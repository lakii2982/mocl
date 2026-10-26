/**
 * 场景回归套件的通用工具：命令执行、文件树快照、临时 git 仓库。
 *
 * 设计纪律：
 * - 只用 Node 标准库，离线、零额度、跨平台（macOS/Linux）；
 * - 所有临时产物都落在 `scenarios/tmp/` 下，报告落在 `scenarios/out/`；
 * - 命令超时一律 SIGKILL，不留下挂起的子进程。
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行一条命令并捕获输出（不抛错；由调用方按 exitCode 判定）。
 * @returns {Promise<{command:string, code:number|null, signal:string|null, timedOut:boolean, durationMs:number, stdout:string, stderr:string, error?:Error}>}
 */
export function runCommand({ command, args = [], cwd, env, timeoutMs = 180_000 }) {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      resolve({
        command: [command, ...args].join(" "),
        code: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        ...extra,
      });
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env === undefined ? process.env : { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ error });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ error });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal });
    });
  });
}

export function tailLines(text, count = 30) {
  const lines = String(text ?? "").trimEnd().split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

/** 文件树快照（默认跳过 .git 与 node_modules；mtime 取整避免文件系统抖动）。 */
export async function walkTree(root, { skipDirs = [".git", "node_modules"], skipFiles = [] } = {}) {
  const entries = [];
  async function visit(dir) {
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue;
        await visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        if (skipFiles.includes(entry.name)) continue;
        const full = join(dir, entry.name);
        const info = await stat(full);
        entries.push({
          path: relative(root, full),
          size: info.size,
          mtimeMs: Math.floor(info.mtimeMs),
        });
      }
    }
  }
  await visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function diffTrees(before, after) {
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  const added = [];
  const modified = [];
  for (const entry of after) {
    const old = previous.get(entry.path);
    if (old === undefined) added.push(entry.path);
    else if (old.size !== entry.size || old.mtimeMs !== entry.mtimeMs) modified.push(entry.path);
    previous.delete(entry.path);
  }
  return { added, modified, removed: [...previous.keys()] };
}

export function describeDiff(diff) {
  return JSON.stringify({
    added: diff.added,
    modified: diff.modified,
    removed: diff.removed,
  });
}

export function git(cwd, args, timeoutMs = 30_000) {
  return runCommand({ command: "git", args, cwd, timeoutMs });
}

export async function gitStatus(cwd) {
  const result = await git(cwd, ["status", "--porcelain"]);
  return { code: result.code, status: result.stdout.trim(), stderr: result.stderr };
}

/**
 * 造一个临时 git 仓库（3 个文件 + 1 个故意失败的测试脚本）并提交。
 * 用途：让「只读子代理不会顺手改文件」的断言有真实工作区可比对。
 */
export async function makeRepoFixture(root) {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "README.md"), "# scenario fixture\n\n只读场景回归用临时仓库。\n", "utf8");
  await writeFile(join(root, "src", "math.js"), "export const add = (a, b) => a + b;\n", "utf8");
  await writeFile(
    join(root, "tests", "failing-check.js"),
    "// 故意失败：验证只读子代理不会「顺手修好」\nprocess.exit(1);\n",
    "utf8",
  );
  const steps = [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["-c", "user.email=scenario@example.invalid", "-c", "user.name=MOCL Scenario", "commit", "-qm", "fixture"],
  ];
  for (const args of steps) {
    const result = await git(root, args);
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (code=${String(result.code)}): ${result.stderr}`);
    }
  }
  return root;
}

/** 键排序后的 JSON 字符串：用于「结构相等」断言，避免键顺序导致假失败。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function formatValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncate(text, limit = 500) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

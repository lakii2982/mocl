import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * C11b：`scripts/upgrade-dsh-codex-payload.mjs` 的回归测试。
 *
 * 铁律：**全部用临时假 profile**（`--profile-root <tmp>`），绝不触碰真实 `~/.dsh`。
 * pnpm 一律用 fake 脚本（`--pnpm <fake>`），不联网、不改用户环境。
 * 复验默认走真实 `assert-codex-baseline.mjs`（需要 PATH 上有 0.164.0）——“复验失败→回滚”用例
 * 用 stub 复验脚本注入失败，保证确定性。
 *
 * 每个用例 60s 上限。
 */

const CASE_TIMEOUT_MS = 60_000;
const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/upgrade-dsh-codex-payload.mjs", import.meta.url));
const ASSERT_SCRIPT_PATH = fileURLToPath(new URL("../../scripts/assert-codex-baseline.mjs", import.meta.url));
const TARGET = "0.164.0";
const OLD = "0.153.4";

interface Workspace {
  root: string;
  profileRoot: string;
  profileDir: string;
  backupRoot: string;
  stateDir: string;
  fakePnpm: string;
  verifyStubOk: string;
  verifyStubFail: string;
}

const workspaces: string[] = [];

function makeWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), "mocl-c11b-"));
  const ws: Workspace = {
    root,
    profileRoot: join(root, "profiles"),
    profileDir: join(root, "profiles", "desktop"),
    backupRoot: join(root, "backup"),
    stateDir: join(root, "fake-state"),
    fakePnpm: join(root, "fake-pnpm.mjs"),
    verifyStubOk: join(root, "verify-ok.mjs"),
    verifyStubFail: join(root, "verify-fail.mjs"),
  };
  mkdirSync(ws.stateDir, { recursive: true });
  seedFakeProfile(ws);
  writeFileSync(ws.fakePnpm, FAKE_PNPM_SOURCE);
  chmodSync(ws.fakePnpm, 0o755);
  writeFileSync(ws.verifyStubOk, "process.exit(0);\n");
  writeFileSync(ws.verifyStubFail, "process.exit(1);\n");
  workspaces.push(root);
  return ws;
}

afterEach(() => {
  while (workspaces.length > 0) {
    const root = workspaces.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/** 造一个结构与真实 profile 同形的假目录（含 vendor 二进制）。 */
function seedFakeProfile(ws: Workspace, version = OLD): void {
  const nodeModules = join(ws.profileDir, "node_modules");
  const codexDir = join(nodeModules, "@openai", "codex");
  const platformDir = join(nodeModules, "@openai", "codex-darwin-arm64");
  const binDir = join(platformDir, "vendor", "aarch64-apple-darwin", "bin");
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(
    join(ws.profileDir, "package.json"),
    JSON.stringify(
      {
        name: "dsh-profile-desktop",
        private: true,
        dependencies: { "@deepseek-ai/dsh-subagent-codex": "0.2.1-rc.3" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(ws.profileDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(
    join(codexDir, "package.json"),
    JSON.stringify(
      {
        name: "@openai/codex",
        version,
        optionalDependencies: { "@openai/codex-darwin-arm64": `npm:@openai/codex@${version}-darwin-arm64` },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(platformDir, "package.json"),
    JSON.stringify({ name: "@openai/codex", version: `${version}-darwin-arm64` }, null, 2) + "\n",
  );
  const vendorBin = join(binDir, "codex");
  writeFileSync(vendorBin, `#!/bin/sh\necho "codex-cli ${version}"\n`);
  chmodSync(vendorBin, 0o755);
}

const FAKE_PNPM_SOURCE = `#!/usr/bin/env node
// 假 pnpm：只按 FAKE_MODE 改假 profile，绝不联网。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const dirIndex = argv.indexOf("--dir");
const profileDir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;
const mode = process.env.FAKE_MODE ?? "ok";
const target = process.env.FAKE_TARGET ?? "0.164.0";
const stateDir = process.env.FAKE_STATE ?? ".";

mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, "invocations.log"), JSON.stringify({ argv, mode }) + "\\n", { flag: "a" });

function rewrite(version) {
  const codexPkg = join(profileDir, "node_modules/@openai/codex/package.json");
  const platformPkg = join(profileDir, "node_modules/@openai/codex-darwin-arm64/package.json");
  const vendorBin = join(profileDir, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex");
  const codex = JSON.parse(readFileSync(codexPkg, "utf8"));
  codex.version = version;
  codex.optionalDependencies = { "@openai/codex-darwin-arm64": \`npm:@openai/codex@\${version}-darwin-arm64\` };
  writeFileSync(codexPkg, JSON.stringify(codex, null, 2) + "\\n");
  writeFileSync(platformPkg, JSON.stringify({ name: "@openai/codex", version: \`\${version}-darwin-arm64\` }, null, 2) + "\\n");
  writeFileSync(vendorBin, \`#!/bin/sh\\necho "codex-cli \${version}"\\n\`);
  chmodSync(vendorBin, 0o755);
}

if (mode === "busy") {
  process.stderr.write("EBUSY: resource busy or locked, rmdir '" + profileDir + "/node_modules/@openai/codex'\\n");
  process.exit(1);
}
if (mode === "fail") {
  // 故意把 vendor 目录写坏，验证回滚能把它还原成字节一致
  writeFileSync(join(profileDir, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"), "CORRUPTED");
  process.stderr.write("ERR_PNPM_SOMETHING_BAD: simulated failure\\n");
  process.exit(1);
}
if (mode === "stale") {
  process.exit(0);
}
rewrite(target);
process.exit(0);
`;

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runUpgrade(ws: Workspace, args: readonly string[], env: Record<string, string> = {}): RunOutcome {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      "--profile-root",
      ws.profileRoot,
      "--backup-root",
      ws.backupRoot,
      "--pnpm",
      ws.fakePnpm,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: CASE_TIMEOUT_MS,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FAKE_STATE: ws.stateDir,
        FAKE_TARGET: TARGET,
        ...env,
      },
    },
  );
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error?.message.includes("ETIMEDOUT") ?? false,
  };
}

/** 全树 sha256 快照（相对路径 → hash），用于“字节一致”断言。 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const stat = statSync(abs);
      if (stat.isDirectory()) walk(abs);
      else if (stat.isFile()) out[relative(root, abs)] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(root);
  return out;
}

function readVersion(path: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function fakePnpmInvocations(ws: Workspace): number {
  const log = join(ws.stateDir, "invocations.log");
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
}

function backupDirFrom(ws: Workspace, stdout: string): string {
  const entries = existsSync(ws.backupRoot) ? readdirSync(ws.backupRoot).filter((name) => name.startsWith("codex-payload-")) : [];
  expect(entries.length, `stdout=${stdout.slice(0, 400)}`).toBe(1);
  return join(ws.backupRoot, entries[0] as string);
}

describe("C11b DSH profile codex 载荷升级脚本", () => {
  it("dry-run：打印完整计划（当前/目标/备份/命令/复验/回滚）且完全不写盘", { timeout: CASE_TIMEOUT_MS }, () => {
    const ws = makeWorkspace();
    const before = snapshot(ws.root);
    const outcome = runUpgrade(ws, ["--dry-run"]);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code, `stderr=${outcome.stderr}`).toBe(0);

    // 计划六要素
    expect(outcome.stdout).toContain("DSH profile codex 载荷升级计划");
    expect(outcome.stdout).toContain(`目标版本                    : ${TARGET}`);
    expect(outcome.stdout).toContain(`vendor 二进制版本           : ${OLD}`);
    expect(outcome.stdout).toContain("备份目录 :");
    expect(outcome.stdout).toContain("将执行的命令");
    expect(outcome.stdout).toContain("pnpm.overrides");
    expect(outcome.stdout).toContain("复验");
    expect(outcome.stdout).toContain("--rollback");
    // 必须解释「为什么不用字面 pnpm update @openai/codex-darwin-arm64@<target>」
    expect(outcome.stdout).toContain("registry 上不存在");
    expect(outcome.stdout).toContain("升级策略                    : overrides");

    // 完全不写盘：无备份、未调用 pnpm、全树字节不变
    expect(existsSync(ws.backupRoot)).toBe(false);
    expect(fakePnpmInvocations(ws)).toBe(0);
    expect(snapshot(ws.root)).toEqual(before);
  });

  it("apply 成功：先备份→升级→strict 复验通过，exit 0 且版本达标", { timeout: CASE_TIMEOUT_MS }, () => {
    const ws = makeWorkspace();
    const originalVendor = readFileSync(join(ws.profileDir, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"), "utf8");
    const outcome = runUpgrade(ws, ["--apply"], { FAKE_MODE: "ok" });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code, `stdout=${outcome.stdout}\nstderr=${outcome.stderr}`).toBe(0);
    expect(fakePnpmInvocations(ws)).toBe(1);

    // 版本达标
    expect(readVersion(join(ws.profileDir, "node_modules/@openai/codex/package.json"))).toBe(TARGET);
    const vendorVersion = spawnSync(
      join(ws.profileDir, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"),
      ["--version"],
      { encoding: "utf8" },
    ).stdout;
    expect(vendorVersion).toContain(TARGET);

    // overrides 已写入（确定性升级机制）
    const profilePkg = JSON.parse(readFileSync(join(ws.profileDir, "package.json"), "utf8")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(profilePkg.pnpm?.overrides?.["@openai/codex"]).toBe(TARGET);
    expect(profilePkg.pnpm?.overrides?.["@openai/codex-darwin-arm64"]).toBe(`npm:@openai/codex@${TARGET}-darwin-arm64`);

    // 备份完整：manifest + package.json + lock + 两个载荷目录（vendor 与升级前字节一致）
    const backupDir = backupDirFrom(ws, outcome.stdout);
    const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8")) as {
      from: { codexPackageJsonVersion: string };
      items: { label: string; present: boolean; kind: string }[];
    };
    expect(manifest.from.codexPackageJsonVersion).toBe(OLD);
    expect(manifest.items.map((item) => item.label)).toContain("package.json");
    expect(manifest.items.map((item) => item.label)).toContain("node_modules/@openai/codex-darwin-arm64");
    const backedUpVendor = readFileSync(join(backupDir, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"), "utf8");
    expect(backedUpVendor).toBe(originalVendor);

    // 输出必须给出回滚命令与下一步
    expect(outcome.stdout).toContain("升级完成");
    expect(outcome.stdout).toContain(`--rollback ${backupDir}`);
    expect(outcome.stdout).toContain("strict-bundle 通过");
  });

  it("apply 失败（通用 pnpm 错误）→ exit 1，自动回滚且全树字节一致", { timeout: CASE_TIMEOUT_MS }, () => {
    const ws = makeWorkspace();
    const before = snapshot(ws.profileDir);
    const outcome = runUpgrade(ws, ["--apply"], { FAKE_MODE: "fail" });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code, `stdout=${outcome.stdout}`).toBe(1);
    expect(outcome.stdout).toContain("自动回滚");
    expect(outcome.stdout).toContain("profile 已还原到升级前状态");
    // 回滚后 profile 与升级前逐字节一致（含被写坏的 vendor）
    expect(snapshot(ws.profileDir)).toEqual(before);
    // 备份保留（不删除证据）
    backupDirFrom(ws, outcome.stdout);
  });

  it("Electron 独占（EBUSY）→ exit 3 且给出替代路径，profile 已回滚", { timeout: CASE_TIMEOUT_MS }, () => {
    const ws = makeWorkspace();
    const before = snapshot(ws.profileDir);
    const outcome = runUpgrade(ws, ["--apply"], { FAKE_MODE: "busy" });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code, `stdout=${outcome.stdout}`).toBe(3);
    expect(outcome.stdout).toContain("环境不支持");
    // 必须是可操作的替代路径，而不是静默失败
    expect(outcome.stdout).toContain("codexBinaryPath");
    expect(outcome.stdout).toContain("插件管理页");
    expect(outcome.stdout).toContain("退出 DeepSeek Harness");
    expect(snapshot(ws.profileDir)).toEqual(before);
  });

  it("复验失败（strict-bundle 不通过）→ exit 1 且自动回滚", { timeout: CASE_TIMEOUT_MS }, () => {
    const ws = makeWorkspace();
    const before = snapshot(ws.profileDir);
    const outcome = runUpgrade(ws, ["--apply", "--verify-script", ws.verifyStubFail], { FAKE_MODE: "ok" });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code, `stdout=${outcome.stdout}`).toBe(1);
    expect(outcome.stdout).toContain("严格门禁复验失败");
    expect(outcome.stdout).toContain("自动回滚");
    expect(snapshot(ws.profileDir)).toEqual(before);
  });

  it("--rollback 还原备份（覆盖而非删除，报告备份外多余文件）", { timeout: CASE_TIMEOUT_MS }, () => {
    const ws = makeWorkspace();
    const before = snapshot(ws.profileDir);
    const applied = runUpgrade(ws, ["--apply"], { FAKE_MODE: "ok" });
    expect(applied.code, `stdout=${applied.stdout}`).toBe(0);
    const backupDir = backupDirFrom(ws, applied.stdout);

    // 升级后确实变了
    expect(snapshot(ws.profileDir)).not.toEqual(before);
    const backupSnapshot = snapshot(join(backupDir, "node_modules"));

    // 再破坏一次现有文件 + 造一个备份里没有的多余文件
    writeFileSync(
      join(ws.profileDir, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"),
      "BROKEN\n",
    );
    writeFileSync(join(ws.profileDir, "node_modules/@openai/codex/EXTRA_FILE.txt"), "extra\n");

    const rolled = runUpgrade(ws, ["--rollback", backupDir]);
    expect(rolled.timedOut).toBe(false);
    expect(rolled.code, `stdout=${rolled.stdout}`).toBe(0);
    expect(rolled.stdout).toContain("字节一致");
    expect(readVersion(join(ws.profileDir, "node_modules/@openai/codex/package.json"))).toBe(OLD);
    // vendor 与备份一致
    const restoredVendor = readFileSync(
      join(ws.profileDir, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"),
      "utf8",
    );
    expect(restoredVendor).toContain(OLD);
    expect(snapshot(join(backupDir, "node_modules"))).toEqual(backupSnapshot);
    // 备份外多余文件：只报告、不删除
    expect(rolled.stdout).toContain("备份外多出");
    expect(existsSync(join(ws.profileDir, "node_modules/@openai/codex/EXTRA_FILE.txt"))).toBe(true);
  });

  it("用法错误：--dry-run 与 --apply 互斥 → exit 2；--rollback 指向不存在目录 → exit 1", { timeout: CASE_TIMEOUT_MS }, () => {
    const ws = makeWorkspace();
    const both = runUpgrade(ws, ["--dry-run", "--apply"]);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("互斥");

    const missing = runUpgrade(ws, ["--rollback", join(ws.root, "no-such-backup")]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("备份目录不存在");
  });

  it("复验默认脚本存在且支持 --profile-root（与 C11 门禁同名口径）", { timeout: CASE_TIMEOUT_MS }, () => {
    expect(existsSync(ASSERT_SCRIPT_PATH)).toBe(true);
    const help = spawnSync(process.execPath, [ASSERT_SCRIPT_PATH, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--profile-root");
    expect(help.stdout).toContain("--strict-bundle");
  });
});

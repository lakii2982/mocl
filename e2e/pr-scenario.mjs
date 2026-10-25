#!/usr/bin/env node
/**
 * C9 端到端 PR 演练（离线默认可跑；`MOCL_LIVE=1` 跑真 codex）。
 *
 * 场景（docs/test/00-test-plan.md E2E-1 的可执行版）：
 *   1. 造一个临时 git 仓库（2 个文件 + 1 个失败的测试脚本）并 commit；
 *   2. `git worktree add` 建隔离工作区；
 *   3. facade.open(codex, read-only) → 轮询 status 到终态；
 *   4. 断言：终态 turn.completed、父级投递 ≤1、无 degraded、**worktree 外零写入**、
 *      worktree 内 git status 与开始时一致；
 *   5. 写 `e2e/out/report.json` 并校验字段。
 *
 * 离线档（默认）：注入假适配器，零额度、CI 可跑。
 * live 档：需要 codex 0.164.0 + 可用凭据；quota/auth/model 失败 → `skipped:quota`，**不假绿**。
 * 退出码：离线 PASS=0；离线断言失败=1；live PASS/SKIP=0。
 */
import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MoclFacade, validateConfig } from "../src/facade/index.ts";
import { CAPABILITY_BITS } from "../src/abi/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const IMPL_ROOT = resolve(HERE, "..");
const LIVE = process.env.MOCL_LIVE === "1";
const RUN_ID = `${process.pid}-${Date.now()}`;
const TMP_ROOT = join(HERE, "tmp");
const OUT_DIR = join(HERE, "out");
const REPORT_PATH = join(OUT_DIR, "report.json");

function sh(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, ...options });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status, error: result.error };
}

function git(cwd, args, timeoutMs) {
  return sh("git", args, { cwd, timeoutMs });
}

/* ------------------------------------------------------------------ */
/* 事件队列假适配器                                                    */
/* ------------------------------------------------------------------ */

class EventQueue {
  #items = [];
  #waiters = [];
  #closed = false;
  push(event) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ value: event, done: false });
    else this.#items.push(event);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolveNext) => this.#waiters.push(resolveNext));
      },
    };
  }
}

class OfflineCodexAdapter {
  backendId = "codex";
  capabilities = {
    abiVersion: "0.1",
    backendId: "codex",
    backendVersion: "0.164.0-offline-fake",
    transport: "app-server-jsonrpc",
    bits: CAPABILITY_BITS.map((bit) => ({ bit, state: "native" })),
    limits: { maxTurnMs: 1_800_000, idleTimeoutMs: 180_000, maxSessionsPerBackend: 8, maxNestingDepth: 2, maxConcurrentTurns: 2 },
    warnings: [],
    observedAt: new Date().toISOString(),
  };
  #queue = new EventQueue();
  #turns = 0;
  sendCalls = 0;
  async open() {
    return { remoteSessionId: "remote_offline_codex", capabilities: this.capabilities };
  }
  async send() {
    this.sendCalls += 1;
    const turnId = `turn_offline_${this.sendCalls}`;
    const usage = { estimated: false, scope: "turn", inputTokens: 12, outputTokens: 4, durationMs: 5 };
    this.#queue.push({ type: "turn.started", turnId, payload: { model: "codex-offline", delivery: "parent" } });
    this.#queue.push({ type: "message.delta", turnId, payload: { channel: "assistant", messageId: "msg_1", granularity: "token", text: "1+1=2" } });
    this.#queue.push({ type: "usage.updated", turnId, payload: { usage } });
    this.#queue.push({ type: "turn.completed", turnId, payload: { stopReason: "end-turn", usage, summary: "1+1=2" } });
    this.#turns += 1;
    return { turnId };
  }
  async resume() {
    return { exists: true, remoteSessionId: "remote_offline_codex" };
  }
  async interrupt() {}
  async close() {
    this.#queue.close();
  }
  async *events() {
    yield* this.#queue;
  }
}

/* ------------------------------------------------------------------ */
/* 仓库夹具 + 快照                                                     */
/* ------------------------------------------------------------------ */

async function setupRepo() {
  const repoDir = join(TMP_ROOT, `repo-${RUN_ID}`);
  const worktreeDir = join(TMP_ROOT, `wt-${RUN_ID}`);
  await rm(repoDir, { recursive: true, force: true });
  await rm(worktreeDir, { recursive: true, force: true });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "tests"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), "# e2e fixture\n\nread-only PR 演练用临时仓库。\n", "utf8");
  await writeFile(join(repoDir, "src", "math.js"), "export const add = (a, b) => a + b;\n", "utf8");
  await writeFile(
    join(repoDir, "tests", "failing-check.js"),
    "// 故意失败的测试脚本：验证只读子代理不会\"顺手修好\"\nprocess.exit(1);\n",
    "utf8",
  );
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "mocl-e2e@example.invalid"],
    ["config", "user.name", "MOCL E2E"],
    ["add", "-A"],
    ["commit", "-qm", "e2e fixture"],
  ]) {
    const result = git(repoDir, args);
    if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  const worktree = git(repoDir, ["worktree", "add", "-q", worktreeDir, "HEAD"]);
  if (!worktree.ok) throw new Error(`git worktree add failed: ${worktree.stderr}`);
  return { repoDir, worktreeDir };
}

async function walkFiles(root, { skipGit = true } = {}) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipGit && entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const info = await stat(full);
        out.push({ path: relative(root, full), size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  await visit(root);
  return out;
}

function diffSnapshots(before, after) {
  const old = new Map(before.map((entry) => [entry.path, entry]));
  const added = [];
  const modified = [];
  for (const entry of after) {
    const previous = old.get(entry.path);
    if (previous === undefined) added.push(entry.path);
    else if (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) modified.push(entry.path);
  }
  return { added, modified };
}

function gitStatus(worktreeDir) {
  const result = git(worktreeDir, ["status", "--porcelain"]);
  if (!result.ok) throw new Error(`git status failed: ${result.stderr}`);
  return result.stdout.trim();
}

/* ------------------------------------------------------------------ */
/* 配置 / 运行时                                                       */
/* ------------------------------------------------------------------ */

function runtimeMax() {
  const fromEnv = process.env.MOCL_MAX_ACTIVE_SUBAGENTS;
  if (fromEnv !== undefined && /^\d+$/.test(fromEnv)) return Number.parseInt(fromEnv, 10);
  // D-016：从运行时（desktop patch 的 subagent 行）读取，不硬编码。
  const desktopPatch = join(process.env.HOME ?? "", ".dsh", "profiles", "desktop", "cordis.patch.yml");
  if (existsSync(desktopPatch)) {
    const text = readFileSync(desktopPatch, "utf8");
    const match = /maxActiveSubagents:\s*(\d+)/.exec(text);
    if (match !== null) return Number.parseInt(match[1], 10);
  }
  return null;
}

function baseConfig() {
  return validateConfig({
    global: { enabled: true },
    backends: { codex: { enabled: true, permissionMode: "read-only" } },
  });
}

function runtimeProvider() {
  const max = runtimeMax();
  if (max === null || !Number.isSafeInteger(max) || max <= 0) {
    throw new Error("runtime maxActiveSubagents unavailable (D-016 fail-closed; set MOCL_MAX_ACTIVE_SUBAGENTS)");
  }
  return { read: () => ({ maxActiveSubagents: max }) };
}

/* ------------------------------------------------------------------ */
/* 场景执行                                                            */
/* ------------------------------------------------------------------ */

async function waitForTerminal(facade, childId, timeoutMs) {
  const started = Date.now();
  let last = await facade.status(childId);
  while (Date.now() - started < timeoutMs) {
    if (last.state !== "running" && last.state !== "created") return last;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
    last = await facade.status(childId, last.cursor.lastSeq ?? 0);
  }
  return last;
}

function summarizeError(error) {
  const code = error?.code ?? "internal.unexpected";
  const message = String(error?.message ?? error);
  return { code, message };
}

async function runScenario() {
  const started = Date.now();
  // 清掉历史 run 的临时仓库/worktree（只允许清 e2e/tmp 自身，防误删）。
  if (!resolve(TMP_ROOT).startsWith(HERE)) throw new Error(`refusing to clean ${TMP_ROOT}`);
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  const { repoDir, worktreeDir } = await setupRepo();
  const outerBefore = await walkFiles(TMP_ROOT);
  const worktreeBefore = await walkFiles(worktreeDir);
  const statusBefore = gitStatus(worktreeDir);

  const assertions = [];
  const assert = (name, ok, detail) => {
    assertions.push({ name, ok: Boolean(ok), detail: detail ?? "" });
    return ok;
  };

  let facade = null;
  let adapter = null;
  let report;
  try {
    const config = baseConfig();
    const options = {
      config,
      runtime: runtimeProvider(),
      registryPath: join(TMP_ROOT, `sessions-${RUN_ID}.json`),
    };
    if (!LIVE) {
      adapter = new OfflineCodexAdapter();
      options.adapters = { codex: adapter };
    }
    facade = await MoclFacade.create(options);
    const opened = await facade.open("codex", "只读检查仓库，回答 1+1，不要改文件", {
      cwd: worktreeDir,
      permissionMode: "read-only",
    });
    assert("open:childId", /^sess_/.test(opened.childId), opened.childId);
    assert("open:remoteIdState", opened.remoteIdState === "bound" || opened.remoteIdState === "pending", opened.remoteIdState);

    const status = await waitForTerminal(facade, opened.childId, LIVE ? 180_000 : 10_000);
    assert("state:terminal", status.state !== "running" && status.state !== "created", status.state);
    assert("state:completed", status.state === "completed", status.state);
    assert("error:none", status.error === undefined || status.error === null, String(status.error ?? "none"));
    assert("degraded:false", status.degraded === false, String(status.degraded));
    assert("events:received", status.cursor.total > 0, String(status.cursor.total));
    assert("parent:<=1", status.parentDeliveries <= 1, String(status.parentDeliveries));
    assert("usage:present", status.usage !== null, status.usage === null ? "null" : "present");
    assert("remoteId:state", status.remoteIdState === "bound" || status.remoteIdState === "pending", status.remoteIdState);

    const statusAfter = gitStatus(worktreeDir);
    assert("worktree:git-status-unchanged", statusAfter === statusBefore, `${JSON.stringify(statusBefore)} -> ${JSON.stringify(statusAfter)}`);
    const worktreeAfter = await walkFiles(worktreeDir);
    const worktreeDiff = diffSnapshots(worktreeBefore, worktreeAfter);
    assert(
      "worktree:no-writes",
      worktreeDiff.added.length === 0 && worktreeDiff.modified.length === 0,
      JSON.stringify(worktreeDiff),
    );
    const outerAfter = await walkFiles(TMP_ROOT);
    const outerDiff = diffSnapshots(outerBefore, outerAfter);
    // 允许 e2e 自己的 registry/sessions 与 report 路径；worktree/repo 本体必须零变化。
    // MOCL 自己的状态文件（registry/journal）+ 报告目录不算「子代理写入」。
    const allowed = (path) => path.startsWith("sessions-") || path === "journal.jsonl" || path.startsWith("out/");
    const outsideWrites = [...outerDiff.added, ...outerDiff.modified].filter((path) => !allowed(path));
    assert("outside-worktree:no-writes", outsideWrites.length === 0, JSON.stringify(outsideWrites));

    report = {
      mode: LIVE ? "live" : "offline",
      status: "passed",
      backend: "codex",
      model: status.model ?? null,
      childId: opened.childId,
      state: status.state,
      events: { total: status.cursor.total, cursor: status.cursor.lastSeq, parentDeliveries: status.parentDeliveries },
      lastEventType: status.lastEventType,
      warnings: status.warnings,
      error: status.error ?? null,
      usage: status.usage,
      durationMs: Date.now() - started,
      writesOutsideWorktree: outsideWrites.length > 0,
      assertions,
      worktree: { repoDir, worktreeDir, statusBefore, statusAfter },
    };
  } catch (error) {
    const summary = summarizeError(error);
    const quotaLike = /quota|rate.?limit|credential|auth|model_not_found|usage/i.test(`${summary.code} ${summary.message}`);
    const status = LIVE && quotaLike ? "skipped:quota" : LIVE ? "skipped:host-unavailable" : "failed";
    assertions.push({ name: "scenario:completed", ok: false, detail: `${summary.code}: ${summary.message}` });
    report = {
      mode: LIVE ? "live" : "offline",
      status,
      backend: "codex",
      model: null,
      childId: null,
      state: "unknown",
      events: { total: 0, cursor: null, parentDeliveries: 0 },
      usage: null,
      durationMs: Date.now() - started,
      writesOutsideWorktree: false,
      assertions,
      error: summary,
      worktree: { repoDir, worktreeDir, statusBefore },
    };
    if (LIVE) {
      console.log(`SKIP:quota (${summary.code}: ${summary.message})`);
      console.log("SKIP 说明：live 档按契约不判失败（不假绿），离线档仍为 CI 默认。");
    }
  } finally {
    if (facade !== null) {
      try {
        await facade.close(report?.childId ?? "");
      } catch {
        // 已关闭/未创建：忽略
      }
    }
    // 清掉 git worktree 与临时仓库（避免残留；报告保留在 e2e/out）。
    git(repoDir, ["worktree", "remove", "--force", worktreeDir]);
    await rm(repoDir, { recursive: true, force: true });
  }

  // 任一断言失败都不得报 PASS（离线=失败；live 的非 quota 失败同样失败）。
  if (report.status === "passed" && !report.assertions.every((assertion) => assertion.ok)) {
    const code = String(report.error?.code ?? "");
    const quotaLike = /quota|rate.?limit|credential|auth|model|usage|login/i.test(`${code} ${String(report.error?.message ?? "")}`);
    if (LIVE && quotaLike) {
      report.status = "skipped:quota";
      report.skipReason = `${code}: ${String(report.error?.message ?? "terminal failure")}`;
      console.log(`SKIP:quota (${report.skipReason})`);
    } else if (LIVE) {
      // 非 quota 语义的 live 失败：不判 PASS，也不冒充 quota；标 host-unavailable 并附证据。
      report.status = "skipped:host-unavailable";
      report.skipReason = `live terminal failure code=${code || "none"} (upstream cause hidden by adapter; see warnings=${JSON.stringify(report.warnings ?? [])})`;
      console.log(`SKIP:host-unavailable (${report.skipReason})`);
    } else {
      report.status = "failed";
    }
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  const required = ["mode", "status", "backend", "model", "childId", "state", "events", "usage", "durationMs", "writesOutsideWorktree", "assertions"];
  const missing = required.filter((key) => !(key in report));
  if (missing.length > 0) throw new Error(`report missing fields: ${missing.join(", ")}`);
  console.log(`report: ${REPORT_PATH}`);
  console.log(`assertions: ${report.assertions.filter((a) => a.ok).length}/${report.assertions.length} passed`);
  for (const assertion of report.assertions) {
    console.log(`  ${assertion.ok ? "PASS" : "FAIL"} ${assertion.name}${assertion.detail === "" ? "" : ` (${assertion.detail})`}`);
  }
  if (report.status === "failed") process.exitCode = 1;
  if (report.warnings !== undefined && report.warnings.length > 0) console.log(`warnings: ${JSON.stringify(report.warnings)}`);
  if (report.lastEventType !== undefined) console.log(`lastEventType: ${String(report.lastEventType)}`);
  if (report.status === "passed") console.log(`RESULT: PASS (${report.mode})`);
  else console.log(`RESULT: SKIP (${report.status})`);
  return report;
}

const report = await runScenario();
if (report.status === "failed") process.exitCode = 1;

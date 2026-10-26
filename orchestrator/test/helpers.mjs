/**
 * Test helpers: temp workspaces + injectable fake exec.
 * No network, no credentials, no real gh/git/dsh invocation.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXED_ISO = "2026-01-02T03:04:05.000Z";

/** Deterministic clock: identical timestamps keep run ids predictable. */
export function constantClock(iso = FIXED_ISO) {
  return () => new Date(iso);
}

export async function makeWorkspace(prefix = "mocl-orch-test-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
    async list() {
      return (await readdir(root)).sort();
    },
  };
}

/**
 * Fake executor. `handler(call)` returns `{ code, stdout, stderr }`.
 * Records every call so tests can assert on the exact command plan.
 */
export function createFakeExec(handler = () => ({ code: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const exec = async (command, args = [], options = {}) => {
    const call = { command, args: [...args], cwd: options.cwd, line: [command, ...args].join(" "), options };
    calls.push(call);
    const outcome = (await handler(call)) ?? {};
    const code = outcome.code ?? 0;
    return {
      ok: code === 0,
      code,
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
      durationMs: 0,
      command,
      args,
      cwd: options.cwd,
    };
  };
  exec.calls = calls;
  exec.count = (predicate) => calls.filter(predicate).length;
  exec.filter = (predicate) => calls.filter(predicate);
  return exec;
}

/** Executor that fails loudly if anything tries to run in dry-run mode. */
export function throwingExec() {
  const calls = [];
  const exec = async (command, args = []) => {
    calls.push({ command, args });
    throw new Error(`exec must not be called in dry-run: ${command} ${args.join(" ")}`);
  };
  exec.calls = calls;
  return exec;
}

export const ISSUE_FIXTURE = {
  number: 1,
  title: "Add orchestrator dry-run planner",
  body: [
    "## 需求摘要",
    "为 orchestrator 增加 dry-run 计划输出。",
    "",
    "## 验收口径",
    "- deliver --dry-run exit 0 且零副作用",
    "",
    "## 风险",
    "- 计划与真实执行不一致",
    "",
    "## 非目标",
    "- 不改 runner 行为",
  ].join("\n"),
  labels: [{ name: "agent:ready" }],
  state: "OPEN",
  author: { login: "octocat" },
  url: "https://github.com/lakii2982/mocl/issues/1",
};

export async function writeIssueFixture(dir, issue = ISSUE_FIXTURE) {
  const path = join(dir, "issue.json");
  await writeFile(path, `${JSON.stringify(issue, null, 2)}\n`, "utf8");
  return path;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export const PR_URL = "https://github.com/lakii2982/mocl/pull/42";

/**
 * Happy-path gh/git fake.
 * - `issues` drives `gh issue list` (watch)
 * - `prsForBranch(head)` drives the idempotency check
 * - `dirtyStatus` makes `git status --porcelain` report an agent change
 */
export function happyHandler({
  issues = [ISSUE_FIXTURE],
  prsForBranch = () => [],
  issueView = ISSUE_FIXTURE,
  prCreateStdout = `${PR_URL}\n`,
  dirtyStatus = " M src/feature.ts\n",
} = {}) {
  return (call) => {
    const { command, args } = call;
    if (command === "gh") {
      if (args[0] === "issue" && args[1] === "view") return { code: 0, stdout: JSON.stringify(issueView) };
      if (args[0] === "issue" && args[1] === "list") return { code: 0, stdout: JSON.stringify(issues) };
      if (args[0] === "pr" && args[1] === "list") {
        const headIndex = args.indexOf("--head");
        const head = headIndex === -1 ? null : args[headIndex + 1];
        return { code: 0, stdout: JSON.stringify(prsForBranch(head)) };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            title: "feat(issue-1): Add orchestrator dry-run planner",
            state: "OPEN",
            headRefName: "agent/1-add-orchestrator-dry-run-planner",
            url: PR_URL,
            isDraft: false,
          }),
        };
      }
      if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: prCreateStdout };
      return { code: 0, stdout: "" };
    }
    if (command === "git") {
      const joined = args.join(" ");
      if (joined.includes("status") && joined.includes("--porcelain")) return { code: 0, stdout: dirtyStatus };
      if (joined.includes("status") && joined.includes("--short")) return { code: 0, stdout: dirtyStatus };
      return { code: 0, stdout: "" };
    }
    if (command === "dsh" || command === "my-agent") return { code: 0, stdout: "agent finished" };
    return { code: 0, stdout: "" };
  };
}

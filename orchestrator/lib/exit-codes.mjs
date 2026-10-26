/**
 * Exit codes — aligned with `docs/process/10-DSH-LOCAL-AGENTS.md` §2.
 *
 *   0  成功 / PASS
 *   1  门禁失败 / 校验 FAIL / 运行失败（可重试）
 *   2  用法错误 / 仓库推断失败
 *   3  重试耗尽：issue 已打 status/blocked + agent:blocked，交人工
 *   4  环境不可用：gh/网络/labels 真源/runner 不可用
 */

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLOCKED = 3;
export const EXIT_ENV = 4;

/** Failure codes that mean "the caller made a mistake / inference failed". */
const USAGE_CODES = new Set([
  "invalid-argument",
  "invalid-issue",
  "invalid-runner",
  "invalid-agent-cmd",
  "invalid-role",
  "repo-unresolved",
]);

/** Failure codes that mean "this environment cannot run the command". */
const ENV_CODES = new Set([
  "labels-unavailable",
  "labels-incomplete",
  "env-unavailable",
  "gh-failed",
  "gh-unavailable",
  "network-unavailable",
  "runner-unavailable",
]);

/** Map a typed failure code to an exit code (default: 1). */
export function exitCodeForCode(code) {
  if (USAGE_CODES.has(code)) return EXIT_USAGE;
  if (ENV_CODES.has(code)) return EXIT_ENV;
  return EXIT_FAIL;
}

/** Map a failure object / error to an exit code. */
export function exitCodeForFailure(failure) {
  return exitCodeForCode(failure?.code);
}

export const EXIT_CODE_TABLE = [
  { code: EXIT_OK, meaning: "成功 / PASS" },
  { code: EXIT_FAIL, meaning: "门禁失败 / 校验 FAIL / 可重试的运行失败" },
  { code: EXIT_USAGE, meaning: "用法错误 / 仓库推断失败" },
  { code: EXIT_BLOCKED, meaning: "重试耗尽：status/blocked + agent:blocked，交人工" },
  { code: EXIT_ENV, meaning: "环境不可用：gh/网络/labels 真源/runner 不可用" },
];

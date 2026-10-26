import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * C11 / D-015 门禁的回归测试：断言 `scripts/assert-codex-baseline.mjs` 的退出码契约。
 *
 * 覆盖：
 *   1. 正常路径（本机基线 0.164.0）→ exit 0，且 106/85/10 与 bundle 结论可在 --json 里读到
 *   2. 版本前缀不符（--expect 0.999.）→ exit ≠ 0 且输出含可定位的诊断
 *   3. 二进制不存在（--binary /nonexistent）→ exit ≠ 0
 *   4. --help → exit 0（CI 里误传参数时先能自证用法）
 *
 * 零额度：脚本本身只跑 `--version` 与 `app-server generate-json-schema`，不建 thread、不跑 turn。
 * 每个用例上限 60s（单个脚本实测约 1.5–3s）。
 */

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/assert-codex-baseline.mjs", import.meta.url));
const CASE_TIMEOUT_MS = 60_000;

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runBaselineScript(args: readonly string[]): RunOutcome {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    timeout: CASE_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error?.message.includes("ETIMEDOUT") ?? false,
  };
}

/** 基线二进制：优先 MOCL_CODEX_BIN（CI 可钉绝对路径），否则 PATH 上的 codex。 */
function baselineBinary(): string | undefined {
  const override = process.env.MOCL_CODEX_BIN;
  if (override !== undefined && override.trim() !== "") return override;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "codex");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface BaselineReport {
  ok: boolean;
  binary: string | null;
  expect: { versionPrefix: string; clientRequest: number; serverNotification: number; serverRequest: number };
  checks: { id: string; status: string; detail: string }[];
  bundleWarnings: { id: string; detail: string }[];
  strictBundle: boolean;
}

/**
 * CI portability: this suite needs a baseline `codex` binary on PATH (or MOCL_CODEX_BIN).
 * Local machines have it; a clean CI runner does not, and the contract under test is
 * "what the script does when a baseline exists". Skip instead of failing.
 */
const HAS_CODEX = baselineBinary() !== undefined && process.env.MOCL_SKIP_LOCAL_BASELINE_TESTS !== "1";

describe.skipIf(!HAS_CODEX)("C11 codex 基线断言脚本（D-015 门禁）", () => {
  it("正常路径：exit 0，且 --json 报告 106/85/10 与 bundle 结论", { timeout: CASE_TIMEOUT_MS }, () => {
    const binary = baselineBinary();
    expect(
      binary,
      "PATH 上找不到 codex，且未设置 MOCL_CODEX_BIN —— C11 门禁要求本机/CI 装有基线 0.164.0",
    ).toBeDefined();

    const outcome = runBaselineScript(["--binary", binary as string, "--json"]);
    expect(outcome.timedOut, "脚本超过 60s 未退出").toBe(false);
    expect(outcome.code, `期望 exit 0，实际 ${outcome.code}；stderr=${outcome.stderr}`).toBe(0);

    const report = JSON.parse(outcome.stdout) as BaselineReport;
    expect(report.ok).toBe(true);
    expect(report.binary).not.toBeNull();
    expect(report.expect).toMatchObject({ clientRequest: 106, serverNotification: 85, serverRequest: 10 });

    const byId = new Map(report.checks.map((check) => [check.id, check]));
    for (const id of ["version", "count:ClientRequest", "count:ServerNotification", "count:ServerRequest"]) {
      expect(byId.get(id)?.status, `缺少通过的断言 ${id}`).toBe("PASS");
    }
    expect(byId.get("count:ClientRequest")?.detail).toContain("106");
    expect(byId.get("count:ServerNotification")?.detail).toContain("85");
    expect(byId.get("count:ServerRequest")?.detail).toContain("10");

    // bundle 结论必须出现（SAME 或 DIFF 都要能判定），否则 DIFF 的升级指引无从触发。
    const bundleChecks = report.checks.filter((check) => check.id.startsWith("bundle:"));
    expect(bundleChecks.length).toBeGreaterThan(0);
    expect(bundleChecks[0]?.detail).toMatch(/\b(SAME|DIFF)\b/);
    expect(report.bundleWarnings.length).toBe(
      bundleChecks.filter((check) => check.status !== "PASS").length,
    );
  });

  it("版本前缀不符：--expect 0.999. → exit ≠ 0 且给出可定位诊断", { timeout: CASE_TIMEOUT_MS }, () => {
    const binary = baselineBinary();
    if (binary === undefined) return; // 无二进制时由上一个用例负责报错，这里避免重复噪声

    const outcome = runBaselineScript(["--binary", binary, "--expect", "0.999."]);
    expect(outcome.timedOut, "脚本超过 60s 未退出").toBe(false);
    expect(outcome.code, "版本不符必须非零退出").not.toBe(0);
    expect(outcome.stdout).toContain("FAIL version");
    expect(outcome.stdout).toContain("0.999.");
    expect(outcome.stdout).toContain("RESULT: FAIL");
    // 诊断必须包含「怎么复现」，而不是只说失败。
    expect(outcome.stdout).toContain("DIAG 复现命令");
  });

  it("二进制不存在：--binary /nonexistent → exit ≠ 0", { timeout: CASE_TIMEOUT_MS }, () => {
    const outcome = runBaselineScript(["--binary", "/nonexistent"]);
    expect(outcome.timedOut, "脚本超过 60s 未退出").toBe(false);
    expect(outcome.code, "二进制不存在必须非零退出").not.toBe(0);
    expect(outcome.stdout).toContain("FAIL version");
    expect(outcome.stdout).toMatch(/路径不存在|不可执行/);
    // 二进制不可用时不应继续做协议断言（避免在错误基线上产出误导性计数）。
    expect(outcome.stdout).toContain("SKIP protocol-counts");
  });

  it("--help 可用：exit 0 且列出关键参数", { timeout: CASE_TIMEOUT_MS }, () => {
    const outcome = runBaselineScript(["--help"]);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("--binary");
    expect(outcome.stdout).toContain("--expect");
    expect(outcome.stdout).toContain("--strict-bundle");
  });

  it("pnpm/npm 风格的前导 `--` 被剥离（回归：pnpm 11 会把字面量 -- 透传给脚本）", { timeout: CASE_TIMEOUT_MS }, () => {
    const binary = baselineBinary();
    if (binary === undefined) return; // 无二进制时由第一个用例负责报错

    // `pnpm -s baseline:codex -- --binary ...` 实际 argv 是 ["--", "--binary", ...]；
    // 若不剥离前导 `--`，node parseArgs 会把后续选项当成位置参数并 exit 2。
    const outcome = runBaselineScript(["--", "--binary", binary, "--json"]);
    expect(outcome.code, `期望 exit 0，实际 ${outcome.code}；stderr=${outcome.stderr}`).toBe(0);
    const report = JSON.parse(outcome.stdout) as BaselineReport;
    expect(report.ok).toBe(true);
  });
});

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const IMPL_ROOT = process.cwd();
const REPORT = join(IMPL_ROOT, "e2e", "out", "report.json");

describe("C9 端到端 PR 演练（离线档）", () => {
  it("离线 e2e 退出码 0，报告 13 条断言全 PASS 且字段齐全", () => {
    const env = { ...process.env };
    delete env.MOCL_LIVE;
    const output = execFileSync("node", [join(IMPL_ROOT, "e2e", "pr-scenario.mjs")], {
      cwd: IMPL_ROOT,
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
    expect(output).toContain("RESULT: PASS (offline)");
    const report = JSON.parse(readFileSync(REPORT, "utf8")) as Record<string, unknown>;
    for (const key of ["mode", "status", "backend", "model", "childId", "state", "events", "usage", "durationMs", "writesOutsideWorktree", "assertions"]) {
      expect(report).toHaveProperty(key);
    }
    expect(report["mode"]).toBe("offline");
    expect(report["status"]).toBe("passed");
    expect(report["writesOutsideWorktree"]).toBe(false);
    const assertions = report["assertions"] as Array<{ ok: boolean }>;
    expect(assertions.every((assertion) => assertion.ok)).toBe(true);
  }, 130_000);
});

/**
 * Scenario 5 — PR body rendering: the contracted sections must always be
 * present, evidence must be tabulated, and template mistakes must fail loudly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { OrchestratorError } from "../lib/errors.mjs";
import { loadPrTemplate, renderPrBody, validatePrTemplate, PR_REQUIRED_SECTIONS } from "../lib/prbody.mjs";
import { renderDeliveryReport } from "../lib/report.mjs";
import { renderTemplate } from "../lib/templates.mjs";

const ISSUE = {
  number: 12,
  title: "Support dry-run plan output",
  body: "## 需求摘要\n需要 dry-run。\n\n## 风险\n计划漂移。",
  url: "https://github.com/lakii2982/mocl/issues/12",
  labels: ["agent:ready"],
  author: "octocat",
  state: "OPEN",
};

const GATES = [
  { id: "typecheck", display: "node_modules/.bin/tsc -p tsconfig.json --noEmit", ok: true, code: 0, dryRun: false },
  { id: "test", display: "node_modules/.bin/vitest run", ok: false, code: 1, dryRun: false },
  { id: "validate-abi", display: "node tools/validate-abi.mjs", ok: true, code: 0, dryRun: true },
];

function body(overrides = {}) {
  return renderPrBody({
    issue: ISSUE,
    repo: "lakii2982/mocl",
    branch: "agent/12-support-dry-run-plan-output",
    base: "main",
    worktree: ".worktrees/issue-12",
    gates: GATES,
    agent: { runner: "mock", rolePromptSource: "fallback" },
    runId: "2026-01-02T03-04-05-000Z-i12",
    generatedAt: "2026-01-02T03:04:06.000Z",
    ...overrides,
  });
}

test("PR body contains 关联 issue / 证据表 / 风险与回滚 sections", () => {
  const markdown = body();
  for (const section of PR_REQUIRED_SECTIONS) {
    assert.ok(markdown.includes(section), `missing section: ${section}`);
  }
  assert.match(markdown, /Closes #12/);
  assert.match(markdown, /https:\/\/github\.com\/lakii2982\/mocl\/issues\/12/);
  // Evidence table rows with exit codes and verdicts.
  assert.match(markdown, /\| `typecheck` \|/);
  assert.match(markdown, /PASS/);
  assert.match(markdown, /FAIL/);
  assert.match(markdown, /PLANNED/);
  assert.match(markdown, /node_modules\/\.bin\/vitest run/);
  // Rollback plan names the branch and the revert step.
  assert.match(markdown, /git push origin --delete agent\/12-support-dry-run-plan-output/);
  assert.match(markdown, /git revert -m 1/);
  // Attribution badge (dsh-badge skill) is present at the end.
  assert.match(markdown, /powered_by-dsh/);
});

test("PR template on disk is valid and renders the same sections", async () => {
  const template = await loadPrTemplate();
  assert.equal(validatePrTemplate(template), true);
  const markdown = body({ template });
  for (const section of PR_REQUIRED_SECTIONS) {
    assert.ok(markdown.includes(section), `missing section: ${section}`);
  }
});

test("a template that drops a required section fails validation", async () => {
  const badTemplate = "## 关联 issue\n\n{{issueLink}}\n";
  assert.throws(
    () => validatePrTemplate(badTemplate),
    (error) => error instanceof OrchestratorError && error.code === "template-missing-sections",
  );
  assert.throws(
    () => body({ template: badTemplate }),
    (error) => error instanceof OrchestratorError && error.code === "template-missing-sections",
  );
});

test("unknown placeholders fail instead of producing a half-empty body", () => {
  assert.throws(
    () => renderTemplate("## x\n\n{{not_a_known_key}}\n", {}),
    (error) => error instanceof OrchestratorError && error.code === "template-placeholder",
  );
});

test("delivery report keeps 交付摘要 / 证据 / 风险与回滚 and rollback commands", () => {
  const report = renderDeliveryReport({
    issue: ISSUE,
    repo: "lakii2982/mocl",
    branch: "agent/12-support-dry-run-plan-output",
    base: "main",
    worktree: ".worktrees/issue-12",
    prUrl: "https://github.com/lakii2982/mocl/pull/42",
    gates: GATES,
    agent: { runner: "mock", rolePromptSource: "fallback" },
    issueSource: "file",
    runId: "2026-01-02T03-04-05-000Z-i12",
    runDir: ".agentspec/runs/2026-01-02T03-04-05-000Z-i12",
    eventsPath: ".agentspec/runs/2026-01-02T03-04-05-000Z-i12/events.jsonl",
    changedFiles: ["src/orchestrator.test.ts"],
    risks: "计划漂移。",
    durationMs: 12_345,
  });
  for (const section of ["## 交付摘要", "## 证据", "## 风险与回滚"]) {
    assert.ok(report.includes(section), `missing section: ${section}`);
  }
  assert.match(report, /gh pr close https:\/\/github\.com\/lakii2982\/mocl\/pull\/42/);
  assert.match(report, /verify --pr 42 --repo lakii2982\/mocl/);
  assert.match(report, /src\/orchestrator\.test\.ts/);
  assert.match(report, /12\.3s/);
});

/**
 * Scenario 1 — dry-run: deliver/intake/verify must PLAN commands and execute
 * none (fake exec calls === 0) with zero filesystem side effects.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { ORCHESTRATOR_ROOT } from "../lib/paths.mjs";
import { deliverCommand } from "../lib/deliver.mjs";
import { intakeCommand } from "../lib/intake.mjs";
import { verifyCommand } from "../lib/verify.mjs";
import { constantClock, makeWorkspace, throwingExec } from "./helpers.mjs";

const DRY_ENV = {}; // no MOCL_* overrides

test("deliver --dry-run plans every mutating step and executes nothing", async () => {
  const workspace = await makeWorkspace();
  try {
    const exec = throwingExec();
    const summary = await deliverCommand(
      { issue: 1, dryRun: true, repo: "lakii2982/mocl", cwd: workspace.root, runner: "dsh", print: false },
      { exec, now: constantClock(), env: DRY_ENV },
    );

    assert.equal(exec.calls.length, 0, "dry-run must not invoke the executor");
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.dryRun, true);

    const planned = summary.planned;
    assert.ok(planned.length >= 8, `expected >= 8 planned commands, got ${planned.length}`);

    const has = (command, ...fragments) =>
      planned.some((entry) => entry.command === command && fragments.every((fragment) => entry.args.includes(fragment)));

    assert.ok(has("gh", "issue", "view"), "issue read planned");
    assert.ok(has("gh", "pr", "list"), "idempotency PR check planned");
    assert.ok(has("git", "worktree", "add", "-b"), "branch/worktree creation planned");
    assert.ok(has("dsh", "headless"), "dsh runner invocation planned");
    assert.ok(has("node_modules/.bin/tsc", "-p"), "typecheck gate planned");
    assert.ok(has("node_modules/.bin/vitest", "run"), "test gate planned");
    assert.ok(has("node", "tools/validate-abi.mjs"), "validate-abi gate planned");
    assert.ok(has("git", "push"), "push planned");
    assert.ok(has("gh", "pr", "create"), "PR creation planned");
    assert.ok(has("gh", "issue", "edit", "status/in-review"), "in-review label planned");
    assert.ok(has("gh", "issue", "comment"), "delivery report comment planned");

    // No force flags may ever appear as a real git argument.
    const forceFlags = new Set(["-f", "--force", "--force-with-lease", "--force-if-changed"]);
    for (const entry of planned) {
      for (const arg of entry.args) {
        assert.ok(!forceFlags.has(arg), `force flag ${arg} planned in: ${entry.display}`);
      }
    }

    // Explicit fallback source (temp cwd has no agents/roles/*.md).
    assert.equal(summary.rolePromptSource, "fallback");
    assert.match(summary.steps.find((step) => step.id === "build-prompt").title, /implementer/);
    // Offline issue stub is clearly labelled when no fixture is supplied.
    assert.equal(summary.issueSource, "offline-stub");

    // Zero filesystem side effects.
    assert.deepEqual(await workspace.list(), [], "workspace must stay empty");
    assert.equal(existsSync(join(workspace.root, ".agentspec")), false);
    assert.equal(existsSync(join(workspace.root, ".worktrees")), false);
  } finally {
    await workspace.cleanup();
  }
});

test("intake --dry-run renders the BRIEF but writes nothing", async () => {
  const workspace = await makeWorkspace();
  try {
    const exec = throwingExec();
    const summary = await intakeCommand(
      { issue: 1, dryRun: true, repo: "lakii2982/mocl", cwd: workspace.root, print: false },
      { exec, now: constantClock(), env: DRY_ENV },
    );
    assert.equal(exec.calls.length, 0);
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.issueSource, "offline-stub");
    for (const section of ["## 需求摘要", "## 验收口径", "## 风险", "## 非目标", "## 待澄清问题"]) {
      assert.ok(summary.brief.includes(section), `BRIEF missing ${section}`);
    }
    assert.ok(summary.briefPath.endsWith(".agentspec/issues/1/BRIEF.md"));
    assert.equal(existsSync(summary.briefPath), false, "dry-run must not write the BRIEF");
    assert.deepEqual(await workspace.list(), []);
  } finally {
    await workspace.cleanup();
  }
});

test("verify --dry-run plans gates and role reviews without executing", async () => {
  const workspace = await makeWorkspace();
  try {
    const exec = throwingExec();
    const summary = await verifyCommand(
      { pr: 7, dryRun: true, repo: "lakii2982/mocl", cwd: workspace.root, runner: "dsh", review: true, print: false },
      { exec, now: constantClock(), env: DRY_ENV },
    );
    assert.equal(exec.calls.length, 0);
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.verdict, "PASS");
    assert.deepEqual(
      summary.reviews.map((review) => review.role),
      ["verifier", "reviewer"],
    );
    const planned = summary.planned;
    assert.ok(planned.some((entry) => entry.command === "gh" && entry.args[1] === "view"));
    assert.ok(planned.some((entry) => entry.command === "node_modules/.bin/tsc"));
    assert.ok(planned.some((entry) => entry.command === "dsh" && entry.args.includes("headless")));
    assert.deepEqual(await workspace.list(), []);
  } finally {
    await workspace.cleanup();
  }
});

test("CLI entrypoint: deliver --dry-run exits 0 with no repo side effects", async () => {
  const workspace = await makeWorkspace();
  try {
    const cli = join(ORCHESTRATOR_ROOT, "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [cli, "deliver", "--issue", "1", "--dry-run", "--repo", "lakii2982/mocl"],
      { cwd: workspace.root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /RESULT: DRY-RUN OK/);
    assert.match(result.stdout, /rolePromptSource: fallback/);
    assert.deepEqual(await workspace.list(), [], "CLI dry-run must not create files");
  } finally {
    await workspace.cleanup();
  }
});

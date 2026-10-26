/**
 * Scenario 2 — idempotency: an issue that already has an open PR must be
 * refused before any branch/worktree/PR mutation happens. Plus the happy-path
 * contract (PR body artifact, labels, report comment, state).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { deliverCommand } from "../lib/deliver.mjs";
import { readState } from "../lib/state.mjs";
import {
  constantClock,
  createFakeExec,
  happyHandler,
  makeWorkspace,
  PR_URL,
  writeIssueFixture,
} from "./helpers.mjs";

const ENV = {};

test("deliver refuses when the issue branch already has an open PR", async () => {
  const workspace = await makeWorkspace();
  try {
    const issueJsonPath = await writeIssueFixture(workspace.root);
    const exec = createFakeExec(
      happyHandler({
        prsForBranch: () => [{ number: 7, url: "https://github.com/lakii2982/mocl/pull/7", title: "existing" }],
      }),
    );

    const summary = await deliverCommand(
      { issue: 1, repo: "lakii2982/mocl", cwd: workspace.root, runner: "mock", issueJsonPath, print: false },
      { exec, now: constantClock(), env: ENV },
    );

    assert.equal(summary.exitCode, 1);
    assert.equal(summary.code, "duplicate-open-pr");
    const calls = exec.calls;
    assert.equal(exec.count((call) => call.command === "git" && call.args.includes("worktree")), 0, "no worktree");
    assert.equal(
      exec.count((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create"),
      0,
      "no PR creation",
    );
    assert.equal(exec.count((call) => call.command === "git" && call.args.includes("push")), 0, "no push");
    // The check targeted the deterministic branch name.
    assert.ok(
      calls.some(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "pr" &&
          call.args[1] === "list" &&
          call.args.includes("agent/1-add-orchestrator-dry-run-planner"),
      ),
      "idempotency check must use agent/<n>-<slug>",
    );
    // A preflight refusal is not a failed attempt: no blocked label, no state attempt.
    assert.equal(summary.attempts, 0);
    const state = await readState(workspace.root);
    assert.equal(state.issues["1"], undefined);
  } finally {
    await workspace.cleanup();
  }
});

test("deliver happy path creates the branch, PR body artifact, label and report", async () => {
  const workspace = await makeWorkspace();
  try {
    const issueJsonPath = await writeIssueFixture(workspace.root);
    const exec = createFakeExec(happyHandler());

    const summary = await deliverCommand(
      { issue: 1, repo: "lakii2982/mocl", cwd: workspace.root, runner: "mock", issueJsonPath, print: false },
      { exec, now: constantClock(), env: ENV },
    );

    assert.equal(summary.exitCode, 0, `${summary.code}: ${summary.message}`);
    assert.equal(summary.ok, true);
    assert.equal(summary.branch, "agent/1-add-orchestrator-dry-run-planner");
    assert.equal(summary.prUrl, PR_URL);
    assert.equal(summary.prNumber, 42);
    assert.equal(summary.rolePromptSource, "fallback");
    assert.equal(summary.issueSource, "file");
    assert.deepEqual(summary.changedFiles, ["src/feature.ts"]);

    // Worktree + push + PR + label + comment all went through the executor.
    const has = (command, ...fragments) =>
      exec.calls.some((call) => call.command === command && fragments.every((fragment) => call.args.includes(fragment)));
    assert.ok(has("git", "worktree", "add", "-b"));
    assert.ok(has("git", "push", "-u", "origin"));
    assert.ok(has("gh", "pr", "create", "--body-file"));
    assert.ok(has("gh", "issue", "edit", "status/in-review"));
    assert.ok(has("gh", "issue", "comment", "--body-file"));
    assert.ok(!exec.calls.some((call) => call.args.some((arg) => arg === "--force")));

    // PR body artifact exists and carries the contracted sections.
    assert.ok(summary.prBodyPath.endsWith("pr-body.md"));
    const prBody = await readFile(summary.prBodyPath, "utf8");
    for (const section of ["## 关联 issue", "## 证据表", "## 风险与回滚"]) {
      assert.ok(prBody.includes(section), `PR body missing ${section}`);
    }
    assert.match(prBody, /Closes #1/);
    assert.match(prBody, /typecheck/);
    assert.match(prBody, /powered_by-dsh/);
    assert.match(prBody, /status\/in-review/);

    // Delivery report artifact + local state.
    assert.ok(summary.reportPath.endsWith("delivery-report.md"));
    const report = await readFile(summary.reportPath, "utf8");
    assert.match(report, /## 交付摘要/);
    assert.match(report, /run `/);
    const state = await readState(workspace.root);
    assert.equal(state.issues["1"].lastStatus, "delivered");
    assert.equal(state.issues["1"].attempts, 0);
    assert.equal(state.issues["1"].pr.number, 42);

    // Event log written under .agentspec/runs/<iso>/events.jsonl.
    assert.ok(summary.eventsPath.endsWith("events.jsonl"));
    const events = (await readFile(summary.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "step.ok" && event.id === "open-pr"));
    assert.ok(events.every((event) => typeof event.ts === "string"));
  } finally {
    await workspace.cleanup();
  }
});

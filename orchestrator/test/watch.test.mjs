/**
 * Scenario 4 — `watch --once`: dispatch only `agent:ready` / non-blocked issues,
 * cap dispatches at `--max`, and report skipped reasons.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { watchCommand } from "../lib/watch.mjs";
import { constantClock, createFakeExec, happyHandler, makeWorkspace } from "./helpers.mjs";

const ENV = {};

function issue(number, title, labels) {
  return {
    number,
    title,
    labels: labels.map((name) => ({ name })),
    state: "OPEN",
    author: { login: "octocat" },
    url: `https://github.com/lakii2982/mocl/issues/${number}`,
  };
}

test("watch --once dispatches only eligible issues, up to --max", async () => {
  const workspace = await makeWorkspace();
  try {
    const issues = [
      issue(1, "One", ["agent:ready"]),
      issue(2, "Two", ["agent:ready", "status/blocked", "agent:blocked"]),
      issue(3, "Three", ["bug"]),
      issue(4, "Four", ["agent:ready"]),
      issue(5, "Five", ["agent:ready"]),
    ];
    const exec = createFakeExec(happyHandler({ issues }));

    const summary = await watchCommand(
      { once: true, max: 2, repo: "lakii2982/mocl", cwd: workspace.root, runner: "mock", maxAttempts: 2, print: false },
      { exec, now: constantClock(), env: ENV },
    );

    assert.equal(summary.exitCode, 0, `${summary.code}: ${summary.message}`);
    assert.equal(summary.cycles, 1);
    assert.equal(summary.dispatched.length, 2, `dispatched: ${JSON.stringify(summary.dispatched)}`);
    assert.deepEqual(
      summary.dispatched.map((entry) => entry.number).sort((left, right) => left - right),
      [1, 4],
    );
    // Only two worktrees were created → the concurrency cap held.
    assert.equal(exec.count((call) => call.command === "git" && call.args.includes("worktree") && call.args.includes("add")), 2);

    const skippedNumbers = summary.skipped.map((entry) => entry.number);
    assert.ok(skippedNumbers.includes(2), "blocked label must be skipped");
    assert.ok(skippedNumbers.includes(3), "missing agent:ready must be skipped");
    assert.ok(skippedNumbers.includes(5), "over-cap issue must be skipped");
    const issue2 = summary.skipped.find((entry) => entry.number === 2);
    assert.ok(issue2.reasons.includes("label:status/blocked"));
    assert.ok(issue2.reasons.includes("label:agent:blocked"));
    const issue3 = summary.skipped.find((entry) => entry.number === 3);
    assert.ok(issue3.reasons.includes("missing-label:agent:ready"));
    const issue5 = summary.skipped.find((entry) => entry.number === 5);
    assert.ok(issue5.reasons.includes("concurrency-limit"));

    // Audit log written for the watch run.
    assert.ok(summary.eventsPath.endsWith("events.jsonl"));
  } finally {
    await workspace.cleanup();
  }
});

test("watch --once with no eligible issues exits 0 and dispatches nothing", async () => {
  const workspace = await makeWorkspace();
  try {
    const issues = [issue(9, "Not ready", ["needs-triage"])];
    const exec = createFakeExec(happyHandler({ issues }));
    const summary = await watchCommand(
      { once: true, max: 3, repo: "lakii2982/mocl", cwd: workspace.root, runner: "mock", print: false },
      { exec, now: constantClock(), env: ENV },
    );
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.dispatched.length, 0);
    assert.equal(exec.count((call) => call.command === "git" && call.args.includes("worktree") && call.args.includes("add")), 0);
    assert.equal(exec.count((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create"), 0);
  } finally {
    await workspace.cleanup();
  }
});

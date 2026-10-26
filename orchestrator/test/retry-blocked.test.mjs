/**
 * Scenario 3 — retries and blocking: a runner that keeps failing must block the
 * issue after the configured attempt budget: both parking labels (status/blocked
 * and agent:blocked) plus an @owner comment, and exit code 3.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deliverCommand } from "../lib/deliver.mjs";
import { readState } from "../lib/state.mjs";
import { constantClock, createFakeExec, happyHandler, makeWorkspace, writeIssueFixture } from "./helpers.mjs";

const ENV = {};

test("runner keeps failing → 2nd attempt parks the issue (status + agent labels) and comments @owner", async () => {
  const workspace = await makeWorkspace();
  try {
    const issueJsonPath = await writeIssueFixture(workspace.root);
    const exec = createFakeExec(happyHandler());
    const run = (mockFailures) =>
      deliverCommand(
        {
          issue: 1,
          repo: "lakii2982/mocl",
          cwd: workspace.root,
          runner: "mock",
          issueJsonPath,
          mockFailures,
          maxAttempts: 2,
          print: false,
        },
        { exec, now: constantClock(), env: ENV },
      );

    const blockedLabelCalls = () =>
      exec.count(
        (call) => call.command === "gh" && call.args[0] === "issue" && call.args[1] === "edit" && call.args.includes("status/blocked"),
      );
    const commentCalls = () => exec.count((call) => call.command === "gh" && call.args[0] === "issue" && call.args[1] === "comment");

    const first = await run(1);
    assert.equal(first.exitCode, 1);
    assert.equal(first.code, "agent-run-failed");
    assert.equal(first.blocked, false);
    assert.equal(first.attempts, 1);
    assert.equal(blockedLabelCalls(), 0, "first failure is retryable, must not block");
    assert.equal(commentCalls(), 0, "first failure must not comment");
    let state = await readState(workspace.root);
    assert.equal(state.issues["1"].attempts, 1);
    assert.equal(state.issues["1"].blocked, false);
    // Failed worktree is cleaned up so the retry can create it again.
    assert.ok(
      exec.calls.some((call) => call.command === "git" && call.args.includes("worktree") && call.args.includes("remove")),
      "failed worktree must be cleaned up before retry",
    );
    assert.ok(
      exec.calls.some((call) => call.command === "git" && call.args.includes("branch") && call.args.includes("-D")),
      "failed local branch must be deleted before retry",
    );

    const second = await run(1);
    assert.equal(second.exitCode, 3, "retry budget exhausted → exit 3");
    assert.equal(second.blocked, true);
    assert.equal(second.attempts, 2);
    assert.equal(blockedLabelCalls(), 1, "second failure must apply the parking labels");
    assert.equal(commentCalls(), 1, "second failure must comment the reason");

    const blockedEdit = exec.filter(
      (call) => call.command === "gh" && call.args[0] === "issue" && call.args[1] === "edit" && call.args.includes("status/blocked"),
    )[0];
    assert.ok(blockedEdit.args.includes("--add-label"));
    assert.ok(blockedEdit.args.includes("status/blocked"));
    assert.ok(blockedEdit.args.includes("agent:blocked"));
    assert.ok(blockedEdit.args.includes("--remove-label"));

    const comment = exec.filter((call) => call.command === "gh" && call.args[0] === "issue" && call.args[1] === "comment")[0];
    const bodyFileIndex = comment.args.indexOf("--body-file");
    const commentPath = comment.args[bodyFileIndex + 1];
    const note = await readFile(commentPath, "utf8");
    assert.match(note, /@octocat/);
    assert.match(note, /status\/blocked/);
    assert.match(note, /agent:blocked/);
    assert.match(note, /agent-run-failed/);
    assert.match(note, /--remove-label/);

    state = await readState(workspace.root);
    assert.equal(state.issues["1"].attempts, 2);
    assert.equal(state.issues["1"].blocked, true);
    assert.equal(state.issues["1"].lastStatus, "blocked");
  } finally {
    await workspace.cleanup();
  }
});

test("a third deliver after blocking still respects --max-attempts (no unbounded retries)", async () => {
  const workspace = await makeWorkspace();
  try {
    const issueJsonPath = await writeIssueFixture(workspace.root);
    const exec = createFakeExec(happyHandler());
    const runOnce = (mockFailures) =>
      deliverCommand(
        {
          issue: 1,
          repo: "lakii2982/mocl",
          cwd: workspace.root,
          runner: "mock",
          issueJsonPath,
          mockFailures,
          maxAttempts: 2,
          print: false,
        },
        { exec, now: constantClock(), env: ENV },
      );

    await runOnce(1);
    await runOnce(1);
    const third = await runOnce(1);

    assert.equal(third.exitCode, 3);
    assert.equal(third.attempts, 3);
    assert.equal(third.blocked, true);
    const state = await readState(workspace.root);
    assert.equal(state.issues["1"].attempts, 3);
    assert.equal(state.issues["1"].blocked, true);
  } finally {
    await workspace.cleanup();
  }
});

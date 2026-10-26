/**
 * Exit-code contract (docs/process/10 §2):
 *   0 success / PASS · 1 fail · 2 usage · 3 retry budget exhausted · 4 env unavailable
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { ORCHESTRATOR_ROOT } from "../lib/paths.mjs";
import { deliverCommand } from "../lib/deliver.mjs";
import { statusCommand } from "../lib/status.mjs";
import { EXIT_BLOCKED, EXIT_ENV, EXIT_USAGE, exitCodeForCode } from "../lib/exit-codes.mjs";
import { constantClock, createFakeExec, happyHandler, makeWorkspace, writeIssueFixture } from "./helpers.mjs";

const CLI = join(ORCHESTRATOR_ROOT, "cli.mjs");
const ENV = {};

test("retry budget exhausted maps to exit code 3", async () => {
  const workspace = await makeWorkspace();
  try {
    const issueJsonPath = await writeIssueFixture(workspace.root);
    const exec = createFakeExec(happyHandler());
    const run = () =>
      deliverCommand(
        { issue: 1, repo: "lakii2982/mocl", cwd: workspace.root, runner: "mock", issueJsonPath, mockFailures: 1, maxAttempts: 2, print: false },
        { exec, now: constantClock(), env: ENV },
      );
    const first = await run();
    const second = await run();
    assert.equal(first.exitCode, 1, "a retryable failure is exit 1");
    assert.equal(second.exitCode, 3, "retry budget exhausted is exit 3");
    assert.equal(second.blocked, true);
    assert.equal(exitCodeForCode("agent-run-failed"), 1);
    assert.equal(EXIT_BLOCKED, 3);
  } finally {
    await workspace.cleanup();
  }
});

test("status: environment unavailable with no cache maps to exit code 4", async () => {
  const workspace = await makeWorkspace();
  try {
    const failingGh = createFakeExec((call) =>
      call.command === "gh"
        ? { code: 1, stderr: "error connecting to api.github.com" }
        : { code: 0, stdout: "" },
    );
    const summary = await statusCommand(
      { repo: "lakii2982/mocl", cwd: workspace.root, print: false },
      { exec: failingGh, now: constantClock(), env: ENV },
    );
    assert.equal(summary.exitCode, EXIT_ENV);
    assert.equal(summary.offline, true);
    assert.equal(summary.code, "env-unavailable");
    assert.match(summary.note, /无本地缓存/);
  } finally {
    await workspace.cleanup();
  }
});

test("status: offline with a local cache stays exit 0 (SKIP), --strict upgrades to 4", async () => {
  const workspace = await makeWorkspace();
  try {
    await mkdir(join(workspace.root, ".agentspec"), { recursive: true });
    await writeFile(
      join(workspace.root, ".agentspec", "status-cache.json"),
      `${JSON.stringify({ cachedAt: "2026-01-02T03:04:05.000Z", repo: "lakii2982/mocl", issues: [] }, null, 2)}\n`,
      "utf8",
    );
    const failingGh = createFakeExec(() => ({ code: 1, stderr: "no network" }));
    const relaxed = await statusCommand(
      { repo: "lakii2982/mocl", cwd: workspace.root, offline: true, print: false },
      { exec: failingGh, now: constantClock(), env: ENV },
    );
    assert.equal(relaxed.exitCode, 0);
    assert.equal(relaxed.offline, true);
    assert.match(relaxed.note, /SKIP:offline/);

    const strict = await statusCommand(
      { repo: "lakii2982/mocl", cwd: workspace.root, offline: true, strict: true, print: false },
      { exec: failingGh, now: constantClock(), env: ENV },
    );
    assert.equal(strict.exitCode, EXIT_ENV);
  } finally {
    await workspace.cleanup();
  }
});

test("CLI exits 4 when gh is unavailable (no cache)", async () => {
  const workspace = await makeWorkspace();
  try {
    const result = spawnSync(process.execPath, [CLI, "status", "--json", "--repo", "lakii2982/mocl"], {
      cwd: workspace.root,
      encoding: "utf8",
      // A PATH without gh makes the spawn fail with ENOENT.
      env: { ...process.env, PATH: "/nonexistent-bin", NO_COLOR: "1" },
    });
    assert.equal(result.status, 4, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /offline|SKIP:offline|env-unavailable/);
  } finally {
    await workspace.cleanup();
  }
});

test("repo inference failure maps to usage exit code 2", async () => {
  const workspace = await makeWorkspace();
  try {
    const failingExec = createFakeExec(() => ({ code: 128, stderr: "not a git repository" }));
    const summary = await deliverCommand(
      { issue: 1, cwd: workspace.root, runner: "mock", print: false },
      { exec: failingExec, now: constantClock(), env: ENV },
    );
    assert.equal(summary.exitCode, EXIT_USAGE);
    assert.equal(summary.code, "repo-unresolved");
  } finally {
    await workspace.cleanup();
  }
});

test("CLI usage errors stay exit code 2", async () => {
  const workspace = await makeWorkspace();
  try {
    const unknownCommand = spawnSync(process.execPath, [CLI, "bogus"], {
      cwd: workspace.root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(unknownCommand.status, 2);

    const badRunner = spawnSync(
      process.execPath,
      [CLI, "deliver", "--issue", "1", "--dry-run", "--repo", "lakii2982/mocl", "--runner", "nope"],
      { cwd: workspace.root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    assert.equal(badRunner.status, 2, `stdout=${badRunner.stdout}\nstderr=${badRunner.stderr}`);
    assert.match(`${badRunner.stdout}${badRunner.stderr}`, /invalid-runner/);
  } finally {
    await workspace.cleanup();
  }
});

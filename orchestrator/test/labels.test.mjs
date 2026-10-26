/**
 * Label truth-source alignment (docs/process/10 §2): every label the
 * orchestrator reads/writes must exist verbatim in `.github/labels.yml`; a
 * missing/renamed label fails closed with exit code 4 — never a silent fallback
 * to another naming scheme.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { ORCHESTRATOR_ROOT } from "../lib/paths.mjs";
import {
  AGENT_BLOCKED,
  AGENT_READY,
  AGENT_REVIEW,
  AGENT_RUNNING,
  ACCEPTED,
  BLOCKED,
  DONE,
  IN_PROGRESS,
  IN_REVIEW,
  LABELS,
  NEEDS_INFO,
  NEEDS_TRIAGE,
  READY,
  REQUIRED_LABELS,
  defaultLabelsFile,
  loadLabelSet,
  parseLabelNames,
} from "../lib/labels.mjs";
import { OrchestratorError } from "../lib/errors.mjs";
import { deliverCommand } from "../lib/deliver.mjs";
import { constantClock, makeWorkspace, throwingExec } from "./helpers.mjs";

const CLI = join(ORCHESTRATOR_ROOT, "cli.mjs");
const LABELS_YML = defaultLabelsFile();

/** The eight workflow-critical labels the CLI must be able to write/read. */
const CORE_CONSTANTS = {
  READY,
  AGENT_READY,
  AGENT_RUNNING,
  AGENT_REVIEW,
  AGENT_BLOCKED,
  NEEDS_INFO,
  ACCEPTED,
  IN_PROGRESS,
  IN_REVIEW,
  BLOCKED,
  DONE,
};

test("labels.yml is the single source of truth: 8+ constants exist verbatim", async () => {
  const text = await readFile(LABELS_YML, "utf8");
  const names = parseLabelNames(text);
  assert.ok(names.length >= REQUIRED_LABELS.length, `parsed ${names.length} labels`);
  for (const [constant, value] of Object.entries(CORE_CONSTANTS)) {
    assert.ok(names.includes(value), `${constant}=${value} missing from ${LABELS_YML}`);
  }
  for (const label of REQUIRED_LABELS) {
    assert.ok(names.includes(label), `REQUIRED_LABELS entry ${label} missing`);
  }
  // No duplicate names (labels.yml contract) and the canonical bundle is frozen.
  assert.equal(new Set(names).size, names.length, "duplicate label names");
  assert.equal(Object.isFrozen(LABELS), true);
  assert.equal(LABELS.IN_REVIEW, "status/in-review");
  assert.equal(LABELS.BLOCKED, "status/blocked");
  assert.equal(LABELS.AGENT_BLOCKED, "agent:blocked");
});

test("orchestrator source carries no divergent label naming", async () => {
  // Legacy colon-style workflow labels must not appear anywhere outside tests.
  const legacy = new RegExp(["status", "(?::)(?:blocked|in-review|done|in-progress|needs-info|needs-triage|accepted)"].join(""));
  const files = [];
  const libDir = join(ORCHESTRATOR_ROOT, "lib");
  for (const entry of await readdir(libDir)) {
    if (entry.endsWith(".mjs")) files.push(join(libDir, entry));
  }
  files.push(join(ORCHESTRATOR_ROOT, "cli.mjs"), join(ORCHESTRATOR_ROOT, "README.md"));
  const templatesDir = join(ORCHESTRATOR_ROOT, "templates");
  for (const entry of await readdir(templatesDir)) files.push(join(templatesDir, entry));

  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.equal(legacy.test(text), false, `legacy label naming in ${file}`);
  }
  // Writes/reads go through the labels adapter, not ad-hoc literals.
  for (const name of ["deliver.mjs", "watch.mjs", "status.mjs", "issue.mjs", "prbody.mjs"]) {
    const text = await readFile(join(libDir, name), "utf8");
    assert.match(text, /from "\.\/labels\.mjs"/, `${name} must import labels.mjs`);
  }
});

test("loadLabelSet fails closed when a required label is removed", async () => {
  const workspace = await makeWorkspace();
  try {
    const text = await readFile(LABELS_YML, "utf8");
    const broken = text.replace('- name: "status/in-review"', '- name: "status/in-review-renamed"');
    assert.notEqual(broken, text, "fixture must actually remove status/in-review");
    const brokenPath = join(workspace.root, "labels-broken.yml");
    await writeFile(brokenPath, broken, "utf8");

    await assert.rejects(
      () => loadLabelSet({ file: brokenPath }),
      (error) =>
        error instanceof OrchestratorError &&
        error.code === "labels-incomplete" &&
        error.message.includes("status/in-review"),
    );

    await assert.rejects(
      () => loadLabelSet({ file: join(workspace.root, "missing-labels.yml") }),
      (error) => error instanceof OrchestratorError && error.code === "labels-unavailable",
    );
  } finally {
    await workspace.cleanup();
  }
});

test("CLI exits 4 (fail-closed) when the label truth-source is broken", async () => {
  const workspace = await makeWorkspace();
  try {
    const text = await readFile(LABELS_YML, "utf8");
    const brokenPath = join(workspace.root, "labels-broken.yml");
    await writeFile(brokenPath, text.replace('- name: "status/in-review"', '- name: "status/wrong-name"'), "utf8");

    const env = { ...process.env, MOCL_LABELS_FILE: brokenPath, NO_COLOR: "1" };
    const status = spawnSync(process.execPath, [CLI, "status", "--json", "--repo", "lakii2982/mocl"], {
      cwd: workspace.root,
      encoding: "utf8",
      env,
    });
    assert.equal(status.status, 4, `status=${status.status}\nstdout=${status.stdout}\nstderr=${status.stderr}`);
    assert.match(`${status.stdout}${status.stderr}`, /status\/in-review/);

    const deliver = spawnSync(
      process.execPath,
      [CLI, "deliver", "--issue", "1", "--dry-run", "--repo", "lakii2982/mocl"],
      { cwd: workspace.root, encoding: "utf8", env },
    );
    assert.equal(deliver.status, 4, `stdout=${deliver.stdout}\nstderr=${deliver.stderr}`);
    assert.match(`${deliver.stdout}${deliver.stderr}`, /labels-incomplete|status\/in-review/);
    assert.equal(existsSync(join(workspace.root, ".agentspec")), false, "no side effects on fail-closed");
  } finally {
    await workspace.cleanup();
  }
});

test("MOCL_LABELS_FILE override is honoured by deliver --dry-run", async () => {
  const workspace = await makeWorkspace();
  try {
    const copyPath = join(workspace.root, "labels.yml");
    await writeFile(copyPath, await readFile(LABELS_YML, "utf8"), "utf8");

    const summary = await deliverCommand(
      { issue: 1, dryRun: true, repo: "lakii2982/mocl", cwd: workspace.root, print: false },
      { exec: throwingExec(), now: constantClock(), env: { MOCL_LABELS_FILE: copyPath } },
    );
    assert.equal(summary.exitCode, 0, `${summary.code}: ${summary.message}`);
    assert.equal(summary.labelsPath, copyPath);
    assert.deepEqual(await workspace.list(), ["labels.yml"]);
  } finally {
    await workspace.cleanup();
  }
});

test("watch exits 4 when the label truth-source is unavailable", async () => {
  const workspace = await makeWorkspace();
  try {
    await mkdir(workspace.root, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [CLI, "watch", "--once", "--dry-run", "--repo", "lakii2982/mocl"],
      {
        cwd: workspace.root,
        encoding: "utf8",
        env: { ...process.env, MOCL_LABELS_FILE: join(workspace.root, "nope.yml"), NO_COLOR: "1" },
      },
    );
    assert.equal(result.status, 4, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /labels-unavailable/);
  } finally {
    await workspace.cleanup();
  }
});

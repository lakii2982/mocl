/**
 * Label source of truth adapter.
 *
 * The only label names the orchestrator may use are the ones declared in
 * `.github/labels.yml` (process doc `10-DSH-LOCAL-AGENTS.md` §2: 标签真源，不得
 * 硬编码另一套命名). This module:
 *
 * 1. declares the canonical names once (below) — the single place in the codebase;
 * 2. parses `- name: "..."` entries from the YAML *without a YAML dependency*;
 * 3. fails closed (`labels-unavailable` / `labels-incomplete`, exit code 4) when
 *    the file is missing, unparsable, or lacks a label the orchestrator writes.
 *
 * Commands call `ensureLabels(ctx)` before touching GitHub; no fallback naming.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { OrchestratorError } from "./errors.mjs";
import { ORCHESTRATOR_ROOT } from "./paths.mjs";

/* ── canonical names (must exist verbatim in .github/labels.yml) ───────── */

export const AGENT_READY = "agent:ready";
export const AGENT_RUNNING = "agent:running";
export const AGENT_REVIEW = "agent:review";
export const AGENT_BLOCKED = "agent:blocked";

export const NEEDS_TRIAGE = "status/needs-triage";
export const NEEDS_INFO = "status/needs-info";
export const ACCEPTED = "status/accepted";
export const IN_PROGRESS = "status/in-progress";
export const IN_REVIEW = "status/in-review";
export const BLOCKED = "status/blocked";
export const DONE = "status/done";

/** Alias kept for the wording used in the process doc (`READY` = agent:ready). */
export const READY = AGENT_READY;

/** Labels the orchestrator reads or writes; every one must exist in labels.yml. */
export const REQUIRED_LABELS = Object.freeze([
  AGENT_READY,
  AGENT_RUNNING,
  AGENT_REVIEW,
  AGENT_BLOCKED,
  NEEDS_TRIAGE,
  NEEDS_INFO,
  ACCEPTED,
  IN_PROGRESS,
  IN_REVIEW,
  BLOCKED,
  DONE,
]);

/** Convenience bundle (`LABELS.IN_REVIEW` etc.). */
export const LABELS = Object.freeze({
  AGENT_READY,
  AGENT_RUNNING,
  AGENT_REVIEW,
  AGENT_BLOCKED,
  NEEDS_TRIAGE,
  NEEDS_INFO,
  ACCEPTED,
  IN_PROGRESS,
  IN_REVIEW,
  BLOCKED,
  DONE,
});

/** `<repo>/.github/labels.yml`; the repo is the mocl checkout that owns this lib. */
export function defaultLabelsFile() {
  return resolve(ORCHESTRATOR_ROOT, "..", ".github", "labels.yml");
}

/**
 * Parse label names out of the YAML. Only the `- name: "..."` shape matters;
 * anchors/aliases/nested maps are intentionally not supported.
 * @returns {string[]}
 */
export function parseLabelNames(yamlText) {
  const names = [];
  for (const line of String(yamlText ?? "").split(/\r?\n/)) {
    const match = /^\s*-\s*name:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (match === null) continue;
    const name = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (name !== "") names.push(name);
  }
  return names;
}

/**
 * Load + validate the label set.
 * @param {{ file?: string, root?: string }} [options] `file` wins; otherwise
 *   `$MOCL_LABELS_FILE` handled by `ensureLabels`, then the mocl labels.yml.
 * @returns {Promise<{ path: string, names: string[], has(label: string): boolean }>}
 */
export async function loadLabelSet({ file } = {}) {
  const path = file === undefined || file === null || file === "" ? defaultLabelsFile() : file;
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new OrchestratorError("labels-unavailable", `标签真源不可读: ${path} (${error?.message ?? error})`, {
      path,
    });
  }
  const names = parseLabelNames(text);
  if (names.length === 0) {
    throw new OrchestratorError("labels-unavailable", `标签真源中没有解析到任何 \`- name:\` 条目: ${path}`, { path });
  }
  const present = new Set(names);
  const missing = REQUIRED_LABELS.filter((label) => !present.has(label));
  if (missing.length > 0) {
    throw new OrchestratorError(
      "labels-incomplete",
      `标签真源缺少 orchestrator 必需的标签: ${missing.join(", ")} (${path})`,
      { path, missing },
    );
  }
  return {
    path,
    names,
    has(label) {
      return present.has(label);
    },
  };
}

/**
 * Validate labels for a command. Resolution order: `--labels-file` >
 * `$MOCL_LABELS_FILE` > `<mocl>/.github/labels.yml`. Relative paths are resolved
 * against the command cwd. On success the set is attached as `ctx.labels`.
 */
export async function ensureLabels(ctx, options = {}) {
  const raw = options.labelsFile ?? ctx.env.MOCL_LABELS_FILE;
  const file = raw === undefined || raw === null || raw === "" ? undefined : isAbsolute(String(raw)) ? String(raw) : resolve(ctx.cwd, String(raw));
  const set = await loadLabelSet({ file });
  ctx.labels = set;
  ctx.log(`  labels: ${set.names.length} 个，真源 ${set.path}`);
  return set;
}

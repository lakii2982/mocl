/**
 * Minimal `{{placeholder}}` rendering plus section validation.
 *
 * Templates live in `orchestrator/templates/` and are part of the contract:
 * the PR body must keep the "关联 issue / 证据表 / 风险与回滚" sections, so
 * `assertSections` fails the run if a template edit drops one.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "./errors.mjs";
import { TEMPLATES_DIR } from "./paths.mjs";

/**
 * Replace `{{key}}` placeholders. Unknown placeholders are an error (a template
 * typo must not silently produce half-empty PR bodies).
 */
export function renderTemplate(template, vars = {}) {
  return String(template ?? "").replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      fail("template-placeholder", `template placeholder ${match} has no value`, { key });
    }
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/** Fail if any required heading/section text is missing. */
export function assertSections(text, sections, { kind = "document" } = {}) {
  const missing = sections.filter((section) => !String(text).includes(section));
  if (missing.length > 0) {
    fail("template-missing-sections", `${kind} is missing required sections: ${missing.join(", ")}`, { missing });
  }
  return text;
}

/**
 * Load a template from `orchestrator/templates/` (or an explicit path),
 * returning `fallback` when the file is absent.
 */
export async function loadTemplate({ name, templatePath, fallback = null } = {}) {
  const path = templatePath ?? join(TEMPLATES_DIR, name);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== null) return fallback;
    fail("template-unreadable", `cannot read template ${path}: ${error?.message ?? error}`);
  }
}

/** Make issue/PR-sourced markdown safe to embed inside a template section. */
export function indentBlock(text, prefix = "> ") {
  const value = String(text ?? "").trim();
  if (value === "") return `${prefix}(空)`;
  return value
    .split(/\r?\n/)
    .map((line) => (line === "" ? prefix.trimEnd() : `${prefix}${line}`))
    .join("\n");
}

/** Collapse a free-form block to a one-line summary for artifact headers. */
export function summarize(text, max = 300) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

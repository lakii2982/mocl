/** Small shared helpers. Zero dependencies, node: builtins only. */

import { OrchestratorError } from "./errors.mjs";

/** ISO timestamp that is safe to use as a directory name (`:` and `.` replaced). */
export function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Keep the tail of a command output; evidence only needs the interesting end. */
export function tail(text, max = 2000) {
  const value = String(text ?? "");
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

export function truncate(text, max = 400) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function oneLine(text, max = 120) {
  return truncate(String(text ?? "").replace(/\s+/g, " ").trim(), max);
}

/** Parse an integer CLI/env value; throws a typed error instead of NaN. */
export function toPositiveInt(value, fallback, { name = "value", max = 1_000_000 } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new OrchestratorError("invalid-argument", `${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** `1234` -> `1234`, `12345` -> `12345`; durations in ms, rounded. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

export function unique(list) {
  return [...new Set(list)];
}

/** Strip characters that break a git ref / directory name. */
export function safeSegment(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

/**
 * Credential redaction.
 *
 * The orchestrator never needs a token value: `gh`/`git` read their own
 * credentials. Still, command arguments (e.g. `git remote set-url ...`,
 * `https://x-access-token:...@github.com/...`) and child output can contain
 * secrets. Everything written to `events.jsonl` or printed passes through
 * this module.
 */

const SECRET_KEY = /(token|secret|password|passwd|credential|authorization|api[-_]?key|private[-_]?key|access[-_]?key|auth[-_]?cookie)/i;

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abps]-[A-Za-z0-9-]{10,}\b/g,
  /(?<=\/\/)[^/@\s:]+:[^/@\s]+(?=@)/g, // user:password@host in URLs
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)=[^\s"']+/g,
];

const MAX_DEPTH = 6;
const MAX_STRING = 4000;

/** Redact known secret shapes from free text. */
export function redactText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text.length <= MAX_STRING ? text : `${text.slice(0, MAX_STRING)}…`;
}

/**
 * Deep-redact an artifact payload.
 * - keys that look like credentials are blanked entirely
 * - strings are pattern-scrubbed and truncated
 * - arrays/objects are walked with a depth cap
 */
export function redactValue(value, depth = 0) {
  if (depth > MAX_DEPTH) return "[depth-limit]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Redact command arguments before they are logged. */
export function redactArgs(args) {
  return redactValue(Array.isArray(args) ? args : []);
}

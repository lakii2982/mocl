/**
 * Append-only audit log: `.agentspec/runs/<iso>/events.jsonl`.
 *
 * - one JSON object per line, redacted before it touches the disk
 * - writes are queued so callers can fire-and-forget; `flush()` drains the queue
 * - in dry-run mode nothing is written to disk (the run has zero side effects)
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { redactValue } from "./redact.mjs";

/**
 * @param {{ dir: string; persist?: boolean; now?: () => Date }} options
 */
export function createRunLog({ dir, persist = true, now = () => new Date() }) {
  const events = [];
  const path = join(dir, "events.jsonl");
  let queue = persist ? mkdir(dir, { recursive: true }).then(() => undefined) : Promise.resolve();
  queue = queue.catch(() => {
    // A read-only workspace must not crash the run; the in-memory log survives.
  });

  function event(type, payload = {}) {
    const record = { ts: now().toISOString(), type, ...redactValue(payload) };
    events.push(record);
    if (persist) {
      const line = `${JSON.stringify(record)}\n`;
      queue = queue.then(() => appendFile(path, line, "utf8")).catch(() => undefined);
    }
    return record;
  }

  return {
    dir,
    path,
    persist,
    events,
    event,
    async flush() {
      await queue;
    },
  };
}

/** Pull a single event type out of a run log (handy for tests/summaries). */
export function eventsOfType(events, type) {
  return events.filter((event) => event.type === type);
}

/**
 * Typed errors for the orchestrator.
 *
 * Every failure surfaced to a human or a log line carries a stable `code`
 * so scripts, tests and the Issue comment templates can rely on it.
 */

export class OrchestratorError extends Error {
  /**
   * @param {string} code stable machine-readable code, e.g. `issue-not-eligible`
   * @param {string} message human readable one-liner
   * @param {Record<string, unknown>} [details] structured context for logs/artifacts
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
export function fail(code, message, details = {}) {
  throw new OrchestratorError(code, message, details);
}

/** Normalise any thrown value into the `{ code, message, details }` shape. */
export function toFailure(error) {
  if (error instanceof OrchestratorError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: "internal-error",
    message: String(error?.message ?? error),
    details: {},
  };
}

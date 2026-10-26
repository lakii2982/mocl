/**
 * Agent runner: turns a role prompt into an argv invocation.
 *
 * Runners:
 * - `dsh`  (default, real): command template `dsh headless`, overridable via
 *   `MOCL_AGENT_CMD` / `--agent-cmd`. Supports a `{prompt}` placeholder; without
 *   it the prompt is appended as the last argv element.
 * - `mock` (tests/offline): no process, deterministic reply, optional failure
 *   budget via `--mock-failures` so retry/blocked logic can be exercised.
 *
 * No shell is involved anywhere: the prompt is a single argv element, so quotes,
 * newlines and `;`/`$()` inside it are inert.
 */

import { fail } from "./errors.mjs";
import { tail } from "./util.mjs";

export const DEFAULT_AGENT_CMD = "dsh headless";
export const PROMPT_PLACEHOLDER = "{prompt}";

/**
 * Split a command template into argv tokens (quote-aware, no shell expansion).
 * @param {string} template
 * @param {{ source?: string }} [options]
 * @returns {string[]}
 */
export function tokenizeCommandTemplate(template, { source = "MOCL_AGENT_CMD" } = {}) {
  const text = String(template ?? "").trim();
  if (text === "") fail("invalid-agent-cmd", `${source} is empty; expected e.g. "dsh headless"`);

  const tokens = [];
  let current = "";
  let quote = null;
  let hasToken = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\" && (text[index + 1] === quote || text[index + 1] === "\\")) {
        current += text[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += text[index + 1];
      hasToken = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }

  if (quote !== null) {
    fail("invalid-agent-cmd", `unterminated ${quote} quote in ${source}: ${text}`);
  }
  if (hasToken) tokens.push(current);
  if (tokens.length === 0) fail("invalid-agent-cmd", `${source} has no command: ${text}`);
  return tokens;
}

/**
 * Build `{ command, args }` for one agent turn.
 * @param {{ runner?: string, commandTemplate?: string | null, prompt: string, env?: NodeJS.ProcessEnv }} input
 */
export function buildRunnerInvocation({ runner = "dsh", commandTemplate, prompt, env = process.env }) {
  const text = String(prompt ?? "");
  if (text.includes("\0")) fail("invalid-prompt", "agent prompt contains a NUL byte");

  if (runner === "mock") {
    return { command: "mock", args: [], template: null, promptInjected: false, mock: true };
  }
  if (runner !== "dsh") {
    fail("invalid-runner", `unknown runner ${JSON.stringify(runner)} (expected "dsh" or "mock")`);
  }

  const template = commandTemplate ?? env.MOCL_AGENT_CMD ?? DEFAULT_AGENT_CMD;
  const tokens = tokenizeCommandTemplate(template);
  const placeholderIndex = tokens.indexOf(PROMPT_PLACEHOLDER);
  if (placeholderIndex === 0) {
    fail("invalid-agent-cmd", `${PROMPT_PLACEHOLDER} cannot be the command itself: ${template}`);
  }

  let args;
  let promptInjected;
  if (placeholderIndex > 0) {
    args = [...tokens.slice(1)];
    args[placeholderIndex - 1] = text;
    promptInjected = "placeholder";
  } else {
    args = [...tokens.slice(1), text];
    promptInjected = "appended";
  }

  return { command: tokens[0], args, template, promptInjected, mock: false };
}

/**
 * Execute one agent turn through the injected executor.
 * @returns {Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, runner: string, role: string, mock: boolean, invocation: object | null, durationMs?: number }>}
 */
export async function runAgent(ctx, { runner, role = "implementer", prompt, cwd, timeoutMs }) {
  if (runner === "mock") {
    const remaining = Number(ctx.mock?.failuresRemaining ?? 0);
    if (remaining > 0) {
      ctx.mock.failuresRemaining = remaining - 1;
      return {
        ok: false,
        code: 1,
        signal: null,
        stdout: "",
        stderr: "mock runner: simulated failure",
        runner: "mock",
        role,
        mock: true,
        invocation: null,
        durationMs: 0,
      };
    }
    return {
      ok: true,
      code: 0,
      signal: null,
      stdout: `mock runner: role=${role} promptChars=${String(prompt ?? "").length} verdict=VERDICT: PASS`,
      stderr: "",
      runner: "mock",
      role,
      mock: true,
      invocation: null,
      durationMs: 0,
    };
  }

  const invocation = buildRunnerInvocation({
    runner,
    commandTemplate: ctx.env.MOCL_AGENT_CMD,
    prompt,
    env: ctx.env,
  });
  const result = await ctx.run(invocation.command, invocation.args, {
    cwd,
    mutating: true,
    intent: `run ${role} agent`,
    timeoutMs: timeoutMs ?? 30 * 60_000,
  });
  return { ...result, runner, role, mock: false, invocation };
}

/**
 * Availability probe for the real runner. Dry-run never spawns anything.
 * @returns {Promise<{ ok: boolean, skipped: boolean, reason?: string, version?: string }>}
 */
export async function probeRunner(ctx, { runner, commandTemplate }) {
  if (runner === "mock") {
    return { ok: true, skipped: true, reason: "mock runner never touches the network or DSH" };
  }
  const command = tokenizeCommandTemplate(
    commandTemplate ?? ctx.env.MOCL_AGENT_CMD ?? DEFAULT_AGENT_CMD,
  )[0];
  const result = await ctx.run(command, ["--version"], {
    intent: "probe agent runner availability",
    timeoutMs: 30_000,
  });
  if (result.dryRun) return { ok: true, skipped: true, planned: true, reason: "dry-run: probe planned only" };
  if (!result.ok) {
    return {
      ok: false,
      skipped: true,
      reason: `${command} --version failed (exit ${result.code ?? "?"})`,
      stderr: tail(result.stderr, 500),
    };
  }
  const version = String(result.stdout).trim().split(/\r?\n/)[0] ?? "";
  return { ok: true, skipped: false, version: version || "(no version output)" };
}

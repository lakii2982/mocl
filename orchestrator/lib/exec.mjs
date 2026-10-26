/**
 * The single place where external processes are started.
 *
 * Contract: every `gh` / `git` / `dsh` / gate invocation inside the
 * orchestrator goes through an injected `exec(command, args, options)`.
 * Tests inject a fake exec, so nothing here is hard-coded into the pipelines.
 * `shell: false` always: arguments are passed as an argv array, so a prompt
 * containing quotes/newlines can never be shell-interpreted.
 */

import { spawn as nodeSpawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_CAPTURE = 1_000_000;

/**
 * @typedef {{
 *   command: string;
 *   args: string[];
 *   cwd?: string;
 *   ok: boolean;
 *   code: number | null;
 *   signal?: string | null;
 *   stdout: string;
 *   stderr: string;
 *   durationMs: number;
 *   timedOut?: boolean;
 *   error?: string;
 *   dryRun?: boolean;
 * }} ExecResult
 */

/**
 * Real exec: spawn without a shell, capture stdout/stderr, enforce a timeout.
 * @returns {(command: string, args?: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<ExecResult>}
 */
export function createSpawnExec({ spawnImpl = nodeSpawn } = {}) {
  return function exec(command, args = [], options = {}) {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolvePromise) => {
      let settled = false;
      let timer = null;
      let timedOut = false;
      let stdout = "";
      let stderr = "";

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolvePromise({
          command,
          args,
          cwd: options.cwd,
          durationMs: Date.now() - startedAt,
          stdout,
          stderr,
          code: null,
          ok: false,
          ...result,
        });
      };

      let child;
      try {
        child = spawnImpl(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        finish({ error: `spawn failed: ${error?.message ?? String(error)}` });
        return;
      }

      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      child.stdout?.on?.("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > MAX_CAPTURE) stdout = stdout.slice(-MAX_CAPTURE);
      });
      child.stderr?.on?.("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > MAX_CAPTURE) stderr = stderr.slice(-MAX_CAPTURE);
      });
      child.on?.("error", (error) => {
        finish({ error: `spawn failed: ${error?.message ?? String(error)}` });
      });
      child.on?.("close", (code, signal) => {
        finish({ ok: code === 0 && !timedOut, code, signal, timedOut });
      });

      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill?.("SIGKILL");
        } catch {
          // Process already gone.
        }
      }, timeoutMs);
      timer.unref?.();
    });
  };
}

/** Quote one argv element for human-readable plans (display only, never executed). */
export function formatCommand(command, args = []) {
  return [command, ...args].map((arg) => formatArg(arg)).join(" ");
}

function formatArg(value) {
  const text = String(value);
  if (/^[\w@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Execution context shared by every pipeline.
 *
 * `ctx.run()` is the ONLY way pipelines start external processes. In dry-run
 * mode it records the command as "planned" and returns an ok result without
 * touching the injected executor, so fake executors observe zero calls and the
 * workspace stays byte-identical.
 */

import { join, resolve } from "node:path";
import { createSpawnExec, formatCommand, DEFAULT_TIMEOUT_MS } from "./exec.mjs";
import { createRunLog } from "./runlog.mjs";
import { redactArgs } from "./redact.mjs";
import { ensureStateRoot } from "./state.mjs";
import { isoStamp, tail } from "./util.mjs";

/** Long argv elements (role prompts, PR bodies) are truncated for display only. */
const DISPLAY_ARG_LIMIT = 240;

function displayCommand(command, args) {
  const shortened = args.map((arg) => {
    const text = String(arg);
    return text.length <= DISPLAY_ARG_LIMIT ? text : `${text.slice(0, DISPLAY_ARG_LIMIT - 1)}…`;
  });
  return formatCommand(command, shortened);
}

/**
 * @param {Record<string, any>} options command options (dryRun, cwd, print, runId, ...)
 * @param {{ exec?: Function, now?: () => Date, env?: NodeJS.ProcessEnv, cwd?: string, print?: boolean }} deps
 */
export async function createContext(options = {}, deps = {}) {
  const cwd = resolve(options.cwd ?? deps.cwd ?? process.cwd());
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const dryRun = options.dryRun === true;
  const runId = options.runId ?? isoStamp(now());
  const persistEvents = dryRun ? false : options.persistEvents !== false;
  const print = options.print ?? deps.print ?? false;

  if (persistEvents) await ensureStateRoot(cwd);

  const events = createRunLog({
    dir: join(cwd, ".agentspec", "runs", runId),
    persist: persistEvents,
    now,
  });

  const planned = [];
  const lines = [];
  const exec = deps.exec ?? createSpawnExec();
  const ctx = {
    cwd,
    dryRun,
    env,
    runId,
    events,
    planned,
    lines,
    print,
    now,
    /** mock-runner failure budget, only used by `--runner mock --mock-failures n`. */
    mock: { failuresRemaining: Number(options.mockFailures ?? 0) || 0 },
    log(line = "") {
      lines.push(String(line));
      if (print) console.log(String(line));
    },
    warn(line) {
      ctx.log(`WARN: ${line}`);
    },
  };

  /**
   * @param {string} command
   * @param {string[]} [args]
   * @param {{ cwd?: string, mutating?: boolean, intent?: string, timeoutMs?: number }} [runOptions]
   */
  ctx.run = async function run(command, args = [], runOptions = {}) {
    const commandCwd = runOptions.cwd ?? cwd;
    const display = displayCommand(command, args);
    const entry = {
      command,
      args: [...args],
      cwd: commandCwd,
      mutating: runOptions.mutating === true,
      intent: runOptions.intent ?? "",
      display,
    };

    if (dryRun) {
      planned.push(entry);
      events.event("command.planned", {
        display,
        cwd: commandCwd,
        mutating: entry.mutating,
        intent: entry.intent,
      });
      ctx.log(`    [plan] ${display}${entry.mutating ? "   (mutating)" : ""}`);
      return {
        ok: true,
        code: 0,
        stdout: "",
        stderr: "",
        dryRun: true,
        planned: true,
        command,
        args,
      };
    }

    events.event("command.start", {
      display,
      cwd: commandCwd,
      mutating: entry.mutating,
      intent: entry.intent,
    });
    const result = await exec(command, args, {
      cwd: commandCwd,
      env: runOptions.env ?? env,
      timeoutMs: runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    events.event(result.ok ? "command.ok" : "command.fail", {
      display,
      code: result.code,
      signal: result.signal,
      durationMs: result.durationMs,
      timedOut: result.timedOut === true,
      error: result.error,
      stdoutTail: tail(result.stdout, 1500),
      stderrTail: tail(result.stderr, 1500),
      args: redactArgs(args),
    });
    return result;
  };

  ctx.flush = async function flush() {
    await events.flush();
  };

  return ctx;
}

/**
 * JSON-safe plan summary (long argv elements such as the role prompt are
 * truncated). Used by every command's `--json` output.
 */
export function publicPlan(planned = []) {
  return planned.map((entry) => ({
    command: entry.command,
    args: entry.args.map((arg) => {
      const text = String(arg);
      return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
    }),
    cwd: entry.cwd,
    mutating: entry.mutating,
    intent: entry.intent,
    display: entry.display,
  }));
}

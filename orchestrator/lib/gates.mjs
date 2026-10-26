/**
 * Local gates ("门禁") executed before commit and by `verify`.
 *
 * Gate commands are data (`orchestrator/gates.default.json`), never hard-coded
 * command strings scattered through the pipeline, and they always run through
 * the injected executor. They run from the worktree root, so a failing agent
 * change blocks the PR instead of shipping it.
 */

import { readFile } from "node:fs/promises";
import { fail } from "./errors.mjs";
import { formatCommand } from "./exec.mjs";
import { DEFAULT_GATES_FILE } from "./paths.mjs";
import { tail } from "./util.mjs";

const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

export const BUILTIN_GATES = [
  {
    id: "typecheck",
    description: "tsc --noEmit",
    command: "node_modules/.bin/tsc",
    args: ["-p", "tsconfig.json", "--noEmit"],
    timeoutMs: 10 * 60_000,
  },
  {
    id: "test",
    description: "vitest run",
    command: "node_modules/.bin/vitest",
    args: ["run"],
    timeoutMs: 15 * 60_000,
  },
  {
    id: "validate-abi",
    description: "ABI gate: 46 errors / 34 capability bits / 35 events / 18 methods",
    command: "node",
    args: ["tools/validate-abi.mjs"],
    timeoutMs: 5 * 60_000,
  },
];

function normalizeGate(gate, index = 0) {
  if (gate === null || typeof gate !== "object") {
    fail("invalid-gates", `gate #${index} must be an object`);
  }
  const id = String(gate.id ?? "").trim();
  const command = String(gate.command ?? "").trim();
  if (id === "") fail("invalid-gates", `gate #${index} is missing "id"`);
  if (command === "") fail("invalid-gates", `gate ${id} is missing "command"`);
  const args = Array.isArray(gate.args) ? gate.args.map((arg) => String(arg)) : [];
  const timeoutMs = Number(gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail("invalid-gates", `gate ${id} has an invalid timeoutMs`);
  }
  return {
    id,
    description: String(gate.description ?? id),
    command,
    args,
    timeoutMs,
  };
}

/**
 * Load gates: explicit file > MOCL_GATES_FILE > bundled gates.default.json >
 * built-in defaults. An explicitly requested file must exist and be valid.
 */
export async function loadGates({ gatesFile, env = process.env } = {}) {
  const explicit = gatesFile ?? env.MOCL_GATES_FILE;
  const target = explicit ?? DEFAULT_GATES_FILE;
  let raw;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && explicit === undefined) {
      return BUILTIN_GATES.map((gate, index) => normalizeGate(gate, index));
    }
    fail("gates-unreadable", `cannot read gates file ${target}: ${error?.message ?? error}`, { path: target });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail("gates-invalid", `gates file ${target} is not valid JSON: ${error?.message ?? error}`, { path: target });
  }
  if (!Array.isArray(parsed?.gates) || parsed.gates.length === 0) {
    fail("gates-invalid", `gates file ${target} must contain a non-empty "gates" array`, { path: target });
  }
  return parsed.gates.map((gate, index) => normalizeGate(gate, index));
}

/**
 * Run gates sequentially in `cwd`; stop at the first failure (evidence keeps the
 * failing gate last). In dry-run every gate is reported as `planned-pass` and
 * nothing is executed.
 *
 * @returns {Promise<{ ok: boolean, results: Array<object>, failed: string[], skipped: boolean }>}
 */
export async function runGates(ctx, { cwd, gates, skip = false, label = "gate" } = {}) {
  if (skip) {
    return {
      ok: true,
      skipped: true,
      failed: [],
      results: gates.map((gate) => ({
        id: gate.id,
        description: gate.description,
        command: gate.command,
        args: gate.args,
        display: formatCommand(gate.command, gate.args),
        ok: true,
        code: 0,
        dryRun: false,
        skipped: true,
        durationMs: 0,
      })),
    };
  }

  const results = [];
  for (const gate of gates) {
    const display = formatCommand(gate.command, gate.args);
    ctx.log(`  → ${label} ${gate.id}: ${display}`);
    const startedAt = ctx.now().getTime();
    const result = await ctx.run(gate.command, gate.args, {
      cwd,
      intent: `gate:${gate.id}`,
      timeoutMs: gate.timeoutMs,
      mutating: false,
    });
    const entry = {
      id: gate.id,
      description: gate.description,
      command: gate.command,
      args: gate.args,
      display,
      ok: result.ok === true,
      code: result.code ?? null,
      dryRun: result.dryRun === true,
      planned: result.planned === true,
      timedOut: result.timedOut === true,
      durationMs: result.dryRun === true ? 0 : Math.max(0, ctx.now().getTime() - startedAt),
      stdoutTail: tail(result.stdout, 1500),
      stderrTail: tail(result.stderr, 1500),
    };
    results.push(entry);
    ctx.events.event(entry.ok ? "gate.pass" : "gate.fail", entry);
    if (!entry.ok) {
      ctx.log(`    FAIL ${gate.id} (exit ${entry.code ?? "?"})${entry.timedOut ? " [timeout]" : ""}`);
      break;
    }
    if (entry.dryRun) ctx.log(`    planned (not executed)`);
  }

  const failed = results.filter((entry) => !entry.ok).map((entry) => entry.id);
  return { ok: failed.length === 0 && results.length === gates.length, results, failed, skipped: false };
}

/** Markdown evidence table shared by PR body, delivery report and verify report. */
export function evidenceTable(results) {
  const rows = results.map((entry) => {
    const status = entry.skipped === true ? "SKIP" : entry.dryRun === true ? "PLANNED" : entry.ok ? "PASS" : "FAIL";
    const code = entry.skipped === true ? "—" : entry.dryRun === true ? "planned" : (entry.code ?? "?");
    return `| \`${entry.id}\` | \`${escapeCell(entry.display)}\` | ${code} | ${status} |`;
  });
  return ["| 门禁 | 命令 | 退出码 | 结果 |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function escapeCell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

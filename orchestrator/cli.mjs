#!/usr/bin/env node
/**
 * mocl-agent — GitHub issue → agent → 门禁 → PR → 评审 → 交付报告.
 *
 * Zero third-party dependencies, Node >= 24 ESM. Every external command is
 * injected into the pipelines (`lib/exec.mjs`), which is what makes `--dry-run`
 * and the fake-exec tests trustworthy.
 *
 * Exit codes (docs/process/10 §2): 0 success/PASS, 1 fail, 2 usage, 3 retry
 * budget exhausted, 4 environment unavailable.
 */

import { HELP_TEXT, applyEnv, parseArgv } from "./lib/args.mjs";
import { exitCodeForFailure } from "./lib/exit-codes.mjs";
import { deliverCommand } from "./lib/deliver.mjs";
import { intakeCommand } from "./lib/intake.mjs";
import { statusCommand } from "./lib/status.mjs";
import { verifyCommand } from "./lib/verify.mjs";
import { watchCommand } from "./lib/watch.mjs";

const HANDLERS = new Map([
  ["status", statusCommand],
  ["intake", intakeCommand],
  ["deliver", deliverCommand],
  ["verify", verifyCommand],
  ["watch", watchCommand],
]);

/** Trim multi-KB strings so `--json` stays readable. */
function serializable(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "string" && item.length > 2000 ? `${item.slice(0, 2000)}…` : item,
    ),
  );
}

async function main(argv) {
  const parsed = parseArgv(argv);

  if (parsed.options.help === true) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (parsed.errors.length > 0) {
    process.stderr.write(parsed.errors.map((error) => `error: ${error}\n`).join(""));
    process.stderr.write("\nRun `node orchestrator/cli.mjs --help` for usage.\n");
    return 2;
  }
  if (parsed.command === null) {
    process.stderr.write("error: no command given\n\n");
    process.stderr.write(HELP_TEXT);
    return 2;
  }

  const options = applyEnv(parsed.options, process.env);
  options.cwd = process.cwd();
  options.print = parsed.options.json !== true;
  options.json = parsed.options.json === true;

  let result;
  try {
    result = await HANDLERS.get(parsed.command)(options);
  } catch (error) {
    const code = exitCodeForFailure(error);
    process.stderr.write(`error: ${error?.message ?? String(error)}\n`);
    return code;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(serializable(result), null, 2)}\n`);
  } else if (result.exitCode !== 0 && result.code) {
    process.stderr.write(`error: [${result.code}] ${result.message ?? ""}\n`);
  }
  return result.exitCode ?? (result.ok ? 0 : 1);
}

process.exitCode = await main(process.argv.slice(2));

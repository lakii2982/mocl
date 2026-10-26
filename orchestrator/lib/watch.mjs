/**
 * `watch` — poll `agent:ready` issues and dispatch `deliver` with a concurrency
 * cap. Failures are counted by `deliver` itself (attempt budget →
 * both parking labels + @owner comment), so the watcher only has to keep going.
 *
 * Ctrl-C is safe: SIGINT stops new dispatches and waits for in-flight ones.
 */

import { resolveRunner } from "./args.mjs";
import { createContext, publicPlan } from "./context.mjs";
import { exitCodeForFailure } from "./exit-codes.mjs";
import { toFailure } from "./errors.mjs";
import { deliverCommand } from "./deliver.mjs";
import { evaluateIssue, issueBranch, normalizeIssue } from "./issue.mjs";
import { AGENT_BLOCKED, AGENT_READY, BLOCKED, ensureLabels } from "./labels.mjs";
import { ghJson, resolveRepo } from "./repo.mjs";
import { isBlockedInState, readState } from "./state.mjs";
import { isoStamp, sleep, toPositiveInt } from "./util.mjs";

/** Run the watcher. Always returns a summary (never throws for operational issues). */
export async function watchCommand(rawOptions = {}, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const options = { ...rawOptions, runId: rawOptions.runId ?? `${isoStamp(now())}-watch` };
  let runner;
  try {
    runner = resolveRunner(rawOptions, deps.env ?? process.env);
  } catch (error) {
    return { command: "watch", ok: false, exitCode: 2, dryRun: rawOptions.dryRun === true, code: error.code, message: error.message };
  }
  const ctx = await createContext(options, deps);
  const max = toPositiveInt(rawOptions.max, 1, { name: "--max", max: 10 });
  const intervalSeconds = toPositiveInt(rawOptions.interval ?? ctx.env.MOCL_WATCH_INTERVAL, 60, {
    name: "--interval",
    max: 3600,
  });
  const maxAttempts = toPositiveInt(rawOptions.maxAttempts ?? ctx.env.MOCL_MAX_ATTEMPTS, 2, {
    name: "--max-attempts",
  });
  const once = rawOptions.once === true;
  const startedAt = ctx.now().getTime();

  const summary = {
    command: "watch",
    ok: true,
    exitCode: 0,
    dryRun: ctx.dryRun,
    runId: ctx.runId,
    repo: null,
    cycles: 0,
    dispatched: [],
    skipped: [],
    failures: [],
    interrupted: false,
    planned: [],
    runDir: ctx.events.dir,
    eventsPath: ctx.events.path,
    code: null,
    message: null,
  };

  const stop = { value: false };
  const onSignal = () => {
    stop.value = true;
    ctx.log("\n收到中断信号（Ctrl-C）：停止派发新任务，等待进行中的任务结束…");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await ensureLabels(ctx, rawOptions);
    const repoInfo = await resolveRepo(ctx, { repo: rawOptions.repo });
    summary.repo = repoInfo.nameWithOwner;
    ctx.log(
      `watch: repo=${summary.repo} runner=${runner} max=${max} interval=${intervalSeconds}s` +
        `${once ? " once" : ""}${ctx.dryRun ? " dry-run" : ""}`,
    );

    do {
      summary.cycles += 1;
      ctx.log(`\n── cycle ${summary.cycles} ──`);
      const cycle = await runCycle(ctx, {
        options,
        deps,
        repo: summary.repo,
        runner,
        max,
        maxAttempts,
      });
      summary.dispatched.push(...cycle.dispatched);
      summary.skipped.push(...cycle.skipped);
      summary.failures.push(...cycle.failures);
      ctx.events.event("watch.cycle", {
        cycle: summary.cycles,
        dispatched: cycle.dispatched.map((entry) => entry.number),
        failures: cycle.failures.map((entry) => entry.number),
        skipped: cycle.skipped.map((entry) => entry.number),
      });
      summary.planned = publicPlan(ctx.planned);
      if (once || stop.value) break;
      await interruptibleSleep(intervalSeconds * 1000, stop);
    } while (!stop.value);
  } catch (error) {
    const failure = toFailure(error);
    summary.ok = false;
    summary.code = failure.code;
    summary.message = failure.message;
    summary.exitCode = 1;
    ctx.log(`\nFAIL [${failure.code}] ${failure.message}`);
    summary.exitCode = exitCodeForFailure(failure);
    ctx.events.event("watch.fail", failure);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  summary.interrupted = stop.value;
  summary.planned = publicPlan(ctx.planned);
  summary.durationMs = Math.max(0, ctx.now().getTime() - startedAt);
  ctx.events.event("command.finish", {
    ok: summary.exitCode === 0,
    cycles: summary.cycles,
    dispatched: summary.dispatched.length,
    failures: summary.failures.length,
  });
  await ctx.flush();

  if (ctx.print) {
    ctx.log("");
    ctx.log(`RESULT: ${summary.exitCode === 0 ? "WATCH OK" : "WATCH FAIL"}${summary.interrupted ? " (interrupted)" : ""}`);
    ctx.log(`  repo: ${summary.repo}`);
    ctx.log(`  cycles: ${summary.cycles}  dispatched: ${summary.dispatched.length}  failures: ${summary.failures.length}`);
    for (const entry of summary.dispatched) {
      ctx.log(`  dispatched #${entry.number} → ${entry.prUrl ?? "(no PR)"}${entry.blocked ? " [blocked]" : ""}`);
    }
    for (const entry of summary.failures) {
      ctx.log(`  failed #${entry.number} [${entry.code ?? "?"}]${entry.blocked ? ` [blocked @${entry.attempts}/${maxAttempts}]` : ""}`);
    }
    for (const entry of summary.skipped) {
      ctx.log(`  skipped #${entry.number} (${entry.reasons.join(", ")})`);
    }
  }
  return summary;
}

async function runCycle(ctx, { options, deps, repo, runner, max, maxAttempts }) {
  const state = await readState(ctx.cwd);
  const list = await ghJson(
    ctx,
    [
      "issue",
      "list",
      "-R",
      repo,
      "--label",
      AGENT_READY,
      "--state",
      "open",
      "--json",
      "number,title,labels,author,url",
      "--limit",
      "100",
    ],
    { intent: "list agent:ready issues" },
  );

  if (list.planned) {
    ctx.log("  (dry-run) 列表命令已计划；dry-run 不联网，无可派发对象");
    return { dispatched: [], skipped: [], failures: [] };
  }

  const issues = (list.data ?? []).map((raw) => normalizeIssue(raw));
  ctx.log(`  issues with ${AGENT_READY}: ${issues.length}`);

  const skipped = [];
  const ready = [];
  for (const issue of issues) {
    const eligibility = evaluateIssue(issue);
    if (!eligibility.eligible) {
      skipped.push({ number: issue.number, reasons: eligibility.reasons });
      continue;
    }
    if (isBlockedInState(state, issue.number)) {
      skipped.push({ number: issue.number, reasons: ["local-state:blocked"] });
      continue;
    }
    const branch = issueBranch(issue.number, issue.title);
    const prCheck = await ghJson(
      ctx,
      ["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number,url"],
      { allowFailure: true, intent: `check open PR for #${issue.number}` },
    );
    if (prCheck.ok && Array.isArray(prCheck.data) && prCheck.data.length > 0) {
      skipped.push({ number: issue.number, reasons: [`open-pr:${prCheck.data[0].number}`] });
      continue;
    }
    ready.push({ issue, branch });
  }

  const batch = ready.slice(0, max);
  for (const { issue } of ready.slice(max)) {
    skipped.push({ number: issue.number, reasons: ["concurrency-limit"] });
  }

  const dispatched = [];
  const failures = [];
  const results = await Promise.allSettled(
    batch.map(async ({ issue, branch }) => {
      ctx.log(`\n  ▷ dispatch #${issue.number} ${issue.title}`);
      const result = await deliverCommand(
        {
          ...options,
          issue: issue.number,
          issueData: issue,
          repo,
          runner,
          maxAttempts,
          runId: undefined,
          json: false,
        },
        deps,
      );
      return { issue, branch, result };
    }),
  );

  for (const settled of results) {
    if (settled.status === "rejected") {
      const failure = toFailure(settled.reason);
      failures.push({ number: null, code: failure.code, message: failure.message });
      continue;
    }
    const { issue, branch, result } = settled.value;
    if (result.ok) {
      dispatched.push({
        number: issue.number,
        branch,
        prUrl: result.prUrl,
        runDir: result.runDir,
        blocked: result.blocked === true,
        attempts: result.attempts,
      });
      ctx.log(`  ✔ #${issue.number} delivered → ${result.prUrl ?? "(dry-run)"}`);
    } else {
      failures.push({
        number: issue.number,
        branch,
        code: result.code,
        message: result.message,
        attempts: result.attempts,
        blocked: result.blocked === true,
        runDir: result.runDir,
      });
      ctx.log(`  ✘ #${issue.number} failed [${result.code ?? "?"}]${result.blocked === true ? ` → ${BLOCKED} + ${AGENT_BLOCKED}` : ""}`);
    }
  }

  return { dispatched, skipped, failures };
}

/** Sleep in small slices so SIGINT is observed quickly. */
async function interruptibleSleep(ms, stop) {
  const slice = 250;
  let waited = 0;
  while (waited < ms && !stop.value) {
    const chunk = Math.min(slice, ms - waited);
    await sleep(chunk);
    waited += chunk;
  }
}

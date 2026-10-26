/**
 * `verify` — run local gates against the current checkout and optionally ask
 * the verifier/reviewer roles for an independent review.
 *
 * Exit code: 0 = PASS, 1 = FAIL, 2 = usage error. Evidence lands in
 * `.agentspec/runs/<iso>/` (`gates.json`, `verify.md`, `events.jsonl`).
 */

import { join } from "node:path";
import { resolveRunner } from "./args.mjs";
import { createContext, publicPlan } from "./context.mjs";
import { toFailure } from "./errors.mjs";
import { exitCodeForFailure } from "./exit-codes.mjs";
import { loadGates, runGates } from "./gates.mjs";
import { ensureLabels } from "./labels.mjs";
import { buildReviewPrompt, parseVerdict } from "./prompts.mjs";
import { VERIFY_REQUIRED_SECTIONS, renderVerifyReport } from "./report.mjs";
import { ghJson, resolveRepo } from "./repo.mjs";
import { runAgent } from "./runner.mjs";
import { writeRunFile } from "./state.mjs";
import { assertSections } from "./templates.mjs";
import { isoStamp, tail, toPositiveInt } from "./util.mjs";

const REVIEW_ROLES = ["verifier", "reviewer"];

/** Run verification for one PR; always returns a summary (never throws). */
export async function verifyCommand(rawOptions = {}, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const prNumber = toPositiveInt(rawOptions.pr, null, { name: "--pr" });
  if (prNumber === null) {
    return {
      command: "verify",
      ok: false,
      exitCode: 2,
      dryRun: rawOptions.dryRun === true,
      code: "invalid-argument",
      message: "--pr <n> is required (positive integer)",
    };
  }
  const options = { ...rawOptions, runId: rawOptions.runId ?? `${isoStamp(now())}-verify-pr${prNumber}` };
  let runner;
  try {
    runner = resolveRunner(rawOptions, deps.env ?? process.env);
  } catch (error) {
    return { command: "verify", ok: false, exitCode: 2, dryRun: rawOptions.dryRun === true, code: error.code, message: error.message };
  }
  const ctx = await createContext(options, deps);
  const rolesDir = rawOptions.rolesDir ?? "agents/roles";
  const reviewEnabled = rawOptions.review === true && rawOptions.noReview !== true;
  const startedAt = ctx.now().getTime();

  const summary = {
    command: "verify",
    ok: false,
    exitCode: 1,
    dryRun: ctx.dryRun,
    runId: ctx.runId,
    repo: null,
    pr: null,
    verdict: "FAIL",
    gateResults: [],
    reviews: [],
    runDir: ctx.events.dir,
    eventsPath: ctx.events.path,
    reportPath: null,
    planned: [],
    code: null,
    message: null,
  };

  let gateConfigs = [];

  const step = async (id, title, fn) => {
    ctx.log(`\n▶ ${id} — ${title}`);
    ctx.events.event("step.start", { id, title });
    try {
      const value = await fn();
      ctx.events.event("step.ok", { id });
      return value;
    } catch (error) {
      const failure = toFailure(error);
      ctx.events.event("step.fail", { id, ...failure });
      throw error;
    }
  };

  const finish = async (exitCode) => {
    summary.exitCode = exitCode;
    summary.ok = exitCode === 0;
    summary.durationMs = Math.max(0, ctx.now().getTime() - startedAt);
    summary.planned = publicPlan(ctx.planned);
    if (!ctx.dryRun) {
      try {
        await writeRunFile(ctx.events.dir, "gates.json", `${JSON.stringify(summary.gateResults, null, 2)}\n`);
      } catch {
        // best effort
      }
    }
    ctx.events.event("command.finish", { ok: summary.ok, verdict: summary.verdict, code: summary.code });
    await ctx.flush();
    if (ctx.print) {
      ctx.log("");
      ctx.log(`RESULT: ${summary.verdict}${ctx.dryRun ? " (dry-run plan)" : ""}${summary.code === null ? "" : ` (${summary.code})`}`);
      ctx.log(`  runDir: ${ctx.events.dir}`);
      if (summary.reportPath !== null) ctx.log(`  report: ${summary.reportPath}`);
      if (ctx.dryRun) ctx.log(`  planned commands: ${ctx.planned.length} (zero side effects)`);
    }
    return summary;
  };

  try {
    await step("labels", "校验标签真源（.github/labels.yml）", () => ensureLabels(ctx, rawOptions));
    const repoInfo = await step("resolve-repo", "解析目标仓库", () => resolveRepo(ctx, { repo: rawOptions.repo }));
    summary.repo = repoInfo.nameWithOwner;
    ctx.log(`  repo: ${summary.repo} (source: ${repoInfo.source})`);

    const pr = await step("read-pr", `读取 PR #${prNumber}`, async () => {
      if (ctx.dryRun) {
        await ctx.run("gh", ["pr", "view", String(prNumber), "-R", summary.repo, "--json", "number,title,state,headRefName,url,isDraft"], {
          intent: "read PR (planned)",
        });
        return {
          number: prNumber,
          title: `PR #${prNumber} (dry-run stub)`,
          state: "OPEN",
          headRefName: `(dry-run: pr-${prNumber})`,
          url: "(dry-run: planned)",
          isDraft: false,
        };
      }
      const result = await ghJson(
        ctx,
        ["pr", "view", String(prNumber), "-R", summary.repo, "--json", "number,title,state,headRefName,url,isDraft,body"],
        { intent: `read PR #${prNumber}` },
      );
      return result.data;
    });
    summary.pr = { number: pr.number, title: pr.title, headRefName: pr.headRefName, url: pr.url, state: pr.state };

    gateConfigs = await loadGates({ gatesFile: rawOptions.gatesFile, env: ctx.env });
    const gateOutcome = await step(
      "gates",
      `本地门禁（${gateConfigs.map((gate) => gate.id).join(" / ")}）`,
      () => runGates(ctx, { cwd: ctx.cwd, gates: gateConfigs, label: "gate" }),
    );
    summary.gateResults = gateOutcome.results;
    ctx.log(`  gates: ${gateOutcome.ok ? "PASS" : `FAIL (${gateOutcome.failed.join(", ")})`}`);

    const reviews = [];
    if (reviewEnabled) {
      for (const role of REVIEW_ROLES) {
        const review = await step(`review-${role}`, `调用 ${role} 角色评审`, async () => {
          const promptInfo = await buildReviewPrompt({
            cwd: ctx.cwd,
            rolesDir,
            role,
            repo: summary.repo,
            pr,
            gates: summary.gateResults,
            issue: null,
          });
          const result = await runAgent(ctx, { runner, role, prompt: promptInfo.prompt, cwd: ctx.cwd });
          const verdict = ctx.dryRun
            ? { verdict: "PLANNED", reason: "dry-run: review planned only" }
            : result.ok
              ? parseVerdict(result.stdout)
              : { verdict: "FAIL", reason: `agent run failed (exit ${result.code ?? "?"})` };
          const entry = {
            role,
            rolePromptSource: promptInfo.rolePromptSource,
            runner,
            verdict: verdict.verdict,
            reason: verdict.reason,
            stdout: tail(result.stdout, 4000),
            stderr: tail(result.stderr, 1000),
          };
          ctx.log(`  ${role}: ${entry.verdict}${entry.reason === null ? "" : ` — ${entry.reason}`} (rolePromptSource: ${entry.rolePromptSource})`);
          return entry;
        });
        reviews.push(review);
      }
    } else {
      ctx.log("  review: skipped（加 --review 让 verifier/reviewer 角色复核）");
    }
    summary.reviews = reviews;

    const gatesOk = summary.gateResults.every((gate) => gate.ok);
    const reviewsOk = reviews.every((review) => review.verdict === "PASS" || review.verdict === "PLANNED");
    summary.verdict = gatesOk && reviewsOk ? "PASS" : "FAIL";
    if (!gatesOk) summary.code = "gates-failed";
    else if (!reviewsOk) summary.code = "review-failed";

    const report = renderVerifyReport({
      pr,
      repo: summary.repo,
      verdict: summary.verdict,
      gates: summary.gateResults,
      reviews,
      runDir: ctx.events.dir,
      generatedAt: ctx.now().toISOString(),
    });
    assertSections(report, VERIFY_REQUIRED_SECTIONS, { kind: "verify report" });
    summary.reportPath = ctx.dryRun
      ? join(ctx.events.dir, "verify.md")
      : await writeRunFile(ctx.events.dir, "verify.md", report);
    if (!ctx.dryRun) ctx.log(`  report: ${summary.reportPath}`);

    return await finish(summary.verdict === "PASS" ? 0 : 1);
  } catch (error) {
    const failure = toFailure(error);
    summary.code = failure.code;
    summary.message = failure.message;
    summary.verdict = "FAIL";
    ctx.log(`\nFAIL [${failure.code}] ${failure.message}`);
    return await finish(exitCodeForFailure(failure));
  }
}

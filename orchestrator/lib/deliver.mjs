/**
 * `deliver` — the automated core.
 *
 * Pipeline: repo → issue → label policy / idempotency → branch + worktree →
 * implementer prompt → runner → local gates → commit → push → PR → in-review
 * label → delivery report comment → local state.
 *
 * Guarantees:
 * - dry-run executes no external command and creates no file (zero side effects)
 * - a failure after the agent started counts as an attempt; at `--max-attempts`
 *   the issue gets both parking labels (status + agent) plus an @owner comment
 * - no force push, ever (`lib/repo.mjs::assertSafeGitArgs`)
 */

import { join } from "node:path";
import { resolveRunner } from "./args.mjs";
import { createContext, publicPlan } from "./context.mjs";
import { EXIT_BLOCKED, exitCodeForFailure } from "./exit-codes.mjs";
import { toFailure, OrchestratorError } from "./errors.mjs";
import { formatCommand } from "./exec.mjs";
import { loadGates, runGates } from "./gates.mjs";
import { AGENT_BLOCKED, AGENT_READY, BLOCKED, IN_REVIEW, ensureLabels } from "./labels.mjs";
import {
  evaluateIssue,
  extractBriefSections,
  issueBranch,
  loadIssue,
  normalizeIssue,
  worktreePath,
} from "./issue.mjs";
import { buildImplementerPrompt } from "./prompts.mjs";
import { loadPrTemplate, renderPrBody, validatePrTemplate } from "./prbody.mjs";
import { renderBlockedNote, renderDeliveryReport } from "./report.mjs";
import { ghJson, git, gitOutput, resolveRepo } from "./repo.mjs";
import { DEFAULT_AGENT_CMD, probeRunner, runAgent } from "./runner.mjs";
import {
  ensureDirWithSelfIgnore,
  readState,
  updateIssueState,
  writeRunFile,
} from "./state.mjs";
import { isoStamp, tail, toPositiveInt } from "./util.mjs";

const REQUIRED_ISSUE_MESSAGE = "--issue <n> is required (positive integer)";

/**
 * Run the delivery pipeline for one issue.
 * Always returns a summary object; never throws for operational failures.
 */
export async function deliverCommand(rawOptions = {}, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const issueNumber = toPositiveInt(rawOptions.issue, null, { name: "--issue" });
  if (issueNumber === null) {
    return { command: "deliver", ok: false, exitCode: 2, dryRun: false, code: "invalid-argument", message: REQUIRED_ISSUE_MESSAGE };
  }
  const runId = rawOptions.runId ?? `${isoStamp(now())}-i${issueNumber}`;
  const options = { ...rawOptions, runId };
  let runner;
  try {
    runner = resolveRunner(rawOptions, deps.env ?? process.env);
  } catch (error) {
    return { command: "deliver", ok: false, exitCode: 2, dryRun: rawOptions.dryRun === true, code: error.code, message: error.message };
  }
  const ctx = await createContext(options, deps);
  const base = rawOptions.base ?? ctx.env.MOCL_BASE_BRANCH ?? "main";
  const maxAttempts = toPositiveInt(rawOptions.maxAttempts ?? ctx.env.MOCL_MAX_ATTEMPTS, 2, { name: "--max-attempts" });
  const rolesDir = rawOptions.rolesDir ?? "agents/roles";
  const startedAt = ctx.now().getTime();

  const summary = {
    command: "deliver",
    ok: false,
    exitCode: 1,
    dryRun: ctx.dryRun,
    runId: ctx.runId,
    repo: null,
    issue: null,
    issueSource: null,
    branch: null,
    base,
    worktree: null,
    runner,
    agentRunner: runner,
    rolePromptSource: null,
    rolePromptPath: null,
    labelsPath: null,
    prUrl: null,
    prNumber: null,
    changedFiles: [],
    gateResults: [],
    gatesOk: null,
    attempts: 0,
    maxAttempts,
    blocked: false,
    reportPath: null,
    runDir: ctx.events.dir,
    eventsPath: ctx.events.path,
    planned: [],
    steps: [],
    code: null,
    message: null,
  };

  let issue = null;
  let attemptStarted = false;
  let delivered = false;
  let worktreeCreated = false;
  let gateConfigs = [];
  let commitMessage = "";

  const step = async (id, title, fn) => {
    ctx.log(`\n▶ ${id} — ${title}`);
    ctx.events.event("step.start", { id, title });
    const stepStartedAt = ctx.now().getTime();
    try {
      const value = await fn();
      const durationMs = ctx.now().getTime() - stepStartedAt;
      ctx.events.event("step.ok", { id, durationMs });
      summary.steps.push({ id, title, ok: true, durationMs });
      return value;
    } catch (error) {
      const failure = toFailure(error);
      ctx.events.event("step.fail", { id, durationMs: ctx.now().getTime() - stepStartedAt, ...failure });
      summary.steps.push({ id, title, ok: false, code: failure.code, message: failure.message });
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
        await writeRunFile(ctx.events.dir, "deliver.json", `${JSON.stringify(summary, null, 2)}\n`);
      } catch {
        // Artifact write failures must not mask the command verdict.
      }
    }
    ctx.events.event("command.finish", { ok: summary.ok, exitCode, code: summary.code, blocked: summary.blocked, attempts: summary.attempts });
    await ctx.flush();
    if (ctx.print) {
      ctx.log("");
      ctx.log(
        `RESULT: ${summary.ok ? (ctx.dryRun ? "DRY-RUN OK" : "DELIVERED") : "FAIL"}` +
          `${summary.code === null ? "" : ` (${summary.code})`}`,
      );
      ctx.log(`  runDir: ${ctx.events.dir}`);
      if (summary.branch !== null) ctx.log(`  branch: ${summary.branch}`);
      if (summary.worktree !== null) ctx.log(`  worktree: ${summary.worktree}`);
      if (summary.prUrl !== null) ctx.log(`  pr: ${summary.prUrl}`);
      if (summary.attempts > 0) ctx.log(`  attempts: ${summary.attempts}/${maxAttempts}${summary.blocked ? " (blocked)" : ""}`);
      if (summary.rolePromptSource !== null) ctx.log(`  rolePromptSource: ${summary.rolePromptSource}`);
      if (summary.issueSource !== null) ctx.log(`  issueSource: ${summary.issueSource}`);
      // Always surface the role-prompt fallback explicitly.
      if (summary.rolePromptSource === "fallback") ctx.log("  NOTE: 角色 prompt 文件缺失，使用内置回退文案（rolePromptSource: fallback）");
      if (ctx.dryRun) ctx.log(`  planned commands: ${ctx.planned.length} (zero side effects)`);
    }
    return summary;
  };

  try {
    const labelSet = await step("labels", "校验标签真源（.github/labels.yml）", () => ensureLabels(ctx, rawOptions));
    summary.labelsPath = labelSet.path;

    const repoInfo = await step("resolve-repo", "解析目标仓库", () => resolveRepo(ctx, { repo: rawOptions.repo }));
    summary.repo = repoInfo.nameWithOwner;
    ctx.log(`  repo: ${repoInfo.nameWithOwner} (source: ${repoInfo.source})`);
    if (ctx.dryRun && repoInfo.source === "planned") {
      ctx.log("  NOTE: dry-run 未解析真实仓库（无 --repo 且未执行 gh/git），命令里以 <owner>/<repo> 占位");
    }

    const loaded = await step("read-issue", `读取 issue #${issueNumber}`, () => {
      if (rawOptions.issueData !== undefined) {
        return Promise.resolve({
          issue: normalizeIssue(rawOptions.issueData, { fallbackNumber: issueNumber }),
          source: "dispatch",
          note: "issue provided by watch dispatch",
        });
      }
      return loadIssue(ctx, { repo: summary.repo, number: issueNumber, issueJsonPath: rawOptions.issueJsonPath });
    });
    issue = loaded.issue;
    summary.issue = { number: issue.number, title: issue.title, url: issue.url };
    summary.issueSource = loaded.source;
    ctx.log(`  issue: #${issue.number} ${issue.title} (source: ${loaded.source}${loaded.note === undefined ? "" : ` — ${loaded.note}`})`);
    if (loaded.source === "offline-stub") {
      ctx.warn("dry-run: issue 正文为离线桩；真实内容请用 --issue-json <file> 或去掉 --dry-run");
    }

    const brief = extractBriefSections(issue.body);
    const branch = issueBranch(issue.number, issue.title);
    const worktree = worktreePath(ctx.cwd, rawOptions.worktreeRoot ?? ctx.env.MOCL_WORKTREE_ROOT, issue.number);
    summary.branch = branch;
    summary.worktree = worktree;
    commitMessage = `feat(issue-${issue.number}): ${issue.title}`.slice(0, 200);

    await step("preflight", "校验 issue 标签与幂等（是否已有 open PR）", async () => {
      const eligibility = evaluateIssue(issue);
      summary.eligibility = eligibility;
      if (!eligibility.eligible) {
        if (rawOptions.force !== true) {
          throw new OrchestratorError(
            "issue-not-eligible",
            `issue #${issue.number} 不满足自动交付条件: ${eligibility.reasons.join(", ")}（人工接管请加 --force）`,
            { reasons: eligibility.reasons },
          );
        }
        ctx.warn(`issue 标签不满足自动条件 (${eligibility.reasons.join(", ")})，但 --force 已指定，继续`);
      } else {
        ctx.log(`  eligibility: ok (${AGENT_READY}，无 ${AGENT_BLOCKED} / ${BLOCKED})`);
      }
      const prs = await ghJson(
        ctx,
        ["pr", "list", "-R", summary.repo, "--head", branch, "--state", "open", "--json", "number,url,title"],
        { intent: "idempotency: open PR check" },
      );
      if (!prs.planned && Array.isArray(prs.data) && prs.data.length > 0) {
        const existing = prs.data[0];
        throw new OrchestratorError(
          "duplicate-open-pr",
          `issue #${issue.number} 已有打开的 PR（分支 ${branch}）：#${existing.number} ${existing.url ?? ""}。拒绝重复创建。`,
          { prs: prs.data },
        );
      }
      if (prs.planned) ctx.log("  idempotency: (dry-run) 计划检查 open PR");
      else ctx.log("  idempotency: 无 open PR，可继续");
    });

    gateConfigs = await loadGates({ gatesFile: rawOptions.gatesFile, env: ctx.env });

    await step("create-worktree", `创建分支 ${branch} 与 worktree`, async () => {
      if (!ctx.dryRun) {
        await ensureDirWithSelfIgnore(join(ctx.cwd, rawOptions.worktreeRoot ?? ctx.env.MOCL_WORKTREE_ROOT ?? ".worktrees"));
      }
      await git(ctx, ["-C", ctx.cwd, "worktree", "add", "-b", branch, worktree, base], {
        intent: "create isolated worktree",
      });
      worktreeCreated = true;
      ctx.log(`  worktree: ${worktree} (base: ${base})`);
    });

    const promptInfo = await step("build-prompt", "拼装角色 prompt（implementer）+ issue 上下文 + 工程约束", async () => {
      const info = await buildImplementerPrompt({
        cwd: ctx.cwd,
        rolesDir,
        issue,
        repo: summary.repo,
        base,
        branch,
        worktree,
        gates: gateConfigs,
      });
      summary.rolePromptSource = info.rolePromptSource;
      summary.rolePromptPath = info.rolePromptPath;
      ctx.log(
        `  rolePromptSource: ${info.rolePromptSource}${info.rolePromptPath === null ? "" : ` (${info.rolePromptPath})`}${info.rolePromptNote === null ? "" : ` — ${info.rolePromptNote}`}`,
      );
      return info;
    });

    await step("probe-runner", `探测 runner（${runner}）`, async () => {
      const probe = await probeRunner(ctx, { runner, commandTemplate: ctx.env.MOCL_AGENT_CMD });
      summary.runnerProbe = probe;
      if (probe.skipped) {
        ctx.log(`  probe: SKIP (${probe.reason})${probe.version === undefined ? "" : ` version=${probe.version}`}`);
      } else {
        ctx.log(`  probe: ok (${probe.version})`);
      }
      if (!probe.ok && !ctx.dryRun) {
        throw new OrchestratorError("runner-unavailable", `agent runner 不可用: ${probe.reason}`, probe);
      }
      return probe;
    });

    attemptStarted = true;
    await step("run-agent", `执行 ${runner} agent（worktree 内）`, async () => {
      const template = runner === "dsh" ? ctx.env.MOCL_AGENT_CMD ?? DEFAULT_AGENT_CMD : "(mock)";
      ctx.log(`  runner: ${runner}${runner === "dsh" ? ` (template: ${formatCommand(template.split(/\s+/)[0] ?? "dsh", [])})` : ""}`);
      const result = await runAgent(ctx, {
        runner,
        role: "implementer",
        prompt: promptInfo.prompt,
        cwd: worktree,
      });
      summary.agent = { runner, ok: result.ok, code: result.code, stdoutTail: tail(result.stdout, 800), stderrTail: tail(result.stderr, 800) };
      if (!result.ok) {
        throw new OrchestratorError("agent-run-failed", `${runner} agent 执行失败 (exit ${result.code ?? "?"})`, {
          runner,
          stderr: tail(result.stderr, 3000),
          stdout: tail(result.stdout, 1500),
        });
      }
      ctx.log(`  agent: ok${result.mock ? " (mock)" : ""}`);
      return result;
    });

    await step("gates", "本地门禁（typecheck / test / validate-abi）", async () => {
      const outcome = await runGates(ctx, { cwd: worktree, gates: gateConfigs });
      summary.gateResults = outcome.results;
      summary.gatesOk = outcome.ok;
      if (ctx.dryRun) {
        ctx.log("  gates: planned (not executed)");
        return outcome;
      }
      if (!outcome.ok) {
        throw new OrchestratorError("gates-failed", `本地门禁失败: ${outcome.failed.join(", ")}`, {
          failed: outcome.failed,
          results: outcome.results,
        });
      }
      ctx.log(`  gates: PASS (${outcome.results.length}/${gateConfigs.length})`);
      return outcome;
    });

    await step("commit", "提交 agent 改动", async () => {
      const status = await gitOutput(ctx, ["-C", worktree, "status", "--porcelain"], {
        intent: "detect agent changes",
        mutating: false,
      });
      const changedFiles = String(status)
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => line.slice(3).trim());
      summary.changedFiles = changedFiles;
      if (!ctx.dryRun && changedFiles.length === 0) {
        throw new OrchestratorError("no-changes", "worktree 内没有改动：agent 未产生可交付变更", { worktree });
      }
      await git(ctx, ["-C", worktree, "add", "-A"], { intent: "stage agent changes" });
      await git(ctx, ["-C", worktree, "commit", "-m", commitMessage], { intent: "commit agent changes" });
      if (ctx.dryRun) ctx.log("  commit: planned (changes unknown in dry-run)");
      else ctx.log(`  commit: ${changedFiles.length} file(s) — ${commitMessage}`);
    });

    await step("push", "推送分支（禁止 force）", async () => {
      await git(ctx, ["-C", worktree, "push", "-u", "origin", branch], {
        intent: "push agent branch",
      });
      ctx.log(`  push: origin ${branch}`);
    });

    const pr = await step("open-pr", "创建 PR（填写 PR 模板）", async () => {
      const template = await loadPrTemplate();
      validatePrTemplate(template);
      const body = renderPrBody({
        issue,
        repo: summary.repo,
        branch,
        base,
        worktree,
        gates: summary.gateResults,
        agent: { runner, rolePromptSource: summary.rolePromptSource ?? "fallback" },
        runId: ctx.runId,
        generatedAt: ctx.now().toISOString(),
        template,
        risks: brief.risks,
      });
      const bodyPath = ctx.dryRun ? join(ctx.events.dir, "pr-body.md") : await writeRunFile(ctx.events.dir, "pr-body.md", body);
      summary.prBodyPath = bodyPath;
      const title = `feat(issue-${issue.number}): ${issue.title}`.slice(0, 120);
      const result = await ctx.run(
        "gh",
        ["pr", "create", "-R", summary.repo, "--base", base, "--head", branch, "--title", title, "--body-file", bodyPath],
        { intent: "create PR", mutating: true },
      );
      if (ctx.dryRun) {
        ctx.log(`  pr: planned (body: ${bodyPath})`);
        return { url: "(dry-run: planned)", number: null, bodyPath };
      }
      if (!result.ok) {
        throw new OrchestratorError("pr-create-failed", `gh pr create 失败 (exit ${result.code ?? "?"})`, {
          stderr: tail(result.stderr, 3000),
          stdout: tail(result.stdout, 1500),
        });
      }
      const url = extractPrUrl(result.stdout);
      summary.prUrl = url ?? "(gh pr create returned no URL)";
      const pullNumber = url === null ? null : /\/pull\/(\d+)/.exec(url);
      summary.prNumber = pullNumber === null ? null : Number(pullNumber[1]);
      ctx.log(`  pr: ${summary.prUrl}`);
      return { url, number: summary.prNumber, bodyPath };
    });
    delivered = true;
    if (pr.url !== null && !pr.url.startsWith("(")) summary.prUrl = pr.url;

    await step("label-issue", `issue 打 ${IN_REVIEW}`, async () => {
      const args = ["issue", "edit", String(issue.number), "-R", summary.repo, "--add-label", IN_REVIEW];
      if (issue.labels.includes(AGENT_READY)) args.push("--remove-label", AGENT_READY);
      const result = await ctx.run("gh", args, { intent: "mark issue in-review", mutating: true });
      if (!ctx.dryRun && !result.ok) {
        ctx.warn(`打标签失败（PR 已创建，不阻塞交付）: exit ${result.code ?? "?"} ${tail(result.stderr, 300)}`);
      }
      ctx.log(`  label: ${IN_REVIEW}${issue.labels.includes(AGENT_READY) ? ` (−${AGENT_READY})` : ""}`);
    });

    await step("write-report", "生成交付报告并评论 issue", async () => {
      const report = renderDeliveryReport({
        issue,
        repo: summary.repo,
        branch,
        base,
        worktree,
        prUrl: summary.prUrl ?? "(pending)",
        gates: summary.gateResults,
        agent: { runner, rolePromptSource: summary.rolePromptSource ?? "fallback" },
        issueSource: summary.issueSource,
        runId: ctx.runId,
        runDir: ctx.events.dir,
        eventsPath: ctx.events.path,
        changedFiles: summary.changedFiles,
        risks: brief.risks,
        durationMs: ctx.now().getTime() - startedAt,
        summary: `issue #${issue.number}「${issue.title}」已由 ${runner} agent 实现，本地门禁 ${summary.gateResults.filter((gate) => gate.ok).length}/${summary.gateResults.length} 通过${ctx.dryRun ? "（dry-run 计划）" : ""}。`,
      });
      const reportPath = ctx.dryRun
        ? join(ctx.events.dir, "delivery-report.md")
        : await writeRunFile(ctx.events.dir, "delivery-report.md", report);
      summary.reportPath = reportPath;
      await ctx.run("gh", ["issue", "comment", String(issue.number), "-R", summary.repo, "--body-file", reportPath], {
        intent: "post delivery report comment",
        mutating: true,
      });
      ctx.log(`  report: ${reportPath}`);
    });

    await step("update-state", "更新本地状态与该 issue 的重试计数", async () => {
      if (ctx.dryRun) {
        ctx.log("  state: (dry-run) 不写入 .agentspec/state.json");
        return;
      }
      await updateIssueState(
        ctx.cwd,
        issue.number,
        {
          attempts: 0,
          blocked: false,
          branch,
          worktree,
          pr: { url: summary.prUrl, number: summary.prNumber },
          lastRun: ctx.runId,
          lastStatus: "delivered",
          lastError: null,
          issueTitle: issue.title,
        },
        ctx.now(),
      );
      ctx.log("  state: attempts=0, lastStatus=delivered");
    });

    return finish(0);
  } catch (error) {
    const failure = toFailure(error);
    summary.code = failure.code;
    summary.message = failure.message;
    ctx.log(`\nFAIL [${failure.code}] ${failure.message}`);

    if (attemptStarted && !delivered && !ctx.dryRun && issue !== null) {
      try {
        const attempt = await recordFailureAttempt(ctx, {
          issue,
          repo: summary.repo,
          failure,
          branch: summary.branch,
          maxAttempts,
          runDir: ctx.events.dir,
          eventsPath: ctx.events.path,
        });
        summary.attempts = attempt.attempts;
        summary.blocked = attempt.blocked;
        if (attempt.blocked) ctx.log(`  blocked: 连续失败 ${attempt.attempts} 次，已打 ${BLOCKED} + ${AGENT_BLOCKED} 并 @${issue.author}`);
        else ctx.log(`  attempt: ${attempt.attempts}/${maxAttempts}（未阻塞，可重试）`);
      } catch (nested) {
        ctx.warn(`记录失败/阻塞时出错: ${toFailure(nested).message}`);
      }
    }

    if (!delivered && worktreeCreated && !ctx.dryRun && rawOptions.keepWorktree !== true) {
      try {
        await ctx.run("git", ["-C", ctx.cwd, "worktree", "remove", "--force", summary.worktree], {
          intent: "cleanup failed worktree",
        });
        await ctx.run("git", ["-C", ctx.cwd, "branch", "-D", summary.branch], { intent: "cleanup failed branch" });
        ctx.log("  cleanup: 已移除失败 worktree 与本地分支（--keep-worktree 可保留现场）");
      } catch (nested) {
        ctx.warn(`清理 worktree 失败: ${toFailure(nested).message}`);
      }
    }

    // Exit code contract: retry budget exhausted = 3, environment failures = 4,
    // everything else that is retryable = 1 (see lib/exit-codes.mjs).
    const exitCode = summary.blocked ? EXIT_BLOCKED : exitCodeForFailure(failure);
    return finish(exitCode);
  }
}

function extractPrUrl(stdout) {
  const text = String(stdout ?? "");
  const match = /https?:\/\/[^\s]+\/pull\/\d+/.exec(text);
  return match === null ? null : match[0];
}

/**
 * Increment the attempt counter; block the issue once the budget is exhausted.
 * @returns {Promise<{ attempts: number, blocked: boolean }>}
 */
async function recordFailureAttempt(ctx, { issue, repo, failure, branch, maxAttempts, runDir, eventsPath }) {
  const state = await readState(ctx.cwd);
  const previous = Number(state.issues[String(issue.number)]?.attempts ?? 0);
  const attempts = previous + 1;
  const blocked = attempts >= maxAttempts;
  const patch = {
    attempts,
    blocked,
    branch,
    lastRun: ctx.runId,
    lastStatus: blocked ? "blocked" : "retrying",
    lastError: failure,
    issueTitle: issue.title,
  };
  await updateIssueState(ctx.cwd, issue.number, patch, ctx.now());

  if (blocked) {
    const note = renderBlockedNote({
      issue,
      repo,
      failure,
      attempts,
      runDir,
      eventsPath,
      branch: branch ?? "(未创建)",
    });
    const notePath = await writeRunFile(runDir, "blocked-comment.md", note);
    const editResult = await ctx.run(
      "gh",
      [
        "issue",
        "edit",
        String(issue.number),
        "-R",
        repo,
        "--add-label",
        BLOCKED,
        "--add-label",
        AGENT_BLOCKED,
        "--remove-label",
        AGENT_READY,
      ],
      { intent: "mark issue blocked (status + agent)", mutating: true },
    );
    if (!editResult.ok) {
      ctx.warn(`打 ${BLOCKED} + ${AGENT_BLOCKED} 失败: exit ${editResult.code ?? "?"} ${tail(editResult.stderr, 300)}`);
    }
    const commentResult = await ctx.run(
      "gh",
      ["issue", "comment", String(issue.number), "-R", repo, "--body-file", notePath],
      { intent: "comment blocked reason", mutating: true },
    );
    if (!commentResult.ok) {
      ctx.warn(`评论阻塞原因失败: exit ${commentResult.code ?? "?"} ${tail(commentResult.stderr, 300)}`);
    }
  }
  return { attempts, blocked };
}

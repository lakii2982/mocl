/**
 * `intake` — turn a GitHub issue into a local BRIEF artifact.
 *
 * Output: `.agentspec/issues/<n>/BRIEF.md` with the five contracted sections
 * (需求摘要 / 验收口径 / 风险 / 非目标 / 待澄清问题). In dry-run the BRIEF is
 * rendered and printed but never written.
 */

import { join } from "node:path";
import { createContext, publicPlan } from "./context.mjs";
import { toFailure } from "./errors.mjs";
import { exitCodeForFailure } from "./exit-codes.mjs";
import {
  briefPath,
  evaluateIssue,
  extractBriefSections,
  issueBranch,
  loadIssue,
  worktreeDirName,
} from "./issue.mjs";
import { ensureLabels } from "./labels.mjs";
import { resolveRepo } from "./repo.mjs";
import { writeIssueFile } from "./state.mjs";
import { assertSections, loadTemplate, renderTemplate } from "./templates.mjs";
import { isoStamp, toPositiveInt } from "./util.mjs";

export const INTAKE_REQUIRED_SECTIONS = ["## 需求摘要", "## 验收口径", "## 风险", "## 非目标", "## 待澄清问题"];

export const DEFAULT_ISSUE_BRIEF_TEMPLATE = `# Issue #{{issueNumber}} — {{issueTitle}}

> 由 mocl-agent intake 生成 · {{generatedAt}} · 仓库 \`{{repo}}\`

## 需求摘要

{{summary}}

## 验收口径

{{acceptance}}

## 风险

{{risks}}

## 非目标

{{nonGoals}}

## 待澄清问题

{{questions}}

## 元信息

| 项 | 值 |
| --- | --- |
| issue | {{issueLink}} |
| 标签 | {{labels}} |
| 作者 | {{author}} |
| 自动交付资格 | {{eligibility}} |
| 计划分支 | \`{{branch}}\` |
| 计划 worktree | \`{{worktree}}\` |
| 生成时间 | {{generatedAt}} |

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
`;

/** Run intake for one issue; always returns a summary (never throws). */
export async function intakeCommand(rawOptions = {}, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const issueNumber = toPositiveInt(rawOptions.issue, null, { name: "--issue" });
  if (issueNumber === null) {
    return {
      command: "intake",
      ok: false,
      exitCode: 2,
      dryRun: rawOptions.dryRun === true,
      code: "invalid-argument",
      message: "--issue <n> is required (positive integer)",
    };
  }
  const options = { ...rawOptions, runId: rawOptions.runId ?? `${isoStamp(now())}-intake-${issueNumber}` };
  const ctx = await createContext(options, deps);
  const startedAt = ctx.now().getTime();

  const summary = {
    command: "intake",
    ok: false,
    exitCode: 1,
    dryRun: ctx.dryRun,
    runId: ctx.runId,
    repo: null,
    issue: null,
    issueSource: null,
    briefPath: null,
    brief: null,
    planned: [],
    runDir: ctx.events.dir,
    eventsPath: ctx.events.path,
    code: null,
    message: null,
  };

  const finish = async (exitCode) => {
    summary.exitCode = exitCode;
    summary.ok = exitCode === 0;
    summary.durationMs = Math.max(0, ctx.now().getTime() - startedAt);
    summary.planned = publicPlan(ctx.planned);
    ctx.events.event("command.finish", { ok: summary.ok, code: summary.code });
    await ctx.flush();
    if (ctx.print) {
      ctx.log("");
      ctx.log(`RESULT: ${summary.ok ? (ctx.dryRun ? "DRY-RUN OK" : "INTAKE OK") : "FAIL"}${summary.code === null ? "" : ` (${summary.code})`}`);
      ctx.log(`  brief: ${summary.briefPath}`);
      if (ctx.dryRun) ctx.log(`  planned commands: ${ctx.planned.length} (zero side effects)`);
    }
    return summary;
  };

  try {
    await ensureLabels(ctx, rawOptions);
    const repoInfo = await resolveRepo(ctx, { repo: rawOptions.repo });
    summary.repo = repoInfo.nameWithOwner;
    ctx.log(`\n▶ resolve-repo — ${summary.repo} (source: ${repoInfo.source})`);

    const loaded = await loadIssue(ctx, {
      repo: summary.repo,
      number: issueNumber,
      issueJsonPath: rawOptions.issueJsonPath,
    });
    const issue = loaded.issue;
    summary.issue = { number: issue.number, title: issue.title, url: issue.url, labels: issue.labels };
    summary.issueSource = loaded.source;
    ctx.log(`\n▶ read-issue — #${issue.number} ${issue.title} (source: ${loaded.source})`);

    const sections = extractBriefSections(issue.body);
    const eligibility = evaluateIssue(issue);
    const template = await loadTemplate({ name: "issue-brief.md", fallback: DEFAULT_ISSUE_BRIEF_TEMPLATE });
    assertSections(template, INTAKE_REQUIRED_SECTIONS, { kind: "issue BRIEF template" });

    const brief = renderTemplate(template, {
      issueNumber: String(issue.number),
      issueTitle: issue.title,
      issueLink: issue.url ?? `#${issue.number}`,
      repo: summary.repo,
      labels: issue.labels.join(", ") || "(none)",
      author: issue.author,
      eligibility: eligibility.eligible ? "yes (agent:ready)" : `no (${eligibility.reasons.join(", ")})`,
      branch: issueBranch(issue.number, issue.title),
      worktree: `.worktrees/${worktreeDirName(issue.number)}`,
      summary: sections.summary,
      acceptance: sections.acceptance,
      risks: sections.risks,
      nonGoals: sections.nonGoals,
      questions: sections.questions,
      generatedAt: ctx.now().toISOString(),
    });
    summary.brief = brief;

    if (ctx.dryRun) {
      summary.briefPath = briefPath(ctx.cwd, issue.number);
      ctx.log(`\n▶ write-brief (dry-run: not written) — ${summary.briefPath}`);
      ctx.log("");
      ctx.log(brief);
    } else {
      summary.briefPath = await writeIssueFile(ctx.cwd, issue.number, "BRIEF.md", brief);
      ctx.log(`\n▶ write-brief — ${summary.briefPath}`);
    }

    return await finish(0);
  } catch (error) {
    const failure = toFailure(error);
    summary.code = failure.code;
    summary.message = failure.message;
    ctx.log(`\nFAIL [${failure.code}] ${failure.message}`);
    return await finish(exitCodeForFailure(failure));
  }
}

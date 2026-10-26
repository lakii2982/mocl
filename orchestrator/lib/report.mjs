/**
 * Delivery / blocked / verification reports.
 *
 * Rendered artifacts are written under `.agentspec/runs/<iso>/` and — for the
 * delivery report — posted as an issue comment. They answer the user's only
 * question: what changed, what proved it, what happens if we roll back.
 */

import { evidenceTable } from "./gates.mjs";
import { AGENT_BLOCKED, AGENT_READY, BLOCKED } from "./labels.mjs";
import { assertSections, indentBlock, loadTemplate, renderTemplate, summarize } from "./templates.mjs";

export const DELIVERY_REQUIRED_SECTIONS = ["## 交付摘要", "## 证据", "## 风险与回滚"];

export const DEFAULT_DELIVERY_TEMPLATE = `# 交付报告 — issue #{{issueNumber}} {{issueTitle}}

> 自动生成 by mocl-agent · run \`{{runId}}\` · {{generatedAt}}

## 交付摘要

{{summary}}

## 关联

- issue：{{issueLink}}
- PR：{{prUrl}}
- 分支：\`{{branch}}\` → \`{{base}}\`
- worktree：\`{{worktree}}\`
- 改动文件：{{changedFiles}}

## 证据

{{evidenceTable}}

## 风险与回滚

- 风险：{{risks}}
- 回滚：
{{rollback}}

## 运行信息

| 项 | 值 |
| --- | --- |
| runner | {{agentRunner}} |
| 角色 prompt | {{rolePromptSource}} |
| issue 来源 | {{issueSource}} |
| 运行目录 | \`{{runDir}}\` |
| 耗时 | {{duration}} |
| 证据日志 | \`{{eventsPath}}\` |

---

<sub>由 mocl-agent 自动生成；证据可用 \`node orchestrator/cli.mjs verify --pr {{prNumber}} --repo {{repo}}\` 复跑。</sub>

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
`;

const DEFAULT_BLOCKED_TEMPLATE = `## 自动流程已阻塞 — issue #{{issueNumber}}

@{{owner}} 该 issue 的自动交付连续失败 **{{attempts}}** 次，已被打上 \`{{blockedLabel}}\` + \`{{agentBlockedLabel}}\`，请人工介入。

- 失败代码：\`{{failureCode}}\`
- 失败原因：{{failureMessage}}
- 最近运行目录：\`{{runDir}}\`
- 分支：\`{{branch}}\`
- 查看证据：\`{{eventsPath}}\`

<details><summary>失败详情</summary>

\`\`\`json
{{failureDetails}}
\`\`\`

</details>

恢复方式（人工修复后）：

\`\`\`bash
gh issue edit {{issueNumber}} --repo {{repo}} --remove-label {{blockedLabel}} --remove-label {{agentBlockedLabel}} --add-label {{readyLabel}}
\`\`\`

同期如需人工接管：\`node orchestrator/cli.mjs deliver --issue {{issueNumber}} --repo {{repo}} --force\`

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
`;

/**
 * @param {{ issue: object, repo: string, branch: string, base: string, worktree: string,
 *           prUrl: string, gates: object[], agent: { runner: string, rolePromptSource: string },
 *           issueSource: string, runId: string, runDir: string, eventsPath: string,
 *           changedFiles: string[], risks?: string, rollback?: string,
 *           durationMs?: number, generatedAt?: string, summary?: string }} input
 */
export function renderDeliveryReport(input) {
  const {
    issue, repo, branch, base, worktree, prUrl, gates, agent, issueSource, runId, runDir, eventsPath,
    changedFiles = [], risks, rollback, durationMs, generatedAt, summary,
  } = input;

  const markdown = renderTemplate(DEFAULT_DELIVERY_TEMPLATE, {
    issueNumber: String(issue.number),
    issueTitle: issue.title,
    issueLink: issue.url ?? `#${issue.number}`,
    prUrl: prUrl ?? "(dry-run: planned)",
    branch,
    base,
    worktree,
    changedFiles: changedFiles.length > 0 ? changedFiles.map((file) => `\`${file}\``).join(", ") : "（无 / 未计算）",
    evidenceTable: evidenceTable(gates ?? []),
    risks: summarize(risks ?? "未由 issue 声明；默认风险：门禁失败、改动越界、评审不通过。", 600),
    rollback: rollback ?? buildDefaultRollback({ branch, base, worktree, prUrl }),
    agentRunner: agent?.runner ?? "mock",
    rolePromptSource: agent?.rolePromptSource ?? "fallback",
    issueSource,
    runId,
    runDir,
    eventsPath,
    repo,
    prNumber: String(extractPrNumber(prUrl) ?? "?"),
    duration: durationMs === undefined ? "（未知）" : formatDuration(durationMs),
    generatedAt: generatedAt ?? new Date().toISOString(),
    summary: indentBlock(summary ?? `完成 issue #${issue.number}：${issue.title}`, ""),
  });
  assertSections(markdown, DELIVERY_REQUIRED_SECTIONS, { kind: "delivery report" });
  return markdown;
}

function extractPrNumber(prUrl) {
  const match = /\/pull\/(\d+)/.exec(String(prUrl ?? ""));
  return match === null ? null : Number(match[1]);
}

function buildDefaultRollback({ branch, base, worktree, prUrl }) {  return [
    "```bash",
    `git push origin --delete ${branch}          # 未合并：删远端分支`,
    `gh pr close ${prUrl ?? "<pr-url>"} --delete-branch # 未合并：关 PR 并删分支`,
    `git worktree remove --force ${worktree}      # 清理本地 worktree`,
    `git revert -m 1 <merge-commit>              # 已合并：revert 到 ${base}`,
    "```",
  ].join("\n");
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "（未知）";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/**
 * Comment posted when an issue is blocked after exhausting attempts.
 * @param {{ issue: object, repo: string, failure: { code: string, message: string, details?: object },
 *           attempts: number, runDir: string, eventsPath: string, branch: string }} input
 */
export function renderBlockedNote({ issue, repo, failure, attempts, runDir, eventsPath, branch }) {
  return renderTemplate(DEFAULT_BLOCKED_TEMPLATE, {
    blockedLabel: BLOCKED,
    agentBlockedLabel: AGENT_BLOCKED,
    readyLabel: AGENT_READY,
    issueNumber: String(issue.number),
    owner: issue.author ?? "unknown",
    attempts: String(attempts),
    failureCode: failure.code,
    failureMessage: summarize(failure.message, 500),
    failureDetails: JSON.stringify(failure.details ?? {}, null, 2),
    runDir,
    eventsPath,
    branch,
    repo,
  });
}

export const VERIFY_REQUIRED_SECTIONS = ["## 门禁证据", "## 结论"];

/** Verification evidence report written by `verify`. */
export function renderVerifyReport({ pr, repo, verdict, gates, reviews, runDir, generatedAt }) {
  const reviewSections = reviews.length === 0
    ? "（未启用角色评审；加 `--review` 可让 verifier/reviewer 角色复核）"
    : reviews
        .map((review) => {
          const lines = [
            `### ${review.role}（${review.verdict}）`,
            `- rolePromptSource: ${review.rolePromptSource}`,
            `- runner: ${review.runner}`,
            "",
            "```text",
            String(review.stdout ?? "").trim().slice(0, 4000),
            "```",
          ];
          return lines.join("\n");
        })
        .join("\n\n");

  const markdown = [
    `# 验证报告 — PR #${pr.number}`,
    "",
    `- 仓库：\`${repo}\``,
    `- PR：${pr.url ?? `#${pr.number}`}`,
    `- 分支：\`${pr.headRefName ?? "(unknown)"}\``,
    `- 结论：**${verdict}**`,
    `- 运行目录：\`${runDir}\``,
    `- 生成时间：${generatedAt}`,
    "",
    "## 结论",
    "",
    verdict === "PASS" ? "PASS：本地门禁全绿，评审未发现阻断问题。" : "FAIL：存在失败门禁或阻断评审意见。",
    "",
    "## 门禁证据",
    "",
    evidenceTable(gates),
    "",
    "## 角色评审",
    "",
    reviewSections,
    "",
    "---",
    "",
    "<sub>由 mocl-agent 自动生成 · 用同一命令可复跑本报告。</sub>",
  ].join("\n");
  assertSections(markdown, VERIFY_REQUIRED_SECTIONS, { kind: "verify report" });
  return markdown;
}

/** Load the delivery report template from disk (falls back to the built-in copy). */
export async function loadDeliveryTemplate({ templatePath } = {}) {
  return loadTemplate({ name: "delivery-report.md", templatePath, fallback: DEFAULT_DELIVERY_TEMPLATE });
}

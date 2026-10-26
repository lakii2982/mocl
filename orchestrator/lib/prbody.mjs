/**
 * PR body rendering.
 *
 * The template lives in `orchestrator/templates/pr-body.md`; the same required
 * sections are asserted after rendering so a template edit can never silently
 * drop the issue link, the evidence table or the rollback plan.
 */

import { fail } from "./errors.mjs";
import { evidenceTable } from "./gates.mjs";
import { IN_REVIEW } from "./labels.mjs";
import { assertSections, indentBlock, loadTemplate, renderTemplate, summarize } from "./templates.mjs";

export const PR_REQUIRED_SECTIONS = ["## 关联 issue", "## 证据表", "## 风险与回滚"];

export const DEFAULT_PR_TEMPLATE = `## 关联 issue

{{issueLink}}

{{issueSummary}}

## 交付内容

{{deliverySummary}}

## 证据表

{{evidenceTable}}

## 风险与回滚

- 风险：{{risks}}
- 回滚：{{rollback}}

## 检查清单

{{checklist}}

---

<sub>由 mocl-agent 自动生成 · run \`{{runId}}\` · {{generatedAt}}</sub>

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
`;

export function buildChecklist(results) {
  const allPass = results.every((entry) => entry.ok);
  return [
    `- [${allPass ? "x" : " "}] 本地门禁 ${allPass ? "全绿" : "存在失败项"}（见证据表）`,
    "- [x] 改动仅限 issue 范围",
    "- [ ] CI 绿（GitHub Actions）",
    "- [ ] 评审通过（verifier + reviewer）",
    `- [ ] 关联 issue 打上 \`${IN_REVIEW}\``,
  ].join("\n");
}

export function buildRollbackInstructions({ branch, base, worktree, prUrl }) {
  const lines = [
    "```bash",
    `git push origin --delete ${branch}                 # 未合并：删除远端分支`,
    `gh pr close ${prUrl ?? "<pr-url>"} --delete-branch  # 未合并：关闭 PR 并删分支`,
    `git worktree remove --force ${worktree}             # 清理本地 worktree`,
  ];
  if (base !== undefined && base !== null) {
    lines.push(`git revert -m 1 <merge-commit>                    # 已合并：revert 到 ${base}`);
  }
  lines.push("```");
  return lines.join("\n");
}

/**
 * Render the PR body.
 * @param {{ issue: object, repo: string, branch: string, base: string, worktree: string,
 *           gates: object[], agent: { runner: string, rolePromptSource: string },
 *           runId: string, generatedAt?: string, template?: string, risks?: string }} input
 */
export function renderPrBody({
  issue,
  repo,
  branch,
  base,
  worktree,
  gates,
  agent,
  runId,
  generatedAt,
  template,
  risks,
}) {
  const body = renderTemplate(template ?? DEFAULT_PR_TEMPLATE, {
    issueNumber: String(issue.number),
    issueTitle: issue.title,
    issueLink: `Closes #${issue.number} — ${issue.url ?? `issue #${issue.number}`}`,
    issueSummary: indentBlock(summarize(issue.body, 600)),
    deliverySummary: [
      `- 仓库：\`${repo}\``,
      `- 分支：\`${branch}\` → \`${base}\``,
      `- 隔离 worktree：\`${worktree}\``,
      `- agent runner：\`${agent.runner}\`（角色 prompt：${agent.rolePromptSource}）`,
      "- 由 orchestrator 自动提交并创建 PR",
    ].join("\n"),
    evidenceTable: evidenceTable(gates),
    risks: summarize(risks ?? "未由 issue 声明；默认风险：门禁失败、改动越界、评审不通过。", 600),
    rollback: buildRollbackInstructions({ branch, base, worktree, prUrl: undefined }),
    checklist: buildChecklist(gates),
    runId,
    generatedAt: generatedAt ?? new Date().toISOString(),
  });
  assertSections(body, PR_REQUIRED_SECTIONS, { kind: "PR body" });
  return body;
}

/** Load the PR template from disk (falls back to the built-in copy). */
export async function loadPrTemplate({ templatePath } = {}) {
  return loadTemplate({ name: "pr-body.md", templatePath, fallback: DEFAULT_PR_TEMPLATE });
}

/** Validate a custom PR template before a run mutates anything. */
export function validatePrTemplate(template) {
  if (typeof template !== "string" || template.trim() === "") {
    fail("template-invalid", "PR template is empty");
  }
  assertSections(template, PR_REQUIRED_SECTIONS, { kind: "PR template" });
  return true;
}

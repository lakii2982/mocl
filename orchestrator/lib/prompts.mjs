/**
 * Role prompts.
 *
 * The slice boundary matters here: `agents/roles/*.md` is owned by the process
 * slice (R3). We only *read* those files and never modify them. When a file is
 * missing (R3 not landed yet, or a fork without the roles dir) we fall back to
 * the built-in prompts below and record `rolePromptSource: "fallback"` in every
 * artifact so nobody mistakes the fallback for the real role contract.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fail } from "./errors.mjs";
import { formatCommand } from "./exec.mjs";

export const ROLE_NAMES = ["implementer", "verifier", "reviewer"];

export const FALLBACK_PROMPTS = {
  implementer: `# 角色：实现者（implementer）

> 内置回退文案（未找到 agents/roles/implementer.md，由 orchestrator 提供最小契约）。

## 输入
- issue 编号、标题、正文、标签（agent:ready 表示已就绪）
- 目标仓库（owner/name）、基线分支、隔离 worktree 路径
- 工程约束与门禁清单（由 orchestrator 追加在本 prompt 末尾）

## 输出
- worktree 内完成 issue 范围内的代码/文档改动（必要时补测试）
- 门禁命令的最终结果（PASS/FAIL + 失败原因）
- 结尾摘要：改动文件、门禁结果、风险与回滚方式

## 禁止
- 禁止 \`git push --force\` / \`--force-with-lease\` / 改写已推送历史
- 禁止读取、打印或提交任何凭据（token / key / cookie / .env）
- 禁止修改 issue 范围外的文件，禁止升级依赖或运行 \`pnpm install\`
- 禁止提交 \`.agentspec/\`、\`.worktrees/\`、\`node_modules/\` 等本地产物

## 完成判据
- 门禁全绿：typecheck / test / validate-abi
- 改动仅限 issue 范围，提交信息含 issue 编号
- 只在指定分支/worktree 内工作，结束时 \`git status --short\` 无意外改动`,
  verifier: `# 角色：验证者（verifier）

> 内置回退文案（未找到 agents/roles/verifier.md，由 orchestrator 提供最小契约）。

## 输入
- issue 的验收口径与 PR diff
- 本地门禁原始输出（typecheck / test / validate-abi）
- 运行证据目录 \`.agentspec/runs/<iso>/\`

## 输出
- 首行结论：\`VERDICT: PASS\` 或 \`VERDICT: FAIL\`
- 逐条验收口径的证据（命令 + 退出码 + 关键输出）
- 失败项的可复现命令与最小修复建议

## 禁止
- 只读评审：不得修改代码、提交、push 或创建 PR
- 不得以 dry-run 计划代替真实门禁证据
- 不得读取或打印凭据

## 完成判据
- 每条验收口径都有可复跑命令与原始输出
- 结论与证据一致；证据缺失即 FAIL`,
  reviewer: `# 角色：评审者（reviewer）

> 内置回退文案（未找到 agents/roles/reviewer.md，由 orchestrator 提供最小契约）。

## 输入
- PR 标题/正文/关联 issue
- diff 摘要与门禁证据
- 仓库工程约束（零第三方依赖、Node >= 24 ESM、禁 force push）

## 输出
- 首行结论：\`VERDICT: PASS\` 或 \`VERDICT: FAIL\`
- 阻断问题清单（文件:行 + 原因 + 建议）
- 非阻断建议与风险备注

## 禁止
- 只读评审：不得修改代码或合并 PR
- 不得因风格偏好判 FAIL（只拦正确性/安全/越界/可维护性问题）
- 不得读取或打印凭据

## 完成判据
- 阻断问题 0 条才可 PASS
- 每条结论都能定位到文件或命令证据`,
};

/**
 * @returns {Promise<{ role: string, text: string, source: "file" | "fallback", path: string | null, note: string | null }>}
 */
export async function loadRolePrompt({ cwd, role, rolesDir = "agents/roles" } = {}) {
  if (!ROLE_NAMES.includes(role)) fail("invalid-role", `unknown role ${JSON.stringify(role)} (expected ${ROLE_NAMES.join("|")})`);
  const path = resolve(cwd, rolesDir, `${role}.md`);
  try {
    const text = await readFile(path, "utf8");
    if (text.trim() === "") {
      return { role, text: FALLBACK_PROMPTS[role], source: "fallback", path: null, note: `${path} is empty` };
    }
    return { role, text, source: "file", path, note: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { role, text: FALLBACK_PROMPTS[role], source: "fallback", path: null, note: `${path} not found` };
    }
    throw error;
  }
}

/** Engineering constraints appended to every agent prompt. */
export function promptConstraints({ repo, base, branch, worktree, gates = [] }) {
  const gateLines = gates.map((gate) => `- \`${gate.id}\`: \`${formatCommand(gate.command, gate.args)}\``);
  return [
    "## 工程约束（由 orchestrator 自动注入）",
    `- 仓库：${repo}`,
    `- 基线分支：${base}`,
    `- 工作分支：${branch}`,
    `- 隔离 worktree：${worktree}（只允许在此目录内改动）`,
    "- 运行时：Node >= 24，ESM，零第三方依赖（除非 issue 明确要求）",
    "- 禁止 `git push --force` / `--force-with-lease`，禁止改写已推送历史",
    "- 禁止读取/打印凭据；禁止修改 ~/.dsh、DSH 安装目录与 impl/",
    "- 门禁必须全绿：",
    ...gateLines,
    "- 提交信息格式：`feat(issue-<n>): <一句话>`",
    "",
  ].join("\n");
}

/** Full implementer prompt = role prompt + issue context + constraints. */
export async function buildImplementerPrompt({ cwd, rolesDir, issue, repo, base, branch, worktree, gates }) {
  const rolePrompt = await loadRolePrompt({ cwd, role: "implementer", rolesDir });
  const issueContext = [
    "## Issue 上下文",
    `- 编号：#${issue.number}`,
    `- 标题：${issue.title}`,
    `- 链接：${issue.url ?? "(unknown)"}`,
    `- 标签：${issue.labels.join(", ") || "(none)"}`,
    "",
    "### 正文",
    issue.body.trim() === "" ? "(空)" : issue.body.trim(),
    "",
  ].join("\n");
  const prompt = [
    rolePrompt.text.trim(),
    "",
    issueContext,
    promptConstraints({ repo, base, branch, worktree, gates }),
  ].join("\n");
  return {
    prompt,
    role: "implementer",
    rolePromptSource: rolePrompt.source,
    rolePromptPath: rolePrompt.path,
    rolePromptNote: rolePrompt.note,
  };
}

/** Prompt used by `verify --review` for the verifier/reviewer roles. */
export async function buildReviewPrompt({ cwd, rolesDir, role, repo, pr, gates, issue }) {
  const rolePrompt = await loadRolePrompt({ cwd, role, rolesDir });
  const gateLines = gates.map((gate) => `- ${gate.id}: ${gate.ok ? "PASS" : "FAIL"} (exit ${gate.code ?? "?"}) ${gate.display}`);
  const prompt = [
    rolePrompt.text.trim(),
    "",
    "## 待评审对象",
    `- 仓库：${repo}`,
    `- PR：#${pr.number} ${pr.title ?? ""}`,
    `- 分支：${pr.headRefName ?? "(unknown)"}`,
    `- 关联 issue：${issue === null || issue === undefined ? pr.issueNumber ?? "(unknown)" : `#${issue.number} ${issue.title}`}`,
    "",
    "## 本地门禁证据",
    ...(gateLines.length > 0 ? gateLines : ["- （无）"]),
    "",
    "只输出评审结论与证据，不要修改任何文件。首行必须是 `VERDICT: PASS` 或 `VERDICT: FAIL`。",
    "",
  ].join("\n");
  return {
    prompt,
    role,
    rolePromptSource: rolePrompt.source,
    rolePromptPath: rolePrompt.path,
    rolePromptNote: rolePrompt.note,
  };
}

/** Parse `VERDICT: PASS|FAIL` out of an agent reply; UNKNOWN forces FAIL upstream. */
export function parseVerdict(stdout) {
  const text = String(stdout ?? "");
  const match = /VERDICT\s*:\s*(PASS|FAIL)/i.exec(text);
  if (match === null) return { verdict: "UNKNOWN", reason: "agent reply did not contain `VERDICT: PASS|FAIL`" };
  return { verdict: match[1].toUpperCase(), reason: null };
}

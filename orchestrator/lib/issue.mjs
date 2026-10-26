/**
 * GitHub issue model: loading (gh / fixture / offline stub), label policy,
 * branch/worktree naming, and the `intake` BRIEF extraction.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fail } from "./errors.mjs";
import { AGENT_BLOCKED, AGENT_READY, BLOCKED } from "./labels.mjs";
import { ghJson } from "./repo.mjs";
import { safeSegment, truncate } from "./util.mjs";

/** Label names come from the single source of truth adapter (`labels.mjs`). */
export const LABEL_READY = AGENT_READY;
export const LABEL_AGENT_BLOCKED = AGENT_BLOCKED;
export const LABEL_STATUS_BLOCKED = BLOCKED;

export const ISSUE_JSON_FIELDS = "number,title,body,labels,state,author,url";

const OFFLINE_ISSUE_BODY = [
  "（dry-run 离线降级：未执行 `gh issue view`，issue 正文不可用。）",
  "",
  "## 需求摘要",
  "待读取真实 issue 正文；dry-run 仅验证流水线计划与参数拼装。",
  "",
  "## 验收口径",
  "门禁全绿 + PR 合并前 CI 绿（真实运行以 issue 正文为准）。",
].join("\n");

/** Labels may arrive as `["a"]`, `[{name:"a"}]`, or `{nodes:[{name}]}` (gh --json). */
export function labelNames(rawLabels) {
  if (!Array.isArray(rawLabels)) return [];
  return rawLabels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string" && name.length > 0);
}

/** Normalise gh JSON / fixture JSON into the orchestrator's issue shape. */
export function normalizeIssue(raw, { fallbackNumber } = {}) {
  const number = Number(raw?.number ?? fallbackNumber);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail("invalid-issue", `issue number is missing or invalid: ${JSON.stringify(raw?.number ?? fallbackNumber)}`);
  }
  const author = typeof raw?.author === "string" ? raw.author : raw?.author?.login;
  return {
    number,
    title: String(raw?.title ?? "").trim() || `issue-${number}`,
    body: String(raw?.body ?? ""),
    labels: labelNames(raw?.labels),
    state: String(raw?.state ?? "OPEN").toUpperCase(),
    author: author ?? "unknown",
    url: raw?.url ?? null,
  };
}

/** Label policy for automatic dispatch (contract: agent:ready and not blocked). */
export function evaluateIssue(issue) {
  const reasons = [];
  if (issue.state === "CLOSED") reasons.push("issue-closed");
  if (!issue.labels.includes(AGENT_READY)) reasons.push(`missing-label:${AGENT_READY}`);
  if (issue.labels.includes(AGENT_BLOCKED)) reasons.push(`label:${AGENT_BLOCKED}`);
  if (issue.labels.includes(BLOCKED)) reasons.push(`label:${BLOCKED}`);
  return { eligible: reasons.length === 0, reasons };
}

export function slugifyTitle(title, maxLength = 40) {
  const slug = safeSegment(title);
  if (slug === "") return "issue";
  return slug.slice(0, maxLength).replace(/[-._]+$/, "") || "issue";
}

export function issueBranch(number, title) {
  return `agent/${number}-${slugifyTitle(title)}`;
}

export function worktreeDirName(number) {
  return `issue-${number}`;
}

export function worktreePath(cwd, worktreeRoot, number) {
  return resolve(cwd, worktreeRoot ?? ".worktrees", worktreeDirName(number));
}

/**
 * Load an issue.
 * @returns {Promise<{ issue: object, source: "gh" | "file" | "offline-stub", note: string }>}
 */
export async function loadIssue(ctx, { repo, number, issueJsonPath } = {}) {
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail("invalid-argument", `--issue must be a positive integer, got ${JSON.stringify(number)}`);
  }

  if (issueJsonPath !== undefined && issueJsonPath !== null) {
    const path = resolve(ctx.cwd, String(issueJsonPath));
    let raw;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      fail("issue-json-unreadable", `cannot read --issue-json ${path}: ${error?.message ?? error}`);
    }
    return {
      issue: normalizeIssue({ ...raw, number: raw?.number ?? number }, { fallbackNumber: number }),
      source: "file",
      note: `issue fixture: ${path}`,
    };
  }

  if (ctx.dryRun) {
    // Plan the read but never execute it: dry-run must work with no network.
    await ctx.run("gh", ["issue", "view", String(number), "-R", repo, "--json", ISSUE_JSON_FIELDS], {
      intent: "read issue (planned)",
    });
    return {
      issue: normalizeIssue(
        {
          number,
          title: `issue-${number}`,
          body: OFFLINE_ISSUE_BODY,
          labels: [AGENT_READY],
          state: "OPEN",
          author: "unknown",
        },
        { fallbackNumber: number },
      ),
      source: "offline-stub",
      note: "dry-run: issue read planned only; using offline stub (pass --issue-json for real content)",
    };
  }

  const result = await ghJson(ctx, ["issue", "view", String(number), "-R", repo, "--json", ISSUE_JSON_FIELDS], {
    intent: `read issue #${number}`,
  });
  return { issue: normalizeIssue(result.data, { fallbackNumber: number }), source: "gh", note: `gh issue view ${number}` };
}

/* ------------------------------------------------------------------ */
/* intake: BRIEF extraction                                             */
/* ------------------------------------------------------------------ */

const BRIEF_SECTIONS = [
  {
    key: "summary",
    title: "需求摘要",
    aliases: ["需求摘要", "摘要", "背景", "目标", "summary", "goal", "context"],
    fallback: "（issue 未提供需求摘要；请补充背景与期望结果）",
  },
  {
    key: "acceptance",
    title: "验收口径",
    aliases: ["验收口径", "验收标准", "acceptance", "done criteria"],
    fallback: "门禁全绿（typecheck / test / validate-abi）；PR 合并前 CI 绿；改动与 issue 范围一致。",
  },
  {
    key: "risks",
    title: "风险",
    aliases: ["风险", "risk", "risks"],
    fallback: "未由 issue 声明；默认风险：门禁失败、改动越界、评审不通过。",
  },
  {
    key: "nonGoals",
    title: "非目标",
    aliases: ["非目标", "non-goal", "non goals", "out of scope"],
    fallback: "未由 issue 声明；不得扩大范围（不升级依赖、不改无关模块）。",
  },
  {
    key: "questions",
    title: "待澄清问题",
    aliases: ["待澄清问题", "待澄清", "open questions", "questions", "待确认"],
    fallback: "无（如有疑问在 issue 评论中提出，达升级点再人工介入）。",
  },
];

/**
 * Extract `## 需求摘要`-style sections from the issue body. Falls back to the
 * whole body for the summary and to contract defaults for the rest.
 * @returns {Record<string, string>}
 */
export function extractBriefSections(body) {
  const text = String(body ?? "");
  const buckets = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s*(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const title = heading[1].toLowerCase();
      const matched = BRIEF_SECTIONS.find((section) =>
        section.aliases.some((alias) => title.includes(alias.toLowerCase())),
      );
      current = matched?.key ?? null;
      if (current !== null && !buckets.has(current)) buckets.set(current, []);
      continue;
    }
    if (current !== null) buckets.get(current)?.push(line);
  }

  const sections = {};
  for (const section of BRIEF_SECTIONS) {
    const captured = (buckets.get(section.key) ?? []).join("\n").trim();
    sections[section.key] = captured !== "" ? captured : section.fallback;
  }
  if (sections.summary === BRIEF_SECTIONS[0].fallback && text.trim() !== "") {
    sections.summary = truncate(text.trim(), 1200);
  }
  return sections;
}

/** Human-readable intake summary printed by `intake --dry-run`. */
export function intakeChecklist(issue, repo) {
  const eligibility = evaluateIssue(issue);
  return [
    `issue: #${issue.number} ${issue.title}`,
    `repo:  ${repo}`,
    `state: ${issue.state}  labels: ${issue.labels.join(", ") || "(none)"}`,
    `eligible-for-deliver: ${eligibility.eligible ? "yes" : `no (${eligibility.reasons.join(", ")})`}`,
    `branch: ${issueBranch(issue.number, issue.title)}`,
    `worktree: .worktrees/${worktreeDirName(issue.number)}`,
  ].join("\n");
}

/** Path used by `intake` for the generated BRIEF. */
export function briefPath(cwd, number) {
  return join(resolve(cwd), ".agentspec", "issues", String(number), "BRIEF.md");
}

/**
 * `status` — read-only view of `agent:ready` issues, their branch/PR, and the
 * last local run.
 *
 * Read-only means: no writes to GitHub; no state mutation. A local response
 * cache (`.agentspec/status-cache.json`) is written on success and reused when
 * the network/gh is unavailable, so `status` degrades to `SKIP:offline` instead
 * of failing a CI smoke test. `--strict` turns that SKIP into exit 1.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContext, publicPlan } from "./context.mjs";
import { OrchestratorError, toFailure } from "./errors.mjs";
import { EXIT_ENV, exitCodeForFailure } from "./exit-codes.mjs";
import { issueBranch, normalizeIssue } from "./issue.mjs";
import { AGENT_READY, ensureLabels } from "./labels.mjs";
import { ghJson, resolveRepo } from "./repo.mjs";
import { ensureStateRoot, readState, writeRunFile } from "./state.mjs";
import { isoStamp } from "./util.mjs";

/** Run `status`; always returns a summary (never throws). */
export async function statusCommand(rawOptions = {}, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const options = {
    ...rawOptions,
    persistEvents: false,
    runId: rawOptions.runId ?? `${isoStamp(now())}-status`,
  };
  const ctx = await createContext(options, deps);
  const cachePath = join(ctx.cwd, ".agentspec", "status-cache.json");

  const summary = {
    command: "status",
    ok: false,
    exitCode: 0,
    offline: false,
    repo: null,
    issues: [],
    cachedAt: null,
    note: null,
    planned: [],
    code: null,
    message: null,
  };

  const readCache = async () => {
    try {
      return JSON.parse(await readFile(cachePath, "utf8"));
    } catch {
      return null;
    }
  };

  const useCache = async (note) => {
    const cache = await readCache();
    summary.offline = true;
    if (cache !== null && Array.isArray(cache.issues)) {
      summary.repo = summary.repo ?? cache.repo ?? null;
      summary.issues = cache.issues;
      summary.cachedAt = cache.cachedAt ?? null;
      summary.note = `${note} — 使用本地缓存 ${cachePath}（缓存时间 ${cache.cachedAt ?? "unknown"}）`;
      // --strict upgrades a cached SKIP into "environment unavailable".
      summary.exitCode = rawOptions.strict === true ? EXIT_ENV : 0;
    } else {
      summary.note = `${note} — 无本地缓存（先联网跑一次 status 生成缓存）`;
      summary.exitCode = EXIT_ENV;
      summary.code = "env-unavailable";
    }
    if (summary.exitCode === EXIT_ENV && summary.code === null) summary.code = "env-unavailable";
    ctx.log(summary.note);
    printTable(ctx, summary);
    return summary;
  };

  try {
    // Label truth-source validation is an environment check: missing labels.yml
    // fails closed with exit code 4 (never a silent degrade).
    await ensureLabels(ctx, rawOptions);

    if (rawOptions.offline === true) {
      return await useCache("SKIP:offline (--offline)");
    }

    const repoInfo = await resolveRepo(ctx, { repo: rawOptions.repo });
    summary.repo = repoInfo.nameWithOwner;

    const issueList = await ghJson(
      ctx,
      [
        "issue",
        "list",
        "-R",
        summary.repo,
        "--label",
        AGENT_READY,
        "--state",
        "open",
        "--json",
        "number,title,labels,author,url",
        "--limit",
        "100",
      ],
      { allowFailure: true, intent: "list agent:ready issues" },
    );
    if (!issueList.ok) {
      const failure = { code: "gh-failed", message: "gh issue list failed" };
      summary.code = failure.code;
      summary.message = failure.message;
      return await useCache(`SKIP:offline — ${failure.code}`);
    }

    const prList = await ghJson(
      ctx,
      ["pr", "list", "-R", summary.repo, "--state", "all", "--json", "number,title,headRefName,state,url", "--limit", "200"],
      { allowFailure: true, intent: "list PRs for branch mapping" },
    );
    const prs = prList.ok && Array.isArray(prList.data) ? prList.data : [];
    const prByBranch = new Map(prs.map((pr) => [pr.headRefName, pr]));

    const state = await readState(ctx.cwd);
    summary.issues = (issueList.data ?? []).map((raw) => {
      const issue = normalizeIssue(raw);
      const branch = issueBranch(issue.number, issue.title);
      const pr = prByBranch.get(branch) ?? null;
      const local = state.issues[String(issue.number)] ?? null;
      return {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        labels: issue.labels,
        branch,
        pr: pr === null ? null : { number: pr.number, state: pr.state, url: pr.url },
        lastRun: local?.lastRun ?? null,
        lastStatus: local?.lastStatus ?? null,
        attempts: Number(local?.attempts ?? 0),
        blocked: local?.blocked === true,
      };
    });

    summary.ok = true;
    summary.exitCode = 0;
    if (summary.issues.length === 0) summary.note = `no open issues with label ${AGENT_READY}`;
    printTable(ctx, summary);

    if (!ctx.dryRun) {
      try {
        await ensureStateRoot(ctx.cwd);
        await writeRunFile(
          join(ctx.cwd, ".agentspec"),
          "status-cache.json",
          `${JSON.stringify({ cachedAt: ctx.now().toISOString(), repo: summary.repo, issues: summary.issues }, null, 2)}\n`,
        );
      } catch {
        // Cache is best effort; never fail status because of it.
      }
    }
    return summary;
  } catch (error) {
    const failure = toFailure(error);
    summary.code = failure.code;
    summary.message = failure.message;
    if (failure.code === "labels-unavailable" || failure.code === "labels-incomplete" || failure.code === "repo-unresolved") {
      summary.offline = false;
      summary.note = `FAIL:${failure.code} — ${failure.message}`;
      summary.exitCode = exitCodeForFailure(failure);
      ctx.log(summary.note);
      return summary;
    }
    return await useCache(`SKIP:offline — ${failure.code}: ${failure.message}`);
  } finally {
    summary.planned = publicPlan(ctx.planned);
  }
}

function printTable(ctx, summary) {
  if (ctx.print !== true) return;
  if (summary.repo !== null) ctx.log(`\nrepo: ${summary.repo}`);
  if (summary.offline) return;
  if (summary.issues.length === 0) {
    ctx.log(`  (no open issues with label ${AGENT_READY})`);
    return;
  }
  for (const issue of summary.issues) {
    ctx.log(`  #${issue.number} ${issue.title}`);
    ctx.log(
      `    branch: ${issue.branch}  pr: ${
        issue.pr === null ? "none" : `#${issue.pr.number} ${issue.pr.state} ${issue.pr.url}`
      }`,
    );
    ctx.log(
      `    lastRun: ${issue.lastRun ?? "-"}  lastStatus: ${issue.lastStatus ?? "-"}  attempts: ${issue.attempts}` +
        `${issue.blocked ? "  BLOCKED" : ""}`,
    );
  }
}

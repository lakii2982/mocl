/**
 * Repository resolution and the safe wrappers around `git` / `gh`.
 *
 * Safety rules enforced here rather than at call sites:
 * - force push / force-with-lease is refused for every git invocation;
 * - every command goes through `ctx.run` (injectable, dry-run aware);
 * - failures carry the command line and stderr tail for the audit log.
 */

import { fail, OrchestratorError } from "./errors.mjs";
import { formatCommand } from "./exec.mjs";
import { redactArgs } from "./redact.mjs";
import { tail } from "./util.mjs";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FORCE_FLAGS = new Set(["-f", "--force", "--force-with-lease", "--force-if-includes", "--mirror"]);

/** First non-option token after git global options (`-C <path>`, `-c k=v`, ...). */
function gitSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

/**
 * Throw if a `git push` argument could rewrite published history. The guard is
 * scoped to push (plus blanket `--mirror`), so legitimate `git worktree remove
 * --force` cleanup during failure handling still works.
 */
export function assertSafeGitArgs(args) {
  const isPush = gitSubcommand(args) === "push" || args.includes("push");
  if (!isPush) {
    if (args.includes("--mirror")) {
      throw new OrchestratorError("force-push-forbidden", "refusing to run git --mirror: never automated", { args });
    }
    return;
  }
  for (const arg of args) {
    const text = String(arg);
    if (FORCE_FLAGS.has(text) || text.startsWith("--force-with-lease")) {
      throw new OrchestratorError(
        "force-push-forbidden",
        `refusing to run git ${args.join(" ")}: force pushes are never automated (push a new commit instead)`,
        { args },
      );
    }
  }
}

/** Parse `git@github.com:owner/name.git`, `https://github.com/owner/name`, `ssh://...`. */
export function parseGitRemoteUrl(url) {
  const text = String(url ?? "").trim();
  const patterns = [
    /^git@[\w.-]+:([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
    /^ssh:\/\/git@[\w.-]+\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
    /^https?:\/\/[\w.-]+\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) return match[1];
  }
  return null;
}

/**
 * Resolve `owner/name`: explicit option > `gh repo view` > `git remote get-url origin`.
 * In dry-run the lookups are only *planned*; the placeholder `<owner>/<repo>` is
 * returned so the rest of the plan can still be printed offline.
 */
export async function resolveRepo(ctx, { repo } = {}) {
  if (repo !== undefined && repo !== null && repo !== "") {
    const value = String(repo);
    if (!REPO_PATTERN.test(value)) {
      fail("invalid-repo", `--repo must look like owner/name, got ${JSON.stringify(value)}`);
    }
    return { nameWithOwner: value, source: "option" };
  }

  const ghResult = await ctx.run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    intent: "resolve repository via gh",
  });
  if (!ctx.dryRun && ghResult.ok) {
    const value = ghResult.stdout.trim();
    if (REPO_PATTERN.test(value)) return { nameWithOwner: value, source: "gh" };
  }

  const remoteResult = await ctx.run("git", ["remote", "get-url", "origin"], {
    intent: "resolve repository via git remote",
  });
  if (!ctx.dryRun && remoteResult.ok) {
    const parsed = parseGitRemoteUrl(remoteResult.stdout);
    if (parsed !== null) return { nameWithOwner: parsed, source: "git-remote" };
  }

  if (ctx.dryRun) {
    return { nameWithOwner: "<owner>/<repo>", source: "planned" };
  }
  fail("repo-unresolved", "cannot determine GitHub repo: pass --repo owner/name, or add a git remote named origin");
}

/** Run and throw a typed error on a non-zero exit. */
export async function mustRun(ctx, command, args, options = {}) {
  const result = await ctx.run(command, args, options);
  if (!result.ok) {
    throw new OrchestratorError("command-failed", `${formatCommand(command, args)} failed (exit ${result.code ?? "?"})`, {
      command,
      args: redactArgs(args),
      code: result.code,
      timedOut: result.timedOut === true,
      stderr: tail(result.stderr, 3000),
      stdout: tail(result.stdout, 1500),
    });
  }
  return result;
}

/** git with the force-push guard applied. */
export async function git(ctx, args, options = {}) {
  assertSafeGitArgs(args);
  return mustRun(ctx, "git", args, { mutating: true, ...options });
}

/** git that is allowed to fail (existence probes). */
export async function gitAllowFailure(ctx, args, options = {}) {
  assertSafeGitArgs(args);
  return ctx.run("git", args, { mutating: false, ...options });
}

export async function gitOutput(ctx, args, options = {}) {
  const result = await git(ctx, args, options);
  return result.stdout;
}

/** gh invocation that must succeed. */
export async function gh(ctx, args, options = {}) {
  return mustRun(ctx, "gh", args, { mutating: false, ...options });
}

/**
 * gh --json wrapper. In dry-run returns `{ planned: true, data: null }` so the
 * pipeline can print the plan without touching the network.
 */
export async function ghJson(ctx, args, { allowFailure = false, intent } = {}) {
  const result = await ctx.run("gh", args, { intent, mutating: false });
  if (result.dryRun) return { ok: true, planned: true, data: null, raw: "" };
  if (!result.ok) {
    if (allowFailure) return { ok: false, planned: false, data: null, raw: result.stderr, result };
    throw new OrchestratorError("gh-failed", `gh ${args.join(" ")} failed (exit ${result.code ?? "?"})`, {
      args: redactArgs(args),
      code: result.code,
      stderr: tail(result.stderr, 3000),
    });
  }
  try {
    return { ok: true, planned: false, data: JSON.parse(result.stdout), raw: result.stdout, result };
  } catch {
    throw new OrchestratorError("gh-invalid-json", `gh ${args.join(" ")} returned non-JSON output`, {
      args: redactArgs(args),
      stdout: tail(result.stdout, 2000),
    });
  }
}

/** `git status --short` for a directory (throws on failure; empty string when clean). */
export async function gitStatusShort(ctx, cwd) {
  const result = await git(ctx, ["-C", cwd, "status", "--short"], { intent: "worktree dirty check" });
  return result.stdout;
}

/**
 * CLI argument parsing and environment merging.
 *
 * Flags are deliberately boring: `--flag value`, `--flag=value`, booleans.
 * Anything unknown is a usage error (exit code 2), so typos never silently
 * turn a mutating run loose.
 */

import { OrchestratorError } from "./errors.mjs";

export const COMMANDS = ["status", "intake", "deliver", "verify", "watch"];

const FLAG_SPEC = {
  "--repo": "string",
  "--issue": "string",
  "--issue-json": "string",
  "--pr": "string",
  "--runner": "string",
  "--base": "string",
  "--worktree-root": "string",
  "--gates-file": "string",
  "--labels-file": "string",
  "--roles-dir": "string",
  "--interval": "string",
  "--max": "string",
  "--max-attempts": "string",
  "--mock-failures": "string",
  "--dry-run": "boolean",
  "--json": "boolean",
  "--once": "boolean",
  "--force": "boolean",
  "--keep-worktree": "boolean",
  "--offline": "boolean",
  "--strict": "boolean",
  "--review": "boolean",
  "--no-review": "boolean",
  "--verbose": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/** env var -> option key (only applied when the flag was not passed). */
const ENV_MAP = {
  MOCL_REPO: "repo",
  MOCL_RUNNER: "runner",
  MOCL_BASE_BRANCH: "base",
  MOCL_WORKTREE_ROOT: "worktreeRoot",
  MOCL_GATES_FILE: "gatesFile",
  MOCL_LABELS_FILE: "labelsFile",
  MOCL_ROLES_DIR: "rolesDir",
  MOCL_WATCH_INTERVAL: "interval",
  MOCL_MAX_ATTEMPTS: "maxAttempts",
  MOCL_OFFLINE: "offline",
  MOCL_DRY_RUN: "dryRun",
};

const BOOLEAN_ENV = new Set(["offline", "dryRun"]);

function camelCase(flagName) {
  if (flagName === "-h") return "help";
  return flagName.replace(/^--/, "").replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ command: string | null, options: Record<string, unknown>, errors: string[] }}
 */
export function parseArgv(argv) {
  const errors = [];
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    const kind = FLAG_SPEC[name];
    if (kind === undefined) {
      errors.push(`unknown option: ${name}`);
      continue;
    }
    if (kind === "boolean") {
      if (inlineValue !== undefined) {
        errors.push(`option ${name} does not take a value`);
        continue;
      }
      options[camelCase(name)] = true;
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        errors.push(`option ${name} requires a value`);
        continue;
      }
      value = next;
      index += 1;
    }
    options[camelCase(name)] = value;
  }

  const command = positionals[0] ?? null;
  if (command !== null && !COMMANDS.includes(command)) errors.push(`unknown command: ${command}`);
  if (positionals.length > 1) errors.push(`unexpected arguments: ${positionals.slice(1).join(" ")}`);

  return { command, options, errors };
}

/** Fill unset options from MOCL_* environment variables. */
export function applyEnv(options, env = process.env) {
  const merged = { ...options };
  for (const [envKey, optionKey] of Object.entries(ENV_MAP)) {
    const raw = env[envKey];
    if (raw === undefined || raw === "") continue;
    if (merged[optionKey] !== undefined) continue;
    merged[optionKey] = BOOLEAN_ENV.has(optionKey) ? raw === "1" || raw.toLowerCase() === "true" : raw;
  }
  return merged;
}

/** Resolve+validate `--runner` (cli flag > env > default `dsh`). */
export function resolveRunner(options, env = process.env) {
  const runner = options.runner ?? env.MOCL_RUNNER ?? "dsh";
  if (runner !== "dsh" && runner !== "mock") {
    throw new OrchestratorError("invalid-runner", `--runner must be "dsh" or "mock", got ${JSON.stringify(runner)}`);
  }
  return runner;
}

export const HELP_TEXT = `mocl-agent — GitHub issue → agent → 门禁 → PR → 评审 → 交付报告（零依赖）

用法:
  node orchestrator/cli.mjs <command> [options]

命令:
  status   列出带 agent:ready 的 issue 及其分支/PR/最近一次 run（只读）
  intake   读取 issue，生成 .agentspec/issues/<n>/BRIEF.md
  deliver  分支 + worktree + 角色 prompt + runner + 门禁 + commit/push/PR
  verify   跑本地门禁（可选 verifier/reviewer 角色评审），输出 PASS/FAIL 与证据
  watch    轮询 agent:ready issue 并按并发上限派发 deliver（--once 跑一轮）

全局选项:
  --repo <owner/name>     默认从 gh repo view 或 git remote 推断
  --dry-run               只打印计划，零副作用（不执行任何外部命令）
  --json                  机器可读输出
  --runner dsh|mock       默认 dsh（命令模板 dsh headless，可被 MOCL_AGENT_CMD 覆盖）
  --base <branch>         基线分支，默认 main
  --worktree-root <dir>   worktree 根目录，默认 .worktrees
  --issue-json <file>     离线 issue fixture（dry-run/测试用）
  --gates-file <file>     门禁清单（默认 orchestrator/gates.default.json）
  --labels-file <file>    标签真源（默认 .github/labels.yml；也可用 MOCL_LABELS_FILE）
                          缺文件/缺少必需标签 → exit 4，禁止回退到其他命名
  --roles-dir <dir>       角色 prompt 目录，默认 agents/roles
  --max-attempts <n>      每 issue 最多尝试次数，默认 2（超过打 status/blocked + agent:blocked）
  --once                  watch 只跑一圈（配合 --max 可用于 CI 冒烟）
  --keep-worktree         失败时保留 worktree/分支现场（默认清理以便重试）
  --offline               status/watch 无网络时降级为缓存/SKIP
  --review / --no-review  verify 是否调用 verifier/reviewer 角色评审
  --force                 忽略 agent:ready / 阻塞类标签检查
  --strict                离线降级时返回非零退出码
  -h, --help              帮助

退出码（与 docs/process/10 §2 对齐）:
  0 成功 / PASS
  1 门禁失败 / 校验 FAIL / 可重试的运行失败
  2 用法错误 / 仓库推断失败
  3 重试耗尽：issue 已打 status/blocked + agent:blocked，交人工
  4 环境不可用：gh / 网络 / labels 真源 / runner 不可用

示例:
  node orchestrator/cli.mjs deliver --issue 1 --dry-run --repo lakii2982/mocl
  node orchestrator/cli.mjs intake --issue 1 --dry-run --repo lakii2982/mocl
  node orchestrator/cli.mjs status --json --repo lakii2982/mocl
  MOCL_AGENT_CMD='dsh headless' node orchestrator/cli.mjs deliver --issue 1
`;

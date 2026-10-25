/**
 * claude-code 权限策略（施工 C5）：权限模式映射 + `canUseTool` 确定性代答（**2s 超时 fail-closed**）。
 *
 * 设计约束（docs/adapters/claude-code.md §7）：
 * - `canUseTool` 返回 `null` 或挂起会让工具**无限期阻塞**（SDK 原文："permission prompts have no
 *   park deadline"），因此本模块用 `Promise.race` 强制在 `timeoutMs` 内给出 allow/deny；
 * - 默认最小权限：`read-only` 只放行只读工具，其余一律 deny；
 * - 任何策略异常都按 deny 处理（绝不把异常抛给 SDK 造成挂起）。
 */
import type { PermissionProfile } from "../../abi/types.ts";
import { adapterError } from "./errors.ts";
import type { CanUseTool, CanUseToolContext, CanUseToolResult } from "./types.ts";

/** SDK `PermissionMode` 的 6 值中，适配器会主动使用的 5 个（`default` 只在显式模式下用）。 */
export const CLAUDE_PERMISSION_MODES = [
  "dontAsk",
  "acceptEdits",
  "auto",
  "plan",
  "bypassPermissions",
] as const;

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** ABI 三档 → SDK 权限模式（docs §7.1；不按名字透传）。 */
export function permissionModeFor(profile: PermissionProfile): ClaudePermissionMode {
  switch (profile) {
    case "read-only":
      return "dontAsk";
    case "safe-auto":
      return "acceptEdits";
    case "yolo":
      return "bypassPermissions";
  }
}

/** 始终禁用的产品工具（无人值守：不弹交互问答、不进入计划交互）。 */
export const BASE_DISALLOWED_TOOLS = ["AskUserQuestion", "ExitPlanMode"] as const;

/** 只读档额外禁用的写/执行工具（即使模型想调用也进不了上下文）。 */
export const READ_ONLY_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
] as const;

/** 只读档允许的工具白名单（配合 `dontAsk` 的"预批准"语义）。 */
export const READ_ONLY_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"] as const;

/** 安全自动档允许写，但拒绝执行与网络（执行需外部 worktree + 显式策略）。 */
export const SAFE_AUTO_DENIED_TOOLS = ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"] as const;

export function disallowedToolsFor(profile: PermissionProfile): readonly string[] {
  const base = [...BASE_DISALLOWED_TOOLS];
  if (profile === "read-only") return [...base, ...READ_ONLY_DISALLOWED_TOOLS];
  return base;
}

export function allowedToolsFor(profile: PermissionProfile): readonly string[] | undefined {
  return profile === "read-only" ? READ_ONLY_ALLOWED_TOOLS : undefined;
}

/** 工具 → ABI `permission.requested.risk` 分类（schema 枚举 read/write/execute/network/unknown）。 */
export function riskOf(toolName: string): "read" | "write" | "execute" | "network" | "unknown" {
  if (["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"].includes(toolName)) return "read";
  if (["Write", "Edit", "NotebookEdit", "MultiEdit"].includes(toolName)) return "write";
  if (["Bash", "BashOutput", "KillShell"].includes(toolName)) return "execute";
  if (["WebFetch", "WebSearch"].includes(toolName)) return "network";
  return "unknown";
}

export interface PermissionDecisionRecord {
  readonly toolName: string;
  readonly risk: "read" | "write" | "execute" | "network" | "unknown";
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly timedOut: boolean;
  readonly toolUseId?: string;
}

export interface PermissionPolicyOptions {
  readonly profile: PermissionProfile;
  /** fail-closed 超时（默认 2000ms；SDK 无内置 park 期限）。 */
  readonly timeoutMs?: number;
  /** 额外允许的工具（如用户显式扩展）；仍受 profile 的 deny 表约束。 */
  readonly allowedTools?: readonly string[];
  /** 每次决策回调（适配器用于产出 `permission.requested/resolved` 事件）。 */
  readonly onDecision?: (record: PermissionDecisionRecord) => void;
  /** 决策函数覆盖（测试注入慢/抛错策略以验证超时 fail-closed；生产不传）。 */
  readonly decideToolUse?: (toolName: string, context: CanUseToolContext) => PermissionDecisionRecord | Promise<PermissionDecisionRecord>;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/** 决策主体（不含超时包装）：纯函数，便于单测。 */
export function decideToolUse(options: PermissionPolicyOptions, toolName: string, context: CanUseToolContext): PermissionDecisionRecord {
  const risk = riskOf(toolName);
  const reasonBase = "unattended policy";
  const toolUseId = context.toolUseID;
  const deny = (reason: string): PermissionDecisionRecord => ({
    toolName,
    risk,
    decision: "deny",
    reason,
    timedOut: false,
    ...(toolUseId === undefined ? {} : { toolUseId }),
  });
  const allow = (): PermissionDecisionRecord => ({
    toolName,
    risk,
    decision: "allow",
    reason: `${reasonBase}: allowed by ${options.profile}`,
    timedOut: false,
    ...(toolUseId === undefined ? {} : { toolUseId }),
  });

  if (context.signal?.aborted === true) return deny("unattended policy: request aborted");
  if (context.blockedPath !== undefined && options.profile !== "yolo") {
    return deny(`unattended policy: blocked path ${context.blockedPath}`);
  }
  if (options.profile === "yolo") return allow();

  const extra = options.allowedTools ?? [];
  if (extra.includes(toolName)) return allow();

  if (options.profile === "read-only") {
    return (READ_ONLY_ALLOWED_TOOLS as readonly string[]).includes(toolName)
      ? allow()
      : deny(`unattended policy: ${toolName} not allowed in read-only profile`);
  }
  // safe-auto：允许读与写，拒绝执行/网络（需外部 worktree + 显式策略）
  if ((SAFE_AUTO_DENIED_TOOLS as readonly string[]).includes(toolName)) {
    return deny(`unattended policy: ${toolName} requires explicit execution approval`);
  }
  if (risk === "unknown") return deny(`unattended policy: unknown tool ${toolName}`);
  return allow();
}

/**
 * 生成 SDK `canUseTool` 回调：**永不返回 null、永不挂起**。
 * 决策在 `timeoutMs` 内 race；超时/异常 → deny（fail-closed）。
 */
export function createCanUseTool(options: PermissionPolicyOptions): CanUseTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (toolName: string, _input: Record<string, unknown>, context: CanUseToolContext): Promise<CanUseToolResult> => {
    let record: PermissionDecisionRecord;
    let timer: NodeJS.Timeout | undefined;
    try {
      const decide = options.decideToolUse ?? ((name, ctx) => decideToolUse(options, name, ctx));
      record = await Promise.race([
        Promise.resolve(decide(toolName, context)),
        new Promise<PermissionDecisionRecord>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              toolName,
              risk: riskOf(toolName),
              decision: "deny",
              reason: `unattended policy: decision timed out after ${timeoutMs}ms`,
              timedOut: true,
              ...(context.toolUseID === undefined ? {} : { toolUseId: context.toolUseID }),
            });
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (cause) {
      record = {
        toolName,
        risk: riskOf(toolName),
        decision: "deny",
        reason: `unattended policy: decision error ${cause instanceof Error ? cause.message : String(cause)}`,
        timedOut: false,
        ...(context.toolUseID === undefined ? {} : { toolUseId: context.toolUseID }),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    options.onDecision?.(record);
    if (record.decision === "allow") {
      return { behavior: "allow", ...(context.toolUseID === undefined ? {} : { toolUseID: context.toolUseID }) };
    }
    return {
      behavior: "deny",
      message: record.reason,
      ...(context.toolUseID === undefined ? {} : { toolUseID: context.toolUseID }),
    };
  };
}

/** 超时即失败（上层需要时用于把挂起归类为 `transport.timeout`）。 */
export function policyTimeoutError(profile: PermissionProfile): ReturnType<typeof adapterError> {
  return adapterError("transport.timeout", {
    message: `permission policy did not decide within budget (profile=${profile})`,
    details: { kind: "transport.timeout", phase: "canUseTool" },
  });
}

/* ------------------------------------------------------------------ env 白名单 */

const ENV_ALLOW_EXACT = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
]);

/** 认证相关前缀（值永不打印/不落日志；SDK 需要它们完成鉴权）。 */
const ENV_ALLOW_PREFIX = ["ANTHROPIC_", "CLAUDE_"];

/** 非白名单前缀一律剔除（防泄漏父进程的云凭据/GitHub token 等）。 */
const SECRET_PATTERN = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|PRIVATE_KEY|AWS_|AZURE_|GCP_|GITHUB_|GITLAB_)/i;

/**
 * 构造传给 CLI 子进程的环境变量白名单：
 * - 只允许系统基础变量 + `ANTHROPIC_*`/`CLAUDE_*`（鉴权面）；
 * - 其他变量（尤其 `*_TOKEN`、`*_SECRET`、`*_PASSWORD`、AWS_、GITHUB_ 前缀）一律不传；
 * - 该函数不打印任何值（测试只断言键集合）。
 */
export function sanitizedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const exact = ENV_ALLOW_EXACT.has(key);
    const prefixed = ENV_ALLOW_PREFIX.some((prefix) => key.startsWith(prefix));
    if (!exact && !prefixed) continue;
    if (SECRET_PATTERN.test(key) && !prefixed) continue;
    out[key] = value;
  }
  return out;
}

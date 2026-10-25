/**
 * claude-code 适配器的失败分类（施工 C5）：一律落到 `src/abi/errors.ts` 的 46 个 ABI 码，
 * 分类表见 `../../../../docs/adapters/claude-code.md` §10.1。
 *
 * 与 codex 适配器同构（L1 不依赖 L2，不 import broker/errors）：本类携带 ABI 码 + 分类 +
 * 可重试性 + 结构化 details，上层可无损投影为 `ErrorRef`。
 */
import {
  ERROR_CATEGORY,
  RETRYABLE,
  type ErrorCategory,
  type ErrorCode,
  type Retryability,
} from "../../abi/errors.ts";
import type { ErrorRef } from "../../abi/types.ts";

export interface AdapterErrorOptions {
  readonly message?: string;
  readonly backendCode?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: string;
  readonly retryAfterMs?: number;
}

export class AdapterError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: Retryability;
  readonly backendCode?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly causeText?: string;
  readonly retryAfterMs?: number;

  constructor(code: ErrorCode, options: AdapterErrorOptions = {}) {
    super(options.message ?? code);
    this.name = "AdapterError";
    this.code = code;
    this.category = ERROR_CATEGORY[code];
    this.retryable = RETRYABLE[code];
    this.backendCode = options.backendCode;
    this.details = options.details;
    this.causeText = options.cause;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function adapterError(code: ErrorCode, options?: AdapterErrorOptions): AdapterError {
  return new AdapterError(code, options);
}

export function isAdapterError(value: unknown): value is AdapterError {
  return value instanceof AdapterError;
}

/** 把任意 thrown 值规整为 `AdapterError`（分类由 message/status 猜，未知落 internal.unexpected）。 */
export function asAdapterError(value: unknown): AdapterError {
  if (value instanceof AdapterError) return value;
  const message = value instanceof Error ? value.message : String(value);
  const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const status = typeof record?.["status"] === "number" ? record["status"] : undefined;
  if (status === 401 || /authentication_failed|invalid api key|unauthori[sz]ed/i.test(message)) {
    return adapterError("auth.credential-rejected", { message });
  }
  if (status === 429 || /rate[ _-]?limit|overloaded|too many requests/i.test(message)) {
    return adapterError("quota.rate-limited", { message });
  }
  if (/ENOENT|not found|executable/i.test(message) && /claude|spawn/i.test(message)) {
    return adapterError("process.spawn-failed", { message });
  }
  return adapterError("internal.unexpected", { message });
}

/** `SDKAssistantMessageError`（11 值）→ ABI 码（docs §10.1 B 表）。 */
const ASSISTANT_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  authentication_failed: "auth.credential-rejected",
  oauth_org_not_allowed: "auth.credential-rejected",
  account_on_hold: "quota.usage-exhausted",
  billing_error: "quota.usage-exhausted",
  rate_limit: "quota.rate-limited",
  overloaded: "quota.rate-limited",
  invalid_request: "protocol.invalid-params",
  model_not_found: "auth.provider-mismatch",
  server_error: "backend.internal-error",
  unknown: "backend.internal-error",
  max_output_tokens: "backend.internal-error",
};

export function mapAssistantError(name: unknown, message: string): AdapterError {
  const key = typeof name === "string" ? name : "unknown";
  const code = ASSISTANT_ERROR_MAP[key] ?? "backend.internal-error";
  return adapterError(code, {
    message,
    backendCode: key,
    details: { kind: code, assistantError: key },
  });
}

/** `SDKResultError.subtype` → ABI 码（非成功终态一律 `turn.failed`，见 C5 契约）。 */
export function mapResultError(subtype: string, errors: readonly string[] | undefined, assistantError?: AdapterError): AdapterError {
  const message = errors !== undefined && errors.length > 0 ? errors.join("; ") : subtype;
  switch (subtype) {
    case "error_max_turns":
      return adapterError("limit.budget-exceeded", {
        message: `max turns reached: ${message}`,
        backendCode: subtype,
        details: { kind: "limit.budget-exceeded", reason: "max-turns" },
      });
    case "error_max_budget_usd":
      return adapterError("limit.budget-exceeded", {
        message: `budget exhausted: ${message}`,
        backendCode: subtype,
        details: { kind: "limit.budget-exceeded", reason: "max-budget-usd" },
      });
    case "error_max_structured_output_retries":
      return adapterError("protocol.invalid-params", {
        message: `structured output retries exhausted: ${message}`,
        backendCode: subtype,
      });
    case "error_during_execution":
      return assistantError ?? adapterError("backend.internal-error", { message, backendCode: subtype });
    default:
      return adapterError("backend.internal-error", { message, backendCode: subtype });
  }
}

/** 命令/shell 类被拒绝的 tool_result 不算失败终态，但拒绝本身要可见。 */
export function permissionDenied(toolName: string, reason: string | undefined): AdapterError {
  return adapterError("policy.permission-denied", {
    message: reason ?? `tool denied by unattended policy: ${toolName}`,
    details: { kind: "policy.permission-denied", tool: toolName },
  });
}

/** 等首帧（init）超时 / 查询挂起 → `transport.timeout`。 */
export function mapInitTimeout(timeoutMs: number): AdapterError {
  return adapterError("transport.timeout", {
    message: `claude-code init did not arrive within ${timeoutMs}ms`,
    details: { kind: "transport.timeout", phase: "init", timeoutMs },
  });
}

/** 子进程退出/关闭（worker_shutting_down、query 迭代结束但无 result）。 */
export function mapProcessExit(reason: string): AdapterError {
  return adapterError("process.crashed", {
    message: reason,
    details: { kind: "process.crashed" },
  });
}

const USER_MESSAGES: Partial<Record<ErrorCode, string>> = {
  "transport.timeout": "后端响应超时，正在核对会话状态",
  "transport.disconnected": "与后端的连接中断，正在恢复会话",
  "process.spawn-failed": "后端可执行文件无法启动",
  "process.crashed": "后端进程崩溃，正在恢复会话",
  "process.killed": "后端进程已终止",
  "protocol.invalid-params": "请求参数不被后端接受（内部错误）",
  "protocol.version-mismatch": "版本不匹配，已阻止启动",
  "protocol.unexpected-response": "收到意外响应，已忽略并记录",
  "auth.credential-rejected": "后端拒绝凭据，请检查配置",
  "auth.provider-mismatch": "当前模型对后端不可用，请更换模型",
  "auth.missing-credential": "后端未配置凭据，请先登录对应产品",
  "quota.rate-limited": "后端限流，正在退避重试",
  "quota.usage-exhausted": "后端额度已耗尽，请补充额度",
  "quota.context-overflow": "上下文超出窗口，已尝试压缩/重开",
  "limit.budget-exceeded": "预算已用尽，任务已中止",
  "policy.permission-denied": "操作被权限策略拒绝",
  "policy.sandbox-violation": "操作越过沙箱/目录边界，已阻止",
  "session.not-found": "会话不存在或已过期",
  "session.invalidated": "会话在后端已失效，无法续接",
  "session.resume-failed": "会话续接失败，正在尝试替代方案",
  "capability.missing": "后端缺少必需能力",
  "backend.internal-error": "后端返回内部错误，已记录",
  "internal.unexpected": "兼容层内部错误，请联系维护者",
};

/** `AdapterError` → ABI `ErrorRef`（事件 payload 用）。 */
export function toErrorRef(error: AdapterError): ErrorRef {
  return {
    code: error.code,
    category: error.category,
    message: error.message,
    retryable: error.retryable,
    userMessage: USER_MESSAGES[error.code] ?? "操作失败，请稍后重试",
    severity: error.code.startsWith("security.") ? "fatal" : "error",
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
}

/**
 * codex 适配器的失败分类（施工 C4）：一律落到 `src/abi/errors.ts` 的 46 个 ABI 码，
 * 分类表见 `../../../../docs/adapters/codex.md` §10.1。
 *
 * 为什么不用 `src/broker/errors.ts` 的 `MoclError`：L1 适配器不应依赖 L2（分层约束见
 * `docs/architecture/01-layers.md`）。本类只携带 ABI 码 + 分类 + 可重试性 + 结构化 details，
 * L2/L4 可无损投影为 `ErrorRef`。
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

/** 适配器层错误：`code` 必须是 ABI §8.2 的码。 */
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

/** JSON-RPC 错误体（`{code,message,data}`）里可能携带的 HTTP 状态。 */
function httpStatusOf(error: { readonly code: number; readonly data?: unknown }): number | undefined {
  const data = error.data;
  if (data === null || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ["httpStatusCode", "httpStatus", "status", "statusCode"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  const nested = record["codexErrorInfo"];
  if (nested !== null && typeof nested === "object") {
    const inner = (nested as Record<string, unknown>)["httpStatusCode"];
    if (typeof inner === "number" && Number.isInteger(inner)) return inner;
  }
  return undefined;
}

/**
 * 把 app-server 的 JSON-RPC 错误映射成 ABI 码。
 *
 * 基线实测（设计 §10.1）：codex 对语义错误也用 `-32600`，且**未知方法也是 `-32600`**，
 * 因此匹配必须 `code + message` 双条件；`-32601 not supported yet` 是"方法未实现"。
 */
export function mapJsonRpcError(
  method: string,
  error: { readonly code: number; readonly message: string; readonly data?: unknown },
): AdapterError {
  const message = error.message;
  const lower = message.toLowerCase();
  const status = httpStatusOf(error);

  if (status === 401 || /unauthori[sz]ed|invalid api key|credential/.test(lower)) {
    return adapterError("auth.credential-rejected", { message, backendCode: String(error.code) });
  }
  if (status === 429 || /rate[ _-]?limit|too many requests/.test(lower)) {
    return adapterError("quota.rate-limited", { message, backendCode: String(error.code) });
  }
  if (error.code === -32601 || /not supported yet/.test(lower)) {
    return adapterError("capability.unsupported-method", { message, backendCode: String(error.code) });
  }
  if (error.code === -32600) {
    if (/unknown variant/.test(lower)) {
      return adapterError("protocol.unknown-method", { message, backendCode: String(error.code) });
    }
    if (/no active turn/.test(lower)) {
      // 不是失败：调用方按幂等成功处理（设计 §10.1）。保留为专用码便于识别。
      return adapterError("session.conflict", { message, backendCode: "no-active-turn" });
    }
    if (/no rollout found|not materialized yet/.test(lower)) {
      const code: ErrorCode = method.startsWith("thread/resume") ? "session.resume-failed" : "session.invalidated";
      return adapterError(code, { message, backendCode: "not-materialized" });
    }
    if (/unknown thread|thread not found|no thread/.test(lower)) {
      return adapterError("session.not-found", { message, backendCode: String(error.code) });
    }
    return adapterError("protocol.invalid-params", { message, backendCode: String(error.code) });
  }
  if (error.code === -32602) {
    return adapterError("protocol.invalid-params", { message, backendCode: String(error.code) });
  }
  if (error.code === -32603) {
    return adapterError("backend.internal-error", { message, backendCode: String(error.code) });
  }
  return adapterError("backend.internal-error", {
    message,
    backendCode: String(error.code),
    details: { method },
  });
}

/** `TurnError.codexErrorInfo` 逐值映射（设计 §10.1 表）。 */
const TURN_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  contextWindowExceeded: "quota.context-overflow",
  sessionBudgetExceeded: "limit.budget-exceeded",
  usageLimitExceeded: "quota.usage-exhausted",
  rateLimitExceeded: "quota.rate-limited",
  serverOverloaded: "quota.rate-limited",
  cyberPolicy: "policy.permission-denied",
  misalignmentPolicyViolation: "policy.permission-denied",
  unauthorized: "auth.credential-rejected",
  badRequest: "protocol.invalid-params",
  threadRollbackFailed: "session.resume-failed",
  sandboxError: "policy.sandbox-violation",
  internalServerError: "backend.internal-error",
  other: "backend.internal-error",
};

/** 从 `TurnError.codexErrorInfo`（字符串或 `{variant:{…}}`）提取分类。 */
export function codexErrorInfoName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1) return keys[0];
  }
  return undefined;
}

export function mapTurnError(codexErrorInfo: unknown, message: string): AdapterError {
  const name = codexErrorInfoName(codexErrorInfo);
  const code = name === undefined ? "backend.internal-error" : (TURN_ERROR_MAP[name] ?? "backend.internal-error");
  return adapterError(code, {
    message,
    ...(name === undefined ? {} : { backendCode: name }),
    details: { kind: code, ...(name === undefined ? {} : { codexErrorInfo: name }) },
  });
}

/** spawn 失败（二进制缺失/不可执行）→ `process.spawn-failed`。 */
export function mapSpawnError(cause: unknown): AdapterError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return adapterError("process.spawn-failed", { message, cause: message });
}

/** 子进程在请求未完成时退出 → `process.crashed`（主动 kill 则由调用方改判）。 */
export function mapExitError(exitCode: number | null, signal: string | null): AdapterError {
  return adapterError("process.crashed", {
    message: `app-server exited (code=${String(exitCode)}, signal=${String(signal)})`,
    details: { kind: "process.crashed", exitCode, signal },
  });
}

/** 单请求超时 → `transport.timeout`（ABI §4「超时是传输层义务」）。 */
export function mapTimeout(method: string, timeoutMs: number): AdapterError {
  return adapterError("transport.timeout", {
    message: `${method} timed out after ${timeoutMs}ms`,
    details: { kind: "transport.timeout", method, timeoutMs },
  });
}

/** 适配器会产出的错误码的用户文案（ABI §8.2 口径；≤60 字，errorRef.userMessage 上限 120）。 */
const USER_MESSAGES: Partial<Record<ErrorCode, string>> = {
  "transport.connect-failed": "后端进程启动失败，正在重试或已切换备用通道",
  "transport.disconnected": "与后端的连接中断，正在恢复会话",
  "transport.timeout": "后端响应超时，正在核对会话状态",
  "transport.frame-invalid": "收到无法解析的后端消息，已隔离",
  "protocol.unknown-method": "后端不支持该操作，已切换降级路径",
  "protocol.invalid-params": "请求参数不被后端接受（内部错误）",
  "protocol.version-mismatch": "版本不匹配，已阻止启动",
  "protocol.bad-frame": "协议异常，正在重建连接",
  "protocol.unexpected-response": "收到意外响应，已忽略并记录",
  "process.spawn-failed": "后端可执行文件无法启动",
  "process.crashed": "后端进程崩溃，正在恢复会话",
  "process.killed": "后端进程已终止",
  "capability.missing": "后端缺少必需能力",
  "capability.unsupported-method": "后端不支持该方法，请改用降级路径",
  "session.not-found": "会话不存在或已过期",
  "session.invalidated": "会话在后端已失效，无法续接",
  "session.conflict": "会话状态冲突，请刷新后重试",
  "session.resume-failed": "会话续接失败，正在尝试替代方案",
  "policy.permission-denied": "操作被权限策略拒绝",
  "policy.sandbox-violation": "操作越过沙箱/目录边界，已阻止",
  "limit.budget-exceeded": "预算已用尽，任务已中止",
  "quota.rate-limited": "后端限流，正在退避重试",
  "quota.usage-exhausted": "后端额度已耗尽，请补充额度",
  "quota.context-overflow": "上下文超出窗口，已尝试压缩/重开",
  "auth.credential-rejected": "后端拒绝凭据，请检查配置",
  "auth.missing-credential": "后端未配置凭据，请先登录对应产品",
  "backend.internal-error": "后端返回内部错误，已记录",
  "internal.unexpected": "兼容层内部错误，请联系维护者",
};

/** `AdapterError` → ABI `ErrorRef`（事件 payload 用；details 不进 errorRef schema）。 */
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

/** 把任意 thrown 值规整为 `AdapterError`（未知异常落 `internal.unexpected`）。 */
export function asAdapterError(value: unknown): AdapterError {
  if (value instanceof AdapterError) return value;
  const message = value instanceof Error ? value.message : String(value);
  return adapterError("internal.unexpected", { message });
}

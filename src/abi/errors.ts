/**
 * ABI v0 错误码与可重试性（真源：docs/abi/abi-v0.md §8.2 错误码总表，46 码 / 12 类）。
 *
 * 命名与语义不得在施工期改动：新增错误码必须先在 ABI 真源走 §13 MINOR 流程。
 * `retryable` 的 wire 取值：`no` / `once` / `backoff` / `after-recovery`（见 schema/error.json）。
 */
export const ERROR_CATEGORIES = [
  "transport",
  "auth",
  "quota",
  "protocol",
  "process",
  "capability",
  "session",
  "policy",
  "storage",
  "limit",
  "security",
  "internal",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const RETRYABILITIES = ["no", "once", "backoff", "after-recovery"] as const;

export type Retryability = (typeof RETRYABILITIES)[number];

export const ERROR_CODES = [
  "transport.connect-failed",
  "transport.disconnected",
  "transport.timeout",
  "transport.frame-invalid",
  "transport.frame-too-large",
  "transport.backpressure",
  "auth.missing-credential",
  "auth.credential-expired",
  "auth.credential-rejected",
  "auth.login-required",
  "auth.provider-mismatch",
  "quota.rate-limited",
  "quota.usage-exhausted",
  "quota.context-overflow",
  "protocol.unknown-method",
  "protocol.invalid-params",
  "protocol.version-mismatch",
  "protocol.bad-frame",
  "protocol.unexpected-response",
  "process.spawn-failed",
  "process.crashed",
  "process.hung",
  "process.killed",
  "capability.missing",
  "capability.unsupported-method",
  "session.not-found",
  "session.invalidated",
  "session.conflict",
  "session.locked",
  "session.resume-failed",
  "session.fork-failed",
  "session.mapping-corrupt",
  "session.expired",
  "policy.permission-denied",
  "policy.sandbox-violation",
  "policy.escalation-required",
  "storage.disk-full",
  "storage.write-failed",
  "storage.corrupt",
  "limit.nesting-exceeded",
  "limit.concurrency-exceeded",
  "limit.budget-exceeded",
  "limit.turn-timeout",
  "security.credential-leak-suspected",
  "backend.internal-error",
  "internal.unexpected",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 错误码 → 分类（ABI §8.1 分类树；`backend.internal-error` 是唯一前缀≠分类的例外）。 */
export const ERROR_CATEGORY: Readonly<Record<ErrorCode, ErrorCategory>> = {
  "transport.connect-failed": "transport",
  "transport.disconnected": "transport",
  "transport.timeout": "transport",
  "transport.frame-invalid": "transport",
  "transport.frame-too-large": "transport",
  "transport.backpressure": "transport",
  "auth.missing-credential": "auth",
  "auth.credential-expired": "auth",
  "auth.credential-rejected": "auth",
  "auth.login-required": "auth",
  "auth.provider-mismatch": "auth",
  "quota.rate-limited": "quota",
  "quota.usage-exhausted": "quota",
  "quota.context-overflow": "quota",
  "protocol.unknown-method": "protocol",
  "protocol.invalid-params": "protocol",
  "protocol.version-mismatch": "protocol",
  "protocol.bad-frame": "protocol",
  "protocol.unexpected-response": "protocol",
  "process.spawn-failed": "process",
  "process.crashed": "process",
  "process.hung": "process",
  "process.killed": "process",
  "capability.missing": "capability",
  "capability.unsupported-method": "capability",
  "session.not-found": "session",
  "session.invalidated": "session",
  "session.conflict": "session",
  "session.locked": "session",
  "session.resume-failed": "session",
  "session.fork-failed": "session",
  "session.mapping-corrupt": "session",
  "session.expired": "session",
  "policy.permission-denied": "policy",
  "policy.sandbox-violation": "policy",
  "policy.escalation-required": "policy",
  "storage.disk-full": "storage",
  "storage.write-failed": "storage",
  "storage.corrupt": "storage",
  "limit.nesting-exceeded": "limit",
  "limit.concurrency-exceeded": "limit",
  "limit.budget-exceeded": "limit",
  "limit.turn-timeout": "limit",
  "security.credential-leak-suspected": "security",
  "backend.internal-error": "internal",
  "internal.unexpected": "internal",
};

/**
 * 错误码 → 可重试性（逐行取自 ABI §8.2 的「可重试性」列，映射到 wire 四值）：
 * - 否 → `no`；恢复重试/恢复重连 → `after-recovery`；退避 → `backoff`；有条件/≤N 次 → `once`。
 * 注意：`retryable !== "no"` 只是「允许尝试」，写操作仍须先对账（ABI §9）。
 */
export const RETRYABLE: Readonly<Record<ErrorCode, Retryability>> = {
  "transport.connect-failed": "backoff",
  "transport.disconnected": "after-recovery",
  "transport.timeout": "once",
  "transport.frame-invalid": "no",
  "transport.frame-too-large": "no",
  "transport.backpressure": "backoff",
  "auth.missing-credential": "no",
  "auth.credential-expired": "no",
  "auth.credential-rejected": "no",
  "auth.login-required": "no",
  "auth.provider-mismatch": "no",
  "quota.rate-limited": "backoff",
  "quota.usage-exhausted": "no",
  "quota.context-overflow": "no",
  "protocol.unknown-method": "no",
  "protocol.invalid-params": "no",
  "protocol.version-mismatch": "no",
  "protocol.bad-frame": "after-recovery",
  "protocol.unexpected-response": "once",
  "process.spawn-failed": "backoff",
  "process.crashed": "after-recovery",
  "process.hung": "after-recovery",
  "process.killed": "no",
  "capability.missing": "no",
  "capability.unsupported-method": "no",
  "session.not-found": "no",
  "session.invalidated": "no",
  "session.conflict": "no",
  "session.locked": "once",
  "session.resume-failed": "after-recovery",
  "session.fork-failed": "no",
  "session.mapping-corrupt": "no",
  "session.expired": "no",
  "policy.permission-denied": "no",
  "policy.sandbox-violation": "no",
  "policy.escalation-required": "no",
  "storage.disk-full": "backoff",
  "storage.write-failed": "backoff",
  "storage.corrupt": "no",
  "limit.nesting-exceeded": "no",
  "limit.concurrency-exceeded": "backoff",
  "limit.budget-exceeded": "no",
  "limit.turn-timeout": "once",
  "security.credential-leak-suspected": "no",
  "backend.internal-error": "once",
  "internal.unexpected": "no",
};

export const ERROR_CODE_SET: ReadonlySet<ErrorCode> = new Set(ERROR_CODES);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value as ErrorCode);
}

/** 是否允许重试（`no` 为唯一不可重试值）；写操作仍须按 ABI §9 先对账。 */
export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE[code] !== "no";
}

export function retryabilityOf(code: ErrorCode): Retryability {
  return RETRYABLE[code];
}

export function categoryOf(code: ErrorCode): ErrorCategory {
  return ERROR_CATEGORY[code];
}

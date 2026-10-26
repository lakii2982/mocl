/**
 * Broker 层的错误对象构造（ABI §8 唯一命名真源；不另造错误码）。
 *
 * `MoclError` 是控制面抛出的唯一错误类型：携带 `code/category/retryable/userMessage/severity`，
 * 可直接投影为 ABI `ErrorRef`（`toErrorRef()`）。上层（L4）只消费 `userMessage`。
 */
import { ERROR_CATEGORY, RETRYABLE, type ErrorCategory, type ErrorCode, type Retryability } from "../abi/errors.ts";
import type { ErrorRef, ErrorSeverity } from "../abi/types.ts";

/** 用户可见文案（≤60 字；ABI §8.2 口径，按需补到实际使用的码）。 */
const USER_MESSAGES: Partial<Record<ErrorCode, string>> = {
  "session.not-found": "会话不存在或已过期",
  "session.conflict": "会话状态冲突，请刷新后重试",
  "session.locked": "会话正忙，请稍后重试",
  "session.invalidated": "会话在后端已失效，无法续接",
  "session.resume-failed": "会话续接失败，正在尝试替代方案",
  "session.mapping-corrupt": "会话映射损坏，需人工介入",
  "session.expired": "会话已过期回收",
  "capability.missing": "后端缺少必需能力",
  "capability.unsupported-method": "后端不支持该方法，请改用降级路径",
  "limit.concurrency-exceeded": "并发已达上限，任务已排队",
  "limit.nesting-exceeded": "子代理嵌套超过上限",
  "protocol.invalid-params": "请求参数不被接受（内部错误）",
  "internal.unexpected": "兼容层内部错误，请联系维护者",
  "storage.corrupt": "本地状态文件损坏，正在修复",
  "storage.write-failed": "本地状态写入失败，已降级只读",
};

export interface MoclErrorOptions {
  readonly message?: string;
  readonly severity?: ErrorSeverity;
  readonly retryAfterMs?: number;
  readonly details?: ErrorRef["details"];
  readonly cause?: string;
  readonly traceId?: string;
  readonly backendCode?: string;
}

/** Broker 内部统一错误；`code` 必须来自 ABI §8.2（46 码）。 */
export class MoclError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: Retryability;
  readonly userMessage: string;
  readonly severity: ErrorSeverity;
  readonly retryAfterMs?: number;
  readonly details?: ErrorRef["details"];
  readonly causeText?: string;
  readonly traceId?: string;
  readonly backendCode?: string;

  constructor(code: ErrorCode, options: MoclErrorOptions = {}) {
    super(options.message ?? code);
    this.name = "MoclError";
    this.code = code;
    this.category = ERROR_CATEGORY[code];
    this.retryable = RETRYABLE[code];
    this.userMessage = USER_MESSAGES[code] ?? "操作失败，请稍后重试";
    this.severity = options.severity ?? (code.startsWith("security.") ? "fatal" : "error");
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
    this.causeText = options.cause;
    this.traceId = options.traceId;
    this.backendCode = options.backendCode;
  }

  /** 投影为 ABI `ErrorRef`（事件/响应使用）。 */
  toErrorRef(extra: { sessionId?: string; turnId?: string } = {}): ErrorRef {
    // 宿主（dsh-tools）要求工具返回值是 lossless JSON：undefined 字段会把整个
    // ErrorRef 判成非法输出（ToolOutputError: value is not lossless JSON），
    // 因此可选字段必须整键省略，不能显式赋 undefined。
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      userMessage: this.userMessage,
      severity: this.severity,
      sessionId: extra.sessionId ?? null,
      turnId: extra.turnId ?? null,
      details:
        this.details ??
        (this.backendCode === undefined
          ? { kind: this.code }
          : { kind: this.code, backendCode: this.backendCode }),
      ...(this.traceId === undefined ? {} : { traceId: this.traceId }),
      ...(this.causeText === undefined ? {} : { cause: this.causeText }),
    };
  }
}

/** 便捷构造函数（保持调用点短）。 */
export function moclError(code: ErrorCode, options?: MoclErrorOptions): MoclError {
  return new MoclError(code, options);
}

export function isMoclError(value: unknown): value is MoclError {
  return value instanceof MoclError;
}

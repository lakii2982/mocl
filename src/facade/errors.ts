/**
 * 门面错误映射（C8）：一切对外错误统一为 ABI `ErrorRef`。
 *
 * - 已经是 `MoclError`（Broker/适配器抛出的 ABI 错误）→ 原样透传，不二次包装；
 * - 其他异常（编程错误、宿主异常）→ `internal.unexpected`，保留 cause 文本；
 * - 配置错误（`ConfigError`）→ `protocol.invalid-params`（启动期即失败，不允许半可用）。
 */
import type { ErrorRef } from "../abi/types.ts";
import { ConfigError } from "./config.ts";
import { MoclError, moclError } from "../broker/errors.ts";

export { MoclError, moclError };

/** 任意异常 → ABI `ErrorRef`（不打印凭据；`cause` 仅保留 message）。 */
export function toErrorRef(error: unknown, extra: { sessionId?: string; turnId?: string } = {}): ErrorRef {
  if (error instanceof MoclError) return error.toErrorRef(extra);
  if (error instanceof ConfigError) {
    return moclError("protocol.invalid-params", {
      message: error.message,
      details: { kind: "protocol.invalid-params", hint: error.issues.join("; ") },
    }).toErrorRef(extra);
  }
  const message = error instanceof Error ? error.message : String(error);
  return moclError("internal.unexpected", { message, cause: message }).toErrorRef(extra);
}

/** 把任意异常规整为 `MoclError`（门面内部 throw 用）。 */
export function asMoclError(error: unknown): MoclError {
  if (error instanceof MoclError) return error;
  if (error instanceof ConfigError) {
    return moclError("protocol.invalid-params", { message: error.message, details: { kind: "protocol.invalid-params" } });
  }
  const message = error instanceof Error ? error.message : String(error);
  return moclError("internal.unexpected", { message, cause: message });
}

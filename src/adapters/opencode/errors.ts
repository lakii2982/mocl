/**
 * opencode 原生错误 → ABI 错误码映射（docs/adapters/opencode.md §10.2；错误码真源 = src/abi/errors.ts）。
 *
 * 输入来源三类：
 * 1) v2 HTTP：HTTP 状态码 + `_tag`/provider 错误体（`{"_tag":"UnauthorizedError"}`、`provider.auth` 401 `api_key_expired`）；
 * 2) SSE/JSONL：`{"type":"error","error":{type,message,status,response.body}}`；
 * 3) ACP JSON-RPC：`-32000 Authentication required`、`-32601`、`-32602`、`-32603`。
 *
 * 纪律：错误消息里**不得**携带 Authorization / password / token（只允许状态码、错误类型、后端 code）。
 */
import { moclError, MoclError, type MoclErrorOptions } from "../../broker/errors.ts";
import type { ErrorCode } from "../../abi/errors.ts";

/** 从错误体里尽量安全地提取“后端 code”（不回显 message 里的敏感内容）。 */
function extractBackendCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const direct = record["code"];
  if (typeof direct === "string") return direct;
  const nested = record["error"];
  if (nested !== null && typeof nested === "object") {
    const code = (nested as Record<string, unknown>)["code"];
    if (typeof code === "string") return code;
  }
  const tag = record["_tag"];
  if (typeof tag === "string") return tag;
  const type = record["type"];
  if (typeof type === "string") return type;
  return undefined;
}

/** 从错误体里提取 provider 错误类型（`provider.auth` 等），只用于分级，不作为外显文案。 */
function extractErrorType(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const direct = record["type"];
  if (typeof direct === "string") return direct;
  const nested = record["error"];
  if (nested !== null && typeof nested === "object") {
    const type = (nested as Record<string, unknown>)["type"];
    if (typeof type === "string") return type;
  }
  return undefined;
}

function extractStatus(body: unknown): number | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const status = record["status"];
  if (typeof status === "number") return status;
  const nested = record["error"];
  if (nested !== null && typeof nested === "object") {
    const nestedStatus = (nested as Record<string, unknown>)["status"];
    if (typeof nestedStatus === "number") return nestedStatus;
  }
  return undefined;
}

/** 错误体是否表示“付费 key 过期”（`api_key_expired`）——D-019 的降级触发条件。 */
export function isApiKeyExpired(body: unknown): boolean {
  const text = safeStringify(body);
  if (text.includes("api_key_expired")) return true;
  if (extractStatus(body) === 401 && extractErrorType(body) === "provider.auth") return true;
  return false;
}

/** 是否属于“凭据类失败”（用于降级/不重试判定；不用于把 404 等误判为 auth）。 */
export function isAuthFailure(body: unknown): boolean {
  if (isApiKeyExpired(body)) return true;
  const type = extractErrorType(body);
  if (type === "provider.auth") return true;
  const tag = extractBackendCode(body);
  return tag === "UnauthorizedError";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function baseOptions(body: unknown): MoclErrorOptions {
  const backendCode = extractBackendCode(body);
  return {
    message: backendCode === undefined ? "opencode backend error" : `opencode backend error (${backendCode})`,
    ...(backendCode === undefined ? {} : { backendCode }),
  };
}

/**
 * v2 HTTP 响应 → MoclError（§10.2）。
 *
 * @param status HTTP 状态码
 * @param body 解析后的 JSON（解析失败时传 undefined）
 * @param context 场景：sessionScoped 时 404 归 `session.not-found`，否则 `transport.connect-failed`
 */
export function mapHttpError(
  status: number,
  body: unknown,
  context: { readonly sessionScoped?: boolean; readonly operation?: string } = {},
): MoclError {
  const options = baseOptions(body);
  const type = extractErrorType(body);
  const text = safeStringify(body);

  if (status === 401) {
    if (isApiKeyExpired(body)) {
      return moclError("auth.credential-expired", {
        ...options,
        message: `opencode provider key expired (401 ${options.backendCode ?? "auth"})`,
        details: { kind: "auth.credential-expired", backendCode: options.backendCode ?? "api_key_expired" },
      });
    }
    if (isAuthFailure(body) || text.includes("UnauthorizedError")) {
      return moclError("auth.credential-rejected", {
        ...options,
        message: `opencode server rejected credentials (401 ${options.backendCode ?? "auth"})`,
      });
    }
    return moclError("auth.missing-credential", { ...options, message: "opencode authentication required (401)" });
  }
  if (status === 403) {
    return moclError("auth.credential-rejected", { ...options, message: "opencode rejected credentials (403)" });
  }
  if (status === 404) {
    return moclError(context.sessionScoped === true ? "session.not-found" : "transport.connect-failed", {
      ...options,
      message: `opencode resource not found (404${context.operation === undefined ? "" : ` ${context.operation}`})`,
    });
  }
  if (status === 429) {
    return moclError("quota.rate-limited", { ...options, message: "opencode rate limited (429)" });
  }
  if (status === 400 || status === 422) {
    if (
      text.includes("model_not_available_for_integrator") ||
      text.includes("model_not_supported") ||
      type === "provider.invalid-request"
    ) {
      return moclError("auth.provider-mismatch", {
        ...options,
        message: `opencode model not available (${status} ${options.backendCode ?? "provider.invalid-request"})`,
      });
    }
    return moclError("protocol.invalid-params", { ...options, message: `opencode rejected params (${status})` });
  }
  if (status >= 500) {
    return moclError("backend.internal-error", { ...options, message: `opencode server error (${status})` });
  }
  return moclError("protocol.unexpected-response", { ...options, message: `unexpected opencode status (${status})` });
}

/** JSON-RPC error（ACP）→ MoclError。 */
export function mapJsonRpcError(error: {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}): MoclError {
  const backendCode = `jsonrpc.${error.code}`;
  const body = { code: backendCode, message: error.message };
  switch (error.code) {
    case -32000:
      return moclError("auth.missing-credential", {
        message: "opencode ACP authentication required (-32000)",
        backendCode,
        details: { kind: "auth.missing-credential", backendCode },
      });
    case -32601:
      return moclError("protocol.unknown-method", { message: error.message, backendCode });
    case -32602:
      return moclError("protocol.invalid-params", { message: error.message, backendCode });
    case -32603:
      return moclError("internal.unexpected", { message: error.message, backendCode });
    default:
      return moclError("backend.internal-error", {
        ...baseOptions(body),
        message: `opencode ACP error (${error.code})`,
      });
  }
}

/** SSE/JSONL 的 `error` 对象 → MoclError（§5.2 #10/#47）。 */
export function mapRawRuntimeError(raw: unknown): MoclError {
  if (raw instanceof MoclError) return raw;
  const status = extractStatus(raw);
  const text = safeStringify(raw);
  if (status !== undefined) {
    return mapHttpError(status, raw, {});
  }
  if (text.includes("api_key_expired") || text.includes("provider.auth")) {
    return moclError("auth.credential-expired", {
      message: "opencode provider key expired",
      details: { kind: "auth.credential-expired", backendCode: "api_key_expired" },
    });
  }
  if (text.includes("aborted") || text.includes("interrupted")) {
    return moclError("process.killed", { message: "opencode turn aborted" });
  }
  return moclError("backend.internal-error", { message: "opencode runtime error" });
}

/** 任意抛错 → MoclError（保底 `internal.unexpected`；不透传原始栈/凭据）。 */
export function toMoclError(error: unknown): MoclError {
  if (error instanceof MoclError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return moclError("transport.timeout", { message: "opencode request aborted by timeout" });
  }
  const message = error instanceof Error ? error.message : "unknown error";
  return moclError("internal.unexpected", { message: `opencode adapter failure: ${sanitize(message)}` });
}

/** 去掉可能出现在 message 里的 Basic/Authorization 片段（SEC-1 兜底）。 */
export function sanitize(message: string): string {
  return message
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic <redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(password|token|secret)\s*[:=]\s*\S+/gi, "$1=<redacted>");
}

export type { ErrorCode };

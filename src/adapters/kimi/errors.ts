/**
 * kimi 原生错误 → ABI 错误码映射（docs/adapters/kimi.md §10.2；错误码真源 = src/abi/errors.ts）。
 *
 * 实测输入三类（docs/research/kimi.md）：
 * 1) ACP JSON-RPC error：`-32601`（`session/cancel` 缺位）、`-32602`（`Unknown sessionId: X`）、
 *    `-32603`（`Already in plan mode`）、未来可能的 `-32000`（auth）；
 * 2) 进程信号/退出码：`exit=-15`（SIGTERM，本端 kill 的预期结果）；
 * 3) CLI `-p` 的参数冲突：`Cannot combine --prompt with --auto.`（rc=1）。
 *
 * 纪律：错误文案**不得**携带 token/api_key/OAuth 或 config.toml 敏感值（ABI SEC-1）；
 * `message` 只允许状态码、后端 code 与已脱敏的方法名。
 */
import { moclError, MoclError } from "../../broker/errors.ts";
import type { ErrorCode } from "../../abi/errors.ts";

/** JSON-RPC 错误体（ACP 线格式）。 */
export interface JsonRpcErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** 去掉可能出现在 message 里的凭据片段（SEC-1 兜底）。 */
export function sanitize(message: string): string {
  return message
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic <redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=<redacted>");
}

/**
 * `-32602` 是否表示「会话在后端已不存在」。
 * 实测原文：`Invalid params: Unknown sessionId: session_xxx`（kimi.md:242）→ `session.invalidated`。
 */
export function isUnknownSessionId(error: JsonRpcErrorShape): boolean {
  if (error.code !== -32602) return false;
  return /unknown\s+sessionid/i.test(error.message);
}

/**
 * `-32603` 点名的档位（实测 `{"details":"Already in plan mode"}`，kimi.md:236；
 * 2026-10-26 复测：message 是泛化 "Internal error"，点名只出现在 data.details 里）。
 *
 * "Already in <mode> mode" 只在请求档位 = 当前档位时出现（plan→auto/default 均成功），
 * 因此点名档位 == 请求档位 → 幂等成功；点名其他档位才是真冲突。
 */
export function conflictingModeName(error: JsonRpcErrorShape): string | null {
  if (error.code !== -32603) return null;
  const text = `${error.message} ${safeStringify(error.data)}`;
  const match = /already\s+in\s+([a-z][a-z-]*)\s+mode/i.exec(text);
  return match === null ? null : match[1]!.toLowerCase();
}

/** `-32603` 是否表示模式状态冲突（`conflictingModeName` 非空即冲突）。 */
export function isModeConflict(error: JsonRpcErrorShape): boolean {
  return conflictingModeName(error) !== null;
}

function safeStringify(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * ACP JSON-RPC error → MoclError（§10.2 逐行）。
 *
 * @param context `sessionScoped=true` 时 `-32602 Unknown sessionId` 归 `session.invalidated`
 */
export function mapJsonRpcError(
  error: JsonRpcErrorShape,
  context: { readonly sessionScoped?: boolean; readonly method?: string } = {},
): MoclError {
  const backendCode = `jsonrpc.${error.code}`;
  const methodSuffix = context.method === undefined ? "" : ` (${context.method})`;

  if (isUnknownSessionId(error)) {
    return moclError("session.invalidated", {
      message: `kimi session no longer exists${methodSuffix}`,
      backendCode,
      details: { kind: "session.invalidated", backendCode },
    });
  }
  if (isModeConflict(error)) {
    // §10.2：状态冲突 → session.conflict；幂等语义由调用方处理（不重试同一个 set_mode）。
    // 点名档位写进 hint（`already-in-mode:<name>`）供调用方判定"已在目标档 = 幂等成功"。
    const named = conflictingModeName(error);
    return moclError("session.conflict", {
      message: `kimi mode state conflict${methodSuffix}`,
      backendCode,
      details: {
        kind: "session.conflict",
        backendCode,
        ...(named === null ? {} : { hint: `already-in-mode:${named}` }),
      },
    });
  }
  switch (error.code) {
    case -32000:
      // kimi 只有 terminal 设备码登录（无 API-key auth method，kimi.md:211-217）→ 需人工登录。
      return moclError("auth.login-required", {
        message: "kimi requires an interactive device-code login (-32000)",
        backendCode,
        details: { kind: "auth.login-required", backendCode },
      });
    case -32601:
      // 已声明缺位（session/cancel）；其他方法按 unsupported-method 处理。
      return moclError("protocol.unknown-method", {
        message: `kimi does not implement ${context.method ?? "this method"} (-32601)`,
        backendCode,
        details: { kind: "protocol.unknown-method", backendCode },
      });
    case -32602:
      return moclError(context.sessionScoped === true ? "session.invalidated" : "protocol.invalid-params", {
        message: `kimi rejected params${methodSuffix} (-32602)`,
        backendCode,
        details: { kind: "protocol.invalid-params", backendCode },
      });
    case -32603:
      return moclError("internal.unexpected", {
        message: `kimi internal error${methodSuffix} (-32603)`,
        backendCode,
        details: { kind: "internal.unexpected", backendCode },
      });
    default:
      return moclError("backend.internal-error", {
        message: `kimi ACP error ${error.code}${methodSuffix}`,
        backendCode,
        details: { kind: "backend.internal-error", backendCode },
      });
  }
}

/**
 * 进程退出 → MoclError（§10.2 的「退出码 -15」「stopReason 缺失 + 进程退出」两行）。
 *
 * @param expectedKill 本端是否主动 kill（是 → `process.killed`，属预期，不算崩溃）
 */
export function mapExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  context: { readonly expectedKill?: boolean; readonly hadTerminalEvent?: boolean } = {},
): MoclError {
  if (context.expectedKill === true) {
    return moclError("process.killed", { message: `kimi process killed (${signal ?? code})` });
  }
  if (context.hadTerminalEvent === true) {
    // 轮已正常结束，进程随后退出：不是错误，交由调用方按 session.lost 处理。
    return moclError("transport.disconnected", { message: "kimi transport closed after turn completed" });
  }
  return moclError("process.crashed", {
    message: `kimi process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
  });
}

/**
 * CLI `-p` 的 stderr / 退出码 → MoclError。
 *
 * 实测原文（kimi.md:106-115）：
 * - `error: Cannot combine --prompt with --auto.` → rc=1（`-y`/`--plan` 同理）
 * - `error: unknown option '--badflag'` → rc=1
 * - `error: failed to run prompt: Unknown agent profile: "nope"` → rc=1
 */
export function mapCliError(stderr: string, exitCode: number | null): MoclError {
  const text = stderr.trim();
  if (/cannot combine --prompt with/i.test(text)) {
    return moclError("protocol.invalid-params", {
      message: "kimi `-p` cannot be combined with --auto/-y/--plan (headless mode is fixed by config.toml)",
      details: { kind: "protocol.invalid-params", hint: "改 config.toml: default_permission_mode，不要给 -p 传模式旗标" },
    });
  }
  if (/unknown option/i.test(text)) {
    return moclError("protocol.invalid-params", { message: `kimi rejected CLI option: ${sanitize(firstLine(text))}` });
  }
  if (/unknown agent profile/i.test(text)) {
    return moclError("protocol.invalid-params", { message: `kimi unknown agent profile: ${sanitize(firstLine(text))}` });
  }
  if (/authentication|login|credential/i.test(text)) {
    return moclError("auth.login-required", { message: "kimi CLI requires login" });
  }
  return moclError("process.crashed", {
    message: `kimi prompt process failed (exit=${String(exitCode)}): ${sanitize(firstLine(text))}`,
  });
}

function firstLine(text: string): string {
  const line = text.split("\n").find((item) => item.trim().length > 0) ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * 任意抛错 → MoclError，**优先识别 JSON-RPC 形状**（`{code:number}`）。
 *
 * 用途：适配器 catch 分支里既可能收到 `KimiAcpClient` 抛的 `MoclError`，
 * 也可能收到注入实现抛的 `Object.assign(new Error(), {code:-32602})`。
 * 不识别后者会把 `-32602 Unknown sessionId` 误判成 `internal.unexpected`，
 * 从而丢失 `session.invalidated`（R-1 冷恢复的触发条件）。
 */
export function toKimiError(error: unknown, context: { readonly method?: string } = {}): MoclError {
  if (error instanceof MoclError) return error;
  if (error instanceof Error) {
    const candidate = error as unknown as Partial<JsonRpcErrorShape>;
    if (typeof candidate.code === "number" && typeof candidate.message === "string") {
      return mapJsonRpcError(
        { code: candidate.code, message: candidate.message, data: candidate.data },
        { sessionScoped: true, ...(context.method === undefined ? {} : { method: context.method }) },
      );
    }
  }
  return toMoclError(error);
}

/** 任意抛错 → MoclError（保底 `internal.unexpected`；不泄露栈）。 */
export function toMoclError(error: unknown): MoclError {
  if (error instanceof MoclError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return moclError("transport.timeout", { message: "kimi request aborted" });
  }
  const message = error instanceof Error ? error.message : "unknown error";
  return moclError("internal.unexpected", { message: `kimi adapter failure: ${sanitize(message)}` });
}

export type { ErrorCode };

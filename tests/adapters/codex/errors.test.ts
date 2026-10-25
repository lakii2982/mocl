import { describe, expect, it } from "vitest";
import { ERROR_CATEGORY, RETRYABLE } from "../../../src/abi/errors.ts";
import {
  asAdapterError,
  codexErrorInfoName,
  mapExitError,
  mapJsonRpcError,
  mapSpawnError,
  mapTimeout,
  mapTurnError,
  toErrorRef,
} from "../../../src/adapters/codex/errors.ts";
import { permissionParamsFor, permissionParamsForMode, profileFromPermissionMode } from "../../../src/adapters/codex/index.ts";

describe("codex 失败分类（设计 §10.1）", () => {
  it("HTTP 401/429 分别映射 auth.credential-rejected / quota.rate-limited", () => {
    expect(mapJsonRpcError("turn/start", { code: -32000, message: "boom", data: { httpStatusCode: 401 } }).code).toBe("auth.credential-rejected");
    expect(mapJsonRpcError("turn/start", { code: -32000, message: "slow down", data: { status: 429 } }).code).toBe("quota.rate-limited");
    expect(mapJsonRpcError("turn/start", { code: -32000, message: "rate limit exceeded" }).code).toBe("quota.rate-limited");
  });

  it("-32601 / `not supported yet` → capability.unsupported-method（基线 items/list 的真实形态）", () => {
    expect(mapJsonRpcError("thread/items/list", { code: -32601, message: "thread/items/list is not supported yet" }).code).toBe("capability.unsupported-method");
    expect(mapJsonRpcError("thread/items/list", { code: -32600, message: "is not supported yet" }).code).toBe("capability.unsupported-method");
  });

  it("-32600 的三种语义错误按 message 区分（codex 不用 -32601）", () => {
    expect(mapJsonRpcError("thread/doesNotExist", { code: -32600, message: "Invalid request: unknown variant `thread/doesNotExist`" }).code).toBe("protocol.unknown-method");
    expect(mapJsonRpcError("turn/interrupt", { code: -32600, message: "no active turn to interrupt" }).code).toBe("session.conflict");
    expect(mapJsonRpcError("thread/resume", { code: -32600, message: "no rollout found for thread id t1" }).code).toBe("session.resume-failed");
    expect(mapJsonRpcError("thread/archive", { code: -32600, message: "no rollout found for thread id t1" }).code).toBe("session.invalidated");
    expect(mapJsonRpcError("thread/read", { code: -32600, message: "thread not found" }).code).toBe("session.not-found");
    expect(mapJsonRpcError("thread/start", { code: -32600, message: "Invalid request: cwd" }).code).toBe("protocol.invalid-params");
  });

  it("-32602/-32603 与未知错误码的兜底分类", () => {
    expect(mapJsonRpcError("turn/start", { code: -32602, message: "bad params" }).code).toBe("protocol.invalid-params");
    expect(mapJsonRpcError("turn/start", { code: -32603, message: "internal" }).code).toBe("backend.internal-error");
    expect(mapJsonRpcError("turn/start", { code: -32050, message: "weird" }).code).toBe("backend.internal-error");
  });

  it("mapTurnError 覆盖 codexErrorInfo 全部 13 个值", () => {
    const cases: Record<string, string> = {
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
    for (const [name, code] of Object.entries(cases)) {
      const error = mapTurnError(name, `msg-${name}`);
      expect(error.code).toBe(code);
      expect(error.backendCode).toBe(name);
    }
    expect(mapTurnError(undefined, "no info").code).toBe("backend.internal-error");
    expect(mapTurnError({ other: {} }, "object form").code).toBe("backend.internal-error");
  });

  it("codexErrorInfoName 兼容字符串与单键对象", () => {
    expect(codexErrorInfoName("rateLimitExceeded")).toBe("rateLimitExceeded");
    expect(codexErrorInfoName({ sandboxError: { detail: 1 } })).toBe("sandboxError");
    expect(codexErrorInfoName({ a: 1, b: 2 })).toBeUndefined();
    expect(codexErrorInfoName(null)).toBeUndefined();
  });

  it("toErrorRef 产出 schema 必填字段（code/category/message/retryable/userMessage/severity）", () => {
    const ref = toErrorRef(mapTimeout("turn/start", 5));
    expect(ref).toMatchObject({
      code: "transport.timeout",
      category: ERROR_CATEGORY["transport.timeout"],
      retryable: RETRYABLE["transport.timeout"],
      severity: "error",
    });
    expect(ref.userMessage.length).toBeGreaterThan(0);
    expect(ref.userMessage.length).toBeLessThanOrEqual(120);
    expect(() => JSON.stringify(ref)).not.toThrow();
  });

  it("spawn/exit 的进程级分类", () => {
    expect(mapSpawnError(new Error("spawn ENOENT")).code).toBe("process.spawn-failed");
    expect(mapExitError(2, null).code).toBe("process.crashed");
    expect(mapExitError(null, "SIGKILL").code).toBe("process.crashed");
  });

  it("asAdapterError 把未知异常规整为 internal.unexpected", () => {
    const error = asAdapterError(new Error("weird"));
    expect(error.code).toBe("internal.unexpected");
    expect(asAdapterError(error)).toBe(error);
  });
});

describe("codex 权限映射（设计 §7.1；含插件模式名）", () => {
  it("ABI 三档 → thread/start 参数", () => {
    expect(permissionParamsFor("read-only")).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    expect(permissionParamsFor("safe-auto")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(permissionParamsFor("yolo")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });

  it("生产插件的模式名 never|approve-for-me|dangerously-bypass → 参数", () => {
    expect(permissionParamsForMode("never")).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    expect(permissionParamsForMode("approve-for-me")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(permissionParamsForMode("dangerously-bypass")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });

  it("模式名 → ABI 档位（安全默认：未知一律 read-only）", () => {
    expect(profileFromPermissionMode("approve-for-me")).toBe("safe-auto");
    expect(profileFromPermissionMode("dangerously-bypass")).toBe("yolo");
    expect(profileFromPermissionMode("never")).toBe("read-only");
    expect(profileFromPermissionMode("unknown-mode")).toBe("read-only");
  });
});

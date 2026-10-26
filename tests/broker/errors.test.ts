import { describe, expect, it } from "vitest";
import { MoclError, moclError } from "../../src/broker/errors.ts";

/**
 * 宿主（dsh-tools）对工具返回值做 lossless-JSON 校验：
 * 任何 undefined/函数/类实例都会让整次工具调用变成 ToolOutputError。
 * ErrorRef 会作为工具错误结果直接返回，因此必须保证整对象可无损 JSON 化。
 */
describe("MoclError → ErrorRef（lossless JSON 约束）", () => {
  it("未设置的可选字段整键省略，不留 undefined", () => {
    const ref = moclError("internal.unexpected", { message: "boom" }).toErrorRef();
    expect(Object.values(ref).every((value) => value !== undefined)).toBe(true);
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
  });

  it("设置了可选字段时按原值保留（retryAfterMs / traceId / backendCode / cause）", () => {
    const err = new MoclError("quota.rate-limited", {
      message: "slow down",
      retryAfterMs: 500,
      traceId: "trace-1",
      backendCode: "429",
      cause: "provider said no",
    });
    const ref = err.toErrorRef({ sessionId: "sess_1", turnId: "turn_1" });
    expect(ref.retryAfterMs).toBe(500);
    expect(ref.traceId).toBe("trace-1");
    expect(ref.sessionId).toBe("sess_1");
    expect(ref.turnId).toBe("turn_1");
    expect(ref.details).toEqual({ kind: "quota.rate-limited", backendCode: "429" });
    expect(ref.cause).toBe("provider said no");
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
  });

  it("默认 details 只含 kind（无 undefined）", () => {
    const ref = moclError("session.not-found", { message: "x" }).toErrorRef();
    expect(ref.details).toEqual({ kind: "session.not-found" });
  });
});

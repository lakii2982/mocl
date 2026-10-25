import { describe, expect, it } from "vitest";
import {
  SERVER_REQUEST_METHODS,
  UnattendedApprovals,
  isRegisteredServerRequest,
  respondToServerRequest,
} from "../../../src/adapters/codex/server-requests.ts";

const request = (id: number, method: string, params: unknown = {}): { id: number; method: string; params: unknown } => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
}) as unknown as { id: number; method: string; params: unknown };

describe("codex 无人值守审批：10 个 ServerRequest 全部有确定性应答", () => {
  it("预注册集合恰好是基线的 10 个 method", () => {
    expect(SERVER_REQUEST_METHODS).toHaveLength(10);
    expect(new Set(SERVER_REQUEST_METHODS).size).toBe(10);
    expect(SERVER_REQUEST_METHODS).toContain("applyPatchApproval");
    expect(SERVER_REQUEST_METHODS).toContain("execCommandApproval");
    expect(isRegisteredServerRequest("item/commandExecution/requestApproval")).toBe(true);
    expect(isRegisteredServerRequest("item/notARealRequest")).toBe(false);
  });

  it.each(SERVER_REQUEST_METHODS)("method %s → 有应答帧且 id 原样回填", (method) => {
    const frame = respondToServerRequest(request(42, method, { availableDecisions: ["accept", "decline", "cancel"] }));
    expect(frame.id).toBe(42);
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.result !== undefined || frame.error !== undefined).toBe(true);
    // 必须能 JSON 序列化（不能含 undefined 字段导致超集失配）
    expect(() => JSON.stringify(frame)).not.toThrow();
    expect(JSON.stringify(frame)).not.toContain("undefined");
  });

  it("4 个现代 approval 一律给最保守的拒绝（decline 优先于 cancel）", () => {
    expect(respondToServerRequest(request(1, "item/commandExecution/requestApproval", { availableDecisions: ["accept", "decline", "cancel"] })).result).toEqual({ decision: "decline" });
    expect(respondToServerRequest(request(2, "item/fileChange/requestApproval", { availableDecisions: ["accept", "cancel"] })).result).toEqual({ decision: "cancel" });
    expect(respondToServerRequest(request(3, "item/fileChange/requestApproval")).result).toEqual({ decision: "decline" });
  });

  it("permission 扩权请求 → 空权限（不扩权）；user input → 空 answers", () => {
    expect(respondToServerRequest(request(1, "item/permissions/requestApproval")).result).toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(respondToServerRequest(request(2, "item/tool/requestUserInput")).result).toEqual({ answers: {} });
    expect(respondToServerRequest(request(3, "mcpServer/elicitation/request")).result).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
  });

  it("无法伪造的请求（token refresh / attestation）回 JSON-RPC error 而不是假成功", () => {
    const refresh = respondToServerRequest(request(7, "account/chatgptAuthTokens/refresh"));
    expect(refresh.error?.code).toBe(-32001);
    expect(refresh.result).toBeUndefined();
    const attestation = respondToServerRequest(request(8, "attestation/generate"));
    expect(attestation.error?.code).toBe(-32002);
  });

  it("v1 legacy approval → denied 对象（ReviewDecision 的拒绝形状）", () => {
    for (const method of ["applyPatchApproval", "execCommandApproval"]) {
      const frame = respondToServerRequest(request(9, method));
      expect(frame.result).toEqual({ decision: { denied: { rejection: "unattended: no interactive approval surface" } } });
    }
  });

  it("未知 method → -32601 明确错误（不静默、不阻塞 turn）", () => {
    const frame = respondToServerRequest(request(11, "item/totallyUnknown/request"));
    expect(frame.error?.code).toBe(-32601);
    expect(frame.error?.message).toContain("item/totallyUnknown/request");
  });

  it("计数覆盖：每次 handle 都计数（可观测性）", () => {
    const approvals = new UnattendedApprovals();
    approvals.handle(request(1, "item/commandExecution/requestApproval"));
    approvals.handle(request(2, "item/commandExecution/requestApproval"));
    approvals.handle(request(3, "attestation/generate"));
    expect(approvals.counts()).toEqual({
      "item/commandExecution/requestApproval": 2,
      "attestation/generate": 1,
    });
    expect(approvals.total).toBe(3);
  });
});

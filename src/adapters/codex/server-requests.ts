/**
 * 无人值守审批：app-server 的 **10 个 `ServerRequest` method 全部预注册确定性拒绝桩**（设计 §7.2）。
 *
 * 为什么必须"全注册"：这些是「服务端问客户端」的反向请求；没有 handler 时 turn 会无限期等待
 * （ABI §4 要求 1 / ABI-T8）。未知 method 也必须有响应（回 JSON-RPC error），**绝不静默忽略**。
 *
 * 应答形状取自基线 0.164.0 导出物（`*RequestApprovalResponse.json` / `DynamicToolCallResponse.json`
 * / `ToolRequestUserInputResponse.json` / `McpServerElicitationRequestResponse.json` 等）；
 * 4 个现代 approval 的决策遵循生产插件已验证的做法：在 `availableDecisions` 里挑最保守的可选项。
 */
import type { JsonRpcFrame } from "./types.ts";

/** 基线实测的 10 个 method（8 现代 + 2 个 v1 legacy；顺序固定便于测试与文档对照）。 */
export const SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/call",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "applyPatchApproval",
  "execCommandApproval",
] as const;

export type ServerRequestMethod = (typeof SERVER_REQUEST_METHODS)[number];

const SERVER_REQUEST_METHOD_SET: ReadonlySet<string> = new Set(SERVER_REQUEST_METHODS);

export function isRegisteredServerRequest(method: string): method is ServerRequestMethod {
  return SERVER_REQUEST_METHOD_SET.has(method);
}

/** `availableDecisions` 里挑最保守的拒绝项；缺失时默认 `decline`。 */
function denyDecision(params: unknown): "decline" | "cancel" {
  if (params === null || typeof params !== "object") return "decline";
  const available = (params as Record<string, unknown>)["availableDecisions"];
  if (!Array.isArray(available)) return "decline";
  const values = available.filter((v): v is string => typeof v === "string");
  if (values.includes("decline")) return "decline";
  if (values.includes("cancel")) return "cancel";
  return "decline";
}

/** 结构化拒绝文案（出现在 agent 上下文里，必须说明是无人值守策略）。 */
const DENY_REASON = "unattended: no interactive approval surface";

/** 每个 method 的确定性应答（`error` 表示无法伪造结果，用 JSON-RPC error 明确失败）。 */
function resultFor(method: ServerRequestMethod, params: unknown): { result: unknown } | { error: { code: number; message: string } } {
  switch (method) {
    case "item/commandExecution/requestApproval":
      // CommandExecutionApprovalDecision: accept | acceptForSession | {...} | decline | cancel
      return { result: { decision: denyDecision(params) } };
    case "item/fileChange/requestApproval":
      // FileChangeApprovalDecision: accept | acceptForSession | decline | cancel
      return { result: { decision: denyDecision(params) } };
    case "item/permissions/requestApproval":
      // PermissionsRequestApprovalResponse.required = [permissions]；空权限即"不扩权"。
      return { result: { permissions: {}, scope: "turn" } };
    case "item/tool/call":
      // DynamicToolCallResponse.required = [contentItems, success]
      return { result: { success: false, contentItems: [] } };
    case "item/tool/requestUserInput":
      return { result: { answers: {} } };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline", content: null, _meta: null } };
    case "account/chatgptAuthTokens/refresh":
      // 不能伪造 accessToken/chatgptAccountId → 明确报错（上层映射 auth.credential-expired）。
      return { error: { code: -32001, message: "unattended: cannot refresh chatgpt auth tokens" } };
    case "attestation/generate":
      return { error: { code: -32002, message: "unattended: attestation generation disabled" } };
    case "applyPatchApproval":
    case "execCommandApproval":
      // v1 legacy ReviewDecision：denied 是对象 `{denied:{rejection}}`。
      return { result: { decision: { denied: { rejection: DENY_REASON } } } };
  }
}

/** 生成对任一反向请求的 JSON-RPC 应答帧（含未知 method 的 -32601）。 */
export function respondToServerRequest(frame: JsonRpcFrame): JsonRpcFrame {
  const id = frame.id ?? null;
  const method = frame.method ?? "";
  if (!isRegisteredServerRequest(method)) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `unattended: unsupported server request ${method}` },
    };
  }
  const outcome = resultFor(method, frame.params);
  if ("error" in outcome) {
    return { jsonrpc: "2.0", id, error: outcome.error };
  }
  return { jsonrpc: "2.0", id, result: outcome.result };
}

/** 应答计数器（可观测性 + 测试断言；不改变应答语义）。 */
export class UnattendedApprovals {
  readonly #counts = new Map<string, number>();

  /** 处理一个反向请求帧，返回应发送的响应帧。 */
  handle(frame: JsonRpcFrame): JsonRpcFrame {
    const method = frame.method ?? "unknown";
    this.#counts.set(method, (this.#counts.get(method) ?? 0) + 1);
    return respondToServerRequest(frame);
  }

  /** method → 次数快照。 */
  counts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.#counts);
  }

  get total(): number {
    let sum = 0;
    for (const value of this.#counts.values()) sum += value;
    return sum;
  }
}

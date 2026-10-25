import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import {
  EventDropCounters,
  OpenCodeEventMapper,
  permissionRiskFromAction,
  usageFromTokens,
} from "../../../src/adapters/opencode/events.ts";
import type { AcpSessionUpdateParams, SseFrame } from "../../../src/adapters/opencode/types.ts";
import { loadFrames } from "./helpers.ts";

function mapAll(frames: readonly SseFrame[], sessionId = "ses_1", model = "opencode-go/deepseek-v4.1-flash") {
  const counters = new EventDropCounters();
  const mapper = new OpenCodeEventMapper({ sessionId, model }, counters);
  mapper.beginTurn("turn_1", model);
  const events: AdapterEvent[] = [];
  for (const frame of frames) events.push(...mapper.map(frame));
  return { mapper, counters, events };
}

describe("opencode 事件映射（§5.2 v2 SSE）", () => {
  it("成功轮 fixture：turn/message/reasoning/usage 到唯一终态", () => {
    const { events, mapper } = mapAll(loadFrames("sse-success"));
    const types = events.map((event) => event.type);
    expect(types).toContain("transport.state-changed");
    expect(types).toContain("turn.started");
    expect(types).toContain("message.started");
    expect(types).toContain("message.delta");
    expect(types).toContain("message.completed");
    expect(types).toContain("usage.updated");
    expect(types.filter((type) => type === "turn.completed")).toHaveLength(1);
    expect(mapper.terminalEmitted).toBe(true);
    const delta = events.find((event) => event.type === "message.delta");
    expect(delta?.payload).toMatchObject({ channel: "assistant", text: "OK", granularity: "message" });
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toMatchObject({ stopReason: "end-turn", usage: { inputTokens: 3657 } });
  });

  it("catalog 噪声与内部标记丢弃并计数（§5.5）", () => {
    const { counters } = mapAll(loadFrames("catalog-noise"));
    expect(counters.snapshot()).toMatchObject({ "drop.catalog_event": 5 });
    const internal = mapAll([
      { type: "session.inbox.delivered", data: {} },
      { type: "session.step.started", data: {} },
      { type: "session.step.streamed", data: {} },
      { type: "session.instructions.updated", data: {} },
    ]);
    expect(internal.counters.snapshot()).toMatchObject({ "drop.internal_event": 4 });
  });

  it("未知 type 丢弃并计数，不伪造事件", () => {
    const { events, counters } = mapAll([{ type: "session.mystery.event", data: {} }]);
    expect(events).toEqual([]);
    expect(Object.keys(counters.snapshot())).toContain("drop.unknown_type.session.mystery.event");
  });

  it("inbox.enqueued → turn.queued（运行中追加输入）", () => {
    const { events } = mapAll([
      {
        type: "session.inbox.enqueued",
        data: { inboxID: "msg_2", sessionID: "ses_1", item: { type: "user", payload: { text: "more" } } },
      },
    ]);
    expect(events[0]).toMatchObject({ type: "turn.queued", payload: { queuePosition: 1 } });
  });

  it("401 provider.auth：step.failed + execution.failed → 唯一 turn.failed（auth.credential-expired）", () => {
    const { events } = mapAll(loadFrames("sse-auth-expired"));
    const failed = events.filter((event) => event.type === "turn.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ error: { code: "auth.credential-expired" } });
  });

  it("中断：step.failed(aborted) + execution.interrupted → 唯一 turn.aborted（native）", () => {
    const { events } = mapAll([
      { type: "session.step.started", data: { agent: "plan" } },
      {
        type: "session.step.failed",
        data: { sessionID: "ses_1", error: { type: "aborted", message: "Step interrupted" } },
      },
      { type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "user" } },
    ]);
    const aborted = events.filter((event) => event.type === "turn.aborted");
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.payload).toMatchObject({ interruptMethod: "native", partial: true });
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("permission.asked → permission.requested（risk/options 映射）", () => {
    const { events } = mapAll([
      {
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_1", action: "read", resources: [".env"], save: ["*"] },
      },
    ]);
    expect(events[0]).toMatchObject({
      type: "permission.requested",
      payload: {
        requestId: "per_1",
        tool: "read",
        risk: "read",
        options: [
          { id: "once", kind: "allow-once" },
          { id: "always", kind: "allow-always" },
          { id: "reject", kind: "deny-once" },
        ],
      },
    });
    expect(permissionRiskFromAction("bash", ["npm test"])).toBe("execute");
    expect(permissionRiskFromAction("edit", ["src/a.ts"])).toBe("write");
    expect(permissionRiskFromAction("webfetch", ["https://x"])).toBe("network");
    expect(permissionRiskFromAction("mystery")).toBe("unknown");
  });

  it("server.connected 只发一次 transport.state-changed；重复丢弃", () => {
    const { events, counters } = mapAll([
      { type: "server.connected", data: {} },
      { type: "server.connected", data: {} },
    ]);
    expect(events.filter((event) => event.type === "transport.state-changed")).toHaveLength(1);
    expect(counters.snapshot()).toMatchObject({ "drop.duplicate_ready": 1 });
  });

  it("usageFromTokens：tokens 缺失时 estimated:true，不伪造 0", () => {
    expect(usageFromTokens(undefined, undefined)).toMatchObject({ estimated: true, scope: "turn" });
    expect(usageFromTokens({ input: 3, output: 2 }, 0)).toMatchObject({
      estimated: false,
      inputTokens: 3,
      outputTokens: 2,
      costUsd: 0,
    });
  });
});

describe("opencode 事件映射（§5.3 ACP / §5.4 CLI）", () => {
  it("ACP agent_message_chunk / usage_update / available_commands_update", () => {
    const counters = new EventDropCounters();
    const mapper = new OpenCodeEventMapper({ sessionId: "ses_acp_1", model: "opencode/deepseek-v4.1-flash-free" }, counters);
    mapper.beginTurn("turn_acp_1");
    const chunk = mapper.mapAcpUpdate({
      sessionId: "ses_acp_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_1",
        content: { type: "text", text: "OK" },
      },
    } as AcpSessionUpdateParams);
    expect(chunk[0]).toMatchObject({ type: "message.delta", payload: { text: "OK", messageId: "msg_1" } });
    const usage = mapper.mapAcpUpdate({
      sessionId: "ses_acp_1",
      update: { sessionUpdate: "usage_update", used: 5721, size: 200000, cost: { amount: 0, currency: "USD" } },
    } as AcpSessionUpdateParams);
    expect(usage[0]).toMatchObject({ type: "usage.updated", payload: { usage: { estimated: true, costUsd: 0 } } });
    const dropped = mapper.mapAcpUpdate({
      sessionId: "ses_acp_1",
      update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    } as AcpSessionUpdateParams);
    expect(dropped).toEqual([]);
    expect(counters.snapshot()).toMatchObject({ "drop.acp_internal": 1 });
  });

  it("ACP prompt 结果 → turn.completed（end_turn + usage），重复终态丢弃", () => {
    const counters = new EventDropCounters();
    const mapper = new OpenCodeEventMapper({ sessionId: "ses_acp_1", model: "opencode/deepseek-v4.1-flash-free" }, counters);
    mapper.beginTurn("turn_acp_2");
    const events = mapper.mapPromptResult({
      stopReason: "end_turn",
      usage: { inputTokens: 1623, outputTokens: 2, totalTokens: 5721, cachedReadTokens: 4096 },
    });
    expect(events[0]).toMatchObject({
      type: "turn.completed",
      payload: { stopReason: "end-turn", usage: { inputTokens: 1623, outputTokens: 2 } },
    });
    expect(mapper.mapPromptResult({ stopReason: "end_turn" })).toEqual([]);
    expect(counters.snapshot()).toMatchObject({ "drop.duplicate_terminal": 1 });
  });

  it("CLI JSONL：step_start → text → step_finish；error → turn.failed", () => {
    const mapper = new OpenCodeEventMapper({ sessionId: "ses_cli", model: "opencode/deepseek-v4.1-flash-free" });
    mapper.beginTurn("turn_cli_1");
    expect(mapper.mapCliEvent({ type: "step_start", part: { messageID: "msg_c" } })).toMatchObject([
      { type: "turn.started" },
    ]);
    expect(
      mapper.mapCliEvent({ type: "text", part: { messageID: "msg_c", type: "text", text: "OK" } }),
    ).toMatchObject([{ type: "message.completed", payload: { text: "OK" } }]);
    expect(
      mapper.mapCliEvent({
        type: "step_finish",
        part: { reason: "stop", cost: 0, tokens: { input: 5, output: 2 } },
      }),
    ).toMatchObject([{ type: "turn.completed", payload: { stopReason: "end-turn" } }]);

    const mapper2 = new OpenCodeEventMapper({ sessionId: "ses_cli2", model: "opencode-go/deepseek-v4.1-flash" });
    mapper2.beginTurn("turn_cli_2");
    const failed = mapper2.mapCliEvent({
      type: "error",
      error: { type: "provider.auth", status: 401, message: "api_key_expired" },
    });
    expect(failed[0]).toMatchObject({ type: "turn.failed", payload: { error: { code: "auth.credential-expired" } } });
  });
});

import { describe, expect, it } from "vitest";
import { KimiEventMapper, digest, mapStopReason } from "../../../src/adapters/kimi/events.ts";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import { moclError } from "../../../src/broker/errors.ts";

function makeMapper(overrides: Partial<ConstructorParameters<typeof KimiEventMapper>[0]> = {}): KimiEventMapper {
  return new KimiEventMapper({ sessionId: "s1", cwd: "/tmp/work", expectedProfile: "safe-auto", ...overrides });
}

function update(mapper: KimiEventMapper, payload: Readonly<Record<string, unknown>>): AdapterEvent[] {
  return mapper.mapAcpUpdate({ sessionId: "s1", update: payload });
}

function startTurn(mapper: KimiEventMapper): AdapterEvent[] {
  mapper.beginTurn("turn_1", "kimi-code/k3.1-pro");
  return update(mapper, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
}

describe("会话级事件（§5.2 #2/#3）", () => {
  it("session/new → session.created{cwd}", () => {
    const mapper = makeMapper();
    const events = mapper.sessionCreated("/tmp/work");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session.created", payload: { state: "created", cwd: "/tmp/work" } });
  });

  it("session/load → session.recovered + state-changed", () => {
    const events = makeMapper().sessionRecovered();
    expect(events.map((event) => event.type)).toEqual(["session.recovered", "session.state-changed"]);
    expect(events[0]?.payload).toMatchObject({ strategy: "resume", attempt: 1 });
  });
});

describe("丢弃项必须计数（§5.3）", () => {
  it("available_commands_update / session_info_update / config_option_update", () => {
    const mapper = makeMapper();
    expect(update(mapper, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] })).toEqual([]);
    expect(update(mapper, { sessionUpdate: "session_info_update", title: "只回复 OK" })).toEqual([]);
    expect(update(mapper, { sessionUpdate: "config_option_update", configOptions: [] })).toEqual([]);
    expect(mapper.counters.snapshot()).toMatchObject({
      "drop.available_commands_update": 1,
      "drop.session_info_update": 1,
      "drop.config_option_update": 1,
    });
    // session_info_update 的 title 仍被记为非事件信息
    expect(mapper.title).toBe("只回复 OK");
  });

  it("未知 update 类型 → 计数且不伪造事件", () => {
    const mapper = makeMapper();
    expect(update(mapper, { sessionUpdate: "brand_new_thing" })).toEqual([]);
    expect(mapper.counters.snapshot()["drop.unknown_acp_update.brand_new_thing"]).toBe(1);
  });
});

describe("模式漂移检测（§5.2 #8）", () => {
  it("currentModeId 与请求档位一致 → 无 warning", () => {
    const mapper = makeMapper({ expectedProfile: "safe-auto" }); // → auto
    expect(update(mapper, { sessionUpdate: "current_mode_update", currentModeId: "auto" })).toEqual([]);
    expect(mapper.currentModeId).toBe("auto");
  });

  it("不一致 → session.warning{permission.mode-drift, degrade:true}（只发一次）", () => {
    const mapper = makeMapper({ expectedProfile: "safe-auto" });
    const events = update(mapper, { sessionUpdate: "current_mode_update", currentModeId: "yolo" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session.warning",
      payload: { code: "permission.mode-drift", degrade: true, bits: ["permissionModes"] },
    });
    expect(update(mapper, { sessionUpdate: "current_mode_update", currentModeId: "yolo" })).toEqual([]);
  });

  it("plan 档对应 read-only（严格档语义）", () => {
    const mapper = makeMapper({ expectedProfile: "read-only" });
    expect(update(mapper, { sessionUpdate: "current_mode_update", currentModeId: "plan" })).toEqual([]);
  });
});

describe("token 级流映射（§5.2 #10/#11、§5.4）", () => {
  it("agent_thought_chunk 默认丢弃并计 fold.reasoning_dropped", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    expect(update(mapper, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I" } })).toEqual([]);
    expect(mapper.counters.snapshot()["fold.reasoning_dropped"]).toBe(1);
  });

  it("includeReasoning=true → reasoning.delta{token} 且带 turn.started", () => {
    const mapper = makeMapper({ includeReasoning: true });
    mapper.beginTurn("turn_1", "m");
    const events = update(mapper, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I need" } });
    expect(events.map((event) => event.type)).toEqual(["turn.started", "reasoning.delta"]);
    expect(events[1]?.payload).toMatchObject({ text: "I need", granularity: "token" });
  });

  it("agent_message_chunk → message.started（一次）+ message.delta{token}；轮末补权威全文", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "kimi-code/k3.1-pro");
    const first = update(mapper, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
    expect(first.map((event) => event.type)).toEqual(["turn.started", "message.started", "message.delta"]);
    const messageId = (first[2]?.payload as { messageId: string }).messageId;
    expect(messageId).toBe("msg_turn_1");

    const second = update(mapper, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "!" } });
    expect(second.map((event) => event.type)).toEqual(["message.delta"]); // 不再重复 started

    const terminal = mapper.mapPromptResult({ stopReason: "end_turn" });
    expect(terminal.map((event) => event.type)).toEqual(["message.completed", "turn.completed"]);
    expect(terminal[0]?.payload).toMatchObject({ text: "OK!", messageId });
    expect(terminal[1]?.payload).toMatchObject({ stopReason: "end-turn" });
  });
});

describe("工具事件（§5.2 #12/#13/#14/#15）", () => {
  it("tool_call → tool.started；completed → tool.completed{outputDigest}", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    const started = update(mapper, {
      sessionUpdate: "tool_call",
      toolCallId: "0:tool_a",
      title: "Read",
      kind: "read",
      status: "pending",
    });
    expect(started.map((event) => event.type)).toEqual(["turn.started", "tool.started"]);
    expect(started[1]?.payload).toMatchObject({ toolCallId: "0:tool_a", name: "Read", kind: "read" });

    const completed = update(mapper, {
      sessionUpdate: "tool_call_update",
      toolCallId: "0:tool_a",
      status: "completed",
      rawOutput: "1\thello-marker",
    });
    expect(completed.map((event) => event.type)).toEqual(["tool.completed"]);
    expect(completed[0]?.payload).toMatchObject({
      toolCallId: "0:tool_a",
      status: "ok",
      outputDigest: digest("1\thello-marker"),
    });
  });

  it("tool_call_update.in_progress 的 rawInput 逐字符回显 → 丢弃计数 + ≥200ms 节流", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    update(mapper, { sessionUpdate: "tool_call", toolCallId: "0:tool_b", title: "Write" });

    const first = update(mapper, {
      sessionUpdate: "tool_call_update",
      toolCallId: "0:tool_b",
      status: "in_progress",
      rawInput: { path: "a" },
    });
    expect(first.map((event) => event.type)).toEqual(["tool.progress"]);
    // 紧随其后的 fragment：被节流
    const second = update(mapper, {
      sessionUpdate: "tool_call_update",
      toolCallId: "0:tool_b",
      status: "in_progress",
      rawInput: { path: "a.txt" },
    });
    expect(second).toEqual([]);
    expect(mapper.counters.snapshot()["coalesce.tool_progress"]).toBe(1);
    expect(mapper.counters.snapshot()["drop.tool_rawinput_fragment"]).toBe(2);
  });

  it("大输出 → truncated:true", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    update(mapper, { sessionUpdate: "tool_call", toolCallId: "t", title: "Bash" });
    const events = update(mapper, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      rawOutput: "x".repeat(9 * 1024),
    });
    expect(events[0]?.payload).toMatchObject({ truncated: true });
    expect(mapper.counters.snapshot()["fold.tool_output_truncated"]).toBe(1);
  });

  it("status=failed → tool.failed{error,partial}", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    update(mapper, { sessionUpdate: "tool_call", toolCallId: "t2", title: "Read" });
    const events = update(mapper, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t2",
      status: "failed",
      error: { message: "ENOENT" },
    });
    expect(events.map((event) => event.type)).toEqual(["tool.failed"]);
    expect(events[0]?.payload).toMatchObject({ partial: true });
  });
});

describe("用量（§5.2 #16）：coarse，不伪造计费 token", () => {
  it("usage_update → usage.updated{estimated:true,scope:turn} + 首见 usage.coarse warning", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    const first = update(mapper, { sessionUpdate: "usage_update", used: 36996, size: 1000000 });
    expect(first.map((event) => event.type)).toEqual(["turn.started", "usage.updated", "session.warning"]);
    const usage = (first[1]?.payload as { usage: { estimated: boolean; scope: string; inputTokens?: number } }).usage;
    expect(usage.estimated).toBe(true);
    expect(usage.scope).toBe("turn");
    expect(usage.inputTokens).toBeUndefined(); // 关键：不伪造
    expect(first[2]?.payload).toMatchObject({ code: "usage.coarse", degrade: true });

    // 第二次不再重复 warning
    const second = update(mapper, { sessionUpdate: "usage_update", used: 40000, size: 1000000 });
    expect(second.map((event) => event.type)).toEqual(["usage.updated"]);
  });
});

describe("权限请求 → ABI（§5.2 #17/#18 / K5）", () => {
  it("Write 请求在 read-only 档 → requested + resolved(deny)，且 answer 是真实存在的 optionId", () => {
    const mapper = makeMapper({ expectedProfile: "read-only" });
    mapper.beginTurn("turn_1", "m");
    const { events, answer } = mapper.mapPermissionRequest(42, {
      sessionId: "s1",
      toolCall: { toolCallId: "0:call_1", title: "Write", content: [] },
      options: [
        { optionId: "approve_once", kind: "allow_once" },
        { optionId: "approve_always", kind: "allow_always" },
        { optionId: "reject", kind: "reject_once" },
      ],
    });
    expect(events.map((event) => event.type)).toEqual(["permission.requested", "permission.resolved"]);
    expect(events[0]?.payload).toMatchObject({ requestId: "42", tool: "Write", risk: "write" });
    expect(events[1]?.payload).toMatchObject({ requestId: "42", decision: "deny", by: "policy" });
    expect(answer).toMatchObject({ optionId: "reject", decision: "deny", risk: "write" });
  });

  it("yolo 档 Read 请求 → allow-always", () => {
    const mapper = makeMapper({ expectedProfile: "yolo" });
    mapper.beginTurn("turn_1", "m");
    const { answer } = mapper.mapPermissionRequest(43, {
      sessionId: "s1",
      toolCall: { toolCallId: "c", title: "Read", kind: "read" },
      options: [{ optionId: "approve_always", kind: "allow_always" }, { optionId: "reject", kind: "reject_once" }],
    });
    expect(answer).toMatchObject({ optionId: "approve_always", decision: "allow-always" });
  });

  it("无匹配 option → escalationRequired", () => {
    const mapper = makeMapper({ expectedProfile: "yolo" });
    mapper.beginTurn("turn_1", "m");
    const { answer } = mapper.mapPermissionRequest(44, {
      sessionId: "s1",
      toolCall: { title: "Bash" },
      options: [{ optionId: "no", kind: "reject_once" }],
    });
    expect(answer.escalationRequired).toBe(true);
  });
});

describe("终态唯一性（§5.1 EV-4）", () => {
  it("stopReason 映射：end_turn/max_tokens/refusal", () => {
    expect(mapStopReason("end_turn")).toBe("end-turn");
    expect(mapStopReason("max_tokens")).toBe("context-limit");
    expect(mapStopReason("max_turns")).toBe("max-turns");
    expect(mapStopReason("refusal")).toBe("other");
    expect(mapStopReason("stop_sequence")).toBe("other");
  });

  it("重复终态被丢弃并计数（一轮恰好一条终态）", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    // 首个终态会补齐 turn.started（若此前没有过程事件）
    const first = mapper.mapPromptResult({ stopReason: "end_turn" });
    expect(first.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(mapper.mapPromptResult({ stopReason: "end_turn" })).toEqual([]);
    expect(mapper.counters.snapshot()["drop.duplicate_terminal"]).toBe(1);
  });

  it("prompt 错误（-32602 Unknown sessionId）→ turn.failed{session.invalidated}", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    const error = Object.assign(new Error("Invalid params: Unknown sessionId: s1"), { code: -32602, data: {} });
    const events = mapper.mapPromptError(error, { method: "session/prompt" });
    // 首个终态会补齐 turn.started（此前无过程事件）
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.failed"]);
    const failed = events.find((event) => event.type === "turn.failed");
    expect((failed?.payload as { error: { code: string } }).error.code).toBe("session.invalidated");
  });

  it("显式 MoclError 原样投影（不吞错误码）", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    const events = mapper.mapPromptError(moclError("backend.internal-error", { message: "boom" }));
    const failed = events.find((event) => event.type === "turn.failed");
    expect((failed?.payload as { error: { code: string } }).error.code).toBe("backend.internal-error");
  });

  it("interrupt → turn.aborted{process-kill,partial:true}", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_1", "m");
    const events = mapper.interrupt();
    expect(events[0]).toMatchObject({ type: "turn.aborted", payload: { interruptMethod: "process-kill", partial: true } });
    expect(mapper.interrupt()).toEqual([]); // 幂等
  });

  it("无进行中轮时 interrupt → 不产生事件（只计数）", () => {
    const mapper = makeMapper();
    expect(mapper.interrupt()).toEqual([]);
    expect(mapper.counters.snapshot()["drop.interrupt_without_active_turn"]).toBe(1);
  });

  it("timeout → turn.aborted{timeout}；process exit → turn.failed{process.crashed}", () => {
    const timedOut = makeMapper();
    timedOut.beginTurn("turn_1", "m");
    expect(timedOut.mapTimeout("idle")[0]).toMatchObject({
      type: "turn.aborted",
      payload: { interruptMethod: "timeout", partial: true },
    });

    const crashed = makeMapper();
    crashed.beginTurn("turn_2", "m");
    expect(crashed.mapProcessExit(null, "SIGKILL")[0]).toMatchObject({ type: "turn.failed" });
  });

  it("transportClosed → transport.state-changed{closed}；帧损坏计数", () => {
    const mapper = makeMapper();
    expect(mapper.transportClosed()[0]).toMatchObject({
      type: "transport.state-changed",
      payload: { transport: "acp-stdio", state: "closed" },
    });
    mapper.frameInvalid("bad");
    expect(mapper.counters.snapshot()["frame.invalid"]).toBe(1);
  });

  it("sessionLost → session.lost{reason,lastKnownSeq}", () => {
    const mapper = makeMapper();
    expect(mapper.sessionLost("interrupted")[0]).toMatchObject({
      type: "session.lost",
      payload: { reason: "interrupted", lastKnownSeq: 0 },
    });
  });
});

describe("CLI 兜底通道事件映射（message-level）", () => {
  it("meta 帧（system.version / session.resume_hint）→ 丢弃计数", () => {
    const mapper = makeMapper();
    expect(mapper.mapCliEvent({ role: "meta", type: "system.version", version: "2.3.1" })).toEqual([]);
    expect(mapper.mapCliEvent({ role: "meta", type: "session.resume_hint", session_id: "session_x" })).toEqual([]);
    expect(mapper.counters.snapshot()).toMatchObject({
      "drop.cli_meta.system.version": 1,
      "drop.cli_meta.session.resume_hint": 1,
    });
  });

  it("assistant content → message.started/delta/completed（granularity:message）", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_cli", "kimi-code/k3.1-pro");
    const events = mapper.mapCliEvent({ role: "assistant", content: "OK" });
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "message.started",
      "message.delta",
      "message.completed",
    ]);
    expect(events[2]?.payload).toMatchObject({ text: "OK", granularity: "message" });
  });

  it("assistant tool_calls → tool.started；tool 角色 → tool.completed", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_cli", "m");
    const started = mapper.mapCliEvent({
      role: "assistant",
      tool_calls: [{ type: "function", id: "tool_1", function: { name: "Read", arguments: '{"path":"a.txt"}' } }],
    });
    expect(started.map((event) => event.type)).toEqual(["turn.started", "tool.started"]);
    expect(started[1]?.payload).toMatchObject({ toolCallId: "tool_1", name: "Read" });

    const completed = mapper.mapCliEvent({ role: "tool", tool_call_id: "tool_1", content: "1\thello" });
    expect(completed.map((event) => event.type)).toEqual(["tool.completed"]);
    expect(completed[0]?.payload).toMatchObject({ outputDigest: digest("1\thello") });
  });

  it("进程退出 → turn.completed（rc=0 → end-turn）", () => {
    const mapper = makeMapper();
    mapper.beginTurn("turn_cli", "m");
    mapper.mapCliEvent({ role: "assistant", content: "OK" });
    const terminal = mapper.finishCliTurn(0);
    expect(terminal.map((event) => event.type)).toContain("turn.completed");
    expect(terminal.at(-1)?.payload).toMatchObject({ stopReason: "end-turn" });
  });

  it("未知 role/type → 计数不伪造", () => {
    const mapper = makeMapper();
    expect(mapper.mapCliEvent({ role: "weird" })).toEqual([]);
    expect(mapper.counters.snapshot()["drop.unknown_cli_role.weird"]).toBe(1);
  });
});

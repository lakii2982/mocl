import { describe, expect, it } from "vitest";
import { ClaudeEventMapper } from "../../../src/adapters/claude-code/events.ts";
import type { SdkMessage } from "../../../src/adapters/claude-code/types.ts";
import { loadMessages } from "./helpers.ts";

const TURN = "turn_1";
const SESSION = "0f7c1f0e-1111-4222-8333-944455556666";

interface Setup {
  readonly mapper: ClaudeEventMapper;
  readonly clock: { now: number };
}

function makeMapper(overrides: { onConversationReset?: (id: string) => void } = {}): Setup {
  const clock = { now: 1_000 };
  const mapper = new ClaudeEventMapper({
    resolveTurnId: (remote) => remote,
    now: () => clock.now,
    warningWindowMs: 5_000,
    ...(overrides.onConversationReset === undefined ? {} : { onConversationReset: overrides.onConversationReset }),
  });
  return { mapper, clock };
}

function withTurn(): ClaudeEventMapper {
  const { mapper } = makeMapper();
  mapper.createTurn(TURN);
  return mapper;
}

const init = (overrides: Record<string, unknown> = {}): SdkMessage =>
  ({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    claude_code_version: "2.1.310",
    cwd: "/tmp/work",
    model: "claude-sonnet-5",
    ...overrides,
  }) as SdkMessage;

describe("claude-code 消息 → ABI 事件（设计 §5.2）", () => {
  it("system/init → session.created（仅首次）；重复 init 只记诊断", () => {
    const { mapper } = makeMapper();
    const first = mapper.handleMessage(init());
    expect(first.map((event) => event.type)).toEqual(["session.created"]);
    expect(first[0]?.payload).toEqual({ state: "running", cwd: "/tmp/work" });
    const second = mapper.handleMessage(init());
    expect(second.map((event) => event.type)).toEqual(["diagnostic.log"]);
  });

  it("录制帧一轮成功：消息/工具/推理/用量/终态齐全且终态唯一", async () => {
    const mapper = withTurn();
    const messages = await loadMessages("turn-success");
    const events = messages.flatMap((message) => mapper.handleMessage(message));
    const types = events.map((event) => event.type);
    for (const expected of [
      "session.created",
      "message.started",
      "message.delta",
      "tool.started",
      "tool.progress",
      "tool.completed",
      "message.completed",
      "reasoning.summary",
      "usage.updated",
      "turn.completed",
    ]) {
      expect(types).toContain(expected);
    }
    const terminals = events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed");
    expect(terminals).toHaveLength(1);
    expect(types[types.length - 1]).toBe("turn.completed");
    const completed = terminals[0];
    expect(completed?.turnId).toBe(TURN);
    expect(completed?.payload).toMatchObject({
      stopReason: "end-turn",
      usage: { inputTokens: 12, outputTokens: 8, costUsd: 0.001, durationMs: 1234, estimated: false, scope: "turn" },
    });
    // 工具完成事件带 digest（tool_result）
    const toolCompleted = events.find((event) => event.type === "tool.completed");
    expect(toolCompleted?.payload).toMatchObject({ toolCallId: "toolu_1", status: "ok" });
    expect(String((toolCompleted?.payload as { outputDigest?: string }).outputDigest)).toMatch(/^[0-9a-f]{16}$/);
    // model 从 init/message_start 学得
    expect(events.find((event) => event.type === "message.delta")?.payload).toMatchObject({
      channel: "assistant",
      granularity: "token",
    });
  });

  it("成功终态判定：is_error=true / result 为空 / 纯空白 都不算成功", () => {
    for (const result of [
      { subtype: "success", is_error: true, result: "OK" },
      { subtype: "success", is_error: false, result: "" },
      { subtype: "success", is_error: false, result: "   " },
    ]) {
      const mapper = withTurn();
      const events = mapper.handleMessage({ type: "result", ...result } as unknown as SdkMessage);
      expect(events.some((event) => event.type === "turn.failed")).toBe(true);
      expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    }
  });

  it("error_during_execution + assistant rate_limit → quota.rate-limited", () => {
    const mapper = withTurn();
    mapper.handleMessage({
      type: "assistant",
      message: { id: "m", role: "assistant", content: [] },
      parent_tool_use_id: null,
      uuid: "m",
      error: "rate_limit",
    } as unknown as SdkMessage);
    const events = mapper.handleMessage({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "",
      errors: ["429"],
    } as unknown as SdkMessage);
    expect(events.find((event) => event.type === "turn.failed")?.payload).toMatchObject({
      error: { code: "quota.rate-limited", category: "quota" },
      partial: true,
    });
  });

  it("result 子类型映射：max_turns/max_budget → limit.budget-exceeded；structured retries → protocol.invalid-params", () => {
    const cases: Record<string, string> = {
      error_max_turns: "limit.budget-exceeded",
      error_max_budget_usd: "limit.budget-exceeded",
      error_max_structured_output_retries: "protocol.invalid-params",
      error_during_execution: "backend.internal-error",
    };
    for (const [subtype, code] of Object.entries(cases)) {
      const mapper = withTurn();
      const events = mapper.handleMessage({ type: "result", subtype, is_error: true, errors: [subtype] } as unknown as SdkMessage);
      expect(events.find((event) => event.type === "turn.failed")?.payload).toMatchObject({ error: { code } });
    }
  });

  it("markInterrupted 后 result → turn.aborted（native）", () => {
    const mapper = withTurn();
    mapper.markInterrupted(TURN);
    const events = mapper.handleMessage({ type: "result", subtype: "success", is_error: false, result: "OK" } as unknown as SdkMessage);
    expect(events.some((event) => event.type === "turn.aborted")).toBe(true);
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
  });

  it("tool_result(is_error) → tool.completed status=error；thinking → reasoning.summary", () => {
    const mapper = withTurn();
    const tool = mapper.handleMessage({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true }] },
      parent_tool_use_id: null,
      uuid: "u",
    } as unknown as SdkMessage);
    expect(tool[0]?.payload).toMatchObject({ toolCallId: "toolu_2", status: "error" });
    const assistant = mapper.handleMessage({
      type: "assistant",
      message: { id: "m3", role: "assistant", content: [{ type: "thinking", thinking: "reasoning text" }] },
      parent_tool_use_id: null,
      uuid: "m3",
    } as unknown as SdkMessage);
    expect(assistant[0]?.type).toBe("reasoning.summary");
    expect(assistant[0]?.payload).toEqual({ text: "reasoning text" });
  });

  it("子代理 task_* → child.spawned/state-changed/completed（深度是一等字段）", () => {
    const mapper = withTurn();
    const spawned = mapper.handleMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task_1",
      description: "explore",
      spawn_depth: 1,
    } as unknown as SdkMessage);
    expect(spawned[0]).toMatchObject({
      type: "child.spawned",
      payload: { childSessionId: "task_1", nativeAgentId: "task_1", name: "explore", depth: 1 },
    });
    const updated = mapper.handleMessage({ type: "system", subtype: "task_updated", task_id: "task_1", patch: { status: "failed" } } as unknown as SdkMessage);
    expect(updated[0]).toMatchObject({ type: "child.state-changed", payload: { childSessionId: "task_1", state: "failed" } });
    const done = mapper.handleMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task_1",
      status: "completed",
      summary: "explored",
    } as unknown as SdkMessage);
    expect(done[0]).toMatchObject({ type: "child.completed", payload: { childSessionId: "task_1", status: "ok", summary: "explored" } });
  });

  it("permission_denied → permission.resolved（deny/by policy）", () => {
    const mapper = withTurn();
    const events = mapper.handleMessage({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Write",
      tool_use_id: "toolu_3",
      decision_reason: "mode says no",
    } as unknown as SdkMessage);
    expect(events).toEqual([
      {
        type: "permission.resolved",
        payload: { requestId: "toolu_3", decision: "deny", by: "policy", reason: "mode says no" },
      },
    ]);
  });

  it("rate_limit_event：out_of_credits → usage-exhausted；rejected → rate-limited；allowed → 提示", () => {
    const mapper = withTurn();
    const exhausted = mapper.handleMessage({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", overageDisabledReason: "out_of_credits" },
    } as unknown as SdkMessage);
    expect(exhausted[0]?.payload).toMatchObject({ code: "quota.usage-exhausted" });
    const limited = mapper.handleMessage({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } } as unknown as SdkMessage);
    expect(limited[0]?.payload).toMatchObject({ code: "quota.rate-limited" });
    const warning = mapper.handleMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } } as unknown as SdkMessage);
    expect(warning[0]?.payload).toMatchObject({ code: "rate-limit-warning" });
  });

  it("status/compact/api_retry/session_state/worker_shutting_down 的系统事件映射", () => {
    const mapper = withTurn();
    expect(mapper.handleMessage({ type: "system", subtype: "status", status: "compacting" } as unknown as SdkMessage)[0]?.payload).toMatchObject({
      code: "context-compacting",
    });
    expect(mapper.handleMessage({ type: "system", subtype: "status", status: "requesting" } as unknown as SdkMessage)[0]).toMatchObject({
      type: "session.state-changed",
      payload: { state: "awaiting-input" },
    });
    expect(
      mapper.handleMessage({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 10, post_tokens: 2 } } as unknown as SdkMessage)[0]?.payload,
    ).toMatchObject({ code: "context-compacted" });
    expect(mapper.handleMessage({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: 10, error: "rate_limit" } as unknown as SdkMessage)[0]?.payload).toMatchObject({
      code: "api-retry",
    });
    expect(mapper.handleMessage({ type: "system", subtype: "session_state_changed", state: "requires_action" } as unknown as SdkMessage)[0]).toMatchObject({
      type: "session.state-changed",
      payload: { state: "awaiting-input" },
    });
    expect(mapper.handleMessage({ type: "system", subtype: "worker_shutting_down", reason: "restart" } as unknown as SdkMessage)[0]).toMatchObject({
      type: "session.lost",
      payload: { reason: "restart", lastKnownSeq: 0 },
    });
  });

  it("model_refusal_no_fallback → turn.failed policy.permission-denied；fallback → warning", () => {
    const refuser = withTurn();
    expect(
      refuser.handleMessage({ type: "system", subtype: "model_refusal_no_fallback", original_model: "claude-opus-5" } as unknown as SdkMessage)[0],
    ).toMatchObject({ type: "turn.failed", payload: { error: { code: "policy.permission-denied" } } });
    const fallbacker = withTurn();
    expect(
      fallbacker.handleMessage({ type: "system", subtype: "model_refusal_fallback", original_model: "a", fallback_model: "b" } as unknown as SdkMessage)[0]?.payload,
    ).toMatchObject({ code: "model-refusal-fallback" });
  });

  it("thinking_tokens/tool_progress → usage.updated(estimated)/tool.progress", () => {
    const mapper = withTurn();
    const usage = mapper.handleMessage({ type: "system", subtype: "thinking_tokens", estimated_tokens: 42 } as unknown as SdkMessage);
    expect(usage[0]?.payload).toMatchObject({ usage: { reasoningTokens: 42, estimated: true, scope: "turn" } });
    const progress = mapper.handleMessage({
      type: "tool_progress",
      tool_use_id: "toolu_4",
      tool_name: "Bash",
      elapsed_time_seconds: 3,
    } as unknown as SdkMessage);
    expect(progress[0]?.payload).toMatchObject({ toolCallId: "toolu_4", text: "Bash running 3s" });
  });

  it("未知消息 → 丢弃 + 计数 + 节流 warning（窗口内 1 条，过后再 1 条）", () => {
    const { mapper, clock } = makeMapper();
    const first = mapper.handleMessage({ type: "totally_unknown", x: 1 } as unknown as SdkMessage);
    expect(first.map((event) => event.type)).toEqual(["session.warning"]);
    expect(first[0]?.payload).toMatchObject({ code: "adapter.event-dropped" });
    expect(mapper.handleMessage({ type: "prompt_suggestion", suggestion: "x" } as unknown as SdkMessage)).toEqual([]);
    expect(mapper.droppedTotal).toBeGreaterThanOrEqual(2);
    clock.now += 5_001;
    expect(mapper.handleMessage({ type: "local_command_output" } as unknown as SdkMessage)[0]?.type).toBe("session.warning");
  });

  it("终态后到达的 result 静默丢弃（EV-4），不改变已发终态", () => {
    const mapper = withTurn();
    mapper.handleMessage({ type: "result", subtype: "success", is_error: false, result: "OK" } as unknown as SdkMessage);
    const late = mapper.handleMessage({ type: "result", subtype: "success", is_error: false, result: "LATE" } as unknown as SdkMessage);
    expect(late).toEqual([]);
    expect(mapper.droppedTotal).toBe(1); // 静默丢弃（不产生任何事件）
  });

  it("conversation_reset → warning + 回调更新会话 id", () => {
    const seen: string[] = [];
    const { mapper } = makeMapper({ onConversationReset: (id) => seen.push(id) });
    mapper.createTurn(TURN);
    const events = mapper.handleMessage({ type: "conversation_reset", new_conversation_id: "new-session-id" } as unknown as SdkMessage);
    expect(events[0]?.payload).toMatchObject({ code: "conversation-reset" });
    expect(seen).toEqual(["new-session-id"]);
    expect(mapper.sessionId).toBe("new-session-id");
  });

  it("diagnostic() 产出 schema 必填字段（level/message/component）", () => {
    const { mapper } = makeMapper();
    expect(mapper.diagnostic("info", "hello")).toEqual({
      type: "diagnostic.log",
      payload: { level: "info", message: "hello", component: "adapter.claude-code" },
    });
  });
});

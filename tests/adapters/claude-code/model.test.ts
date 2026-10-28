/**
 * W4（issue #20）：claude-code 实际模型上报。
 *
 * 链路：`system/init.model`（或 `message_start.model`）→ 映射器 `#model` →
 * 每轮首个轮内事件前的 `turn.started.model` → facade `runtime.model`（modelSource=reported）。
 * facade 层验收见 `tests/facade/claude-model.test.ts`。
 *
 * 纪律（W4 §3）：拿不到模型 → 空串（facade 不记 reported），不编造占位值；
 * 只补 `turn.started`，不改变既有事件的相对顺序与丢弃计数。
 */
import { describe, expect, it } from "vitest";
import { ClaudeEventMapper } from "../../../src/adapters/claude-code/events.ts";
import type { SdkMessage } from "../../../src/adapters/claude-code/types.ts";
import { collectEvents, handshake, loadMessages, makeHarness, makeWorkdir, openSession, tick } from "./helpers.ts";

const TURN = "turn_1";
const SESSION = "0f7c1f0e-1111-4222-8333-944455556666";

function makeMapper(): ClaudeEventMapper {
  // 配置 model 缺省（生产 `model:null` 场景）：模型只能来自 init / message_start 实测。
  return new ClaudeEventMapper({
    resolveTurnId: (remote) => remote,
    now: () => 1_000,
    warningWindowMs: 5_000,
  });
}

const init = (overrides: Record<string, unknown> = {}): SdkMessage =>
  ({
    type: "system",
    subtype: "init",
    session_id: SESSION,
    claude_code_version: "2.1.310",
    cwd: "/tmp/work",
    model: "claude-opus-5",
    ...overrides,
  }) as SdkMessage;

const assistantText = (text: string): SdkMessage =>
  ({
    type: "assistant",
    message: { id: "m1", role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid: "m1",
  }) as SdkMessage;

const successResult = (): SdkMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "OK" }) as unknown as SdkMessage;

const messageStart = (model: string | undefined): SdkMessage =>
  ({
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg_1", role: "assistant", model, content: [] } },
    parent_tool_use_id: null,
    uuid: "u1",
  }) as unknown as SdkMessage;

function modelOf(event: ReturnType<ClaudeEventMapper["handleMessage"]>[number] | undefined): string {
  return (event?.payload as { model?: string }).model ?? "";
}

describe("W4：claude-code turn.started.model 实测上报", () => {
  it("system/init 的 model → 后续首个轮内事件以 turn.started{model} 开头（W4 验收序列）", () => {
    const mapper = makeMapper();
    mapper.createTurn(TURN);
    expect(mapper.handleMessage(init()).map((event) => event.type)).toEqual(["session.created"]);
    const events = mapper.handleMessage(assistantText("hi"));
    expect(events.map((event) => event.type)).toEqual(["turn.started", "message.completed"]);
    expect(events[0]?.turnId).toBe(TURN);
    expect(events[0]?.payload).toEqual({ model: "claude-opus-5", delivery: "caller" });
  });

  it("每轮恰一条：第二轮补新 turn.started；首条之后不再重复", () => {
    const mapper = makeMapper();
    mapper.handleMessage(init());
    mapper.createTurn("turn_a");
    const first = mapper.handleMessage(assistantText("a"));
    expect(first.map((event) => event.type)).toEqual(["turn.started", "message.completed"]);
    // 首轮终态（此前已有 turn.started → 不再补）
    mapper.handleMessage(successResult());
    // 第二轮：重新补一条
    mapper.createTurn("turn_b");
    const second = mapper.handleMessage(assistantText("b"));
    expect(second.map((event) => event.type)).toEqual(["turn.started", "message.completed"]);
    expect(modelOf(second[0])).toBe("claude-opus-5");
    expect(second[0]?.turnId).toBe("turn_b");
  });

  it("init 无 model（配置 null 且 init 缺字段）→ turn.started.model 为空串，不编造", () => {
    const mapper = makeMapper();
    mapper.createTurn(TURN);
    mapper.handleMessage(init({ model: undefined }));
    const events = mapper.handleMessage(assistantText("hi"));
    expect(events[0]?.type).toBe("turn.started");
    expect(events[0]?.payload).toEqual({ model: "", delivery: "caller" });
  });

  it("message_start 实测 model 学入映射器：下一轮 turn.started 用流内值", () => {
    const mapper = makeMapper();
    mapper.createTurn(TURN);
    mapper.handleMessage(init({ model: "claude-opus-5" }));
    const stream = mapper.handleMessage(messageStart("claude-fallback-3"));
    expect(stream.map((event) => event.type)).toEqual(["turn.started", "message.started"]);
    expect(modelOf(stream[0])).toBe("claude-opus-5"); // 本轮 turn.started 用 init 值
    mapper.handleMessage(successResult());
    mapper.createTurn("turn_2");
    const second = mapper.handleMessage(assistantText("again"));
    expect(modelOf(second[0])).toBe("claude-fallback-3"); // 下一轮用 message_start 学到的值
  });

  it("result 兜底：整轮无过程事件时在 usage/终态前补 turn.started", () => {
    const mapper = makeMapper();
    mapper.createTurn(TURN);
    mapper.handleMessage(init());
    const events = mapper.handleMessage(successResult());
    expect(events.map((event) => event.type)).toEqual(["turn.started", "usage.updated", "turn.completed"]);
    expect(modelOf(events[0])).toBe("claude-opus-5");
  });

  it("纯 thinking 的 assistant 批次不触发 turn.started（保持既有顺序断言）", () => {
    const mapper = makeMapper();
    mapper.createTurn(TURN);
    mapper.handleMessage(init());
    const thinkingOnly = mapper.handleMessage({
      type: "assistant",
      message: { id: "m2", role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
      parent_tool_use_id: null,
      uuid: "m2",
    } as unknown as SdkMessage);
    expect(thinkingOnly.map((event) => event.type)).toEqual(["reasoning.summary"]);
  });

  it("录制帧 turn-success：turn.started 先于轮内事件、恰一条、model 取 init 实测", async () => {
    const mapper = makeMapper();
    mapper.createTurn(TURN);
    const messages = await loadMessages("turn-success");
    const events = messages.flatMap((message) => mapper.handleMessage(message));
    const startedIndex = events.findIndex((event) => event.type === "turn.started");
    const messageStartedIndex = events.findIndex((event) => event.type === "message.started");
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeLessThan(messageStartedIndex);
    expect(modelOf(events[startedIndex])).toBe("claude-sonnet-5");
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(events[events.length - 1]?.type).toBe("turn.completed");
  });

  it("适配器链路：open→send→init(model)→result 后事件流含 turn.started{model}（readLoop 实测注入）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      // model:null：证明 turn.started.model 只来自 init 实测，而非配置
      const harness = makeHarness({ adapter: { model: null } });
      const opened = await openSession(harness, { cwd: dir });
      const sending = harness.adapter.send({
        sessionId: opened.sessionId,
        remoteSessionId: opened.remoteSessionId,
        input: [{ type: "text", text: "hello" }],
        idempotencyKey: "w4-1",
      });
      await tick();
      await handshake(harness); // helpers 默认 init.model = "claude-sonnet-5"
      await sending;
      harness.queries[0]?.push(successResult());
      const events = await collectEvents(harness.adapter, { until: (event) => event.type === "turn.completed" });
      const started = events.find((event) => event.type === "turn.started");
      expect(started).toBeDefined();
      expect(started?.payload).toMatchObject({ model: "claude-sonnet-5", delivery: "caller" });
      const completedIndex = events.findIndex((event) => event.type === "turn.completed");
      const startedIndex = events.findIndex((event) => event.type === "turn.started");
      expect(startedIndex).toBeGreaterThanOrEqual(0);
      expect(startedIndex).toBeLessThan(completedIndex);
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });
});

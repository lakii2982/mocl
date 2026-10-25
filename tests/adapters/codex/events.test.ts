import { describe, expect, it } from "vitest";
import { CodexEventMapper, parseUnifiedDiff } from "../../../src/adapters/codex/events.ts";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";

const THREAD = "thread-1";
const REMOTE_TURN = "remote-turn-1";

interface MapperSetup {
  readonly mapper: CodexEventMapper;
  readonly clock: { now: number };
}

function makeMapper(): MapperSetup {
  const clock = { now: 1_000 };
  const mapper = new CodexEventMapper({
    resolveTurnId: (remoteTurnId) => `turn_abi_${remoteTurnId}`,
    model: "gpt-6-astra",
    now: () => clock.now,
    warningWindowMs: 5_000,
  });
  return { mapper, clock };
}

const base = { threadId: THREAD, turnId: REMOTE_TURN };

function feed(mapper: CodexEventMapper, method: string, params: Record<string, unknown>): AdapterEvent[] {
  return mapper.handleNotification({ method, params: { ...base, ...params } });
}

function started(mapper: CodexEventMapper): void {
  feed(mapper, "turn/started", { turn: { id: REMOTE_TURN, status: "inProgress" } });
}

describe("codex 通知 → ABI 事件映射（设计 §5.2）", () => {
  it("turn/started → turn.started（model/delivery 必填）", () => {
    const { mapper } = makeMapper();
    const events = feed(mapper, "turn/started", { turn: { id: REMOTE_TURN, status: "inProgress" } });
    expect(events).toEqual([
      { type: "turn.started", turnId: `turn_abi_${REMOTE_TURN}`, payload: { model: "gpt-6-astra", delivery: "caller" } },
    ]);
    // 重复 turn/started 不再发（幂等）
    expect(feed(mapper, "turn/started", { turn: { id: REMOTE_TURN, status: "inProgress" } })).toEqual([]);
  });

  it("agentMessage：started → delta×2 → completed（completed 是权威文本）", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const events = [
      ...feed(mapper, "item/started", { item: { id: "item_m1", type: "agentMessage", text: "" } }),
      ...feed(mapper, "item/agentMessage/delta", { itemId: "item_m1", delta: "OK" }),
      ...feed(mapper, "item/agentMessage/delta", { itemId: "item_m1", delta: "!" }),
      ...feed(mapper, "item/completed", { item: { id: "item_m1", type: "agentMessage", text: "OK!" } }),
    ];
    expect(events.map((e) => e.type)).toEqual(["message.started", "message.delta", "message.delta", "message.completed"]);
    expect(events[0]?.payload).toEqual({ channel: "assistant", messageId: "item_m1" });
    expect(events[1]?.payload).toMatchObject({ channel: "assistant", text: "OK", granularity: "token", messageId: "item_m1" });
    expect(events[3]?.payload).toEqual({ channel: "assistant", text: "OK!", messageId: "item_m1" });
  });

  it("reasoning：textDelta → reasoning.delta；summary 片段累积 → reasoning.summary", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const first = feed(mapper, "item/reasoning/textDelta", { itemId: "item_r1", contentIndex: 0, delta: "思考" });
    expect(first[0]?.type).toBe("reasoning.delta");
    feed(mapper, "item/reasoning/summaryTextDelta", { itemId: "item_r2", summaryIndex: 0, delta: "先读" });
    feed(mapper, "item/reasoning/summaryTextDelta", { itemId: "item_r2", summaryIndex: 0, delta: "再改" });
    const part = feed(mapper, "item/reasoning/summaryPartAdded", { itemId: "item_r2", summaryIndex: 0 });
    expect(part).toEqual([
      { type: "reasoning.summary", turnId: `turn_abi_${REMOTE_TURN}`, payload: { text: "先读再改" } },
    ]);
  });

  it("commandExecution：started/progress/completed（exitCode=0 → ok，带 digest）", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const events = [
      ...feed(mapper, "item/started", {
        item: { id: "item_c1", type: "commandExecution", command: "echo hi", commandActions: [], cwd: "/tmp", status: "inProgress" },
      }),
      ...feed(mapper, "item/commandExecution/outputDelta", { itemId: "item_c1", delta: "hi\n" }),
      ...feed(mapper, "item/commandExecution/terminalInteraction", { itemId: "item_c1", stdin: "y\n" }),
      ...feed(mapper, "item/completed", {
        item: { id: "item_c1", type: "commandExecution", command: "echo hi", commandActions: [], cwd: "/tmp", status: "completed", exitCode: 0, aggregatedOutput: "hi\n" },
      }),
    ];
    expect(events.map((e) => e.type)).toEqual(["tool.started", "tool.progress", "tool.progress", "tool.completed"]);
    expect(events[0]?.payload).toMatchObject({ toolCallId: "item_c1", name: "commandExecution", kind: "execute" });
    expect(events[1]?.payload).toMatchObject({ toolCallId: "item_c1", text: "hi\n" });
    expect(events[3]?.payload).toMatchObject({ toolCallId: "item_c1", status: "ok" });
    expect(String((events[3]?.payload as { outputDigest?: string }).outputDigest)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("commandExecution 非零退出码 → tool.completed status=error；declined → denied", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const failed = feed(mapper, "item/completed", {
      item: { id: "item_c2", type: "commandExecution", command: "false", commandActions: [], cwd: "/tmp", status: "completed", exitCode: 2, aggregatedOutput: "" },
    });
    expect(failed[0]?.payload).toMatchObject({ status: "error" });
    const denied = feed(mapper, "item/completed", {
      item: { id: "item_c3", type: "commandExecution", command: "rm", commandActions: [], cwd: "/tmp", status: "declined" },
    });
    expect(denied[0]?.payload).toMatchObject({ status: "denied" });
  });

  it("turn/plan/updated → plan.updated（status 映射到 schema 的 in-progress）", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const events = feed(mapper, "turn/plan/updated", {
      plan: [
        { step: "读代码", status: "completed" },
        { step: "改代码", status: "inProgress" },
        { step: "跑测试", status: "pending" },
      ],
    });
    expect(events[0]?.type).toBe("plan.updated");
    expect(events[0]?.payload).toEqual({
      steps: [
        { id: "p1", title: "读代码", status: "completed" },
        { id: "p2", title: "改代码", status: "in-progress" },
        { id: "p3", title: "跑测试", status: "pending" },
      ],
    });
  });

  it("item/fileChange/patchUpdated → diff.updated（kind→schema status）", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const events = feed(mapper, "item/fileChange/patchUpdated", {
      itemId: "item_f1",
      changes: [
        { path: "src/a.ts", kind: { type: "update" }, diff: "+x" },
        { path: "src/b.ts", kind: { type: "add" }, diff: "+y" },
        { path: "src/c.ts", kind: { type: "delete" }, diff: "-z" },
        { path: "src/d.ts", kind: { type: "update", move_path: "src/e.ts" }, diff: "" },
      ],
    });
    expect(events[0]?.payload).toEqual({
      files: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/b.ts", status: "added" },
        { path: "src/c.ts", status: "deleted" },
        { path: "src/d.ts", status: "renamed" },
      ],
    });
    // 同一 item 再发 completed 时不重复 diff（§5.5 去重）
    const after = feed(mapper, "item/completed", {
      item: {
        id: "item_f1",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "+x" }],
      },
    });
    expect(after.map((e) => e.type)).toEqual(["tool.completed"]);
  });

  it("turn/diff/updated：解析统一 diff，重复指纹去重", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/new.ts b/new.ts\nnew file mode 100644\n";
    const first = feed(mapper, "turn/diff/updated", { diff });
    expect(first[0]?.type).toBe("diff.updated");
    expect(first[0]?.payload).toMatchObject({
      files: [
        { path: "src/a.ts", status: "modified" },
        { path: "new.ts", status: "added" },
      ],
    });
    expect(String((first[0]?.payload as { patchDigest?: string }).patchDigest)).toMatch(/^[0-9a-f]{16}$/);
    expect(feed(mapper, "turn/diff/updated", { diff })).toEqual([]);
  });

  it("thread/tokenUsage/updated → usage.updated（turn + session 两个 scope）", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const events = feed(mapper, "thread/tokenUsage/updated", {
      tokenUsage: {
        last: { inputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5, cachedInputTokens: 0, totalTokens: 35 },
        total: { inputTokens: 100, outputTokens: 200, reasoningOutputTokens: 50, cachedInputTokens: 0, totalTokens: 350 },
        modelContextWindow: 100_000,
      },
    });
    expect(events.map((e) => e.type)).toEqual(["usage.updated", "usage.updated"]);
    expect(events[0]?.payload).toEqual({
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5, estimated: false, scope: "turn" },
    });
    expect(events[1]?.payload).toEqual({
      usage: { inputTokens: 100, outputTokens: 200, reasoningTokens: 50, estimated: false, scope: "session" },
    });
  });

  it("turn/completed(completed) → turn.completed，且 usage 来自 tokenUsage（非估算）", () => {
    const { mapper } = makeMapper();
    started(mapper);
    feed(mapper, "thread/tokenUsage/updated", {
      tokenUsage: { last: { inputTokens: 1, outputTokens: 2, reasoningOutputTokens: 3 } },
    });
    const events = feed(mapper, "turn/completed", { turn: { id: REMOTE_TURN, status: "completed", items: [] } });
    expect(events[0]?.type).toBe("turn.completed");
    expect(events[0]?.payload).toMatchObject({
      stopReason: "end-turn",
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3, estimated: false, scope: "turn" },
    });
  });

  it("turn/completed(failed) + codexErrorInfo → turn.failed 的 ABI 错误码", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const events = feed(mapper, "turn/completed", {
      turn: { id: REMOTE_TURN, status: "failed", error: { message: "slow down", codexErrorInfo: "rateLimitExceeded" }, items: [] },
    });
    expect(events[0]?.type).toBe("turn.failed");
    expect(events[0]?.payload).toMatchObject({
      partial: true,
      error: { code: "quota.rate-limited", category: "quota", retryable: "backoff" },
    });
  });

  it("turn/completed(interrupted) → turn.aborted（interruptMethod=native）", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const events = feed(mapper, "turn/completed", { turn: { id: REMOTE_TURN, status: "interrupted", items: [] } });
    expect(events[0]).toMatchObject({ type: "turn.aborted", payload: { interruptMethod: "native", partial: true } });
  });

  it("error 通知：轮未终结 → turn.failed；轮已终结 → session.warning（不重复终态）", () => {
    const { mapper } = makeMapper();
    started(mapper);
    const failed = feed(mapper, "error", { message: "internal boom", codexErrorInfo: "internalServerError" });
    expect(failed[0]?.type).toBe("turn.failed");
    expect(failed[0]?.payload).toMatchObject({ error: { code: "backend.internal-error" } });
    const late = feed(mapper, "error", { message: "late error" });
    expect(late[0]?.type).toBe("session.warning");
    expect(late[0]?.payload).toMatchObject({ code: "backend-error", degrade: true });
  });

  it("终态之后的事件一律丢弃（EV-4）", () => {
    const { mapper } = makeMapper();
    started(mapper);
    feed(mapper, "turn/completed", { turn: { id: REMOTE_TURN, status: "completed", items: [] } });
    expect(feed(mapper, "item/agentMessage/delta", { itemId: "m", delta: "LATE" })).toEqual([]);
    expect(feed(mapper, "item/completed", { item: { id: "m", type: "agentMessage", text: "late" } })).toEqual([]);
    expect(feed(mapper, "turn/completed", { turn: { id: REMOTE_TURN, status: "completed", items: [] } })).toEqual([]);
  });

  it("无映射事件 → 丢弃 + 计数 + 节流 session.warning（窗口内只 1 条）", () => {
    const { mapper, clock } = makeMapper();
    started(mapper);
    const first = feed(mapper, "item/plan/delta", { itemId: "p", delta: "x" });
    expect(first.map((e) => e.type)).toEqual(["session.warning"]);
    expect(first[0]?.payload).toMatchObject({ code: "adapter.event-dropped", degrade: true });
    const second = feed(mapper, "thread/name/updated", { name: "demo" });
    expect(second).toEqual([]); // 窗口内节流
    expect(mapper.droppedCounts()).toMatchObject({ "item/plan/delta": 1, "thread/name/updated": 1 });
    clock.now += 5_001;
    const third = feed(mapper, "thread/name/updated", { name: "demo2" });
    expect(third.map((e) => e.type)).toEqual(["session.warning"]);
    expect(mapper.warningCount).toBe(2);
  });

  it("缺少必要字段的通知 → 丢弃计数（不抛异常、不伪造事件）", () => {
    const { mapper } = makeMapper();
    const events = mapper.handleNotification({ method: "item/agentMessage/delta", params: { threadId: THREAD } });
    expect(events.map((event) => event.type)).toEqual(["session.warning"]); // 只告警，不伪造 message.* 事件
    expect(mapper.droppedTotal).toBeGreaterThan(0);
  });

  it("parseUnifiedDiff 覆盖 modified/added/deleted/renamed", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "diff --git a/b.ts b/b.ts",
      "new file mode 100644",
      "diff --git a/c.ts b/c.ts",
      "deleted file mode 100644",
      "diff --git a/d.ts b/e.ts",
      "rename from d.ts",
      "rename to e.ts",
    ].join("\n");
    expect(parseUnifiedDiff(diff).map((f) => f.status)).toEqual(["modified", "added", "deleted", "renamed"]);
  });

  it("diagnostic() 产出 schema 必填字段齐全的 diagnostic.log", () => {
    const { mapper } = makeMapper();
    const event = mapper.diagnostic("warn", "something happened");
    expect(event).toEqual({
      type: "diagnostic.log",
      payload: { level: "warn", message: "something happened", component: "adapter.codex" },
    });
  });
});

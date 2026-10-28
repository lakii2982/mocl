/**
 * W4（issue #20）：codex 实际模型上报。
 *
 * 链路：`thread/start` 响应 `model`（适配器 open() 已捕获 → `mapper.setModel`）/
 * `thread/resume` 响应 `model`（W4 补：同步进映射器）/ `turn/started` 通知自带
 * `turn.model` → `turn.started.model` → facade `runtime.model`（modelSource=reported）。
 *
 * 纪律（W4 §3）：全部来源都拿不到 → `model:""`（facade 不记 reported），不编造
 * `"unspecified"` 之类占位值。
 */
import { describe, expect, it } from "vitest";
import { CodexEventMapper } from "../../../src/adapters/codex/events.ts";
import type { ScriptDirective } from "./helpers.ts";
import { collectEvents, handshakeDirectives, makeHarness, makeWorkdir } from "./helpers.ts";

const THREAD = "01a1thread000000000000000001";

function makeMapper(model?: string | null): CodexEventMapper {
  return new CodexEventMapper({
    resolveTurnId: (remoteTurnId) => `turn_abi_${remoteTurnId}`,
    ...(model === undefined ? {} : { model }),
    now: () => 1_000,
    warningWindowMs: 5_000,
  });
}

function feed(mapper: CodexEventMapper, method: string, params: Record<string, unknown>) {
  return mapper.handleNotification({ method, params: { threadId: THREAD, ...params } });
}

function modelOf(payload: unknown): string {
  return (payload as { model?: string }).model ?? "";
}

describe("W4：codex turn.started.model 实测上报", () => {
  it("thread/start 响应实测模型（setModel 注入）→ turn.started.model", () => {
    const mapper = makeMapper(); // options.model 缺省：模型只能来自 open() 的实测注入
    mapper.setModel("gpt-5.1-codex");
    const events = feed(mapper, "turn/started", { turn: { id: "remote-w4", status: "inProgress" } });
    expect(events).toEqual([
      { type: "turn.started", turnId: "turn_abi_remote-w4", payload: { model: "gpt-5.1-codex", delivery: "caller" } },
    ]);
  });

  it("映射器无模型时回退 turn 通知自带的 model 字段", () => {
    const mapper = makeMapper();
    const events = feed(mapper, "turn/started", {
      turn: { id: "remote-w4", status: "inProgress", model: "gpt-5.1-codex-mini" },
    });
    expect(events).toHaveLength(1);
    expect(modelOf(events[0]?.payload)).toBe("gpt-5.1-codex-mini");
  });

  it("全部来源都拿不到 → model 为空串（不编造占位值）", () => {
    const mapper = makeMapper();
    const events = feed(mapper, "turn/started", { turn: { id: "remote-w4", status: "inProgress" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ model: "", delivery: "caller" });
  });

  it("适配器链路：open() 捕获 thread/start 响应 model → 通知触发 turn.started.model", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      // handshakeDirectives 的 thread/start 回复自带 model:"gpt-6-astra"（实测帧）
      const harness = makeHarness({ script: handshakeDirectives(), adapter: { requestTimeoutMs: 500 } });
      await harness.adapter.open({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9W401", cwd: dir, epoch: 1 });
      harness.child.emitFrame({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: THREAD, turnId: "remote-w4-open", turn: { id: "remote-w4-open", status: "inProgress" } },
      });
      const events = await collectEvents(harness.adapter, { until: (event) => event.type === "turn.started" });
      const started = events.find((event) => event.type === "turn.started");
      expect(started?.payload).toMatchObject({ model: "gpt-6-astra", delivery: "caller" });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("resume 路径：thread/resume 响应 model 同步进映射器 → 后续 turn.started 用实测值", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      // thread/start 回复刻意不带 model：证明 resume 实测值是唯一来源
      const script: ScriptDirective[] = [
        ...handshakeDirectives().slice(0, 2),
        { on: "request", method: "thread/start", reply: { thread: { id: THREAD, cliVersion: "0.164.0" } } },
        { on: "request", method: "thread/read", reply: { thread: { id: THREAD } } },
        { on: "request", method: "thread/resume", reply: { thread: { id: THREAD }, model: "gpt-5.5-resumed" } },
      ];
      const harness = makeHarness({ script, adapter: { requestTimeoutMs: 500 } });
      await harness.adapter.open({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9W402", cwd: dir, epoch: 1 });
      const resumed = await harness.adapter.resume({
        sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9W402",
        remoteSessionId: THREAD,
        fromSeq: 0,
      });
      expect(resumed).toEqual({ exists: true, remoteSessionId: THREAD });
      harness.child.emitFrame({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: THREAD, turnId: "remote-w4-resume", turn: { id: "remote-w4-resume", status: "inProgress" } },
      });
      const events = await collectEvents(harness.adapter, { until: (event) => event.type === "turn.started" });
      const started = events.find((event) => event.type === "turn.started");
      expect(started?.payload).toMatchObject({ model: "gpt-5.5-resumed", delivery: "caller" });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });
});

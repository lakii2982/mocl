/**
 * W4（issue #20）：kimi 实际模型上报（验证性回归；链路已存在，锁定不回退）。
 *
 * 链路：`session/new` 响应 `configOptions[id=="model"].currentValue` → `state.model`
 * （`#spawnSession`）→ `send()` 里 `beginTurn(turnId, state.model)` →
 * `turn.started.model` → facade `runtime.model`（modelSource=reported）。
 */
import { describe, expect, it } from "vitest";
import { KimiEventMapper } from "../../../src/adapters/kimi/events.ts";
import { KimiAdapter, type KimiAdapterOptions, type KimiProcessSpec } from "../../../src/adapters/kimi/index.ts";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import { configProbe, drainUntil, fakeProcessFactory, fixedRuntime, type FakeProcess } from "./helpers.ts";

describe("W4：kimi turn.started.model 实测上报", () => {
  it("映射器：beginTurn(model) → 首个轮内事件以 turn.started{model} 开头", () => {
    const mapper = new KimiEventMapper({ sessionId: "s1", cwd: "/tmp/work", expectedProfile: "read-only" });
    mapper.beginTurn("turn_w4", "kimi-code/k3.1-pro");
    const events = mapper.mapAcpUpdate({
      sessionId: "session_x",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
    });
    expect(events.map((event) => event.type)).toEqual(["turn.started", "message.started", "message.delta"]);
    expect(events[0]?.turnId).toBe("turn_w4");
    expect(events[0]?.payload).toEqual({ model: "kimi-code/k3.1-pro", delivery: "caller" });
  });

  it("适配器链路：session/new 的 configOptions[model].currentValue → state.model → turn.started.model", async () => {
    const processes = fakeProcessFactory();
    // 在进程创建瞬间改写 session/new 结果：configOptions 报 deepseek（实测字段形状）
    const factory = (spec: KimiProcessSpec): FakeProcess => {
      const process = processes.factory(spec);
      process.acp.newSessionResult = {
        ...process.acp.newSessionResult,
        configOptions: [
          { id: "model", currentValue: "deepseek/deepseek-flash" },
          { id: "thinking", currentValue: "high" },
          { id: "mode", currentValue: "default" },
        ],
      };
      return process;
    };
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: factory,
      configProbe: configProbe("auto"),
      allowedRoots: ["/tmp/work"],
    } satisfies KimiAdapterOptions);
    try {
      const openResult = await adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 });
      await drainUntil(adapter.events(), (accumulated) =>
        accumulated.some((event) => event.type === "session.state-changed"),
      );
      await adapter.send({
        sessionId: "s1",
        remoteSessionId: openResult.remoteSessionId,
        input: [{ type: "text", text: "只回复 OK" }],
        idempotencyKey: "w4-1",
      });
      const events = await drainUntil(adapter.events(), (accumulated: readonly AdapterEvent[]) =>
        accumulated.some((event) => event.type === "turn.completed"),
      );
      const started = events.find((event) => event.type === "turn.started");
      expect(started).toBeDefined();
      // configOptions 实测值（deepseek）覆盖初始默认（kimi-code/k3.1-pro）——真实生效模型
      expect(started?.payload).toMatchObject({ model: "deepseek/deepseek-flash", delivery: "caller" });
    } finally {
      await adapter.dispose();
    }
  });
});

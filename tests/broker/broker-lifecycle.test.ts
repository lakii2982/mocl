import { describe, expect, it } from "vitest";
import { Broker } from "../../src/broker/broker.ts";
import { fixedRuntime, makeBroker } from "./helpers.ts";

const input = [{ type: "text" as const, text: "hello" }];

describe("Broker 生命周期与并发槽位（D-016）", () => {
  it("open → status → list → send → close 全链路", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      expect(opened.state).toBe("created");
      const status = await broker.status(opened.sessionId);
      expect(status).toMatchObject({ backend: "codex", cwd: "/tmp/work", active: true, epoch: 1 });
      const list = await broker.list();
      expect(list).toHaveLength(1);
      const sent = await broker.send(opened.sessionId, { input, idempotencyKey: "s-1" });
      expect(sent.state).toBe("running");
      await broker.close(opened.sessionId, "completed");
      expect(adapter.closeCalls).toBe(1);
      expect((await broker.status(opened.sessionId)).state).toBe("lost"); // 已不在激活表
    } finally {
      await cleanup();
    }
  });

  it("并发上限来自运行时：满额 open 抛 limit.concurrency-exceeded；close 释放后可再开", async () => {
    const { broker, cleanup } = await makeBroker(2);
    try {
      const a = await broker.open({ backend: "codex", cwd: "/tmp/a" });
      await broker.open({ backend: "codex", cwd: "/tmp/b" });
      await expect(broker.open({ backend: "codex", cwd: "/tmp/c" })).rejects.toMatchObject({
        code: "limit.concurrency-exceeded",
      });
      await broker.close(a.sessionId, "completed");
      const c = await broker.open({ backend: "codex", cwd: "/tmp/c" });
      expect(c.sessionId).toMatch(/^sess_/);
    } finally {
      await cleanup();
    }
  });

  it("运行时容量变化即时生效（无需重建 Broker）", async () => {
    const { Broker: BrokerClass } = await import("../../src/broker/broker.ts");
    const { makeRegistry, FakeAdapter } = await import("./helpers.ts");
    const { registry, cleanup } = await makeRegistry();
    let capacity = 1;
    const broker = new BrokerClass({
      runtime: { read: () => ({ maxActiveSubagents: capacity }) },
      adapters: [new FakeAdapter()],
      registry,
    });
    try {
      const a = await broker.open({ backend: "codex", cwd: "/tmp/a" });
      await expect(broker.open({ backend: "codex", cwd: "/tmp/b" })).rejects.toMatchObject({
        code: "limit.concurrency-exceeded",
      });
      capacity = 2;
      const b = await broker.open({ backend: "codex", cwd: "/tmp/b" });
      expect(b.sessionId).not.toBe(a.sessionId);
    } finally {
      await cleanup();
    }
  });

  it("同一 childId 重复 open → session.conflict", async () => {
    const { broker, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/a", childId: "sess_fixed_0000000000000000" });
      await expect(
        broker.open({ backend: "codex", cwd: "/tmp/a", childId: "sess_fixed_0000000000000000" }),
      ).rejects.toMatchObject({ code: "session.conflict" });
      expect(opened.sessionId).toBe("sess_fixed_0000000000000000");
    } finally {
      await cleanup();
    }
  });

  it("未注册后端 → capability.missing（不静默降级）", async () => {
    const { Broker: BrokerClass } = await import("../../src/broker/broker.ts");
    const { makeRegistry, FakeAdapter } = await import("./helpers.ts");
    const { registry, cleanup } = await makeRegistry();
    const broker = new BrokerClass({ runtime: fixedRuntime(1), adapters: [new FakeAdapter("codex")], registry });
    try {
      await expect(broker.open({ backend: "kimi", cwd: "/tmp/a" })).rejects.toMatchObject({ code: "capability.missing" });
    } finally {
      await cleanup();
    }
  });

  it("重复注册同一后端适配器 → 构造期拒绝", async () => {
    const { makeRegistry, FakeAdapter } = await import("./helpers.ts");
    const { registry, cleanup } = await makeRegistry();
    try {
      expect(
        () =>
          new Broker({
            runtime: fixedRuntime(1),
            adapters: [new FakeAdapter("codex"), new FakeAdapter("codex")],
            registry,
          }),
      ).toThrow(/duplicate adapter/);
    } finally {
      await cleanup();
    }
  });
});

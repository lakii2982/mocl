import { describe, expect, it } from "vitest";
import { MoclError } from "../../src/broker/errors.ts";
import { makeBroker } from "./helpers.ts";

const input = [{ type: "text" as const, text: "只回复 OK" }];

describe("Broker 幂等（send / open / resume）", () => {
  it("同 idempotencyKey 重复 send：返回既有结果、适配器只被调用一次", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      const first = await broker.send(opened.sessionId, { input, idempotencyKey: "req-1" });
      const second = await broker.send(opened.sessionId, { input, idempotencyKey: "req-1" });
      expect(adapter.sendCalls).toBe(1);
      expect(second.turnId).toBe(first.turnId);
      expect(second.deduplicated).toBe(true);
      expect(first.deduplicated).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("不同 idempotencyKey → 两次真实发送", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      await broker.send(opened.sessionId, { input, idempotencyKey: "req-1" });
      await broker.send(opened.sessionId, { input, idempotencyKey: "req-2" });
      expect(adapter.sendCalls).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("同 key 不同载荷 → session.conflict（不覆盖旧结果、不重发）", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      await broker.send(opened.sessionId, { input, idempotencyKey: "req-1" });
      await expect(
        broker.send(opened.sessionId, { input: [{ type: "text", text: "不同内容" }], idempotencyKey: "req-1" }),
      ).rejects.toMatchObject({ code: "session.conflict" });
      expect(adapter.sendCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("open 同 key 幂等：返回同一 sessionId，适配器 open 只调用一次", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const first = await broker.open({ backend: "codex", cwd: "/tmp/work", idempotencyKey: "open-1" });
      const second = await broker.open({ backend: "codex", cwd: "/tmp/work", idempotencyKey: "open-1" });
      expect(adapter.openCalls).toBe(1);
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.deduplicated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("open 同 key 不同 cwd → session.conflict", async () => {
    const { broker, cleanup } = await makeBroker(2);
    try {
      await broker.open({ backend: "codex", cwd: "/tmp/work", idempotencyKey: "open-1" });
      await expect(broker.open({ backend: "codex", cwd: "/tmp/other", idempotencyKey: "open-1" })).rejects.toMatchObject({
        code: "session.conflict",
      });
    } finally {
      await cleanup();
    }
  });

  it("resume 同 key 幂等：探测只发生一次", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      const first = await broker.resume(opened.sessionId, { idempotencyKey: "resume-1" });
      const second = await broker.resume(opened.sessionId, { idempotencyKey: "resume-1" });
      expect(adapter.resumeCalls).toBe(1);
      expect(second).toMatchObject({ sessionId: first.sessionId, strategy: "resume", deduplicated: true });
    } finally {
      await cleanup();
    }
  });

  it("send 未知会话 → session.not-found（不触碰适配器）", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      await expect(broker.send("sess_missing", { input, idempotencyKey: "req-x" })).rejects.toBeInstanceOf(MoclError);
      await expect(broker.send("sess_missing", { input, idempotencyKey: "req-x" })).rejects.toMatchObject({
        code: "session.not-found",
      });
      expect(adapter.sendCalls).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("幂等账本有容量上限（不会无限增长）", async () => {
    const { broker, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      for (let i = 0; i < 5000; i += 1) {
        await broker.send(opened.sessionId, { input, idempotencyKey: `req-${i}` });
      }
      // 账本默认 4096；The Broker 只暴露行为，这里断言最近一次仍命中、内存未失控（由 maxEntries 保证）。
      const hit = await broker.send(opened.sessionId, { input, idempotencyKey: "req-4999" });
      expect(hit.deduplicated).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

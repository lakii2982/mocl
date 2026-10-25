import { describe, expect, it } from "vitest";
import { makeBroker } from "./helpers.ts";

describe("Broker resume（顺序：registry → 远端探测 → 降级/session.not-found）", () => {
  it("registry 无记录 → session.not-found（不调用适配器探测）", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      await expect(broker.resume("sess_missing", { idempotencyKey: "r-1" })).rejects.toMatchObject({
        code: "session.not-found",
      });
      expect(adapter.resumeCalls).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("远端存在 → strategy=resume、epoch 不变、degraded=false", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      const resumed = await broker.resume(opened.sessionId, { idempotencyKey: "r-1" });
      expect(resumed).toMatchObject({
        sessionId: opened.sessionId,
        strategy: "resume",
        epoch: opened.epoch,
        degraded: false,
        deduplicated: false,
      });
      expect(adapter.resumeCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("远端不存在且未配置降级 → session.not-found（按 R-1 默认终止）", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      adapter.deleteRemote();
      await expect(broker.resume(opened.sessionId, { idempotencyKey: "r-1" })).rejects.toMatchObject({
        code: "session.not-found",
      });
      expect(adapter.resumeCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("远端不存在 + fallback=reseed → 新建后端会话、epoch+1、degraded=true", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      adapter.deleteRemote();
      const resumed = await broker.resume(opened.sessionId, { idempotencyKey: "r-1", fallback: "reseed" });
      expect(resumed.strategy).toBe("reseed");
      expect(resumed.degraded).toBe(true);
      expect(resumed.epoch).toBe(opened.epoch + 1);
      expect(adapter.openCalls).toBe(2);
      const status = await broker.status(opened.sessionId);
      expect(status.backendSessionId).not.toBe(opened.backendSessionId);
      expect(status.epoch).toBe(opened.epoch + 1);
    } finally {
      await cleanup();
    }
  });

  it("resume 探测发生在 registry 命中之后（顺序可观测：无记录不探测）", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      expect(adapter.resumeCalls).toBe(0);
      await broker.resume(opened.sessionId, { idempotencyKey: "r-1" });
      expect(adapter.resumeCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("resume 未知会话即使带幂等键也不进入账本（先 registry）", async () => {
    const { broker, cleanup } = await makeBroker(2);
    try {
      await expect(broker.resume("sess_x", { idempotencyKey: "r-1" })).rejects.toMatchObject({ code: "session.not-found" });
      // 同键换一个真实会话不应冲突（未提交半成品记录）
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      const resumed = await broker.resume(opened.sessionId, { idempotencyKey: "r-1" });
      expect(resumed.strategy).toBe("resume");
    } finally {
      await cleanup();
    }
  });
});

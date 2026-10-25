import { describe, expect, it } from "vitest";
import { makeBroker } from "./helpers.ts";

const input = [{ type: "text" as const, text: "跑一轮" }];

describe("Broker 冷恢复（kill → 按 id 恢复，epoch+1，无重复 turn）", () => {
  it("kill 后 recover：recovered=true、epoch+1、不重放已终态轮次（无重复 turn）", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      const sent = await broker.send(opened.sessionId, { input, idempotencyKey: "turn-1" });
      expect(adapter.sendCalls).toBe(1);
      expect(sent.turnId).toBe("turn_codex_1");

      // 模拟后端进程被 kill（远端会话仍持久化）
      adapter.kill();
      const recovered = await broker.recover(opened.sessionId);
      expect(recovered).toMatchObject({
        sessionId: opened.sessionId,
        recovered: true,
        strategy: "resume",
        epoch: opened.epoch + 1,
      });
      // 关键：恢复不产生新 turn
      expect(adapter.sendCalls).toBe(1);
      expect(adapter.turns).toEqual(["turn_codex_1"]);
      const status = await broker.status(opened.sessionId);
      expect(status.epoch).toBe(opened.epoch + 1);
      expect(status.state).toBe("running");
    } finally {
      await cleanup();
    }
  });

  it("recover 同幂等键重复调用：只探测一次、返回既有结果（deduplicated）", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      adapter.kill();
      const first = await broker.recover(opened.sessionId, { idempotencyKey: "rec-1" });
      const probeCallsAfterFirst = adapter.resumeCalls;
      const second = await broker.recover(opened.sessionId, { idempotencyKey: "rec-1" });
      expect(second.deduplicated).toBe(true);
      expect(second.epoch).toBe(first.epoch);
      expect(adapter.resumeCalls).toBe(probeCallsAfterFirst);
    } finally {
      await cleanup();
    }
  });

  it("恢复后同一 id 可继续下一轮（epoch 递增不破坏 id）", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      await broker.send(opened.sessionId, { input, idempotencyKey: "turn-1" });
      adapter.kill();
      const recovered = await broker.recover(opened.sessionId);
      expect(recovered.epoch).toBe(2);
      const next = await broker.send(opened.sessionId, { input, idempotencyKey: "turn-2" });
      expect(next.turnId).toBe("turn_codex_2");
      expect(adapter.sendCalls).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("远端已被删除 → recovered=false（strategy=aborted），不伪造成功", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      adapter.kill();
      adapter.deleteRemote();
      const result = await broker.recover(opened.sessionId);
      expect(result).toMatchObject({ recovered: false, strategy: "aborted", epoch: opened.epoch });
    } finally {
      await cleanup();
    }
  });

  it("远端已删除 + fallback=reseed → 新会话恢复，epoch+1", async () => {
    const { broker, adapter, cleanup } = await makeBroker(2);
    try {
      const opened = await broker.open({ backend: "codex", cwd: "/tmp/work" });
      adapter.kill();
      adapter.deleteRemote();
      const result = await broker.recover(opened.sessionId, { fallback: "reseed" });
      expect(result).toMatchObject({ recovered: true, strategy: "reseed", epoch: opened.epoch + 1 });
      expect(adapter.openCalls).toBe(2);
    } finally {
      await cleanup();
    }
  });
});

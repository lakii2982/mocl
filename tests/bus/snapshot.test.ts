import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/bus/event-bus.ts";
import { SESSION, TestClock, tokenDelta, turnCompleted, turnStarted } from "./helpers.ts";

describe("EventBus snapshot / stats（mocl_status 数据面）", () => {
  it("snapshot 返回增量、lastSeq、epoch 与统计；未知会话返回空快照", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    bus.ingest(turnStarted(1, { epoch: 3 }));
    bus.ingest(tokenDelta(2, "a", "msg_1", { epoch: 3 }));
    bus.ingest(tokenDelta(3, "b", "msg_1", { epoch: 3 }));
    const snapshot = bus.snapshot(SESSION, 1);
    expect(snapshot).toMatchObject({ sessionId: SESSION, epoch: 3, lastSeq: 3, fromSeq: 1 });
    expect(snapshot.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(snapshot.stats.ingested).toBe(3);

    const missing = bus.snapshot("sess_UNKNOWN000000000000000000");
    expect(missing).toMatchObject({ lastSeq: 0, events: [], ringSize: 0 });
  });

  it("snapshot 不吐旧于 ring 的事件（retention 边界可观测）", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now, ringCapacity: 4 });
    for (let seq = 1; seq <= 10; seq += 1) bus.ingest(tokenDelta(seq, "x"));
    const snapshot = bus.snapshot(SESSION, 0);
    expect(snapshot.ringEvicted).toBe(6);
    expect(snapshot.events.length).toBeLessThanOrEqual(4);
  });

  it("stats 聚合多会话；reset 清空状态", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    bus.ingest(tokenDelta(1, "a", "msg_1", { sessionId: "sess_ONE" }));
    bus.ingest(turnCompleted(2, { sessionId: "sess_TWO" }));
    expect(bus.stats().ingested).toBe(2);
    expect(bus.stats().parentDeliveryCount).toBe(1);
    bus.reset();
    expect(bus.stats().ingested).toBe(0);
    expect(bus.snapshot("sess_ONE").lastSeq).toBe(0);
  });

  it("drainParentDeliveries 支持按会话过滤且消费后清空", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    bus.ingest(turnCompleted(1, { sessionId: "sess_A" }));
    bus.ingest(turnCompleted(1, { sessionId: "sess_B" }));
    const a = bus.drainParentDeliveries("sess_A");
    expect(a).toHaveLength(1);
    expect(bus.drainParentDeliveries("sess_A")).toHaveLength(0);
    expect(bus.drainParentDeliveries("sess_B")).toHaveLength(1);
  });
});

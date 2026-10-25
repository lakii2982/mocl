import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/bus/event-bus.ts";
import { SESSION, TestClock, tokenDelta, turnCompleted } from "./helpers.ts";

describe("EventBus 洪泛与有界性（1e5 帧）", () => {
  it("1e5 token 帧：全部接收、父级仍只投终态 1 条", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now, parentProgress: { mode: "summary" } });
    const startedAt = Date.now();
    const count = 100_000;
    for (let seq = 1; seq <= count; seq += 1) {
      const result = bus.ingest(tokenDelta(seq, "x"));
      expect(result.accepted).toBe(true);
    }
    bus.ingest(turnCompleted(count + 1));
    const elapsed = Date.now() - startedAt;
    const deliveries = bus.drainParentDeliveries(SESSION);
    // 终态 1 条；摘要按窗口（5s）最多若干条，但父级总消息数远小于帧数
    const terminal = deliveries.filter((d) => d.kind === "terminal");
    expect(terminal).toHaveLength(1);
    expect(deliveries.length).toBeLessThanOrEqual(2);
    expect(bus.stats(SESSION).ingested).toBe(count + 1);
    expect(bus.stats(SESSION).ringEvicted).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("环形缓冲同时受条数与字节上限约束", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({
      clock: clock.now,
      ringCapacity: 64,
      ringByteCapacity: 32 * 1024,
    });
    for (let seq = 1; seq <= 10_000; seq += 1) bus.ingest(tokenDelta(seq, "payload-".repeat(10)));
    const snapshot = bus.snapshot(SESSION);
    expect(snapshot.ringSize).toBeLessThanOrEqual(64);
    expect(snapshot.ringBytes).toBeLessThanOrEqual(32 * 1024);
    expect(snapshot.ringEvicted).toBeGreaterThan(0);
    expect(snapshot.lastSeq).toBe(10_000);
  });

  it("洪泛后 snapshot(fromSeq) 只返回 ring 内的增量（不假装全量可回放）", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now, ringCapacity: 16 });
    for (let seq = 1; seq <= 100; seq += 1) bus.ingest(tokenDelta(seq, "x"));
    const snapshot = bus.snapshot(SESSION, 90);
    expect(snapshot.events.every((event) => event.seq > 90)).toBe(true);
    expect(snapshot.ringSize).toBeLessThanOrEqual(16);
    expect(snapshot.events.map((event) => event.seq)).toEqual([...snapshot.events.map((event) => event.seq)].sort((a, b) => a - b));
  });
});

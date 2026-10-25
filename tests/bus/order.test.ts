import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/bus/event-bus.ts";
import { SESSION, TestClock, tokenDelta, turnCompleted, turnStarted } from "./helpers.ts";

describe("EventBus 顺序与去重（单写者 + 单调序号）", () => {
  it("严格递增 seq 全部接收，lastSeq 单调", () => {
    const bus = new EventBus();
    for (let seq = 1; seq <= 5; seq += 1) {
      expect(bus.ingest(tokenDelta(seq, `t${seq}`)).accepted).toBe(true);
    }
    expect(bus.snapshot(SESSION).lastSeq).toBe(5);
    expect(bus.stats(SESSION)).toMatchObject({ ingested: 5, droppedOutOfOrder: 0, droppedDuplicate: 0 });
  });

  it("乱序帧（seq <= lastSeq）丢弃并计数", () => {
    const bus = new EventBus();
    bus.ingest(tokenDelta(1, "a"));
    bus.ingest(tokenDelta(3, "c"));
    const stale = bus.ingest(tokenDelta(2, "b"));
    expect(stale).toMatchObject({ accepted: false, reason: "out-of-order" });
    expect(bus.stats(SESSION).droppedOutOfOrder).toBe(1);
    // 乱序后的新帧仍继续处理（不阻断会话）
    expect(bus.ingest(tokenDelta(4, "d")).accepted).toBe(true);
  });

  it("重复 eventId 丢弃并计数（即使 seq 更大）", () => {
    const bus = new EventBus();
    const first = tokenDelta(1, "a", "msg_1", { eventId: "evt-fixed" });
    const second = tokenDelta(2, "b", "msg_1", { eventId: "evt-fixed" });
    expect(bus.ingest(first).accepted).toBe(true);
    const dup = bus.ingest(second);
    expect(dup).toMatchObject({ accepted: false, reason: "duplicate" });
    expect(bus.stats(SESSION).droppedDuplicate).toBe(1);
  });

  it("序号缺口被接收并计数（gap 由 replay 补齐，不阻断）", () => {
    const bus = new EventBus();
    bus.ingest(tokenDelta(1, "a"));
    expect(bus.ingest(tokenDelta(5, "e")).accepted).toBe(true);
    expect(bus.stats(SESSION).seqGaps).toBe(1);
    expect(bus.snapshot(SESSION).lastSeq).toBe(5);
  });

  it("旧 epoch 帧丢弃（EV-3）", () => {
    const bus = new EventBus();
    bus.ingest(tokenDelta(1, "a", "msg_1", { epoch: 5 }));
    const stale = bus.ingest(tokenDelta(2, "b", "msg_1", { epoch: 4 }));
    expect(stale).toMatchObject({ accepted: false, reason: "stale-epoch" });
    expect(bus.stats(SESSION).droppedStaleEpoch).toBe(1);
    expect(bus.snapshot(SESSION).epoch).toBe(5);
  });

  it("不同会话各自独立单调", () => {
    const bus = new EventBus();
    bus.ingest(tokenDelta(1, "a"));
    bus.ingest(tokenDelta(1, "a", "msg_1", { sessionId: "sess_OTHER0000000000000000000" }));
    expect(bus.snapshot(SESSION).lastSeq).toBe(1);
    expect(bus.snapshot("sess_OTHER0000000000000000000").lastSeq).toBe(1);
  });

  it("终态事件不受乱序/重复影响：合法终态必投递一次", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    bus.ingest(turnStarted(1));
    bus.ingest(tokenDelta(2, "x"));
    bus.ingest(turnCompleted(3));
    const deliveries = bus.drainParentDeliveries(SESSION);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.kind).toBe("terminal");
  });
});

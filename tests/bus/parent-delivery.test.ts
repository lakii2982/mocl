import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/bus/event-bus.ts";
import { PARENT_HARD_LIMITS, resolveParentProgressConfig } from "../../src/bus/parent-delivery.ts";
import { SESSION, TestClock, tokenDelta, turnCompleted, turnStarted } from "./helpers.ts";

describe("父级投递策略（D-009 / ABI §11）", () => {
  it("默认 mode=off：只投终态 1 条，delta 不进父级", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    expect(bus.parentConfig.mode).toBe("off");
    bus.ingest(turnStarted(1));
    for (let seq = 2; seq <= 20; seq += 1) bus.ingest(tokenDelta(seq, "x"));
    expect(bus.drainParentDeliveries(SESSION)).toHaveLength(0);
    bus.ingest(turnCompleted(21));
    const deliveries = bus.drainParentDeliveries(SESSION);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.kind).toBe("terminal");
  });

  it("summary 模式：窗口摘要 + 终态，顺序为摘要在前、终态在后", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now, parentProgress: { mode: "summary" } });
    bus.ingest(turnStarted(1));
    for (let seq = 2; seq <= 10; seq += 1) bus.ingest(tokenDelta(seq, "x"));
    bus.ingest(turnCompleted(11));
    const deliveries = bus.drainParentDeliveries(SESSION);
    expect(deliveries.map((d) => d.kind)).toEqual(["summary", "terminal"]);
  });

  it("摘要条目 ≤8、总字符 ≤1200、单条 ≤400（硬上限）", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now, parentProgress: { mode: "summary" } });
    for (let i = 0; i < 20; i += 1) bus.ingest(tokenDelta(i + 1, "q".repeat(500), `msg_${i}`));
    bus.flush(SESSION);
    const summary = bus.drainParentDeliveries(SESSION).find((d) => d.kind === "summary");
    if (summary === undefined || summary.kind !== "summary") throw new Error("missing summary");
    expect(summary.fold.items.length).toBeLessThanOrEqual(PARENT_HARD_LIMITS.maxItems);
    expect(summary.fold.chars).toBeLessThanOrEqual(PARENT_HARD_LIMITS.maxCharsPerTurn);
    for (const item of summary.fold.items) {
      expect(item.text.length).toBeLessThanOrEqual(PARENT_HARD_LIMITS.maxCharsPerItem);
    }
  });

  it("配置超硬上限 → 构造期拒绝（items > 8）", () => {
    expect(() => new EventBus({ parentProgress: { mode: "summary", maxItemsPerTurn: 9 } })).toThrow(RangeError);
  });

  it("配置超硬上限 → 构造期拒绝（chars > 1200 / item > 400）", () => {
    expect(() => new EventBus({ parentProgress: { mode: "summary", maxCharsPerTurn: 1201 } })).toThrow(RangeError);
    expect(() => new EventBus({ parentProgress: { mode: "summary", maxCharsPerItem: 401 } })).toThrow(RangeError);
  });

  it("非法 mode → RangeError；默认解析值等于硬上限", () => {
    expect(() =>
      resolveParentProgressConfig({ mode: "events" as unknown as "off" }),
    ).toThrow(RangeError);
    expect(resolveParentProgressConfig()).toMatchObject({
      mode: "off",
      maxItemsPerTurn: PARENT_HARD_LIMITS.maxItems,
      maxCharsPerTurn: PARENT_HARD_LIMITS.maxCharsPerTurn,
      maxCharsPerItem: PARENT_HARD_LIMITS.maxCharsPerItem,
    });
  });

  it("同一 delta 重复 ingest（同 eventId）只投递一次终态（事件级去重与父级去重叠加）", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    const completed = turnCompleted(2, { eventId: "evt-terminal" });
    bus.ingest(turnStarted(1));
    bus.ingest(completed);
    bus.ingest(completed);
    const deliveries = bus.drainParentDeliveries(SESSION);
    expect(deliveries).toHaveLength(1);
  });
});

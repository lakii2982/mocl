import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/bus/event-bus.ts";
import { SESSION, TestClock, reasoningDelta, tokenDelta } from "./helpers.ts";

describe("EventBus 折叠（token/reasoning delta + 窗口）", () => {
  it("同 messageId 的 token delta 聚合成 1 条，count 记录次数", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    for (let seq = 1; seq <= 100; seq += 1) bus.ingest(tokenDelta(seq, "x"));
    const folded = bus.flush(SESSION);
    expect(folded).not.toBeNull();
    expect(folded?.items).toHaveLength(1);
    expect(folded?.items[0]).toMatchObject({ kind: "turn", key: "message:msg_1", count: 100 });
    expect(bus.stats(SESSION).foldedEvents).toBe(100);
  });

  it("折叠确定性：同一输入/同一时钟的两次运行结果逐字节一致", () => {
    const run = (): string => {
      const clock = new TestClock(0);
      const bus = new EventBus({ clock: clock.now });
      for (let seq = 1; seq <= 50; seq += 1) bus.ingest(tokenDelta(seq, `tok${seq}`));
      return JSON.stringify(bus.flush(SESSION));
    };
    expect(run()).toBe(run());
  });

  it("折叠比：1000 条 delta → 1 条 item（折叠率 1000:1）", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    for (let seq = 1; seq <= 1000; seq += 1) bus.ingest(tokenDelta(seq, "y"));
    const folded = bus.flush(SESSION);
    expect(folded?.items).toHaveLength(1);
    expect(folded?.foldedEvents).toBe(1000);
  });

  it("单条折叠文本 ≤400 字符（超长截断并置 truncated）", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    bus.ingest(tokenDelta(1, "a".repeat(1000)));
    const folded = bus.flush(SESSION);
    expect(folded?.items[0]?.text.length).toBeLessThanOrEqual(400);
    expect(folded?.truncated).toBe(true);
  });

  it("整窗字符 ≤1200（多 key 竞争时丢低优并计数）", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now });
    for (let i = 0; i < 10; i += 1) bus.ingest(tokenDelta(i + 1, "z".repeat(400), `msg_${i}`));
    const folded = bus.flush(SESSION);
    expect(folded?.chars).toBeLessThanOrEqual(1200);
    expect(folded?.items.length).toBeLessThanOrEqual(8);
    expect((folded?.dropped.count ?? 0) > 0).toBe(true);
  });

  it("窗口按时间自动关闭（默认 5000ms）：跨窗产生两个 FoldState", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now, parentProgress: { mode: "summary" } });
    bus.ingest(tokenDelta(1, "a"));
    clock.advance(4_999);
    bus.ingest(tokenDelta(2, "b"));
    expect(bus.flush(SESSION)).not.toBeNull();
    clock.advance(5_001);
    bus.ingest(tokenDelta(3, "c")); // 触发旧窗 flush（新窗从当前时刻开始）
    const deliveries = bus.drainParentDeliveries(SESSION);
    expect(deliveries.filter((d) => d.kind === "summary").length).toBeGreaterThanOrEqual(1);
  });

  it("reasoning delta 默认可折叠但不出现在父级摘要（includeReasoning=false）", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now, parentProgress: { mode: "summary" } });
    bus.ingest(reasoningDelta(1, "think-1"));
    bus.ingest(reasoningDelta(2, "think-2"));
    const folded = bus.flush(SESSION);
    expect(folded?.items.some((item) => item.key.startsWith("reasoning:"))).toBe(true);
    const deliveries = bus.drainParentDeliveries(SESSION);
    expect(deliveries.some((d) => d.kind === "summary")).toBe(false);
  });

  it("includeReasoning=true 时 reasoning 进入摘要", () => {
    const clock = new TestClock(0);
    const bus = new EventBus({ clock: clock.now, includeReasoning: true, parentProgress: { mode: "summary" } });
    bus.ingest(reasoningDelta(1, "think"));
    bus.flush(SESSION);
    const deliveries = bus.drainParentDeliveries(SESSION);
    const summary = deliveries.find((d) => d.kind === "summary");
    expect(summary?.kind === "summary" && summary.fold.items.some((item) => item.key.startsWith("reasoning:"))).toBe(true);
  });
});

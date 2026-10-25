/**
 * 事件总线（L3；施工 C3）。
 *
 * 不变量（docs/architecture/01-layers.md §L3）：
 * - **每会话单写者 + 单调序号**：`ingest` 同步串行；`seq <= lastSeq` 的帧丢弃并计数（EV-1/EV-2）；
 * - 旧 epoch 帧丢弃（EV-3）；重复 `eventId` 丢弃并计数；
 * - token/reasoning delta 按窗口折叠（默认 5s）；环形缓冲同时受条数与字节上限约束；
 * - `snapshot(fromSeq)` 供 `mocl_status` 拉增量；`drainParentDeliveries()` 供 L4 投递：
 *   默认（`mode:"off"`，D-009）**只投终态**；`mode:"summary"` 时终态 + 有界折叠摘要（硬上限 8/1200/400）。
 */
import { TERMINAL_EVENT_TYPES, type EventType } from "../abi/events.ts";
import type { MoclEvent } from "../abi/types.ts";
import { FoldAccumulator, type FoldConfig, type FoldInput, type FoldState } from "./fold.ts";
import {
  resolveParentProgressConfig,
  type ParentDelivery,
  type ParentProgressConfig,
  type ResolvedParentProgressConfig,
} from "./parent-delivery.ts";
import { RingBuffer } from "./ring-buffer.ts";

export interface EventBusOptions {
  /** 环形缓冲条数上限（默认 2048，ABI §11/§6.5）。 */
  readonly ringCapacity?: number;
  /** 环形缓冲字节上限（默认 8 MiB）。 */
  readonly ringByteCapacity?: number;
  /** 折叠窗口毫秒（默认 5000；可配）。 */
  readonly foldWindowMs?: number;
  /** 是否把 reasoning 计入摘要（默认 false，D-009）；不影响内部折叠。 */
  readonly includeReasoning?: boolean;
  readonly parentProgress?: ParentProgressConfig;
  readonly clock?: () => number;
}

export interface IngestResult {
  readonly accepted: boolean;
  readonly seq: number;
  readonly folded: boolean;
  readonly reason?: "stale-epoch" | "duplicate" | "out-of-order" | "invalid";
}

export interface BusStats {
  readonly ingested: number;
  readonly droppedDuplicate: number;
  readonly droppedOutOfOrder: number;
  readonly droppedStaleEpoch: number;
  readonly seqGaps: number;
  readonly foldedEvents: number;
  readonly ringEvicted: number;
  readonly parentDeliveryCount: number;
}

export interface BusSnapshot {
  readonly sessionId: string;
  readonly epoch: number;
  readonly lastSeq: number;
  readonly fromSeq: number;
  readonly events: readonly MoclEvent[];
  readonly ringSize: number;
  readonly ringBytes: number;
  readonly ringEvicted: number;
  readonly stats: BusStats;
}

interface SessionBusState {
  epoch: number;
  lastSeq: number;
  readonly ring: RingBuffer<MoclEvent>;
  readonly seen: Map<string, true>;
  readonly fold: FoldAccumulator;
  readonly parent: ParentDelivery[];
  readonly stats: {
    ingested: number;
    droppedDuplicate: number;
    droppedOutOfOrder: number;
    droppedStaleEpoch: number;
    seqGaps: number;
    foldedEvents: number;
    parentDeliveryCount: number;
  };
}

const DEFAULT_RING_CAPACITY = 2048;
const DEFAULT_RING_BYTES = 8 * 1024 * 1024;
const DEFAULT_FOLD_WINDOW_MS = 5_000;

function byteLength(event: MoclEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    return 0;
  }
}

/** ABI 事件 → 可折叠项（不产生第二套事件名）。 */
function foldInputOf(event: MoclEvent, nowMs: number): FoldInput | null {
  switch (event.type) {
    case "message.delta":
      if (event.payload.granularity !== "token") return null;
      return { kind: "turn", key: `message:${event.payload.messageId}`, text: event.payload.text, atMs: nowMs };
    case "reasoning.delta":
      return { kind: "turn", key: `reasoning:${event.payload.messageId ?? "reasoning"}`, text: event.payload.text, atMs: nowMs };
    case "tool.progress":
      return { kind: "tool", key: `tool:${event.payload.toolCallId}`, text: event.payload.text, atMs: nowMs };
    case "plan.updated":
      return {
        kind: "plan",
        key: event.payload.planId ?? "plan",
        text: event.payload.steps.map((step) => `${step.id}:${step.status}`).join(", "),
        atMs: nowMs,
      };
    case "diff.updated":
      return {
        kind: "diff",
        key: "diff",
        text: event.payload.files.map((file) => `${file.status}:${file.path}`).join(", "),
        atMs: nowMs,
      };
    case "usage.updated":
      return { kind: "usage", key: "usage", text: JSON.stringify(event.payload.usage), atMs: nowMs };
    case "child.spawned":
      return { kind: "child", key: event.payload.childSessionId, text: event.payload.name ?? event.payload.childSessionId, atMs: nowMs };
    case "session.state-changed":
      return { kind: "state", key: "state", text: `${event.payload.previousState}→${event.payload.state}`, atMs: nowMs };
    case "session.warning":
      return { kind: "error", key: event.payload.code, text: event.payload.message, atMs: nowMs };
    default:
      return null;
  }
}

export class EventBus {
  readonly #ringCapacity: number;
  readonly #ringByteCapacity: number;
  readonly #foldWindowMs: number;
  readonly #includeReasoning: boolean;
  readonly #parentConfig: ResolvedParentProgressConfig;
  readonly #clock: () => number;
  readonly #sessions = new Map<string, SessionBusState>();

  constructor(options: EventBusOptions = {}) {
    this.#ringCapacity = options.ringCapacity ?? DEFAULT_RING_CAPACITY;
    this.#ringByteCapacity = options.ringByteCapacity ?? DEFAULT_RING_BYTES;
    this.#foldWindowMs = options.foldWindowMs ?? DEFAULT_FOLD_WINDOW_MS;
    this.#includeReasoning = options.includeReasoning ?? false;
    this.#parentConfig = resolveParentProgressConfig(options.parentProgress);
    this.#clock = options.clock ?? (() => Date.now());
    if (!Number.isSafeInteger(this.#ringCapacity) || this.#ringCapacity <= 0) {
      throw new RangeError("ringCapacity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#ringByteCapacity) || this.#ringByteCapacity <= 0) {
      throw new RangeError("ringByteCapacity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#foldWindowMs) || this.#foldWindowMs <= 0) {
      throw new RangeError("foldWindowMs must be a positive safe integer");
    }
  }

  get foldConfig(): FoldConfig {
    return {
      windowMs: this.#foldWindowMs,
      maxItems: this.#parentConfig.maxItemsPerTurn,
      maxChars: this.#parentConfig.maxCharsPerTurn,
      maxCharsPerItem: this.#parentConfig.maxCharsPerItem,
    };
  }

  get parentConfig(): ResolvedParentProgressConfig {
    return this.#parentConfig;
  }

  #stateOf(sessionId: string, nowMs: number): SessionBusState {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const state: SessionBusState = {
      epoch: 0,
      lastSeq: 0,
      ring: new RingBuffer<MoclEvent>({
        capacity: this.#ringCapacity,
        byteCapacity: this.#ringByteCapacity,
        sizeOf: byteLength,
      }),
      seen: new Map(),
      fold: new FoldAccumulator(this.foldConfig, nowMs),
      parent: [],
      stats: {
        ingested: 0,
        droppedDuplicate: 0,
        droppedOutOfOrder: 0,
        droppedStaleEpoch: 0,
        seqGaps: 0,
        foldedEvents: 0,
        parentDeliveryCount: 0,
      },
    };
    this.#sessions.set(sessionId, state);
    return state;
  }

  /**
   * 写入一帧（同步；单写者语义）。
   * 顺序：epoch 检查 → 去重 → 序号单调 → 环形缓冲 → 折叠/终态投递。
   */
  ingest(event: MoclEvent): IngestResult {
    const nowMs = this.#clock();
    const state = this.#stateOf(event.sessionId, nowMs);
    if (event.epoch < state.epoch) {
      state.stats.droppedStaleEpoch += 1;
      return { accepted: false, seq: event.seq, folded: false, reason: "stale-epoch" };
    }
    if (event.epoch > state.epoch) state.epoch = event.epoch;
    if (state.seen.has(event.eventId)) {
      state.stats.droppedDuplicate += 1;
      return { accepted: false, seq: event.seq, folded: false, reason: "duplicate" };
    }
    if (event.seq <= state.lastSeq) {
      state.stats.droppedOutOfOrder += 1;
      return { accepted: false, seq: event.seq, folded: false, reason: "out-of-order" };
    }
    if (event.seq > state.lastSeq + 1) state.stats.seqGaps += 1;
    state.lastSeq = event.seq;
    state.seen.set(event.eventId, true);
    while (state.seen.size > this.#ringCapacity * 2) {
      const oldest = state.seen.keys().next();
      if (oldest.done === true) break;
      state.seen.delete(oldest.value);
    }
    state.ring.push(event);
    state.stats.ingested += 1;

    if (isTerminalType(event.type)) {
      // 终态前先把当前窗口的折叠摘要（若启用）落盘，保证父级看到「摘要 → 终态」顺序。
      this.#flushWindow(state, event.sessionId, nowMs);
      this.#deliverTerminal(state, event, nowMs);
      return { accepted: true, seq: event.seq, folded: false };
    }

    const foldInput = foldInputOf(event, nowMs);
    if (foldInput !== null) {
      state.fold.push(foldInput);
      state.stats.foldedEvents += 1;
      if (state.fold.isExpired(nowMs)) this.#flushWindow(state, event.sessionId, nowMs);
      return { accepted: true, seq: event.seq, folded: true };
    }
    if (state.fold.isExpired(nowMs)) this.#flushWindow(state, event.sessionId, nowMs);
    return { accepted: true, seq: event.seq, folded: false };
  }

  /** 强制关闭当前折叠窗口（测试/终态/定时器可调用）；返回被关闭的窗口（无内容时 null）。 */
  flush(sessionId: string, nowMs: number = this.#clock()): FoldState | null {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) return null;
    return this.#flushWindow(state, sessionId, nowMs);
  }

  #flushWindow(state: SessionBusState, sessionId: string, nowMs: number): FoldState | null {
    const snapshot = state.fold.flush(nowMs, nowMs);
    if (this.#parentConfig.mode !== "summary") return snapshot;
    // reasoning 默认不进父级摘要（D-009 includeReasoning=false）；内部仍折叠（供 mocl_status）。
    const items = this.#includeReasoning
      ? snapshot.items
      : snapshot.items.filter((item) => !item.key.startsWith("reasoning:"));
    const chars = items.reduce((sum, item) => sum + item.text.length, 0);
    const visible: FoldState = {
      ...snapshot,
      items,
      chars,
    };
    if (visible.items.length === 0 && visible.dropped.count === 0) return snapshot;
    const delivery: ParentDelivery = {
      sessionId,
      kind: "summary",
      seq: state.lastSeq,
      at: new Date(nowMs).toISOString(),
      fold: visible,
    };
    state.parent.push(delivery);
    state.stats.parentDeliveryCount += 1;
    return snapshot;
  }

  #deliverTerminal(state: SessionBusState, event: MoclEvent, nowMs: number): void {
    const delivery: ParentDelivery = {
      sessionId: event.sessionId,
      kind: "terminal",
      seq: event.seq,
      type: event.type,
      event,
      at: new Date(nowMs).toISOString(),
    };
    state.parent.push(delivery);
    state.stats.parentDeliveryCount += 1;
  }

  /** 拉取并清空父级投递（L4 消费）。 */
  drainParentDeliveries(sessionId?: string): readonly ParentDelivery[] {
    if (sessionId !== undefined) {
      const state = this.#sessions.get(sessionId);
      if (state === undefined) return [];
      const out = [...state.parent];
      state.parent.length = 0;
      return out;
    }
    const out: ParentDelivery[] = [];
    for (const state of this.#sessions.values()) {
      out.push(...state.parent);
      state.parent.length = 0;
    }
    return out;
  }

  /** `mocl_status` 增量拉取：返回 ring 中 `seq > fromSeq` 的事件。 */
  snapshot(sessionId: string, fromSeq = 0): BusSnapshot {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) {
      return {
        sessionId,
        epoch: 0,
        lastSeq: 0,
        fromSeq,
        events: [],
        ringSize: 0,
        ringBytes: 0,
        ringEvicted: 0,
        stats: this.#emptyStats(),
      };
    }
    return {
      sessionId,
      epoch: state.epoch,
      lastSeq: state.lastSeq,
      fromSeq,
      events: state.ring.toArray().filter((event) => event.seq > fromSeq),
      ringSize: state.ring.size,
      ringBytes: state.ring.bytes,
      ringEvicted: state.ring.evicted,
      stats: this.#statsOf(state),
    };
  }

  stats(sessionId?: string): BusStats {
    if (sessionId !== undefined) {
      const state = this.#sessions.get(sessionId);
      return state === undefined ? this.#emptyStats() : this.#statsOf(state);
    }
    const aggregate = {
      ingested: 0,
      droppedDuplicate: 0,
      droppedOutOfOrder: 0,
      droppedStaleEpoch: 0,
      seqGaps: 0,
      foldedEvents: 0,
      ringEvicted: 0,
      parentDeliveryCount: 0,
    };
    for (const state of this.#sessions.values()) {
      const s = this.#statsOf(state);
      aggregate.ingested += s.ingested;
      aggregate.droppedDuplicate += s.droppedDuplicate;
      aggregate.droppedOutOfOrder += s.droppedOutOfOrder;
      aggregate.droppedStaleEpoch += s.droppedStaleEpoch;
      aggregate.seqGaps += s.seqGaps;
      aggregate.foldedEvents += s.foldedEvents;
      aggregate.ringEvicted += s.ringEvicted;
      aggregate.parentDeliveryCount += s.parentDeliveryCount;
    }
    return aggregate;
  }

  #statsOf(state: SessionBusState): BusStats {
    return { ...state.stats, ringEvicted: state.ring.evicted };
  }

  #emptyStats(): BusStats {
    return {
      ingested: 0,
      droppedDuplicate: 0,
      droppedOutOfOrder: 0,
      droppedStaleEpoch: 0,
      seqGaps: 0,
      foldedEvents: 0,
      ringEvicted: 0,
      parentDeliveryCount: 0,
    };
  }

  reset(): void {
    this.#sessions.clear();
  }
}

function isTerminalType(type: EventType): boolean {
  return (TERMINAL_EVENT_TYPES as readonly EventType[]).includes(type);
}

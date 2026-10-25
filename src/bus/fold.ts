/**
 * 折叠器（L3）：把 token/reasoning delta 聚合成有界 `progress.folded` 窗口。
 *
 * 契约（ABI §11.1 + D-009）：
 * - 窗口默认 5s（可配）；窗口内同 `(kind,key)` 合并，`text` 增量拼接、`count` 累加；
 * - 单条 ≤ `maxCharsPerItem`（默认 400，硬上限 400）；整窗 ≤ `maxCharsPerTurn`（默认 1200，硬上限 1200）；
 * - 最多 `maxItemsPerTurn` 条（默认 8，硬上限 8），超出计入 `dropped`；
 * - 终态事件不参与折叠（由 EventBus 直接投递）。
 */
import type { ProgressDropped, ProgressItem, ProgressItemKind, ProgressWindow } from "../abi/types.ts";

export interface FoldConfig {
  readonly windowMs: number;
  readonly maxItems: number;
  readonly maxChars: number;
  readonly maxCharsPerItem: number;
}

export interface FoldInput {
  readonly kind: ProgressItemKind;
  readonly key: string;
  readonly text: string;
  readonly atMs: number;
}

export interface FoldState {
  readonly window: ProgressWindow;
  readonly items: readonly ProgressItem[];
  readonly dropped: ProgressDropped;
  readonly chars: number;
  readonly truncated: boolean;
  readonly foldedEvents: number;
}

interface Accumulator {
  readonly kind: ProgressItemKind;
  readonly key: string;
  count: number;
  text: string;
  truncated: boolean;
}

/** 窗口累积器（一个实例服务多个会话时，每会话一个）。 */
export class FoldAccumulator {
  readonly #config: FoldConfig;
  readonly #accumulators = new Map<string, Accumulator>();
  readonly #droppedKinds = new Map<string, number>();
  #windowStartMs: number;
  #chars = 0;
  #foldedEvents = 0;
  #droppedCount = 0;
  #truncated = false;

  constructor(config: FoldConfig, startMs: number) {
    if (!Number.isSafeInteger(config.windowMs) || config.windowMs <= 0) {
      throw new TypeError("FoldAccumulator: windowMs must be a positive safe integer");
    }
    this.#config = config;
    this.#windowStartMs = startMs;
  }

  get windowStartMs(): number {
    return this.#windowStartMs;
  }

  get totalFolded(): number {
    return this.#foldedEvents;
  }

  /** 窗口是否已到关闭时间（`now >= start + windowMs`）。 */
  isExpired(nowMs: number): boolean {
    return nowMs - this.#windowStartMs >= this.#config.windowMs;
  }

  push(input: FoldInput): void {
    this.#foldedEvents += 1;
    if (input.text.length === 0) return;
    const id = `${input.kind}\u0000${input.key}`;
    const existing = this.#accumulators.get(id);
    if (existing === undefined) {
      if (this.#accumulators.size >= this.#config.maxItems) {
        this.#droppedCount += 1;
        this.#droppedKinds.set(input.kind, (this.#droppedKinds.get(input.kind) ?? 0) + 1);
        return;
      }
      const remaining = this.#config.maxChars - this.#chars;
      if (remaining <= 0) {
        this.#droppedCount += 1;
        this.#droppedKinds.set(input.kind, (this.#droppedKinds.get(input.kind) ?? 0) + 1);
        this.#truncated = true;
        return;
      }
      const room = Math.min(this.#config.maxCharsPerItem, remaining);
      const text = input.text.length > room ? input.text.slice(0, room) : input.text;
      const truncated = text.length < input.text.length;
      if (truncated) this.#truncated = true;
      this.#chars += text.length;
      this.#accumulators.set(id, { kind: input.kind, key: input.key, count: 1, text, truncated });
      return;
    }
    existing.count += 1;
    const remaining = this.#config.maxChars - this.#chars;
    if (remaining <= 0) {
      this.#droppedCount += 1;
      this.#truncated = true;
      return;
    }
    const itemRoom = this.#config.maxCharsPerItem - existing.text.length;
    const room = Math.min(itemRoom, remaining);
    if (room <= 0) {
      this.#droppedCount += 1;
      this.#truncated = true;
      return;
    }
    const piece = input.text.length > room ? input.text.slice(0, room) : input.text;
    if (piece.length < input.text.length) {
      existing.truncated = true;
      this.#truncated = true;
    }
    existing.text += piece;
    this.#chars += piece.length;
  }

  /** 关闭当前窗口并返回快照；`nextStartMs` 用于开启下一窗。 */
  flush(nowMs: number, nextStartMs: number): FoldState {
    const items: ProgressItem[] = [];
    for (const acc of this.#accumulators.values()) {
      items.push({
        kind: acc.kind,
        key: acc.key,
        text: acc.text,
        ...(acc.count > 1 ? { count: acc.count } : {}),
      });
    }
    const state: FoldState = {
      window: { startMs: this.#windowStartMs, endMs: nowMs },
      items,
      dropped: { count: this.#droppedCount, kinds: [...this.#droppedKinds.keys()] },
      chars: this.#chars,
      truncated: this.#truncated,
      foldedEvents: this.#foldedEvents,
    };
    this.#accumulators.clear();
    this.#droppedKinds.clear();
    this.#chars = 0;
    this.#foldedEvents = 0;
    this.#droppedCount = 0;
    this.#truncated = false;
    this.#windowStartMs = nextStartMs;
    return state;
  }
}

/**
 * 幂等账本（ABI §9 的 C2 最小实现）。
 *
 * 语义（与 ABI §9.1 一致）：
 * - key = `(scope, method, clientRequestId)` 规范化字符串（scope 通常是 sessionId/backendId）；
 * - 同 key 同 `requestHash` → 返回首次结果 + `deduplicated:true`，**不产生第二次副作用**；
 * - 同 key 不同 `requestHash` → `session.conflict`（不覆盖旧结果）；
 * - 账本容量有上限（避免长进程无限增长）；淘汰按插入顺序（FIFO）。
 *
 * 说明：C2 只需进程内幂等；跨重启的 7 天账本属 C4/C5 的 journal 持久化范围（ABI §9.2）。
 */
import { createHash } from "node:crypto";
import { moclError } from "./errors.ts";

export interface LedgerEntry<TResult = unknown> {
  readonly key: string;
  readonly requestHash: string;
  readonly result: TResult;
  readonly committedAt: string;
}

export type LedgerLookup<TResult = unknown> =
  | { readonly kind: "miss" }
  | { readonly kind: "hit"; readonly entry: LedgerEntry<TResult> }
  | { readonly kind: "conflict"; readonly entry: LedgerEntry<TResult> };

export interface IdempotencyLedgerOptions {
  /** 最多保留的键数（防长进程内存增长；不参与并发语义）。 */
  readonly maxEntries: number;
  readonly clock?: () => Date;
}

/** 规范化 JSON：对象键排序 + 无空白，用于稳定 requestHash。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashRequest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function ledgerKey(scope: string, method: string, clientRequestId: string): string {
  return `${scope}\u0000${method}\u0000${clientRequestId}`;
}

export class IdempotencyLedger {
  readonly #maxEntries: number;
  readonly #clock: () => Date;
  readonly #entries = new Map<string, LedgerEntry>();

  constructor(options: IdempotencyLedgerOptions) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new TypeError("IdempotencyLedger: maxEntries must be a positive safe integer");
    }
    this.#maxEntries = options.maxEntries;
    this.#clock = options.clock ?? (() => new Date());
  }

  get size(): number {
    return this.#entries.size;
  }

  lookup<TResult>(key: string, requestHash: string): LedgerLookup<TResult> {
    const entry = this.#entries.get(key) as LedgerEntry<TResult> | undefined;
    if (entry === undefined) return { kind: "miss" };
    if (entry.requestHash !== requestHash) return { kind: "conflict", entry };
    // 命中：刷新到队尾（近似 LRU，避免热键被淘汰）。
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return { kind: "hit", entry };
  }

  commit<TResult>(key: string, requestHash: string, result: TResult): LedgerEntry<TResult> {
    const entry: LedgerEntry<TResult> = {
      key,
      requestHash,
      result,
      committedAt: this.#clock().toISOString(),
    };
    this.#entries.set(key, entry as LedgerEntry);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    return entry;
  }

  /** 同键冲突时抛 ABI `session.conflict`（调用方不覆盖旧结果）。 */
  assertCompatible(key: string, requestHash: string): void {
    const entry = this.#entries.get(key);
    if (entry !== undefined && entry.requestHash !== requestHash) {
      throw moclError("session.conflict", {
        message: `idempotency key reused with different payload: ${key.split("\u0000").slice(1).join(":")}`,
      });
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

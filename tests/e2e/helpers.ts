/**
 * C9 E2E 测试假件：带事件队列的假适配器（零额度）。
 */
import type {
  AdapterCloseRequest,
  AdapterEvent,
  AdapterInterruptRequest,
  AdapterOpenRequest,
  AdapterOpenResult,
  AdapterResumeRequest,
  AdapterResumeResult,
  AdapterSendRequest,
  AdapterSendResult,
  BackendAdapter,
} from "../../src/abi/adapter.ts";
import { CAPABILITY_BITS, type CapabilityDeclaration } from "../../src/abi/index.ts";
import type { BackendId } from "../../src/abi/types.ts";

export class EventQueue {
  #items: AdapterEvent[] = [];
  #waiters: ((result: IteratorResult<AdapterEvent>) => void)[] = [];
  #closed = false;
  push(event: AdapterEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ value: event, done: false });
    else this.#items.push(event);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<AdapterEvent> {
    const iterator = {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolveNext) => this.#waiters.push(resolveNext));
      },
    };
    return Object.assign(iterator, { [Symbol.asyncIterator]: () => iterator }) as AsyncIterableIterator<AdapterEvent>;
  }
}

export function capabilitiesOf(backendId: BackendId): CapabilityDeclaration {
  return {
    abiVersion: "0.1",
    backendId,
    backendVersion: "test-9",
    transport: "app-server-jsonrpc",
    bits: CAPABILITY_BITS.map((bit) => ({ bit, state: "native" as const })),
    limits: {
      maxTurnMs: 1_800_000,
      idleTimeoutMs: 180_000,
      maxSessionsPerBackend: 8,
      maxNestingDepth: 2,
      maxConcurrentTurns: 2,
    },
    warnings: [],
    observedAt: "2026-10-26T00:00:00.000Z",
  };
}

/** 假适配器：open 可返回空 remoteId（模拟 kimi CLI D-020），send 产出完整事件序列。 */
export class StreamingFakeAdapter implements BackendAdapter {
  readonly backendId: BackendId;
  readonly capabilities: CapabilityDeclaration;
  readonly queue = new EventQueue();
  openCalls = 0;
  sendCalls = 0;
  resumeCalls = 0;
  closeCalls = 0;
  remoteId: string;
  /** send 后是否把 remoteId 回填为 `remote_after_turn`（模拟 kimi CLI 首轮）。 */
  backfillAfterSend: boolean;
  degraded = false;
  failSend: Error | null = null;

  constructor(backendId: BackendId, options: { remoteId?: string; backfillAfterSend?: boolean } = {}) {
    this.backendId = backendId;
    this.capabilities = capabilitiesOf(backendId);
    this.remoteId = options.remoteId ?? `remote_${backendId}`;
    this.backfillAfterSend = options.backfillAfterSend ?? false;
  }

  async open(_request: AdapterOpenRequest): Promise<AdapterOpenResult> {
    this.openCalls += 1;
    return { remoteSessionId: this.remoteId };
  }

  async send(_request: AdapterSendRequest): Promise<AdapterSendResult> {
    this.sendCalls += 1;
    if (this.failSend !== null) throw this.failSend;
    const turnId = `turn_fake_${this.sendCalls}`;
    const usage = { estimated: false, scope: "turn" as const, inputTokens: 3, outputTokens: 2, durationMs: 1 };
    if (this.degraded) {
      this.queue.push({ type: "session.warning", payload: { code: "auth.credential-expired", message: "degraded", degrade: true } });
    }
    this.queue.push({ type: "turn.started", turnId, payload: { model: "fake", delivery: "parent" } });
    this.queue.push({ type: "message.delta", turnId, payload: { channel: "assistant", messageId: "m1", granularity: "token", text: "OK" } });
    this.queue.push({ type: "usage.updated", turnId, payload: { usage } });
    this.queue.push({ type: "turn.completed", turnId, payload: { stopReason: "end-turn", usage, summary: "OK" } });
    if (this.backfillAfterSend) this.remoteId = "remote_after_turn";
    return { turnId };
  }

  async resume(_request: AdapterResumeRequest): Promise<AdapterResumeResult> {
    this.resumeCalls += 1;
    return { exists: true, remoteSessionId: this.remoteId };
  }

  async interrupt(_request: AdapterInterruptRequest): Promise<void> {}
  async close(_request: AdapterCloseRequest): Promise<void> {
    this.closeCalls += 1;
    this.queue.close();
  }

  async *events(): AsyncIterable<AdapterEvent> {
    yield* this.queue;
  }
}

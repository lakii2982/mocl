/**
 * 场景级假后端：只模拟「人类能观察到的控制面行为」，不模拟任何真实协议线格式。
 *
 * 能力：
 * - 正常一轮（turn.started → message.delta → usage.updated → turn.completed）；
 * - kimi CLI 式 pending 远端 id（D-020：首轮后才有 id，探测失败时保持 pending）；
 * - opencode 式降级（session.warning + degrade=true，D-019）；
 * - 长任务挂起（只发 turn.started，等 interrupt）；
 * - 进程死亡（kill() 关闭事件流，模拟宿主进程崩溃）。
 *
 * 限制：一个实例同一时间只服务一个会话（本套件的并发场景用「不同后端」表达，
 * 见 S06）。多会话同后端不在离线假件的覆盖范围内。
 */
import { CAPABILITY_BITS } from "../../src/abi/index.ts";

export class EventQueue {
  #items = [];
  #waiters = [];
  #closed = false;

  push(event) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ value: event, done: false });
    else this.#items.push(event);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    const iterator = {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolveNext) => this.#waiters.push(resolveNext));
      },
    };
    return Object.assign(iterator, { [Symbol.asyncIterator]: () => iterator });
  }
}

const TRANSPORT = {
  codex: "app-server-jsonrpc",
  "claude-code": "agent-sdk",
  kimi: "acp-stdio",
  opencode: "http-api",
};

const BACKEND_VERSION = {
  codex: "0.164.0-scenario",
  "claude-code": "0.3.263-scenario",
  kimi: "2.3.1-scenario",
  opencode: "2.1.4-scenario",
};

export function capabilitiesOf(backendId, overrides = {}) {
  return {
    abiVersion: "0.1",
    backendId,
    backendVersion: BACKEND_VERSION[backendId] ?? "scenario",
    transport: TRANSPORT[backendId] ?? "app-server-jsonrpc",
    bits: CAPABILITY_BITS.map((bit) => ({ bit, state: "native" })),
    limits: {
      maxTurnMs: 1_800_000,
      idleTimeoutMs: 180_000,
      maxSessionsPerBackend: 8,
      maxNestingDepth: 2,
      maxConcurrentTurns: 2,
    },
    warnings: [],
    observedAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

const USAGE = Object.freeze({ estimated: false, scope: "turn", inputTokens: 12, outputTokens: 4, durationMs: 5 });

export class ScenarioAdapter {
  /**
   * @param {string} backendId
   * @param {{
   *   remoteId?: string,
   *   remoteIdAfterTurn?: string|null,
   *   pendingResumeFailures?: number,
   *   remoteExists?: boolean,
   *   degrade?: {code?: string, message?: string}|null,
   *   hangOnSend?: boolean,
   *   failOpen?: Error|null,
   *   failSend?: Error|null,
   *   summary?: string,
   * }} behavior
   */
  constructor(backendId, behavior = {}) {
    this.backendId = backendId;
    this.behavior = behavior;
    this.capabilities = capabilitiesOf(backendId);
    this.remoteId = behavior.remoteId ?? `remote_${backendId}`;
    this.remoteExists = behavior.remoteExists ?? true;

    this.openCalls = 0;
    this.sendCalls = 0;
    this.resumeCalls = 0;
    this.interruptCalls = 0;
    this.closeCalls = 0;
    this.openRequests = [];
    this.sendRequests = [];
    this.turns = [];
    this.crashed = false;

    this.queue = new EventQueue();
  }

  async open(request) {
    this.openCalls += 1;
    this.openRequests.push(request);
    if (this.behavior.failOpen instanceof Error) throw this.behavior.failOpen;
    this.crashed = false;
    this.queue = new EventQueue();
    return { remoteSessionId: this.remoteId };
  }

  async send(request) {
    this.sendCalls += 1;
    this.sendRequests.push(request);
    if (this.crashed) {
      const error = new Error("scenario backend process is dead");
      error.code = "process.crashed";
      throw error;
    }
    if (this.behavior.failSend instanceof Error) throw this.behavior.failSend;

    const turnId = `turn_${this.backendId}_${this.sendCalls}`;
    this.turns.push(turnId);

    const degrade = this.behavior.degrade ?? null;
    if (degrade !== null) {
      this.queue.push({
        type: "session.warning",
        payload: {
          code: degrade.code ?? "model.free-fallback",
          message: degrade.message ?? "paid model rejected; degraded to free model (model=free-fallback)",
          degrade: true,
        },
      });
    }

    this.queue.push({ type: "turn.started", turnId, payload: { model: `scenario-${this.backendId}`, delivery: "parent" } });
    if (this.behavior.hangOnSend === true) {
      return { turnId };
    }

    this.queue.push({
      type: "message.delta",
      turnId,
      payload: { channel: "assistant", messageId: `msg_${turnId}`, granularity: "token", text: "OK" },
    });
    this.queue.push({ type: "usage.updated", turnId, payload: { usage: USAGE } });
    this.queue.push({
      type: "turn.completed",
      turnId,
      payload: { stopReason: "end-turn", usage: USAGE, summary: this.behavior.summary ?? "OK" },
    });

    const afterTurn = this.behavior.remoteIdAfterTurn ?? null;
    if (afterTurn !== null && this.remoteId === "") this.remoteId = afterTurn;
    return { turnId };
  }

  async resume() {
    this.resumeCalls += 1;
    const remaining = this.behavior.pendingResumeFailures ?? 0;
    if (!this.remoteExists) return { exists: false, reason: "not-found" };
    if (remaining > 0) {
      this.behavior.pendingResumeFailures = remaining - 1;
      return { exists: false, reason: "pending" };
    }
    return { exists: true, remoteSessionId: this.remoteId };
  }

  async interrupt() {
    this.interruptCalls += 1;
    const turnId = this.turns.at(-1) ?? `turn_${this.backendId}_interrupt`;
    this.queue.push({ type: "turn.aborted", turnId, payload: { reason: "interrupted" } });
  }

  async close() {
    this.closeCalls += 1;
    this.queue.close();
  }

  async *events() {
    yield* this.queue;
  }

  /** 模拟后端进程被 kill：事件流中断（没有终态事件）。 */
  kill() {
    this.crashed = true;
    this.queue.close();
  }

  /** 模拟远端会话被清理。 */
  deleteRemote() {
    this.remoteExists = false;
    this.remoteId = "";
  }
}

export function fakeAdapters(behaviorByBackend = {}) {
  return Object.fromEntries(
    ["codex", "claude-code", "kimi", "opencode"].map((backendId) => [
      backendId,
      new ScenarioAdapter(backendId, behaviorByBackend[backendId] ?? {}),
    ]),
  );
}

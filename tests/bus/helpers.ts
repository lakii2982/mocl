/**
 * EventBus 测试假件（C3）：事件工厂 + 可控时钟。
 *
 * 事件形状以 `src/abi/types.ts` 为准；这里只构造测试所需的最小 payload。
 */
import { randomUUID } from "node:crypto";
import type {
  MoclEvent,
  ProgressFoldedPayload,
  UsageRef,
} from "../../src/abi/types.ts";
import type { EventType } from "../../src/abi/events.ts";

export const SESSION = "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W";
export const BACKEND = { id: "codex", version: "0.164.0" } as const;
export const USAGE: UsageRef = { estimated: false, scope: "turn", inputTokens: 10, outputTokens: 20 };

export class TestClock {
  #now: number;
  constructor(start = 0) {
    this.#now = start;
  }
  now = (): number => this.#now;
  advance(ms: number): void {
    this.#now += ms;
  }
  set(ms: number): void {
    this.#now = ms;
  }
}

interface EventOverrides {
  readonly sessionId?: string;
  readonly epoch?: number;
  readonly eventId?: string;
  readonly turnId?: string;
  readonly ts?: string;
}

/** 通用事件构造（type 与 payload 由调用方保证匹配；测试专用）。 */
export function event<TType extends EventType>(
  type: TType,
  seq: number,
  payload: unknown,
  overrides: EventOverrides = {},
): MoclEvent {
  return {
    abiVersion: "0.1",
    eventId: overrides.eventId ?? randomUUID(),
    sessionId: overrides.sessionId ?? SESSION,
    seq,
    epoch: overrides.epoch ?? 1,
    ts: overrides.ts ?? new Date(0).toISOString(),
    type,
    backend: BACKEND,
    ...(overrides.turnId === undefined ? {} : { turnId: overrides.turnId }),
    payload,
  } as unknown as MoclEvent;
}

export function tokenDelta(seq: number, text: string, messageId = "msg_1", overrides: EventOverrides = {}): MoclEvent {
  return event(
    "message.delta",
    seq,
    { channel: "assistant", text, granularity: "token", messageId },
    { turnId: "turn_1", ...overrides },
  );
}

export function reasoningDelta(seq: number, text: string, messageId = "msg_r", overrides: EventOverrides = {}): MoclEvent {
  return event("reasoning.delta", seq, { text, granularity: "token", messageId }, { turnId: "turn_1", ...overrides });
}

export function turnStarted(seq: number, overrides: EventOverrides = {}): MoclEvent {
  return event(
    "turn.started",
    seq,
    { model: "test-model", delivery: "parent", inputDigest: "sha256:test" },
    { turnId: "turn_1", ...overrides },
  );
}

export function turnCompleted(seq: number, overrides: EventOverrides = {}): MoclEvent {
  return event(
    "turn.completed",
    seq,
    { stopReason: "end-turn", usage: USAGE, summary: "done" },
    { turnId: "turn_1", ...overrides },
  );
}

export function progressFolded(seq: number, payload: ProgressFoldedPayload, overrides: EventOverrides = {}): MoclEvent {
  return event("progress.folded", seq, payload, overrides);
}

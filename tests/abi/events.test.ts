import { describe, expect, it } from "vitest";
import {
  EVENT_FAMILIES,
  EVENT_TYPES,
  EVENT_TYPE_SET,
  TERMINAL_EVENT_TYPES,
  isEventType,
  isTerminalEvent,
  validateEvent,
} from "../../src/abi/index.ts";
function event(overrides: Record<string, unknown>): unknown {
  return {
    abiVersion: "0.1",
    eventId: "01J9ZR2B3C4D5E6F7G8H9J0K1M",
    sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W",
    seq: 7,
    epoch: 2,
    ts: "2026-10-25T13:54:07.123Z",
    backend: { id: "codex", version: "0.164.0" },
    ...overrides,
  };
}

describe("事件目录（ABI §7）", () => {
  it("恰好 35 个事件类型、无重复、按家族覆盖全部", () => {
    expect(EVENT_TYPES).toHaveLength(35);
    expect(EVENT_TYPE_SET.size).toBe(35);
    const familyMembers = Object.values(EVENT_FAMILIES).flat();
    expect(new Set(familyMembers)).toEqual(new Set(EVENT_TYPES));
    expect(familyMembers).toHaveLength(35);
  });

  it("终态事件是合法事件类型子集", () => {
    expect(TERMINAL_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const type of TERMINAL_EVENT_TYPES) expect(isEventType(type)).toBe(true);
    expect(isTerminalEvent("turn.completed")).toBe(true);
    expect(isTerminalEvent("message.delta")).toBe(false);
  });

  it("isEventType 区分 ABI 事件名与后端原生事件名", () => {
    expect(isEventType("message.delta")).toBe(true);
    expect(isEventType("item/agentMessage/delta")).toBe(false);
  });

  it("message.delta 事件通过 schema 的 oneOf 校验", () => {
    const result = validateEvent(
      event({
        type: "message.delta",
        turnId: "turn_01J9ZQ8K3M4N5P6Q7R8S9T0V1W",
        payload: {
          channel: "assistant",
          text: "OK",
          granularity: "token",
          messageId: "msg_1",
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("progress.folded 事件通过 schema 的 oneOf 校验（父会话增量）", () => {
    const result = validateEvent(
      event({
        type: "progress.folded",
        payload: {
          window: { startMs: 1761390000000, endMs: 1761390005000 },
          items: [{ kind: "tool", key: "tool:Read", text: "Read ×3", count: 3 }],
          dropped: { count: 274, kinds: ["message-delta"] },
          chars: 96,
          truncated: false,
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("未知 type 被 oneOf 拒绝", () => {
    const result = validateEvent(event({ type: "session.exploded", payload: {} }));
    expect(result.ok).toBe(false);
  });

  it("缺 epoch 的 envelope 被拒绝（v0 必填）", () => {
    const bad = event({ type: "turn.steered", payload: { steerSeq: 1 } }) as Record<string, unknown>;
    delete bad["epoch"];
    expect(validateEvent(bad).ok).toBe(false);
  });
});

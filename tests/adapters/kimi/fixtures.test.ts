/**
 * 录制回放（BRIEF A8 "录制回放"）：用 `tests/fixtures/kimi/*.jsonl` 的真实线格式帧
 * 驱动映射器，断言 §5.2 的 27 条映射与假件假设一致。
 *
 * 价值：假件（helpers.ts）是人写的；fixture 是**实测录下来的**。
 * 两者一起才能证明"契约测试不是自说自话"（docs/adapters/kimi.md §12.3）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KimiEventMapper } from "../../../src/adapters/kimi/events.ts";
import { assertHandshake } from "../../../src/adapters/kimi/index.ts";
import { FakeTransport } from "./helpers.ts";
import type { KimiCliEvent, KimiSessionUpdateParams } from "../../../src/adapters/kimi/types.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/kimi", import.meta.url));

function loadLines(name: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("录制回放：ACP 握手（K1）", () => {
  it("真实 initialize 响应通过握手断言", () => {
    const [frame] = loadLines("acp-initialize.jsonl");
    const result = frame?.["result"] as { protocolVersion: number; agentInfo: { version: string } };
    expect(result.protocolVersion).toBe(1);
    expect(() => assertHandshake(result.protocolVersion, result.agentInfo.version)).not.toThrow();
    expect(result.agentInfo.version).toBe("2.3.1");
  });

  it("真实 initialize 响应喂给客户端不会解析失败（字段齐全）", () => {
    const transport = new FakeTransport();
    const frames = loadLines("acp-initialize.jsonl");
    const [frame] = frames;
    const id = Number(frame?.["id"]);
    transport.sendFromServer(frame as Readonly<Record<string, unknown>>);
    expect(id).toBe(1);
  });
});

describe("录制回放：session/new（K4 权限档位来源）", () => {
  it("configOptions 含 model/thinking/mode；availableModes = default/plan/auto/yolo", () => {
    const [frame] = loadLines("acp-session-new.jsonl");
    const result = frame?.["result"] as {
      sessionId: string;
      configOptions: { id: string; currentValue?: string }[];
      modes: { currentModeId: string; availableModes: { id: string }[] };
    };
    expect(result.sessionId).toMatch(/^session_/);
    expect(result.configOptions.map((option) => option.id)).toEqual(["model", "thinking", "mode"]);
    expect(result.modes.availableModes.map((mode) => mode.id)).toEqual(["default", "plan", "auto", "yolo"]);
    // 实测：session/new 的 currentModeId 不可作为权威快照（§3.2）
    expect(result.modes.currentModeId).toBe("default");
  });

  it("thinking 的 effort 取值实测为 low/high/max", () => {
    const [frame] = loadLines("acp-session-new.jsonl");
    const result = frame?.["result"] as { configOptions: { id: string; options?: { value: string }[] }[] };
    const thinking = result.configOptions.find((option) => option.id === "thinking");
    expect(thinking?.options?.map((option) => option.value)).toEqual(["low", "high", "max"]);
  });
});

describe("录制回放：session/update 全序列（§5.2 #6–#16）", () => {
  it("13 条真实通知 → 只产出 ABI 允许的事件，丢弃项全部计数", () => {
    const mapper = new KimiEventMapper({ sessionId: "s1", cwd: "/tmp/work", expectedProfile: "safe-auto" });
    mapper.beginTurn("turn_1", "kimi-code/k3.1-pro");
    const produced: string[] = [];
    for (const frame of loadLines("acp-updates.jsonl")) {
      const params = frame["params"] as unknown as KimiSessionUpdateParams;
      for (const event of mapper.mapAcpUpdate(params)) {
        produced.push(event.type);
        // 不变量：原生名不得泄漏到事件类型
        expect(event.type).toMatch(/^(session|turn|message|reasoning|tool|usage|permission|transport|diagnostic)\./);
      }
    }
    // 关键映射都在
    expect(produced).toContain("tool.started");
    expect(produced).toContain("tool.progress");
    expect(produced).toContain("tool.completed");
    expect(produced).toContain("message.delta");
    expect(produced).toContain("usage.updated");
    // reasoning 默认不进父会话（fragment 洪水）
    expect(produced).not.toContain("reasoning.delta");
    // 三类必须丢弃并计数
    const stats = mapper.counters.snapshot();
    expect(stats["drop.available_commands_update"]).toBe(1);
    expect(stats["drop.session_info_update"]).toBe(1);
    expect(stats["drop.config_option_update"]).toBe(1);
    expect(stats["fold.reasoning_dropped"]).toBe(3);
    // title 被记为非事件信息
    expect(mapper.title).toContain("a.txt");
  });

  it("usage_update 的 used/size 不冒充计费 token", () => {
    const mapper = new KimiEventMapper({ sessionId: "s1", cwd: "/tmp/work", expectedProfile: "safe-auto" });
    mapper.beginTurn("turn_1", "m");
    for (const frame of loadLines("acp-updates.jsonl")) {
      mapper.mapAcpUpdate(frame["params"] as unknown as KimiSessionUpdateParams);
    }
    expect(mapper.usage).toMatchObject({ estimated: true, scope: "turn" });
    expect(mapper.usage?.inputTokens).toBeUndefined();
  });
});

describe("录制回放：权限请求（K5）", () => {
  it("真实 Write 请求在 read-only 档 → deny，且 answer 指向真实存在的 optionId", () => {
    const [frame] = loadLines("acp-permission-request.jsonl");
    const params = frame?.["params"] as unknown as Readonly<Record<string, unknown>>;
    const mapper = new KimiEventMapper({ sessionId: "s1", cwd: "/tmp/work", expectedProfile: "read-only" });
    mapper.beginTurn("turn_1", "m");
    const { events, answer } = mapper.mapPermissionRequest(Number(frame?.["id"]), params);
    expect(events.map((event) => event.type)).toEqual(["permission.requested", "permission.resolved"]);
    expect(events[0]?.payload).toMatchObject({ requestId: String(frame?.["id"]), tool: "Write", risk: "write" });
    expect(answer.decision).toBe("deny");
    expect(answer.optionId).toBe("reject");
    // 回包的 optionId 必须是请求里真实存在的
    const nativeOptions = (params["options"] as { optionId: string }[]).map((option) => option.optionId);
    expect(nativeOptions).toContain(answer.optionId);
  });
});

describe("录制回放：session/cancel → -32601（D-008）", () => {
  it("错误帧被分类为 protocol.unknown-method（无单轮中断的证据）", async () => {
    const [frame] = loadLines("acp-cancel-method-not-found.jsonl");
    const transport = new FakeTransport();
    const id = Number(frame?.["id"]);
    // 直接把录到的错误帧丢给客户端：它应当把对应请求标成 unknown-method
    transport.sendFromServer(frame as Readonly<Record<string, unknown>>);
    expect((frame?.["error"] as { code: number }).code).toBe(-32601);
    expect(id).toBe(4);
  });
});

describe("录制回放：CLI stream-json（兜底通道）", () => {
  it("5 条真实事件 → message/tool/meta 分流正确，resume_hint 不被当事件", () => {
    const mapper = new KimiEventMapper({ sessionId: "s1", cwd: "/tmp/work", expectedProfile: "read-only" });
    mapper.beginTurn("turn_cli", "kimi-code/k3.1-pro");
    const produced: string[] = [];
    for (const frame of loadLines("cli-stream-json.jsonl")) {
      for (const event of mapper.mapCliEvent(frame as unknown as KimiCliEvent)) produced.push(event.type);
    }
    for (const event of mapper.finishCliTurn(0)) produced.push(event.type);
    expect(produced).toContain("tool.started");
    expect(produced).toContain("tool.completed");
    expect(produced).toContain("message.completed");
    expect(produced).toContain("turn.completed");
    const stats = mapper.counters.snapshot();
    expect(stats["drop.cli_meta.system.version"]).toBe(1);
    expect(stats["drop.cli_meta.session.resume_hint"]).toBe(1);
    // 一条 turn.completed 恰一次
    expect(produced.filter((type) => type === "turn.completed")).toHaveLength(1);
  });
});

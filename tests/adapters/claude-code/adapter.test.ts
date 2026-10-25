import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import {
  FakeProber,
  collectEvents,
  handshake,
  initMessage,
  makeHarness,
  makeWorkdir,
  openSession,
  tick,
} from "./helpers.ts";

const SESSION_ID = "sess_01J9ZQ8K3M4N5P6Q7R8S9C5AB";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function canUseToolOf(sdk: { calls: { options: Record<string, unknown> }[] }, index = 0): unknown {
  return sdk.calls[index]?.options["canUseTool"];
}

describe("claude-code 适配器：握手 / 能力声明 / 校验", () => {
  it("capabilities 在 open() 之前不可用（必须来自 open 的实测/契约面）", () => {
    const harness = makeHarness();
    let thrown: unknown;
    try {
      harness.adapter.capabilities;
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe("capability.missing");
  });

  it("open：客户端预生成 UUID sessionId（先于 init 可知）+ persistSession/host 权限桥 + 34 位能力", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness({ capacity: 8 });
      const opened = await openSession(harness, { cwd: dir });
      // stream 模式下 SDK 首个输入后才发 init，故 open 必须返回预生成 id（保证可续接）
      expect(opened.remoteSessionId).toMatch(UUID_V4);
      const options = harness.sdk.calls[0]?.options ?? {};
      expect(options["sessionId"]).toBe(opened.remoteSessionId);
      expect(options["cwd"]).toBe(realpathSync(dir));
      expect(options["persistSession"]).toBe(true);
      expect(options["permissionPrompts"]).toBe("host");
      expect(options["permissionMode"]).toBe("dontAsk");
      expect(typeof options["canUseTool"]).toBe("function");
      expect(options["disallowedTools"]).toContain("AskUserQuestion");
      expect(options["env"]).toBeTypeOf("object");
      const caps = harness.adapter.capabilities;
      expect(caps.backendId).toBe("claude-code");
      expect(caps.backendVersion).toBe("0.3.263+2.1.263");
      expect(caps.transport).toBe("agent-sdk");
      expect(caps.bits).toHaveLength(34);
      expect(caps.bits.find((entry) => entry.bit === "sandboxModes")?.state).toBe("emulated");
      expect(caps.bits.find((entry) => entry.bit === "concurrencyControl")?.state).toBe("unavailable");
      expect(caps.limits).toEqual({
        maxTurnMs: 1_800_000,
        idleTimeoutMs: 120_000,
        maxSessionsPerBackend: 8,
        maxNestingDepth: 1,
        maxConcurrentTurns: 8,
      });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("运行时并发来源缺失/非法 → open 前 fail-closed（capability.missing）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const { ClaudeCodeAdapter } = await import("../../../src/adapters/claude-code/index.ts");
      const noRuntime = new ClaudeCodeAdapter({ initTimeoutMs: 50 });
      await expect(noRuntime.open({ sessionId: SESSION_ID, cwd: dir, epoch: 1 })).rejects.toMatchObject({
        code: "capability.missing",
      });
      const badRuntime = new ClaudeCodeAdapter({ runtime: { read: () => ({ maxActiveSubagents: 0 }) }, initTimeoutMs: 50 });
      await expect(badRuntime.open({ sessionId: SESSION_ID, cwd: dir, epoch: 1 })).rejects.toMatchObject({
        code: "capability.missing",
      });
      const throwing = new ClaudeCodeAdapter({
        runtime: {
          read: () => {
            throw new Error("seam config missing");
          },
        },
        initTimeoutMs: 50,
      });
      await expect(throwing.open({ sessionId: SESSION_ID, cwd: dir, epoch: 1 })).rejects.toMatchObject({
        code: "capability.missing",
      });
    } finally {
      await cleanup();
    }
  });

  it("cwd 校验：相对路径/不存在/越出 allowedRoots → policy.sandbox-violation", async () => {
    const workdir = await makeWorkdir();
    const other = await makeWorkdir();
    try {
      const harness = makeHarness({ adapter: { allowedRoots: [workdir.dir] } });
      await expect(
        harness.adapter.open({ sessionId: SESSION_ID, cwd: "relative/path", epoch: 1 }),
      ).rejects.toMatchObject({ code: "policy.sandbox-violation" });
      await expect(
        harness.adapter.open({ sessionId: SESSION_ID, cwd: "/definitely/not/exists", epoch: 1 }),
      ).rejects.toMatchObject({ code: "policy.sandbox-violation" });
      await expect(
        harness.adapter.open({ sessionId: SESSION_ID, cwd: other.dir, epoch: 1 }),
      ).rejects.toMatchObject({ code: "policy.sandbox-violation" });
      await harness.adapter.dispose();
    } finally {
      await workdir.cleanup();
      await other.cleanup();
    }
  });

  it("首个 send 内做 init 握手：CLI 版本不符 → protocol.version-mismatch，且后续 send 立即失败", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness();
      const opened = await openSession(harness, { cwd: dir });
      const sending = harness.adapter.send({
        sessionId: opened.sessionId,
        remoteSessionId: opened.remoteSessionId,
        input: [{ type: "text", text: "hi" }],
        idempotencyKey: "version-1",
      });
      await tick();
      harness.queries[0]?.push(initMessage({ claude_code_version: "2.0.0" }));
      await expect(sending).rejects.toMatchObject({ code: "protocol.version-mismatch" });
      await expect(
        harness.adapter.send({
          sessionId: opened.sessionId,
          remoteSessionId: opened.remoteSessionId,
          input: [{ type: "text", text: "again" }],
          idempotencyKey: "version-2",
        }),
      ).rejects.toMatchObject({ code: "protocol.version-mismatch" });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("init 的 session_id 与预生成 id 不一致 → protocol.unexpected-response", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness();
      const opened = await openSession(harness, { cwd: dir });
      const sending = harness.adapter.send({
        sessionId: opened.sessionId,
        remoteSessionId: opened.remoteSessionId,
        input: [{ type: "text", text: "hi" }],
        idempotencyKey: "id-1",
      });
      await tick();
      harness.queries[0]?.push(initMessage({ session_id: "11111111-2222-4333-8444-555555555555" }));
      await expect(sending).rejects.toMatchObject({ code: "protocol.unexpected-response" });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("init 首帧超时 → transport.timeout（挂起防护，不无限等）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness({ adapter: { initTimeoutMs: 20 } });
      const opened = await openSession(harness, { cwd: dir });
      await expect(
        harness.adapter.send({
          sessionId: opened.sessionId,
          remoteSessionId: opened.remoteSessionId,
          input: [{ type: "text", text: "hi" }],
          idempotencyKey: "timeout-1",
        }),
      ).rejects.toMatchObject({ code: "transport.timeout" });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });
});

describe("claude-code 适配器：send / 事件 / 权限 / 中断 / 续接 / 关闭", () => {
  it("send：握手后推送用户消息并返回 ABI turnId；result 后发 turn.completed", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness();
      const opened = await openSession(harness, { cwd: dir });
      const sending = harness.adapter.send({
        sessionId: opened.sessionId,
        remoteSessionId: opened.remoteSessionId,
        input: [{ type: "text", text: "hello" }],
        idempotencyKey: "send-1",
      });
      await tick();
      await handshake(harness);
      const sent = await sending;
      expect(sent.turnId).toMatch(/^turn_/);
      // 输入流里能读到用户消息
      const prompt = harness.sdk.calls[0]?.prompt as AsyncIterable<{ message: { content: { text?: string }[] } }>;
      const iterator = prompt[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value?.message.content[0]?.text).toBe("hello");
      harness.queries[0]?.push({ type: "result", subtype: "success", is_error: false, result: "OK" } as never);
      const events = await collectEvents(harness.adapter, { until: (event) => event.type === "turn.completed" });
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);
      expect(events.some((event) => event.type === "session.created")).toBe(true);
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("canUseTool 被注入且拒绝写工具；拒绝会产出 permission.requested/resolved 对", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness();
      await openSession(harness, { cwd: dir });
      const canUseTool = canUseToolOf(harness.sdk) as (
        tool: string,
        input: Record<string, unknown>,
        ctx: { toolUseID?: string },
      ) => Promise<{ behavior: string; message?: string }>;
      const decision = await canUseTool("Write", {}, { toolUseID: "toolu_w1" });
      expect(decision.behavior).toBe("deny");
      const events = await collectEvents(harness.adapter, {
        until: (event) => event.type === "permission.resolved",
        timeoutMs: 500,
      });
      const types = events.map((event) => event.type);
      expect(types).toContain("permission.requested");
      expect(types).toContain("permission.resolved");
      const resolved = events.find((event) => event.type === "permission.resolved");
      expect(resolved?.payload).toMatchObject({ requestId: "toolu_w1", decision: "deny", by: "policy" });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("interrupt：调用 SDK Query.interrupt()；随后 result 映射为 turn.aborted", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness();
      const opened = await openSession(harness, { cwd: dir });
      const sending = harness.adapter.send({
        sessionId: opened.sessionId,
        remoteSessionId: opened.remoteSessionId,
        input: [{ type: "text", text: "long task" }],
        idempotencyKey: "i-1",
      });
      await tick();
      await handshake(harness);
      await sending;
      await harness.adapter.interrupt({ sessionId: opened.sessionId, remoteSessionId: opened.remoteSessionId });
      expect(harness.queries[0]?.interrupts).toHaveLength(1);
      harness.queries[0]?.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"] } as never);
      const events = await collectEvents(harness.adapter, { until: (event) => event.type === "turn.aborted" });
      expect(events.some((event) => event.type === "turn.aborted")).toBe(true);
      expect(events.some((event) => event.type === "turn.failed")).toBe(false);
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("resume：探测不到会话文件 → exists=false（交 Broker 走 R-1 reseed）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const prober = new FakeProber();
      const harness = makeHarness({ prober });
      const result = await harness.adapter.resume({
        sessionId: SESSION_ID,
        remoteSessionId: "0f7c1f0e-1111-4222-8333-944455556666",
        fromSeq: 0,
      });
      expect(result).toEqual({ exists: false, reason: "not-found" });
      expect(prober.probes).toEqual(["0f7c1f0e-1111-4222-8333-944455556666"]);
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("resume：探测到会话但适配器无句柄 → exists=true 且不重复起进程（由 send 再恢复）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const remoteId = "0f7c1f0e-1111-4222-8333-944455556666";
      const prober = new FakeProber(new Set([remoteId]));
      const harness = makeHarness({ prober });
      const result = await harness.adapter.resume({ sessionId: SESSION_ID, remoteSessionId: remoteId, fromSeq: 0 });
      expect(result).toEqual({ exists: true, remoteSessionId: remoteId });
      expect(harness.sdk.queries).toHaveLength(0);
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("resume：已在线会话直接 exists=true（不重新探测文件）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness();
      const opened = await openSession(harness, { cwd: dir });
      const result = await harness.adapter.resume({
        sessionId: opened.sessionId,
        remoteSessionId: opened.remoteSessionId,
        fromSeq: 0,
      });
      expect(result.exists).toBe(true);
      expect(harness.prober.probes).toHaveLength(0);
      expect(harness.sdk.queries).toHaveLength(1);
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("关闭：query.close() + 结束事件流；重复 close 幂等；dispose 后 send 拒绝", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness();
      const opened = await openSession(harness, { cwd: dir });
      await harness.adapter.close({ sessionId: opened.sessionId, remoteSessionId: opened.remoteSessionId, reason: "completed" });
      expect(harness.queries[0]?.closed).toBe(true);
      const events: AdapterEvent[] = [];
      for await (const event of harness.adapter.events()) {
        events.push(event);
        if (events.length > 20) break;
      }
      expect(events.some((event) => event.type === "transport.state-changed")).toBe(true);
      await harness.adapter.close({ sessionId: opened.sessionId, remoteSessionId: opened.remoteSessionId, reason: "operator" });
      await expect(
        harness.adapter.send({
          sessionId: SESSION_ID,
          remoteSessionId: opened.remoteSessionId,
          input: [{ type: "text", text: "x" }],
          idempotencyKey: "after-close",
        }),
      ).rejects.toMatchObject({ code: "transport.disconnected" });
    } finally {
      await cleanup();
    }
  });

  it("多会话：每会话独立 query；关闭其一不影响另一个，全部关闭后 dispose", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness();
      const first = await openSession(harness, { cwd: dir, sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9C5A1" });
      const second = await openSession(harness, { cwd: dir, sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9C5A2" });
      expect(harness.sdk.queries).toHaveLength(2);
      expect(first.remoteSessionId).not.toBe(second.remoteSessionId);
      await harness.adapter.close({ sessionId: first.sessionId, remoteSessionId: first.remoteSessionId, reason: "completed" });
      expect(harness.sdk.queries[0]?.closed).toBe(true);
      expect(harness.sdk.queries[1]?.closed).toBe(false);
      await harness.adapter.close({ sessionId: second.sessionId, remoteSessionId: second.remoteSessionId, reason: "completed" });
      expect(harness.sdk.queries[1]?.closed).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("并发槽位与适配器无关：limits 只用运行时 seam 值（不写死数字）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness({ capacity: 3 });
      const opened = await openSession(harness, { cwd: dir });
      expect(harness.adapter.capabilities.limits.maxSessionsPerBackend).toBe(3);
      expect(harness.adapter.capabilities.limits.maxConcurrentTurns).toBe(3);
      expect(opened.remoteSessionId).toMatch(UUID_V4);
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("dispose 后 events() 流结束（transport.state-changed closed）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness();
      await openSession(harness, { cwd: dir });
      await harness.adapter.dispose();
      const events: AdapterEvent[] = [];
      for await (const event of harness.adapter.events()) events.push(event);
      expect(events.some((event) => event.type === "transport.state-changed")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

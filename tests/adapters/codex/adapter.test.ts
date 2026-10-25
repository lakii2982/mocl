import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import type { ScriptDirective } from "./helpers.ts";
import {
  collectEvents,
  handshakeDirectives,
  loadScript,
  makeHarness,
  makeWorkdir,
} from "./helpers.ts";

const THREAD = "01a1thread000000000000000001";
const TURN = "01a1turn000000000000000000001";
const TEXT_INPUT = [{ type: "text" as const, text: "hello" }];

function requestMethods(server: { requests: readonly { method: string }[] }): string[] {
  return server.requests.map((request) => request.method);
}

async function opened(script: readonly ScriptDirective[], options: { capacity?: number; workdir: string; allowedRoots?: readonly string[] }) {
  const harness = makeHarness({
    script,
    ...(options.capacity === undefined ? {} : { runtimeCapacity: options.capacity }),
    adapter: {
      ...(options.allowedRoots === undefined ? {} : { allowedRoots: options.allowedRoots }),
      requestTimeoutMs: 500,
    },
  });
  const result = await harness.adapter.open({
    sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W",
    cwd: options.workdir,
    permissionProfile: "read-only",
    epoch: 1,
  });
  return { ...harness, result };
}

describe("codex 适配器：握手 / 能力声明 / cwd 校验", () => {
  it("capabilities 在 open() 之前不可用（ABI：必须来自握手实测）", () => {
    const harness = makeHarness();
    let thrown: unknown;
    try {
      harness.adapter.capabilities;
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe("capability.missing");
  });

  it("open：initialize → config/read → thread/start(ephemeral:false)；返回 remoteSessionId + 34 位能力声明", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const { adapter, server, result } = await opened(await loadScript("handshake"), { workdir: dir, capacity: 8 });
      expect(result.remoteSessionId).toBe(THREAD);
      expect(requestMethods(server)).toEqual(["initialize", "config/read", "thread/start"]);
      const startParams = server.requests[2]?.params as Record<string, unknown>;
      expect(startParams).toMatchObject({ cwd: realpathSync(dir), ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
      const caps = adapter.capabilities;
      expect(caps.backendId).toBe("codex");
      expect(caps.backendVersion).toBe("0.164.0");
      expect(caps.transport).toBe("app-server-jsonrpc");
      expect(caps.bits).toHaveLength(34);
      expect(caps.bits.find((entry) => entry.bit === "concurrencyControl")?.state).toBe("native");
      expect(caps.bits.find((entry) => entry.bit === "inputInbox")?.state).toBe("unavailable");
      expect(caps.limits).toEqual({
        maxTurnMs: 1_800_000,
        idleTimeoutMs: 120_000,
        maxSessionsPerBackend: 8,
        maxNestingDepth: 2,
        maxConcurrentTurns: 3,
      });
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("并发一律运行时派生：seam 容量下调后 maxConcurrentTurns 跟着 clamp（D-016）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const { adapter } = await opened(await loadScript("handshake"), { workdir: dir, capacity: 2 });
      expect(adapter.capabilities.limits.maxSessionsPerBackend).toBe(2);
      expect(adapter.capabilities.limits.maxConcurrentTurns).toBe(2);
      expect(adapter.capabilities.warnings).toContain("limit-clamped-to-runtime: maxConcurrentTurns");
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("config/read 缺 agents 上限 → fail-closed（capability.missing + missingBits）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness({ script: await loadScript("handshake-no-agents"), adapter: { requestTimeoutMs: 500 } });
      await expect(
        harness.adapter.open({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V2X", cwd: dir, epoch: 1 }),
      ).rejects.toMatchObject({
        code: "capability.missing",
        details: { missingBits: ["concurrencyControl"] },
      });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("运行时并发 provider 读取失败 → fail-closed，不猜默认值", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const harness = makeHarness({ script: await loadScript("handshake") });
      const broken = new (await import("../../../src/adapters/codex/index.ts")).CodexAdapter({
        requestTimeoutMs: 500,
        runtime: {
          read: () => {
            throw new Error("seam config missing");
          },
        },
        spawn: () => ({ child: harness.child, killTree: () => undefined }),
      });
      await expect(broken.open({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V3Y", cwd: dir, epoch: 1 })).rejects.toMatchObject({
        code: "capability.missing",
      });
      await broken.dispose();
    } finally {
      await cleanup();
    }
  });

  it("cwd 校验：相对路径/不存在/越界根 → policy.sandbox-violation", async () => {
    const { dir, cleanup } = await makeWorkdir();
    const other = await makeWorkdir();
    try {
      const harness = makeHarness({
        script: [...(await loadScript("handshake")), ...(await loadScript("handshake"))],
        adapter: { requestTimeoutMs: 500, allowedRoots: [dir] },
      });
      await expect(
        harness.adapter.open({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V4Z", cwd: "relative/path", epoch: 1 }),
      ).rejects.toMatchObject({ code: "policy.sandbox-violation" });
      await expect(
        harness.adapter.open({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V5A", cwd: "/definitely/not/exist", epoch: 1 }),
      ).rejects.toMatchObject({ code: "policy.sandbox-violation" });
      await expect(
        harness.adapter.open({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V6B", cwd: other.dir, epoch: 1 }),
      ).rejects.toMatchObject({ code: "policy.sandbox-violation" });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
      await other.cleanup();
    }
  });

  it("版本断言失败 → protocol.version-mismatch（不混跑旧载荷）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const script = handshakeDirectives({
        userAgent: "mocl-codex/0.153.4 (Mac OS 27.0.1; arm64) dumb (mocl-codex; 0.1)",
      });
      const harness = makeHarness({ script, adapter: { requestTimeoutMs: 500 } });
      await expect(
        harness.adapter.open({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V7C", cwd: dir, epoch: 1 }),
      ).rejects.toMatchObject({ code: "protocol.version-mismatch" });
      await harness.adapter.dispose();
    } finally {
      await cleanup();
    }
  });
});

describe("codex 适配器：send / 事件流 / 续接 / 中断 / 关闭", () => {
  it("send：turn/start 带 clientUserMessageId；事件流覆盖消息/工具/计划/diff/用量/终态", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const { adapter, server } = await opened(await loadScript("turn-success"), { workdir: dir, capacity: 8 });
      const sent = await adapter.send({
        sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W",
        remoteSessionId: THREAD,
        input: TEXT_INPUT,
        idempotencyKey: "send-1",
      });
      expect(sent.turnId).toMatch(/^turn_[0-9A-HJKMNP-TV-Z]{26}$/);
      const turnStart = server.requests.find((request) => request.method === "turn/start");
      expect(turnStart?.params).toMatchObject({ threadId: THREAD, clientUserMessageId: "send-1" });

      const events = await collectEvents(adapter, { until: (event) => event.type === "turn.completed", timeoutMs: 2_000 });
      const types = events.map((event) => event.type);
      expect(types).toContain("transport.state-changed");
      expect(types).toContain("turn.started");
      expect(types).toContain("message.delta");
      expect(types).toContain("tool.started");
      expect(types).toContain("tool.progress");
      expect(types).toContain("tool.completed");
      expect(types).toContain("plan.updated");
      expect(types).toContain("diff.updated");
      expect(types).toContain("usage.updated");
      expect(types).toContain("turn.completed");
      expect(types.filter((type) => type === "turn.completed")).toHaveLength(1);
      expect(types[types.length - 1]).toBe("turn.completed");
      // 丢弃计数包含 plan/delta 与 thread/name/updated；终态后的迟到 delta 也被丢（EV-4）
      expect(adapter.droppedCounts).toMatchObject({
        "item/plan/delta": 1,
        "thread/name/updated": 1,
        "item/agentMessage/delta:late": 1,
      });
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("失败轮：error 通知 + turn/completed(failed) → 恰一个 turn.failed（backend.internal-error）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const { adapter } = await opened(await loadScript("turn-failed"), { workdir: dir, capacity: 8 });
      await adapter.send({
        sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W",
        remoteSessionId: THREAD,
        input: TEXT_INPUT,
        idempotencyKey: "send-fail",
      });
      const events = await collectEvents(adapter, { until: (event) => event.type === "turn.failed", timeoutMs: 2_000 });
      const failed = events.filter((event) => event.type === "turn.failed" || event.type === "turn.completed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        type: "turn.failed",
        payload: { error: { code: "backend.internal-error" }, partial: true },
      });
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("10 个 ServerRequest 全部被应答；未知 method 回 -32601；不挂起", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const { adapter, server } = await opened(await loadScript("server-requests"), { workdir: dir, capacity: 8 });
      await adapter.send({
        sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W",
        remoteSessionId: THREAD,
        input: TEXT_INPUT,
        idempotencyKey: "send-approvals",
      });
      const events = await collectEvents(adapter, { until: (event) => event.type === "turn.completed", timeoutMs: 2_000 });
      const responses = server.responses;
      expect(responses).toHaveLength(11); // 10 个已知 + 1 个未知
      expect(responses.filter((response) => response.error === undefined)).toHaveLength(8); // 8 个确定性 result
      expect(responses.filter((response) => response.error !== undefined)).toHaveLength(3); // 2 个不可伪造 + 1 个未知
      expect(adapter.approvalCounts["item/commandExecution/requestApproval"]).toBe(1);
      expect(adapter.approvalCounts["applyPatchApproval"]).toBe(1);
      // 权限/输入请求对父级可见（各一对 requested/resolved）
      const types = events.map((event) => event.type);
      expect(types).toContain("permission.requested");
      expect(types).toContain("permission.resolved");
      expect(types).toContain("input.requested");
      expect(types).toContain("input.resolved");
      expect(types).toContain("turn.completed");
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("resume：thread/read 命中 → thread/resume → exists=true 且回填 remoteSessionId", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const script = [
        ...handshakeDirectives(),
        { on: "request", method: "thread/read", reply: { thread: { id: THREAD } } },
        { on: "request", method: "thread/resume", reply: { thread: { id: THREAD }, model: "gpt-6-astra" } },
      ] satisfies ScriptDirective[];
      const { adapter } = await opened(script, { workdir: dir, capacity: 8 });
      const result = await adapter.resume({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W", remoteSessionId: THREAD, fromSeq: 3 });
      expect(result).toEqual({ exists: true, remoteSessionId: THREAD });
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("resume：read 报 no rollout 但 loaded/list 含线程 → 仍视为已加载可续接", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const script: ScriptDirective[] = [
        ...handshakeDirectives(),
        { on: "request", method: "thread/read", error: { code: -32600, message: `no rollout found for thread id ${THREAD}` } },
        { on: "request", method: "thread/loaded/list", reply: { data: [THREAD] } },
        { on: "request", method: "thread/resume", reply: { thread: { id: THREAD } } },
      ];
      const { adapter } = await opened(script, { workdir: dir, capacity: 8 });
      const result = await adapter.resume({
        sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W",
        remoteSessionId: THREAD,
        fromSeq: 0,
      });
      expect(result.exists).toBe(true);
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("resume：read 失败且 loaded 列表没有 → exists=false（上层走 R-1 降级）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const script: ScriptDirective[] = [
        ...handshakeDirectives(),
        { on: "request", method: "thread/read", error: { code: -32600, message: "no rollout found for thread id gone" } },
        { on: "request", method: "thread/loaded/list", reply: { data: [] } },
      ];
      const { adapter } = await opened(script, { workdir: dir, capacity: 8 });
      const result = await adapter.resume({
        sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W",
        remoteSessionId: "gone",
        fromSeq: 0,
      });
      expect(result.exists).toBe(false);
      expect(result.reason).toBeDefined();
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("interrupt：已知最近一轮 → turn/interrupt；无进行中轮 → 幂等空操作", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const script: ScriptDirective[] = [
        ...handshakeDirectives(),
        { on: "request", method: "turn/start", reply: { turn: { id: TURN, status: "inProgress" } } },
        { on: "request", method: "turn/interrupt", reply: {} },
      ];
      const { adapter, server } = await opened(script, { workdir: dir, capacity: 8 });
      const sessionId = "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W";
      await adapter.send({ sessionId, remoteSessionId: THREAD, input: TEXT_INPUT, idempotencyKey: "i-1" });
      await adapter.interrupt({ sessionId, remoteSessionId: THREAD });
      const interrupt = server.requests.find((request) => request.method === "turn/interrupt");
      expect(interrupt?.params).toEqual({ threadId: THREAD, turnId: TURN });
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });

  it("close：thread/unsubscribe → 关闭最后一个会话后停传输并结束事件流", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const script: ScriptDirective[] = [
        ...handshakeDirectives(),
        { on: "request", method: "thread/unsubscribe", reply: { status: "notLoaded" } },
      ];
      const { adapter, server, child } = await opened(script, { workdir: dir, capacity: 8 });
      const sessionId = "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V1W";
      await adapter.close({ sessionId, remoteSessionId: THREAD, reason: "completed" });
      expect(server.requests.some((request) => request.method === "thread/unsubscribe")).toBe(true);
      expect(child.kills).toContain("SIGTERM");
      const events: AdapterEvent[] = [];
      for await (const event of adapter.events()) {
        events.push(event);
        if (events.length > 20) break;
      }
      expect(events.some((event) => event.type === "transport.state-changed" && (event.payload as { state?: string }).state === "closed")).toBe(true);
      // 幂等：再次 close 不抛
      await adapter.close({ sessionId, remoteSessionId: "gone", reason: "operator" });
    } finally {
      await cleanup();
    }
  });

  it("send 使用未知 remote id 时能重建 handle（冷恢复场景）", async () => {
    const { dir, cleanup } = await makeWorkdir();
    try {
      const script: ScriptDirective[] = [
        ...handshakeDirectives(),
        { on: "request", method: "turn/start", reply: { turn: { id: TURN, status: "inProgress" } } },
      ];
      const { adapter } = await opened(script, { workdir: dir, capacity: 8 });
      const unsent = await adapter.send({
        sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V9Z",
        remoteSessionId: "01a1thread0000000000000009aa",
        input: TEXT_INPUT,
        idempotencyKey: "cold-1",
      });
      expect(unsent.turnId).toMatch(/^turn_/);
      await expect(
        adapter.send({ sessionId: "sess_01J9ZQ8K3M4N5P6Q7R8S9T0V9Y", remoteSessionId: "", input: TEXT_INPUT, idempotencyKey: "cold-2" }),
      ).rejects.toMatchObject({ code: "session.not-found" });
      await adapter.dispose();
    } finally {
      await cleanup();
    }
  });
});

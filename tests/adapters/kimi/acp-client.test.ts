import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KimiAcpClient } from "../../../src/adapters/kimi/acp-client.ts";
import { MoclError } from "../../../src/broker/errors.ts";
import { FakeTransport, kimiInitResult, makeTempDir } from "./helpers.ts";

function makeClient(
  transport: FakeTransport,
  overrides: Partial<ConstructorParameters<typeof KimiAcpClient>[0]> = {},
): KimiAcpClient {
  return new KimiAcpClient({ transport, ...overrides });
}

function frameOf(transport: FakeTransport, id: number): { result?: unknown; error?: { code: number; message: string } } | undefined {
  for (const line of transport.written) {
    const parsed = JSON.parse(line) as { id?: number; result?: unknown; error?: { code: number; message: string } };
    if (parsed.id === id) return parsed;
  }
  return undefined;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("KimiAcpClient 握手（K1）", () => {
  it("initialize 断言 protocolVersion=1 并回填 agentInfo", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.initialize({ name: "mocl", version: "0.1" });
    const request = transport.lastRequest();
    expect(request.method).toBe("initialize");
    expect(request.params["protocolVersion"]).toBe(1);
    expect(request.params["clientCapabilities"]).toMatchObject({ fs: { readTextFile: true } });
    transport.respond(request.id, kimiInitResult() as unknown as Readonly<Record<string, unknown>>);
    const init = await pending;
    expect(init.protocolVersion).toBe(1);
    expect(init.agentInfo?.version).toBe("2.3.1");
    // 实测能力位透传（sse=true 是 kimi 与 opencode 的差异点）
    expect((init.agentCapabilities as { mcpCapabilities: { sse: boolean } }).mcpCapabilities.sse).toBe(true);
  });

  it("protocolVersion≠1 → protocol.version-mismatch", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.initialize({ name: "mocl", version: "0.1" });
    const request = transport.lastRequest();
    transport.respond(request.id, { protocolVersion: 2, agentInfo: { version: "2.3.1" } });
    await expect(pending).rejects.toMatchObject({ code: "protocol.version-mismatch" });
  });

  it("initialize 缺 protocolVersion → protocol.invalid-params", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.initialize({ name: "mocl", version: "0.1" });
    transport.respond(transport.lastRequest().id, { agentInfo: { version: "2.3.1" } });
    await expect(pending).rejects.toMatchObject({ code: "protocol.invalid-params" });
  });

  it("反向 handler 默认已注册（D-003 启动守卫）", () => {
    const client = makeClient(new FakeTransport());
    expect(client.reverseHandlersRegistered).toBe(true);
    expect(() => client.assertStartable()).not.toThrow();
  });

  it("关掉反向 handler → assertStartable 抛 capability.missing（拒绝启动）", () => {
    const client = makeClient(new FakeTransport(), { disableReverseHandlers: true });
    expect(client.reverseHandlersRegistered).toBe(false);
    expect(() => client.assertStartable()).toThrowError(/fs\/read_text_file/);
    try {
      client.assertStartable();
    } catch (error) {
      expect((error as MoclError).code).toBe("capability.missing");
    }
  });
});

describe("KimiAcpClient 会话方法", () => {
  it("session/new 返回 sessionId 与 configOptions/modes", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.newSession({ cwd: "/tmp/work" });
    const request = transport.lastRequest();
    expect(request.method).toBe("session/new");
    expect(request.params["cwd"]).toBe("/tmp/work");
    expect(request.params["mcpServers"]).toEqual([]);
    transport.respond(request.id, {
      sessionId: "session_abc",
      configOptions: [{ id: "mode", currentValue: "default" }],
      modes: { currentModeId: "default", availableModes: [{ id: "plan" }, { id: "auto" }, { id: "yolo" }] },
    });
    const created = await pending;
    expect(created.sessionId).toBe("session_abc");
    expect(created.modes?.currentModeId).toBe("default");
  });

  it("session/new 缺 sessionId → protocol.invalid-params", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.newSession({ cwd: "/tmp/work" });
    transport.respond(transport.lastRequest().id, {});
    await expect(pending).rejects.toMatchObject({ code: "protocol.invalid-params" });
  });

  it("setMode / setConfigOption / setModel 发出正确的原生方法", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    void client.setMode("s1", "auto").catch(() => undefined);
    expect(transport.lastRequest()).toMatchObject({ method: "session/set_mode", params: { sessionId: "s1", modeId: "auto" } });
    void client.setConfigOption("s1", "mode", "yolo").catch(() => undefined);
    expect(transport.lastRequest()).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "mode", value: "yolo" },
    });
    void client.setModel("s1", "deepseek/deepseek-flash").catch(() => undefined);
    expect(transport.lastRequest()).toMatchObject({ method: "session/set_model", params: { sessionId: "s1", modelId: "deepseek/deepseek-flash" } });
  });

  it("session/load 与 session/list 透传", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const load = client.loadSession({ sessionId: "s1", cwd: "/tmp/work" });
    expect(transport.lastRequest().method).toBe("session/load");
    transport.respond(transport.lastRequest().id, { configOptions: [] });
    await expect(load).resolves.toMatchObject({ configOptions: [] });

    const list = client.listSessions("/tmp/work");
    expect(transport.lastRequest().method).toBe("session/list");
    transport.respond(transport.lastRequest().id, { sessions: [{ sessionId: "s1", cwd: "/tmp/work" }] });
    await expect(list).resolves.toEqual([{ sessionId: "s1", cwd: "/tmp/work" }]);
  });
});

describe("fs/read_text_file 三态（K2/K3/D-003）", () => {
  it("允许根内的文件 → 回 {content}", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const path = join(dir, "a.txt");
      await writeFile(path, "hello-marker", "utf8");
      const transport = new FakeTransport();
      const client = makeClient(transport, { allowedRoots: [dir] });
      transport.serverRequest(11, "fs/read_text_file", { path });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frameOf(transport, 11)).toMatchObject({ result: { content: "hello-marker" } });
    } finally {
      await cleanup();
    }
  });

  it("越界（worktree 外绝对路径）→ -32602 且必须回包（不挂起）", async () => {
    const { dir, cleanup } = await makeTempDir();
    const { dir: other, cleanup: cleanupOther } = await makeTempDir();
    try {
      const outside = join(other, "secret.txt");
      await writeFile(outside, "nope", "utf8");
      const transport = new FakeTransport();
      const client = makeClient(transport, { allowedRoots: [dir] });
      transport.serverRequest(12, "fs/read_text_file", { path: outside });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const frame = frameOf(transport, 12);
      expect(frame?.error?.code).toBe(-32602);
      expect(frame?.error?.message).toContain("outside allowed roots");
    } finally {
      await cleanup();
      await cleanupOther();
    }
  });

  it("路径穿越 ../../etc/passwd → -32602", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const transport = new FakeTransport();
      const client = makeClient(transport, { allowedRoots: [dir] });
      transport.serverRequest(13, "fs/read_text_file", { path: join(dir, "..", "..", "etc", "passwd") });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frameOf(transport, 13)?.error?.code).toBe(-32602);
    } finally {
      await cleanup();
    }
  });

  it("文件不存在 → -32602（FileNotFoundError 分支）", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const transport = new FakeTransport();
      const client = makeClient(transport, { allowedRoots: [dir] });
      transport.serverRequest(14, "fs/read_text_file", { path: join(dir, "missing.txt") });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const frame = frameOf(transport, 14);
      expect(frame?.error?.code).toBe(-32602);
      expect(frame?.error?.message).toContain("not found");
    } finally {
      await cleanup();
    }
  });

  it("目标是目录 → -32602", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      await mkdir(join(dir, "sub"), { recursive: true });
      const transport = new FakeTransport();
      const client = makeClient(transport, { allowedRoots: [dir] });
      transport.serverRequest(15, "fs/read_text_file", { path: join(dir, "sub") });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frameOf(transport, 15)?.error?.code).toBe(-32602);
    } finally {
      await cleanup();
    }
  });

  it("allowedRoots 为空 → fail-closed（一切读都拒）", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const path = join(dir, "a.txt");
      await writeFile(path, "x", "utf8");
      const transport = new FakeTransport();
      const client = makeClient(transport, { allowedRoots: [] });
      transport.serverRequest(16, "fs/read_text_file", { path });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frameOf(transport, 16)?.error?.code).toBe(-32602);
    } finally {
      await cleanup();
    }
  });

  it("fs/write_text_file 默认 deny（-32603）", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const transport = new FakeTransport();
      const client = makeClient(transport, { allowedRoots: [dir] });
      transport.serverRequest(17, "fs/write_text_file", { path: join(dir, "new.txt"), content: "x" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(frameOf(transport, 17)?.error?.code).toBe(-32603);
    } finally {
      await cleanup();
    }
  });

  it("terminal/* fail-closed（-32601，但必须有 handler）", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport, { allowedRoots: ["/tmp"] });
    transport.serverRequest(18, "terminal/create", { command: "ls" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frameOf(transport, 18)?.error?.code).toBe(-32601);
  });

  it("session/request_permission 默认回 reject（不回包会挂死）", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport, { allowedRoots: ["/tmp"] });
    transport.serverRequest(19, "session/request_permission", {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Write" },
      options: [{ optionId: "approve_once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frameOf(transport, 19)).toMatchObject({ result: { outcome: "selected", optionId: "reject" } });
  });

  it("permissionHandler 生效并透传 requestId", async () => {
    const transport = new FakeTransport();
    const seen: unknown[] = [];
    const client = makeClient(transport, {
      allowedRoots: ["/tmp"],
      permissionHandler: async (params) => {
        seen.push(params.requestId);
        return { optionId: "approve_once" };
      },
    });
    transport.serverRequest(20, "session/request_permission", { sessionId: "s1", options: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([20]);
    expect(frameOf(transport, 20)).toMatchObject({ result: { optionId: "approve_once" } });
  });
});

describe("KimiAcpClient 错误分类（§10.2）", () => {
  it("-32601 session/cancel → protocol.unknown-method（无中断能力证据）", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.tryCancel("s1");
    const request = transport.lastRequest();
    expect(request.method).toBe("session/cancel");
    transport.respondError(request.id, -32601, '"Method not found": session/cancel');
    await expect(pending).rejects.toMatchObject({ code: "protocol.unknown-method" });
  });

  it("-32602 Unknown sessionId → session.invalidated", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.prompt("session_x", "hi");
    transport.respondError(transport.lastRequest().id, -32602, "Invalid params: Unknown sessionId: session_x", {
      sessionId: "session_x",
    });
    await expect(pending).rejects.toMatchObject({ code: "session.invalidated" });
  });

  it("-32603 Already in plan mode → session.conflict（hint 点名档位，供幂等判定）", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.setMode("s1", "plan");
    transport.respondError(transport.lastRequest().id, -32603, "Internal error", { details: "Already in plan mode" });
    await expect(pending).rejects.toMatchObject({
      code: "session.conflict",
      details: { hint: "already-in-mode:plan" },
    });
  });

  it("-32601 未知方法 → protocol.unknown-method", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.request("nope/method", {});
    transport.respondError(transport.lastRequest().id, -32601, '"Method not found": nope/method');
    await expect(pending).rejects.toMatchObject({ code: "protocol.unknown-method" });
  });

  it("迟到/未知 id 的响应被忽略、不杀连接", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    transport.respond(999, { anything: true });
    expect(transport.closed).toBe(false);
  });

  it("连续 5 个坏帧 → protocol.bad-frame 并断开", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    for (let index = 0; index < 5; index += 1) transport.sendRaw("not-json{");
    expect(client.badFrameCount).toBe(5);
    expect(transport.closed).toBe(true);
  });
});

describe("KimiAcpClient 帧计数与更新回调", () => {
  it("session/update 通知转给 onUpdate", () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const received: string[] = [];
    client.onUpdate((params) => received.push(params.update.sessionUpdate ?? "?"));
    transport.notify("session/update", { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } });
    expect(received).toEqual(["agent_message_chunk"]);
  });

  it("prompt 期间累计帧数（§11.2 frames.per_turn）", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport, { watchdogMs: 60_000 });
    const pending = client.prompt("s1", "hi");
    transport.notify("session/update", { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } });
    transport.notify("session/update", { sessionId: "s1", update: { sessionUpdate: "usage_update" } });
    transport.respond(transport.lastRequest().id, { stopReason: "end_turn" });
    await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
    expect(client.frameCount).toBeGreaterThanOrEqual(2);
  });

  it("同一会话并发 prompt → session.locked", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const first = client.prompt("s1", "one");
    await expect(client.prompt("s1", "two")).rejects.toMatchObject({ code: "session.locked" });
    transport.respond(transport.lastRequest().id, { stopReason: "end_turn" });
    await first;
  });
});

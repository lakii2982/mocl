import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcpClient } from "../../../src/adapters/opencode/acp-client.ts";
import { FakeTransport, makeTempDir } from "./helpers.ts";

function makeClient(
  transport: FakeTransport,
  overrides: Partial<ConstructorParameters<typeof AcpClient>[0]> = {},
): AcpClient {
  return new AcpClient({ transport, ...overrides });
}

function parseWritten(transport: FakeTransport, id: number): { result?: unknown; error?: { code: number } } | undefined {
  for (const line of transport.written) {
    const parsed = JSON.parse(line) as { id?: number; result?: unknown; error?: { code: number } };
    if (parsed.id === id) return parsed;
  }
  return undefined;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitUntil timeout");
}

describe("opencode ACP 兜底客户端（§2.3/§5.3）", () => {
  it("initialize 发送 protocolVersion=1，断言后端版本", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.initialize({ name: "mocl", version: "0.1" });
    const request = transport.lastRequest();
    expect(request.method).toBe("initialize");
    expect(request.params).toMatchObject({ protocolVersion: 1 });
    transport.respond(request.id, { protocolVersion: 1, agentInfo: { name: "OpenCode", version: "2.1.4" } });
    await expect(pending).resolves.toMatchObject({ protocolVersion: 1 });
  });

  it("initialize protocolVersion 非 1 → protocol.version-mismatch", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.initialize({ name: "mocl", version: "0.1" });
    transport.respond(transport.lastRequest().id, { protocolVersion: 2 });
    await expect(pending).rejects.toMatchObject({ code: "protocol.version-mismatch" });
  });

  it("session/new 返回 sessionId；缺 sessionId → protocol.invalid-params", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const ok = client.newSession({ cwd: "/tmp/work" });
    transport.respond(transport.lastRequest().id, {
      sessionId: "ses_acp_1",
      configOptions: [{ id: "model", currentValue: "opencode-go/iceman-contributor-free" }],
    });
    await expect(ok).resolves.toMatchObject({ sessionId: "ses_acp_1" });

    const bad = client.newSession({ cwd: "/tmp/work" });
    transport.respond(transport.lastRequest().id, {});
    await expect(bad).rejects.toMatchObject({ code: "protocol.invalid-params" });
  });

  it("session/prompt 无响应 → transport.timeout（无内置超时的兜底）", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport, { timeoutMs: 30 });
    await expect(client.prompt("ses_acp_1", "只回复 OK")).rejects.toMatchObject({ code: "transport.timeout" });
  });

  it("session/prompt 成功返回 stopReason + usage", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.prompt("ses_acp_1", "只回复 OK");
    transport.respond(transport.lastRequest().id, {
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    await expect(pending).resolves.toMatchObject({ stopReason: "end_turn", usage: { inputTokens: 10 } });
  });

  it("set_config_option 切换模型（ACP 无 set_model 的替代路径）", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.setConfigOption("ses_acp_1", "model", "opencode/deepseek-v4.1-flash-free");
    const request = transport.lastRequest();
    expect(request.method).toBe("session/set_config_option");
    expect(request.params).toMatchObject({ sessionId: "ses_acp_1", configId: "model" });
    transport.respond(request.id, { configOptions: [{ id: "model", currentValue: "opencode/deepseek-v4.1-flash-free" }] });
    await expect(pending).resolves.toMatchObject({ configOptions: [{ id: "model" }] });
  });

  it("fs/read_text_file 成功应答（必须实现的 handler）", async () => {
    const temp = await makeTempDir();
    try {
      const file = join(temp.dir, "a.txt");
      await writeFile(file, "hello-marker", "utf8");
      const transport = new FakeTransport();
      makeClient(transport, { allowedRoots: [temp.dir] });
      transport.serverRequest(900, "fs/read_text_file", { path: file });
      await waitUntil(() => parseWritten(transport, 900) !== undefined);
      expect(parseWritten(transport, 900)?.result).toEqual({ content: "hello-marker" });
    } finally {
      await temp.cleanup();
    }
  });

  it("fs/read_text_file 越界 → -32602（路径穿越防线，且不挂起）", async () => {
    const temp = await makeTempDir();
    try {
      const transport = new FakeTransport();
      makeClient(transport, { allowedRoots: [temp.dir] });
      transport.serverRequest(901, "fs/read_text_file", { path: "/etc/hosts" });
      await waitUntil(() => parseWritten(transport, 901) !== undefined);
      expect(parseWritten(transport, 901)?.error?.code).toBe(-32602);
    } finally {
      await temp.cleanup();
    }
  });

  it("fs/write_text_file 默认拒绝 → -32603", async () => {
    const temp = await makeTempDir();
    try {
      const transport = new FakeTransport();
      makeClient(transport, { allowedRoots: [temp.dir] });
      transport.serverRequest(902, "fs/write_text_file", { path: join(temp.dir, "x.txt"), content: "x" });
      await waitUntil(() => parseWritten(transport, 902) !== undefined);
      expect(parseWritten(transport, 902)?.error?.code).toBe(-32603);
    } finally {
      await temp.cleanup();
    }
  });

  it("session/request_permission 默认 reject（无人值守 fail-closed）", async () => {
    const transport = new FakeTransport();
    makeClient(transport);
    transport.serverRequest(903, "session/request_permission", { sessionId: "ses_acp_1" });
    await waitUntil(() => parseWritten(transport, 903) !== undefined);
    expect(parseWritten(transport, 903)?.result).toMatchObject({ outcome: "selected", optionId: "reject" });
  });

  it("未知反向方法 → -32601；session/update 通知交给 onUpdate", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const updates: string[] = [];
    client.onUpdate((params) => updates.push(String(params.update["sessionUpdate"])));
    transport.notify("session/update", {
      sessionId: "ses_acp_1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
    });
    expect(updates).toEqual(["agent_message_chunk"]);

    transport.serverRequest(904, "terminal/create", {});
    await waitUntil(() => parseWritten(transport, 904) !== undefined);
    expect(parseWritten(transport, 904)?.error?.code).toBe(-32601);
  });

  it("terminate：关闭 transport 并拒绝悬挂请求", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport, { timeoutMs: 5_000 });
    const pending = client.prompt("ses_acp_1", "never answered");
    await client.terminate();
    await expect(pending).rejects.toMatchObject({ code: "process.killed" });
    expect(transport.closed).toBe(true);
  });

  it("JSON-RPC -32000 → auth.missing-credential；-32601/-32602/-32603 映射", async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const cases: readonly [number, string][] = [
      [-32000, "auth.missing-credential"],
      [-32601, "protocol.unknown-method"],
      [-32602, "protocol.invalid-params"],
      [-32603, "internal.unexpected"],
    ];
    for (const [code, expected] of cases) {
      const pending = client.listSessions("/tmp");
      transport.respondError(transport.lastRequest().id, code, "boom");
      await expect(pending).rejects.toMatchObject({ code: expected });
    }
  });
});

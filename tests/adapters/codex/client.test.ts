import { describe, expect, it } from "vitest";
import { CodexClient, toUserInput, versionOfUserAgent } from "../../../src/adapters/codex/client.ts";
import { CodexTransport } from "../../../src/adapters/codex/transport.ts";
import { FakeChild } from "./helpers.ts";

function makeClient(options: ConstructorParameters<typeof CodexClient>[1] = {}): {
  client: CodexClient;
  child: FakeChild;
  transport: CodexTransport;
} {
  const child = new FakeChild();
  const transport = new CodexTransport({
    requestTimeoutMs: 500,
    spawn: () => ({ child, killTree: () => undefined }),
  });
  const client = new CodexClient(transport, options);
  return { client, child, transport };
}

const OK_USER_AGENT = "mocl-codex/0.164.0 (Mac OS 27.0.1; arm64) dumb (mocl-codex; 0.1)";

describe("codex client：握手/版本/方法封装", () => {
  it("initialize 解析 userAgent 里的基线版本", async () => {
    const { client, child } = makeClient();
    const pending = client.initialize({ name: "mocl-codex", version: "0.1" });
    child.emitFrame({ jsonrpc: "2.0", id: 1, result: { userAgent: OK_USER_AGENT } });
    await expect(pending).resolves.toMatchObject({ userAgent: OK_USER_AGENT });
    expect(client.initialized).toBe(true);
    expect(client.detectedVersion).toBe("0.164.0");
    // 幂等：第二次 initialize 不再发请求
    await client.initialize({ name: "mocl-codex", version: "0.1" });
    expect(child.written.filter((w) => w.includes('"method":"initialize"'))).toHaveLength(1);
  });

  it("版本不符 → protocol.version-mismatch（fail fast）", async () => {
    const { client, child } = makeClient();
    const pending = client.initialize({ name: "mocl-codex", version: "0.1" });
    const assertion = expect(pending).rejects.toMatchObject({ code: "protocol.version-mismatch" });
    child.emitFrame({ jsonrpc: "2.0", id: 1, result: { userAgent: "mocl-codex/0.153.4 (Mac OS; arm64)" } });
    await assertion;
    expect(client.initialized).toBe(false);
  });

  it("expectedVersion=null 可关闭版本断言（迁移/测试用）", async () => {
    const { client, child } = makeClient({ expectedVersion: null });
    const pending = client.initialize({ name: "mocl-codex", version: "0.1" });
    child.emitFrame({ jsonrpc: "2.0", id: 1, result: { userAgent: "mocl-codex/9.9.9 (X; arm64)" } });
    await expect(pending).resolves.toBeDefined();
    expect(client.detectedVersion).toBe("9.9.9");
  });

  it("threadStart 强制 ephemeral:false（持久线程是续接前提）", async () => {
    const { client } = makeClient();
    await expect(
      client.threadStart({ cwd: "/tmp/work", ephemeral: true }),
    ).rejects.toMatchObject({ code: "internal.unexpected" });
  });

  it("threadStart 返回 thread.id 与 model", async () => {
    const { client, child } = makeClient();
    const pending = client.threadStart({ cwd: "/tmp/work", ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
    const written = child.written.join("");
    expect(written).toContain('"ephemeral":false');
    expect(written).toContain('"approvalPolicy":"never"');
    expect(written).toContain('"sandbox":"read-only"');
    child.emitFrame({
      jsonrpc: "2.0",
      id: 1,
      result: { thread: { id: "t1", ephemeral: false, cliVersion: "0.164.0" }, model: "gpt-6-astra" },
    });
    await expect(pending).resolves.toMatchObject({ thread: { id: "t1" }, model: "gpt-6-astra" });
  });

  it("thread/start 响应缺 thread.id → protocol.unexpected-response", async () => {
    const { client, child } = makeClient();
    const pending = client.threadStart({ cwd: "/tmp/work", ephemeral: false });
    const assertion = expect(pending).rejects.toMatchObject({ code: "protocol.unexpected-response" });
    child.emitFrame({ jsonrpc: "2.0", id: 1, result: { thread: {} } });
    await assertion;
  });

  it("turnInterrupt 把 `no active turn` 视为幂等成功（不是错误）", async () => {
    const { client, child } = makeClient();
    const pending = client.turnInterrupt({ threadId: "t1", turnId: "r1" });
    child.emitFrame({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "no active turn to interrupt" },
    });
    await expect(pending).resolves.toBe("already-finished");
  });

  it("threadResume 的 no rollout found → session.resume-failed（上层降级）", async () => {
    const { client, child } = makeClient();
    const pending = client.threadResume({ threadId: "t1" });
    const assertion = expect(pending).rejects.toMatchObject({ code: "session.resume-failed" });
    child.emitFrame({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "no rollout found for thread id t1" },
    });
    await assertion;
  });

  it("config/read 透出 agents 运行时上限（D-016 的输入）", async () => {
    const { client, child } = makeClient();
    const pending = client.readConfig();
    child.emitFrame({
      jsonrpc: "2.0",
      id: 1,
      result: { config: { agents: { max_concurrent_threads_per_session: 3, max_depth: 2 } } },
    });
    await expect(pending).resolves.toMatchObject({
      config: { agents: { max_concurrent_threads_per_session: 3, max_depth: 2 } },
    });
  });

  it("toUserInput：text/localImage/file 的映射与非法 image", () => {
    expect(toUserInput([{ type: "text", text: "hi" }])).toEqual([{ type: "text", text: "hi" }]);
    expect(toUserInput([{ type: "image", text: "", path: "/tmp/a.png" }])).toEqual([
      { type: "localImage", path: "/tmp/a.png" },
    ]);
    expect(toUserInput([{ type: "file", text: "", path: "/tmp/a.txt" }])).toEqual([
      { type: "text", text: "[file] /tmp/a.txt" },
    ]);
    expect(() => toUserInput([{ type: "image", text: "" }])).toThrowError(/image input requires a path/);
  });

  it("versionOfUserAgent 兼容多种 userAgent 形态", () => {
    expect(versionOfUserAgent("mocl/0.164.0 (Mac OS 27.0.1; arm64)")).toBe("0.164.0");
    expect(versionOfUserAgent("agent 0.164.0-alpha.1")).toBe("0.164.0-alpha.1");
    expect(versionOfUserAgent("no-version-here")).toBeUndefined();
  });
});

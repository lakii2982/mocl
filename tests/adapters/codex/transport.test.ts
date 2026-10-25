import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexTransport, type SpawnedChild } from "../../../src/adapters/codex/transport.ts";
import type { AdapterError } from "../../../src/adapters/codex/errors.ts";
import { FakeChild } from "./helpers.ts";

function makeTransport(
  overrides: Partial<ConstructorParameters<typeof CodexTransport>[0]> = {},
  child: FakeChild = new FakeChild(),
): { transport: CodexTransport; child: FakeChild; faults: AdapterError[]; exits: unknown[] } {
  const faults: AdapterError[] = [];
  const exits: unknown[] = [];
  const transport = new CodexTransport({
    args: ["app-server", "--listen", "stdio://"],
    requestTimeoutMs: 1_000,
    killGraceMs: 50,
    spawn: (): SpawnedChild => ({ child, killTree: (signal) => child.kills.push(signal) }),
    onFault: (error) => faults.push(error),
    onExit: (code, signal) => exits.push({ code, signal }),
    ...overrides,
  });
  return { transport, child, faults, exits };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("codex transport：JSONL 分帧与 JSON-RPC 关联", () => {
  it("start() 用基线 argv 启动，并默认支持 MOCL_CODEX_BIN 覆盖", () => {
    const child = new FakeChild();
    const seen: { command: string; args: readonly string[] }[] = [];
    const transport = new CodexTransport({
      spawn: (command, args): SpawnedChild => {
        seen.push({ command, args });
        return { child, killTree: () => undefined };
      },
    });
    const previous = process.env["MOCL_CODEX_BIN"];
    process.env["MOCL_CODEX_BIN"] = "/opt/codex-0.164.0/bin/codex";
    try {
      transport.start();
      transport.start(); // 幂等
    } finally {
      if (previous === undefined) delete process.env["MOCL_CODEX_BIN"];
      else process.env["MOCL_CODEX_BIN"] = previous;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe("/opt/codex-0.164.0/bin/codex");
    expect(seen[0]?.args).toEqual(["app-server", "--listen", "stdio://"]);
  });

  it("请求/响应按 id 关联（允许乱序响应）", async () => {
    const { transport, child } = makeTransport();
    transport.start();
    const first = transport.request<string>("initialize", { clientInfo: { name: "t", version: "0" } });
    const second = transport.request<string>("config/read", {});
    expect(child.written.join("")).toContain('"method":"initialize"');
    child.emitFrame({ jsonrpc: "2.0", id: 2, result: { config: {} } });
    child.emitFrame({ jsonrpc: "2.0", id: 1, result: { userAgent: "x/0.164.0" } });
    await expect(first).resolves.toEqual({ userAgent: "x/0.164.0" });
    await expect(second).resolves.toEqual({ config: {} });
    expect(transport.pendingCount).toBe(0);
  });

  it("一帧跨 chunk / 一 chunk 多帧都能解析", async () => {
    const { transport, child } = makeTransport();
    transport.start();
    const pending = transport.request<number>("thread/loaded/list", {});
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { data: ["t1"] } });
    child.emitChunk(frame.slice(0, 12));
    child.emitChunk(`${frame.slice(12)}\n`);
    child.emitChunk(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} })}\n`);
    await expect(pending).resolves.toEqual({ data: ["t1"] });
    expect(transport.unexpectedResponseCount).toBe(1); // id=9 无等待者
  });

  it("单请求超时 → transport.timeout（且清空 pending）", async () => {
    vi.useFakeTimers();
    const { transport } = makeTransport({ requestTimeoutMs: 100 });
    transport.start();
    const pending = transport.request("turn/start", {});
    const assertion = expect(pending).rejects.toMatchObject({ code: "transport.timeout" });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    expect(transport.pendingCount).toBe(0);
  });

  it("坏帧被隔离：记 frame-invalid，但不杀死连接，后续合法帧照常解析", async () => {
    const { transport, child, faults } = makeTransport();
    transport.start();
    const pending = transport.request<string>("thread/read", {});
    child.emitLine("{not json");
    child.emitFrame({ jsonrpc: "2.0", id: 1, result: { thread: { id: "t1" } } });
    await expect(pending).resolves.toEqual({ thread: { id: "t1" } });
    expect(transport.badFrameCount).toBe(1);
    expect(faults.map((f) => f.code)).toContain("transport.frame-invalid");
  });

  it("连续 5 个坏帧升级为 protocol.bad-frame 并停止连接（SIGTERM 进程组）", async () => {
    const { transport, child, faults } = makeTransport();
    transport.start();
    for (let i = 0; i < 5; i += 1) child.emitLine("<html>not json</html>");
    await flush();
    expect(faults.map((f) => f.code)).toContain("protocol.bad-frame");
    expect(child.kills).toContain("SIGTERM");
  });

  it("未知 id 的响应 → protocol.unexpected-response（只计数与告警，不改变连接）", async () => {
    const { transport, child, faults } = makeTransport();
    transport.start();
    child.emitFrame({ jsonrpc: "2.0", id: 777, result: {} });
    expect(transport.unexpectedResponseCount).toBe(1);
    expect(faults.map((f) => f.code)).toContain("protocol.unexpected-response");
  });

  it("stderr 环形缓冲按字节上限截断（排障不 OOM）", () => {
    const { transport, child } = makeTransport({ maxStderrBytes: 20 });
    transport.start();
    child.emitStderr("a".repeat(15));
    child.emitStderr("b".repeat(15));
    const tail = transport.stderrTail();
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(20);
    expect(tail.endsWith("b".repeat(15))).toBe(true);
  });

  it("子进程退出会拒绝所有未完成请求（process.crashed），并回调 onExit", async () => {
    const { transport, child, exits, faults } = makeTransport();
    transport.start();
    const pending = transport.request("turn/start", {});
    const assertion = expect(pending).rejects.toMatchObject({ code: "process.crashed" });
    child.exit(2, null);
    await assertion;
    expect(exits).toEqual([{ code: 2, signal: null }]);
    expect(faults.map((f) => f.code)).toContain("process.crashed");
    expect(transport.closed).toBe(true);
  });

  it("spawn 抛错 → process.spawn-failed（不进半可用状态）", () => {
    const faults: AdapterError[] = [];
    const transport = new CodexTransport({
      spawn: () => {
        throw new Error("spawn ENOENT");
      },
      onFault: (error) => faults.push(error),
    });
    expect(() => transport.start()).toThrowError(/spawn ENOENT/);
    expect(faults.map((f) => f.code)).toContain("process.spawn-failed");
    expect(transport.closed).toBe(true);
  });

  it("通知与反向请求分流到各自 handler", () => {
    const notifications: string[] = [];
    const requests: string[] = [];
    const { transport, child } = makeTransport({
      onNotification: (frame) => notifications.push(String(frame.method)),
      onServerRequest: (frame) => requests.push(String(frame.method)),
    });
    transport.start();
    child.emitFrame({ jsonrpc: "2.0", method: "turn/started", params: {} });
    child.emitFrame({ jsonrpc: "2.0", id: 51, method: "item/commandExecution/requestApproval", params: {} });
    expect(notifications).toEqual(["turn/started"]);
    expect(requests).toEqual(["item/commandExecution/requestApproval"]);
  });

  it("stop() 走 SIGTERM → 宽限 → SIGKILL，并结束待处理请求", async () => {
    vi.useFakeTimers();
    const { transport, child } = makeTransport({ killGraceMs: 100 });
    transport.start();
    const pending = transport.request("turn/start", {});
    const assertion = expect(pending).rejects.toMatchObject({ code: "process.killed" });
    const stopping = transport.stop();
    await vi.advanceTimersByTimeAsync(150);
    await stopping;
    await assertion;
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.ended).toBe(true);
  });

  it("子进程在 stop() 前已退出时，stop() 立即完成", async () => {
    const { transport, child } = makeTransport();
    transport.start();
    child.exit(0, null);
    await expect(transport.stop()).resolves.toBeUndefined();
  });

  it("ping() 用轻量只读方法（thread/loaded/list）作健康探针", async () => {
    const { transport, child } = makeTransport();
    transport.start();
    const ping = transport.ping();
    child.emitFrame({ jsonrpc: "2.0", id: 1, result: { data: [] } });
    await expect(ping).resolves.toBeUndefined();
    expect(child.written.join("")).toContain("thread/loaded/list");
  });
});

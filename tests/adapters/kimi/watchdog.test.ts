import { afterEach, describe, expect, it, vi } from "vitest";
import { KimiAcpClient } from "../../../src/adapters/kimi/acp-client.ts";
import { FakeTransport } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("静默挂死看门狗（D-003 / K2）", () => {
  it("60s 内无任何帧 → transport.timeout 且触发 onHung('idle')", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const onHung = vi.fn();
    const client = new KimiAcpClient({ transport, watchdogMs: 60_000, onHung });
    const pending = client.prompt("s1", "hi");
    const settled = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(59_999);
    // 差 1ms：尚未触发
    expect(onHung).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;
    expect(error).toMatchObject({ code: "transport.timeout" });
    expect(onHung).toHaveBeenCalledWith("idle");
  });

  it("任何入站帧都会刷新看门狗（有帧 = 没挂死）", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const onHung = vi.fn();
    const client = new KimiAcpClient({ transport, watchdogMs: 60_000, onHung });
    const pending = client.prompt("s1", "hi");
    const settled = pending.then((value) => value);

    // 每 30s 来一条 thought 帧，累计跨越 3 个看门狗窗口仍不超时
    for (let index = 0; index < 6; index += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      transport.notify("session/update", { sessionId: "s1", update: { sessionUpdate: "agent_thought_chunk" } });
    }
    expect(onHung).not.toHaveBeenCalled();
    transport.respond(transport.lastRequest().id, { stopReason: "end_turn" });
    await expect(settled).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("【负向】不注册 fs handler 时 prompt 必然挂死 → 由看门狗兜底（不实现即事故）", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const onHung = vi.fn();
    const client = new KimiAcpClient({ transport, watchdogMs: 60_000, onHung, disableReverseHandlers: true });
    // 绕过 assertStartable 直接发 prompt：模拟"历史实现"（没注册 handler 也没守卫）
    // 用远大于看门狗的请求超时，确保先触发**看门狗**（真实路径 maxTurnMs=1.8e6 > watchdog=60s）
    const pending = client.request(
      "session/prompt",
      { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] },
      { timeoutMs: 120_000 },
    );
    const settled = pending.catch((error: unknown) => error);
    // 服务端来要 fs/read_text_file：无 handler → 不回包 → 后端永久等待
    transport.serverRequest(7, "fs/read_text_file", { path: "/tmp/x" });
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await settled;
    expect(error).toMatchObject({ code: "transport.timeout" });
    expect(onHung).toHaveBeenCalledWith("idle");
  });

  it("并行的 prompt 不会被前一轮的残留计时器打断", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = new KimiAcpClient({ transport, watchdogMs: 1_000 });
    const first = client.prompt("s1", "one");
    transport.respond(transport.lastRequest().id, { stopReason: "end_turn" });
    await first;
    await vi.advanceTimersByTimeAsync(5_000); // 第一轮之后不应再有看门狗
    const second = client.prompt("s1", "two");
    transport.respond(transport.lastRequest().id, { stopReason: "end_turn" });
    await expect(second).resolves.toEqual({ stopReason: "end_turn" });
  });
});

describe("单轮硬超时（§9.3）", () => {
  it("maxTurnMs 到点 → limit.turn-timeout（不是 transport.timeout）", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = new KimiAcpClient({ transport, watchdogMs: 60_000, maxTurnMs: 1_000 });
    const pending = client.prompt("s1", "hi");
    const settled = pending.catch((error: unknown) => error);
    // 持续有帧（看门狗被刷新），但总时长超过 maxTurnMs
    for (let index = 0; index < 12; index += 1) {
      await vi.advanceTimersByTimeAsync(200);
      if (index < 11) transport.notify("session/update", { sessionId: "s1", update: { sessionUpdate: "agent_thought_chunk" } });
    }
    const error = await settled;
    expect(error).toMatchObject({ code: "limit.turn-timeout" });
  });

  it("terminate 后 pending 请求收到 transport.disconnected", async () => {
    const transport = new FakeTransport();
    const client = new KimiAcpClient({ transport });
    const pending = client.request("session/list", { cwd: "/tmp" });
    const settled = pending.catch((error: unknown) => error);
    await client.terminate();
    expect(await settled).toMatchObject({ code: "process.killed" });
    expect(transport.closed).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import { KimiAdapter } from "../../../src/adapters/kimi/index.ts";
import { MoclError } from "../../../src/broker/errors.ts";
import { drainUntil, fakeProcessFactory, fixedRuntime, configProbe } from "./helpers.ts";

async function openTwo(): Promise<{
  readonly adapter: KimiAdapter;
  readonly processes: ReturnType<typeof fakeProcessFactory>;
  readonly a: string;
  readonly b: string;
}> {
  const processes = fakeProcessFactory(7000);
  const adapter = new KimiAdapter({
    transport: "acp",
    runtime: fixedRuntime(4),
    processFactory: processes.factory,
    configProbe: configProbe("auto"),
  });
  const openedA = await adapter.open({ sessionId: "sA", cwd: "/tmp/work", epoch: 0 });
  const openedB = await adapter.open({ sessionId: "sB", cwd: "/tmp/work", epoch: 0 });
  return { adapter, processes, a: openedA.remoteSessionId, b: openedB.remoteSessionId };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("进程级中断（D-008 / K6）", () => {
  it("中断进行中的轮 → killpg(SIGTERM) + turn.aborted{process-kill,partial:true} + session.lost", async () => {
    const processes = fakeProcessFactory(8000);
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: processes.factory,
      configProbe: configProbe("auto"),
    });
    const opened = await adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 });
    const acp = processes.created[0]?.acp;
    acp?.holdPrompt();

    const inFlight = adapter.send({
      sessionId: "s1",
      remoteSessionId: opened.remoteSessionId,
      input: [{ type: "text", text: "long task" }],
      idempotencyKey: "k1",
    });
    inFlight.catch(() => undefined);
    // 等 prompt 真正发出
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acp?.promptCount).toBe(1);

    await adapter.interrupt({ sessionId: "s1", remoteSessionId: opened.remoteSessionId });

    // SIGTERM 立即发出（SIGKILL 是 5s 兜底）
    expect(processes.created[0]?.killSignals).toContain("SIGTERM");
    expect(adapter.isSessionLost("s1")).toBe(true);

    const events = await drainUntil(adapter.events(), (accumulated) =>
      accumulated.some((event) => event.type === "session.lost"),
    );
    const types = events.map((event) => event.type);
    expect(types).toContain("turn.aborted");
    expect(types).toContain("session.lost");
    const aborted = events.find((event) => event.type === "turn.aborted") as AdapterEvent;
    expect(aborted.payload).toMatchObject({ interruptMethod: "process-kill", partial: true });

    acp?.releasePrompt();
    await inFlight;
    await adapter.dispose();
  });

  it("**不重放**：中断后 prompt 计数不增加（无幂等对账 → 禁止重发）", async () => {
    const processes = fakeProcessFactory(8100);
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: processes.factory,
      configProbe: configProbe("auto"),
    });
    const opened = await adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 });
    const acp = processes.created[0]?.acp;
    acp?.holdPrompt();
    const inFlight = adapter.send({
      sessionId: "s1",
      remoteSessionId: opened.remoteSessionId,
      input: [{ type: "text", text: "long task" }],
      idempotencyKey: "k1",
    });
    inFlight.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await adapter.interrupt({ sessionId: "s1", remoteSessionId: opened.remoteSessionId });
    expect(acp?.promptCount).toBe(1); // 未重发
    acp?.releasePrompt();
    await inFlight;
    await adapter.dispose();
  });

  it("SIGTERM 后 5s 未退 → SIGKILL（分级回收）", async () => {
    vi.useFakeTimers();
    const processes = fakeProcessFactory(8200);
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: processes.factory,
      configProbe: configProbe("auto"),
    });
    const opened = await adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 });
    await adapter.interrupt({ sessionId: "s1", remoteSessionId: opened.remoteSessionId });
    expect(processes.created[0]?.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(processes.created[0]?.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(processes.created[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await adapter.dispose();
  });

  it("中断后 send → session.invalidated（必须先 resume）", async () => {
    const processes = fakeProcessFactory(8300);
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: processes.factory,
      configProbe: configProbe("auto"),
    });
    const opened = await adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 });
    await adapter.interrupt({ sessionId: "s1", remoteSessionId: opened.remoteSessionId });
    await expect(
      adapter.send({
        sessionId: "s1",
        remoteSessionId: opened.remoteSessionId,
        input: [{ type: "text", text: "again" }],
        idempotencyKey: "k2",
      }),
    ).rejects.toMatchObject({ code: "session.invalidated" });
    await adapter.dispose();
  });

  it("无进行中轮时中断 → 只发 session.lost（不伪造 turn.aborted）", async () => {
    const processes = fakeProcessFactory(8400);
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: processes.factory,
      configProbe: configProbe("auto"),
    });
    const opened = await adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 });
    // 先跑完一轮（终态已发）
    await adapter.send({
      sessionId: "s1",
      remoteSessionId: opened.remoteSessionId,
      input: [{ type: "text", text: "done" }],
      idempotencyKey: "k1",
    });
    await drainUntil(adapter.events(), (events) => events.some((event) => event.type === "turn.completed"));
    await adapter.interrupt({ sessionId: "s1", remoteSessionId: opened.remoteSessionId });
    const events = await drainUntil(adapter.events(), (accumulated) =>
      accumulated.some((event) => event.type === "session.lost"),
    );
    expect(events.map((event) => event.type)).toEqual(["session.lost"]);
    await adapter.dispose();
  });

  it("中断后 resume → 新进程 + session/load + session.recovered（冷恢复）", async () => {
    const processes = fakeProcessFactory(8500);
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: processes.factory,
      configProbe: configProbe("auto"),
    });
    const opened = await adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 });
    await adapter.interrupt({ sessionId: "s1", remoteSessionId: opened.remoteSessionId });
    await drainUntil(adapter.events(), (events) => events.some((event) => event.type === "session.lost"));

    const resumed = await adapter.resume({ sessionId: "s1", remoteSessionId: opened.remoteSessionId, fromSeq: 0 });
    expect(resumed.exists).toBe(true);
    // 新进程（第二个句柄），旧进程已 kill
    expect(processes.created).toHaveLength(2);
    expect(processes.created[1]?.acp.methods()).toEqual(["initialize", "session/load"]);
    expect(processes.created[1]?.acp.loadCount).toBe(1);
    expect(adapter.isSessionLost("s1")).toBe(false);
    const events = await drainUntil(adapter.events(), (accumulated) =>
      accumulated.some((event) => event.type === "session.state-changed"),
    );
    expect(events.map((event) => event.type)).toEqual(["session.recovered", "session.state-changed"]);
    await adapter.dispose();
  });

  it("resume 时后端已无该会话 → exists:false", async () => {
    const processes = fakeProcessFactory(8600);
    let created = 0;
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: (spec) => {
        const handle = processes.factory(spec);
        created += 1;
        // 第二个进程（冷恢复用的新进程）上让 session/load 报 Unknown sessionId
        if (created === 2) {
          // 用 JSON-RPC 形状的裸错误，验证 toKimiError 会把 -32602 归为 session.invalidated
          handle.acp.loadError = Object.assign(new Error("Invalid params: Unknown sessionId: x"), {
            code: -32602,
          }) as unknown as MoclError;
        }
        return handle;
      },
      configProbe: configProbe("auto"),
    });
    const opened = await adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 });
    await adapter.interrupt({ sessionId: "s1", remoteSessionId: opened.remoteSessionId });
    const resumed = await adapter.resume({ sessionId: "s1", remoteSessionId: opened.remoteSessionId, fromSeq: 0 });
    expect(resumed).toMatchObject({ exists: false, reason: "session.invalidated" });
    await adapter.dispose();
  });
});

describe("一任务一进程（K9 / §2.1）", () => {
  it("两次 open 产生两个不同 pgid；杀 A 不影响 B", async () => {
    const { adapter, processes, a, b } = await openTwo();
    expect(processes.created).toHaveLength(2);
    expect(adapter.pgidOf("sA")).not.toBe(adapter.pgidOf("sB"));
    expect(adapter.pgidOf("sA")).toBe(7000);
    expect(adapter.pgidOf("sB")).toBe(7001);

    await adapter.interrupt({ sessionId: "sA", remoteSessionId: a });
    expect(processes.created[0]?.killSignals).toContain("SIGTERM");
    expect(processes.created[1]?.killSignals).toEqual([]); // B 未受牵连

    // B 仍可继续跑一轮
    await adapter.send({ sessionId: "sB", remoteSessionId: b, input: [{ type: "text", text: "hi" }], idempotencyKey: "k" });
    expect(processes.created[1]?.acp.promptCount).toBe(1);
    await adapter.dispose();
  });

  it("dispose 杀光所有进程组", async () => {
    const { adapter, processes } = await openTwo();
    await adapter.dispose();
    expect(processes.created[0]?.killSignals).toContain("SIGTERM");
    expect(processes.created[1]?.killSignals).toContain("SIGTERM");
  });
});

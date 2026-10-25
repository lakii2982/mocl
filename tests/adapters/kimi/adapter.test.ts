import { afterEach, describe, expect, it } from "vitest";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import {
  DEFAULT_WATCHDOG_MS,
  KimiAdapter,
  assertAbsoluteCwd,
  assertHandshake,
  modelOfConfigOptions,
  type KimiAdapterOptions,
} from "../../../src/adapters/kimi/index.ts";
import { MoclError } from "../../../src/broker/errors.ts";
import { RuntimeConfigError } from "../../../src/broker/concurrency.ts";
import {
  FakeTransport,
  ScriptedPromptRunner,
  configProbe,
  drainUntil,
  failingRuntime,
  fakeProcessFactory,
  fixedRuntime,
  invalidRuntime,
  makeTempDir,
  unreadableConfigProbe,
} from "./helpers.ts";

interface Harness {
  readonly adapter: KimiAdapter;
  readonly processes: ReturnType<typeof fakeProcessFactory>;
  readonly openResult: Awaited<ReturnType<KimiAdapter["open"]>>;
}

async function openAdapter(
  overrides: Partial<KimiAdapterOptions> = {},
): Promise<Harness & { readonly events: readonly AdapterEvent[] }> {
  const processes = fakeProcessFactory();
  const adapter = new KimiAdapter({
    transport: "acp",
    runtime: fixedRuntime(4),
    processFactory: processes.factory,
    configProbe: configProbe("auto"),
    allowedRoots: ["/tmp/work"],
    ...overrides,
  });
  const openResult = await adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 });
  const events = await drainUntil(adapter.events(), (accumulated) =>
    accumulated.some((event) => event.type === "session.state-changed"),
  );
  return { adapter, processes, openResult, events };
}

afterEach(() => {
  // 清理可能残留的 SIGKILL 计时器（unref 已处理，这里仅保持测试隔离）。
});

describe("KimiAdapter 握手与启动守卫（K1/D-003）", () => {
  it("open() 走 ACP：initialize + session/new + 显式 set_mode，发 session.created", async () => {
    const { adapter, processes, openResult, events } = await openAdapter();
    expect(openResult.remoteSessionId).toMatch(/^session_fake_/);
    const acp = processes.created[0]?.acp;
    expect(acp?.methods()).toEqual(["initialize", "session/new", "session/set_mode"]);
    expect(acp?.modeCalls).toEqual(["plan"]); // 默认 read-only → ACP plan（严格档）
    expect(events.map((event) => event.type)).toEqual(["session.created", "session.state-changed"]);
    await adapter.dispose();
  });

  it("safe-auto → set_mode('auto')；yolo → set_mode('yolo')（语义映射，非名字）", async () => {
    const safeAuto = fakeProcessFactory();
    const adapterA = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: safeAuto.factory,
      configProbe: configProbe("auto"),
    });
    await adapterA.open({ sessionId: "a", cwd: "/tmp/work", permissionProfile: "safe-auto", epoch: 0 });
    expect(safeAuto.created[0]?.acp.modeCalls).toEqual(["auto"]);
    await adapterA.dispose();

    const yolo = fakeProcessFactory();
    const adapterB = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: yolo.factory,
      configProbe: configProbe("yolo"),
    });
    await adapterB.open({ sessionId: "b", cwd: "/tmp/work", permissionProfile: "yolo", epoch: 0 });
    expect(yolo.created[0]?.acp.modeCalls).toEqual(["yolo"]);
    await adapterB.dispose();
  });

  it("反向 handler 未注册 → 拒绝启动（capability.missing），并杀掉进程", async () => {
    const processes = fakeProcessFactory();
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: (spec) => {
        const handle = processes.factory(spec);
        handle.acp.reverseHandlersRegistered = false;
        return handle;
      },
      configProbe: configProbe("auto"),
    });
    await expect(adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 })).rejects.toMatchObject({
      code: "capability.missing",
    });
    expect(processes.created[0]?.killSignals).toContain("SIGTERM");
    await adapter.dispose();
  });

  it("agentInfo.version 不是 2.3.1 → protocol.version-mismatch", async () => {
    const processes = fakeProcessFactory();
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: (spec) => {
        const handle = processes.factory(spec);
        handle.acp.initResult = { protocolVersion: 1, agentInfo: { version: "2.4.0" } };
        return handle;
      },
      configProbe: configProbe("auto"),
    });
    await expect(adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 })).rejects.toMatchObject({
      code: "protocol.version-mismatch",
    });
    await adapter.dispose();
  });

  it("session/new 失败 → 杀掉进程并把错误上抛", async () => {
    const processes = fakeProcessFactory();
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: (spec) => {
        const handle = processes.factory(spec);
        handle.acp.newSessionError = new MoclError("auth.login-required", { message: "login required" });
        return handle;
      },
      configProbe: configProbe("auto"),
    });
    await expect(adapter.open({ sessionId: "s1", cwd: "/tmp/work", epoch: 0 })).rejects.toMatchObject({
      code: "auth.login-required",
    });
    expect(processes.created[0]?.killSignals).toContain("SIGTERM");
    await adapter.dispose();
  });

  it("相对 cwd → protocol.invalid-params（ABI M2 要求绝对路径）", async () => {
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: fakeProcessFactory().factory,
      configProbe: configProbe("auto"),
    });
    await expect(adapter.open({ sessionId: "s1", cwd: "relative/path", epoch: 0 })).rejects.toMatchObject({
      code: "protocol.invalid-params",
    });
    await adapter.dispose();
  });

  it("default_plan_mode 引发 -32603 时，plan 档幂等通过、yolo 档退到 set_config_option", async () => {
    const planCase = fakeProcessFactory();
    const adapterA = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: (spec) => {
        const handle = planCase.factory(spec);
        handle.acp.setModeError = new MoclError("session.conflict", { message: "Already in plan mode" });
        return handle;
      },
      configProbe: configProbe("plan"),
    });
    await expect(adapterA.open({ sessionId: "a", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 0 })).resolves.toBeDefined();
    expect(planCase.created[0]?.acp.configOptionCalls).toEqual([]);
    await adapterA.dispose();

    const yoloCase = fakeProcessFactory();
    const adapterB = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: (spec) => {
        const handle = yoloCase.factory(spec);
        handle.acp.setModeError = new MoclError("session.conflict", { message: "Already in plan mode" });
        return handle;
      },
      configProbe: configProbe("yolo"),
    });
    await adapterB.open({ sessionId: "b", cwd: "/tmp/work", permissionProfile: "yolo", epoch: 0 });
    expect(yoloCase.created[0]?.acp.configOptionCalls).toEqual([{ configId: "mode", value: "yolo" }]);
    await adapterB.dispose();
  });
});

describe("KimiAdapter 能力声明（§1.2）", () => {
  it("ACP 通道：interruptTurn/sandboxModes/concurrencyControl = unavailable；processKillInterrupt = native", () => {
    const adapter = new KimiAdapter({
      transport: "acp",
      runtime: fixedRuntime(4),
      processFactory: fakeProcessFactory().factory,
      configProbe: configProbe("auto"),
    });
    const bits = Object.fromEntries(adapter.capabilities.bits.map((entry) => [entry.bit, entry.state]));
    expect(bits["interruptTurn"]).toBe("unavailable");
    expect(bits["sandboxModes"]).toBe("unavailable");
    expect(bits["concurrencyControl"]).toBe("unavailable");
    expect(bits["processKillInterrupt"]).toBe("native");
    expect(bits["tokenLevelStream"]).toBe("native");
    expect(bits["usageReporting"]).toBe("emulated");
    expect(adapter.capabilities.transport).toBe("acp-stdio");
    expect(adapter.capabilities.nativeProtocolVersion).toBe("acp/1");
    expect(adapter.capabilities.limits.idleTimeoutMs).toBe(DEFAULT_WATCHDOG_MS);
    expect(adapter.capabilities.warnings.join(" ")).toContain("interruptTurn=unavailable");
  });

  it("CLI 通道：streaming=emulated、tokenLevelStream=unavailable、transport=cli-stream-json", () => {
    const adapter = new KimiAdapter({
      transport: "cli",
      runtime: fixedRuntime(4),
      configProbe: configProbe("plan"),
      promptRunner: new ScriptedPromptRunner(),
    });
    const bits = Object.fromEntries(adapter.capabilities.bits.map((entry) => [entry.bit, entry.state]));
    expect(bits["streaming"]).toBe("emulated");
    expect(bits["tokenLevelStream"]).toBe("unavailable");
    expect(adapter.capabilities.transport).toBe("cli-stream-json");
  });

  it("D-016：容量只来自运行时；缺失/非法 → 构造 fail-closed", () => {
    expect(
      () =>
        new KimiAdapter({
          transport: "acp",
          runtime: failingRuntime(),
          processFactory: fakeProcessFactory().factory,
          configProbe: configProbe("auto"),
        }),
    ).toThrow(RuntimeConfigError);
    expect(
      () =>
        new KimiAdapter({
          transport: "acp",
          runtime: invalidRuntime(),
          processFactory: fakeProcessFactory().factory,
          configProbe: configProbe("auto"),
        }),
    ).toThrow(RuntimeConfigError);
  });
});

describe("KimiAdapter 发送与多轮（K7）", () => {
  it("send() → turn.started + turn.completed{end-turn}", async () => {
    const { adapter, openResult } = await openAdapter();
    const result = await adapter.send({
      sessionId: "s1",
      remoteSessionId: openResult.remoteSessionId,
      input: [{ type: "text", text: "只回复 OK" }],
      idempotencyKey: "k1",
    });
    expect(result.turnId).toMatch(/^turn_/);
    const events = await drainUntil(adapter.events(), (accumulated) =>
      accumulated.some((event) => event.type === "turn.completed"),
    );
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(events[1]?.payload).toMatchObject({ stopReason: "end-turn", usage: { estimated: true } });
    await adapter.dispose();
  });

  it("同会话两轮 → 两次 turn.completed（multiTurn=native）", async () => {
    const { adapter, openResult, processes } = await openAdapter();
    const input = [{ type: "text" as const, text: "hi" }];
    await adapter.send({ sessionId: "s1", remoteSessionId: openResult.remoteSessionId, input, idempotencyKey: "k1" });
    await adapter.send({ sessionId: "s1", remoteSessionId: openResult.remoteSessionId, input, idempotencyKey: "k2" });
    const events = await drainUntil(
      adapter.events(),
      (accumulated) => accumulated.filter((event) => event.type === "turn.completed").length === 2,
    );
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
    expect(processes.created[0]?.acp.promptCount).toBe(2);
    await adapter.dispose();
  });

  it("空输入 → protocol.invalid-params", async () => {
    const { adapter, openResult } = await openAdapter();
    await expect(
      adapter.send({ sessionId: "s1", remoteSessionId: openResult.remoteSessionId, input: [], idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "protocol.invalid-params" });
    await adapter.dispose();
  });

  it("session/prompt 返回 -32602 Unknown sessionId → turn.failed + session.lost（R-1）", async () => {
    const { adapter, openResult, processes } = await openAdapter();
    const acp = processes.created[0]?.acp;
    if (acp !== undefined) acp.promptError = new MoclError("session.invalidated", { message: "Unknown sessionId" });
    await adapter.send({ sessionId: "s1", remoteSessionId: openResult.remoteSessionId, input: [{ type: "text", text: "hi" }], idempotencyKey: "k" });
    const events = await drainUntil(adapter.events(), (accumulated) =>
      accumulated.some((event) => event.type === "session.lost"),
    );
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.failed", "session.lost"]);
    expect(adapter.isSessionLost("s1")).toBe(true);
    await adapter.dispose();
  });

  it("未知 remoteSessionId → session.not-found", async () => {
    const { adapter } = await openAdapter();
    await expect(
      adapter.send({ sessionId: "x", remoteSessionId: "nope", input: [{ type: "text", text: "hi" }], idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "session.not-found" });
    await adapter.dispose();
  });
});

describe("KimiAdapter 关闭/释放", () => {
  it("close() → session.closed + 杀进程（幂等）", async () => {
    const { adapter, openResult, processes } = await openAdapter();
    await adapter.close({ sessionId: "s1", remoteSessionId: openResult.remoteSessionId, reason: "completed" });
    const events = await drainUntil(adapter.events(), (accumulated) =>
      accumulated.some((event) => event.type === "session.closed"),
    );
    expect(events.at(-1)).toMatchObject({ type: "session.closed", payload: { reason: "completed" } });
    expect(processes.created[0]?.killSignals).toContain("SIGTERM");
    await expect(
      adapter.close({ sessionId: "s1", remoteSessionId: openResult.remoteSessionId, reason: "completed" }),
    ).resolves.toBeUndefined();
    await adapter.dispose();
  });

  it("dispose() 后调用 → transport.disconnected", async () => {
    const { adapter } = await openAdapter();
    await adapter.dispose();
    await expect(adapter.open({ sessionId: "s2", cwd: "/tmp/work", epoch: 1 })).rejects.toMatchObject({
      code: "transport.disconnected",
    });
  });
});

describe("KimiAdapter CLI 兜底通道（§7.5 fail-closed）", () => {
  function cliAdapter(probe: ReturnType<typeof configProbe>, runner: ScriptedPromptRunner): KimiAdapter {
    return new KimiAdapter({
      transport: "cli",
      runtime: fixedRuntime(4),
      configProbe: probe,
      promptRunner: runner,
      allowedRoots: ["/tmp/work"],
    });
  }

  it("配置档位不满足请求档位 → policy.escalation-required（拒绝使用 CLI 兜底）", async () => {
    const runner = new ScriptedPromptRunner();
    const adapter = cliAdapter(configProbe("yolo"), runner);
    await expect(
      adapter.open({ sessionId: "s1", cwd: "/tmp/work", permissionProfile: "safe-auto", epoch: 0 }),
    ).rejects.toMatchObject({ code: "policy.escalation-required" });
    expect(runner.calls).toHaveLength(0);
  });

  it("配置不可读 → 同样拒绝（fail-closed）", async () => {
    const adapter = cliAdapter(unreadableConfigProbe(), new ScriptedPromptRunner());
    await expect(
      adapter.open({ sessionId: "s1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 0 }),
    ).rejects.toMatchObject({ code: "policy.escalation-required" });
  });

  it("配置=plan + read-only → 可用；send 解析 stream-json 并捕获后端 sessionId", async () => {
    const runner = new ScriptedPromptRunner();
    runner.stdoutLines = [
      JSON.stringify({ role: "meta", type: "system.version", version: "2.3.1" }),
      JSON.stringify({ role: "assistant", content: "OK" }),
      JSON.stringify({
        role: "meta",
        type: "session.resume_hint",
        session_id: "session_cli_1",
        command: "kimi -r session_cli_1",
      }),
    ];
    const adapter = cliAdapter(configProbe("plan"), runner);
    await adapter.open({ sessionId: "s1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 0 });
    const sendResult = await adapter.send({
      sessionId: "s1",
      remoteSessionId: "",
      input: [{ type: "text", text: "只回复 OK" }],
      idempotencyKey: "k1",
    });
    expect(sendResult.turnId).toMatch(/^turn_/);
    // 参数面：-p/--output-format + -m（首次无 -S）；绝不出现模式旗标
    const argv = runner.calls[0]?.argv ?? [];
    expect(argv.slice(0, 4)).toEqual(["-p", "只回复 OK", "--output-format", "stream-json"]);
    expect(argv).toContain("-m");
    for (const forbidden of ["-y", "--yolo", "--auto", "--plan"]) expect(argv).not.toContain(forbidden);
    const events = await drainUntil(adapter.events(), (accumulated) =>
      accumulated.some((event) => event.type === "turn.completed"),
    );
    expect(events.map((event) => event.type)).toContain("turn.completed");
    expect(events.map((event) => event.type)).toContain("message.completed");
    expect(adapter.dropStats["drop.cli_meta.session.resume_hint"]).toBe(1);
    expect(adapter.capabilities.transport).toBe("cli-stream-json");
    await adapter.dispose();
  });

  it("CLI 非零退出 → turn.failed 且上抛", async () => {
    const runner = new ScriptedPromptRunner();
    runner.exitCode = 1;
    runner.stderr = "error: Cannot combine --prompt with --auto.";
    const adapter = cliAdapter(configProbe("plan"), runner);
    await adapter.open({ sessionId: "s1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 0 });
    await expect(
      adapter.send({ sessionId: "s1", remoteSessionId: "", input: [{ type: "text", text: "hi" }], idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(MoclError);
    const events = await drainUntil(adapter.events(), (accumulated) =>
      accumulated.some((event) => event.type === "turn.failed"),
    );
    expect(events.map((event) => event.type)).toContain("turn.failed");
    await adapter.dispose();
  });

  it("CLI 超时 → turn.aborted{timeout} + session.lost", async () => {
    const runner = new ScriptedPromptRunner();
    runner.timedOut = true;
    runner.exitCode = null;
    const adapter = cliAdapter(configProbe("plan"), runner);
    await adapter.open({ sessionId: "s1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 0 });
    // 先把 open() 期间的 session.created 消费掉，只看本轮事件
    await drainUntil(adapter.events(), (events) => events.some((event) => event.type === "session.created"));
    await expect(
      adapter.send({ sessionId: "s1", remoteSessionId: "", input: [{ type: "text", text: "hi" }], idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "limit.turn-timeout" });
    const events = await drainUntil(adapter.events(), (accumulated) =>
      accumulated.some((event) => event.type === "session.lost"),
    );
    expect(events.map((event) => event.type)).toEqual(["turn.aborted", "session.lost"]);
    await adapter.dispose();
  });
});

describe("纯函数助手", () => {
  it("assertHandshake 断言 protocolVersion 与版本", () => {
    expect(() => assertHandshake(1, "2.3.1")).not.toThrow();
    expect(() => assertHandshake(1, undefined)).not.toThrow();
    expect(() => assertHandshake(2, "2.3.1")).toThrow(/protocolVersion/);
    expect(() => assertHandshake(1, "9.9.9")).toThrow(/version mismatch/);
  });

  it("assertAbsoluteCwd 拒绝相对路径", () => {
    expect(assertAbsoluteCwd("/tmp/work")).toBe("/tmp/work");
    expect(() => assertAbsoluteCwd("work")).toThrow();
    expect(() => assertAbsoluteCwd("")).toThrow();
  });

  it("modelOfConfigOptions 取 id=model 的 currentValue", () => {
    expect(modelOfConfigOptions([{ id: "model", currentValue: "kimi-code/k3.1-pro" }])).toBe("kimi-code/k3.1-pro");
    expect(modelOfConfigOptions([])).toBeNull();
  });

  it("FakeTransport 假件自身可用（自检：pgid 与写入帧）", () => {
    const transport = new FakeTransport(1234);
    transport.writeLine('{"jsonrpc":"2.0"}');
    expect(transport.pgid).toBe(1234);
    expect(transport.written).toHaveLength(1);
  });

  it("临时目录假件可写可清理", async () => {
    const temp = await makeTempDir();
    await temp.cleanup();
    expect(temp.dir.length).toBeGreaterThan(0);
  });
});

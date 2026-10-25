import { describe, expect, it } from "vitest";
import { ConfigError, validateConfig } from "../../src/facade/config.ts";
import { MoclError, moclError } from "../../src/facade/errors.ts";
import { MoclFacade } from "../../src/facade/facade.ts";
import { enabledConfig, FakeAdapter, fixedRuntime, makeFacade } from "./helpers.ts";

describe("MoclFacade 生命周期（Broker + 四适配器）", () => {
  it("开放默认：global.enabled=false 时 open 被拒绝（fail-closed）", async () => {
    const dir = await import("node:fs/promises").then((m) => m.mkdtemp("/tmp/mocl-c8-disabled-"));
    try {
      const facade = await MoclFacade.create({
        config: validateConfig({}),
        runtime: fixedRuntime(2),
        adapters: { codex: new FakeAdapter("codex") },
        registryPath: `${dir}/sessions.json`,
      });
      await expect(facade.open("codex", "hello")).rejects.toMatchObject({ code: "policy.permission-denied" });
    } finally {
      await import("node:fs/promises").then((m) => m.rm(dir, { recursive: true, force: true }));
    }
  });

  it("未启用的后端 → policy.permission-denied（不偷偷路由）", async () => {
    const { facade, cleanup } = await makeFacade({ config: enabledConfig({ enabled: ["codex"] }), adapters: { codex: new FakeAdapter("codex") } });
    try {
      await expect(facade.open("kimi", "hello")).rejects.toMatchObject({ code: "policy.permission-denied" });
    } finally {
      await cleanup();
    }
  });

  it("四后端路由：open(backend) 分派到对应适配器", async () => {
    const adapters = {
      codex: new FakeAdapter("codex"),
      kimi: new FakeAdapter("kimi"),
      "claude-code": new FakeAdapter("claude-code"),
      opencode: new FakeAdapter("opencode"),
    } as const;
    const config = enabledConfig({ enabled: ["codex", "kimi", "claude-code", "opencode"] });
    const { facade, cleanup } = await makeFacade({ config, adapters, runtime: fixedRuntime(8) });
    try {
      for (const backend of ["codex", "kimi", "claude-code", "opencode"] as const) {
        const outcome = await facade.open(backend, `task for ${backend}`);
        expect(outcome.backend).toBe(backend);
        expect(adapters[backend].openCalls).toBe(1);
        expect(adapters[backend].sendCalls).toBe(1);
        expect(outcome.childId).toMatch(/^sess_/);
        expect(outcome.turnId).toBe(`turn_${backend}_1`);
      }
    } finally {
      await cleanup();
    }
  });

  it("open 默认把 read-only 权限档传给适配器（最小权限）", async () => {
    const adapter = new FakeAdapter("codex");
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter } });
    try {
      await facade.open("codex", "hello", { cwd: "/tmp" });
      expect(adapter.openRequests[0]?.permissionProfile).toBe("read-only");
      expect(adapter.openRequests[0]?.cwd).toBe("/tmp");
    } finally {
      await cleanup();
    }
  });

  it("open 模型优先级：显式参数 > 配置 > null", async () => {
    const adapter = new FakeAdapter("codex");
    const config = enabledConfig({ enabled: ["codex"], backends: { codex: { model: "cfg-model" } } });
    const { facade, cleanup } = await makeFacade({ config, adapters: { codex: adapter } });
    try {
      await facade.open("codex", "a");
      await facade.open("codex", "b", { model: "call-model" });
      expect(adapter.openRequests[0]?.model).toBe("cfg-model");
      expect(adapter.openRequests[1]?.model).toBe("call-model");
    } finally {
      await cleanup();
    }
  });

  it("send/status/list/resume/interrupt/close 全链路", async () => {
    const adapter = new FakeAdapter("codex");
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter } });
    try {
      const opened = await facade.open("codex", "first");
      const sent = await facade.send(opened.childId, "second");
      expect(sent.turnId).toBe("turn_codex_2");
      const status = await facade.status(opened.childId, 5);
      expect(status).toMatchObject({ childId: opened.childId, backend: "codex", state: "running", cursor: { fromSeq: 5 } });
      expect(status.remoteIdState).toBe("bound");
      const listed = await facade.list();
      expect(listed.children.map((child) => child.childId)).toContain(opened.childId);
      const resumed = await facade.resume(opened.childId);
      expect(resumed).toMatchObject({ strategy: "resume", childId: opened.childId, remoteIdState: "bound" });
      await facade.interrupt(opened.childId);
      expect(adapter.interruptCalls).toBe(1);
      const closed = await facade.close(opened.childId);
      expect(closed).toEqual({ childId: opened.childId, closed: true });
      expect(adapter.closeCalls).toBe(1);
      // 幂等 close：已关闭会话再次 close 不报错
      await expect(facade.close(opened.childId)).resolves.toMatchObject({ closed: true });
    } finally {
      await cleanup();
    }
  });

  it("D-020：kimi CLI 空 remoteId → open/status 显示 pending；resume 回填后 bound", async () => {
    const adapter = new FakeAdapter("kimi", { remoteId: "" });
    const config = enabledConfig({ enabled: ["kimi"], backends: { kimi: { channel: "cli" } } });
    const { facade, cleanup } = await makeFacade({ config, adapters: { kimi: adapter } });
    try {
      const opened = await facade.open("kimi", "task");
      expect(opened.backendSessionId).toBeNull();
      expect(opened.remoteIdState).toBe("pending");
      expect((await facade.status(opened.childId)).remoteIdState).toBe("pending");
      adapter.remoteId = "remote_backfilled";
      const resumed = await facade.resume(opened.childId);
      expect(resumed.remoteIdState).toBe("bound");
      expect((await facade.status(opened.childId)).backendSessionId).toBe("remote_backfilled");
    } finally {
      await cleanup();
    }
  });

  it("D-021：kimi CLI 通道切换权限档 → policy.escalation-required", async () => {
    const adapter = new FakeAdapter("kimi");
    const config = enabledConfig({
      enabled: ["kimi"],
      global: { dangerousModes: { allowed: true } },
      backends: { kimi: { channel: "cli", allowDangerousModes: true } },
    });
    const { facade, cleanup } = await makeFacade({ config, adapters: { kimi: adapter } });
    try {
      await expect(facade.open("kimi", "task", { permissionMode: "safe-auto" })).rejects.toMatchObject({
        code: "policy.escalation-required",
      });
    } finally {
      await cleanup();
    }
  });

  it("危险档仍受全局/后端开关约束（read-only 是默认）", async () => {
    const adapter = new FakeAdapter("codex");
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter } });
    try {
      await expect(facade.open("codex", "task", { permissionMode: "yolo" })).rejects.toMatchObject({
        code: "policy.escalation-required",
      });
    } finally {
      await cleanup();
    }
  });

  it("maxDepth 超过允许值 → limit.nesting-exceeded", async () => {
    const { facade, cleanup } = await makeFacade({ adapters: { codex: new FakeAdapter("codex") } });
    try {
      await expect(facade.open("codex", "task", { maxDepth: 3 })).rejects.toMatchObject({ code: "limit.nesting-exceeded" });
      await expect(facade.open("codex", "task", { maxDepth: "provider-managed" })).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("并发容量运行时派生：满额被拒、close 释放后可再开", async () => {
    const { facade, cleanup } = await makeFacade({ runtime: fixedRuntime(1), adapters: { codex: new FakeAdapter("codex") } });
    try {
      const first = await facade.open("codex", "a");
      await expect(facade.open("codex", "b")).rejects.toMatchObject({ code: "limit.concurrency-exceeded" });
      await facade.close(first.childId);
      await expect(facade.open("codex", "c")).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("配置 maxConcurrent 不得超运行时（D-016 fail-closed）", async () => {
    const config = enabledConfig({ enabled: ["codex"], global: { maxConcurrent: 4 } });
    await expect(makeFacade({ config, runtime: fixedRuntime(2), adapters: { codex: new FakeAdapter("codex") } })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("错误映射：适配器普通异常 → internal.unexpected ErrorRef", async () => {
    const adapter = new FakeAdapter("codex");
    adapter.failSend = new Error("boom from adapter");
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter } });
    try {
      await expect(facade.open("codex", "task")).rejects.toMatchObject({
        code: "internal.unexpected",
      });
    } finally {
      await cleanup();
    }
  });

  it("错误映射：MoclError 原样透传（ABI 错误码不被吞）", async () => {
    const adapter = new FakeAdapter("codex");
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter } });
    try {
      const opened = await facade.open("codex", "task");
      adapter.failSend = moclError("quota.rate-limited", { message: "rate limited" });
      await expect(facade.send(opened.childId, "again")).rejects.toMatchObject({ code: "quota.rate-limited" });
    } finally {
      await cleanup();
    }
  });

  it("未知会话/非法参数 → ABI 错误（不抛裸 Error）", async () => {
    const { facade, cleanup } = await makeFacade({ adapters: { codex: new FakeAdapter("codex") } });
    try {
      await expect(facade.status("sess_missing")).rejects.toBeInstanceOf(MoclError);
      await expect(facade.status("sess_missing")).rejects.toMatchObject({ code: "session.not-found" });
      const opened = await facade.open("codex", "task");
      await expect(facade.status(opened.childId, -1)).rejects.toMatchObject({ code: "protocol.invalid-params" });
      await expect(facade.open("codex", "task", { cwd: "relative/dir" })).rejects.toMatchObject({
        code: "protocol.invalid-params",
      });
    } finally {
      await cleanup();
    }
  });

  it("task 为空 → protocol.invalid-params（首轮前拒绝，不建会话）", async () => {
    const adapter = new FakeAdapter("codex");
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter } });
    try {
      await expect(facade.open("codex", "   ")).rejects.toMatchObject({ code: "protocol.invalid-params" });
      expect(adapter.openCalls).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

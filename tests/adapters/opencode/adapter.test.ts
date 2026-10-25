import { describe, expect, it } from "vitest";
import { CAPABILITY_BITS } from "../../../src/abi/capabilities.ts";
import { OpenCodeAdapter } from "../../../src/adapters/opencode/index.ts";
import { FREE_FALLBACK_MARKER, FREE_FALLBACK_MODEL, PRODUCTION_MODEL } from "../../../src/adapters/opencode/models.ts";
import { moclError } from "../../../src/broker/errors.ts";
import { RuntimeConfigError } from "../../../src/broker/concurrency.ts";
import {
  drainUntil,
  failingRuntime,
  FakeAcp,
  FakeHttpApi,
  fixedRuntime,
  invalidRuntime,
  loadFrames,
} from "./helpers.ts";

const input = [{ type: "text" as const, text: "只回复两个字符：OK" }];

function makeHttpAdapter(http: FakeHttpApi, initialModel: string = PRODUCTION_MODEL): OpenCodeAdapter {
  return new OpenCodeAdapter({
    transport: "http",
    http,
    runtime: fixedRuntime(7),
    initialModel,
    clock: () => new Date("2026-10-26T00:00:00.000Z"),
    turnIdFactory: () => "turn_test_fixed",
  });
}

function makeAcpAdapter(acp: FakeAcp, initialModel: string = PRODUCTION_MODEL): OpenCodeAdapter {
  return new OpenCodeAdapter({
    transport: "acp",
    acp,
    runtime: fixedRuntime(4),
    initialModel,
    clock: () => new Date("2026-10-26T00:00:00.000Z"),
    turnIdFactory: () => "turn_acp_fixed",
  });
}

describe("OpenCodeAdapter —— 能力声明与 D-016 闸门", () => {
  it("HTTP 通道能力位：34 位齐全，sandbox=unavailable，并发容量来自运行时", () => {
    const adapter = makeHttpAdapter(new FakeHttpApi());
    expect(adapter.capabilities.bits).toHaveLength(CAPABILITY_BITS.length);
    const bits = new Map(adapter.capabilities.bits.map((entry) => [entry.bit, entry.state]));
    expect(bits.get("sandboxModes")).toBe("unavailable");
    expect(bits.get("concurrencyControl")).toBe("unavailable");
    expect(bits.get("interruptTurn")).toBe("native");
    expect(bits.get("streaming")).toBe("native");
    expect(bits.get("tokenLevelStream")).toBe("unavailable");
    expect(adapter.capabilities.limits).toMatchObject({
      maxSessionsPerBackend: 7,
      maxConcurrentTurns: 1,
      maxNestingDepth: 1,
    });
    expect(adapter.capabilities.transport).toBe("http-api");
    expect(adapter.capabilities.warnings).toContain("sandboxModes=unavailable");
  });

  it("ACP 通道能力位：interrupt=emulated、权限桥 unavailable", () => {
    const adapter = makeAcpAdapter(new FakeAcp());
    const bits = new Map(adapter.capabilities.bits.map((entry) => [entry.bit, entry.state]));
    expect(adapter.capabilities.transport).toBe("acp-stdio");
    expect(bits.get("interruptTurn")).toBe("emulated");
    expect(bits.get("permissionRequestBridge")).toBe("unavailable");
    expect(bits.get("childSessionUpdates")).toBe("native");
  });

  it("运行时不可用/非法 → 构造 fail-closed（RuntimeConfigError，不猜默认）", () => {
    expect(() => new OpenCodeAdapter({ transport: "http", http: new FakeHttpApi(), runtime: failingRuntime() })).toThrow(
      RuntimeConfigError,
    );
    expect(() => new OpenCodeAdapter({ transport: "http", http: new FakeHttpApi(), runtime: invalidRuntime() })).toThrow(
      RuntimeConfigError,
    );
  });
});

describe("OpenCodeAdapter —— HTTP 主通道（D-007）", () => {
  it("open → send → events：turn.started/message/usage/turn.completed 全链路", async () => {
    const http = new FakeHttpApi();
    http.promptBehaviors = ["emit-success"];
    const adapter = makeHttpAdapter(http);
    try {
      const opened = await adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 });
      expect(opened.remoteSessionId).toBe("ses_test_1");
      expect(http.createSessionCalls[0]).toMatchObject({
        agent: "plan",
        model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
        location: { directory: "/tmp/work" },
      });

      const sent = await adapter.send({
        sessionId: "sess_1",
        remoteSessionId: "ses_test_1",
        input,
        idempotencyKey: "send-1",
      });
      expect(sent.turnId).toBe("turn_test_fixed");
      const events = await drainUntil(adapter.events(), (collected) =>
        collected.some((event) => event.type === "turn.completed"),
      );
      const types = events.map((event) => event.type);
      expect(types).toContain("turn.started");
      expect(types).toContain("message.delta");
      expect(types).toContain("message.completed");
      expect(types).toContain("usage.updated");
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.payload).toMatchObject({ stopReason: "end-turn" });
    } finally {
      await adapter.dispose();
    }
  });

  it("catalog 噪声丢弃计数（share service 事件需过滤）", async () => {
    const http = new FakeHttpApi();
    http.frames = [...loadFrames("sse-success"), ...loadFrames("catalog-noise")];
    http.promptBehaviors = ["emit-success"];
    const adapter = makeHttpAdapter(http);
    try {
      await adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 });
      await adapter.send({ sessionId: "sess_1", remoteSessionId: "ses_test_1", input, idempotencyKey: "s1" });
      await drainUntil(adapter.events(), (collected) => collected.some((event) => event.type === "turn.completed"));
      expect(adapter.dropStats["drop.catalog_event"]).toBe(5);
    } finally {
      await adapter.dispose();
    }
  });

  it("401 api_key_expired：显式降级 + 事件 + 下一轮使用免费模型（D-019）", async () => {
    const http = new FakeHttpApi();
    http.promptBehaviors = ["throw-auth-expired", "emit-success"];
    const adapter = makeHttpAdapter(http);
    try {
      await adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 });
      await expect(
        adapter.send({ sessionId: "sess_1", remoteSessionId: "ses_test_1", input, idempotencyKey: "s1" }),
      ).rejects.toMatchObject({ code: "auth.credential-expired" });

      // 降级必须显式：switchModel 到免费模型 + session.warning 带标记
      expect(http.switchModelCalls).toEqual([{ providerID: "opencode", id: "deepseek-v4.1-flash-free" }]);
      const warnings = await drainUntil(adapter.events(), (collected) =>
        collected.some((event) => event.type === "session.warning"),
      );
      const warning = warnings.find((event) => event.type === "session.warning");
      expect(warning?.payload).toMatchObject({ code: "model.free-fallback", degrade: true });
      expect(JSON.stringify(warning?.payload)).toContain(FREE_FALLBACK_MARKER);
      expect(adapter.modelState).toMatchObject({ model: FREE_FALLBACK_MODEL, degraded: true });

      // 下一轮使用免费模型并正常完成
      await adapter.send({ sessionId: "sess_1", remoteSessionId: "ses_test_1", input, idempotencyKey: "s2" });
      const events = await drainUntil(adapter.events(), (collected) =>
        collected.some((event) => event.type === "turn.completed"),
      );
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);
      expect(http.promptCalls).toHaveLength(2);
    } finally {
      await adapter.dispose();
    }
  });

  it("SSE 侧 401（prompt 已接受后失败）也触发显式降级", async () => {
    const http = new FakeHttpApi();
    http.promptBehaviors = ["emit-auth-expired"];
    const adapter = makeHttpAdapter(http);
    try {
      await adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 });
      await adapter.send({ sessionId: "sess_1", remoteSessionId: "ses_test_1", input, idempotencyKey: "s1" });
      const events = await drainUntil(adapter.events(), (collected) => {
        const hasFailed = collected.some((event) => event.type === "turn.failed");
        const hasWarning = collected.some((event) => event.type === "session.warning");
        return hasFailed && hasWarning;
      });
      expect(events.some((event) => event.type === "turn.failed")).toBe(true);
      expect(http.switchModelCalls).toHaveLength(1);
      expect(adapter.modelState.degraded).toBe(true);
    } finally {
      await adapter.dispose();
    }
  });

  it("resume：远端存在/不存在（R-1 判定输入）", async () => {
    const http = new FakeHttpApi();
    const adapter = makeHttpAdapter(http);
    try {
      await adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 });
      await expect(
        adapter.resume({ sessionId: "sess_1", remoteSessionId: "ses_test_1", fromSeq: 0 }),
      ).resolves.toMatchObject({ exists: true, remoteSessionId: "ses_test_1" });

      http.getSessionError = moclError("session.not-found", { message: "gone" });
      await expect(
        adapter.resume({ sessionId: "sess_1", remoteSessionId: "ses_test_1", fromSeq: 0 }),
      ).resolves.toMatchObject({ exists: false });
    } finally {
      await adapter.dispose();
    }
  });

  it("interrupt → turn.aborted(native)；close → session.closed 且幂等", async () => {
    const http = new FakeHttpApi();
    const adapter = makeHttpAdapter(http);
    try {
      await adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 });
      await adapter.send({ sessionId: "sess_1", remoteSessionId: "ses_test_1", input, idempotencyKey: "s1" });
      await adapter.interrupt({ sessionId: "sess_1", remoteSessionId: "ses_test_1", turnId: "turn_test_fixed" });
      expect(http.interruptCalls).toEqual([true]);
      const events = await drainUntil(adapter.events(), (collected) =>
        collected.some((event) => event.type === "turn.aborted"),
      );
      expect(events.find((event) => event.type === "turn.aborted")?.payload).toMatchObject({
        interruptMethod: "native",
      });

      await adapter.close({ sessionId: "sess_1", remoteSessionId: "ses_test_1", reason: "completed" });
      await adapter.close({ sessionId: "sess_1", remoteSessionId: "ses_test_1", reason: "completed" }); // 幂等
      const closed = await drainUntil(adapter.events(), (collected) =>
        collected.some((event) => event.type === "session.closed"),
      );
      expect(closed).toHaveLength(1);
    } finally {
      await adapter.dispose();
    }
  });

  it("握手断言：OpenAPI 缺必需 operationId → protocol.version-mismatch", async () => {
    const http = new FakeHttpApi();
    http.openapiOverride = {
      openapi: "3.1.0",
      paths: { "/api/session": { post: { operationId: "session.create" } } },
    };
    const adapter = makeHttpAdapter(http);
    await expect(
      adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 }),
    ).rejects.toMatchObject({ code: "protocol.version-mismatch" });
  });
});

describe("OpenCodeAdapter —— ACP 兜底通道", () => {
  it("open → send：先 set_config_option 切模型，再 prompt 并产出 turn.completed", async () => {
    const acp = new FakeAcp();
    const adapter = makeAcpAdapter(acp);
    try {
      const opened = await adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 });
      expect(opened.remoteSessionId).toBe("ses_acp_1");
      expect(acp.configOptionCalls[0]).toMatchObject({
        sessionId: "ses_acp_1",
        configId: "model",
        value: PRODUCTION_MODEL,
      });

      await adapter.send({ sessionId: "sess_1", remoteSessionId: "ses_acp_1", input, idempotencyKey: "s1" });
      const events = await drainUntil(adapter.events(), (collected) =>
        collected.some((event) => event.type === "turn.completed"),
      );
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        stopReason: "end-turn",
        usage: { inputTokens: 10, outputTokens: 2 },
      });
    } finally {
      await adapter.dispose();
    }
  });

  it("ACP 认证失败 → 切免费模型 + warning（不静默）", async () => {
    const acp = new FakeAcp();
    acp.promptError = moclError("auth.credential-expired", { message: "api_key_expired" });
    const adapter = makeAcpAdapter(acp);
    try {
      await adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 });
      await expect(
        adapter.send({ sessionId: "sess_1", remoteSessionId: "ses_acp_1", input, idempotencyKey: "s1" }),
      ).rejects.toMatchObject({ code: "auth.credential-expired" });
      expect(acp.configOptionCalls.at(-1)).toMatchObject({
        configId: "model",
        value: FREE_FALLBACK_MODEL,
      });
      const events = await drainUntil(adapter.events(), (collected) =>
        collected.some((event) => event.type === "session.warning"),
      );
      expect(events.some((event) => event.type === "session.warning")).toBe(true);
      expect(adapter.modelState.degraded).toBe(true);
    } finally {
      await adapter.dispose();
    }
  });

  it("ACP resume：loadSession 报未知会话 → exists=false", async () => {
    const acp = new FakeAcp();
    const adapter = makeAcpAdapter(acp);
    try {
      await adapter.open({ sessionId: "sess_1", cwd: "/tmp/work", permissionProfile: "read-only", epoch: 1 });
      acp.loadError = moclError("protocol.invalid-params", { message: "unknown session" });
      await expect(
        adapter.resume({ sessionId: "sess_1", remoteSessionId: "ses_acp_1", fromSeq: 0 }),
      ).resolves.toMatchObject({ exists: false });
    } finally {
      await adapter.dispose();
    }
  });
});

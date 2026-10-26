import { describe, expect, it } from "vitest";
import { moclError } from "../../src/facade/errors.ts";
import {
  apply,
  BACKEND_ENUM,
  createMoclStatusTool,
  createSubagentAgentTool,
  DEFAULT_MAX_DEPTH,
  PERMISSION_MODE_ENUM,
  runtimeProviderFromContext,
  validateSubagentAgentArgs,
  type MoclFacadeLike,
} from "../../src/plugin/index.ts";
import type { DshHostContext, DshToolDefinition } from "../../src/plugin/dsh-types.js";

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

class FakeFacade implements MoclFacadeLike {
  readonly calls: Call[] = [];
  error: Error | null = null;
  readonly openResult = {
    childId: "sess_test",
    backend: "codex" as const,
    backendSessionId: "remote_1",
    remoteIdState: "bound" as const,
    epoch: 1,
    state: "running" as const,
    turnId: "turn_1",
    deduplicated: false,
  };
  async open(backend: string, task: string, options?: unknown): Promise<never> {
    this.calls.push({ method: "open", args: [backend, task, options] });
    if (this.error !== null) throw this.error;
    return this.openResult as never;
  }
  async send(childId: string, message: string): Promise<never> {
    this.calls.push({ method: "send", args: [childId, message] });
    return {} as never;
  }
  async status(childId: string, cursor?: number): Promise<never> {
    this.calls.push({ method: "status", args: [childId, cursor] });
    if (this.error !== null) throw this.error;
    return { childId, remoteIdState: "pending" } as never;
  }
  async list(): Promise<never> {
    this.calls.push({ method: "list", args: [] });
    return { children: [] } as never;
  }
  async resume(childId: string): Promise<never> {
    this.calls.push({ method: "resume", args: [childId] });
    return {} as never;
  }
  async interrupt(childId: string): Promise<never> {
    this.calls.push({ method: "interrupt", args: [childId] });
    return {} as never;
  }
  async close(childId: string): Promise<never> {
    this.calls.push({ method: "close", args: [childId] });
    return {} as never;
  }
}

function fakeContext(tools: DshToolDefinition[] = [], settings?: Record<string, unknown>): DshHostContext {
  return {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => undefined;
      },
    },
    settings: { get: (key) => settings?.[key] },
  };
}

describe("DSH 插件薄壳（subagent_agent / mocl_status）", () => {
  it("ctx 缺失/无 tools.register → fail-closed（抛错，不静默跳过注册）", () => {
    expect(() => apply(undefined as never)).toThrow(/fail-closed/);
    expect(() => apply({} as never)).toThrow(/fail-closed/);
  });

  it("apply 注册恰好两个工具，名称固定", () => {
    const tools: DshToolDefinition[] = [];
    apply(fakeContext(tools, { "subagent.maxActiveSubagents": 4 }), { __facade: new FakeFacade() });
    expect(tools.map((tool) => tool.name)).toEqual(["subagent_agent", "mocl_status"]);
  });

  it("subagent_agent schema：backend 四枚举、task 必填、permissionMode 三档、maxDepth provider-managed", () => {
    const tool = createSubagentAgentTool(new FakeFacade());
    const schema = tool.parameters;
    expect(tool.name).toBe("subagent_agent");
    expect(schema.required).toEqual(["backend", "task"]);
    expect(schema.properties?.["backend"]?.enum).toEqual([...BACKEND_ENUM]);
    expect(schema.properties?.["permissionMode"]?.enum).toEqual([...PERMISSION_MODE_ENUM]);
    const depth = schema.properties?.["maxDepth"];
    expect(JSON.stringify(depth)).toContain("provider-managed");
    expect(DEFAULT_MAX_DEPTH).toBe("provider-managed");
    expect(tool.output.schema.type).toBe("object");
  });

  it("subagent_agent execute 只调门面 open（参数完整映射）", async () => {
    const facade = new FakeFacade();
    const tool = createSubagentAgentTool(facade);
    const result = await tool.execute(
      {
        backend: "opencode",
        task: "do it",
        cwd: "/tmp/x",
        model: "m",
        permissionMode: "read-only",
        maxDepth: "provider-managed",
      },
      {},
    );
    expect(result).toMatchObject({ ok: true, childId: "sess_test" });
    expect(facade.calls).toHaveLength(1);
    expect(facade.calls[0]?.method).toBe("open");
    expect(facade.calls[0]?.args[0]).toBe("opencode");
    expect(facade.calls[0]?.args[1]).toBe("do it");
    expect(facade.calls[0]?.args[2]).toMatchObject({ cwd: "/tmp/x", model: "m", permissionMode: "read-only", maxDepth: "provider-managed" });
  });

  it("subagent_agent 非法 backend/空 task → ok:false + protocol.invalid-params", async () => {
    const facade = new FakeFacade();
    const tool = createSubagentAgentTool(facade);
    for (const args of [{ backend: "gpt", task: "x" }, { backend: "codex", task: "   " }, { backend: "codex" }]) {
      const result = (await tool.execute(args as never, {})) as { ok: boolean; error: { code: string } };
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("protocol.invalid-params");
    }
    expect(facade.calls).toHaveLength(0);
  });

  it("门面 MoclError → 工具结果携带原 ABI 错误码（不吞）", async () => {
    const facade = new FakeFacade();
    facade.error = moclError("quota.rate-limited", { message: "rate limited" });
    const result = (await createSubagentAgentTool(facade).execute({ backend: "codex", task: "x" }, {})) as {
      ok: boolean;
      error: { code: string; userMessage: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("quota.rate-limited");
    expect(result.error.userMessage.length).toBeGreaterThan(0);
  });

  it("validateSubagentAgentArgs 是 schema 之外的第二道闸", () => {
    expect(validateSubagentAgentArgs({ backend: "claude-code", task: "t" })).toMatchObject({ backend: "claude-code", task: "t" });
    expect(validateSubagentAgentArgs({ backend: "codex", task: "t", maxDepth: 2 }).maxDepth).toBe(2);
    expect(() => validateSubagentAgentArgs({ backend: "codex", task: "t", maxDepth: 0 })).toThrow(/maxDepth/);
    expect(() => validateSubagentAgentArgs({ backend: "codex", task: "t", permissionMode: "root" })).toThrow(/permissionMode/);
  });

  it("mocl_status：传 childId 查单会话（cursor 透传）", async () => {
    const facade = new FakeFacade();
    const tool = createMoclStatusTool(facade);
    const result = (await tool.execute({ childId: "sess_1", cursor: 7 }, {})) as { ok: boolean; status: unknown };
    expect(result.ok).toBe(true);
    expect(facade.calls[0]).toEqual({ method: "status", args: ["sess_1", 7] });
  });

  it("mocl_status：不传 childId 列出全部", async () => {
    const facade = new FakeFacade();
    const result = (await createMoclStatusTool(facade).execute({}, {})) as { ok: boolean; children: unknown[] };
    expect(result.ok).toBe(true);
    expect(facade.calls[0]?.method).toBe("list");
    expect(Array.isArray(result.children)).toBe(true);
  });

  it("mocl_status 非法 cursor → ok:false + protocol.invalid-params", async () => {
    const result = (await createMoclStatusTool(new FakeFacade()).execute({ childId: "sess_1", cursor: -1 }, {})) as {
      ok: boolean;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("protocol.invalid-params");
  });

  it("工具返回值做 lossless-JSON 归一化（undefined 不会让宿主判 invalid output）", async () => {
    const facade = {
      async open() { return {}; },
      async send() { return {}; },
      async status() { return { childId: "sess_1", usage: { costUsd: undefined, inputTokens: 1 }, extra: undefined }; },
      async list() { return { children: [{ childId: "sess_1", usage: { costUsd: undefined } }] }; },
      async resume() { return {}; },
      async interrupt() { return {}; },
      async close() { return {}; },
    } as unknown as MoclFacadeLike;
    const result = await createMoclStatusTool(facade).execute({}, {});
    const text = JSON.stringify(result);
    expect(text).toBeDefined();
    expect(text).not.toContain("undefined");
    expect(JSON.parse(text as string)).toEqual(result);
  });

  it("runtimeProviderFromContext 读 Host settings 的 subagent.maxActiveSubagents（D-016）", () => {
    const ctx = fakeContext([], { "subagent.maxActiveSubagents": 6 });
    expect(runtimeProviderFromContext(ctx).read()).toEqual({ maxActiveSubagents: 6 });
  });

  it("Host 运行时值缺失 → fail-closed（不默认 8 或任何数字）", () => {
    const provider = runtimeProviderFromContext(fakeContext([], {}));
    expect(() => provider.read()).toThrow(/D-016 fail-closed/);
  });

  it("runtimeProviderFromContext 读 DSH 真实形状：ctx.get('subagents').config.maxActiveSubagents.get()（D-016）", () => {
    const ctx: DshHostContext = {
      tools: { register: () => () => undefined },
      get: (name: string) =>
        name === "subagents" ? { config: { maxActiveSubagents: { get: () => 20 } } } : undefined,
    };
    expect(runtimeProviderFromContext(ctx).read()).toEqual({ maxActiveSubagents: 20 });
  });

  it("未 inject settings（属性访问抛 cordis 错误）时回退 ctx.get('subagents')，不中断门面装配", () => {
    const ctx = {
      tools: { register: () => () => undefined },
      get: (name: string) => (name === "subagents" ? { config: { maxActiveSubagents: { get: () => 20 } } } : undefined),
    } as unknown as DshHostContext;
    Object.defineProperty(ctx, "settings", {
      get() {
        throw new Error('cannot get property "settings" without inject');
      },
    });
    expect(runtimeProviderFromContext(ctx).read()).toEqual({ maxActiveSubagents: 20 });
  });

  it("runtimeProviderFromContext 兼容 SubagentManager.maxActiveSubagents 为函数", () => {
    const ctx: DshHostContext = {
      tools: { register: () => () => undefined },
      get: (name: string) => (name === "subagents" ? { manager: { maxActiveSubagents: () => 5 } } : undefined),
    };
    expect(runtimeProviderFromContext(ctx).read()).toEqual({ maxActiveSubagents: 5 });
  });

  it("runtimeProviderFromContext 非法/非正数 → 仍 fail-closed", () => {
    const ctx: DshHostContext = {
      tools: { register: () => () => undefined },
      get: (name: string) =>
        name === "subagents" ? { config: { maxActiveSubagents: { get: () => 0 } } } : undefined,
    };
    expect(() => runtimeProviderFromContext(ctx).read()).toThrow(/D-016 fail-closed/);
  });

  it("插件→真实门面：默认配置 disabled 时工具返回 policy.permission-denied（不假绿）", async () => {
    const tools: DshToolDefinition[] = [];
    apply(fakeContext(tools, { "subagent.maxActiveSubagents": 4 }), {
      __runtimeProvider: { read: () => ({ maxActiveSubagents: 4 }) },
    });
    const result = (await tools[0]?.execute({ backend: "codex", task: "hello" }, {})) as {
      ok: boolean;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("policy.permission-denied");
  });
});

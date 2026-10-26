/**
 * 场景装配件：配置工厂、DSH 宿主桩、门面 + 工具栈。
 *
 * 这里刻意走**真实的产品路径**：
 *   apply(ctx) 注册工具 → 模型调用 subagent_agent / mocl_status → 门面 → Broker。
 * 只有后端适配器被替换为离线假件（本套件不需要任何凭据/额度）。
 */
import { join } from "node:path";
import { MoclFacade, validateConfig } from "../../src/facade/index.ts";
import { apply } from "../../src/plugin/index.ts";
import { sleep } from "./util.mjs";

export const BACKENDS = ["codex", "claude-code", "kimi", "opencode"];

export function runtimeAt(capacity) {
  return { read: () => ({ maxActiveSubagents: capacity }) };
}

/** 可变的运行时（模拟用户在 DSH 设置页改并发上限）。 */
export class MutableRuntime {
  #capacity;
  constructor(capacity) {
    this.#capacity = capacity;
  }
  read() {
    return { maxActiveSubagents: this.#capacity };
  }
  set(capacity) {
    this.#capacity = capacity;
  }
}

/**
 * 生成「全局已启用 + 指定后端启用」的合法配置。
 * @param {{enabled?: string[], global?: object, backends?: Record<string, object>}} options
 */
export function configFor({ enabled = [], global = {}, backends = {} } = {}) {
  const backendOverrides = {};
  for (const backendId of BACKENDS) {
    backendOverrides[backendId] = {
      enabled: enabled.includes(backendId),
      ...(backends[backendId] ?? {}),
    };
  }
  return validateConfig({
    global: { enabled: true, ...global },
    backends: backendOverrides,
  });
}

/** 默认配置（global.enabled=false、四后端全关、read-only）。 */
export function defaultConfig() {
  return validateConfig({});
}

/**
 * 最小 DSH 宿主桩：`ctx.tools.register` + `ctx.get("subagents")`。
 * runtimeProviderFromContext 会依次尝试 settings/subagents 服务，这里给最真实的形状。
 */
export function createHost({ capacity = 4 } = {}) {
  const tools = new Map();
  const calls = [];
  let callSeq = 0;

  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) {
          throw new Error(`duplicate tool registration: ${definition.name}`);
        }
        tools.set(definition.name, definition);
        return definition;
      },
    },
    get(name) {
      if (name !== "subagents") return undefined;
      return {
        config: { maxActiveSubagents: { get: () => capacity } },
        manager: { maxActiveSubagents: () => capacity },
      };
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  };

  return {
    ctx,
    tools,
    calls,
    async callTool(name, args = {}) {
      const definition = tools.get(name);
      if (definition === undefined) throw new Error(`tool not registered: ${name}`);
      callSeq += 1;
      const result = await definition.execute(args, {
        toolCallId: `scenario-call-${callSeq}`,
        sessionId: "sess_parent_scenario",
      });
      calls.push({ name, args, result });
      return result;
    },
    toolNames() {
      return [...tools.keys()].sort();
    },
  };
}

/**
 * 建门面 + 注册工具的完整栈。
 * @param {{ctx: import("./harness.mjs").CaseContext, config: object, runtime: object, adapters: object, registryName?: string}} options
 */
export async function createStack({
  ctx,
  config,
  runtime,
  adapters,
  registryName = "sessions.json",
  stateDir = null,
}) {
  const facade = await MoclFacade.create({
    config,
    runtime,
    adapters,
    registryPath: join(stateDir ?? ctx.dir, registryName),
  });
  const host = createHost({ capacity: runtime.read().maxActiveSubagents });
  apply(host.ctx, { __facade: facade, __runtimeProvider: runtime });
  return { facade, host, adapters, config, runtime };
}

/** 等门面状态进入终态（running/created 之外）。 */
export async function waitForTerminal(facade, childId, { timeoutMs = 5_000, cursor = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await facade.status(childId, cursor);
  while (Date.now() < deadline) {
    if (last.state !== "running" && last.state !== "created") return last;
    await sleep(40);
    last = await facade.status(childId, cursor);
  }
  return last;
}

/** 等工具返回的 mocl_status 进入终态（模拟人类反复查询）。 */
export async function waitForToolTerminal(host, childId, { timeoutMs = 5_000, cursor = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const result = await host.callTool("mocl_status", { childId, cursor });
    if (result.ok !== true) {
      throw new Error(`mocl_status failed: ${JSON.stringify(result.error ?? result)}`);
    }
    last = result.status;
    if (last.state !== "running" && last.state !== "created") return last;
    await sleep(40);
  }
  return last;
}

/** 一次完整的人类派发：调工具 → 轮询到终态。 */
export async function delegateAndWait(host, args, options = {}) {
  const opened = await host.callTool("subagent_agent", args);
  if (opened.ok !== true) return { opened, status: null };
  const status = await waitForToolTerminal(host, opened.childId, options);
  return { opened, status };
}

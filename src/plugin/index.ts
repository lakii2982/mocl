/**
 * DSH Host 插件（C8）：薄壳。
 *
 * 导出宿主需要的模块形状（同 `@deepseek-ai/dsh-tool-subagent`）：
 * `export { name, inject, apply }`；`apply(ctx, config)` 做四件事：
 * 1. 校验宿主上下文（缺 `ctx.tools.register` → fail-closed，不静默降级）；
 * 2. 懒装配门面（`MoclFacade`，配置/运行时并发都在门面内校验）；
 * 3. 注册两个工具：`subagent_agent`（backend 枚举 = 四后端）与 `mocl_status`；
 * 4. 注册 `/mocl-panel` 面板数据路由（W2；best-effort，webServer 不可达只记日志，不影响工具）。
 *
 * 业务逻辑全部在门面（Broker + 适配器）；本文件不得重复路由/会话/幂等逻辑。
 * 宿主 API 基线 DSH 0.2.1-rc.3（见 `dsh-types.d.ts`，升级需复核）。
 */
import type { ErrorRef, PermissionProfile } from "../abi/types.ts";
import type { RuntimeConfigProvider } from "../broker/concurrency.ts";
import { MoclFacade, type OpenOutcome, type StatusOutcome, type ListOutcome, type CloseOutcome, type InterruptOutcome, type ResumeOutcome, type SendOutcome } from "../facade/facade.ts";
import { moclError, toErrorRef } from "../facade/errors.ts";
import { registerPanelRoute } from "./panel-route.ts";
import type {
  DshHostContext,
  DshJsonSchema,
  DshPluginConfig,
  DshToolDefinition,
  DshToolExec,
  UnknownArgs,
} from "./dsh-types.js";

export const name = "mocl";
export const inject = ["tools"] as const;

export const BACKEND_ENUM = ["codex", "claude-code", "kimi", "opencode"] as const;
export const PERMISSION_MODE_ENUM = ["read-only", "safe-auto", "yolo"] as const;
export const DEFAULT_MAX_DEPTH = "provider-managed" as const;

/** 门面中插件会用到的全部方法（测试可注入假门面）。 */
export interface MoclFacadeLike {
  open(backend: (typeof BACKEND_ENUM)[number], task: string, options?: unknown): Promise<OpenOutcome>;
  send(childId: string, message: string): Promise<SendOutcome>;
  status(childId: string, cursor?: number): Promise<StatusOutcome>;
  list(): Promise<ListOutcome>;
  resume(childId: string): Promise<ResumeOutcome>;
  interrupt(childId: string): Promise<InterruptOutcome>;
  close(childId: string): Promise<CloseOutcome>;
}

/** 插件选项：`config` 来自 patch 行；`__facade/__runtimeProvider/__journalDir` 仅测试注入。 */
export interface MoclPluginOptions extends DshPluginConfig {
  readonly __facade?: MoclFacadeLike;
  readonly __runtimeProvider?: RuntimeConfigProvider;
  /** W2：心跳落盘目录覆盖（缺省读 `facade.config.global.journal.dir`）。 */
  readonly __journalDir?: string;
}

const JSON_OUTPUT: DshJsonSchema = { type: "object" };

function renderJson(_args: UnknownArgs, value: unknown): readonly { type: "text"; text: string }[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/**
 * 宿主 dsh-tools 会对工具返回值做 lossless-JSON 快照校验：对象里只要出现
 * undefined / 函数 / 类实例，整次调用就变成 ToolOutputError
 * （"returned invalid output: value is not lossless JSON"），模型只能看到一条
 * 内部错误。ABI 的可选字段在实现中经常是 undefined，因此在工具边界统一做一次
 * JSON 归一化（等价 JSON.stringify → JSON.parse：丢弃 undefined、Date→字符串）。
 */
export function toLosslessJson<T>(value: T): T {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("value is not JSON-serializable");
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        code: "internal.unexpected",
        category: "internal",
        message,
        retryable: "no",
        userMessage: "兼容层内部错误，请联系维护者",
        severity: "error",
        sessionId: null,
        turnId: null,
        details: { kind: "internal.unexpected" },
      },
    } as unknown as T;
  }
}

/**
 * 从 Host 上下文读取 D-016 的运行时并发值；读不到 → fail-closed。
 *
 * DSH 0.2.1-rc.3 的真实形状（`@deepseek-ai/dsh-subagent` 的 Service，服务名 **subagents**，复数）：
 * - `ctx.get("subagents").config.maxActiveSubagents` 是 volatile 配置（有 `.get()`）；
 * - `SubagentManager.maxActiveSubagents` 是返回当前值的函数（manager 挂在服务上）。
 * 旧实现只查了不存在的单数服务名与 settings key，导致门面装配必然失败（工具全部返回 internal 错误）。
 */
export function runtimeProviderFromContext(ctx: DshHostContext): RuntimeConfigProvider {
  const readNumber = (value: unknown): number | undefined => {
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
    if (typeof value === "function") {
      try {
        return readNumber((value as () => unknown)());
      } catch {
        return undefined;
      }
    }
    if (typeof value === "object" && value !== null && typeof (value as { get?: unknown }).get === "function") {
      try {
        return readNumber((value as { get: () => unknown }).get());
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  return {
    read(): { maxActiveSubagents: number } {
      // cordis：未 inject 的 service 属性访问会抛 "cannot get property ... without inject"，
      // 因此 settings 分支必须 try/catch；拿不到就继续走 ctx.get()（该方法不受 inject 限制）。
      let settingsService: { get?: (key: string) => unknown } | undefined;
      try {
        settingsService = ctx.settings;
      } catch {
        settingsService = undefined;
      }
      if (settingsService === undefined) {
        try {
          settingsService = ctx.get?.("settings") as { get?: (key: string) => unknown } | undefined;
        } catch {
          settingsService = undefined;
        }
      }
      const fromSettings = readNumber(settingsService?.get?.("subagent.maxActiveSubagents"));
      if (fromSettings !== undefined) return { maxActiveSubagents: fromSettings };

      let service: unknown;
      try {
        service = ctx.get?.("subagents") ?? ctx.get?.("subagent");
      } catch {
        service = undefined;
      }
      if (typeof service === "object" && service !== null) {
        const record = service as Record<string, unknown>;
        const direct = readNumber(record["maxActiveSubagents"]);
        if (direct !== undefined) return { maxActiveSubagents: direct };
        const config = record["config"];
        if (typeof config === "object" && config !== null) {
          const viaConfig = readNumber((config as Record<string, unknown>)["maxActiveSubagents"]);
          if (viaConfig !== undefined) return { maxActiveSubagents: viaConfig };
        }
        const manager = record["manager"];
        if (typeof manager === "object" && manager !== null) {
          const viaManager = readNumber((manager as Record<string, unknown>)["maxActiveSubagents"]);
          if (viaManager !== undefined) return { maxActiveSubagents: viaManager };
        }
      }
      throw moclError("protocol.invalid-params", {
        message: "mocl: cannot read subagents.maxActiveSubagents from DSH host (D-016 fail-closed; not defaulting)",
      });
    },
  };
}

async function createFacade(ctx: DshHostContext, options: MoclPluginOptions): Promise<MoclFacadeLike> {
  if (options.__facade !== undefined) return options.__facade;
  return MoclFacade.create({
    configPath: options.configPath,
    configOverrides: options.configOverrides,
    runtime: options.__runtimeProvider ?? runtimeProviderFromContext(ctx),
  });
}

/** 参数校验：工具 schema 之外的第二道闸（宿主可能绕过 schema 调用）。 */
export function validateSubagentAgentArgs(args: unknown): {
  readonly backend: (typeof BACKEND_ENUM)[number];
  readonly task: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly permissionMode?: PermissionProfile;
  readonly maxDepth?: number | "provider-managed";
} {
  if (typeof args !== "object" || args === null) throw moclError("protocol.invalid-params", { message: "mocl: arguments must be an object" });
  const record = args as Record<string, unknown>;
  const backend = record["backend"];
  if (typeof backend !== "string" || !(BACKEND_ENUM as readonly string[]).includes(backend)) {
    throw moclError("protocol.invalid-params", { message: `mocl: backend must be one of ${BACKEND_ENUM.join(", ")}` });
  }
  const task = record["task"];
  if (typeof task !== "string" || task.trim().length === 0) throw moclError("protocol.invalid-params", { message: "mocl: task must be a non-empty string" });
  const out: {
    backend: (typeof BACKEND_ENUM)[number];
    task: string;
    cwd?: string;
    model?: string;
    permissionMode?: PermissionProfile;
    maxDepth?: number | "provider-managed";
  } = { backend: backend as (typeof BACKEND_ENUM)[number], task };
  if (record["cwd"] !== undefined) {
    if (typeof record["cwd"] !== "string") throw moclError("protocol.invalid-params", { message: "mocl: cwd must be a string" });
    out.cwd = record["cwd"];
  }
  if (record["model"] !== undefined) {
    if (typeof record["model"] !== "string") throw moclError("protocol.invalid-params", { message: "mocl: model must be a string" });
    out.model = record["model"];
  }
  if (record["permissionMode"] !== undefined) {
    const mode = record["permissionMode"];
    if (typeof mode !== "string" || !(PERMISSION_MODE_ENUM as readonly string[]).includes(mode)) {
      throw moclError("protocol.invalid-params", { message: `mocl: permissionMode must be one of ${PERMISSION_MODE_ENUM.join(", ")}` });
    }
    out.permissionMode = mode as PermissionProfile;
  }
  if (record["maxDepth"] !== undefined) {
    const depth = record["maxDepth"];
    if (depth === DEFAULT_MAX_DEPTH) {
      out.maxDepth = DEFAULT_MAX_DEPTH;
    } else if (typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 1) {
      out.maxDepth = depth;
    } else {
      throw moclError("protocol.invalid-params", { message: 'mocl: maxDepth must be "provider-managed" or a positive integer' });
    }
  }
  return out;
}

/** `subagent_agent` 工具定义（纯对象；不依赖宿主包，便于测试注入）。 */
export function createSubagentAgentTool(facade: MoclFacadeLike | Promise<MoclFacadeLike>): DshToolDefinition {
  const ready = Promise.resolve(facade);
  return {
    name: "subagent_agent",
    description:
      "在指定外部编码后端上启动一个可编排子代理并执行任务。backend 必须是 codex|claude-code|kimi|opencode 之一；" +
      "任务结束后返回 childId 与远端会话 id（无 id 时 remoteIdState=pending）。默认只读、最小权限；" +
      "maxDepth 默认 provider-managed（由 DSH seam 管理）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        backend: {
          type: "string",
          enum: [...BACKEND_ENUM],
          description: "外部编码后端",
        },
        task: { type: "string", minLength: 1, description: "交给子代理的完整任务说明（自包含）" },
        cwd: { type: "string", description: "子代理工作目录（绝对路径；缺省为当前会话目录）" },
        model: { type: "string", description: "覆盖后端模型（缺省用配置）" },
        permissionMode: { type: "string", enum: [...PERMISSION_MODE_ENUM], description: "权限档（默认 read-only）" },
        maxDepth: {
          description: "嵌套深度；默认 provider-managed（数值会被 seam 拒绝）",
          oneOf: [{ type: "integer", minimum: 1, maximum: 3 }, { const: "provider-managed" }],
        },
      },
      required: ["backend", "task"],
    },
    output: { schema: JSON_OUTPUT, render: renderJson },
    async execute(args: UnknownArgs, _exec: DshToolExec): Promise<unknown> {
      try {
        const validated = validateSubagentAgentArgs(args);
        const instance = await ready;
        const result = await instance.open(validated.backend, validated.task, {
          ...(validated.cwd === undefined ? {} : { cwd: validated.cwd }),
          ...(validated.model === undefined ? {} : { model: validated.model }),
          ...(validated.permissionMode === undefined ? {} : { permissionMode: validated.permissionMode }),
          ...(validated.maxDepth === undefined ? {} : { maxDepth: validated.maxDepth }),
        });
        return toLosslessJson({ ok: true, ...result });
      } catch (error) {
        return toLosslessJson({ ok: false, error: toErrorRef(error) satisfies ErrorRef });
      }
    },
  };
}

/** `mocl_status` 工具定义。 */
export function createMoclStatusTool(facade: MoclFacadeLike | Promise<MoclFacadeLike>): DshToolDefinition {
  const ready = Promise.resolve(facade);
  return {
    name: "mocl_status",
    description:
      "查询 MOCL 子代理状态：不传 childId 返回全部子会话；传 childId 返回单会话状态（含 remoteIdState、" +
      "epoch、最近 turn、cursor）。事件流增量由后续切片接入，当前 cursor 只回显。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        childId: { type: "string", description: "子会话 id（缺省列出全部）" },
        cursor: { type: "integer", minimum: 0, description: "事件增量起点（seq，当前只回显）" },
      },
      required: [],
    },
    output: { schema: JSON_OUTPUT, render: renderJson },
    async execute(args: UnknownArgs, _exec: DshToolExec): Promise<unknown> {
      try {
        const instance = await ready;
        const childId = args["childId"];
        if (childId !== undefined && typeof childId !== "string") {
          throw moclError("protocol.invalid-params", { message: "mocl: childId must be a string" });
        }
        const cursor = args["cursor"];
        if (cursor !== undefined && (!Number.isSafeInteger(cursor) || (cursor as number) < 0)) {
          throw moclError("protocol.invalid-params", { message: "mocl: cursor must be a non-negative integer" });
        }
        if (typeof childId === "string" && childId.length > 0) {
          const status = await instance.status(childId, cursor === undefined ? 0 : (cursor as number));
          return toLosslessJson({ ok: true, status });
        }
        const list = await instance.list();
        return toLosslessJson({ ok: true, ...list });
      } catch (error) {
        return toLosslessJson({ ok: false, error: toErrorRef(error) satisfies ErrorRef });
      }
    },
  };
}

/** 宿主插件入口：同步注册两个工具；门面装配失败由工具执行时以 ABI 错误返回。 */
export function apply(ctx: DshHostContext, options: MoclPluginOptions = {}): void {
  if (ctx === null || ctx === undefined || typeof ctx.tools?.register !== "function") {
    throw moclError("protocol.invalid-params", { message: "mocl: host context missing ctx.tools.register (fail-closed)" });
  }
  const ready = createFacade(ctx, options);
  ready.catch((error: unknown) => {
    ctx.logger?.error?.(`mocl: facade initialization failed: ${String((error as Error)?.message ?? error)}`);
  });
  ctx.tools.register(createSubagentAgentTool(ready));
  ctx.tools.register(createMoclStatusTool(ready));

  // W2：/mocl-panel 数据路由（只读门面复用同一个 ready Promise，不新建门面）。
  // best-effort：webServer 解析/注册失败只记日志并跳过，不拖垮上方工具。
  registerPanelRoute(ctx, {
    facade: ready,
    ...(options.__journalDir === undefined ? {} : { journalDir: options.__journalDir }),
    ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
  });
}

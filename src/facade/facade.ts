/**
 * MOCL 门面（C8）：把 Broker + 四后端适配器组装成 DSH 可控的稳定 API。
 *
 * 面向插件的唯一入口；插件**不得**绕过本文件直接调 Broker/适配器。
 * 所有失败统一抛 `MoclError`（ABI §8 错误码）；插件用 `toErrorRef()` 投影给模型/父会话。
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { BackendAdapter } from "../abi/adapter.ts";
import type { AdapterEvent } from "../abi/adapter.ts";
import type { BackendId, ErrorRef, InputBlock, MoclEvent, PermissionProfile, SessionState, UsageRef } from "../abi/types.ts";
import { Broker } from "../broker/broker.ts";
import { EventBus } from "../bus/event-bus.ts";
import { SessionRegistry, type SessionRecord } from "../broker/session-registry.ts";
import type { RuntimeConfigProvider } from "../broker/concurrency.ts";
import { moclError } from "../broker/errors.ts";
import {
  BACKEND_IDS,
  ConfigError,
  configDigest,
  enabledBackends,
  loadFacadeConfig,
  validateConfig,
  type ConfigBackendId,
  type FacadeConfig,
} from "./config.ts";
import { createBackendAdapter } from "./adapters.ts";
import { asMoclError } from "./errors.ts";

export type RemoteIdState = "pending" | "bound";

export interface BackendRefInput {
  readonly backend: ConfigBackendId;
  readonly model?: string | null;
  readonly permissionMode?: PermissionProfile;
  readonly maxDepth?: number | "provider-managed";
}

export interface OpenOptions {
  readonly cwd?: string;
  readonly model?: string | null;
  readonly permissionMode?: PermissionProfile;
  readonly maxDepth?: number | "provider-managed";
  readonly idempotencyKey?: string;
}

export interface OpenOutcome {
  readonly childId: string;
  readonly backend: ConfigBackendId;
  readonly backendSessionId: string | null;
  readonly remoteIdState: RemoteIdState;
  readonly epoch: number;
  readonly state: SessionState;
  readonly turnId: string;
  readonly deduplicated: boolean;
}

export interface SendOutcome {
  readonly childId: string;
  readonly turnId: string;
  readonly state: SessionState;
  readonly deduplicated: boolean;
}

export interface StatusOutcome {
  readonly childId: string;
  readonly backend: ConfigBackendId;
  readonly backendSessionId: string | null;
  readonly remoteIdState: RemoteIdState;
  readonly state: SessionState;
  readonly epoch: number;
  readonly createdAt: string;
  readonly lastTurnId: string | null;
  readonly active: boolean;
  readonly cursor: {
    readonly fromSeq: number;
    readonly lastSeq: number | null;
    readonly events: number;
    readonly total: number;
    readonly note: string;
  };
  readonly usage: UsageRef | null;
  readonly degraded: boolean;
  readonly parentDeliveries: number;
  readonly lastEventType: string | null;
  readonly warnings: readonly string[];
  readonly error: ErrorRef | null;
  readonly progress: {
    readonly mode: "off" | "summary";
    readonly maxItemsPerTurn: number;
    readonly maxCharsPerTurn: number;
    readonly maxCharsPerItem: number;
  };
  readonly configDigest: string;
  /** W1（issue #18）：任务摘要（open(task) 首行规范化；空/缺失 → "(未命名任务)"）。 */
  readonly label: string;
  /** W1：运行时身份与模型投影（数据面单一真相，面板只读、不自算）。 */
  readonly runtime: RuntimeStatus;
  /** W1：创建时间（= SessionRecord.createdAt）。 */
  readonly startedAt: string | null;
  /** W1：最近事件时间（无事件 = createdAt）。 */
  readonly lastActivityAt: string | null;
  /** W1：本次快照时间。 */
  readonly updatedAt: string | null;
}

/** W1：`runtime.model` 的来源语义。 */
export type ModelSource = "reported" | "configured" | "fallback" | "unknown";

/**
 * W1：实际运行时身份与模型。全部字段必须存在（拿不到写 `null`，不允许
 * undefined——宿主 lossless-JSON 会整调用失败）。
 */
export interface RuntimeStatus {
  /** 后端原生 agent 名（既有 facade/registry/broker 状态暂无此真相源 → null）。 */
  readonly agentName: string | null;
  /** 后端原生会话/线程 id（= backendSessionId；pending 时 null）。 */
  readonly agentId: string | null;
  /** 握手 CapabilityDeclaration.backendVersion（SessionRecord.handshake 缓存；无 → null）。 */
  readonly backendVersion: string | null;
  /** 握手 CapabilityDeclaration.transport（同上）。 */
  readonly transport: string | null;
  /** 实际生效模型（优先后端上报，其次 fallback/配置，末位 null）。 */
  readonly model: string | null;
  readonly modelSource: ModelSource;
}

export interface ListOutcome {
  readonly children: readonly StatusOutcome[];
}

export interface ResumeOutcome {
  readonly childId: string;
  readonly backendSessionId: string | null;
  readonly remoteIdState: RemoteIdState;
  readonly strategy: "resume" | "reseed";
  readonly epoch: number;
  readonly degraded: boolean;
}

export interface InterruptOutcome {
  readonly childId: string;
  readonly interrupted: true;
}

export interface CloseOutcome {
  readonly childId: string;
  readonly closed: true;
}

export interface FacadeOptions {
  /** 省略时从 `configPath` / `MOCL_CONFIG` / `config.default.json` 加载。 */
  readonly config?: FacadeConfig;
  readonly configPath?: string;
  readonly configOverrides?: unknown;
  /** D-016：唯一并发来源（缺省/非法/读取失败 → 构造即 fail-closed）。 */
  readonly runtime: RuntimeConfigProvider;
  /** 测试注入：覆盖某个后端的真实适配器（不得在生产用）。 */
  readonly adapters?: Partial<Record<BackendId, BackendAdapter>>;
  /** 会话注册表路径（默认 `<global.journal.dir>/sessions.json`）。 */
  readonly registryPath?: string;
  readonly clock?: () => Date;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** W1：任务摘要截断上限（UTF-16 code unit 数）。 */
export const TASK_LABEL_MAX_CHARS = 120;

/** W1：空/缺失任务摘要的占位（`label` 类型固定 string，不是 null）。 */
export const UNNAMED_TASK_LABEL = "(未命名任务)";

/** W1：模型降级类 warning 的 code 前缀（既有唯一实例：opencode D-019 `model.free-fallback`）。 */
const MODEL_FALLBACK_CODE_PREFIX = "model.";

/** UTF-16 安全截断：截断点落在代理对中间时丢弃高代理，不把 emoji 切成半。 */
function truncateUtf16Safe(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const lastUnit = text.charCodeAt(end - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** open(task) → 面板任务摘要：首个非空行、trim、≤120 字符（代理对安全）；空 → "(未命名任务)"。 */
export function normalizeTaskLabel(task: string): string {
  if (typeof task !== "string") return UNNAMED_TASK_LABEL;
  const firstNonEmptyLine = task.split(/\r\n|\r|\n/).find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstNonEmptyLine.trim();
  if (trimmed.length === 0) return UNNAMED_TASK_LABEL;
  return truncateUtf16Safe(trimmed, TASK_LABEL_MAX_CHARS);
}

function newClientRequestId(): string {
  return `mocl-${randomUUID()}`;
}

function idStateOf(remoteSessionId: string | null | undefined): RemoteIdState {
  return remoteSessionId === null || remoteSessionId === undefined || remoteSessionId === "" ? "pending" : "bound";
}

export class MoclFacade {
  readonly #config: FacadeConfig;
  readonly #runtime: RuntimeConfigProvider;
  readonly #broker: Broker;
  readonly #adapters = new Map<ConfigBackendId, BackendAdapter>();
  readonly #registryPath: string;
  readonly #clock: () => Date;
  readonly #bus: EventBus;
  readonly #consumers = new Map<string, { running: boolean }>();
  readonly #terminal = new Map<string, SessionState>();
  readonly #degraded = new Set<string>();
  readonly #usage = new Map<string, UsageRef>();
  readonly #seq = new Map<string, number>();
  readonly #lastEventType = new Map<string, string>();
  readonly #warnings = new Map<string, string[]>();
  readonly #terminalError = new Map<string, ErrorRef>();
  // W1（issue #18）：数据面派生缓存（真相源仍是 registry/broker/事件流，这里只投影）。
  readonly #lastActivityAt = new Map<string, string>();
  readonly #reportedModel = new Map<string, string>();
  readonly #modelFallback = new Set<string>();

  private constructor(options: FacadeOptions, config: FacadeConfig, adapters: Map<ConfigBackendId, BackendAdapter>) {
    this.#config = config;
    this.#runtime = options.runtime;
    this.#adapters = adapters;
    this.#registryPath = options.registryPath ?? resolve(process.cwd(), config.global.journal.dir, "sessions.json");
    this.#clock = options.clock ?? (() => new Date());
    this.#assertRuntimeCapacity();
    this.#broker = new Broker({
      runtime: options.runtime,
      adapters: [...adapters.values()],
      registry: new SessionRegistry({ path: this.#registryPath }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    this.#bus = new EventBus({
      foldWindowMs: config.global.progress.samplingWindowMs,
      parentProgress: {
        mode: config.global.progress.mode,
        maxItemsPerTurn: config.global.progress.maxItemsPerTurn,
        maxCharsPerTurn: config.global.progress.maxCharsPerTurn,
        maxCharsPerItem: config.global.progress.maxCharsPerItem,
      },
      clock: () => this.#clock().getTime(),
    });
  }

  #assertRuntimeCapacity(): void {
    const snapshot = this.#runtime.read();
    const runtimeMax = snapshot.maxActiveSubagents;
    const requested: Array<[string, number | "runtime"]> = [
      ["global.maxConcurrent", this.#config.global.maxConcurrent],
      ...BACKEND_IDS.map((id) => [`backends.${id}.maxConcurrent`, this.#config.backends[id].maxConcurrent] as [string, number | "runtime"]),
    ];
    for (const [path, value] of requested) {
      if (value !== "runtime" && value > runtimeMax) {
        throw new ConfigError([`${path}=${value} exceeds runtime maxActiveSubagents=${runtimeMax} (D-016 fail-closed)`]);
      }
    }
  }

  /** 异步装配：加载/校验配置 + 构造启用后端的适配器。 */
  static async create(options: FacadeOptions): Promise<MoclFacade> {
    if (options.runtime === undefined || options.runtime === null || typeof options.runtime.read !== "function") {
      throw new ConfigError(["runtime provider is required (D-016 fail-closed)"]);
    }
    let config: FacadeConfig;
    try {
      config = options.config ?? (await loadFacadeConfig(options.configPath, options.configOverrides));
    } catch (error) {
      throw asMoclError(error);
    }
    if (options.config !== undefined && options.configOverrides !== undefined) {
      config = validateConfig(options.configOverrides);
    }
    const adapters = new Map<ConfigBackendId, BackendAdapter>();
    for (const backendId of enabledBackends(config)) {
      const injected = options.adapters?.[backendId];
      adapters.set(
        backendId,
        injected ?? createBackendAdapter(backendId, config.backends[backendId], options.runtime),
      );
    }
    return new MoclFacade(options, config, adapters);
  }

  get config(): FacadeConfig {
    return this.#config;
  }

  get enabledBackendIds(): readonly ConfigBackendId[] {
    return enabledBackends(this.#config);
  }

  #normalizeBackend(backendRef: ConfigBackendId | BackendRefInput): { backend: ConfigBackendId; ref: BackendRefInput } {
    const ref: BackendRefInput = typeof backendRef === "string" ? { backend: backendRef } : backendRef;
    if (!BACKEND_IDS.includes(ref.backend)) {
      throw moclError("protocol.invalid-params", { message: `unknown backend: ${String(ref.backend)}` });
    }
    return { backend: ref.backend, ref };
  }

  #requireGlobalEnabled(): void {
    if (!this.#config.global.enabled) {
      throw moclError("policy.permission-denied", { message: "MOCL is disabled (global.enabled=false, fail-closed default)" });
    }
  }

  #requireBackendEnabled(backend: ConfigBackendId): void {
    if (!this.#config.backends[backend].enabled) {
      throw moclError("policy.permission-denied", { message: `backend "${backend}" is disabled by config` });
    }
    if (!this.#adapters.has(backend)) {
      throw moclError("capability.missing", { message: `backend "${backend}" enabled but no adapter registered` });
    }
  }

  #resolvePermissionMode(backend: ConfigBackendId, requested?: PermissionProfile): PermissionProfile {
    const backendConfig = this.#config.backends[backend];
    const mode = requested ?? backendConfig.permissionMode;
    if (!["read-only", "safe-auto", "yolo"].includes(mode)) {
      throw moclError("protocol.invalid-params", { message: `invalid permissionMode: ${String(mode)}` });
    }
    if (mode === "read-only") return mode;
    if (!this.#config.global.dangerousModes.allowed) {
      throw moclError("policy.escalation-required", {
        message: `permissionMode=${mode} requires global.dangerousModes.allowed=true`,
      });
    }
    if (!backendConfig.allowDangerousModes) {
      throw moclError("policy.escalation-required", {
        message: `permissionMode=${mode} requires backends.${backend}.allowDangerousModes=true`,
      });
    }
    // D-021：kimi CLI 通道无法按调用方切换权限档（`-p` 与模式旗标互斥）→ fail-closed。
    if (backend === "kimi" && backendConfig.channel === "cli" && mode !== backendConfig.permissionMode) {
      throw moclError("policy.escalation-required", {
        message: "kimi CLI channel cannot switch permission mode per call (D-021 fail-closed)",
        details: { kind: "policy.escalation-required", hint: `configured=${backendConfig.permissionMode}, requested=${mode}` },
      });
    }
    return mode;
  }

  #resolveModel(backend: ConfigBackendId, requested?: string | null): string | null {
    const model = requested === undefined ? this.#config.backends[backend].model : requested;
    if (model !== null && (typeof model !== "string" || model.length === 0)) {
      throw moclError("protocol.invalid-params", { message: "model must be a non-empty string or null" });
    }
    return model;
  }

  #resolveDepth(backend: ConfigBackendId, requested?: number | "provider-managed"): number | "provider-managed" {
    const maxDepth = requested ?? "provider-managed";
    if (maxDepth === "provider-managed") return maxDepth;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
      throw moclError("protocol.invalid-params", { message: "maxDepth must be \"provider-managed\" or a positive integer" });
    }
    const allowed = Math.min(this.#config.global.maxDepth, this.#config.backends[backend].maxDepth);
    if (maxDepth > allowed) {
      throw moclError("limit.nesting-exceeded", { message: `maxDepth=${maxDepth} exceeds allowed ${allowed}` });
    }
    return maxDepth;
  }

  /** 建会话并发首轮。 */
  async open(backendRef: ConfigBackendId | BackendRefInput, task: string, options: OpenOptions = {}): Promise<OpenOutcome> {
    return this.#guard(async () => {
      this.#requireGlobalEnabled();
      const { backend, ref } = this.#normalizeBackend(backendRef);
      this.#requireBackendEnabled(backend);
      if (typeof task !== "string" || task.trim().length === 0) {
        throw moclError("protocol.invalid-params", { message: "task must be a non-empty string" });
      }
      const cwd = options.cwd ?? process.cwd();
      if (!isAbsolute(cwd)) throw moclError("protocol.invalid-params", { message: `cwd must be absolute: ${cwd}` });
      const permissionMode = this.#resolvePermissionMode(backend, options.permissionMode ?? ref.permissionMode);
      const model = this.#resolveModel(backend, options.model ?? ref.model);
      this.#resolveDepth(backend, options.maxDepth ?? ref.maxDepth);
      const idempotencyKey = options.idempotencyKey ?? newClientRequestId();

      const opened = await this.#broker.open({
        backend,
        cwd,
        model,
        permissionProfile: permissionMode,
        // W1：任务摘要随 open 落盘进 SessionRecord（恢复后仍可读）。
        label: normalizeTaskLabel(task),
        idempotencyKey: `${idempotencyKey}:open`,
      });
      const adapter = this.#adapters.get(backend);
      try {
        const sent = await this.#broker.send(opened.sessionId, {
          input: [{ type: "text", text: task } satisfies InputBlock],
          idempotencyKey: `${idempotencyKey}:send`,
        });
        if (adapter !== undefined) this.#startEventStream(opened.sessionId, backend, adapter, opened.epoch);
        const backfilled = await this.#maybeBackfillRemoteId(opened.sessionId);
        return {
          childId: opened.sessionId,
          backend,
          backendSessionId: backfilled,
          remoteIdState: idStateOf(backfilled),
          epoch: opened.epoch,
          state: sent.state,
          turnId: sent.turnId,
          deduplicated: opened.deduplicated || sent.deduplicated,
        };
      } catch (error) {
        // 首轮失败：释放会话槽位，不留下半开状态。
        this.#stopEventStream(opened.sessionId);
        try {
          await this.#broker.close(opened.sessionId, "failed");
        } catch {
          // ignore cleanup failure; original error wins
        }
        throw error;
      }
    });
  }

  async send(childId: string, message: string, options: { idempotencyKey?: string } = {}): Promise<SendOutcome> {
    return this.#guard(async () => {
      this.#requireGlobalEnabled();
      if (typeof message !== "string" || message.length === 0) {
        throw moclError("protocol.invalid-params", { message: "message must be a non-empty string" });
      }
      const sent = await this.#broker.send(childId, {
        input: [{ type: "text", text: message } satisfies InputBlock],
        idempotencyKey: options.idempotencyKey ?? newClientRequestId(),
      });
      const status = await this.#broker.status(childId);
      const backend = status.backend as ConfigBackendId;
      const adapter = this.#adapters.get(backend);
      if (adapter !== undefined) this.#startEventStream(childId, backend, adapter, status.epoch);
      return { childId, turnId: sent.turnId, state: this.#terminal.get(childId) ?? sent.state, deduplicated: sent.deduplicated };
    });
  }

  async status(childId: string, cursor = 0): Promise<StatusOutcome> {
    return this.#guard(async () => {
      this.#requireGlobalEnabled();
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw moclError("protocol.invalid-params", { message: "cursor must be a non-negative integer" });
      }
      const status = await this.#broker.status(childId);
      return this.#statusOutcome(status, cursor);
    });
  }

  async list(): Promise<ListOutcome> {
    return this.#guard(async () => {
      this.#requireGlobalEnabled();
      const sessions = await this.#broker.list();
      return { children: sessions.map((session) => this.#statusOutcome(session, 0)) };
    });
  }

  /** 续接：registry → 远端探测 → 降级由 Broker 决定；门面只做状态投影（D-020 容忍空 id）。 */
  async resume(childId: string): Promise<ResumeOutcome> {
    return this.#guard(async () => {
      this.#requireGlobalEnabled();
      const resumed = await this.#broker.resume(childId, { idempotencyKey: newClientRequestId() });
      let backendSessionId = resumed.backendSessionId === "" ? null : resumed.backendSessionId;
      if (backendSessionId !== null) {
        try {
          await this.#broker.registry.backfillRemoteId(childId, backendSessionId);
        } catch {
          // 已 bound 且一致（幂等）或冲突都保持 registry 现状；状态读取以 registry 为准。
        }
      }
      const status = await this.#broker.status(childId);
      const backend = status.backend as ConfigBackendId;
      const adapter = this.#adapters.get(backend);
      if (adapter !== undefined) this.#startEventStream(childId, backend, adapter, resumed.epoch);
      backendSessionId = status.backendSessionId === "" ? null : status.backendSessionId;
      return {
        childId,
        backendSessionId,
        remoteIdState: idStateOf(backendSessionId),
        strategy: resumed.strategy,
        epoch: resumed.epoch,
        degraded: resumed.degraded,
      };
    });
  }

  async interrupt(childId: string): Promise<InterruptOutcome> {
    return this.#guard(async () => {
      this.#requireGlobalEnabled();
      await this.#broker.interrupt(childId);
      return { childId, interrupted: true };
    });
  }

  async close(childId: string): Promise<CloseOutcome> {
    return this.#guard(async () => {
      this.#requireGlobalEnabled();
      this.#stopEventStream(childId);
      await this.#broker.close(childId, "operator");
      return { childId, closed: true };
    });
  }

  #statusOutcome(
    status: {
      sessionId: string;
      backend: BackendId;
      backendSessionId: string;
      model: string | null;
      state: SessionState;
      epoch: number;
      createdAt: string;
      lastTurnId: string | null;
      active: boolean;
    },
    fromSeq: number,
  ): StatusOutcome {
    const snapshot = this.#bus.snapshot(status.sessionId, fromSeq);
    const busStats = this.#bus.stats(status.sessionId);
    const backendSessionId = status.backendSessionId === "" ? null : status.backendSessionId;
    const terminal = this.#terminal.get(status.sessionId);
    const record = this.#broker.registry.get(status.sessionId);
    return {
      childId: status.sessionId,
      backend: status.backend as ConfigBackendId,
      backendSessionId,
      remoteIdState: idStateOf(backendSessionId),
      state: terminal ?? status.state,
      epoch: status.epoch,
      createdAt: status.createdAt,
      lastTurnId: status.lastTurnId,
      active: status.active,
      cursor: {
        fromSeq,
        lastSeq: snapshot.lastSeq === 0 ? null : snapshot.lastSeq,
        events: snapshot.events.length,
        total: busStats.ingested,
        note: "event stream wired from adapter.events() → EventBus (C9)",
      },
      usage: this.#usage.get(status.sessionId) ?? null,
      degraded: this.#degraded.has(status.sessionId),
      parentDeliveries: busStats.parentDeliveryCount,
      lastEventType: this.#lastEventType.get(status.sessionId) ?? null,
      warnings: this.#warnings.get(status.sessionId) ?? [],
      error: this.#terminalError.get(status.sessionId) ?? null,
      progress: {
        mode: this.#config.global.progress.mode,
        maxItemsPerTurn: this.#config.global.progress.maxItemsPerTurn,
        maxCharsPerTurn: this.#config.global.progress.maxCharsPerTurn,
        maxCharsPerItem: this.#config.global.progress.maxCharsPerItem,
      },
      configDigest: configDigest(this.#config),
      label: normalizeTaskLabel(record?.label ?? ""),
      runtime: this.#runtimeStatus(status.sessionId, status.backend, backendSessionId, status.model, record),
      startedAt: status.createdAt,
      lastActivityAt: this.#lastActivityAt.get(status.sessionId) ?? status.createdAt,
      updatedAt: this.#clock().toISOString(),
    };
  }

  /**
   * W1：runtime 投影。`modelSource` 优先级（§1.2 决策表，四情形互斥）：
   * ① 最近一次 `turn.started.model` 非空 → `reported`；② 发生过模型降级
   * （`model.*` degrade warning，D-019 `model.free-fallback`）→ `fallback`
   * （生效模型 = `fallbackModel`，不能谎报为生产配置模型）；③ 配置模型
   * （会话打开时的 model，其次 `backends.<id>.model`）非空 → `configured`；
   * ④ 否则 `unknown`。`agentName` 暂无既有真相源 → null（不猜）。
   */
  #runtimeStatus(
    childId: string,
    backend: BackendId,
    agentId: string | null,
    sessionModel: string | null,
    record: SessionRecord | undefined,
  ): RuntimeStatus {
    const backendConfig = this.#config.backends[backend as ConfigBackendId];
    const reported = this.#reportedModel.get(childId) ?? null;
    const configured = sessionModel ?? backendConfig.model ?? null;
    let model: string | null = null;
    let modelSource: ModelSource = "unknown";
    if (reported !== null) {
      model = reported;
      modelSource = "reported";
    } else if (this.#modelFallback.has(childId)) {
      model = backendConfig.fallbackModel ?? null;
      modelSource = "fallback";
    } else if (configured !== null) {
      model = configured;
      modelSource = "configured";
    }
    const handshake = record?.handshake;
    return {
      agentName: null,
      agentId,
      backendVersion: handshake?.backendVersion ?? null,
      transport: handshake?.transport ?? null,
      model,
      modelSource,
    };
  }

  /** 适配器事件 → ABI 事件信封 → EventBus（单写者 seq；终态后停流）。 */
  #startEventStream(childId: string, backend: ConfigBackendId, adapter: BackendAdapter, epoch: number): void {
    const existing = this.#consumers.get(childId);
    if (existing !== undefined && existing.running) return;
    const controller = { running: true };
    this.#consumers.set(childId, controller);
    void (async () => {
      try {
        for await (const event of adapter.events()) {
          if (!controller.running) break;
          this.#ingestAdapterEvent(childId, backend, adapter, epoch, event);
          if (isTerminalEventType(event.type)) {
            this.#stopEventStream(childId);
            break;
          }
        }
      } catch {
        // 事件流异常/结束：不影响控制面；status 仍可由后续 status/send 刷新。
      } finally {
        if (this.#consumers.get(childId) === controller) controller.running = false;
      }
    })();
  }

  #ingestAdapterEvent(
    childId: string,
    backend: ConfigBackendId,
    adapter: BackendAdapter,
    epoch: number,
    event: AdapterEvent,
  ): void {
    const seq = (this.#seq.get(childId) ?? 0) + 1;
    this.#seq.set(childId, seq);
    const envelope = {
      abiVersion: "0.1",
      eventId: randomUUID(),
      sessionId: childId,
      seq,
      epoch,
      ts: this.#clock().toISOString(),
      type: event.type,
      backend: { id: backend, version: adapter.capabilities.backendVersion },
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      payload: event.payload,
    } as unknown as MoclEvent;
    this.#bus.ingest(envelope);
    this.#lastEventType.set(childId, event.type);
    // W1：每次事件刷新最近活动时间（不改折叠语义；无事件时投影回退 createdAt）。
    this.#lastActivityAt.set(childId, envelope.ts);
    if (event.type === "session.warning") {
      const payload = event.payload as { readonly code?: string; readonly degrade?: boolean };
      if (payload?.degrade === true) this.#degraded.add(childId);
      if (typeof payload?.code === "string") {
        const warnings = this.#warnings.get(childId) ?? [];
        warnings.push(payload.code);
        this.#warnings.set(childId, warnings);
        // W1：`model.*` 降级 warning（如 D-019 `model.free-fallback`）→ fallback 生效。
        if (payload.code.startsWith(MODEL_FALLBACK_CODE_PREFIX)) this.#modelFallback.add(childId);
      }
    }
    if (event.type === "turn.started") {
      const payload = event.payload as { readonly model?: unknown };
      if (typeof payload?.model === "string" && payload.model.length > 0) this.#reportedModel.set(childId, payload.model);
    }
    if (event.type === "usage.updated") {
      const payload = event.payload as { readonly usage?: UsageRef };
      if (payload?.usage !== undefined) this.#usage.set(childId, payload.usage);
    }
    if (event.type === "turn.completed") {
      const payload = event.payload as { readonly usage?: UsageRef };
      if (payload?.usage !== undefined) this.#usage.set(childId, payload.usage);
    }
    if (event.type === "turn.failed") {
      const payload = event.payload as { readonly error?: ErrorRef };
      if (payload?.error !== undefined) this.#terminalError.set(childId, payload.error);
    }
    if (isTerminalEventType(event.type)) this.#terminal.set(childId, terminalStateOf(event.type));
  }

  #stopEventStream(childId: string): void {
    const controller = this.#consumers.get(childId);
    if (controller !== undefined) controller.running = false;
    this.#consumers.delete(childId);
    this.#bus.flush(childId);
  }

  /**
   * D-020：kimi CLI 首轮后才有远端 id。只读探测适配器当前状态，
   * 有值则**持久化回填**到 SessionRegistry（不再使用内存 overlay）。
   */
  async #maybeBackfillRemoteId(childId: string): Promise<string | null> {
    await this.#broker.status(childId); // 确保 registry 已 load
    const record = this.#broker.registry.get(childId);
    if (record === undefined) return null;
    if (record.remoteSessionId !== "") return record.remoteSessionId;
    const adapter = this.#adapters.get(record.backend as ConfigBackendId);
    if (adapter === undefined) return null;
    try {
      const probe = await adapter.resume({ sessionId: childId, remoteSessionId: "", fromSeq: 0 });
      if (probe.exists && typeof probe.remoteSessionId === "string" && probe.remoteSessionId.length > 0) {
        const updated = await this.#broker.registry.backfillRemoteId(childId, probe.remoteSessionId);
        return updated.remoteSessionId;
      }
    } catch {
      // 探测失败保持 pending（不伪造 bound）
    }
    return null;
  }

  /** 对外统一包装：MoclError 透传，其余异常 → `internal.unexpected`。 */
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw asMoclError(error);
    }
  }
}

function isTerminalEventType(type: string): boolean {
  return type === "turn.completed" || type === "turn.failed" || type === "turn.aborted" || type === "session.closed" || type === "session.archived";
}

function terminalStateOf(type: string): SessionState {
  switch (type) {
    case "turn.completed":
      return "completed";
    case "session.closed":
      return "completed";
    case "session.archived":
      return "archived";
    default:
      return "aborted";
  }
}

export function errorRefOf(error: unknown): ErrorRef {
  return asMoclError(error).toErrorRef();
}

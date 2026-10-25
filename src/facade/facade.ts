/**
 * MOCL 门面（C8）：把 Broker + 四后端适配器组装成 DSH 可控的稳定 API。
 *
 * 面向插件的唯一入口；插件**不得**绕过本文件直接调 Broker/适配器。
 * 所有失败统一抛 `MoclError`（ABI §8 错误码）；插件用 `toErrorRef()` 投影给模型/父会话。
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { BackendAdapter } from "../abi/adapter.ts";
import type { BackendId, ErrorRef, InputBlock, PermissionProfile, SessionState } from "../abi/types.ts";
import { Broker } from "../broker/broker.ts";
import { SessionRegistry } from "../broker/session-registry.ts";
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
    readonly events: 0;
    readonly note: string;
  };
  readonly progress: {
    readonly mode: "off" | "summary";
    readonly maxItemsPerTurn: number;
    readonly maxCharsPerTurn: number;
    readonly maxCharsPerItem: number;
  };
  readonly configDigest: string;
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
  readonly #remoteIds = new Map<string, string | null>();
  readonly #registryPath: string;
  readonly #clock: () => Date;

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
        idempotencyKey: `${idempotencyKey}:open`,
      });
      this.#remoteIds.set(opened.sessionId, opened.backendSessionId === "" ? null : opened.backendSessionId);
      try {
        const sent = await this.#broker.send(opened.sessionId, {
          input: [{ type: "text", text: task } satisfies InputBlock],
          idempotencyKey: `${idempotencyKey}:send`,
        });
        return {
          childId: opened.sessionId,
          backend,
          backendSessionId: opened.backendSessionId === "" ? null : opened.backendSessionId,
          remoteIdState: idStateOf(opened.backendSessionId),
          epoch: opened.epoch,
          state: sent.state,
          turnId: sent.turnId,
          deduplicated: opened.deduplicated || sent.deduplicated,
        };
      } catch (error) {
        // 首轮失败：释放会话槽位，不留下半开状态。
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
      return { childId, turnId: sent.turnId, state: sent.state, deduplicated: sent.deduplicated };
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
      const backendSessionId = resumed.backendSessionId === "" ? null : resumed.backendSessionId;
      this.#remoteIds.set(childId, backendSessionId);
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
      await this.#broker.close(childId, "operator");
      this.#remoteIds.delete(childId);
      return { childId, closed: true };
    });
  }

  #statusOutcome(
    status: { sessionId: string; backend: BackendId; backendSessionId: string; state: SessionState; epoch: number; createdAt: string; lastTurnId: string | null; active: boolean },
    fromSeq: number,
  ): StatusOutcome {
    const overlay = this.#remoteIds.get(status.sessionId);
    const backendSessionId = overlay === undefined ? (status.backendSessionId === "" ? null : status.backendSessionId) : overlay;
    return {
      childId: status.sessionId,
      backend: status.backend as ConfigBackendId,
      backendSessionId,
      remoteIdState: idStateOf(backendSessionId),
      state: status.state,
      epoch: status.epoch,
      createdAt: status.createdAt,
      lastTurnId: status.lastTurnId,
      active: status.active,
      cursor: {
        fromSeq,
        lastSeq: null,
        events: 0,
        note: "event stream wiring is deferred to C9 (broker.status snapshot only)",
      },
      progress: {
        mode: this.#config.global.progress.mode,
        maxItemsPerTurn: this.#config.global.progress.maxItemsPerTurn,
        maxCharsPerTurn: this.#config.global.progress.maxCharsPerTurn,
        maxCharsPerItem: this.#config.global.progress.maxCharsPerItem,
      },
      configDigest: configDigest(this.#config),
    };
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

export function errorRefOf(error: unknown): ErrorRef {
  return asMoclError(error).toErrorRef();
}

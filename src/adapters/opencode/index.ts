/**
 * opencode 适配器（L1；施工 C7；规格 docs/adapters/opencode.md）。
 *
 * 通道：v2 HttpApi 主通道（D-007）→ ACP over stdio 兜底；模型降级按 D-019
 * （生产 `opencode-go/deepseek-v4.1-flash` 遇 401 `api_key_expired` → 显式降级
 * `opencode/deepseek-v4.1-flash-free`，发 `session.warning` 并标 `model=free-fallback`）。
 *
 * 纪律：
 * - 能力声明只来自握手/契约面（ABI §2.3/§3.3），sandboxModes=unavailable（无 OS 沙箱）；
 * - 并发容量运行时派生（D-016）：本文件不出现任何数字型并发默认值（只读取 provider）；
 * - 凭据只读不打印（service.json password / Basic header 永不进日志/错误文案）。
 */
import { randomUUID } from "node:crypto";
import type {
  AdapterCloseRequest,
  AdapterEvent,
  AdapterInterruptRequest,
  AdapterOpenRequest,
  AdapterOpenResult,
  AdapterResumeRequest,
  AdapterResumeResult,
  AdapterSendRequest,
  AdapterSendResult,
  BackendAdapter,
} from "../../abi/adapter.ts";
import { CAPABILITY_BITS, type CapabilityBit, type CapabilityState } from "../../abi/capabilities.ts";
import type { BackendId, CapabilityDeclaration, CapabilityEntry, InputBlock, PermissionProfile, TransportKind } from "../../abi/types.ts";
import type { RuntimeConfigProvider } from "../../broker/concurrency.ts";
import { RuntimeConfigError } from "../../broker/concurrency.ts";
import { moclError } from "../../broker/errors.ts";
import type { AcpApi } from "./acp-client.ts";
import type { AcpSessionUpdateParams } from "./types.ts";
import type { OpenCodeHttpApi } from "./http-client.ts";
import { EventDropCounters, OpenCodeEventMapper } from "./events.ts";
import { toMoclError } from "./errors.ts";
import {
  FREE_FALLBACK_MARKER,
  ModelPolicy,
  isFallbackEligible,
  parseModelRef,
  type ModelFallbackDecision,
  type ModelPolicySnapshot,
} from "./models.ts";

const OPENCODE_BACKEND_VERSION = "2.1.4";
const DEFAULT_MAX_TURN_MS = 1_800_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
/** SSE 首帧（server.connected）就绪等待上限：保证 open 返回前事件流已建立。 */
const SSE_READY_TIMEOUT_MS = 10_000;

/** HTTP 模式的必需端点（握手指纹；缺失 → protocol.version-mismatch，§2.2）。 */
export const REQUIRED_OPERATION_IDS: readonly string[] = [
  "event.subscribe",
  "session.create",
  "session.prompt",
  "session.interrupt",
  "session.fork",
  "session.inbox.list",
  "session.permission.reply",
  "session.switchModel",
];

export type OpenCodeTransportMode = "http" | "acp";

export interface OpenCodeAdapterOptions {
  readonly transport: OpenCodeTransportMode;
  readonly http?: OpenCodeHttpApi;
  readonly acp?: AcpApi;
  /** D-016：并发容量只从运行时读取；缺失/非法 → 构造 fail-closed。 */
  readonly runtime: RuntimeConfigProvider;
  readonly modelPolicy?: ModelPolicy;
  readonly initialModel?: string | null;
  readonly backendVersion?: string;
  readonly maxTurnMs?: number;
  readonly idleTimeoutMs?: number;
  readonly clock?: () => Date;
  readonly turnIdFactory?: () => string;
  /** 测试可注入固定能力声明（默认按通道构造）。 */
  readonly capabilitiesOverride?: CapabilityDeclaration;
}

interface SessionRuntime {
  readonly remoteSessionId: string;
  readonly cwd: string;
  readonly mapper: OpenCodeEventMapper;
  model: string;
  agent: string;
  degraded: boolean;
  turnId: string | null;
  readonly sseAbort: AbortController | null;
  sseReady: (() => void) | null;
  closed: boolean;
}

/** 异步事件队列（`events()` 的载体；适配器生命周期内有效）。 */
class AdapterEventQueue {
  readonly #items: AdapterEvent[] = [];
  readonly #waiters: ((result: IteratorResult<AdapterEvent>) => void)[] = [];
  #closed = false;

  push(event: AdapterEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: event, done: false });
      return;
    }
    this.#items.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<AdapterEvent> {
    return {
      next: (): Promise<IteratorResult<AdapterEvent>> => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      [Symbol.asyncIterator](): AsyncIterableIterator<AdapterEvent> {
        return this;
      },
    };
  }
}

/** 能力位按通道填充（矩阵 opencode 列；sandbox ❌，concurrency 本地派生）。 */
function buildCapabilities(options: {
  readonly mode: OpenCodeTransportMode;
  readonly runtime: RuntimeConfigProvider;
  readonly clock: () => Date;
  readonly backendVersion: string;
  readonly maxTurnMs: number;
  readonly idleTimeoutMs: number;
  readonly extraWarnings?: readonly string[];
}): CapabilityDeclaration {
  const httpStates: Partial<Record<CapabilityBit, CapabilityState>> = {
    headless: "native",
    streaming: "native",
    resumeSession: "native",
    forkSession: "native",
    listSessions: "native",
    interruptTurn: "native",
    nativeSubagents: "native",
    toolExtension: "native",
    permissionModes: "native",
    sandboxModes: "unavailable",
    modelRouting: "native",
    concurrencyControl: "unavailable",
    usageReporting: "native",
    structuredProtocol: "native",
    versionPinning: "native",
    multiTurn: "native",
    steerTurn: "native",
    inputInbox: "native",
    tokenLevelStream: "unavailable",
    planUpdates: "unavailable",
    diffUpdates: "emulated",
    tokenUsage: "native",
    permissionAutoReply: "native",
    permissionRequestBridge: "native",
    childSessionUpdates: "emulated",
    sessionArchive: "unavailable",
    sessionUnarchive: "unavailable",
    sessionDelete: "native",
    sessionExport: "native",
    sessionReseed: "emulated",
    worktreeIsolation: "native",
    backgroundRuns: "native",
    processKillInterrupt: "native",
    handshakeVersion: "native",
  };
  const acpStates: Partial<Record<CapabilityBit, CapabilityState>> = {
    ...httpStates,
    interruptTurn: "emulated", // ACP session/cancel 未验证 → 进程级 kill
    permissionModes: "emulated", // 只有 build/plan
    modelRouting: "emulated", // 无 set_model → set_config_option
    usageReporting: "emulated", // 无 session.list 聚合
    steerTurn: "unavailable",
    inputInbox: "unavailable",
    diffUpdates: "unavailable",
    tokenUsage: "emulated",
    permissionAutoReply: "unavailable",
    permissionRequestBridge: "unavailable",
    childSessionUpdates: "native",
    worktreeIsolation: "unavailable",
    backgroundRuns: "unavailable",
  };
  const states = options.mode === "http" ? httpStates : acpStates;
  const bits: CapabilityEntry[] = CAPABILITY_BITS.map((bit) => {
    const state = states[bit] ?? "unavailable";
    return { bit, state };
  });
  const warnings = [
    "sandboxModes=unavailable",
    "concurrencyControl=derived-from-runtime",
    ...(options.mode === "acp" ? ["interruptTurn=emulated(process-kill)"] : []),
    ...(options.extraWarnings ?? []),
  ];
  return {
    abiVersion: "0.1",
    backendId: "opencode",
    backendVersion: options.backendVersion,
    transport: (options.mode === "http" ? "http-api" : "acp-stdio") satisfies TransportKind,
    nativeProtocolVersion: options.mode === "http" ? "httpapi/0.0.1" : "acp/1",
    bits,
    limits: {
      maxTurnMs: options.maxTurnMs,
      idleTimeoutMs: options.idleTimeoutMs,
      maxSessionsPerBackend: readCapacity(options.runtime),
      maxNestingDepth: 1,
      maxConcurrentTurns: 1,
    },
    warnings,
    observedAt: options.clock().toISOString(),
  };
}

/** D-016：容量只来自运行时；非法 → fail-closed（不猜默认）。 */
function readCapacity(runtime: RuntimeConfigProvider): number {
  let snapshot: { readonly maxActiveSubagents: number };
  try {
    snapshot = runtime.read();
  } catch (cause) {
    throw new RuntimeConfigError("failed to read runtime.maxActiveSubagents (fail-closed)", { cause });
  }
  const value = snapshot.maxActiveSubagents;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeConfigError(`runtime.maxActiveSubagents must be a positive safe integer, got ${String(value)}`);
  }
  return value;
}

function agentForProfile(profile: PermissionProfile): string {
  return profile === "read-only" ? "plan" : "build";
}

function joinInput(input: readonly InputBlock[]): string {
  return input
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newTurnId(): string {
  const hex = randomUUID().replace(/-/g, "");
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    out += CROCKFORD[Number.parseInt(pair.length === 0 ? "0" : pair, 16) % CROCKFORD.length] ?? "0";
  }
  return `turn_${out}`;
}

export class OpenCodeAdapter implements BackendAdapter {
  readonly backendId: BackendId = "opencode";
  readonly capabilities: CapabilityDeclaration;

  readonly #mode: OpenCodeTransportMode;
  readonly #http: OpenCodeHttpApi | undefined;
  readonly #acp: AcpApi | undefined;
  readonly #policy: ModelPolicy;
  readonly #clock: () => Date;
  readonly #turnIdFactory: () => string;
  readonly #events = new AdapterEventQueue();
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #counters = new EventDropCounters();
  #handshake: { readonly info: { readonly version: string }; readonly paths: number } | undefined;
  #acpReady = false;
  #disposed = false;

  constructor(options: OpenCodeAdapterOptions) {
    if (options.transport === "http" && options.http === undefined) {
      throw new TypeError("OpenCodeAdapter(http) requires options.http");
    }
    if (options.transport === "acp" && options.acp === undefined) {
      throw new TypeError("OpenCodeAdapter(acp) requires options.acp");
    }
    this.#mode = options.transport;
    this.#http = options.http;
    this.#acp = options.acp;
    this.#policy = options.modelPolicy ?? new ModelPolicy(options.initialModel);
    this.#clock = options.clock ?? (() => new Date());
    this.#turnIdFactory = options.turnIdFactory ?? newTurnId;
    this.capabilities =
      options.capabilitiesOverride ??
      buildCapabilities({
        mode: this.#mode,
        runtime: options.runtime,
        clock: this.#clock,
        backendVersion: options.backendVersion ?? OPENCODE_BACKEND_VERSION,
        maxTurnMs: options.maxTurnMs ?? DEFAULT_MAX_TURN_MS,
        idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      });
    this.#acp?.onUpdate((params) => this.#onAcpUpdate(params));
  }

  /** 模型状态（D-019：降级后为 free-fallback，供 L2/L4 与测试断言）。 */
  get modelState(): ModelPolicySnapshot {
    return this.#policy.snapshot();
  }

  /** 丢弃计数（catalog 噪声/内部标记/未知类型；§11.2）。 */
  get dropStats(): Readonly<Record<string, number>> {
    return this.#counters.snapshot();
  }

  get transportMode(): OpenCodeTransportMode {
    return this.#mode;
  }

  /* ------------------------------------------------------------------ */
  /* BackendAdapter                                                      */
  /* ------------------------------------------------------------------ */

  async open(request: AdapterOpenRequest): Promise<AdapterOpenResult> {
    this.#assertUsable();
    const model = this.#policy.override(request.model ?? null);
    const agent = agentForProfile(request.permissionProfile ?? "read-only");
    if (this.#mode === "http") {
      const http = this.#requireHttp();
      await this.#ensureHandshake(http);
      const created = await http.createSession({
        agent,
        model: parseModelRef(model),
        location: { directory: request.cwd },
      });
      const state: SessionRuntime = {
        remoteSessionId: created.id,
        cwd: request.cwd,
        mapper: new OpenCodeEventMapper({ sessionId: request.sessionId, model }, this.#counters),
        model,
        agent,
        degraded: this.#policy.degraded,
        turnId: null,
        sseAbort: new AbortController(),
        sseReady: null,
        closed: false,
      };
      this.#sessions.set(created.id, state);
      const ready = new Promise<void>((resolve) => {
        state.sseReady = resolve;
      });
      void this.#startSse(http, state);
      // 事件流就绪后再返回，避免 prompt 早于 SSE 连接导致丢事件（opencode 无断点续传验证）。
      await Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, SSE_READY_TIMEOUT_MS))]);
      return { remoteSessionId: created.id, capabilities: this.capabilities };
    }

    const acp = this.#requireAcp();
    await this.#ensureAcpReady(acp);
    const created = await acp.newSession({ cwd: request.cwd });
    // ACP 默认 model 落在 opencode-go 付费池 → 必须先切到已验证可用的模型（§2.3）。
    await acp.setConfigOption(created.sessionId, "model", model);
    const state: SessionRuntime = {
      remoteSessionId: created.sessionId,
      cwd: request.cwd,
      mapper: new OpenCodeEventMapper({ sessionId: request.sessionId, model }, this.#counters),
      model,
      agent,
      degraded: this.#policy.degraded,
      turnId: null,
      sseAbort: null,
      sseReady: null,
      closed: false,
    };
    this.#sessions.set(created.sessionId, state);
    return { remoteSessionId: created.sessionId, capabilities: this.capabilities };
  }

  async send(request: AdapterSendRequest): Promise<AdapterSendResult> {
    this.#assertUsable();
    const state = this.#sessionOf(request.remoteSessionId);
    const text = joinInput(request.input);
    if (text.trim().length === 0) {
      throw moclError("protocol.invalid-params", { message: "opencode prompt requires at least one text block" });
    }
    const turnId = this.#turnIdFactory();
    state.turnId = turnId;
    state.mapper.beginTurn(turnId, state.model);

    if (this.#mode === "http") {
      try {
        await this.#requireHttp().promptSession(state.remoteSessionId, text);
        return { turnId, acceptedAtSeq: 0 };
      } catch (error) {
        const normalized = toMoclError(error);
        const decision = await this.#applyFallback(state, normalized);
        if (decision !== null) {
          throw moclError("auth.credential-expired", {
            message: `opencode paid model rejected (api_key_expired); degraded to free model (${FREE_FALLBACK_MARKER})`,
            details: {
              kind: "auth.credential-expired",
              backendCode: "api_key_expired",
              hint: `${FREE_FALLBACK_MARKER}; 请用新 turnId 重试本轮`,
            },
          });
        }
        throw normalized;
      }
    }

    const acp = this.#requireAcp();
    try {
      const result = await acp.prompt(state.remoteSessionId, text);
      this.#pushAll(state.mapper.mapPromptResult(result));
      state.turnId = null;
      return { turnId, acceptedAtSeq: 0 };
    } catch (error) {
      const normalized = toMoclError(error);
      const decision = await this.#applyFallback(state, normalized);
      if (decision !== null) {
        throw moclError("auth.credential-expired", {
          message: `opencode ACP auth failed; degraded to free model (${FREE_FALLBACK_MARKER})`,
          details: { kind: "auth.credential-expired", hint: `${FREE_FALLBACK_MARKER}; 请用新 turnId 重试本轮` },
        });
      }
      throw normalized;
    }
  }

  async resume(request: AdapterResumeRequest): Promise<AdapterResumeResult> {
    this.#assertUsable();
    if (this.#mode === "http") {
      try {
        const info = await this.#requireHttp().getSession(request.remoteSessionId);
        this.#syncSessionFromInfo(request.remoteSessionId, info);
        return { exists: true, remoteSessionId: info.id };
      } catch (error) {
        const normalized = toMoclError(error);
        if (normalized.code === "session.not-found" || normalized.code === "transport.connect-failed") {
          return { exists: false, reason: normalized.code };
        }
        throw normalized;
      }
    }
    const acp = this.#requireAcp();
    const state = this.#sessions.get(request.remoteSessionId);
    try {
      await acp.loadSession({ sessionId: request.remoteSessionId, cwd: state?.cwd ?? process.cwd() });
      return { exists: true, remoteSessionId: request.remoteSessionId };
    } catch (error) {
      const normalized = toMoclError(error);
      if (normalized.code === "session.not-found" || normalized.code === "protocol.invalid-params") {
        return { exists: false, reason: normalized.code };
      }
      throw normalized;
    }
  }

  async interrupt(request: AdapterInterruptRequest): Promise<void> {
    this.#assertUsable();
    const state = this.#sessions.get(request.remoteSessionId);
    if (state === undefined) {
      throw moclError("session.not-found", { message: `session not found: ${request.remoteSessionId}` });
    }
    if (this.#mode === "http") {
      const result = await this.#requireHttp().interrupt(state.remoteSessionId, true);
      if (result.interrupted) {
        this.#pushAll(state.mapper.interrupt("native"));
        state.turnId = null;
      }
      return;
    }
    const acp = this.#requireAcp();
    await acp.terminate();
    this.#pushAll(state.mapper.interrupt("process-kill"));
    state.turnId = null;
  }

  async close(request: AdapterCloseRequest): Promise<void> {
    const state = this.#sessions.get(request.remoteSessionId);
    if (state === undefined) return; // 幂等
    state.closed = true;
    state.sseAbort?.abort();
    this.#sessions.delete(request.remoteSessionId);
    this.#events.push({ type: "session.closed", payload: { reason: request.reason } });
    if (this.#mode === "acp" && this.#sessions.size === 0) {
      await this.#acp?.terminate();
    }
  }

  events(): AsyncIterable<AdapterEvent> {
    return this.#events;
  }

  /** 释放适配器（关闭事件流；Broker 生命周期结束时调用）。 */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const state of this.#sessions.values()) {
      state.closed = true;
      state.sseAbort?.abort();
    }
    this.#sessions.clear();
    if (this.#mode === "acp") await this.#acp?.terminate();
    else await this.#http?.close();
    this.#events.close();
  }

  /* ------------------------------------------------------------------ */
  /* 握手 / 事件 / 降级                                                  */
  /* ------------------------------------------------------------------ */

  async #ensureHandshake(http: OpenCodeHttpApi): Promise<void> {
    if (this.#handshake !== undefined) return;
    const info = await http.getInfo();
    if (typeof info.version !== "string" || info.version.length === 0) {
      throw moclError("protocol.version-mismatch", { message: "opencode /api/info missing version" });
    }
    const openapi = await http.getOpenApi();
    if (typeof openapi.openapi !== "string" || !openapi.openapi.startsWith("3.1.")) {
      throw moclError("protocol.version-mismatch", {
        message: `opencode OpenAPI version mismatch: ${String(openapi.openapi)}`,
      });
    }
    const paths = openapi.paths;
    if (paths === undefined || typeof paths !== "object") {
      throw moclError("protocol.version-mismatch", { message: "opencode /openapi.json missing paths" });
    }
    const pathCount = Object.keys(paths).length;
    const operationIds = collectOperationIds(paths);
    const missing = REQUIRED_OPERATION_IDS.filter((operationId) => !operationIds.has(operationId));
    if (missing.length > 0) {
      throw moclError("protocol.version-mismatch", {
        message: `opencode OpenAPI missing required endpoints (${missing.join(", ")})`,
        details: { kind: "protocol.version-mismatch", hint: "openapi operationId 缺失，禁止按 v1 文档猜路径" },
      });
    }
    this.#handshake = { info: { version: info.version }, paths: pathCount };
  }

  async #ensureAcpReady(acp: AcpApi): Promise<void> {
    if (this.#acpReady) return;
    const init = await acp.initialize({ name: "mocl", version: "0.1" });
    if (init.protocolVersion !== 1) {
      throw moclError("protocol.version-mismatch", {
        message: `opencode ACP protocolVersion mismatch: ${String(init.protocolVersion)}`,
      });
    }
    this.#acpReady = true;
  }

  async #startSse(http: OpenCodeHttpApi, state: SessionRuntime): Promise<void> {
    try {
      await http.subscribeEvents((frame) => this.#onSseFrame(state, frame), {
        signal: state.sseAbort?.signal,
      });
    } catch (error) {
      const normalized = toMoclError(error);
      if (state.closed) return;
      this.#events.push({
        type: "session.lost",
        payload: { reason: normalized.code, lastKnownSeq: 0 },
      });
    }
  }

  #onSseFrame(state: SessionRuntime, frame: { readonly type: string; readonly data?: Readonly<Record<string, unknown>> }): void {
    if (state.closed) return;
    state.sseReady?.();
    state.sseReady = null;
    const sessionID = frame.data?.["sessionID"];
    if (typeof sessionID === "string" && sessionID !== state.remoteSessionId) {
      this.#counters.inc("drop.foreign_session_event");
      return;
    }
    const mapped = state.mapper.map(frame);
    this.#pushAll(mapped);
    if (frame.type === "session.execution.failed" || frame.type === "session.step.failed") {
      void this.#applyFallback(state, frame.data?.["error"]);
    }
    if (frame.type === "session.execution.succeeded" || frame.type === "session.execution.failed" || frame.type === "session.execution.interrupted") {
      state.turnId = null;
    }
  }

  #onAcpUpdate(params: AcpSessionUpdateParams): void {
    const state = this.#sessions.get(params.sessionId);
    if (state === undefined) {
      this.#counters.inc("drop.foreign_session_event");
      return;
    }
    this.#pushAll(state.mapper.mapAcpUpdate(params));
  }

  /**
   * D-019：显式降级（禁止静默）。
   * @returns 决策（已切换模型并发出 warning）/ null（不适用）
   */
  async #applyFallback(state: SessionRuntime, rawError: unknown): Promise<ModelFallbackDecision | null> {
    if (!isFallbackEligible(rawError)) return null;
    // 幂等：同一轮可能同时收到 step.failed 与 execution.failed，只允许降级一次（禁止重复 warning/switch）。
    if (this.#policy.degraded) return null;
    if (!this.#policy.isPaidModel(state.model)) return null;
    const decision = this.#policy.onCredentialExpired(state.model);
    if (decision === null) return null;
    try {
      if (this.#mode === "http") {
        await this.#requireHttp().switchModel(state.remoteSessionId, parseModelRef(decision.model));
      } else {
        await this.#requireAcp().setConfigOption(state.remoteSessionId, "model", decision.model);
      }
    } catch (error) {
      // 切换失败：不做半降级；把错误交给调用方（模型状态保持不变）。
      this.#policy.override(decision.previousModel);
      throw toMoclError(error);
    }
    state.model = decision.model;
    state.degraded = true;
    this.#events.push({
      type: "session.warning",
      payload: decision.warning,
    });
    return decision;
  }

  #syncSessionFromInfo(remoteSessionId: string, info: { readonly model?: { readonly id: string; readonly providerID: string } | null }): void {
    const state = this.#sessions.get(remoteSessionId);
    if (state === undefined) return;
    if (info.model !== null && info.model !== undefined) {
      state.model = `${info.model.providerID}/${info.model.id}`;
    }
  }

  #pushAll(events: readonly AdapterEvent[]): void {
    for (const event of events) this.#events.push(event);
  }

  #sessionOf(remoteSessionId: string): SessionRuntime {
    const state = this.#sessions.get(remoteSessionId);
    if (state === undefined) {
      throw moclError("session.not-found", { message: `session not found: ${remoteSessionId}` });
    }
    return state;
  }

  #requireHttp(): OpenCodeHttpApi {
    if (this.#http === undefined) throw moclError("capability.missing", { message: "http transport not configured" });
    return this.#http;
  }

  #requireAcp(): AcpApi {
    if (this.#acp === undefined) throw moclError("capability.missing", { message: "acp transport not configured" });
    return this.#acp;
  }

  #assertUsable(): void {
    if (this.#disposed) throw moclError("transport.disconnected", { message: "opencode adapter disposed" });
  }
}

/** OpenAPI paths → operationId 集合。 */
function collectOperationIds(paths: Readonly<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const pathItem of Object.values(paths)) {
    if (pathItem === null || typeof pathItem !== "object") continue;
    for (const operation of Object.values(pathItem as Record<string, unknown>)) {
      if (operation !== null && typeof operation === "object") {
        const id = (operation as Record<string, unknown>)["operationId"];
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return ids;
}

export { ModelPolicy, PRODUCTION_MODEL, FREE_FALLBACK_MODEL, FREE_FALLBACK_MARKER } from "./models.ts";

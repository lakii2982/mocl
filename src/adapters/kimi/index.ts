/**
 * kimi-code 适配器（L1；施工 C6；规格 docs/adapters/kimi.md）。
 *
 * 通道：**ACP over stdio 主通道**（§0.2）→ `-p --output-format stream-json` 兜底（仅 ACP 不可用时）。
 *
 * 本文件承载三条 D-决策的落地：
 * - **D-003**：反向 handler 必须先注册；未注册 → `capability.missing` 拒绝启动；再叠一层
 *   60s 静默看门狗 + 单轮硬超时（`acp-client.ts`），超时 → killpg + `turn.aborted{timeout,partial}`。
 * - **D-004**：权限按**语义**映射（`permissions.ts`），绝不按 CLI 旗标名字透传。
 * - **D-008**：**无单轮中断**（`session/cancel` → -32601）→ `interrupt()` = killpg(SIGTERM→5s→SIGKILL)，
 *   发 `turn.aborted{process-kill,partial:true}` + `session.lost`，**不重放**被中断轮；一任务一进程。
 *
 * 纪律：
 * - 能力声明只来自实测（§1.2 表）；`sandboxModes`/`interruptTurn`/`concurrencyControl` 如实报不可用；
 * - 并发容量运行时派生（D-016）：本文件不出现数字型并发默认值；
 * - 不读凭据、不打日志里的 home 绝对路径。
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
import type {
  BackendId,
  CapabilityDeclaration,
  CapabilityEntry,
  InputBlock,
  PermissionProfile,
  TransportKind,
} from "../../abi/types.ts";
import type { RuntimeConfigProvider } from "../../broker/concurrency.ts";
import { RuntimeConfigError } from "../../broker/concurrency.ts";
import { moclError, MoclError } from "../../broker/errors.ts";
import {
  KimiAcpClient,
  defaultKimiBinary,
  spawnKimiAcpTransport,
  type AcpTransport,
  type KimiAcpApi,
  type PermissionRequestParams,
} from "./acp-client.ts";
import { toKimiError, toMoclError } from "./errors.ts";
import { EventDropCounters, KimiEventMapper } from "./events.ts";
import { DEFAULT_KIMI_MODEL, resolveModel } from "./models.ts";
import {
  acpModeForProfile,
  assertSemanticMapping,
  cliFallbackAllowed,
  readKimiConfigProbe,
  type PermissionAnswer,
} from "./permissions.ts";
import { KimiPromptClient, type PromptRunner } from "./prompt-client.ts";
import type { KimiConfigOption, KimiConfigProbe, KimiSessionUpdateParams } from "./types.ts";

/** 握手期断言的后端版本（§1.1 第 2 条）。 */
export const KIMI_BACKEND_VERSION = "2.3.1";
/** 静默挂死看门狗默认值（D-003：60s 内无任何帧即判挂死）。 */
export const DEFAULT_WATCHDOG_MS = 60_000;
export const DEFAULT_MAX_TURN_MS = 1_800_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type KimiTransportMode = "acp" | "cli";

/** 一个逻辑会话 = 一个 ACP 子进程（§2.1）。 */
export interface KimiProcessHandle {
  readonly acp: KimiAcpApi;
  readonly pgid?: number;
  readonly transport?: AcpTransport;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface KimiProcessSpec {
  readonly sessionId: string;
  readonly cwd: string;
  readonly watchdogMs: number;
  readonly maxTurnMs: number;
  readonly timeoutMs: number;
  readonly allowedRoots: readonly string[];
  readonly allowWrite: boolean;
  readonly onHung: (reason: "idle" | "turn-timeout") => void;
  readonly permissionHandler: (params: PermissionRequestParams) => Promise<{ readonly optionId: string } | null>;
}

export type KimiProcessFactory = (spec: KimiProcessSpec) => KimiProcessHandle | Promise<KimiProcessHandle>;

export interface KimiAdapterOptions {
  readonly transport: KimiTransportMode;
  /** ACP 进程工厂（默认 spawn `kimi acp`；测试注入假 transport）。 */
  readonly processFactory?: KimiProcessFactory;
  /** CLI 兜底执行器（测试注入假 runner）。 */
  readonly promptRunner?: PromptRunner;
  /** D-016：并发容量只从运行时读取；缺失/非法 → 构造 fail-closed。 */
  readonly runtime: RuntimeConfigProvider;
  readonly initialModel?: string | null;
  readonly backendVersion?: string;
  readonly watchdogMs?: number;
  readonly maxTurnMs?: number;
  readonly requestTimeoutMs?: number;
  readonly allowedRoots?: readonly string[];
  readonly allowWrite?: boolean;
  /** `config.toml` 只读探测（§7.5；测试注入）。 */
  readonly configProbe?: () => KimiConfigProbe;
  readonly clock?: () => Date;
  readonly turnIdFactory?: () => string;
  readonly capabilitiesOverride?: CapabilityDeclaration;
}

interface SessionRuntime {
  readonly sessionId: string;
  readonly cwd: string;
  remoteSessionId: string;
  readonly mapper: KimiEventMapper;
  model: string;
  readonly profile: PermissionProfile;
  process: KimiProcessHandle | null;
  lost: boolean;
  closed: boolean;
  configOptions: readonly KimiConfigOption[];
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

/** 能力位（§1.2 表逐行；ACP 主通道口径）。 */
function buildCapabilities(options: {
  readonly mode: KimiTransportMode;
  readonly runtime: RuntimeConfigProvider;
  readonly clock: () => Date;
  readonly backendVersion: string;
  readonly maxTurnMs: number;
  readonly watchdogMs: number;
}): CapabilityDeclaration {
  const acpStates: Partial<Record<CapabilityBit, CapabilityState>> = {
    // A 组
    headless: "native",
    streaming: "native",
    resumeSession: "native",
    forkSession: "native",
    listSessions: "native",
    interruptTurn: "unavailable", // session/cancel → -32601；只能进程级 kill
    nativeSubagents: "native", // 存在但不透传（§6.2）
    toolExtension: "native",
    permissionModes: "native",
    sandboxModes: "unavailable", // 无 OS 级沙箱（§7.4）
    modelRouting: "native",
    concurrencyControl: "unavailable", // 未发现后端硬上限（§9.1）
    usageReporting: "emulated", // 只有上下文占用，无计费 token
    structuredProtocol: "native",
    versionPinning: "emulated", // upgrade 无版本参数，只能锁二进制路径
    // B 组
    multiTurn: "native",
    steerTurn: "unavailable",
    inputInbox: "unavailable",
    tokenLevelStream: "native",
    planUpdates: "unavailable",
    diffUpdates: "unavailable",
    tokenUsage: "emulated",
    permissionAutoReply: "native",
    permissionRequestBridge: "native",
    childSessionUpdates: "unavailable",
    sessionArchive: "unavailable",
    sessionUnarchive: "unavailable",
    sessionDelete: "native",
    sessionExport: "emulated",
    sessionReseed: "emulated",
    worktreeIsolation: "unavailable",
    backgroundRuns: "unavailable",
    processKillInterrupt: "native",
    handshakeVersion: "native",
  };
  const cliStates: Partial<Record<CapabilityBit, CapabilityState>> = {
    ...acpStates,
    streaming: "emulated", // 消息级，无 token 增量
    tokenLevelStream: "unavailable",
    interruptTurn: "unavailable",
    permissionModes: "emulated", // -p 与模式旗标互斥 → 档位由 config 决定
    permissionAutoReply: "unavailable",
    permissionRequestBridge: "unavailable",
    processKillInterrupt: "native",
    structuredProtocol: "emulated", // JSONL 非 JSON-RPC
  };
  const states = options.mode === "acp" ? acpStates : cliStates;
  const bits: CapabilityEntry[] = CAPABILITY_BITS.map((bit) => ({ bit, state: states[bit] ?? "unavailable" }));
  const warnings = [
    "interruptTurn=unavailable(emulated-by-process-kill)",
    "sandboxModes=unavailable(no-os-sandbox)",
    "childSessionUpdates=unavailable",
    "usageReporting=emulated(context-occupancy-only)",
    "concurrencyControl=derived-from-runtime",
    ...(options.mode === "cli" ? ["streaming=emulated(message-level)"] : []),
  ];
  return {
    abiVersion: "0.1",
    backendId: "kimi",
    backendVersion: options.backendVersion,
    transport: (options.mode === "acp" ? "acp-stdio" : "cli-stream-json") satisfies TransportKind,
    nativeProtocolVersion: options.mode === "acp" ? "acp/1" : "cli-stream-json/0",
    bits,
    limits: {
      maxTurnMs: options.maxTurnMs,
      idleTimeoutMs: options.watchdogMs,
      maxSessionsPerBackend: readCapacity(options.runtime),
      maxNestingDepth: 1,
      maxConcurrentTurns: 1, // 一任务一进程（§2.1）
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

function joinInput(input: readonly InputBlock[]): string {
  return input
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function newTurnId(): string {
  return `turn_${randomUUID().replace(/-/g, "").slice(0, 26)}`;
}

/** 默认 ACP 进程工厂：spawn `kimi acp`（独立进程组）+ KimiAcpClient。 */
function defaultProcessFactory(spec: KimiProcessSpec): KimiProcessHandle {
  const transport = spawnKimiAcpTransport({ binaryPath: defaultKimiBinary(), cwd: spec.cwd });
  const acp = new KimiAcpClient({
    transport,
    watchdogMs: spec.watchdogMs,
    maxTurnMs: spec.maxTurnMs,
    timeoutMs: spec.timeoutMs,
    allowedRoots: spec.allowedRoots,
    allowWrite: spec.allowWrite,
    permissionHandler: spec.permissionHandler,
    onHung: spec.onHung,
  });
  return {
    acp,
    ...(transport.pgid === undefined ? {} : { pgid: transport.pgid }),
    transport,
    kill(signal: "SIGTERM" | "SIGKILL"): void {
      if (transport.signal !== undefined) transport.signal(signal);
      else transport.close();
    },
  };
}

export class KimiAdapter implements BackendAdapter {
  readonly backendId: BackendId = "kimi";
  readonly capabilities: CapabilityDeclaration;

  readonly #mode: KimiTransportMode;
  readonly #factory: KimiProcessFactory;
  readonly #promptClient: KimiPromptClient;
  readonly #watchdogMs: number;
  readonly #maxTurnMs: number;
  readonly #requestTimeoutMs: number;
  readonly #allowedRoots: readonly string[];
  readonly #allowWrite: boolean;
  readonly #configProbe: () => KimiConfigProbe;
  readonly #clock: () => Date;
  readonly #turnIdFactory: () => string;
  readonly #events = new AdapterEventQueue();
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #counters = new EventDropCounters();
  #initialModel: string;
  #disposed = false;
  #pendingKills: { readonly handle: KimiProcessHandle; readonly timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(options: KimiAdapterOptions) {
    // D-004 自检：映射表必须与"命名错位"事实一致（构造即失败，不允许带病运行）。
    assertSemanticMapping();
    this.#mode = options.transport;
    this.#factory = options.processFactory ?? defaultProcessFactory;
    this.#watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    this.#maxTurnMs = options.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#allowedRoots = options.allowedRoots ?? [];
    this.#allowWrite = options.allowWrite ?? false;
    this.#configProbe = options.configProbe ?? (() => readKimiConfigProbe());
    this.#clock = options.clock ?? (() => new Date());
    this.#turnIdFactory = options.turnIdFactory ?? newTurnId;
    this.#initialModel = options.initialModel ?? DEFAULT_KIMI_MODEL;
    this.#promptClient = new KimiPromptClient({
      ...(options.promptRunner === undefined ? {} : { runner: options.promptRunner }),
      timeoutMs: this.#maxTurnMs,
    });
    this.capabilities =
      options.capabilitiesOverride ??
      buildCapabilities({
        mode: this.#mode,
        runtime: options.runtime,
        clock: this.#clock,
        backendVersion: options.backendVersion ?? KIMI_BACKEND_VERSION,
        maxTurnMs: this.#maxTurnMs,
        watchdogMs: this.#watchdogMs,
      });
  }

  get transportMode(): KimiTransportMode {
    return this.#mode;
  }

  /** 丢弃计数（§11.2；证明丢弃是显式而非漏映射）。 */
  get dropStats(): Readonly<Record<string, number>> {
    return this.#counters.snapshot();
  }

  get watchdogMs(): number {
    return this.#watchdogMs;
  }

  /** 某会话是否已丢失（中断/崩溃后；供测试与 L2 判定冷恢复）。 */
  isSessionLost(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.lost ?? false;
  }

  /** 某会话的进程组 id（K9 "一任务一进程" 断言用）。 */
  pgidOf(sessionId: string): number | undefined {
    return this.#sessions.get(sessionId)?.process?.pgid;
  }

  /* ------------------------------------------------------------------ */
  /* BackendAdapter                                                      */
  /* ------------------------------------------------------------------ */

  async open(request: AdapterOpenRequest): Promise<AdapterOpenResult> {
    this.#assertUsable();
    const profile = request.permissionProfile ?? "read-only";
    const model = resolveModel(request.model, this.#initialModel);
    const cwd = assertAbsoluteCwd(request.cwd);

    if (this.#mode === "cli") {
      // CLI 兜底：档位只能由 config.toml 决定 → 不满足则 fail-closed（§7.5）。
      const verdict = cliFallbackAllowed(profile, this.#configProbe());
      if (!verdict.allowed) {
        throw moclError("policy.escalation-required", {
          message: `kimi CLI fallback cannot honor permissionProfile="${profile}": ${verdict.reason ?? "unknown"}`,
          details: { kind: "policy.escalation-required", hint: "改 config.toml: default_permission_mode，或改用 ACP 通道" },
        });
      }
      const mapper = new KimiEventMapper({ sessionId: request.sessionId, cwd, expectedProfile: profile }, this.#counters);
      const state: SessionRuntime = {
        sessionId: request.sessionId,
        cwd,
        remoteSessionId: "",
        mapper,
        model,
        profile,
        process: null,
        lost: false,
        closed: false,
        configOptions: [],
      };
      this.#sessions.set(request.sessionId, state);
      this.#pushAll(mapper.sessionCreated(cwd));
      return { remoteSessionId: "", capabilities: this.capabilities };
    }

    const state = await this.#spawnSession({ sessionId: request.sessionId, cwd, model, profile });
    return { remoteSessionId: state.remoteSessionId, capabilities: this.capabilities };
  }

  async send(request: AdapterSendRequest): Promise<AdapterSendResult> {
    this.#assertUsable();
    const state = this.#sessionOf(request.remoteSessionId);
    const text = joinInput(request.input);
    if (text.trim().length === 0) {
      throw moclError("protocol.invalid-params", { message: "kimi prompt requires at least one text block" });
    }
    if (state.lost) {
      throw moclError("session.invalidated", { message: `kimi session is lost; resume before send: ${state.sessionId}` });
    }
    const turnId = this.#turnIdFactory();
    state.mapper.beginTurn(turnId, state.model);

    if (this.#mode === "cli") return await this.#sendCli(state, text, turnId);
    return await this.#sendAcp(state, text, turnId);
  }

  async resume(request: AdapterResumeRequest): Promise<AdapterResumeResult> {
    this.#assertUsable();
    const state = this.#sessions.get(request.sessionId);
    if (state === undefined) return { exists: false, reason: "not-tracked" };
    if (this.#mode === "cli") {
      // CLI 通道无 load；存在性以适配器记录为准（CLI 侧会话目录由后端保留）。
      return state.lost ? { exists: false, reason: "session.lost" } : { exists: true, remoteSessionId: state.remoteSessionId };
    }
    try {
      // 进程已被中断/崩溃 → 新进程 + session/load（§10.1 冷恢复）。
      const handle = await this.#ensureProcess(state);
      await handle.acp.loadSession({ sessionId: state.remoteSessionId, cwd: state.cwd });
      state.lost = false;
      this.#pushAll(state.mapper.sessionRecovered());
      return { exists: true, remoteSessionId: state.remoteSessionId };
    } catch (error) {
      const normalized = toKimiError(error, { method: "session/load" });
      if (
        normalized.code === "session.invalidated" ||
        normalized.code === "session.not-found" ||
        normalized.code === "protocol.invalid-params"
      ) {
        return { exists: false, reason: normalized.code };
      }
      throw normalized;
    }
  }

  /**
   * 中断 = 进程级（D-008）：
   * 1. **不**调用 `session/cancel`（必 -32601）；
   * 2. killpg(SIGTERM) → 5s 后 SIGKILL；
   * 3. `turn.aborted{process-kill, partial:true}` + `session.lost`；
   * 4. **不重放**被中断轮（无幂等对账手段）。
   */
  async interrupt(request: AdapterInterruptRequest): Promise<void> {
    this.#assertUsable();
    const state = this.#sessionOf(request.remoteSessionId);
    this.#killSession(state, "interrupted");
  }

  async close(request: AdapterCloseRequest): Promise<void> {
    const state = this.#lookup(request.remoteSessionId);
    if (state === undefined) return; // 幂等
    state.closed = true;
    this.#sessions.delete(request.remoteSessionId);
    if (state.process !== null) {
      // 尽力发 session/close（握手声明支持），失败不阻塞（-32601/超时都按 kill 处理）。
      try {
        await state.process.acp.closeSession(state.remoteSessionId);
      } catch {
        // 忽略：进程即将被 kill
      }
      this.#killProcess(state.process);
    }
    this.#events.push({ type: "session.closed", payload: { reason: request.reason } });
  }

  events(): AsyncIterable<AdapterEvent> {
    return this.#events;
  }

  /** 释放适配器（关闭事件流、杀掉所有进程组；Broker 生命周期结束时调用）。 */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const state of this.#sessions.values()) {
      state.closed = true;
      if (state.process !== null) this.#killProcess(state.process);
    }
    this.#sessions.clear();
    for (const pending of this.#pendingKills) clearTimeout(pending.timer);
    this.#pendingKills = [];
    this.#events.close();
  }

  /* ------------------------------------------------------------------ */
  /* 会话建立 / 进程管理                                                 */
  /* ------------------------------------------------------------------ */

  async #spawnSession(input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly model: string;
    readonly profile: PermissionProfile;
  }): Promise<SessionRuntime> {
    const state: SessionRuntime = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      remoteSessionId: "",
      mapper: new KimiEventMapper(
        { sessionId: input.sessionId, cwd: input.cwd, expectedProfile: input.profile, clock: this.#clock },
        this.#counters,
      ),
      model: input.model,
      profile: input.profile,
      process: null,
      lost: false,
      closed: false,
      configOptions: [],
    };
    this.#sessions.set(input.sessionId, state);

    const handle = await this.#createProcess(state);
    state.process = handle;
    handle.acp.onUpdate((params) => this.#onAcpUpdate(state, params));

    // 启动守卫（§2.3）：没有 fs/read_text_file handler → 拒绝启动（prompt 会静默挂死）。
    if (!handle.acp.reverseHandlersRegistered) {
      this.#killProcess(handle);
      this.#sessions.delete(input.sessionId);
      throw moclError("capability.missing", {
        message: "kimi ACP refused to start: fs/read_text_file reverse handler is not registered",
        details: { kind: "capability.missing", hint: "D-003：缺 fs handler 时 session/prompt 会永久静默挂死" },
      });
    }

    try {
      const init = await handle.acp.initialize({ name: "mocl", version: "0.1" });
      assertHandshake(init.protocolVersion, init.agentInfo?.version);
      const created = await handle.acp.newSession({ cwd: state.cwd });
      state.remoteSessionId = created.sessionId;
      const configOptions = created.configOptions ?? [];
      state.configOptions = configOptions;
      const actualModel = modelOfConfigOptions(configOptions) ?? state.model;
      state.model = actualModel;
      // 权限档位：显式 set_mode（不信 session/new 的快照，§3.2/§7.5）；
      // `default_plan_mode=true` 时 set_mode 会 -32603 "Already in plan mode" → 幂等处理。
      await this.#applyPermissionProfile(handle, state, input.profile);
      this.#pushAll(state.mapper.sessionCreated(state.cwd));
      this.#events.push({
        type: "session.state-changed",
        payload: { previousState: "created", state: "running", reason: "opened" },
      });
      return state;
    } catch (error) {
      this.#killProcess(handle);
      this.#sessions.delete(input.sessionId);
      throw toMoclError(error);
    }
  }

  async #createProcess(state: SessionRuntime): Promise<KimiProcessHandle> {
    return await this.#factory({
      sessionId: state.sessionId,
      cwd: state.cwd,
      watchdogMs: this.#watchdogMs,
      maxTurnMs: this.#maxTurnMs,
      timeoutMs: this.#requestTimeoutMs,
      allowedRoots: this.#allowedRoots.length > 0 ? this.#allowedRoots : [state.cwd],
      allowWrite: this.#allowWrite,
      onHung: (reason) => this.#onHung(state, reason),
      permissionHandler: (params) => this.#onPermissionRequest(state, params),
    });
  }

  /** 惰性建进程（resume 冷恢复路径）。 */
  async #ensureProcess(state: SessionRuntime): Promise<KimiProcessHandle> {
    if (state.process !== null) return state.process;
    const handle = await this.#createProcess(state);
    state.process = handle;
    handle.acp.onUpdate((params) => this.#onAcpUpdate(state, params));
    const init = await handle.acp.initialize({ name: "mocl", version: "0.1" });
    assertHandshake(init.protocolVersion, init.agentInfo?.version);
    return handle;
  }

  /**
   * 应用权限档位（§3.2）：
   * 首选 `session/set_mode`；`-32603 Already in <mode> mode` 点名**请求档位** → 已达目标
   * （幂等，不重试）。点名其他档位才是真冲突 → 走配置项通道（M14 第二条路），同样幂等。
   */
  async #applyPermissionProfile(
    handle: KimiProcessHandle,
    state: SessionRuntime,
    profile: PermissionProfile,
  ): Promise<void> {
    const modeId = acpModeForProfile(profile);
    try {
      await handle.acp.setMode(state.remoteSessionId, modeId);
    } catch (error) {
      const normalized = toMoclError(error);
      if (normalized.code === "session.conflict") {
        // 实测（2026-10-26）：`default_plan_mode=true` 时新会话即 plan 档，set_mode/set_config_option
        // 请求同档均回 -32603 data.details="Already in plan mode"；跨档切换（plan→auto/default）则成功。
        if (conflictingModeOf(normalized) === modeId) return;
        // 点名其他档位（真状态冲突）→ 尝试配置项通道。
        await this.#setModeViaConfigOption(state, modeId);
        return;
      }
      if (normalized.code === "protocol.unknown-method") {
        // 老版本无 set_mode → 退到 set_config_option。
        await this.#setModeViaConfigOption(state, modeId);
        return;
      }
      throw normalized;
    }
  }

  /** `set_config_option{configId:"mode"}` 通道；同形 `-32603` 冲突点名请求档位 → 幂等成功。 */
  async #setModeViaConfigOption(state: SessionRuntime, modeId: string): Promise<void> {
    const handle = state.process;
    if (handle === null) {
      throw moclError("session.locked", { message: "kimi process is not running" });
    }
    try {
      await handle.acp.setConfigOption(state.remoteSessionId, "mode", modeId);
    } catch (error) {
      const normalized = toMoclError(error);
      if (normalized.code === "session.conflict" && conflictingModeOf(normalized) === modeId) return;
      throw normalized;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 发送（ACP 主通道 / CLI 兜底）                                        */
  /* ------------------------------------------------------------------ */

  async #sendAcp(state: SessionRuntime, text: string, turnId: string): Promise<AdapterSendResult> {
    const handle = state.process;
    if (handle === null) {
      throw moclError("transport.disconnected", { message: "kimi ACP process is not running; resume first" });
    }
    try {
      const result = await handle.acp.prompt(state.remoteSessionId, text);
      this.#pushAll(state.mapper.mapPromptResult(result));
      return { turnId, acceptedAtSeq: 0 };
    } catch (error) {
      const normalized = toKimiError(error, { method: "session/prompt" });
      // 看门狗/硬超时：必须先杀进程组，再发终态（保证 `partial:true` 语义）。
      if (normalized.code === "transport.timeout" || normalized.code === "limit.turn-timeout") {
        // 看门狗路径可能已由 onHung 发过终态 + session.lost → 这里保持幂等。
        if (!state.mapper.terminalEmitted) this.#pushAll(state.mapper.mapTimeout("turn"));
        if (!state.lost) {
          state.lost = true;
          this.#pushAll(state.mapper.sessionLost(normalized.code));
        }
        if (state.process !== null) {
          this.#killProcess(state.process);
          state.process = null;
        }
        throw normalized;
      }
      if (normalized.code === "session.invalidated") {
        this.#pushAll(state.mapper.mapPromptError(error, { method: "session/prompt" }));
        state.lost = true;
        this.#pushAll(state.mapper.sessionLost("session.invalidated"));
        return { turnId, acceptedAtSeq: 0 };
      }
      this.#pushAll(state.mapper.mapPromptError(error, { method: "session/prompt" }));
      throw normalized;
    }
  }

  async #sendCli(state: SessionRuntime, text: string, turnId: string): Promise<AdapterSendResult> {
    try {
      const outcome = await this.#promptClient.turn({
        text,
        cwd: state.cwd,
        sessionId: state.remoteSessionId.length > 0 ? state.remoteSessionId : null,
        model: state.model,
        timeoutMs: this.#maxTurnMs,
      });
      for (const event of outcome.parsed) {
        this.#pushAll(state.mapper.mapCliEvent(event));
      }
      if (outcome.sessionId !== null && state.remoteSessionId.length === 0) {
        // CLI 首次 turn 才知道后端 session id（`session.resume_hint`）。
        state.remoteSessionId = outcome.sessionId;
        this.#pushAll(state.mapper.sessionCreated(state.cwd));
      }
      if (outcome.result.timedOut) {
        this.#pushAll(state.mapper.mapTimeout("turn"));
        state.lost = true;
        this.#pushAll(state.mapper.sessionLost("limit.turn-timeout"));
        throw moclError("limit.turn-timeout", { message: `kimi CLI turn exceeded ${this.#maxTurnMs}ms` });
      }
      if (outcome.result.exitCode !== 0) {
        const error = toMoclError(
          moclError("process.crashed", {
            message: `kimi CLI exited with ${String(outcome.result.exitCode)}${outcome.result.stderr.length > 0 ? `: ${outcome.result.stderr.slice(0, 200)}` : ""}`,
          }),
        );
        this.#pushAll(state.mapper.mapPromptError(error));
        throw error;
      }
      this.#pushAll(state.mapper.finishCliTurn(outcome.result.exitCode));
      return { turnId, acceptedAtSeq: 0 };
    } catch (error) {
      if (error instanceof MoclError) throw error;
      const normalized = toMoclError(error);
      this.#pushAll(state.mapper.mapPromptError(normalized));
      throw normalized;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 事件 / 权限 / 看门狗                                                */
  /* ------------------------------------------------------------------ */

  #onAcpUpdate(state: SessionRuntime, params: KimiSessionUpdateParams): void {
    if (state.closed) return;
    if (params.sessionId !== state.remoteSessionId) {
      // 一任务一进程：单进程只承载一个逻辑会话；外来 sessionId 一律丢弃计数（§9.2 不变量）。
      this.#counters.inc("drop.foreign_session_event");
      return;
    }
    this.#pushAll(state.mapper.mapAcpUpdate(params));
  }

  /** 权限请求：确定性策略应答（**必须回包**，否则 turn 挂死）。 */
  async #onPermissionRequest(
    state: SessionRuntime,
    params: PermissionRequestParams,
  ): Promise<{ readonly optionId: string } | null> {
    const answer: PermissionAnswer = this.#answerFor(state, params);
    if (answer.escalationRequired) {
      this.#events.push({
        type: "session.warning",
        payload: {
          code: "policy.escalation-required",
          message: `kimi permission request for "${String(params.toolCall?.["title"] ?? "unknown")}" has no matching allow option; denied`,
          degrade: true,
        },
      });
    }
    // optionId 必须真实存在，否则后端会拒绝应答并继续挂起。
    return answer.optionId.length > 0 ? { optionId: answer.optionId } : null;
  }

  #answerFor(state: SessionRuntime, params: PermissionRequestParams): PermissionAnswer {
    const mapped = state.mapper.mapPermissionRequest(
      params.requestId ?? 0,
      params as unknown as Readonly<Record<string, unknown>>,
    );
    // 事件在应答时一并入队（permission.requested + permission.resolved）。
    this.#pushAll(mapped.events);
    return mapped.answer;
  }

  /** 看门狗/硬超时：killpg + 终态（`turn.aborted{timeout,partial}` + `session.lost`）。 */
  #onHung(state: SessionRuntime, reason: "idle" | "turn-timeout"): void {
    if (state.closed) return;
    this.#counters.inc(reason === "idle" ? "prompt.hung.idle" : "prompt.hung.turn");
    this.#pushAll(state.mapper.mapTimeout(reason === "idle" ? "idle" : "turn"));
    state.lost = true;
    this.#pushAll(state.mapper.sessionLost(reason === "idle" ? "transport.timeout" : "limit.turn-timeout"));
    if (state.process !== null) this.#killProcess(state.process);
    state.process = null;
  }

  /* ------------------------------------------------------------------ */
  /* 进程终止                                                            */
  /* ------------------------------------------------------------------ */

  #killSession(state: SessionRuntime, reason: string, options: { readonly alreadyTerminal?: boolean } = {}): void {
    if (state.process !== null) {
      this.#pushAll(state.mapper.interrupt());
      this.#killProcess(state.process);
      state.process = null;
    } else if (options.alreadyTerminal !== true) {
      this.#pushAll(state.mapper.interrupt());
    }
    state.lost = true;
    this.#pushAll(state.mapper.sessionLost(reason));
  }

  /** SIGTERM → (5s) → SIGKILL；两个信号都要发，且不阻塞调用方（§9.2）。 */
  #killProcess(handle: KimiProcessHandle): void {
    try {
      handle.kill("SIGTERM");
    } catch {
      // 已退出
    }
    const timer = setTimeout(() => {
      this.#pendingKills = this.#pendingKills.filter((item) => item.timer !== timer);
      try {
        handle.kill("SIGKILL");
      } catch {
        // 已退出
      }
    }, 5_000);
    timer.unref?.();
    this.#pendingKills.push({ handle, timer });
  }

  /* ------------------------------------------------------------------ */

  #pushAll(events: readonly AdapterEvent[]): void {
    for (const event of events) this.#events.push(event);
  }

  /** 按 remoteSessionId 或逻辑 sessionId 查找（找不到返回 undefined，不抛）。 */
  #lookup(id: string): SessionRuntime | undefined {
    for (const state of this.#sessions.values()) {
      if (state.remoteSessionId === id || state.sessionId === id) return state;
    }
    return undefined;
  }

  #sessionOf(remoteSessionId: string): SessionRuntime {
    for (const state of this.#sessions.values()) {
      if (state.remoteSessionId === remoteSessionId || state.sessionId === remoteSessionId) return state;
    }
    throw moclError("session.not-found", { message: `kimi session not found: ${remoteSessionId}` });
  }

  #assertUsable(): void {
    if (this.#disposed) throw moclError("transport.disconnected", { message: "kimi adapter disposed" });
  }
}

/* ------------------------------------------------------------------ */
/* 纯函数助手（可单测）                                                 */
/* ------------------------------------------------------------------ */

/** 握手断言（§1.1 第 1/2 条）。 */
export function assertHandshake(protocolVersion: number, agentInfoVersion: string | undefined): void {
  if (protocolVersion !== 1) {
    throw moclError("protocol.version-mismatch", {
      message: `kimi ACP protocolVersion mismatch: expected 1, got ${String(protocolVersion)}`,
    });
  }
  if (agentInfoVersion !== undefined && agentInfoVersion !== KIMI_BACKEND_VERSION) {
    throw moclError("protocol.version-mismatch", {
      message: `kimi version mismatch: expected ${KIMI_BACKEND_VERSION}, got ${agentInfoVersion}`,
      details: { kind: "protocol.version-mismatch", hint: "versionPinning=emulated：升级会静默换版本，需人工确认" },
    });
  }
}

/** cwd 必须是绝对路径（ABI M2；相对路径拒绝）。 */
export function assertAbsoluteCwd(cwd: string): string {
  if (cwd.length === 0 || !cwd.startsWith("/")) {
    throw moclError("protocol.invalid-params", { message: `kimi adapter requires an absolute cwd, got ${JSON.stringify(cwd)}` });
  }
  return cwd;
}

/** `configOptions` 里 id=model 的 currentValue。 */
export function modelOfConfigOptions(configOptions: readonly KimiConfigOption[]): string | null {
  return configOptions.find((option) => option.id === "model")?.currentValue ?? null;
}

/**
 * 从映射后的 `session.conflict` 读出点名档位（errors.ts 写入 `hint: "already-in-mode:<name>"`）。
 * null = 后端未点名（或非模式冲突）→ 调用方按真冲突处理。
 */
function conflictingModeOf(error: MoclError): string | null {
  const hint = error.details?.hint;
  if (typeof hint !== "string") return null;
  const match = /^already-in-mode:([a-z][a-z-]*)$/.exec(hint);
  return match === null ? null : match[1]!;
}

export { acpModeForProfile, cliFallbackAllowed, readKimiConfigProbe };

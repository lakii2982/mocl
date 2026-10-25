/**
 * codex 适配器（施工 C4）：`BackendAdapter` 的 codex 实现（app-server JSON-RPC，基线 0.164.0）。
 *
 * 设计真源：`../../../../docs/adapters/codex.md`（§1 基线 / §2 握手 / §3 会话 / §4 续接 /
 * §5 事件映射 / §7 权限 / §9.1 并发运行时派生 / §10 失败降级）。
 *
 * 关键纪律：
 * - **持久线程**：`thread/start{ephemeral:false}`；`thread/resume` 才是续接（§4.2）；
 * - **无人值守**：10 个 `ServerRequest` 全部预注册拒绝桩（§7.2，否则 turn 挂死）；
 * - **并发不硬编码**：limits 由运行时 seam 值 + codex `config/read` 的 agents 配置联合派生（D-016）；
 * - **默认不跑真实 codex**：测试用假 transport 回放录制帧（零额度）。
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
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
import { CAPABILITY_BITS, type CapabilityBit } from "../../abi/capabilities.ts";
import type { CapabilityDeclaration, CapabilityEntry, PermissionProfile } from "../../abi/types.ts";
import { CodexClient, toUserInput } from "./client.ts";
import { adapterError, asAdapterError } from "./errors.ts";
import { CodexEventMapper } from "./events.ts";
import { UnattendedApprovals } from "./server-requests.ts";
import { CodexTransport, type SpawnFactory, type TransportOptions } from "./transport.ts";
import type { CodexSessionHandle, CodexThread, ThreadResumeResult, ThreadStartResult } from "./types.ts";

/** 运行时配置读取（与 `src/broker/concurrency.ts` 的 `RuntimeConfigProvider` 结构兼容）。 */
export interface CodexRuntimeProvider {
  read(): { readonly maxActiveSubagents: number };
}

export interface CodexAdapterOptions {
  /** 基线二进制：默认 `MOCL_CODEX_BIN` → `codex`（设计 §1.1）。 */
  readonly binaryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 测试注入：假子进程工厂（默认 `node:child_process.spawn`）。 */
  readonly spawn?: SpawnFactory;
  readonly requestTimeoutMs?: number;
  /** 期望基线版本；`null` 关闭版本断言（仅迁移/测试）。 */
  readonly expectedVersion?: string | null;
  /** 运行时并发来源（D-016）；缺失 → open 时 fail-closed。 */
  readonly runtime?: CodexRuntimeProvider;
  /** 允许的 cwd 根（realpath 必须落在其中）；缺省只校验"绝对路径且存在"。 */
  readonly allowedRoots?: readonly string[];
  /** 轮次/空闲上限（ABI `BackendLimits` 的 ABI 契约默认值，不是并发值）。 */
  readonly maxTurnMs?: number;
  readonly idleTimeoutMs?: number;
  readonly defaultModel?: string | null;
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `turn_` + 26 Crockford（与 ABI §0 的 id 形状一致；本地生成，映射后端 UUIDv7）。 */
function newTurnId(): string {
  const hex = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`
    .padEnd(52, "0")
    .slice(0, 52);
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    out += CROCKFORD[Number.isNaN(byte) ? 0 : byte % CROCKFORD.length] ?? "0";
  }
  return `turn_${out}`;
}

/** 设计 §2.3 的 codex 能力位取值（native/emulated/unavailable）。 */
const CODEX_BIT_STATES: Readonly<Record<CapabilityBit, CapabilityEntry["state"]>> = {
  // A 组（15）
  headless: "native",
  streaming: "native",
  resumeSession: "native",
  forkSession: "native",
  listSessions: "native",
  interruptTurn: "native",
  nativeSubagents: "native",
  toolExtension: "native",
  permissionModes: "native",
  sandboxModes: "native",
  modelRouting: "native",
  concurrencyControl: "native",
  usageReporting: "native",
  structuredProtocol: "native",
  versionPinning: "native",
  // B 组（19）
  multiTurn: "native",
  steerTurn: "native",
  inputInbox: "unavailable",
  tokenLevelStream: "native",
  planUpdates: "native",
  diffUpdates: "native",
  tokenUsage: "native",
  permissionAutoReply: "native",
  permissionRequestBridge: "native",
  childSessionUpdates: "native",
  sessionArchive: "native",
  sessionUnarchive: "native",
  sessionDelete: "native",
  sessionExport: "emulated",
  sessionReseed: "emulated",
  worktreeIsolation: "emulated",
  backgroundRuns: "emulated",
  processKillInterrupt: "emulated",
  handshakeVersion: "native",
};

/** ABI `PermissionProfile` → `thread/start` 的权限参数（设计 §7.1；不按名字透传）。 */
export function permissionParamsFor(profile: PermissionProfile): {
  readonly approvalPolicy: string;
  readonly sandbox: string;
} {
  switch (profile) {
    case "read-only":
      return { approvalPolicy: "never", sandbox: "read-only" };
    case "safe-auto":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "yolo":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
}

/** codex 侧的模式名（生产插件用）→ `thread/start` 权限参数。 */
export function permissionParamsForMode(mode: "never" | "approve-for-me" | "dangerously-bypass"): {
  readonly approvalPolicy: string;
  readonly sandbox: string;
} {
  switch (mode) {
    case "approve-for-me":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "dangerously-bypass":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "never":
      return { approvalPolicy: "never", sandbox: "read-only" };
  }
}

/** 生产插件用的三种模式名（`never|approve-for-me|dangerously-bypass`）→ ABI 档位。 */
export function profileFromPermissionMode(mode: string): PermissionProfile {
  switch (mode) {
    case "approve-for-me":
      return "safe-auto";
    case "dangerously-bypass":
      return "yolo";
    default:
      return "read-only";
  }
}

interface TransportFactory {
  (options: TransportOptions): CodexTransport;
}

/** 事件队列（单消费者；Broker 是唯一消费者）。 */
class EventQueue {
  readonly #items: AdapterEvent[] = [];
  readonly #waiters: ((value: IteratorResult<AdapterEvent>) => void)[] = [];
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
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async *iterate(): AsyncIterableIterator<AdapterEvent> {
    for (;;) {
      const buffered = this.#items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<AdapterEvent>>((resolveNext) => {
        this.#waiters.push(resolveNext);
      });
      if (next.done === true) return;
      yield next.value;
    }
  }
}

export class CodexAdapter implements BackendAdapter {
  readonly backendId = "codex" as const;
  readonly #options: CodexAdapterOptions;
  readonly #transportFactory: TransportFactory;
  readonly #approvals = new UnattendedApprovals();
  readonly #events = new EventQueue();
  readonly #sessions = new Map<string, CodexSessionHandle>();
  readonly #threadToSession = new Map<string, string>();
  readonly #remoteTurnToAbi = new Map<string, string>();
  readonly #abiTurnToRemote = new Map<string, string>();
  readonly #mapper: CodexEventMapper;
  #transport: CodexTransport | undefined;
  #client: CodexClient | undefined;
  #declaration: CapabilityDeclaration | undefined;
  #closed = false;

  constructor(options: CodexAdapterOptions = {}, transportFactory?: TransportFactory) {
    this.#options = options;
    this.#transportFactory = transportFactory ?? ((transportOptions) => new CodexTransport(transportOptions));
    this.#mapper = new CodexEventMapper({
      resolveTurnId: (remoteTurnId) => {
        let abi = this.#remoteTurnToAbi.get(remoteTurnId);
        if (abi === undefined) {
          abi = newTurnId();
          this.#remoteTurnToAbi.set(remoteTurnId, abi);
          this.#abiTurnToRemote.set(abi, remoteTurnId);
        }
        return abi;
      },
    });
  }

  /**
   * 握手实测的能力声明。
   * @throws `capability.missing`：`open()` 尚未执行（ABI 要求能力声明来自握手实测）。
   */
  get capabilities(): CapabilityDeclaration {
    if (this.#declaration === undefined) {
      throw adapterError("capability.missing", {
        message: "codex capabilities are only available after a successful open() handshake",
        details: { kind: "capability.missing", missingBits: ["headless"] },
      });
    }
    return this.#declaration;
  }

  /** 反向请求计数（测试与可观测性）。 */
  get approvalCounts(): Readonly<Record<string, number>> {
    return this.#approvals.counts();
  }

  /** 事件丢弃计数（可观测性；键是原生通知名）。 */
  get droppedCounts(): Readonly<Record<string, number>> {
    return this.#mapper.droppedCounts();
  }

  get transportBadFrames(): number {
    return this.#transport?.badFrameCount ?? 0;
  }

  get stderrTail(): string {
    return this.#transport?.stderrTail() ?? "";
  }

  /** 建会话（ABI `session.create` 的后端侧）：initialize → config/read → thread/start(ephemeral:false)。 */
  async open(request: AdapterOpenRequest): Promise<AdapterOpenResult> {
    if (this.#closed) throw adapterError("transport.disconnected", { message: "adapter is closed" });
    if (this.#sessions.has(request.sessionId)) {
      throw adapterError("session.conflict", { message: `session already open: ${request.sessionId}` });
    }
    const cwd = this.#validateCwd(request.cwd);
    const client = this.#ensureClient();
    await client.initialize(this.#options.clientInfo ?? { name: "mocl-codex", version: "0.1" });

    // 并发/深度：运行时配置（D-016）——读取失败即 fail-closed，不猜默认值。
    const limits = await this.#deriveLimits(client);
    const profile = request.permissionProfile ?? "read-only";
    const permission = permissionParamsFor(profile);
    const started = await client.threadStart({
      cwd,
      ephemeral: false,
      approvalPolicy: permission.approvalPolicy,
      sandbox: permission.sandbox,
      ...(request.model === null || request.model === undefined ? {} : { model: request.model }),
    });
    const thread = started.thread;
    const model = request.model ?? started.model ?? thread.model ?? null;
    const handle: CodexSessionHandle = {
      abiSessionId: request.sessionId,
      remoteThreadId: thread.id,
      model,
      cwd,
      materialized: false,
    };
    this.#sessions.set(request.sessionId, handle);
    this.#threadToSession.set(thread.id, request.sessionId);
    this.#mapper.setModel(model);
    this.#declaration = this.#declarationFor(client, limits, thread);
    return { remoteSessionId: thread.id, capabilities: this.#declaration };
  }

  /** 发一轮（ABI `session.send`）：`turn/start`；只代表"已接受"。 */
  async send(request: AdapterSendRequest): Promise<AdapterSendResult> {
    const handle = this.#handleOf(request.sessionId, request.remoteSessionId);
    const client = this.#ensureClient();
    const started = await client.turnStart({
      threadId: handle.remoteThreadId,
      input: toUserInput(request.input),
      clientUserMessageId: request.idempotencyKey.slice(0, 120),
      ...(handle.model === null ? {} : { model: handle.model }),
    });
    const abiTurnId = this.#mapperIdForRemote(started.turn.id);
    handle.lastRemoteTurnId = started.turn.id;
    handle.lastAbiTurnId = abiTurnId;
    handle.materialized = true; // 首个 user message 产生后线程即 materialize（设计 §4.2）
    return { turnId: abiTurnId };
  }

  /** 续接（ABI `session.resume` 的后端侧）：只读探测 → `thread/resume`。 */
  async resume(request: AdapterResumeRequest): Promise<AdapterResumeResult> {
    const client = this.#ensureClient();
    const handle = this.#sessions.get(request.sessionId);
    const remoteThreadId = handle?.remoteThreadId ?? request.remoteSessionId;
    if (remoteThreadId.length === 0) return { exists: false, reason: "no-remote-id" };
    try {
      await client.threadRead(remoteThreadId);
    } catch (error) {
      const adapterFailure = asAdapterError(error);
      if (adapterFailure.code !== "session.invalidated" && adapterFailure.code !== "session.resume-failed" && adapterFailure.code !== "session.not-found") {
        throw adapterFailure;
      }
      // 读不到 rollout 时仍可能是"进程内已加载"的线程（池化探测，设计 §4.4）。
      const loaded = await this.#safeLoadedList(client);
      if (!loaded.includes(remoteThreadId)) {
        return { exists: false, reason: adapterFailure.backendCode ?? "no-rollout" };
      }
    }
    try {
      const resumed: ThreadResumeResult = await client.threadResume({ threadId: remoteThreadId });
      if (handle !== undefined) {
        handle.remoteThreadId = resumed.thread.id;
        if (resumed.model !== undefined) handle.model = resumed.model;
        handle.materialized = true;
      }
      return { exists: true, remoteSessionId: resumed.thread.id };
    } catch (error) {
      const adapterFailure = asAdapterError(error);
      if (adapterFailure.code === "session.resume-failed" || adapterFailure.code === "session.not-found") {
        return { exists: false, reason: adapterFailure.backendCode ?? "resume-failed" };
      }
      throw adapterFailure;
    }
  }

  /** 中断（ABI `session.interrupt`）：`turn/interrupt`；已结束按幂等成功处理。 */
  async interrupt(request: AdapterInterruptRequest): Promise<void> {
    const handle = this.#sessions.get(request.sessionId);
    const remoteThreadId = handle?.remoteThreadId ?? request.remoteSessionId;
    const remoteTurnId =
      request.turnId === undefined
        ? handle?.lastRemoteTurnId
        : (this.#abiTurnToRemote.get(request.turnId) ?? handle?.lastRemoteTurnId);
    if (remoteTurnId === undefined || remoteTurnId.length === 0) return; // 无进行中轮：幂等
    await this.#ensureClient().turnInterrupt({ threadId: remoteThreadId, turnId: remoteTurnId });
  }

  /** 关闭（ABI `session.close`）：`thread/unsubscribe`；最后一个会话关闭后停传输。 */
  async close(request: AdapterCloseRequest): Promise<void> {
    const handle = this.#sessions.get(request.sessionId);
    const remoteThreadId = handle?.remoteThreadId ?? request.remoteSessionId;
    if (handle !== undefined) {
      this.#sessions.delete(request.sessionId);
      this.#threadToSession.delete(handle.remoteThreadId);
    }
    const client = this.#client;
    if (client !== undefined && remoteThreadId.length > 0) {
      try {
        await client.threadUnsubscribe(remoteThreadId);
      } catch {
        // 关闭是幂等的：unsubscribe 失败不阻断（进程可能已退出）。
      }
    }
    if (this.#sessions.size === 0) await this.dispose();
  }

  /** 事件流（单消费者；Broker 侧消费）。 */
  events(): AsyncIterable<AdapterEvent> {
    return this.#events.iterate();
  }

  /** 停止传输并结束事件流（close 后自动调用；测试可直接调用）。 */
  async dispose(): Promise<void> {
    this.#closed = true;
    const transport = this.#transport;
    this.#transport = undefined;
    this.#client = undefined;
    if (transport !== undefined) {
      await transport.stop();
      this.#events.push({
        type: "transport.state-changed",
        payload: { transport: "app-server-jsonrpc", state: "closed", detail: "adapter disposed" },
      });
    }
    this.#events.close();
  }

  /* ------------------------------------------------------------------ 内部 */

  #ensureTransport(): CodexTransport {
    if (this.#transport !== undefined) return this.#transport;
    const transport = this.#transportFactory({
      ...(this.#options.binaryPath === undefined ? {} : { binaryPath: this.#options.binaryPath }),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(this.#options.spawn === undefined ? {} : { spawn: this.#options.spawn }),
      ...(this.#options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#options.requestTimeoutMs }),
      onNotification: (frame) => this.#onNotification(frame),
      onServerRequest: (frame) => this.#onServerRequest(frame),
      onFault: (error) => {
        this.#events.push(this.#mapper.diagnostic("warn", `${error.code}: ${error.message}`));
      },
      onExit: (code, signal) => {
        this.#events.push({
          type: "transport.state-changed",
          payload: {
            transport: "app-server-jsonrpc",
            state: code === 0 ? "closed" : "failed",
            detail: `app-server exited (code=${String(code)}, signal=${String(signal)})`.slice(0, 200),
          },
        });
      },
    });
    this.#transport = transport;
    transport.start();
    this.#events.push({ type: "transport.state-changed", payload: { transport: "app-server-jsonrpc", state: "ready" } });
    return transport;
  }

  #ensureClient(): CodexClient {
    if (this.#client !== undefined) return this.#client;
    const transport = this.#ensureTransport();
    this.#client = new CodexClient(transport, {
      expectedVersion: this.#options.expectedVersion === undefined ? "0.164.0" : this.#options.expectedVersion,
      ...(this.#options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#options.requestTimeoutMs }),
    });
    return this.#client;
  }

  #handleOf(sessionId: string, remoteSessionId: string): CodexSessionHandle {
    const handle = this.#sessions.get(sessionId);
    if (handle !== undefined) return handle;
    // 冷恢复后的适配器实例可能没有内存 handle：用请求里的 remote id 重建（cwd/model 未知）。
    if (remoteSessionId.length === 0) {
      throw adapterError("session.not-found", { message: `session not open: ${sessionId}` });
    }
    const created: CodexSessionHandle = {
      abiSessionId: sessionId,
      remoteThreadId: remoteSessionId,
      model: this.#options.defaultModel ?? null,
      cwd: process.cwd(),
      materialized: true,
    };
    this.#sessions.set(sessionId, created);
    this.#threadToSession.set(remoteSessionId, sessionId);
    return created;
  }

  #mapperIdForRemote(remoteTurnId: string): string {
    let abi = this.#remoteTurnToAbi.get(remoteTurnId);
    if (abi === undefined) {
      abi = newTurnId();
      this.#remoteTurnToAbi.set(remoteTurnId, abi);
      this.#abiTurnToRemote.set(abi, remoteTurnId);
    }
    return abi;
  }

  async #safeLoadedList(client: CodexClient): Promise<readonly string[]> {
    try {
      return await client.threadLoadedList();
    } catch {
      return [];
    }
  }

  #validateCwd(cwd: string): string {
    if (!isAbsolute(cwd)) {
      throw adapterError("policy.sandbox-violation", {
        message: `cwd must be absolute: ${cwd}`,
        details: { kind: "policy.sandbox-violation", cwd },
      });
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw adapterError("policy.sandbox-violation", {
        message: `cwd does not exist or is not a directory: ${cwd}`,
        details: { kind: "policy.sandbox-violation", cwd },
      });
    }
    const real = realpathSync(cwd);
    const roots = this.#options.allowedRoots;
    if (roots !== undefined && roots.length > 0) {
      const allowed = roots.some((root) => {
        const realRoot = realpathSync(resolve(root));
        return real === realRoot || real.startsWith(`${realRoot}${sep}`);
      });
      if (!allowed) {
        throw adapterError("policy.sandbox-violation", {
          message: `cwd escapes allowed roots: ${real}`,
          details: { kind: "policy.sandbox-violation", cwd: real },
        });
      }
    }
    return real;
  }

  async #deriveLimits(client: CodexClient): Promise<{
    maxSessionsPerBackend: number;
    maxConcurrentTurns: number;
    maxNestingDepth: number;
    warnings: string[];
  }> {
    const runtime = this.#options.runtime;
    if (runtime === undefined) {
      throw adapterError("capability.missing", {
        message: "runtime provider is required to derive concurrency limits (D-016)",
        details: { kind: "capability.missing", missingBits: ["concurrencyControl"] },
      });
    }
    let seamCap: number;
    try {
      seamCap = runtime.read().maxActiveSubagents;
    } catch (cause) {
      throw adapterError("capability.missing", {
        message: `failed to read runtime.maxActiveSubagents: ${cause instanceof Error ? cause.message : String(cause)}`,
        details: { kind: "capability.missing", missingBits: ["concurrencyControl"] },
      });
    }
    if (!Number.isSafeInteger(seamCap) || seamCap <= 0) {
      throw adapterError("capability.missing", {
        message: `runtime.maxActiveSubagents is invalid: ${String(seamCap)}`,
        details: { kind: "capability.missing", missingBits: ["concurrencyControl"] },
      });
    }
    const config = await client.readConfig();
    const agents = config.config?.agents ?? undefined;
    const backendThreads = agents?.max_concurrent_threads_per_session ?? undefined;
    const backendDepth = agents?.max_depth ?? undefined;
    const warnings: string[] = [];
    if (typeof backendThreads !== "number" || !Number.isSafeInteger(backendThreads) || backendThreads <= 0) {
      throw adapterError("capability.missing", {
        message: "codex config/read did not expose agents.max_concurrent_threads_per_session (fail-closed, D-016)",
        details: { kind: "capability.missing", missingBits: ["concurrencyControl"] },
      });
    }
    if (typeof backendDepth !== "number" || !Number.isSafeInteger(backendDepth) || backendDepth < 0) {
      throw adapterError("capability.missing", {
        message: "codex config/read did not expose agents.max_depth (fail-closed, D-016)",
        details: { kind: "capability.missing", missingBits: ["concurrencyControl"] },
      });
    }
    const maxConcurrentTurns = Math.min(seamCap, backendThreads);
    if (backendThreads > seamCap) warnings.push("limit-clamped-to-runtime: maxConcurrentTurns");
    return {
      maxSessionsPerBackend: seamCap,
      maxConcurrentTurns,
      maxNestingDepth: backendDepth,
      warnings,
    };
  }

  #declarationFor(
    client: CodexClient,
    limits: { maxSessionsPerBackend: number; maxConcurrentTurns: number; maxNestingDepth: number; warnings: string[] },
    thread: CodexThread,
  ): CapabilityDeclaration {
    const bits: CapabilityEntry[] = CAPABILITY_BITS.map((bit) => {
      const state = CODEX_BIT_STATES[bit];
      const detail = bit === "concurrencyControl"
        ? `runtime-derived: seam=${String(limits.maxSessionsPerBackend)}, backend=config/read`
        : undefined;
      return { bit, state, ...(detail === undefined ? {} : { detail }) };
    });
    return {
      abiVersion: "0.1",
      backendId: "codex",
      backendVersion: client.detectedVersion ?? thread.cliVersion ?? "unknown",
      transport: "app-server-jsonrpc",
      nativeProtocolVersion: `${client.detectedVersion ?? "unknown"}/app-server-v2`,
      bits,
      limits: {
        maxTurnMs: this.#options.maxTurnMs ?? 1_800_000,
        idleTimeoutMs: this.#options.idleTimeoutMs ?? 120_000,
        maxSessionsPerBackend: limits.maxSessionsPerBackend,
        maxNestingDepth: limits.maxNestingDepth,
        maxConcurrentTurns: limits.maxConcurrentTurns,
      },
      warnings: limits.warnings,
      observedAt: new Date().toISOString(),
    };
  }

  #onNotification(frame: { readonly method?: string; readonly params?: unknown }): void {
    const params = frame.params;
    const threadId = params !== null && typeof params === "object" ? (params as Record<string, unknown>)["threadId"] : undefined;
    if (typeof threadId === "string" && !this.#threadToSession.has(threadId)) {
      // 未知线程（可能是子代理线程或上个连接遗留）：计数但不混入 ABI 事件。
      this.#events.push(this.#mapper.diagnostic("debug", `notification for unknown thread ${threadId}: ${String(frame.method)}`));
      return;
    }
    for (const event of this.#mapper.handleNotification(frame)) this.#events.push(event);
  }

  #onServerRequest(frame: { readonly id?: string | number | null; readonly method?: string; readonly params?: unknown }): void {
    const transport = this.#transport;
    if (transport === undefined) return;
    const response = this.#approvals.handle(frame);
    transport.respond(response);
    // 权限/输入请求也要让父级可见（ABI §7.6）：请求 + 立即的策略性拒绝。
    const method = frame.method ?? "";
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const requestId = `${String(frame.id)}`;
    const threadId = typeof params["threadId"] === "string" ? params["threadId"] : undefined;
    const sessionId = threadId === undefined ? undefined : this.#threadToSession.get(threadId);
    if (sessionId === undefined) return;
    const turnId = typeof params["turnId"] === "string" ? this.#mapperIdForRemote(params["turnId"]) : undefined;
    if (method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request") {
      this.#events.push({
        type: "input.requested",
        ...(turnId === undefined ? {} : { turnId }),
        payload: { requestId, question: String(params["message"] ?? method).slice(0, 400) },
      });
      this.#events.push({
        type: "input.resolved",
        ...(turnId === undefined ? {} : { turnId }),
        payload: { requestId, decision: "declined" },
      });
      return;
    }
    this.#events.push({
      type: "permission.requested",
      ...(turnId === undefined ? {} : { turnId }),
      payload: {
        requestId,
        tool: method,
        risk: method.includes("fileChange") ? "write" : method.includes("commandExecution") ? "execute" : "unknown",
        options: [],
      },
    });
    this.#events.push({
      type: "permission.resolved",
      ...(turnId === undefined ? {} : { turnId }),
      payload: { requestId, decision: "deny", by: "policy" },
    });
  }
}


/** 便于集成层用同一套默认值构造适配器（`MOCL_CODEX_BIN` 由 transport 解析）。 */
export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexAdapter {
  return new CodexAdapter(options);
}

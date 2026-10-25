/**
 * claude-code 适配器（施工 C5）：`BackendAdapter` 的 Agent SDK 实现（SDK 0.3.263 / CLI 2.1.310）。
 *
 * 设计真源：`../../../../docs/adapters/claude-code.md`（§2 握手 / §3 会话 / §4 续接 / §5 事件映射 /
 * §7 权限 / §9 并发 / §10 失败降级）。
 *
 * 关键纪律：
 * - `persistSession: true`（否则永远无法 resume）；续接只走 `Options.resume`；
 * - `canUseTool` 2s 超时 fail-closed（返回 null/挂起会无限阻塞）；
 * - 成功终态只认 `subtype:"success" && is_error:false && result 非空`；
 * - 并发上限运行时派生（D-016），读不到即 fail-closed，不写死并发常量；
 * - 真实模型默认不跑：测试注入假 SDK（零额度），`MOCL_LIVE=1` 才跑 1 轮 smoke。
 */
import { randomUUID } from "node:crypto";
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
import { adapterError, asAdapterError, mapInitTimeout, type AdapterError } from "./errors.ts";
import { ClaudeEventMapper } from "./events.ts";
import {
  READ_ONLY_ALLOWED_TOOLS,
  createCanUseTool,
  disallowedToolsFor,
  permissionModeFor,
  type PermissionDecisionRecord,
} from "./permissions.ts";
import { classifyResumeFailure, createFileSessionProber, type SessionProber } from "./resume.ts";
import {
  AsyncInputQueue,
  ClaudeSdkClient,
  buildQueryOptions,
  toSdkUserMessage,
  type ClaudeQueryHandle,
} from "./sdk-client.ts";
import type { SdkLoader, SdkMessage, SdkUserMessage } from "./types.ts";

/** 运行时配置读取（与 `src/broker/concurrency.ts` 的 `RuntimeConfigProvider` 结构兼容）。 */
export interface ClaudeRuntimeProvider {
  read(): { readonly maxActiveSubagents: number };
}

export interface ClaudeCodeAdapterOptions {
  /** D-016：并发容量只从运行时读取；缺失/非法 → open 时 fail-closed。 */
  readonly runtime?: ClaudeRuntimeProvider;
  /** 注入 SDK（默认动态 import `@anthropic-ai/claude-agent-sdk`）。 */
  readonly sdkLoader?: SdkLoader;
  /** 冷恢复探测（默认只读 `~/.claude/projects/**` 文件存在性）。 */
  readonly sessionProber?: SessionProber;
  /** 钉死 CLI 的绝对路径（`pathToClaudeCodeExecutable`；缺省用 PATH 上的 `claude`）。 */
  readonly claudeCodeExecutable?: string;
  /** 期望的 CLI 版本（init.claude_code_version）；`null` 关闭断言。 */
  readonly expectedCliVersion?: string | null;
  /** `system/init` 首帧超时（挂起 → `transport.timeout`）。 */
  readonly initTimeoutMs?: number;
  readonly model?: string | null;
  /** 显式权限模式覆盖（默认由 profile 映射）。 */
  readonly permissionMode?: string;
  readonly maxTurns?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowedRoots?: readonly string[];
  /** ABI limits 里的轮次/空闲上限（ABI 契约默认值，不是并发值）。 */
  readonly maxTurnMs?: number;
  readonly idleTimeoutMs?: number;
}

/** 基线 CLI 版本（实测 `system/init.claude_code_version`；SDK 0.3.263 自带该 CLI）。 */
const BASELINE_CLI_VERSION = "2.1.263";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newTurnId(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const byte of bytes) out += CROCKFORD[byte % CROCKFORD.length] ?? "0";
  return `turn_${out}${out.slice(0, 10)}`;
}

/** 设计 §2.4 的 claude-code 能力位（sandbox 为 partial → emulated，见任务书 C5）。 */
const CLAUDE_BIT_STATES: Readonly<Record<CapabilityBit, CapabilityEntry["state"]>> = {
  headless: "native",
  streaming: "native",
  resumeSession: "native",
  forkSession: "native",
  listSessions: "native",
  interruptTurn: "native",
  nativeSubagents: "native",
  toolExtension: "native",
  permissionModes: "native",
  sandboxModes: "emulated",
  modelRouting: "native",
  concurrencyControl: "unavailable",
  usageReporting: "native",
  structuredProtocol: "emulated",
  versionPinning: "native",
  multiTurn: "native",
  steerTurn: "native",
  inputInbox: "emulated",
  tokenLevelStream: "native",
  planUpdates: "unavailable",
  diffUpdates: "unavailable",
  tokenUsage: "native",
  permissionAutoReply: "native",
  permissionRequestBridge: "native",
  childSessionUpdates: "native",
  sessionArchive: "unavailable",
  sessionUnarchive: "unavailable",
  sessionDelete: "native",
  sessionExport: "emulated",
  sessionReseed: "emulated",
  worktreeIsolation: "emulated",
  backgroundRuns: "emulated",
  processKillInterrupt: "native",
  handshakeVersion: "native",
};

interface ClaudeSessionRuntime {
  readonly abiSessionId: string;
  remoteSessionId: string;
  readonly cwd: string;
  readonly profile: PermissionProfile;
  model: string | null;
  query: ClaudeQueryHandle | undefined;
  inputQueue: AsyncInputQueue<SdkUserMessage> | undefined;
  reader: Promise<void> | undefined;
  activeTurnId: string | undefined;
  /** 首次 `system/init` 到达后 resolve（stream 模式下 init 在首次输入后才发，故不能 open 等它）。 */
  handshake: Deferred<void> | undefined;
  /** init 断言失败（版本/会话 id）：后续 send 立即失败，不再装作可用。 */
  versionError: AdapterError | undefined;
  /** 非空表示本次 query 是"resume 到该 id"（init 回来时回填 remoteSessionId）。 */
  resuming: string | undefined;
  closed: boolean;
  sawTurn: boolean;
}

/** 单消费者事件队列（Broker 是唯一消费者）。 */
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
    const iterator: AsyncIterableIterator<AdapterEvent> = {
      next: (): Promise<IteratorResult<AdapterEvent>> => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolveNext) => {
          this.#waiters.push(resolveNext);
        });
      },
      [Symbol.asyncIterator](): AsyncIterableIterator<AdapterEvent> {
        return iterator;
      },
    };
    return iterator;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => AdapterError): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class ClaudeCodeAdapter implements BackendAdapter {
  readonly backendId = "claude-code" as const;
  readonly #options: ClaudeCodeAdapterOptions;
  readonly #sdk: ClaudeSdkClient;
  readonly #prober: SessionProber;
  readonly #queue = new AdapterEventQueue();
  readonly #sessions = new Map<string, ClaudeSessionRuntime>();
  readonly #mapper: ClaudeEventMapper;
  #declaration: CapabilityDeclaration | undefined;
  #disposed = false;
  readonly #turnByRemote = new Map<string, string>();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#options = options;
    this.#sdk = new ClaudeSdkClient(options.sdkLoader);
    this.#prober = options.sessionProber ?? createFileSessionProber();
    this.#mapper = new ClaudeEventMapper({
      resolveTurnId: (remoteTurnId) => {
        let abi = this.#turnByRemote.get(remoteTurnId);
        if (abi === undefined) {
          abi = newTurnId();
          this.#turnByRemote.set(remoteTurnId, abi);
        }
        return abi;
      },
      ...(options.model === undefined ? {} : { model: options.model }),
      onConversationReset: (newSessionId) => {
        for (const session of this.#sessions.values()) {
          if (session.remoteSessionId.length === 0 || session.remoteSessionId === this.#mapper.sessionId) {
            session.remoteSessionId = newSessionId;
          }
        }
      },
    });
  }

  /**
   * 握手实测的能力声明。
   * @throws `capability.missing`：`open()` 尚未执行。
   */
  get capabilities(): CapabilityDeclaration {
    if (this.#declaration === undefined) {
      throw adapterError("capability.missing", {
        message: "claude-code capabilities are only available after a successful open() handshake",
        details: { kind: "capability.missing", missingBits: ["headless"] },
      });
    }
    return this.#declaration;
  }

  get droppedCounts(): Readonly<Record<string, number>> {
    return this.#mapper.droppedCounts();
  }

  get sessionIds(): readonly string[] {
    return [...this.#sessions.values()].map((session) => session.remoteSessionId);
  }

  /**
   * ABI `session.create` 的后端侧：启动 query（stream-input 模式），返回**客户端预生成**的
   * session id（`Options.sessionId`）。
   *
   * 产品事实：Agent SDK 在 stream-input 模式下，`system/init` 要等首次输入写入后才发出
   * （置 `deferSpawn:false` 也无效）；因此 open() 不能等 init，否则必然 60s 超时。
   * 我们改用 SDK 的 `sessionId` 选项在 open 时钉死会话 id（UUID），`init` 在首个 `send()`
   * 内完成版本/会话断言（见 `#readLoop`），失败即 fail-closed。
   */
  async open(request: AdapterOpenRequest): Promise<AdapterOpenResult> {
    if (this.#disposed) throw adapterError("transport.disconnected", { message: "adapter disposed" });
    if (this.#sessions.has(request.sessionId)) {
      throw adapterError("session.conflict", { message: `session already open: ${request.sessionId}` });
    }
    const cwd = this.#validateCwd(request.cwd);
    const seamCap = this.#seamCapacity();
    const profile = request.permissionProfile ?? "read-only";
    const session: ClaudeSessionRuntime = {
      abiSessionId: request.sessionId,
      remoteSessionId: randomUUID(),
      cwd,
      profile,
      model: request.model ?? this.#options.model ?? null,
      query: undefined,
      inputQueue: undefined,
      reader: undefined,
      activeTurnId: undefined,
      handshake: undefined,
      versionError: undefined,
      resuming: undefined,
      closed: false,
      sawTurn: false,
    };
    await this.#startQuery(session);
    this.#sessions.set(request.sessionId, session);
    this.#declaration = this.#declarationFor(seamCap);
    return { remoteSessionId: session.remoteSessionId, capabilities: this.#declaration };
  }

  /** ABI `session.send`：把用户消息推入输入流（模式 A：长驻 query + streamInput）。 */
  async send(request: AdapterSendRequest): Promise<AdapterSendResult> {
    if (this.#disposed) throw adapterError("transport.disconnected", { message: "adapter disposed" });
    const session = this.#sessionOf(request.sessionId, request.remoteSessionId);
    if (session.versionError !== undefined) throw session.versionError;
    if (session.query === undefined || session.inputQueue === undefined || session.closed) {
      // 冷恢复/被中断后的兜底：用 resume 重建查询。
      if (session.remoteSessionId.length > 0) await this.#startQuery(session, { resumeSessionId: session.remoteSessionId });
      else throw adapterError("session.not-found", { message: `session has no claude session id: ${request.sessionId}` });
    }
    const turnId = newTurnId();
    this.#mapper.createTurn(turnId);
    session.activeTurnId = turnId;
    session.sawTurn = true;
    const message = toSdkUserMessage(request.input, session.remoteSessionId);
    session.inputQueue?.push(message);
    // init 在首次输入后才会到：send 内完成握手断言（超时 → transport.timeout，fail-closed）。
    const handshake = session.handshake;
    if (handshake !== undefined) {
      try {
        await withTimeout(handshake.promise, this.#options.initTimeoutMs ?? 30_000, () =>
          mapInitTimeout(this.#options.initTimeoutMs ?? 30_000),
        );
      } catch (cause) {
        session.query?.close();
        throw asAdapterError(cause);
      }
    }
    return { turnId };
  }

  /** ABI `session.resume`：先只读探测，再 `resume` 重建查询（已在线则直接返回）。 */
  async resume(request: AdapterResumeRequest): Promise<AdapterResumeResult> {
    const session = this.#sessions.get(request.sessionId);
    const remoteSessionId = session?.remoteSessionId ?? request.remoteSessionId;
    if (remoteSessionId.length === 0) return { exists: false, reason: "no-session-id" };
    const online = session !== undefined && session.query !== undefined && !session.closed;
    if (online) return { exists: true, remoteSessionId: session.remoteSessionId };
    const probed = await this.#prober.exists(remoteSessionId);
    if (!probed) return { exists: false, reason: "not-found" };
    if (session === undefined) return { exists: probed, remoteSessionId };
    if (!online) {
      try {
        // 只建立 resume 查询；init 在首个 send 内验证（stream 模式限制，见 open 注释）。
        await this.#startQuery(session, { resumeSessionId: remoteSessionId });
        return { exists: true, remoteSessionId };
      } catch (cause) {
        const error = classifyResumeFailure(probed, cause);
        if (error.code === "session.not-found") return { exists: false, reason: "not-found" };
        throw error;
      }
    }
    return { exists: true, remoteSessionId: session.remoteSessionId };
  }

  /** ABI `session.interrupt`：SDK `Query.interrupt()`；本轮终态映射为 `turn.aborted`。 */
  async interrupt(request: AdapterInterruptRequest): Promise<void> {
    const session = this.#sessions.get(request.sessionId);
    if (session === undefined) return; // 幂等：会话已不在本适配器
    this.#mapper.markInterrupted(request.turnId ?? session.activeTurnId);
    if (session.query !== undefined && !session.query.closed) {
      await session.query.interrupt();
    }
  }

  /** ABI `session.close`：关 query（SDK 负责终止其 CLI 子进程）+ 关输入流。 */
  async close(request: AdapterCloseRequest): Promise<void> {
    const session = this.#sessions.get(request.sessionId);
    if (session !== undefined) {
      this.#sessions.delete(request.sessionId);
      await this.#shutdownSession(session, `session closed (${request.reason})`);
    }
    if (this.#sessions.size === 0) await this.dispose();
  }

  events(): AsyncIterable<AdapterEvent> {
    return this.#queue;
  }

  /** 停止所有查询并结束事件流（close 后自动调用；测试可直接调用）。 */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of [...this.#sessions.values()]) {
      await this.#shutdownSession(session, "adapter disposed");
    }
    this.#sessions.clear();
    this.#queue.push({ type: "transport.state-changed", payload: { transport: "agent-sdk", state: "closed", detail: "adapter disposed" } });
    this.#queue.close();
  }

  /* ------------------------------------------------------------------ 内部 */

  #sessionOf(sessionId: string, remoteSessionId: string): ClaudeSessionRuntime {
    const session = this.#sessions.get(sessionId);
    if (session !== undefined) return session;
    if (remoteSessionId.length === 0) {
      throw adapterError("session.not-found", { message: `session not open: ${sessionId}` });
    }
    const created: ClaudeSessionRuntime = {
      abiSessionId: sessionId,
      remoteSessionId,
      cwd: process.cwd(),
      profile: "read-only",
      model: this.#options.model ?? null,
      query: undefined,
      inputQueue: undefined,
      reader: undefined,
      activeTurnId: undefined,
      handshake: undefined,
      versionError: undefined,
      resuming: undefined,
      closed: false,
      sawTurn: true,
    };
    this.#sessions.set(sessionId, created);
    return created;
  }

  async #startQuery(
    session: ClaudeSessionRuntime,
    resume?: { resumeSessionId: string; forkSession?: boolean },
  ): Promise<void> {
    const inputQueue = new AsyncInputQueue<SdkUserMessage>();
    const abortController = new AbortController();
    const handshake = deferred<void>();
    // 未被 send 等待时（如 open 后立即 close）避免 unhandled rejection；send 仍 await 原 promise。
    handshake.promise.catch(() => undefined);
    session.handshake = handshake;
    session.resuming = resume?.resumeSessionId;
    const canUseTool = createCanUseTool({
      profile: session.profile,
      onDecision: (record) => this.#emitPermission(session, record),
    });
    const mode = this.#options.permissionMode ?? permissionModeFor(session.profile);
    const options = {
      cwd: session.cwd,
      permissionProfile: session.profile,
      permissionMode: mode,
      model: session.model,
      resumeSessionId: resume?.resumeSessionId,
      forkSession: resume?.forkSession,
      // 新建会话钉死 UUID（resume 时由 SDK 从会话文件读 id，二者互斥）。
      sessionId: resume === undefined ? session.remoteSessionId : undefined,
      env: this.#options.env,
      claudeCodeExecutable: this.#options.claudeCodeExecutable,
      canUseTool,
      abortController,
      ...(this.#options.maxTurns === undefined ? {} : { maxTurns: this.#options.maxTurns }),
    };
    let handle: ClaudeQueryHandle;
    try {
      handle = await this.#sdk.startQuery(inputQueue, this.#buildOptions(options));
    } catch (cause) {
      throw asAdapterError(cause);
    }
    session.query = handle;
    session.inputQueue = inputQueue;
    session.closed = false;
    session.reader = this.#readLoop(session, handle, inputQueue, handshake, abortController);
  }

  #buildOptions(input: {
    cwd: string;
    permissionProfile: PermissionProfile;
    permissionMode: string;
    model: string | null;
    resumeSessionId?: string;
    forkSession?: boolean;
    sessionId?: string;
    env?: NodeJS.ProcessEnv;
    claudeCodeExecutable?: string;
    canUseTool: ReturnType<typeof createCanUseTool>;
    abortController: AbortController;
    maxTurns?: number;
  }): Record<string, unknown> {
    return buildQueryOptions(
      {
        cwd: input.cwd,
        permissionProfile: input.permissionProfile,
        permissionMode: input.permissionMode,
        model: input.model,
        resumeSessionId: input.resumeSessionId,
        forkSession: input.forkSession,
        sessionId: input.sessionId,
        env: input.env,
        claudeCodeExecutable: input.claudeCodeExecutable,
        canUseTool: input.canUseTool,
        abortController: input.abortController,
        maxTurns: input.maxTurns,
      },
      input.permissionMode,
      disallowedToolsFor(input.permissionProfile),
    );
  }

  async #readLoop(
    session: ClaudeSessionRuntime,
    handle: ClaudeQueryHandle,
    inputQueue: AsyncInputQueue<SdkUserMessage>,
    handshake: Deferred<void>,
    _abortController: AbortController,
  ): Promise<void> {
    let failure: AdapterError | undefined;
    try {
      for await (const raw of handle.raw) {
        const message = raw as SdkMessage;
        if (message.type === "system" && message.subtype === "init") {
          const initMessage = message as unknown as {
            session_id?: string;
            claude_code_version?: string;
            model?: string;
            cwd?: string;
          };
          const version = initMessage.claude_code_version;
          const expected = this.#options.expectedCliVersion === undefined ? BASELINE_CLI_VERSION : this.#options.expectedCliVersion;
          if (expected !== null && version !== expected) {
            failure = adapterError("protocol.version-mismatch", {
              message: `claude CLI version mismatch: expected ${expected}, got ${String(version)}`,
              details: { kind: "protocol.version-mismatch", expected, actual: String(version) },
            });
            session.versionError = failure;
            handshake.reject(failure);
            break;
          }
          const sessionId = initMessage.session_id;
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            failure = adapterError("protocol.unexpected-response", { message: "init without session_id" });
            session.versionError = failure;
            handshake.reject(failure);
            break;
          }
          if (session.resuming !== undefined) {
            // resume 场景：以 init 返回的 id 为准回填（fork 可能产生新 id）。
            session.remoteSessionId = sessionId;
          } else if (sessionId !== session.remoteSessionId) {
            failure = adapterError("protocol.unexpected-response", {
              message: `init session_id mismatch: expected ${session.remoteSessionId}, got ${sessionId}`,
              details: { kind: "protocol.unexpected-response" },
            });
            session.versionError = failure;
            handshake.reject(failure);
            break;
          }
          session.resuming = undefined;
          if (typeof initMessage.model === "string") {
            session.model = initMessage.model;
            this.#mapper.setModel(initMessage.model);
          }
          handshake.resolve();
        }
        for (const event of this.#mapper.handleMessage(message)) this.#queue.push(event);
      }
    } catch (cause) {
      failure = asAdapterError(cause);
    } finally {
      inputQueue.close();
      if (failure !== undefined) {
        // init 未完成时让发送方得到明确分类；已完成的轮次按 lost 处理。
        handshake.reject(failure);
        this.#queue.push({
          type: "session.lost",
          payload: { reason: failure.message.slice(0, 160), lastKnownSeq: 0 },
        });
        this.#queue.push({
          type: "transport.state-changed",
          payload: { transport: "agent-sdk", state: "failed", detail: failure.code.slice(0, 200) },
        });
      } else {
        handshake.reject(adapterError("process.crashed", { message: "claude query ended before init" }));
      }
      session.closed = true;
    }
  }

  async #shutdownSession(session: ClaudeSessionRuntime, reason: string): Promise<void> {
    session.closed = true;
    session.inputQueue?.close();
    session.query?.close();
    try {
      await session.reader;
    } catch {
      // reader 的错误已经在事件流里表达
    }
    this.#queue.push(this.#mapper.diagnostic("debug", `session ${session.abiSessionId}: ${reason}`));
  }

  #emitPermission(session: ClaudeSessionRuntime, record: PermissionDecisionRecord): void {
    const requestId = record.toolUseId ?? `${session.abiSessionId}:${record.toolName}`;
    this.#queue.push({
      type: "permission.requested",
      turnId: session.activeTurnId,
      payload: {
        requestId: requestId.slice(0, 128),
        tool: record.toolName.slice(0, 128),
        risk: record.risk,
        options: [],
        summary: record.reason.slice(0, 400),
      },
    });
    this.#queue.push({
      type: "permission.resolved",
      turnId: session.activeTurnId,
      payload: {
        requestId: requestId.slice(0, 128),
        decision: record.decision === "allow" ? "allow-once" : "deny",
        by: "policy",
        reason: record.reason.slice(0, 160),
      },
    });
    if (record.decision === "deny" && record.timedOut) {
      this.#queue.push({
        type: "session.warning",
        payload: { code: "permission-policy-timeout", message: `canUseTool timed out for ${record.toolName}`, degrade: true },
      });
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

  #seamCapacity(): number {
    const runtime = this.#options.runtime;
    if (runtime === undefined) {
      throw adapterError("capability.missing", {
        message: "runtime provider is required to derive limits (D-016)",
        details: { kind: "capability.missing", missingBits: ["concurrencyControl"] },
      });
    }
    let capacity: number;
    try {
      capacity = runtime.read().maxActiveSubagents;
    } catch (cause) {
      throw adapterError("capability.missing", {
        message: `failed to read runtime.maxActiveSubagents: ${cause instanceof Error ? cause.message : String(cause)}`,
        details: { kind: "capability.missing", missingBits: ["concurrencyControl"] },
      });
    }
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw adapterError("capability.missing", {
        message: `runtime.maxActiveSubagents is invalid: ${String(capacity)}`,
        details: { kind: "capability.missing", missingBits: ["concurrencyControl"] },
      });
    }
    return capacity;
  }

  #declarationFor(seamCap: number): CapabilityDeclaration {
    const bits: CapabilityEntry[] = CAPABILITY_BITS.map((bit) => {
      const state = CLAUDE_BIT_STATES[bit];
      const detail =
        bit === "sandboxModes"
          ? "SDK options.sandbox + permission rules；无 CLI flag，生效未实测（partial）"
          : bit === "concurrencyControl"
            ? "产品无全局并发配置键；由 Broker 运行时信号量强制（D-016）"
            : undefined;
      return { bit, state, ...(detail === undefined ? {} : { detail }) };
    });
    return {
      abiVersion: "0.1",
      backendId: "claude-code",
      backendVersion: "0.3.263+2.1.263",
      transport: "agent-sdk",
      nativeProtocolVersion: "sdk-0.3.263/cli-2.1.263",
      bits,
      limits: {
        maxTurnMs: this.#options.maxTurnMs ?? 1_800_000,
        idleTimeoutMs: this.#options.idleTimeoutMs ?? 120_000,
        maxSessionsPerBackend: seamCap,
        maxNestingDepth: 1,
        maxConcurrentTurns: seamCap,
      },
      warnings: [
        "concurrencyControl=unavailable：并发上限只由运行时 seam 派生",
        "sandboxModes=emulated：SDK sandbox 生效未实测（partial）",
        "maxNestingDepth=1：产品无可强制的嵌套上限",
      ],
      observedAt: new Date().toISOString(),
    };
  }
}

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(options);
}

/** 只读工具白名单再导出，便于集成层与测试复用。 */
export { READ_ONLY_ALLOWED_TOOLS };

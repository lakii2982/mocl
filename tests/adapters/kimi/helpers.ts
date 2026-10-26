/**
 * C6 kimi 适配器测试假件（默认零额度；不 spawn 真实 `kimi acp`）。
 *
 * 提供：
 * - `fixedRuntime` / `failingRuntime` / `invalidRuntime`：D-016 运行时派生容量；
 * - `FakeTransport`：ACP stdio 行管道（记录出站帧、注入入站帧/反向请求）；
 * - `FakeAcp`：`KimiAcpApi` 假实现（适配器测试用）；
 * - `FakeProcess` / `fakeProcessFactory`：进程句柄假件（记录 kill 信号与 pgid）；
 * - `ScriptedPromptRunner`：CLI 兜底通道假执行器；
 * - `drainUntil` / `drainAvailable`：从 `events()` 迭代器收集事件；
 * - `makeTempDir` / 配置探针假件。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import type { RuntimeConfigProvider, RuntimeSnapshot } from "../../../src/broker/concurrency.ts";
import { moclError, type MoclError } from "../../../src/broker/errors.ts";
import type {
  AcpTransport,
  KimiAcpApi,
  KimiAcpClientOptions,
  PermissionRequestParams,
} from "../../../src/adapters/kimi/acp-client.ts";
import type {
  KimiAcpInitResult,
  KimiConfigProbe,
  KimiNewSessionResult,
  KimiPromptResult,
  KimiSessionSummary,
  KimiSessionUpdateParams,
} from "../../../src/adapters/kimi/types.ts";
import type { KimiProcessHandle, KimiProcessSpec } from "../../../src/adapters/kimi/index.ts";
import type { PromptProcessResult, PromptRunner } from "../../../src/adapters/kimi/prompt-client.ts";

/* ---------------------------- runtime ---------------------------- */

export function fixedRuntime(capacity: number): RuntimeConfigProvider {
  return { read: (): RuntimeSnapshot => ({ maxActiveSubagents: capacity }) };
}

export function failingRuntime(): RuntimeConfigProvider {
  return {
    read: (): RuntimeSnapshot => {
      throw new Error("runtime unavailable");
    },
  };
}

export function invalidRuntime(): RuntimeConfigProvider {
  return { read: (): RuntimeSnapshot => ({ maxActiveSubagents: 0 }) };
}

/* ---------------------------- config probe ---------------------------- */

/** 可读且档位可控的 config.toml 探针（§7.5）。 */
export function configProbe(mode: string | null, planMode = false): () => KimiConfigProbe {
  return () => ({
    defaultModel: "kimi-code/k3.1-pro",
    defaultPermissionMode: mode,
    defaultPlanMode: planMode,
    readable: mode !== null,
  });
}

export function unreadableConfigProbe(): () => KimiConfigProbe {
  return () => ({ defaultModel: null, defaultPermissionMode: null, defaultPlanMode: null, readable: false });
}

/* ---------------------------- ACP transport ---------------------------- */

/** 内存 stdio 管道：`writeLine` 记录出站帧；测试可用 `sendFromServer` 注入入站帧。 */
export class FakeTransport implements AcpTransport {
  readonly written: string[] = [];
  readonly killSignals: ("SIGTERM" | "SIGKILL")[] = [];
  readonly pgid: number;
  closed = false;
  readonly #lineHandlers: ((line: string) => void)[] = [];
  readonly #closeHandlers: (() => void)[] = [];

  constructor(pgid = 4242) {
    this.pgid = pgid;
  }

  writeLine(line: string): void {
    this.written.push(line);
  }

  onLine(handler: (line: string) => void): void {
    this.#lineHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.#closeHandlers.push(handler);
  }

  signal(signal: "SIGTERM" | "SIGKILL"): void {
    this.killSignals.push(signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.#closeHandlers) handler();
  }

  /* ---- 测试注入面 ---- */

  sendFromServer(message: Readonly<Record<string, unknown>>): void {
    const line = JSON.stringify(message);
    for (const handler of this.#lineHandlers) handler(line);
  }

  sendRaw(line: string): void {
    for (const handler of this.#lineHandlers) handler(line);
  }

  respond(id: number, result: Readonly<Record<string, unknown>>): void {
    this.sendFromServer({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number, code: number, message: string, data?: unknown): void {
    this.sendFromServer({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  notify(method: string, params: Readonly<Record<string, unknown>>): void {
    this.sendFromServer({ jsonrpc: "2.0", method, params });
  }

  serverRequest(id: number, method: string, params: Readonly<Record<string, unknown>>): void {
    this.sendFromServer({ jsonrpc: "2.0", id, method, params });
  }

  /** 解析出站帧。 */
  requests(): { readonly id: number; readonly method: string; readonly params: Readonly<Record<string, unknown>> }[] {
    return this.written
      .map((line) => JSON.parse(line) as { id?: number; method?: string; params?: Readonly<Record<string, unknown>> })
      .filter((frame): frame is { id: number; method: string; params: Readonly<Record<string, unknown>> } =>
        typeof frame.id === "number" && typeof frame.method === "string")
      .map((frame) => ({ id: frame.id, method: frame.method, params: frame.params ?? {} }));
  }

  lastRequest(): { readonly id: number; readonly method: string; readonly params: Readonly<Record<string, unknown>> } {
    const all = this.requests();
    const last = all.at(-1);
    if (last === undefined) throw new Error("no request written");
    return last;
  }

  /** 最后一条帧（可能是响应）。 */
  lastFrame(): Readonly<Record<string, unknown>> {
    const line = this.written.at(-1);
    if (line === undefined) throw new Error("no frame written");
    return JSON.parse(line) as Readonly<Record<string, unknown>>;
  }

  /** 自动应答：把所有已发出的请求都回成功（`initialize` / `session/*`）。 */
  autoRespond(handlers: Readonly<Record<string, (params: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>>> = {}): void {
    for (const request of this.requests()) {
      const handler = handlers[request.method];
      const result = handler === undefined ? {} : handler(request.params);
      this.respond(request.id, result);
    }
  }
}

/** 便捷构造：默认 `initialize` 结果（kimi 2.3.1 实测形状）。 */
export function kimiInitResult(overrides: Partial<KimiAcpInitResult> = {}): KimiAcpInitResult {
  return {
    protocolVersion: 1,
    agentInfo: { name: "Kimi Code CLI", version: "2.3.1" },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {}, additionalDirectories: {} },
      mcpCapabilities: { http: true, sse: true },
      auth: { logout: {} },
    },
    authMethods: [{ id: "login", type: "terminal" }],
    ...overrides,
  };
}

/* ---------------------------- FakeAcp ---------------------------- */

let fakeSessionSeq = 0;

/** `KimiAcpApi` 假实现（记录调用、可注入错误）。每个实例有**唯一** remote session id。 */
export class FakeAcp implements KimiAcpApi {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
  readonly configOptionCalls: { readonly configId: string; readonly value: string }[] = [];
  readonly modeCalls: string[] = [];
  initResult: KimiAcpInitResult = kimiInitResult();
  newSessionResult: KimiNewSessionResult = {
    sessionId: `session_fake_${String(++fakeSessionSeq).padStart(4, "0")}`,
    configOptions: [
      { id: "model", currentValue: "kimi-code/k3.1-pro" },
      { id: "thinking", currentValue: "max" },
      { id: "mode", currentValue: "default" },
    ],
    modes: { currentModeId: "default", availableModes: [{ id: "plan" }, { id: "auto" }, { id: "yolo" }] },
  };
  promptResult: KimiPromptResult = { stopReason: "end_turn" };
  promptError: MoclError | undefined;
  /** 挂住 prompt 直到 `releasePrompt()`（模拟"轮进行中"，用于中断测试）。 */
  #gate: { readonly promise: Promise<void>; readonly release: () => void } | null = null;
  initError: MoclError | undefined;
  newSessionError: MoclError | undefined;
  loadError: MoclError | undefined;
  setModeError: MoclError | undefined;
  setConfigOptionError: MoclError | undefined;
  closeError: MoclError | undefined;
  reverseHandlersRegistered = true;
  terminated = false;
  promptCount = 0;
  loadCount = 0;
  #updateHandler: ((params: KimiSessionUpdateParams) => void) | undefined;
  readonly #permissionHandlerHolder: { handler?: KimiAcpClientOptions["permissionHandler"] };

  constructor(permissionHolder: { handler?: KimiAcpClientOptions["permissionHandler"] } = {}) {
    this.#permissionHandlerHolder = permissionHolder;
  }

  onUpdate(handler: (params: KimiSessionUpdateParams) => void): void {
    this.#updateHandler = handler;
  }

  /** 测试：模拟服务端推送 `session/update`。 */
  emitUpdate(params: KimiSessionUpdateParams): void {
    this.#updateHandler?.(params);
  }

  /** 测试：模拟服务端发起权限请求（走真实 permissionHandler）。 */
  async permissionRequest(params: PermissionRequestParams): Promise<{ readonly optionId: string } | null> {
    return (await this.#permissionHandlerHolder.handler?.(params)) ?? null;
  }

  async initialize(): Promise<KimiAcpInitResult> {
    this.calls.push({ method: "initialize", args: [] });
    if (this.initError !== undefined) throw this.initError;
    return this.initResult;
  }

  async newSession(request: { readonly cwd: string }): Promise<KimiNewSessionResult> {
    this.calls.push({ method: "session/new", args: [request] });
    if (this.newSessionError !== undefined) throw this.newSessionError;
    return this.newSessionResult;
  }

  async loadSession(request: { readonly sessionId: string; readonly cwd: string }): Promise<Record<string, never>> {
    this.calls.push({ method: "session/load", args: [request] });
    this.loadCount += 1;
    if (this.loadError !== undefined) throw this.loadError;
    return {};
  }

  /** 让下一次/当前 prompt 挂起，直到 `releasePrompt()`。 */
  holdPrompt(): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#gate = { promise, release };
  }

  releasePrompt(): void {
    this.#gate?.release();
    this.#gate = null;
  }

  async prompt(sessionId: string, text: string): Promise<KimiPromptResult> {
    this.promptCount += 1;
    this.calls.push({ method: "session/prompt", args: [sessionId, text] });
    if (this.#gate !== null) await this.#gate.promise;
    if (this.promptError !== undefined) throw this.promptError;
    return this.promptResult;
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<Record<string, never>> {
    this.configOptionCalls.push({ configId, value });
    this.calls.push({ method: "session/set_config_option", args: [sessionId, configId, value] });
    if (this.setConfigOptionError !== undefined) throw this.setConfigOptionError;
    return {};
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.calls.push({ method: "session/set_model", args: [sessionId, modelId] });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.modeCalls.push(modeId);
    this.calls.push({ method: "session/set_mode", args: [sessionId, modeId] });
    if (this.setModeError !== undefined) throw this.setModeError;
  }

  async fork(sessionId: string, cwd: string): Promise<KimiNewSessionResult> {
    this.calls.push({ method: "session/fork", args: [sessionId, cwd] });
    return { sessionId: "session_forked", configOptions: [] };
  }

  async listSessions(cwd: string): Promise<readonly KimiSessionSummary[]> {
    this.calls.push({ method: "session/list", args: [cwd] });
    return [];
  }

  async closeSession(sessionId: string): Promise<void> {
    this.calls.push({ method: "session/close", args: [sessionId] });
    if (this.closeError !== undefined) throw this.closeError;
  }

  async tryCancel(): Promise<never> {
    throw moclError("protocol.unknown-method", { message: 'kimi does not implement session/cancel (-32601)' });
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

/* ---------------------------- 进程假件 ---------------------------- */

/** 进程句柄假件：记录 kill 信号与 pgid。 */
export class FakeProcess implements KimiProcessHandle {
  readonly acp: KissableAcp;
  readonly pgid: number;
  readonly killSignals: ("SIGTERM" | "SIGKILL")[] = [];
  killed = false;

  constructor(pgid: number, permissionHolder: { handler?: KimiAcpClientOptions["permissionHandler"] } = {}) {
    this.pgid = pgid;
    this.acp = new FakeAcp(permissionHolder) as KissableAcp;
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.killSignals.push(signal);
    this.killed = true;
  }
}

type KissableAcp = FakeAcp & KimiAcpApi;

export interface FactoryHarness {
  readonly factory: (spec: KimiProcessSpec) => FakeProcess;
  readonly created: FakeProcess[];
  readonly specs: KimiProcessSpec[];
}

/**
 * 进程工厂假件：每个 `open()` 产生**新的**进程句柄（"一任务一进程"断言基础）。
 *
 * 权限 handler 由 spec 传入 → 塞进 FakeAcp，使 `permissionRequest()` 能走真实策略。
 */
export function fakeProcessFactory(startPgid = 5000): FactoryHarness {
  const created: FakeProcess[] = [];
  const specs: KimiProcessSpec[] = [];
  const factory = (spec: KimiProcessSpec): FakeProcess => {
    const holder: { handler?: KimiAcpClientOptions["permissionHandler"] } = { handler: spec.permissionHandler };
    const process = new FakeProcess(startPgid + created.length, holder);
    created.push(process);
    specs.push(spec);
    return process;
  };
  return { factory, created, specs };
}

/* ---------------------------- CLI runner 假件 ---------------------------- */

/** 按脚本返回 stdout 行的假执行器（`-p --output-format stream-json`）。 */
export class ScriptedPromptRunner implements PromptRunner {
  readonly calls: { readonly argv: readonly string[]; readonly cwd: string }[] = [];
  stdoutLines: string[] = [];
  exitCode: number | null = 0;
  signal: NodeJS.Signals | null = null;
  stderr = "";
  timedOut = false;
  #onRun: (() => void) | undefined;

  onRun(callback: () => void): void {
    this.#onRun = callback;
  }

  async run(argv: readonly string[], options: { readonly cwd: string }): Promise<PromptProcessResult> {
    this.calls.push({ argv, cwd: options.cwd });
    this.#onRun?.();
    return {
      exitCode: this.exitCode,
      signal: this.signal,
      stdoutLines: [...this.stdoutLines],
      stderr: this.stderr,
      timedOut: this.timedOut,
    };
  }
}

/* ---------------------------- 事件收集 ---------------------------- */

/** 收集事件直到 predicate 满足或超时。 */
export async function drainUntil(
  iterable: AsyncIterable<AdapterEvent>,
  predicate: (events: readonly AdapterEvent[]) => boolean,
  timeoutMs = 2_000,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  const pump = (async () => {
    for await (const event of iterable) {
      events.push(event);
      if (predicate(events)) return;
    }
  })();
  await Promise.race([pump, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  pump.catch(() => undefined);
  return events;
}

export function typeOf(event: AdapterEvent): string {
  return event.type;
}

export function typesOf(events: readonly AdapterEvent[]): string[] {
  return events.map((event) => event.type);
}

/* ---------------------------- 临时目录 ---------------------------- */

export async function makeTempDir(): Promise<{ readonly dir: string; readonly cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mocl-c6-"));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function writeTempFile(dir: string, name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

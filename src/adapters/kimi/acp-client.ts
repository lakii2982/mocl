/**
 * kimi ACP over stdio 客户端（docs/adapters/kimi.md §2.2/§2.3/§9.3；LEDGER **D-003**）。
 *
 * 三条不可协商的约束（每一条都来自实测事故，不是设计偏好）：
 *
 * 1. **必须实现 `fs/read_text_file`，且任何分支都必须回包**。
 *    实测对照：客户端不实现时 `session/prompt` 会**永久静默挂住**——无错误、无超时（kimi.md:292-307）。
 *    → 构造函数**先注册**反向 handler（`§2.3` "先注册、fail-closed、绝不挂起"），
 *      并提供 `assertStartable()` 供适配器在握手前做启动守卫。
 * 2. **`session/prompt` 没有内置超时** → 双层兜底：空闲看门狗（默认 60s 无任何帧）+
 *    单轮硬超时（`maxTurnMs`）。看门狗触发 → `transport.timeout` 并通过 `onHung` 让上层 killpg。
 * 3. **`session/cancel` 不存在**（`-32601`，kimi.md:240）→ 本客户端**从不**在中断路径调用它；
 *    `tryCancel()` 只作为诊断/契约测试入口存在，其错误码映射即"缺位证据"。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { moclError, MoclError } from "../../broker/errors.ts";
import { mapJsonRpcError, sanitize } from "./errors.ts";
import type {
  KimiAcpInitResult,
  KimiConfigOption,
  KimiNewSessionResult,
  KimiPermissionOption,
  KimiPromptResult,
  KimiSessionSummary,
  KimiSessionUpdateParams,
} from "./types.ts";

/** ACP 帧传输抽象（真实 = 子进程 stdio；测试 = 内存管道）。 */
export interface AcpTransport {
  writeLine(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
  /** 进程组信号（真实 transport 实现；测试可省略）。 */
  signal?(signal: "SIGTERM" | "SIGKILL"): void;
  /** 进程组 id（真实 transport 提供；用于 K9 "一任务一进程" 断言）。 */
  readonly pgid?: number;
}

/** 权限请求的原生 option（实测 3 个，kimi.md:282-286）。 */
export interface PermissionRequestParams {
  /** JSON-RPC 的 id（适配器用它做 ABI `permission.requested.requestId`）。 */
  readonly requestId?: number | string;
  readonly sessionId: string;
  readonly toolCall?: Readonly<Record<string, unknown>>;
  readonly options?: readonly KimiPermissionOption[];
}

/** 适配器依赖的最小 ACP 面（便于注入假实现）。 */
export interface KimiAcpApi {
  initialize(clientInfo: { readonly name: string; readonly version: string }): Promise<KimiAcpInitResult>;
  newSession(request: { readonly cwd: string; readonly mcpServers?: readonly unknown[] }): Promise<KimiNewSessionResult>;
  loadSession(request: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers?: readonly unknown[];
  }): Promise<{ readonly configOptions?: readonly KimiConfigOption[]; readonly modes?: unknown }>;
  prompt(sessionId: string, text: string): Promise<KimiPromptResult>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ readonly configOptions?: readonly KimiConfigOption[] }>;
  setModel(sessionId: string, modelId: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  fork(sessionId: string, cwd: string): Promise<KimiNewSessionResult>;
  listSessions(cwd: string): Promise<readonly KimiSessionSummary[]>;
  closeSession(sessionId: string): Promise<void>;
  /** 诊断/契约测试用：`session/cancel` 在 kimi 上必 `-32601`（运行期禁止用于中断）。 */
  tryCancel(sessionId: string): Promise<never>;
  onUpdate(handler: (params: KimiSessionUpdateParams) => void): void;
  terminate(): Promise<void>;
  /** 反向 handler 是否已注册（启动守卫，§2.3）。 */
  readonly reverseHandlersRegistered: boolean;
}

export interface KimiAcpClientOptions {
  readonly transport: AcpTransport;
  /** 普通请求超时（`initialize` 建议 15s；ABI §4）。默认 30s。 */
  readonly timeoutMs?: number;
  /** **静默挂死看门狗**：prompt 期间连续这么久没有任何帧 → `transport.timeout`（D-003）。默认 60_000。 */
  readonly watchdogMs?: number;
  /** 单轮硬超时（ABI M2 默认 1_800_000）。 */
  readonly maxTurnMs?: number;
  /** `fs/read_text_file` 允许根（绝对路径）；空数组 = 拒绝一切读（fail-closed）。 */
  readonly allowedRoots?: readonly string[];
  /** 是否允许 `fs/write_text_file`（默认 false）。 */
  readonly allowWrite?: boolean;
  /** 单文件读取上限（默认 1 MiB）。 */
  readonly maxFileBytes?: number;
  /** `session/request_permission` 的应答钩子（默认 reject；适配器注入策略）。 */
  readonly permissionHandler?: (
    params: PermissionRequestParams,
  ) => Promise<{ readonly optionId: string } | null>;
  /** 看门狗/硬超时触发时通知上层（上层负责 killpg + 事件）。 */
  readonly onHung?: (reason: "idle" | "turn-timeout") => void;
  /** 帧变化时通知（供上层实现 `transport.state-changed`；可选）。 */
  readonly onFrame?: () => void;
  /**
   * **仅测试用**：关掉反向 handler 注册以复现"不实现 fs/read_text_file 必挂死"（K2 负向测试）。
   * 生产路径绝不能传 true —— `assertStartable()` 会拒绝启动。
   */
  readonly disableReverseHandlers?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WATCHDOG_MS = 60_000;
const DEFAULT_MAX_TURN_MS = 1_800_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
/** 连续坏帧阈值（§5.2 #27：连续 5 帧 → `protocol.bad-frame`）。 */
const MAX_CONSECUTIVE_BAD_FRAMES = 5;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: Readonly<Record<string, unknown>>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 反向请求处理时的"必须回包"错误（带 JSON-RPC code）。 */
class JsonRpcRespondError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "JsonRpcRespondError";
  }
}

export class KimiAcpClient implements KimiAcpApi {
  readonly #transport: AcpTransport;
  readonly #timeoutMs: number;
  readonly #watchdogMs: number;
  readonly #maxTurnMs: number;
  readonly #allowedRoots: readonly string[];
  readonly #allowWrite: boolean;
  readonly #maxFileBytes: number;
  readonly #permissionHandler: KimiAcpClientOptions["permissionHandler"];
  readonly #onHung: KimiAcpClientOptions["onHung"];
  readonly #onFrame: KimiAcpClientOptions["onFrame"];
  readonly #pending = new Map<number, PendingRequest>();
  #updateHandler: ((params: KimiSessionUpdateParams) => void) | undefined;
  #nextId = 1;
  #terminated = false;
  #reverseHandlersRegistered = false;
  #badFrames = 0;
  #rootsPromise: Promise<readonly string[]> | null = null;

  /* 看门狗状态 */
  #watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  #promptInFlight = false;
  #framesDuringPrompt = 0;

  constructor(options: KimiAcpClientOptions) {
    this.#transport = options.transport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    this.#maxTurnMs = options.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
    this.#allowedRoots = (options.allowedRoots ?? []).map((root) => resolve(root));
    this.#allowWrite = options.allowWrite ?? false;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#permissionHandler = options.permissionHandler;
    this.#onHung = options.onHung;
    this.#onFrame = options.onFrame;

    // §2.3：反向 handler **必须先于第一帧**注册（构造函数内完成）。
    if (options.disableReverseHandlers !== true) {
      this.#reverseHandlersRegistered = true;
    }
    this.#transport.onLine((line) => this.#onLine(line));
    this.#transport.onClose(() => {
      this.#clearWatchdog();
      this.#failAllPending(moclError("transport.disconnected", { message: "kimi ACP transport closed" }));
    });
  }

  get reverseHandlersRegistered(): boolean {
    return this.#reverseHandlersRegistered;
  }

  /** 已收到的帧数（诊断：`frames.per_turn`）。 */
  get frameCount(): number {
    return this.#framesDuringPrompt;
  }

  get badFrameCount(): number {
    return this.#badFrames;
  }

  /**
   * 启动守卫（§2.3）：反向 handler 未注册 → `capability.missing`，**拒绝启动 ACP**。
   * 适配器在 `open()` 第一步调用。
   */
  assertStartable(): void {
    if (!this.#reverseHandlersRegistered) {
      throw moclError("capability.missing", {
        message: "kimi ACP cannot start without fs/read_text_file reverse handlers (prompt would hang silently)",
        details: { kind: "capability.missing", hint: "D-003：不实现 fs/read_text_file 会导致 session/prompt 永久挂死" },
      });
    }
  }

  onUpdate(handler: (params: KimiSessionUpdateParams) => void): void {
    this.#updateHandler = handler;
  }

  async initialize(clientInfo: { readonly name: string; readonly version: string }): Promise<KimiAcpInitResult> {
    this.assertStartable();
    const result = await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo,
      },
      { timeoutMs: Math.min(this.#timeoutMs, 15_000) },
    );
    const protocolVersion = result["protocolVersion"];
    if (typeof protocolVersion !== "number") {
      throw moclError("protocol.invalid-params", { message: "kimi ACP initialize missing protocolVersion" });
    }
    if (protocolVersion !== 1) {
      throw moclError("protocol.version-mismatch", {
        message: `kimi ACP protocolVersion mismatch: expected 1, got ${String(protocolVersion)}`,
      });
    }
    return result as unknown as KimiAcpInitResult;
  }

  async newSession(request: {
    readonly cwd: string;
    readonly mcpServers?: readonly unknown[];
  }): Promise<KimiNewSessionResult> {
    const result = await this.request("session/new", {
      cwd: request.cwd,
      mcpServers: request.mcpServers ?? [],
    });
    const sessionId = result["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw moclError("protocol.invalid-params", { message: "kimi ACP session/new missing sessionId" });
    }
    return result as unknown as KimiNewSessionResult;
  }

  async loadSession(request: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers?: readonly unknown[];
  }): Promise<{ readonly configOptions?: readonly KimiConfigOption[]; readonly modes?: unknown }> {
    return (await this.request("session/load", {
      sessionId: request.sessionId,
      cwd: request.cwd,
      mcpServers: request.mcpServers ?? [],
    })) as { readonly configOptions?: readonly KimiConfigOption[]; readonly modes?: unknown };
  }

  /**
   * 一轮：发 `session/prompt` 并等待响应。
   *
   * 超时语义（§9.3）：
   * - **空闲看门狗** `watchdogMs`：期间**没有任何帧**（连 `agent_thought_chunk` 都没有）→ `transport.timeout`
   *   + `onHung("idle")`（上层 killpg）。
   * - **单轮硬超时** `maxTurnMs`：`limit.turn-timeout` + `onHung("turn-timeout")`。
   */
  async prompt(sessionId: string, text: string): Promise<KimiPromptResult> {
    this.assertStartable();
    if (this.#promptInFlight) {
      throw moclError("session.locked", { message: "kimi ACP supports one prompt per session at a time" });
    }
    this.#promptInFlight = true;
    this.#framesDuringPrompt = 0;
    try {
      const result = await this.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        { timeoutMs: this.#maxTurnMs, timeoutCode: "limit.turn-timeout" },
      );
      return result as unknown as KimiPromptResult;
    } finally {
      this.#promptInFlight = false;
      this.#clearWatchdog();
    }
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ readonly configOptions?: readonly KimiConfigOption[] }> {
    return (await this.request("session/set_config_option", { sessionId, configId, value })) as {
      readonly configOptions?: readonly KimiConfigOption[];
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request("session/set_model", { sessionId, modelId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, modeId });
  }

  async fork(sessionId: string, cwd: string): Promise<KimiNewSessionResult> {
    return (await this.request("session/fork", { sessionId, cwd })) as unknown as KimiNewSessionResult;
  }

  async listSessions(cwd: string): Promise<readonly KimiSessionSummary[]> {
    const result = await this.request("session/list", { cwd });
    const sessions = result["sessions"];
    return Array.isArray(sessions) ? (sessions as readonly KimiSessionSummary[]) : [];
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId });
  }

  /**
   * **诊断/契约测试专用**：`session/cancel` 在 kimi 2.3.1 上必为 `-32601`（kimi.md:240）。
   * 中断路径绝不调用它（D-008：只能进程级 kill）。
   */
  async tryCancel(sessionId: string): Promise<never> {
    const error = await this.request("session/cancel", { sessionId }).then(
      () => null,
      (cause: unknown) => cause,
    );
    if (error === null) {
      throw moclError("protocol.unexpected-response", {
        message: "kimi unexpectedly implemented session/cancel; interrupt semantics must be re-validated",
      });
    }
    throw error instanceof Error ? error : moclError("internal.unexpected", { message: "session/cancel probe failed" });
  }

  async terminate(): Promise<void> {
    this.#terminated = true;
    this.#clearWatchdog();
    this.#failAllPending(moclError("process.killed", { message: "kimi ACP client terminated" }));
    this.#transport.close();
  }

  /**
   * 发送 JSON-RPC 请求。
   *
   * @param options.timeoutCode 超时归因（`session/prompt` 用 `limit.turn-timeout`，其余 `transport.timeout`）
   */
  async request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: { readonly timeoutMs?: number; readonly timeoutCode?: "transport.timeout" | "limit.turn-timeout" } = {},
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.#terminated) {
      throw moclError("transport.disconnected", { message: "kimi ACP client is terminated" });
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const timeoutCode = options.timeoutCode ?? "transport.timeout";
    // 看门狗也要覆盖"绕过 prompt() 直接发 session/prompt"的路径（负向测试/未来调用方）。
    const armsWatchdog = method === "session/prompt";
    if (armsWatchdog) {
      this.#framesDuringPrompt = 0;
      this.#armWatchdog();
    }
    const settle = (): void => {
      if (armsWatchdog) {
        this.#clearWatchdog();
        this.#promptInFlight = false;
      }
    };
    return await new Promise<Readonly<Record<string, unknown>>>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        settle();
        this.#pending.delete(id);
        rejectPromise(
          moclError(timeoutCode, {
            message:
              timeoutCode === "limit.turn-timeout"
                ? `kimi ${method} exceeded maxTurnMs (${timeoutMs}ms)`
                : `kimi ${method} timed out after ${timeoutMs}ms`,
          }),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (result) => {
          settle();
          resolvePromise(result);
        },
        reject: (error) => {
          settle();
          rejectPromise(error);
        },
        timer,
      });
      this.#transport.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /* ------------------------------------------------------------------ */
  /* 帧处理                                                              */
  /* ------------------------------------------------------------------ */

  #onLine(line: string): void {
    // 任何入站帧都刷新看门狗（D-003：挂死 = 完全没有帧，而不是"没有结果帧"）。
    this.#touchFrame();
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.#onBadFrame();
      return;
    }
    if (parsed === null || typeof parsed !== "object") {
      this.#onBadFrame();
      return;
    }
    this.#badFrames = 0;
    const frame = parsed as Record<string, unknown>;
    const id = frame["id"];

    if (typeof id === "number") {
      if (typeof frame["method"] === "string") {
        // 反向请求（server → client）：必须处理并**必须回包**。
        if (!this.#reverseHandlersRegistered) {
          // 负向场景（仅测试可构造）：不注册 handler 就等于"不实现 fs/read_text_file"，
          // 不回包 → 上层 prompt 将挂死 → 由看门狗兜底。
          return;
        }
        void this.#handleReverse({
          id,
          method: frame["method"],
          params: (frame["params"] ?? {}) as Readonly<Record<string, unknown>>,
        });
        return;
      }
      const pending = this.#pending.get(id);
      if (pending === undefined) {
        // 迟到/未知 id：不杀连接（§5.3 `drop.unexpected_response`）。
        return;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      const rpcError = frame["error"];
      if (rpcError !== undefined && rpcError !== null) {
        pending.reject(
          mapJsonRpcError(rpcError as { readonly code: number; readonly message: string; readonly data?: unknown }, {
            method: pending.method,
          }),
        );
      } else {
        pending.resolve((frame["result"] ?? {}) as Readonly<Record<string, unknown>>);
      }
      return;
    }

    // 通知（无 id）
    if (frame["method"] === "session/update") {
      const params = (frame["params"] ?? {}) as unknown as KimiSessionUpdateParams;
      this.#updateHandler?.(params);
    }
  }

  #onBadFrame(): void {
    this.#badFrames += 1;
    if (this.#badFrames >= MAX_CONSECUTIVE_BAD_FRAMES) {
      // 连续坏帧 → 协议不可信：断开（上层走 session.lost / 冷恢复）。
      this.#failAllPending(
        moclError("protocol.bad-frame", { message: `kimi ACP sent ${this.#badFrames} consecutive invalid frames` }),
      );
      this.#transport.close();
    }
  }

  #touchFrame(): void {
    this.#framesDuringPrompt += 1;
    this.#onFrame?.();
    if (this.#promptInFlight) this.#armWatchdog();
  }

  #armWatchdog(): void {
    this.#clearWatchdog();
    this.#watchdogTimer = setTimeout(() => {
      this.#watchdogTimer = null;
      const error = moclError("transport.timeout", {
        message: `kimi ACP produced no frame for ${this.#watchdogMs}ms during prompt (silent hang; D-003)`,
        details: { kind: "transport.timeout", hint: "fs/read_text_file 未回包或后端卡死；已触发看门狗 killpg" },
      });
      this.#failAllPending(error);
      this.#onHung?.("idle");
    }, this.#watchdogMs);
    // 不让看门狗单独吊住进程退出（测试仍受 fake timer 控制）。
    this.#watchdogTimer.unref?.();
  }

  #clearWatchdog(): void {
    if (this.#watchdogTimer === null) return;
    clearTimeout(this.#watchdogTimer);
    this.#watchdogTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /* 反向请求（§2.3 / §7.3）                                             */
  /* ------------------------------------------------------------------ */

  async #handleReverse(frame: {
    readonly id: number;
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    try {
      switch (frame.method) {
        case "fs/read_text_file": {
          const result = await this.#readTextFile(frame.params);
          this.#respond(frame.id, result);
          return;
        }
        case "fs/write_text_file": {
          const result = await this.#writeTextFile(frame.params);
          this.#respond(frame.id, result);
          return;
        }
        case "session/request_permission": {
          // 必须回包：不回 = turn 挂死（与 fs 同类病理，§7.2）。
          // requestId 必须透传：ABI `permission.requested.requestId` = JSON-RPC id（§5.2 #17）。
          const decision = await this.#permissionHandler?.({
            ...(frame.params as unknown as PermissionRequestParams),
            requestId: frame.id,
          });
          this.#respond(frame.id, { outcome: "selected", optionId: decision?.optionId ?? "reject" });
          return;
        }
        case "terminal/create":
        case "terminal/output":
        case "terminal/wait_for_exit":
        case "terminal/kill":
        case "terminal/release": {
          // 实测未触发，但**不能没有 handler**（fail-closed，§7.3）。
          this.#respondError(frame.id, -32601, `kimi adapter does not support ${frame.method}`);
          return;
        }
        default:
          this.#respondError(frame.id, -32601, `method not supported: ${frame.method}`);
          return;
      }
    } catch (error) {
      if (error instanceof JsonRpcRespondError) {
        this.#respondError(frame.id, error.code, error.message);
        return;
      }
      this.#respondError(frame.id, -32603, "internal handler error");
    }
  }

  /**
   * `fs/read_text_file`（**D-003 的核心实现**）。
   *
   * 回包契约：成功 `{content}`；文件不存在 → `-32602`；越界/超限 → `-32602` + 上层可发
   * `policy.sandbox-violation`；其他 IO 异常 → `-32603`。**任何分支都回包，绝不静默。**
   */
  async #readTextFile(params: Readonly<Record<string, unknown>>): Promise<{ readonly content: string }> {
    const path = params["path"];
    if (typeof path !== "string" || path.length === 0) {
      throw new JsonRpcRespondError(-32602, "invalid params: path");
    }
    const absolute = isAbsolute(path) ? resolve(path) : resolve(homedir(), path);
    let canonical: string;
    try {
      canonical = await realpath(absolute);
    } catch (cause) {
      if (isNotFound(cause)) throw new JsonRpcRespondError(-32602, "file not found");
      throw new JsonRpcRespondError(-32603, "failed to resolve file");
    }
    if (!(await this.#isAllowed(canonical))) {
      throw new JsonRpcRespondError(-32602, "path outside allowed roots");
    }
    try {
      const info = await stat(canonical);
      if (!info.isFile()) throw new JsonRpcRespondError(-32602, "not a regular file");
      if (info.size > this.#maxFileBytes) throw new JsonRpcRespondError(-32602, "file too large");
      const content = await readFile(canonical, "utf8");
      return { content };
    } catch (cause) {
      if (cause instanceof JsonRpcRespondError) throw cause;
      if (isNotFound(cause)) throw new JsonRpcRespondError(-32602, "file not found");
      throw new JsonRpcRespondError(-32603, "failed to read file");
    }
  }

  async #writeTextFile(params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, never>>> {
    const path = params["path"];
    const content = params["content"];
    if (typeof path !== "string" || path.length === 0 || typeof content !== "string") {
      throw new JsonRpcRespondError(-32602, "invalid params: path/content");
    }
    if (!this.#allowWrite) throw new JsonRpcRespondError(-32603, "write not permitted");
    const absolute = isAbsolute(path) ? resolve(path) : resolve(homedir(), path);
    if (!(await this.#isAllowed(absolute))) throw new JsonRpcRespondError(-32602, "path outside allowed roots");
    try {
      await writeFile(absolute, content, "utf8");
      return {};
    } catch {
      throw new JsonRpcRespondError(-32603, "failed to write file");
    }
  }

  /** 允许根判定（realpath 后比较；`allowedRoots` 为空 = 全拒）。 */
  async #isAllowed(absolute: string): Promise<boolean> {
    if (this.#allowedRoots.length === 0) return false;
    const roots = await this.#canonicalRoots();
    return roots.some((root) => absolute === root || absolute.startsWith(`${root}/`));
  }

  /** 允许根的 realpath 缓存（macOS 上 `/var` → `/private/var`，不 canon 会误判越界）。 */
  #canonicalRoots(): Promise<readonly string[]> {
    if (this.#rootsPromise === null) {
      this.#rootsPromise = Promise.all(
        this.#allowedRoots.map(async (root) => {
          try {
            return await realpath(root);
          } catch {
            return root;
          }
        }),
      );
    }
    return this.#rootsPromise;
  }

  #respond(id: number, result: Readonly<Record<string, unknown>>): void {
    this.#transport.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  #respondError(id: number, code: number, message: string): void {
    this.#transport.writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: sanitize(message) } }));
  }

  #failAllPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "ENOENT";
}

/* ------------------------------------------------------------------ */
/* 真实 transport：spawn `kimi acp`（一任务一进程 + 独立进程组）          */
/* ------------------------------------------------------------------ */

export interface SpawnKimiAcpOptions {
  readonly binaryPath?: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** SIGTERM 之后等待多久再 SIGKILL（默认 5000，§9.2）。 */
  readonly sigkillAfterMs?: number;
}

/** 默认二进制：`$KIMI_BIN` 或 `~/.kimi-code/bin/kimi`。 */
export function defaultKimiBinary(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env["KIMI_BIN"] ?? `${homedir()}/.kimi-code/bin/kimi`;
}

/**
 * spawn `kimi acp` 并封装为 transport。
 *
 * - `detached: true` → 子进程自成进程组（pgid = pid），`signal()` 用 `process.kill(-pid)` 杀全组；
 * - `NO_COLOR=1`（probe 口径）；**不注入任何 key/token**（凭据由 CLI 自己读）；
 * - stderr 不进协议面（只 drain，避免管道写满阻塞）。
 */
export function spawnKimiAcpTransport(options: SpawnKimiAcpOptions): AcpTransport {
  const binary = options.binaryPath ?? defaultKimiBinary();
  const child: ChildProcess = spawn(binary, ["acp"], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
  });
  const lineHandlers: ((line: string) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  const reader = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  reader.on("line", (line) => {
    for (const handler of lineHandlers) handler(line);
  });
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    reader.close();
    for (const handler of closeHandlers) handler();
  };
  child.on("exit", finish);
  child.on("error", finish);
  child.stderr?.on("data", () => {
    // 后端诊断日志不进协议面（§11.3）。
  });

  const pgid = child.pid;
  const signalGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      if (pgid !== undefined) process.kill(-pgid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 已退出
      }
    }
  };

  return {
    ...(pgid === undefined ? {} : { pgid }),
    writeLine(line: string): void {
      child.stdin?.write(`${line}\n`);
    },
    onLine(handler: (line: string) => void): void {
      lineHandlers.push(handler);
    },
    onClose(handler: () => void): void {
      closeHandlers.push(handler);
    },
    signal: signalGroup,
    close(): void {
      if (closed) return;
      signalGroup("SIGTERM");
      const graceMs = options.sigkillAfterMs ?? 5_000;
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
      }, graceMs);
      killTimer.unref?.();
      finish();
    },
  };
}

export { MoclError, sanitize };

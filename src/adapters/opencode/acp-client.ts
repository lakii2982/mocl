/**
 * ACP over stdio 兜底客户端（docs/adapters/opencode.md §2.3/§3.1/§5.3）。
 *
 * 与 kimi 同类约束（docs/research/kimi.md:292-307）：
 * - 反向请求必须实现 **`fs/read_text_file`**，否则 `session/prompt` 可能静默挂起 → 本客户端默认实现且 fail-closed；
 * - 每个请求都有超时（`session/prompt` 无内置超时，由 `prompt()` 的 timeout 兜底）；
 * - 传输可注入（真实实现 spawn `opencode acp`；测试用假 stdio transport）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { moclError } from "../../broker/errors.ts";
import { mapJsonRpcError, sanitize, toMoclError } from "./errors.ts";
import { SseParser } from "./http-client.ts";
import type {
  AcpConfigOption,
  AcpNewSessionResult,
  AcpPromptResult,
  AcpSessionUpdateParams,
  SseFrame,
} from "./types.ts";

/** ACP 帧传输抽象（真实 = 子进程 stdio；测试 = 内存管道）。 */
export interface AcpTransport {
  writeLine(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** 适配器依赖的最小 ACP 面（便于注入假实现）。 */
export interface AcpApi {
  initialize(clientInfo: { readonly name: string; readonly version: string }): Promise<AcpInitResult>;
  newSession(request: { readonly cwd: string; readonly mcpServers?: readonly unknown[] }): Promise<AcpNewSessionResult>;
  loadSession(request: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers?: readonly unknown[];
  }): Promise<{ readonly configOptions?: readonly AcpConfigOption[] }>;
  prompt(sessionId: string, text: string): Promise<AcpPromptResult>;
  setConfigOption(sessionId: string, configId: string, value: string): Promise<{ readonly configOptions?: readonly AcpConfigOption[] }>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  fork(sessionId: string, cwd: string): Promise<AcpNewSessionResult>;
  listSessions(cwd: string): Promise<readonly { readonly sessionId: string }[]>;
  onUpdate(handler: (params: AcpSessionUpdateParams) => void): void;
  terminate(): Promise<void>;
}

export interface AcpInitResult {
  readonly protocolVersion: number;
  readonly agentInfo?: { readonly name?: string; readonly version?: string };
  readonly agentCapabilities?: Readonly<Record<string, unknown>>;
  readonly authMethods?: readonly unknown[];
}

export interface AcpClientOptions {
  readonly transport: AcpTransport;
  readonly timeoutMs?: number;
  /** `fs/read_text_file` 允许的根目录（绝对路径）；为空表示拒绝一切读（fail-closed）。 */
  readonly allowedRoots?: readonly string[];
  /** 是否允许 `fs/write_text_file`（默认 false）。 */
  readonly allowWrite?: boolean;
  /** 单文件读取上限（默认 1 MiB）。 */
  readonly maxFileBytes?: number;
  /** ACP `session/request_permission` 的自动应答（默认 reject）。 */
  readonly permissionHandler?: (
    params: Readonly<Record<string, unknown>>,
  ) => Promise<{ readonly outcome: "selected"; readonly optionId: string } | { readonly outcome: "cancelled" }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: Readonly<Record<string, unknown>>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class AcpClient implements AcpApi {
  readonly #transport: AcpTransport;
  readonly #timeoutMs: number;
  readonly #allowedRoots: readonly string[];
  readonly #allowWrite: boolean;
  readonly #maxFileBytes: number;
  readonly #permissionHandler: AcpClientOptions["permissionHandler"];
  readonly #pending = new Map<number, PendingRequest>();
  #updateHandler: ((params: AcpSessionUpdateParams) => void) | undefined;
  #nextId = 1;
  #terminated = false;

  constructor(options: AcpClientOptions) {
    this.#transport = options.transport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#allowedRoots = (options.allowedRoots ?? []).map((root) => resolve(root));
    this.#allowWrite = options.allowWrite ?? false;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#permissionHandler = options.permissionHandler;

    this.#transport.onLine((line) => this.#onLine(line));
    this.#transport.onClose(() => this.#failAllPending(moclError("transport.disconnected", { message: "ACP transport closed" })));
  }

  onUpdate(handler: (params: AcpSessionUpdateParams) => void): void {
    this.#updateHandler = handler;
  }

  async initialize(clientInfo: { readonly name: string; readonly version: string }): Promise<AcpInitResult> {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo,
    });
    const protocolVersion = result["protocolVersion"];
    if (typeof protocolVersion !== "number") {
      throw moclError("protocol.invalid-params", { message: "ACP initialize missing protocolVersion" });
    }
    if (protocolVersion !== 1) {
      throw moclError("protocol.version-mismatch", {
        message: `ACP protocolVersion mismatch: expected 1, got ${protocolVersion}`,
      });
    }
    return result as unknown as AcpInitResult;
  }

  async newSession(request: { readonly cwd: string; readonly mcpServers?: readonly unknown[] }): Promise<AcpNewSessionResult> {
    const result = await this.request("session/new", {
      cwd: request.cwd,
      mcpServers: request.mcpServers ?? [],
    });
    const sessionId = result["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw moclError("protocol.invalid-params", { message: "ACP session/new missing sessionId" });
    }
    return result as unknown as AcpNewSessionResult;
  }

  async loadSession(request: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers?: readonly unknown[];
  }): Promise<{ readonly configOptions?: readonly AcpConfigOption[] }> {
    return (await this.request("session/load", {
      sessionId: request.sessionId,
      cwd: request.cwd,
      mcpServers: request.mcpServers ?? [],
    })) as { readonly configOptions?: readonly AcpConfigOption[] };
  }

  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    return (await this.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      { timeoutMs: this.#timeoutMs },
    )) as unknown as AcpPromptResult;
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ readonly configOptions?: readonly AcpConfigOption[] }> {
    return (await this.request("session/set_config_option", { sessionId, configId, value })) as {
      readonly configOptions?: readonly AcpConfigOption[];
    };
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, modeId });
  }

  async fork(sessionId: string, cwd: string): Promise<AcpNewSessionResult> {
    const result = await this.request("session/fork", { sessionId, cwd });
    return result as unknown as AcpNewSessionResult;
  }

  async listSessions(cwd: string): Promise<readonly { readonly sessionId: string }[]> {
    const result = await this.request("session/list", { cwd });
    const sessions = result["sessions"];
    return Array.isArray(sessions) ? (sessions as readonly { readonly sessionId: string }[]) : [];
  }

  async terminate(): Promise<void> {
    this.#terminated = true;
    this.#failAllPending(moclError("process.killed", { message: "ACP client terminated" }));
    this.#transport.close();
  }

  /** 发送 JSON-RPC 请求（`session/prompt` 等无内置超时的方调用方需传 timeoutMs）。 */
  async request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<Readonly<Record<string, unknown>>> {
    if (this.#terminated) {
      throw moclError("transport.disconnected", { message: "ACP client is terminated" });
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    return await new Promise<Readonly<Record<string, unknown>>>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(moclError("transport.timeout", { message: `ACP ${method} timed out after ${timeoutMs}ms` }));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve: resolvePromise, reject: rejectPromise, timer });
      this.#transport.writeLine(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      );
    });
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // 坏帧：丢弃（由上层计数/日志，不杀死连接）
    }
    if (parsed === null || typeof parsed !== "object") return;
    const frame = parsed as Record<string, unknown>;
    const id = frame["id"];
    if (typeof id === "number") {
      if (typeof frame["method"] === "string") {
        // 反向请求（server → client）：立即处理并回包。
        void this.#handleReverse({
          jsonrpc: "2.0",
          id,
          method: frame["method"],
          params: (frame["params"] ?? {}) as Readonly<Record<string, unknown>>,
        });
        return;
      }
      const pending = this.#pending.get(id);
      if (pending === undefined) return; // 迟到/未知 id：丢弃
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      const rpcError = frame["error"];
      if (rpcError !== undefined && rpcError !== null) {
        pending.reject(mapJsonRpcError(rpcError as { readonly code: number; readonly message: string; readonly data?: unknown }));
      } else {
        pending.resolve((frame["result"] ?? {}) as Readonly<Record<string, unknown>>);
      }
      return;
    }
    // 通知（无 id）
    if (frame["method"] === "session/update") {
      const params = (frame["params"] ?? {}) as unknown as AcpSessionUpdateParams;
      this.#updateHandler?.(params);
    }
  }

  async #handleReverse(frame: {
    readonly jsonrpc: "2.0";
    readonly id: number;
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const params = frame.params;
    try {
      switch (frame.method) {
        case "fs/read_text_file": {
          const result = await this.#readTextFile(params);
          this.#respond(frame.id, result);
          return;
        }
        case "fs/write_text_file": {
          const result = await this.#writeTextFile(params);
          this.#respond(frame.id, result);
          return;
        }
        case "session/request_permission": {
          const decision = this.#permissionHandler === undefined
            ? { outcome: "selected" as const, optionId: "reject" }
            : await this.#permissionHandler(params);
          this.#respond(frame.id, decision);
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

  async #readTextFile(params: Readonly<Record<string, unknown>>): Promise<{ readonly content: string }> {
    const path = params["path"];
    if (typeof path !== "string" || path.length === 0) {
      throw new JsonRpcRespondError(-32602, "invalid params: path");
    }
    const absolute = isAbsolute(path) ? resolve(path) : resolve(homedir(), path);
    if (!this.#isAllowed(absolute)) {
      throw new JsonRpcRespondError(-32602, "path outside allowed roots");
    }
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new JsonRpcRespondError(-32602, "not a regular file");
      if (info.size > this.#maxFileBytes) throw new JsonRpcRespondError(-32602, "file too large");
      const content = await readFile(absolute, "utf8");
      return { content };
    } catch (error) {
      if (error instanceof JsonRpcRespondError) throw error;
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
    if (!this.#isAllowed(absolute)) throw new JsonRpcRespondError(-32602, "path outside allowed roots");
    try {
      await writeFile(absolute, content, "utf8");
      return {};
    } catch {
      throw new JsonRpcRespondError(-32603, "failed to write file");
    }
  }

  #isAllowed(absolute: string): boolean {
    if (this.#allowedRoots.length === 0) return false;
    return this.#allowedRoots.some((root) => absolute === root || absolute.startsWith(`${root}/`));
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

class JsonRpcRespondError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "JsonRpcRespondError";
  }
}

/* ------------------------------------------------------------------ */
/* 真实 transport：spawn `opencode acp`（一任务一进程）                  */
/* ------------------------------------------------------------------ */

export interface SpawnAcpOptions {
  readonly binaryPath?: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** 默认二进制路径：`$OPENCODE_BIN` 或 `~/.opencode/bin/opencode`。 */
export function defaultOpenCodeBinary(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env["OPENCODE_BIN"] ?? `${homedir()}/.opencode/bin/opencode`;
}

/** spawn ACP 子进程并封装为 transport（进程组独立，便于 SIGTERM 收拾）。 */
export function spawnAcpTransport(options: SpawnAcpOptions): AcpTransport {
  const binary = options.binaryPath ?? defaultOpenCodeBinary();
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
  const finish = (): void => {
    if (closed) return;
    closed = true;
    reader.close();
    for (const handler of closeHandlers) handler();
  };
  child.on("exit", finish);
  child.on("error", finish);
  child.stderr?.on("data", () => {
    // 后端 stderr 不进协议面；丢弃（排障由后端日志承担）。
  });
  return {
    writeLine(line: string): void {
      child.stdin?.write(`${line}\n`);
    },
    onLine(handler: (line: string) => void): void {
      lineHandlers.push(handler);
    },
    onClose(handler: () => void): void {
      closeHandlers.push(handler);
    },
    close(): void {
      if (closed) return;
      const pid = child.pid;
      try {
        if (pid !== undefined) process.kill(-pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // 已退出
        }
      }
      setTimeout(() => {
        try {
          if (pid !== undefined) process.kill(-pid, "SIGKILL");
        } catch {
          // 已退出
        }
      }, 5_000).unref();
      finish();
    },
  };
}

/** ACP 事件行（`session/update`）→ SseFrame 形状，复用事件映射器（§5.3）。 */
export function acpUpdateToFrame(params: AcpSessionUpdateParams): SseFrame {
  const update = params.update;
  const sessionUpdate = typeof update["sessionUpdate"] === "string" ? update["sessionUpdate"] : "unknown";
  return {
    type: `acp.${sessionUpdate}`,
    data: { ...(update as Readonly<Record<string, unknown>>), sessionID: params.sessionId },
  };
}

export { SseParser, toMoclError };
export type { AcpSessionUpdateParams } from "./types.ts";

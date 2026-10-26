/**
 * codex app-server 传输层（施工 C4）：spawn + JSONL 分帧 + JSON-RPC 关联 + 超时 + 进程组 kill + stderr 环形缓冲。
 *
 * 设计依据：`../../../docs/adapters/codex.md` §2.2/§2.4/§4（基线 0.164.0，newline-delimited JSON-RPC 2.0）。
 *
 * 可测性：进程创建通过 `spawn` 注入（默认 `node:child_process.spawn`），因此测试可用假子进程
 * 回放录制帧，**默认不启动真实 codex**（零额度纪律）。
 *
 * 反直觉事实（基线实测，见设计 §2.4）：`thread/items/list` 虽在导出 schema 中出现，运行时返回
 * `-32601 not supported yet`；因此本层把 `-32601` 统一交给 `errors.ts` 分类，不在传输层做假设。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  adapterError,
  isAdapterError,
  mapExitError,
  mapJsonRpcError,
  mapSpawnError,
  mapTimeout,
  type AdapterError,
} from "./errors.ts";
import type { JsonRpcFrame } from "./types.ts";

/** 最小 stdin 接口（便于测试替换）。 */
export interface WritableLike {
  write(chunk: string): boolean;
  end?(chunk?: string): void;
}

/** 最小 stdout/stderr 接口。 */
export interface ReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/** 最小子进程接口（真实 `ChildProcess` 满足它）。 */
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdin: WritableLike | null;
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  // 宽松签名：真实 ChildProcess 与测试假件都要能满足（不放宽会与重载签名冲突）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** spawn 结果：`killTree` 由默认实现提供（POSIX 进程组），测试注入 spy。 */
export interface SpawnedChild {
  readonly child: ChildLike;
  readonly killTree?: (signal: NodeJS.Signals) => void;
}

export type SpawnFactory = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly cwd?: string },
) => SpawnedChild;

export interface TransportOptions {
  /** 基线二进制：默认 `MOCL_CODEX_BIN` → `codex`（见设计 §1.1）。 */
  readonly binaryPath?: string;
  /** 默认 `["app-server", "--listen", "stdio://"]`。 */
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** 单请求超时（ABI §4「超时是传输层义务」）。 */
  readonly requestTimeoutMs?: number;
  /** SIGTERM → SIGKILL 的宽限。 */
  readonly killGraceMs?: number;
  /** stderr 环形缓冲上限（字节）。 */
  readonly maxStderrBytes?: number;
  /** 连续坏帧阈值：达到后升级 `protocol.bad-frame` 并终止连接。 */
  readonly maxConsecutiveBadFrames?: number;
  readonly spawn?: SpawnFactory;
  readonly onNotification?: (frame: JsonRpcFrame) => void;
  readonly onServerRequest?: (frame: JsonRpcFrame) => void;
  /** 致命/需上报的适配器错误（坏帧升级、spawn 失败、非预期响应等）。 */
  readonly onFault?: (error: AdapterError) => void;
  /** 子进程退出（测试与可观测性用）。 */
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

/** 默认 spawn：POSIX 下 `detached` 建进程组，便于整组 kill（app-server 可能再拉子进程）。 */
function defaultSpawner(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd?: string }): SpawnedChild {
  const child = nodeSpawn(command, [...args], {
    env: options.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const pid = child.pid;
  const killTree =
    process.platform !== "win32" && pid !== undefined
      ? (signal: NodeJS.Signals): void => {
          try {
            process.kill(-pid, signal);
          } catch {
            // 进程组已消失/无权限：退回单进程 kill。
            try {
              child.kill(signal);
            } catch {
              /* 已退出 */
            }
          }
        }
      : (signal: NodeJS.Signals): void => {
          try {
            child.kill(signal);
          } catch {
            /* 已退出 */
          }
        };
  return { child: child as unknown as ChildLike, killTree };
}

/** 行缓冲：处理"一帧跨 chunk / 一 chunk 多帧"（JSONL 无 Content-Length 头）。 */
class LineFramer {
  #buffer = "";
  push(chunk: Buffer | string): string[] {
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines: string[] = [];
    for (;;) {
      const idx = this.#buffer.indexOf("\n");
      if (idx < 0) break;
      lines.push(this.#buffer.slice(0, idx));
      this.#buffer = this.#buffer.slice(idx + 1);
    }
    return lines;
  }
  /** 连接结束时的残片（不带换行）。 */
  drain(): string | undefined {
    const rest = this.#buffer;
    this.#buffer = "";
    return rest.length === 0 ? undefined : rest;
  }
}

interface ResolvedTransportOptions {
  readonly binaryPath?: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly requestTimeoutMs: number;
  readonly killGraceMs: number;
  readonly maxStderrBytes: number;
  readonly maxConsecutiveBadFrames: number;
  readonly spawn?: SpawnFactory;
  readonly onNotification?: (frame: JsonRpcFrame) => void;
  readonly onServerRequest?: (frame: JsonRpcFrame) => void;
  readonly onFault?: (error: AdapterError) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class CodexTransport {
  readonly #options: ResolvedTransportOptions;

  readonly #pending = new Map<number, PendingRequest>();
  readonly #framer = new LineFramer();
  readonly #stderrChunks: string[] = [];
  #stderrBytes = 0;
  #nextId = 1;
  #badFrames = 0;
  #consecutiveBadFrames = 0;
  #unexpectedResponses = 0;
  #child: ChildLike | undefined;
  #killTree: ((signal: NodeJS.Signals) => void) | undefined;
  #started = false;
  #stopping = false;
  #closed = false;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(options: TransportOptions = {}) {
    this.#options = {
      args: options.args ?? ["app-server", "--listen", "stdio://"],
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      killGraceMs: options.killGraceMs ?? 2_000,
      maxStderrBytes: options.maxStderrBytes ?? 32 * 1024,
      maxConsecutiveBadFrames: options.maxConsecutiveBadFrames ?? 5,
      ...(options.binaryPath === undefined ? {} : { binaryPath: options.binaryPath }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
      ...(options.onServerRequest === undefined ? {} : { onServerRequest: options.onServerRequest }),
      ...(options.onFault === undefined ? {} : { onFault: options.onFault }),
      ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
    };
  }

  get started(): boolean {
    return this.#started;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.#exit;
  }

  get badFrameCount(): number {
    return this.#badFrames;
  }

  get unexpectedResponseCount(): number {
    return this.#unexpectedResponses;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** stderr 尾部（环形缓冲；排障用，永不包含凭据——调用方负责脱敏）。 */
  stderrTail(): string {
    return this.#stderrChunks.join("");
  }

  /** 解析出的二进制路径（默认 `MOCL_CODEX_BIN` → `codex`）。 */
  binaryPath(): string {
    return this.#options.binaryPath ?? process.env["MOCL_CODEX_BIN"] ?? "codex";
  }

  /** 启动子进程；幂等。 */
  start(): void {
    if (this.#started) return;
    if (this.#closed) throw adapterError("transport.disconnected", { message: "transport already closed" });
    this.#started = true;
    const spawner = this.#options.spawn ?? defaultSpawner;
    const env = this.#options.env ?? process.env;
    let spawned: SpawnedChild;
    try {
      spawned = spawner(this.binaryPath(), this.#options.args, {
        env,
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      });
    } catch (cause) {
      this.#started = false;
      this.#closed = true;
      const error = mapSpawnError(cause);
      this.#options.onFault?.(error);
      throw error;
    }
    this.#child = spawned.child;
    this.#killTree = spawned.killTree;
    const stdout = spawned.child.stdout;
    if (stdout !== null) {
      stdout.on("data", (chunk: Buffer | string) => {
        this.#onStdout(chunk);
      });
    }
    const stderr = spawned.child.stderr;
    if (stderr !== null) {
      stderr.on("data", (chunk: Buffer | string) => {
        this.#appendStderr(chunk);
      });
    }
    spawned.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.#onExit(code, signal);
    });
    spawned.child.on("error", (error: Error) => {
      // ENOENT / EACCES 等：启动即失败。
      if (this.#closed) return;
      this.#closed = true;
      const adapterFailure = isAdapterError(error) ? error : mapSpawnError(error);
      this.#rejectAll(adapterFailure);
      this.#options.onFault?.(adapterFailure);
    });
  }

  /** 发送请求并等待同 id 响应。 */
  request<T = unknown>(method: string, params: unknown = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.#closed) {
      return Promise.reject(adapterError("transport.disconnected", { message: `transport closed before ${method}` }));
    }
    this.start();
    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(mapTimeout(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    const written = this.#write({ jsonrpc: "2.0", id, method, params });
    if (!written) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
      }
      return Promise.reject(adapterError("transport.disconnected", { message: `failed to write ${method}` }));
    }
    return promise;
  }

  /** 发送通知（无响应）。 */
  notify(method: string, params: unknown = {}): void {
    if (this.#closed) return;
    this.start();
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** 应答一个反向请求（result / error 二选一）。 */
  respond(frame: JsonRpcFrame): void {
    if (this.#closed) return;
    this.#write(frame);
  }

  /** 健康探针（ABI M18 `sys.ping` 的后端侧实现；设计 §11.2 用轻量只读方法）。 */
  async ping(): Promise<void> {
    await this.request("thread/loaded/list", {});
  }

  /** 优雅停止：SIGTERM（进程组）→ 宽限 → SIGKILL；幂等。 */
  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopping = true;
    this.#closed = true;
    this.#rejectAll(adapterError("process.killed", { message: "transport stopped by adapter" }));
    const child = this.#child;
    this.#stopPromise = new Promise<void>((resolve) => {
      if (child === undefined) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(killTimer);
        resolve();
      };
      const killTree = this.#killTree;
      const signal = (name: NodeJS.Signals): void => {
        if (killTree !== undefined) killTree(name);
        else {
          try {
            child.kill(name);
          } catch {
            /* already gone */
          }
        }
      };
      child.stdin?.end?.();
      signal("SIGTERM");
      const killTimer = setTimeout(() => {
        signal("SIGKILL");
        finish();
      }, this.#options.killGraceMs);
      killTimer.unref?.();
      // 已退出则立即完成。
      if (this.#exit !== undefined) {
        finish();
        return;
      }
      const exitListener = (): void => finish();
      child.on("exit", exitListener);
    });
    return this.#stopPromise;
  }

  #write(frame: JsonRpcFrame): boolean {
    const stdin = this.#child?.stdin;
    if (stdin === null || stdin === undefined) return false;
    try {
      stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  #appendStderr(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.#stderrChunks.push(text);
    this.#stderrBytes += Buffer.byteLength(text);
    while (this.#stderrBytes > this.#options.maxStderrBytes && this.#stderrChunks.length > 1) {
      const dropped = this.#stderrChunks.shift();
      if (dropped !== undefined) this.#stderrBytes -= Buffer.byteLength(dropped);
    }
  }

  #onStdout(chunk: Buffer | string): void {
    for (const line of this.#framer.push(chunk)) {
      this.#handleLine(line);
    }
  }

  #handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line.length === 0) return;
    let frame: JsonRpcFrame;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frame is not an object");
      frame = parsed as JsonRpcFrame;
    } catch {
      this.#badFrames += 1;
      this.#consecutiveBadFrames += 1;
      this.#options.onFault?.(
        adapterError("transport.frame-invalid", {
          message: "app-server sent a non-JSON frame",
          details: { kind: "transport.frame-invalid", sample: line.slice(0, 120) },
        }),
      );
      if (this.#consecutiveBadFrames >= this.#options.maxConsecutiveBadFrames) {
        this.#options.onFault?.(
          adapterError("protocol.bad-frame", {
            message: `consecutive invalid frames reached ${this.#options.maxConsecutiveBadFrames}`,
            details: { kind: "protocol.bad-frame", count: this.#consecutiveBadFrames },
          }),
        );
        void this.stop();
      }
      return;
    }
    this.#consecutiveBadFrames = 0;

    const hasId = frame.id !== undefined && frame.id !== null;
    const isResponse = frame.result !== undefined || frame.error !== undefined;
    if (hasId && isResponse) {
      this.#resolveResponse(frame);
      return;
    }
    if (hasId && typeof frame.method === "string") {
      this.#options.onServerRequest?.(frame);
      return;
    }
    if (typeof frame.method === "string") {
      this.#options.onNotification?.(frame);
      return;
    }
    this.#badFrames += 1;
    this.#options.onFault?.(
      adapterError("protocol.unexpected-response", {
        message: "frame is neither response, notification nor server request",
        details: { kind: "protocol.unexpected-response" },
      }),
    );
  }

  #resolveResponse(frame: JsonRpcFrame): void {
    const id = typeof frame.id === "number" ? frame.id : Number(frame.id);
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#unexpectedResponses += 1;
      this.#options.onFault?.(
        adapterError("protocol.unexpected-response", {
          message: `response for unknown request id ${String(frame.id)}`,
          details: { kind: "protocol.unexpected-response", requestId: frame.id },
        }),
      );
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (frame.error !== undefined) {
      pending.reject(mapJsonRpcError(pending.method, frame.error));
      return;
    }
    pending.resolve(frame.result);
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exit = { code, signal };
    const wasStopping = this.#stopping;
    this.#closed = true;
    const error = wasStopping
      ? adapterError("process.killed", { message: `app-server stopped (code=${String(code)})` })
      : mapExitError(code, signal);
    this.#rejectAll(error);
    this.#options.onExit?.(code, signal);
    if (!wasStopping) this.#options.onFault?.(error);
  }

  #rejectAll(error: AdapterError): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}

/**
 * codex 适配器测试脚手架（C4）：假子进程 + 录制帧回放服务器。
 *
 * 纪律：**默认不启动真实 codex**（零额度）。真实 smoke 只在 `MOCL_LIVE=1` 时由
 * `live-smoke.test.ts` 执行，本脚手架不 import 任何真实进程 API。
 *
 * 录制帧格式（`tests/fixtures/codex/*.jsonl`，每行一条指令）：
 * ```json
 * {"on":"request","method":"initialize","reply":{...}}
 * {"on":"request","method":"turn/start","reply":{...},"then":[{server->client frames...}]}
 * ```
 * `reply` 与 `then` 里的帧是 app-server → client 的**原始帧**；`then` 中可包含带 `id` 的
 * 反向请求（`ServerRequest`），回放服务器会记录客户端的应答供断言。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent } from "../../../src/abi/adapter.ts";
import { CodexAdapter, type CodexAdapterOptions, type CodexRuntimeProvider } from "../../../src/adapters/codex/index.ts";
import type { ChildLike, ReadableLike, SpawnedChild, WritableLike } from "../../../src/adapters/codex/transport.ts";

type Listener = (...args: unknown[]) => void;

/** 假子进程：记录写入/信号，可编程注入 stdout/stderr/exit。 */
export class FakeChild implements ChildLike {
  readonly pid = 424242;
  readonly written: string[] = [];
  readonly kills: NodeJS.Signals[] = [];
  ended = false;
  onWrite: ((chunk: string) => void) | undefined;
  readonly #stdout: Listener[] = [];
  readonly #stderr: Listener[] = [];
  readonly #exit: Listener[] = [];
  readonly #error: Listener[] = [];

  readonly stdin: WritableLike = {
    write: (chunk: string): boolean => {
      this.written.push(chunk);
      this.onWrite?.(chunk);
      return true;
    },
    end: (): void => {
      this.ended = true;
    },
  };

  readonly stdout: ReadableLike = {
    on: (_event: "data", listener: (chunk: Buffer | string) => void): unknown => {
      this.#stdout.push(listener as Listener);
      return this;
    },
  };

  readonly stderr: ReadableLike = {
    on: (_event: "data", listener: (chunk: Buffer | string) => void): unknown => {
      this.#stderr.push(listener as Listener);
      return this;
    },
  };

  on(event: string, listener: Listener): unknown {
    if (event === "exit") this.#exit.push(listener);
    else if (event === "error") this.#error.push(listener);
    return this;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push((signal ?? "SIGTERM") as NodeJS.Signals);
    return true;
  }

  /** 注入一行原始 stdout（自动补换行；用于坏帧/分片测试）。 */
  emitLine(line: string): void {
    for (const listener of this.#stdout) listener(`${line}\n`);
  }

  /** 注入一段原始 stdout（不补换行；用于分片测试）。 */
  emitChunk(chunk: string): void {
    for (const listener of this.#stdout) listener(chunk);
  }

  emitFrame(frame: unknown): void {
    this.emitLine(JSON.stringify(frame));
  }

  emitStderr(text: string): void {
    for (const listener of this.#stderr) listener(text);
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    for (const listener of this.#exit) listener(code, signal);
  }

  fail(error: Error): void {
    for (const listener of this.#error) listener(error);
  }
}

export interface ScriptDirective {
  readonly on: "request";
  readonly method: string;
  readonly reply?: unknown;
  /** 回 JSON-RPC error（用于录制"失败响应"；与 `reply` 二选一）。 */
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
  readonly then?: readonly unknown[];
}

/** 录制帧回放服务器：按客户端请求的 method 顺序消费指令。 */
export class ScriptedServer {
  readonly #child: FakeChild;
  readonly #byMethod = new Map<string, ScriptDirective[]>();
  readonly requests: { id: number | string | null; method: string; params: unknown }[] = [];
  readonly responses: { id: number | string | null; result?: unknown; error?: unknown }[] = [];
  readonly #unmatched: string[] = [];

  constructor(child: FakeChild, script: readonly ScriptDirective[] = []) {
    this.#child = child;
    for (const directive of script) {
      const list = this.#byMethod.get(directive.method) ?? [];
      list.push(directive);
      this.#byMethod.set(directive.method, list);
    }
    child.onWrite = (chunk: string): void => this.#onWrite(chunk);
  }

  get unmatched(): readonly string[] {
    return this.#unmatched;
  }

  /** 运行时追加一条指令（测试中途编排用）。 */
  push(directive: ScriptDirective): void {
    const list = this.#byMethod.get(directive.method) ?? [];
    list.push(directive);
    this.#byMethod.set(directive.method, list);
  }

  #onWrite(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim().length === 0) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const method = frame["method"];
      if (typeof method === "string" && frame["result"] === undefined && frame["error"] === undefined) {
        this.#handleRequest(frame);
        continue;
      }
      // 客户端对 ServerRequest 的应答。
      if (frame["id"] !== undefined && (frame["result"] !== undefined || frame["error"] !== undefined)) {
        this.responses.push({
          id: (frame["id"] as number | string | null) ?? null,
          ...(frame["result"] === undefined ? {} : { result: frame["result"] }),
          ...(frame["error"] === undefined ? {} : { error: frame["error"] }),
        });
      }
    }
  }

  #handleRequest(frame: Record<string, unknown>): void {
    const method = String(frame["method"]);
    const id = (frame["id"] as number | string | null) ?? null;
    this.requests.push({ id, method, params: frame["params"] });
    const directives = this.#byMethod.get(method);
    const directive = directives?.shift();
    if (directive === undefined) {
      this.#unmatched.push(method);
      this.#child.emitFrame({ jsonrpc: "2.0", id, error: { code: -32601, message: `no script for ${method}` } });
      return;
    }
    if (directive.error !== undefined) {
      this.#child.emitFrame({ jsonrpc: "2.0", id, error: directive.error });
    } else if (directive.reply !== undefined) {
      this.#child.emitFrame({ jsonrpc: "2.0", id, result: directive.reply });
    }
    for (const extra of directive.then ?? []) {
      this.#child.emitFrame(extra);
    }
  }
}

/** 读取录制帧 JSONL。 */
export async function loadScript(name: string): Promise<readonly ScriptDirective[]> {
  const path = new URL(`../../fixtures/codex/${name}.jsonl`, import.meta.url);
  const text = await readFile(path, "utf8");
  const out: ScriptDirective[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    out.push(JSON.parse(trimmed) as ScriptDirective);
  }
  return out;
}

/** 临时工作目录（cwd 校验要求真实存在的绝对路径）。 */
export async function makeWorkdir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mocl-c4-"));
  return { dir, cleanup: async (): Promise<void> => rm(dir, { recursive: true, force: true }) };
}

export function fixedRuntime(maxActiveSubagents: number): CodexRuntimeProvider {
  return { read: () => ({ maxActiveSubagents }) };
}

export interface HarnessOptions {
  readonly script?: readonly ScriptDirective[];
  readonly adapter?: CodexAdapterOptions;
  readonly runtimeCapacity?: number;
}

export interface Harness {
  readonly adapter: CodexAdapter;
  readonly child: FakeChild;
  readonly server: ScriptedServer;
  readonly spawnCount: () => number;
}

/** 组装 adapter + 假 transport（spawn 注入；不启动真实进程）。 */
export function makeHarness(options: HarnessOptions = {}): Harness {
  const child = new FakeChild();
  const server = new ScriptedServer(child, options.script ?? []);
  let spawns = 0;
  const adapter = new CodexAdapter({
    runtime: options.runtimeCapacity === undefined ? fixedRuntime(8) : fixedRuntime(options.runtimeCapacity),
    ...options.adapter,
    spawn: (): SpawnedChild => {
      spawns += 1;
      // killTree 用 spy 记录，避免测试里误杀真实进程组；SIGTERM 后异步模拟退出，
      // 让 dispose()/stop() 不必等满 killGrace（测试从 ~2s/例降到毫秒级）。
      return {
        child,
        killTree: (signal) => {
          child.kills.push(signal);
          if (signal === "SIGTERM") setImmediate(() => child.exit(0, "SIGTERM"));
        },
      };
    },
  });
  return { adapter, child, server, spawnCount: () => spawns };
}

/** 收集事件直到满足谓词 / 超时（避免测试永久挂起）。 */
export async function collectEvents(
  adapter: CodexAdapter,
  options: { readonly until?: (event: AdapterEvent) => boolean; readonly timeoutMs?: number; readonly maxEvents?: number } = {},
): Promise<AdapterEvent[]> {
  const until = options.until ?? (() => false);
  const timeoutMs = options.timeoutMs ?? 1_000;
  const maxEvents = options.maxEvents ?? 200;
  const events: AdapterEvent[] = [];
  const iterator = adapter.events()[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (events.length < maxEvents) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<AdapterEvent>>((resolve) => {
        setTimeout(() => resolve({ value: undefined, done: true }), remaining).unref?.();
      }),
    ]);
    if (next.done === true) break;
    const event = next.value as AdapterEvent;
    events.push(event);
    if (until(event)) break;
  }
  return events;
}

/** 标准 open 脚本（initialize + config/read + thread/start）。 */
export function handshakeDirectives(options: { readonly agents?: unknown; readonly userAgent?: string; readonly cwd?: string } = {}): ScriptDirective[] {
  return [
    {
      on: "request",
      method: "initialize",
      reply: {
        userAgent: options.userAgent ?? "mocl-codex/0.164.0 (Mac OS 27.0.1; arm64) dumb (mocl-codex; 0.1)",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    },
    {
      on: "request",
      method: "config/read",
      reply: {
        config: {
          agents:
            options.agents === undefined
              ? { max_concurrent_threads_per_session: 3, max_depth: 2, enabled: true }
              : options.agents,
        },
      },
    },
    {
      on: "request",
      method: "thread/start",
      reply: {
        thread: {
          id: "01a1thread000000000000000001",
          sessionId: "01a1thread000000000000000001",
          ephemeral: false,
          cliVersion: "0.164.0",
          path: "/tmp/codex-home/sessions/rollout-1.jsonl",
          cwd: options.cwd ?? "/tmp/work",
          model: "gpt-6-astra",
          status: { type: "idle" },
        },
        model: "gpt-6-astra",
        modelProvider: "openai",
      },
    },
  ];
}

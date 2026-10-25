/**
 * codex app-server 客户端（施工 C4）：把 JSON-RPC 方法调用收敛成带类型的函数。
 *
 * 只封装设计里确认存在的基线方法（`docs/adapters/codex.md` §2.4「运行时方法集」）：
 * initialize / config/read / thread/start / thread/resume / thread/read / thread/loaded/list /
 * turn/start / turn/interrupt / thread/unsubscribe。**不使用** `thread/items/list`（运行时
 * `-32601 not supported yet`）。
 */
import type { InputBlock } from "../../abi/types.ts";
import { adapterError } from "./errors.ts";
import type { CodexTransport } from "./transport.ts";
import type {
  ConfigReadResult,
  InitializeResult,
  ThreadLoadedListResult,
  ThreadReadResult,
  ThreadResumeParams,
  ThreadResumeResult,
  ThreadStartParams,
  ThreadStartResult,
  ThreadUnsubscribeResult,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResult,
  CodexUserInput,
} from "./types.ts";

/** 版本断言失败（ABI §2.3：后端原生版本必须与钉住的基线一致）。 */
export function versionOfUserAgent(userAgent: string): string | undefined {
  const afterSlash = /\/\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/.exec(userAgent);
  if (afterSlash !== null) return afterSlash[1];
  const anySemver = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/.exec(userAgent);
  return anySemver?.[1];
}

/** ABI `InputBlock` → codex `UserInput`（协议只支持 text/localImage 等；file 以路径提示表达）。 */
export function toUserInput(input: readonly InputBlock[]): readonly CodexUserInput[] {
  const out: CodexUserInput[] = [];
  for (const block of input) {
    if (block.type === "text") {
      out.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      if (block.path === undefined || block.path.length === 0) {
        throw adapterError("protocol.invalid-params", { message: "image input requires a path" });
      }
      out.push({ type: "localImage", path: block.path });
      continue;
    }
    // file：app-server 没有通用附件入参（基线），退化为带路径的文本提示。
    const path = block.path ?? block.text;
    out.push({ type: "text", text: `[file] ${path}` });
  }
  return out;
}

export interface CodexClientOptions {
  /** 期望的基线版本（设计 §1.3 V1/V2）；`null` 关闭断言（仅测试/迁移期）。 */
  readonly expectedVersion?: string | null;
  readonly requestTimeoutMs?: number;
}

export class CodexClient {
  readonly #transport: CodexTransport;
  readonly #expectedVersion: string | null;
  readonly #timeoutMs: number | undefined;
  #initialized = false;
  #userAgent: string | undefined;

  constructor(transport: CodexTransport, options: CodexClientOptions = {}) {
    this.#transport = transport;
    this.#expectedVersion = options.expectedVersion === undefined ? "0.164.0" : options.expectedVersion;
    this.#timeoutMs = options.requestTimeoutMs;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get userAgent(): string | undefined {
    return this.#userAgent;
  }

  get detectedVersion(): string | undefined {
    return this.#userAgent === undefined ? undefined : versionOfUserAgent(this.#userAgent);
  }

  /** `initialize` + 版本断言；幂等。 */
  async initialize(clientInfo: { readonly name: string; readonly version: string }): Promise<InitializeResult> {
    if (this.#initialized) {
      if (this.#userAgent === undefined) {
        throw adapterError("internal.unexpected", { message: "initialized without userAgent" });
      }
      return { userAgent: this.#userAgent };
    }
    const result = await this.#request<InitializeResult>("initialize", { clientInfo });
    if (typeof result?.userAgent !== "string") {
      throw adapterError("protocol.unexpected-response", {
        message: "initialize response is missing userAgent",
        details: { kind: "protocol.unexpected-response" },
      });
    }
    const detected = versionOfUserAgent(result.userAgent);
    const expected = this.#expectedVersion;
    if (expected !== null && detected !== expected) {
      throw adapterError("protocol.version-mismatch", {
        message: `codex baseline mismatch: expected ${expected}, got ${detected ?? "unknown"}`,
        details: { kind: "protocol.version-mismatch", expected, actual: detected ?? "unknown" },
      });
    }
    this.#userAgent = result.userAgent;
    this.#initialized = true;
    return result;
  }

  /** 读取生效配置（D-016：并发/深度上限必须来自运行时，不读常量）。 */
  async readConfig(): Promise<ConfigReadResult> {
    return this.#request<ConfigReadResult>("config/read", { includeSources: false });
  }

  /** 建**持久**线程（`ephemeral:false` 是硬要求，见设计 §4.2）。 */
  async threadStart(params: ThreadStartParams): Promise<ThreadStartResult> {
    if (params.ephemeral !== false) {
      throw adapterError("internal.unexpected", { message: "thread/start must be called with ephemeral:false" });
    }
    const result = await this.#request<ThreadStartResult>("thread/start", { ...params });
    if (typeof result?.thread?.id !== "string") {
      throw adapterError("protocol.unexpected-response", {
        message: "thread/start response is missing thread.id",
        details: { kind: "protocol.unexpected-response" },
      });
    }
    return result;
  }

  /** 续接既有线程（`thread/resume`；没有 rollout 时会抛 `session.resume-failed`）。 */
  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResult> {
    const result = await this.#request<ThreadResumeResult>("thread/resume", { ...params });
    if (typeof result?.thread?.id !== "string") {
      throw adapterError("protocol.unexpected-response", {
        message: "thread/resume response is missing thread.id",
        details: { kind: "protocol.unexpected-response" },
      });
    }
    return result;
  }

  /** 只读探测线程是否存在（未 materialize 也可读，设计 §2.4）。 */
  async threadRead(threadId: string): Promise<ThreadReadResult> {
    return this.#request<ThreadReadResult>("thread/read", { threadId });
  }

  /** 内存中已加载线程（池化/冷恢复探测）。 */
  async threadLoadedList(): Promise<readonly string[]> {
    const result = await this.#request<ThreadLoadedListResult>("thread/loaded/list", {});
    return Array.isArray(result?.data) ? result.data : [];
  }

  /** 起一轮；返回**后端** turn id。 */
  async turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    const result = await this.#request<TurnStartResult>("turn/start", { ...params });
    if (typeof result?.turn?.id !== "string") {
      throw adapterError("protocol.unexpected-response", {
        message: "turn/start response is missing turn.id",
        details: { kind: "protocol.unexpected-response" },
      });
    }
    return result;
  }

  /**
   * 中断一轮。
   * @returns `"native"` 表示后端接受；`"already-finished"` 表示 `no active turn to interrupt`
   *          （不是错误，ABI M5 幂等语义，设计 §10.1）。
   */
  async turnInterrupt(params: TurnInterruptParams): Promise<"native" | "already-finished"> {
    try {
      await this.#request("turn/interrupt", { threadId: params.threadId, turnId: params.turnId });
      return "native";
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "session.conflict") return "already-finished";
      throw error;
    }
  }

  /** 释放订阅（不删 rollout）；`{status:"notLoaded"|"unsubscribed"}` 都算成功。 */
  async threadUnsubscribe(threadId: string): Promise<ThreadUnsubscribeResult> {
    return this.#request<ThreadUnsubscribeResult>("thread/unsubscribe", { threadId });
  }

  async #request<T>(method: string, params: unknown): Promise<T> {
    return this.#transport.request<T>(method, params, this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs });
  }
}

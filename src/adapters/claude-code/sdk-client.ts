/**
 * claude-code Agent SDK 客户端（施工 C5）：构造 `query()` 选项 + 控制面封装。
 *
 * 纪律（docs/adapters/claude-code.md §2.1/§4/§7）：
 * - **只通过 `Options` 传参**，不手拼 CLI flag（SDK 内部才会拼 `--resume=<id>` 等）；
 * - `persistSession: true` 是 `resume` 的前提（false 会让会话无法续接）；
 * - `permissionPrompts: "host"` + `canUseTool`（2s fail-closed）才能做无人值守代答；
 * - `env` 用白名单（不透传父进程敏感变量，见 permissions.sanitizedEnv）；
 * - SDK 通过动态 import 加载，测试注入假实现（零额度）。
 */
import type { InputBlock, PermissionProfile } from "../../abi/types.ts";
import { sanitizedEnv } from "./permissions.ts";
import { buildResumeOptions } from "./resume.ts";
import type { AsyncQueryLike, CanUseTool, SdkApiLike, SdkLoader, SdkUserContentBlock, SdkUserMessage } from "./types.ts";
import { loadRealSdk } from "./types.ts";

/** 异步输入队列：模式 A（长驻 query + streamInput）的输入侧。 */
export class AsyncInputQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

/** ABI `InputBlock[]` → SDK 用户消息（附件以路径文本表达；不读文件内容）。 */
export function toSdkUserMessage(input: readonly InputBlock[], sessionId?: string): SdkUserMessage {
  const content: SdkUserContentBlock[] = input.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    const path = block.path ?? block.text;
    return { type: "text", text: `[${block.type}] ${path}` };
  });
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
  };
}

export interface ClaudeQueryOptionsInput {
  readonly cwd: string;
  readonly permissionProfile: PermissionProfile;
  /** 显式覆盖权限模式（5 值之一；缺省由 profile 映射）。 */
  readonly permissionMode?: string;
  readonly model?: string | null;
  readonly resumeSessionId?: string;
  readonly forkSession?: boolean;
  /** 新建会话时由适配器生成的 UUID（`Options.sessionId`，先于 init 可知，保证可续接）。 */
  readonly sessionId?: string;
  readonly resumeSessionAt?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 钉死 CLI 2.1.310 的绝对路径（`pathToClaudeCodeExecutable`）。 */
  readonly claudeCodeExecutable?: string;
  readonly canUseTool: CanUseTool;
  readonly abortController: AbortController;
  readonly maxTurns?: number;
  readonly includePartialMessages?: boolean;
  readonly forwardSubagentText?: boolean;
  readonly extraOptions?: Readonly<Record<string, unknown>>;
}

/**
 * 构造 `query()` 的 options（纯函数，便于单测断言"该传的必须传"）。
 * @returns 可直接传给 SDK `query({prompt, options})` 的对象。
 */
export function buildQueryOptions(input: ClaudeQueryOptionsInput, resolvedMode: string, disallowedTools: readonly string[]): Record<string, unknown> {
  if (input.sessionId !== undefined && input.resumeSessionId !== undefined && input.forkSession !== true) {
    // SDK 硬约束：sessionId 与 resume 互斥（forkSession 时才允许给分叉会话指定新 id）。
    throw new TypeError("Options.sessionId cannot be combined with resume unless forkSession is set");
  }
  const resumeOptions =
    input.resumeSessionId === undefined
      ? {}
      : buildResumeOptions({
          sessionId: input.resumeSessionId,
          ...(input.forkSession === true ? { forkSession: true } : {}),
          ...(input.resumeSessionAt === undefined ? {} : { resumeSessionAt: input.resumeSessionAt }),
        });
  return {
    cwd: input.cwd,
    // 硬要求：关闭持久化就永远无法 resume（SDK: "cannot be resumed later"）。
    persistSession: true,
    // 只有 host 模式才会调用 canUseTool（none 模式下一律立即拒绝、回调永不触发）。
    permissionPrompts: "host",
    permissionMode: resolvedMode,
    // 不使用裸 allowedTools：SDK 会先于 canUseTool 自动放行（CLAUDE_SDK_CAN_USE_TOOL_SHADOWED），
    // 使 2s fail-closed 代答被绕过。权限决策统一收敛到 canUseTool。
    disallowedTools: [...disallowedTools],
    canUseTool: input.canUseTool,
    includePartialMessages: input.includePartialMessages ?? true,
    forwardSubagentText: input.forwardSubagentText ?? true,
    env: sanitizedEnv(input.env ?? process.env),
    abortController: input.abortController,
    ...(input.model === null || input.model === undefined ? {} : { model: input.model }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.claudeCodeExecutable === undefined ? {} : { pathToClaudeCodeExecutable: input.claudeCodeExecutable }),
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    ...resumeOptions,
    ...(input.extraOptions ?? {}),
  };
}

/** SDK 查询控制面（`interrupt/close/streamInput/setModel`）。 */
export class ClaudeQueryHandle {
  readonly #query: AsyncQueryLike;
  #closed = false;

  constructor(query: AsyncQueryLike) {
    this.#query = query;
  }

  get raw(): AsyncQueryLike {
    return this.#query;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** SDK `Query.interrupt()`：中断当前轮，会话保留。 */
  async interrupt(): Promise<void> {
    await this.#query.interrupt();
  }

  /** 运行中追加输入（模式 A）：`priority:"now"` 作为转向。 */
  async streamInput(stream: AsyncIterable<SdkUserMessage>): Promise<void> {
    if (this.#closed) return;
    if (typeof this.#query.streamInput !== "function") {
      throw new TypeError("SDK query does not support streamInput (mode A unavailable)");
    }
    await this.#query.streamInput(stream);
  }

  async setModel(model?: string): Promise<void> {
    if (typeof this.#query.setModel === "function") await this.#query.setModel(model);
  }

  /** 关闭查询（SDK 会终止其 CLI 子进程；适配器 close 时调用）。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#query.close?.();
  }
}

/** SDK 门面：懒加载真实包，支持注入假实现。 */
export class ClaudeSdkClient {
  readonly #loader: SdkLoader;
  #api: SdkApiLike | undefined;

  constructor(loader: SdkLoader = loadRealSdk) {
    this.#loader = loader;
  }

  async api(): Promise<SdkApiLike> {
    if (this.#api === undefined) this.#api = await this.#loader();
    return this.#api;
  }

  /** 启动查询（模式 A：prompt 为输入流；首次输入前 SDK 也会发 system/init）。 */
  async startQuery(prompt: AsyncIterable<SdkUserMessage>, options: Record<string, unknown>): Promise<ClaudeQueryHandle> {
    const api = await this.api();
    const query = api.query({ prompt, options });
    return new ClaudeQueryHandle(query);
  }
}

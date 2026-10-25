/**
 * codex app-server v2 协议的最小 wire 形状（施工 C4）。
 *
 * 真源：`codex app-server generate-json-schema`（基线 0.164.0）导出物；
 * 设计映射见 `../../../../docs/adapters/codex.md` §2–§5。这里只声明适配器实际读写的字段，
 * 不做全量类型生成（导出物有 668 个 definition，全量映射属后续切片）。
 */

/** JSON-RPC 2.0 帧（server → client 可能是响应 / 通知 / 反向请求）。 */
export interface JsonRpcFrame {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** `initialize` 结果（基线实测字段；无独立 protocolVersion，见设计 §2.3）。 */
export interface InitializeResult {
  readonly userAgent: string;
  readonly codexHome?: string;
  readonly platformFamily?: string;
  readonly platformOs?: string;
}

export interface ClientInfo {
  readonly name: string;
  readonly version: string;
}

/** `config/read` 结果里我们读取的部分（agents 三个上限是运行时值，D-016）。 */
export interface ConfigReadResult {
  readonly config?: {
    readonly agents?: {
      readonly max_concurrent_threads_per_session?: number | null;
      readonly max_depth?: number | null;
      readonly enabled?: boolean | null;
    } | null;
  } | null;
}

export interface ThreadStartParams {
  readonly cwd: string;
  readonly ephemeral: boolean;
  readonly approvalPolicy?: string;
  readonly approvalsReviewer?: string;
  readonly sandbox?: string;
  readonly model?: string | null;
  readonly modelProvider?: string | null;
  readonly serviceTier?: string | null;
  readonly developerInstructions?: string | null;
}

export interface ThreadStartResult {
  readonly thread: CodexThread;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly approvalPolicy?: string;
  readonly sandbox?: unknown;
}

/** `Thread` 里适配器关心的字段（响应是超集，未知字段忽略——ABI §0 规则 5）。 */
export interface CodexThread {
  readonly id: string;
  readonly sessionId?: string;
  readonly ephemeral?: boolean;
  readonly cliVersion?: string;
  readonly path?: string | null;
  readonly cwd?: string;
  readonly model?: string | null;
  readonly parentThreadId?: string | null;
  readonly status?: { readonly type?: string } | null;
}

export interface ThreadResumeParams {
  readonly threadId: string;
  readonly cwd?: string;
  readonly model?: string | null;
  readonly sandbox?: string;
  readonly approvalPolicy?: string;
}

export interface ThreadResumeResult {
  readonly thread: CodexThread;
  readonly model?: string;
}

export interface ThreadReadParams {
  readonly threadId: string;
  readonly includeTurns?: boolean;
}

export interface ThreadReadResult {
  readonly thread: CodexThread;
}

export interface ThreadLoadedListResult {
  readonly data: readonly string[];
  readonly nextCursor?: string | null;
}

/** `UserInput`（只映射 ABI `InputBlock` 能表达的子集）。 */
export type CodexUserInput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "localImage"; readonly path: string };

export interface TurnStartParams {
  readonly threadId: string;
  readonly input: readonly CodexUserInput[];
  /** 幂等辅助：写入 userMessage item 的 `clientId`（设计 §3.2 / §4.5）。 */
  readonly clientUserMessageId?: string;
  readonly model?: string | null;
}

export interface TurnStartResult {
  readonly turn: { readonly id: string; readonly status?: string };
}

export interface TurnInterruptParams {
  readonly threadId: string;
  readonly turnId: string;
}

export interface ThreadUnsubscribeResult {
  readonly status?: string;
}

/** 一个 adapter 会话的运行时上下文（handle）。 */
export interface CodexSessionHandle {
  readonly abiSessionId: string;
  remoteThreadId: string;
  /** 最近一次 `turn/start` 的**后端** turn id（用于 interrupt）。 */
  lastRemoteTurnId?: string;
  /** 最近一次 `turn/start` 的 ABI turn id。 */
  lastAbiTurnId?: string;
  model: string | null;
  cwd: string;
  /** 线程是否已 materialize（首个 user message 后；resume/archive 的前提）。 */
  materialized: boolean;
}

/**
 * claude-code（Agent SDK 0.3.263）适配器的最小 wire 形状（施工 C5）。
 *
 * 真源：`@anthropic-ai/claude-agent-sdk@0.3.263` 的 `sdk.d.ts`（SDK 消息是 39 种判别联合）；
 * 设计映射见 `../../../docs/adapters/claude-code.md` §2–§5。这里只声明适配器读写的子集，
 * 未识别消息按 ABI §13.2 忽略并计数（产品原文：消费者应忽略不认识的消息类型）。
 */

/** `query()` 返回的异步查询对象（可测试子集；真实 SDK 对象结构兼容）。 */
export interface AsyncQueryLike extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>;
  close?(): void;
  streamInput?(stream: AsyncIterable<SdkUserMessage>): Promise<void> | void;
  setModel?(model?: string): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
}

/** 注入的 SDK 门面（默认动态 import 真实包；测试注入假实现，零额度）。 */
export interface SdkApiLike {
  query(params: {
    readonly prompt: string | AsyncIterable<SdkUserMessage>;
    readonly options: Record<string, unknown>;
  }): AsyncQueryLike;
  getSessionInfo?(sessionId: string): Promise<{ readonly sessionId?: string; readonly cwd?: string; readonly summary?: string } | undefined>;
  listSessions?(): Promise<readonly unknown[]>;
  forkSession?(sessionId: string, options?: Record<string, unknown>): Promise<{ readonly sessionId?: string }>;
}

export type SdkLoader = () => Promise<SdkApiLike>;

/** 缺省加载器：动态 import 真实 SDK（只有真正 open 时才加载，测试不会触发）。 */
export const loadRealSdk: SdkLoader = async () => {
  const module = await import("@anthropic-ai/claude-agent-sdk");
  return module as unknown as SdkApiLike;
};

/** ABI `InputBlock` → SDK 用户消息（文本 / 图片路径 / 文件路径提示）。 */
export interface SdkUserContentBlock {
  readonly type: "text" | "image" | "tool_use" | "tool_result" | "thinking";
  readonly text?: string;
  readonly source?: unknown;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

export interface SdkUserMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: readonly SdkUserContentBlock[] };
  readonly parent_tool_use_id: string | null;
  readonly session_id?: string;
  readonly priority?: "now" | "next" | "later";
}

export interface SdkUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

export interface SdkMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly [key: string]: unknown;
}

export interface SdkInitMessage extends SdkMessage {
  readonly type: "system";
  readonly subtype: "init";
  readonly session_id: string;
  readonly claude_code_version: string;
  readonly cwd: string;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly tools?: readonly string[];
  readonly agents?: readonly string[];
  readonly mcp_servers?: readonly unknown[];
  readonly apiKeySource?: string;
}

export interface SdkResultMessage extends SdkMessage {
  readonly type: "result";
  readonly subtype: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly stop_reason?: string | null;
  readonly usage?: SdkUsage;
  readonly total_cost_usd?: number;
  readonly duration_ms?: number;
  readonly num_turns?: number;
  readonly session_id?: string;
  readonly errors?: readonly string[];
  readonly permission_denials?: readonly {
    readonly tool_name?: string;
    readonly tool_use_id?: string;
    readonly tool_input?: unknown;
  }[];
}

/** 权限回调结果（与 SDK `PermissionResult` 同形；**永不返回 null**）。 */
export type CanUseToolResult =
  | {
      readonly behavior: "allow";
      readonly updatedInput?: Record<string, unknown>;
      readonly toolUseID?: string;
    }
  | {
      readonly behavior: "deny";
      readonly message: string;
      readonly interrupt?: boolean;
      readonly toolUseID?: string;
    };

/** 权限回调上下文子集（SDK 传 `toolUseID`/`agentID`/`blockedPath` 等）。 */
export interface CanUseToolContext {
  readonly signal?: AbortSignal;
  readonly suggestions?: readonly unknown[];
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly toolUseID?: string;
  readonly agentID?: string;
}

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: CanUseToolContext,
) => Promise<CanUseToolResult>;

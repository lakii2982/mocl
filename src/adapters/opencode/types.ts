/**
 * opencode 适配器内部类型（L1；docs/adapters/opencode.md §0–§5 的实现侧形状）。
 *
 * 纪律：
 * - 不在这里定义 ABI 类型（ABI 真源是 src/abi/*，事件/错误/能力位一律引用）；
 * - 这里只描述 opencode 原生 wire 形状（v2 HttpApi + SSE + ACP over stdio）。
 */

/** 可注入的 fetch（测试零额度；生产默认 Node 全局 fetch）。 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** HTTP 通道配置（密码只允许来自环境或 service.json 的 password 字段，绝不打印）。 */
export interface OpenCodeHttpConfig {
  readonly baseUrl: string;
  readonly password: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
  /** 幂等 GET 的重试次数（默认 2；POST 恒为 0，见 docs/adapters/opencode.md §0/§10）。 */
  readonly maxGetRetries?: number;
}

/** `provider/model#variant` 的结构化形式（OpenAPI `Model.Ref`）。 */
export interface ModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/** `/api/info` → `server.info`。 */
export interface ServerInfo {
  readonly version: string;
  readonly pid?: number;
  readonly urls?: readonly string[];
  readonly paths?: Readonly<Record<string, string>>;
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

/** OpenAPI 指纹所需的最小子集。 */
export interface OpenApiDocument {
  readonly openapi: string;
  readonly info?: { readonly title?: string; readonly version?: string };
  readonly paths?: Readonly<Record<string, unknown>>;
}

/** Token 用量（`Session.Info.tokens` / `session.usage.updated`）。 */
export interface TokenUsage {
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cache?: { readonly read?: number; readonly write?: number };
}

/** `Session.Info`（`GET /api/session/{id}`）。 */
export interface OpenCodeSessionInfo {
  readonly id: string;
  readonly parentID?: string | null;
  readonly agent?: string;
  readonly model?: ModelRef | null;
  readonly location?: { readonly directory?: string };
  readonly outcome?: "succeeded" | "failed" | "interrupted" | null;
  readonly cost?: number;
  readonly tokens?: TokenUsage;
  readonly time?: {
    readonly created?: number;
    readonly updated?: number;
    readonly idle?: number;
    readonly archived?: number;
  };
  readonly title?: string;
  readonly fork?: { readonly sessionID?: string; readonly boundary?: unknown };
}

/** `POST /api/session` 请求体（字段名以 `/openapi.json` 为准）。 */
export interface CreateSessionRequest {
  readonly agent: string;
  readonly model: ModelRef;
  readonly location: { readonly directory: string };
  readonly parentID?: string;
  readonly title?: string;
}

/** `Session.Inbox.User`（prompt 被接受的幂等锚）。 */
export interface InboxUser {
  readonly id: string;
  readonly sessionID: string;
  readonly type: "user";
  readonly delivery: "steer" | "queue";
  readonly payload?: { readonly text?: string };
  readonly time?: { readonly created?: number };
}

/** `Session.Inbox.Info`（`GET /api/session/{id}/inbox` 的元素，宽松取用需要的字段）。 */
export interface InboxItem {
  readonly id: string;
  readonly sessionID?: string;
  readonly type?: string;
  readonly delivery?: "steer" | "queue";
}

/** `POST /api/session/{id}/interrupt` 结果。 */
export interface InterruptResult {
  readonly interrupted: boolean;
}

/** `POST /api/session/{id}/permission/{requestID}/reply` 的 decision 枚举（OpenAPI `Permission.Reply`）。 */
export type OpenCodePermissionDecision = "once" | "always" | "reject";

/** `GET /api/permission/request` 的待批请求（OpenAPI `Permission.Request`）。 */
export interface OpenCodePermissionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources?: readonly string[];
  readonly save?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly message?: string;
  readonly source?: {
    readonly type?: string;
    readonly messageID?: string;
    readonly id?: string;
  };
}

/** SSE 帧（实测形状：`{id,created,type,location,data,durable?}`）。 */
export interface SseFrame {
  readonly id?: string;
  readonly created?: number;
  readonly type: string;
  readonly location?: { readonly directory?: string };
  readonly data?: Readonly<Record<string, unknown>>;
  readonly durable?: {
    readonly aggregateID?: string;
    readonly seq?: number;
    readonly version?: number;
  };
}

/** ACP JSON-RPC 2.0 帧（stdio 行协议）。 */
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type JsonRpcInbound = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;

/** ACP `session/update` 通知的 params（`update.sessionUpdate` 判别）。 */
export interface AcpSessionUpdateParams {
  readonly sessionId: string;
  readonly update: Readonly<Record<string, unknown>> & { readonly sessionUpdate?: string };
}

/** ACP `session/prompt` 结果（opencode 实测带 usage）。 */
export interface AcpPromptResult {
  readonly stopReason: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cachedReadTokens?: number;
  };
}

/** ACP `session/new` 结果（configOptions / modes 均为宽松对象）。 */
export interface AcpNewSessionResult {
  readonly sessionId: string;
  readonly configOptions?: readonly AcpConfigOption[];
  readonly modes?: Readonly<Record<string, unknown>> | null;
}

export interface AcpConfigOption {
  readonly id: string;
  readonly name?: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue?: string;
  readonly options?: readonly { readonly value: string; readonly name?: string }[];
}

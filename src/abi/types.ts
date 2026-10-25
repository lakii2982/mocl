/**
 * ABI v0 手写类型（与 `schema/*.json` 字段一一对应；TS 侧的唯一类型真源）。
 *
 * - Session        ↔ schema/session.json
 * - MoclEvent      ↔ schema/event.json（35 个事件变体的 discriminated union）
 * - ErrorRef       ↔ schema/error.json
 * - CapabilityDeclaration / CapabilityEntry ↔ schema/capabilities.json
 * - MoclRequest    ↔ schema/request.json（M1–M9）+ ABI §6 的 M10–M18（§13.1 加法扩展）
 *
 * 约定：wire 上的可选字段用 `?:`；schema 允许 `null` 的用 `| null`；
 * 只读字段统一 `readonly`（运行时是普通对象，仅类型层约束）。
 */
import type { AbiMethod, ExtensionMethod, SchemaBackedMethod } from "./methods.ts";
import type { CapabilityBit, CapabilityState } from "./capabilities.ts";
import type { ErrorCategory, ErrorCode, Retryability } from "./errors.ts";
import type { EventType } from "./events.ts";

export type { AbiMethod, ExtensionMethod, SchemaBackedMethod };
export type { CapabilityBit, CapabilityState };
export type { ErrorCategory, ErrorCode, Retryability };

/* ------------------------------------------------------------------ */
/* 域枚举（与 schema 的 enum 逐字一致）                                 */
/* ------------------------------------------------------------------ */

export type AbiVersion = "0.1";

export type BackendId = "codex" | "claude-code" | "kimi" | "opencode";

export type TransportKind =
  | "acp-stdio"
  | "app-server-jsonrpc"
  | "agent-sdk"
  | "cli-stream-json"
  | "http-api";

export const SESSION_STATES = [
  "created",
  "running",
  "awaiting-input",
  "blocked",
  "completed",
  "aborted",
  "lost",
  "recovering",
  "archived",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const ACTIVATION_STATES = ["inactive", "queued", "active", "draining"] as const;
export type ActivationState = (typeof ACTIVATION_STATES)[number];

export const TERMINAL_REASONS = [
  "delivered",
  "interrupted",
  "failed",
  "invalidated",
  "budget-exhausted",
  "policy-denied",
  "timeout",
  "operator",
] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

export const RESULT_STATUSES = ["delivered", "partial", "none"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const ERROR_SEVERITIES = ["warning", "error", "fatal"] as const;
export type ErrorSeverity = (typeof ERROR_SEVERITIES)[number];

export const PROGRESS_MODES = ["off", "summary", "events"] as const;
export type ProgressMode = (typeof PROGRESS_MODES)[number];

/* ------------------------------------------------------------------ */
/* 通用引用                                                            */
/* ------------------------------------------------------------------ */

/** session.json#/$defs/backendRef（version 必填，transport 可选）。 */
export interface BackendRef {
  readonly id: BackendId;
  readonly version: string;
  readonly transport?: TransportKind;
}

/** event.json#/$defs/backendRef（只允许 id + version）。 */
export interface EventBackendRef {
  readonly id: BackendId;
  readonly version: string;
}

/** error.json#/properties/backend（id 必填，version 可选）。 */
export interface ErrorBackendRef {
  readonly id: BackendId;
  readonly version?: string;
}

/* ------------------------------------------------------------------ */
/* 能力声明（schema/capabilities.json + session.json 的 capabilities）  */
/* ------------------------------------------------------------------ */

export interface CapabilityEntry {
  readonly bit: CapabilityBit;
  readonly state: CapabilityState;
  readonly detail?: string;
  readonly constraint?: string;
}

/** capabilities.json#/properties/limits（5 项）。 */
export interface BackendLimits {
  readonly maxTurnMs: number;
  readonly idleTimeoutMs: number;
  readonly maxSessionsPerBackend: number;
  readonly maxNestingDepth: number;
  readonly maxConcurrentTurns: number;
}

export interface CapabilityDeclaration {
  readonly abiVersion: AbiVersion;
  readonly backendId: BackendId;
  readonly backendVersion: string;
  readonly transport: TransportKind;
  readonly nativeProtocolVersion?: string | null;
  readonly bits: readonly CapabilityEntry[];
  readonly limits: BackendLimits;
  readonly warnings: readonly string[];
  readonly observedAt: string;
}

/* ------------------------------------------------------------------ */
/* 错误（schema/error.json）                                           */
/* ------------------------------------------------------------------ */

/** error.json 与 event/session 内嵌 errorRef 共用的字段形状。 */
export interface ErrorDetails {
  readonly kind: string;
  readonly missingBits?: readonly CapabilityBit[];
  readonly backendCode?: string;
  readonly retryAttempt?: number;
  readonly hint?: string;
}

export interface ErrorRef {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retryable: Retryability;
  readonly retryAfterMs?: number;
  readonly userMessage: string;
  readonly severity: ErrorSeverity;
  readonly backend?: ErrorBackendRef;
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
  readonly details?: ErrorDetails;
  readonly traceId?: string;
  readonly cause?: string;
}

/* ------------------------------------------------------------------ */
/* 会话（schema/session.json）                                          */
/* ------------------------------------------------------------------ */

/** session.json#/$defs/limits（10 项）。 */
export interface SessionLimits {
  readonly maxTurnMs: number;
  readonly idleTimeoutMs: number;
  readonly leaseTtlMs: number;
  readonly heartbeatMs: number;
  readonly maxSessionsPerBackend: number;
  readonly maxConcurrentTurns: number;
  readonly maxNestingDepth: number;
  readonly maxEventBytes: number;
  readonly maxParentProgressItems: number;
  readonly maxParentProgressChars: number;
}

export interface SessionResult {
  readonly status: ResultStatus;
  readonly summary?: string;
  readonly artifact?: string;
  readonly completedAt?: string | null;
  readonly preservedThroughSeq?: number;
}

export interface SessionProgressStat {
  readonly mode: ProgressMode;
  readonly emittedItems: number;
  readonly droppedEvents: number;
}

export interface Session {
  readonly abiVersion: AbiVersion;
  readonly sessionId: string;
  readonly parentSessionId?: string | null;
  readonly rootSessionId?: string | null;
  readonly label?: string;
  readonly backend: BackendRef;
  readonly backendSessionId?: string | null;
  readonly state: SessionState;
  readonly activation: ActivationState;
  readonly terminalReason?: TerminalReason | null;
  readonly stateReason?: string;
  readonly seq: number;
  readonly epoch: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastTurnId?: string | null;
  readonly result?: SessionResult | null;
  readonly error?: ErrorRef | null;
  readonly capabilities: readonly CapabilityEntry[];
  readonly limits: SessionLimits;
  readonly progress?: SessionProgressStat | null;
}

/* ------------------------------------------------------------------ */
/* 事件 payload（schema/event.json 的 35 个变体）                        */
/* ------------------------------------------------------------------ */

export type MessageChannel = "assistant" | "system" | "tool";
export type StreamGranularity = "token" | "message";

export interface UsageRef {
  readonly estimated: boolean;
  readonly scope: "turn" | "session";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
}

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "in-progress" | "completed" | "failed" | "skipped";
}

export interface DiffFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions?: number;
  readonly deletions?: number;
}

export type PermissionRisk = "read" | "write" | "execute" | "network" | "unknown";
export type PermissionDecision = "allow-once" | "allow-always" | "deny" | "cancel";

export interface PermissionOption {
  readonly id: string;
  readonly kind: "allow-once" | "allow-always" | "deny-once" | "cancel";
}

export type ProgressItemKind =
  | "state"
  | "turn"
  | "tool"
  | "plan"
  | "diff"
  | "usage"
  | "child"
  | "error"
  | "result";

export interface ProgressItem {
  readonly kind: ProgressItemKind;
  readonly key: string;
  readonly text: string;
  readonly count?: number;
}

export interface ProgressWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export interface ProgressDropped {
  readonly count: number;
  readonly kinds: readonly string[];
}

export interface SessionCreatedPayload {
  readonly state: "created" | "running";
  readonly cwd: string;
  readonly label?: string;
}

export interface SessionStateChangedPayload {
  readonly previousState: SessionState;
  readonly state: SessionState;
  readonly reason: string;
  readonly activation?: ActivationState;
}

export interface SessionRecoveredPayload {
  readonly strategy: "resume" | "fork" | "reseed";
  readonly attempt: number;
  readonly replayedEvents: number;
  readonly resumedFromSeq?: number;
}

export interface SessionLostPayload {
  readonly reason: string;
  readonly lastKnownSeq: number;
}

export interface SessionClosedPayload {
  readonly reason: string;
}

export interface SessionArchivedPayload {
  readonly reason: string;
}

export interface SessionWarningPayload {
  readonly code: string;
  readonly message: string;
  readonly degrade: boolean;
  readonly bits?: readonly string[];
}

export interface TurnStartedPayload {
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly delivery: "caller" | "parent";
  readonly inputDigest?: string;
}

export interface TurnCompletedPayload {
  readonly stopReason: "end-turn" | "max-turns" | "stop-sequence" | "context-limit" | "other";
  readonly usage: UsageRef;
  readonly summary?: string;
}

export interface TurnFailedPayload {
  readonly error: ErrorRef;
  readonly partial: boolean;
}

export interface TurnAbortedPayload {
  readonly interruptMethod: "native" | "process-kill" | "timeout" | "budget";
  readonly partial: boolean;
}

export interface TurnSteeredPayload {
  readonly steerSeq: number;
}

export interface TurnQueuedPayload {
  readonly queuePosition: number;
}

export interface MessageStartedPayload {
  readonly channel: MessageChannel;
  readonly messageId: string;
}

export interface MessageDeltaPayload {
  readonly channel: MessageChannel;
  readonly text: string;
  readonly granularity: StreamGranularity;
  readonly messageId: string;
}

export interface MessageCompletedPayload {
  readonly channel: MessageChannel;
  readonly text: string;
  readonly messageId: string;
  readonly truncated?: boolean;
}

export interface ReasoningDeltaPayload {
  readonly text: string;
  readonly granularity: StreamGranularity;
  readonly messageId?: string;
}

export interface ReasoningSummaryPayload {
  readonly text: string;
}

export interface ToolStartedPayload {
  readonly toolCallId: string;
  readonly name: string;
  readonly kind?: string;
}

export interface ToolProgressPayload {
  readonly toolCallId: string;
  readonly text: string;
  readonly percent?: number;
}

export interface ToolCompletedPayload {
  readonly toolCallId: string;
  readonly status: "ok" | "error" | "denied";
  readonly outputDigest: string;
  readonly artifact?: string;
  readonly truncated?: boolean;
}

export interface ToolFailedPayload {
  readonly toolCallId: string;
  readonly error: ErrorRef;
  readonly partial: boolean;
}

export interface PlanUpdatedPayload {
  readonly planId?: string;
  readonly steps: readonly PlanStep[];
}

export interface DiffUpdatedPayload {
  readonly files: readonly DiffFile[];
  readonly patchDigest?: string;
}

export interface UsageUpdatedPayload {
  readonly usage: UsageRef;
}

export interface PermissionRequestedPayload {
  readonly requestId: string;
  readonly tool: string;
  readonly risk: PermissionRisk;
  readonly summary?: string;
  readonly options: readonly PermissionOption[];
}

export interface PermissionResolvedPayload {
  readonly requestId: string;
  readonly decision: PermissionDecision;
  readonly by: "policy" | "user";
  readonly reason?: string;
}

export interface InputRequestedPayload {
  readonly requestId: string;
  readonly question: string;
  readonly options?: readonly string[];
}

export interface InputResolvedPayload {
  readonly requestId: string;
  readonly decision: "answered" | "declined" | "timeout";
  readonly answerDigest?: string;
}

export interface ChildSpawnedPayload {
  readonly childSessionId: string;
  readonly nativeAgentId?: string;
  readonly name?: string;
  readonly depth: number;
}

export interface ChildStateChangedPayload {
  readonly childSessionId: string;
  readonly previousState: SessionState;
  readonly state: SessionState;
}

export interface ChildCompletedPayload {
  readonly childSessionId: string;
  readonly status: "ok" | "error" | "aborted";
  readonly summary?: string;
}

export interface TransportStateChangedPayload {
  readonly transport: TransportKind;
  readonly state: "connecting" | "ready" | "degraded" | "closed" | "failed";
  readonly detail?: string;
}

export interface DiagnosticLogPayload {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly component: string;
}

export interface ProgressFoldedPayload {
  readonly window: ProgressWindow;
  readonly items: readonly ProgressItem[];
  readonly dropped: ProgressDropped;
  readonly chars: number;
  readonly truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* 事件信封 + 35 变体 union                                            */
/* ------------------------------------------------------------------ */

export interface EventEnvelope<TType extends EventType, TPayload> {
  readonly abiVersion: AbiVersion;
  readonly eventId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly seq: number;
  readonly epoch: number;
  readonly ts: string;
  readonly type: TType;
  readonly backend: EventBackendRef;
  readonly payload: TPayload;
}

export type MoclEvent =
  | EventEnvelope<"session.created", SessionCreatedPayload>
  | EventEnvelope<"session.state-changed", SessionStateChangedPayload>
  | EventEnvelope<"session.recovered", SessionRecoveredPayload>
  | EventEnvelope<"session.lost", SessionLostPayload>
  | EventEnvelope<"session.closed", SessionClosedPayload>
  | EventEnvelope<"session.archived", SessionArchivedPayload>
  | EventEnvelope<"session.warning", SessionWarningPayload>
  | EventEnvelope<"turn.started", TurnStartedPayload>
  | EventEnvelope<"turn.completed", TurnCompletedPayload>
  | EventEnvelope<"turn.failed", TurnFailedPayload>
  | EventEnvelope<"turn.aborted", TurnAbortedPayload>
  | EventEnvelope<"turn.steered", TurnSteeredPayload>
  | EventEnvelope<"turn.queued", TurnQueuedPayload>
  | EventEnvelope<"message.started", MessageStartedPayload>
  | EventEnvelope<"message.delta", MessageDeltaPayload>
  | EventEnvelope<"message.completed", MessageCompletedPayload>
  | EventEnvelope<"reasoning.delta", ReasoningDeltaPayload>
  | EventEnvelope<"reasoning.summary", ReasoningSummaryPayload>
  | EventEnvelope<"tool.started", ToolStartedPayload>
  | EventEnvelope<"tool.progress", ToolProgressPayload>
  | EventEnvelope<"tool.completed", ToolCompletedPayload>
  | EventEnvelope<"tool.failed", ToolFailedPayload>
  | EventEnvelope<"plan.updated", PlanUpdatedPayload>
  | EventEnvelope<"diff.updated", DiffUpdatedPayload>
  | EventEnvelope<"usage.updated", UsageUpdatedPayload>
  | EventEnvelope<"permission.requested", PermissionRequestedPayload>
  | EventEnvelope<"permission.resolved", PermissionResolvedPayload>
  | EventEnvelope<"input.requested", InputRequestedPayload>
  | EventEnvelope<"input.resolved", InputResolvedPayload>
  | EventEnvelope<"child.spawned", ChildSpawnedPayload>
  | EventEnvelope<"child.state-changed", ChildStateChangedPayload>
  | EventEnvelope<"child.completed", ChildCompletedPayload>
  | EventEnvelope<"transport.state-changed", TransportStateChangedPayload>
  | EventEnvelope<"diagnostic.log", DiagnosticLogPayload>
  | EventEnvelope<"progress.folded", ProgressFoldedPayload>;

/* ------------------------------------------------------------------ */
/* 请求（schema/request.json 的 M1–M9 + ABI §6 的 M10–M18）              */
/* ------------------------------------------------------------------ */

export type PermissionProfile = "read-only" | "safe-auto" | "yolo";

export interface InputBlock {
  readonly type: "text" | "file" | "image";
  readonly text: string;
  readonly path?: string;
}

export interface TurnExpectation {
  readonly expect: "turn" | "continue";
}

export interface ClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface NegotiateParams {
  readonly requiredBits: readonly CapabilityBit[];
  readonly clientInfo?: ClientInfo;
}

export interface SessionCreateParams {
  readonly backendId: BackendId;
  readonly cwd: string;
  readonly label?: string;
  readonly parentSessionId?: string;
  readonly permissionProfile: PermissionProfile;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly capabilities?: {
    readonly requiredBits: readonly CapabilityBit[];
    readonly preferredBits?: readonly CapabilityBit[];
  };
  readonly limits?: {
    readonly maxTurnMs: number;
    readonly maxNestingDepth?: number;
  };
  readonly firstInput?: {
    readonly input: readonly InputBlock[];
    readonly expect: "turn" | "continue";
  };
}

export interface SessionSendParams {
  readonly input: readonly InputBlock[];
  readonly expect: "turn" | "continue";
  readonly delivery: "caller" | "parent";
  readonly turnLimits?: {
    readonly maxTurnMs: number;
    readonly maxOutputTokens?: number | null;
  };
  readonly seedSummary?: string | null;
}

export interface SessionResumeParams {
  readonly backendSessionId: string;
  readonly fromSeq: number;
  readonly input?: readonly InputBlock[] | null;
  readonly expect?: "turn" | "continue";
}

export interface SessionInterruptParams {
  readonly turnId: string;
  readonly reason: "user-cancel" | "timeout" | "budget" | "policy";
}

export interface SessionQueryParams {
  readonly includeCapabilities: boolean;
  readonly consistentWithSeq?: number | null;
}

export interface SessionListParams {
  readonly limit: number;
  readonly state?: SessionState | null;
  readonly backendId?: BackendId | null;
  readonly parentSessionId?: string | null;
}

export interface SessionRecoverParams {
  readonly reason: "lease-expired" | "process-crash" | "broker-restart" | "manual";
  readonly strategy: "auto" | "resume" | "fork" | "reseed" | "abort";
  readonly fromSeq?: number | null;
}

export interface SessionCloseParams {
  readonly reason: "completed" | "failed" | "cancelled" | "operator";
  readonly archive: boolean;
}

/** 请求信封公共字段（schema/request.json 顶层 required + 可选字段）。 */
export interface RequestEnvelope<TMethod extends AbiMethod, TParams> {
  readonly abiVersion: AbiVersion;
  readonly requestId: string;
  readonly method: TMethod;
  readonly sessionId?: string;
  readonly clientRequestId?: string;
  readonly epoch?: number;
  readonly requiredBits?: readonly CapabilityBit[];
  readonly params: TParams;
}

export type NegotiateRequest = RequestEnvelope<"abi.negotiate", NegotiateParams>;

export type SessionCreateRequest = RequestEnvelope<"session.create", SessionCreateParams> & {
  readonly clientRequestId: string;
};

export type SessionSendRequest = RequestEnvelope<"session.send", SessionSendParams> & {
  readonly sessionId: string;
  readonly clientRequestId: string;
};

export type SessionResumeRequest = RequestEnvelope<"session.resume", SessionResumeParams> & {
  readonly sessionId: string;
  readonly clientRequestId: string;
};

export type SessionInterruptRequest = RequestEnvelope<"session.interrupt", SessionInterruptParams> & {
  readonly sessionId: string;
  readonly clientRequestId: string;
};

export type SessionQueryRequest = RequestEnvelope<"session.query", SessionQueryParams> & {
  readonly sessionId: string;
};

export type SessionListRequest = RequestEnvelope<"session.list", SessionListParams>;

export type SessionRecoverRequest = RequestEnvelope<"session.recover", SessionRecoverParams> & {
  readonly sessionId: string;
  readonly clientRequestId: string;
};

export type SessionCloseRequest = RequestEnvelope<"session.close", SessionCloseParams> & {
  readonly sessionId: string;
  readonly clientRequestId: string;
};

/**
 * M10–M18：ABI §13.1 加法扩展方法。`schema/request.json` v0 只冻结 M1–M9 的请求体；
 * 这些方法的 params 在 C2+ 按同一信封补齐，此处先给出方法级类型占位（不透支设计）。
 */
export interface ExtensionRequest<TMethod extends ExtensionMethod>
  extends RequestEnvelope<TMethod, Readonly<Record<string, unknown>>> {
  readonly sessionId?: string;
  readonly clientRequestId?: string;
}

export type SchemaBackedRequest =
  | NegotiateRequest
  | SessionCreateRequest
  | SessionSendRequest
  | SessionResumeRequest
  | SessionInterruptRequest
  | SessionQueryRequest
  | SessionListRequest
  | SessionRecoverRequest
  | SessionCloseRequest;

export type ExtensionRequestUnion =
  | ExtensionRequest<"session.fork">
  | ExtensionRequest<"session.archive">
  | ExtensionRequest<"session.respond">
  | ExtensionRequest<"session.steer">
  | ExtensionRequest<"session.setMode">
  | ExtensionRequest<"session.setModel">
  | ExtensionRequest<"session.subscribe">
  | ExtensionRequest<"session.replay">
  | ExtensionRequest<"sys.ping">;

export type MoclRequest = SchemaBackedRequest | ExtensionRequestUnion;

/* ------------------------------------------------------------------ */
/* 工具类型守卫                                                        */
/* ------------------------------------------------------------------ */

export function isSessionState(value: string): value is SessionState {
  return (SESSION_STATES as readonly string[]).includes(value);
}

export function isTerminalReason(value: string): value is TerminalReason {
  return (TERMINAL_REASONS as readonly string[]).includes(value);
}

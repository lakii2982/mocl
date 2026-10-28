/**
 * claude-code SDK 消息 → ABI 事件映射（施工 C5；设计 §5.2）。
 *
 * 硬约束（Lead 明确）：
 * - **只有 `subtype:"success" && is_error:false && result 非空` 才发 `turn.completed`**；
 *   其余 result（含 `error_max_turns`）一律 `turn.failed`，错误码按 §10.1 映射；
 * - 无法映射的消息 → 丢弃 + 计数 + 节流 `session.warning{code:"adapter.event-dropped"}`；
 * - 终态之后不再发该轮事件（EV-4）；payload 对齐 `schema/event.json`；
 * - 每轮首个轮内事件前补发 `turn.started`（W4）：model 取 `system/init` /
 *   `message_start` 实测值（配置 `model:null` 时的真实模型来源）；未知 → 空串，
 *   绝不编造（W4 契约 §3）。
 */
import { createHash } from "node:crypto";
import type { AdapterEvent } from "../../abi/adapter.ts";
import { adapterError, mapAssistantError, mapResultError, permissionDenied, toErrorRef, type AdapterError } from "./errors.ts";
import type { SdkInitMessage, SdkMessage, SdkResultMessage, SdkUsage, SdkUserContentBlock } from "./types.ts";

const MAX_TEXT = 4000;

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** SDK `stop_reason` → ABI `turn.completed.stopReason`。 */
function stopReasonOf(value: string | null | undefined): "end-turn" | "max-turns" | "stop-sequence" | "context-limit" | "other" {
  switch (value) {
    case "end_turn":
    case null:
    case undefined:
      return "end-turn";
    case "stop_sequence":
      return "stop-sequence";
    case "max_tokens":
      return "other";
    default:
      return "other";
  }
}

/** 子代理 task 状态 → ABI 会话状态枚举。 */
function childStateOf(patch: string | undefined): "created" | "running" | "blocked" | "completed" | "aborted" | "failed" {
  switch (patch) {
    case "pending":
      return "created";
    case "paused":
      return "blocked";
    case "completed":
      return "completed";
    case "killed":
      return "aborted";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

interface TurnState {
  readonly turnId: string;
  terminal: boolean;
  interrupted: boolean;
  started: boolean;
  currentMessageId: string | undefined;
  toolBlocks: Map<number, string>;
  toolStarted: Set<string>;
  thinkingBuffer: string[];
  usage: { inputTokens?: number; outputTokens?: number };
  assistantError: AdapterError | undefined;
}

export interface ClaudeEventMapperOptions {
  readonly resolveTurnId: (remoteTurnId: string) => string;
  readonly model?: string | null;
  readonly warningWindowMs?: number;
  readonly now?: () => number;
  /** `system/conversation_reset`：产品换了会话 id，适配器必须更新映射。 */
  readonly onConversationReset?: (newSessionId: string) => void;
}

export class ClaudeEventMapper {
  readonly #resolveTurnId: (remoteTurnId: string) => string;
  readonly #warningWindowMs: number;
  readonly #now: () => number;
  readonly #onConversationReset: ((newSessionId: string) => void) | undefined;
  readonly #turns = new Map<string, TurnState>();
  readonly #dropped = new Map<string, number>();
  #model: string | undefined;
  #sessionCreated = false;
  #lastWarningAt = Number.NEGATIVE_INFINITY;
  #warnings = 0;
  #droppedTotal = 0;
  #activeTurnId: string | undefined;
  #sessionId: string | undefined;

  constructor(options: ClaudeEventMapperOptions) {
    this.#resolveTurnId = options.resolveTurnId;
    this.#warningWindowMs = options.warningWindowMs ?? 5_000;
    this.#now = options.now ?? (() => Date.now());
    this.#model = options.model ?? undefined;
    this.#onConversationReset = options.onConversationReset;
  }

  setModel(model: string | null | undefined): void {
    if (model !== null && model !== undefined && model.length > 0) this.#model = model;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get droppedTotal(): number {
    return this.#droppedTotal;
  }

  get warningCount(): number {
    return this.#warnings;
  }

  droppedCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.#dropped);
  }

  /** 适配器 `interrupt()` 调用后标记：下一次 result 映射为 `turn.aborted` 而不是 failed。 */
  markInterrupted(turnId?: string): void {
    const state = turnId === undefined ? this.#activeState() : this.#turns.get(turnId);
    if (state !== undefined) state.interrupted = true;
  }

  handleMessage(message: SdkMessage): AdapterEvent[] {
    try {
      switch (message.type) {
        case "system":
          return this.#onSystem(message);
        case "stream_event":
          return this.#onStreamEvent(message);
        case "assistant":
          return this.#onAssistant(message);
        case "user":
          return this.#onUser(message);
        case "result":
          return this.#onResult(message as SdkResultMessage);
        case "tool_progress":
          return this.#onToolProgress(message);
        case "rate_limit_event":
          return this.#onRateLimit(message);
        case "auth_status":
          return this.#onAuthStatus(message);
        case "conversation_reset":
          return this.#handleConversationReset(message);
        default:
          return this.#drop(message.type, 1);
      }
    } catch (cause) {
      return [
        this.#warning(
          "adapter.event-mapping-failed",
          `mapping ${message.type}/${String(message.subtype ?? "")} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      ];
    }
  }

  /** 适配器注入诊断（`diagnostic.log`）。 */
  diagnostic(level: "debug" | "info" | "warn" | "error", message: string): AdapterEvent {
    return { type: "diagnostic.log", payload: { level, message: message.slice(0, 1000), component: "adapter.claude-code" } };
  }

  /* ------------------------------------------------------------------ system/* */

  #onSystem(message: SdkMessage): AdapterEvent[] {
    const subtype = message.subtype;
    switch (subtype) {
      case "init":
        return this.#onInit(message as SdkInitMessage);
      case "task_started":
        return [
          {
            type: "child.spawned",
            payload: {
              childSessionId: String(message["task_id"] ?? "").slice(0, 128),
              nativeAgentId: String(message["task_id"] ?? "").slice(0, 128),
              name: String(message["description"] ?? "subagent").slice(0, 128),
              depth: Math.max(1, asNumber(message["spawn_depth"]) ?? 1),
            },
          },
        ];
      case "task_updated": {
        const patch = asRecord(message["patch"]);
        const status = asString(patch?.["status"]);
        return [
          {
            type: "child.state-changed",
            payload: {
              childSessionId: String(message["task_id"] ?? "").slice(0, 128),
              previousState: "running",
              state: childStateOf(status),
            },
          },
        ];
      }
      case "task_notification":
        return [
          {
            type: "child.completed",
            payload: {
              childSessionId: String(message["task_id"] ?? "").slice(0, 128),
              status: message["status"] === "completed" ? "ok" : message["status"] === "stopped" ? "aborted" : "error",
              ...(typeof message["summary"] === "string" && message["summary"].length > 0
                ? { summary: message["summary"].slice(0, 2000) }
                : {}),
            },
          },
        ];
      case "task_progress":
        return this.#drop("system/task_progress", 1);
      case "permission_denied": {
        const toolName = asString(message["tool_name"]) ?? "unknown";
        const toolUseId = asString(message["tool_use_id"]) ?? `perm_${toolName}`;
        const reason = asString(message["decision_reason"]) ?? asString(message["message"]);
        void permissionDenied(toolName, reason);
        return [
          {
            type: "permission.resolved",
            payload: {
              requestId: toolUseId.slice(0, 128),
              decision: "deny",
              by: "policy",
              ...(reason === undefined ? {} : { reason: reason.slice(0, 160) }),
            },
          },
        ];
      }
      case "status": {
        const status = message["status"];
        if (status === "compacting") return [this.#warning("context-compacting", "claude is compacting context")];
        if (status === "requesting") {
          return [
            {
              type: "session.state-changed",
              payload: { previousState: "running", state: "awaiting-input", reason: "claude is requesting input" },
            },
          ];
        }
        return [];
      }
      case "compact_boundary": {
        const metadata = asRecord(message["compact_metadata"]);
        const pre = asNumber(metadata?.["pre_tokens"]);
        const post = asNumber(metadata?.["post_tokens"]);
        return [
          this.#warning(
            "context-compacted",
            `context compacted${pre === undefined ? "" : ` (pre=${pre}${post === undefined ? "" : `, post=${post}`})`}`,
          ),
        ];
      }
      case "api_retry": {
        const attempt = asNumber(message["attempt"]);
        const maxRetries = asNumber(message["max_retries"]);
        const delay = asNumber(message["retry_delay_ms"]);
        const errorName = String(message["error"] ?? "unknown");
        return [
          this.#warning(
            "api-retry",
            `retry ${attempt ?? "?"}/${maxRetries ?? "?"} after ${delay ?? "?"}ms (${errorName})`,
          ),
        ];
      }
      case "worker_shutting_down":
        return [
          {
            type: "session.lost",
            payload: { reason: String(message["reason"] ?? "worker shutting down").slice(0, 160), lastKnownSeq: 0 },
          },
        ];
      case "session_state_changed": {
        const state = message["state"];
        const mapped = state === "requires_action" ? "awaiting-input" : "running";
        return [
          {
            type: "session.state-changed",
            payload: { previousState: "running", state: mapped, reason: `claude session_state=${String(state)}` },
          },
        ];
      }
      case "thinking_tokens":
        return [
          {
            type: "usage.updated",
            turnId: this.#activeTurnId,
            payload: {
              usage: {
                reasoningTokens: Math.max(0, asNumber(message["estimated_tokens"]) ?? 0),
                estimated: true,
                scope: "turn",
              },
            },
          },
        ];
      case "model_refusal_fallback":
        return [
          this.#warning(
            "model-refusal-fallback",
            `${String(message["original_model"] ?? "?")} → ${String(message["fallback_model"] ?? "?")}`,
          ),
        ];
      case "model_refusal_no_fallback":
        return this.#failActive(
          adapterError("policy.permission-denied", {
            message: `model refused without fallback: ${String(message["api_refusal_explanation"] ?? "refusal")}`.slice(0, 400),
            backendCode: "model_refusal_no_fallback",
          }),
        );
      case "informational": {
        if (message["level"] === "warning") {
          return [this.#warning("informational", String(message["content"] ?? "").slice(0, 400))];
        }
        return this.#drop("system/informational", 1);
      }
      case "hook_started":
      case "hook_progress":
      case "hook_response":
      case "plugin_install":
      case "local_command_output":
      case "notification":
      case "files_persisted":
      case "elicitation_complete":
      case "commands_changed":
      case "background_tasks_changed":
        return this.#drop(`system/${String(subtype)}`, 1);
      default:
        return this.#drop(`system/${String(subtype ?? "unknown")}`, 1);
    }
  }

  #onInit(message: SdkInitMessage): AdapterEvent[] {
    this.#sessionId = typeof message.session_id === "string" ? message.session_id : this.#sessionId;
    if (typeof message.model === "string") this.#model = message.model;
    if (this.#sessionCreated) {
      return [this.diagnostic("debug", `re-init observed (session ${String(this.#sessionId)})`)];
    }
    this.#sessionCreated = true;
    return [
      {
        type: "session.created",
        payload: { state: "running", cwd: String(message.cwd ?? "").slice(0, 512) },
      },
    ];
  }

  #handleConversationReset(message: SdkMessage): AdapterEvent[] {
    const newId = asString(message["new_conversation_id"]);
    if (newId !== undefined) {
      this.#sessionId = newId;
      this.#onConversationReset?.(newId);
    }
    return [this.#warning("conversation-reset", `claude conversation reset to ${String(newId ?? "?")}`)];
  }

  /* ------------------------------------------------------------------ stream_event */

  #onStreamEvent(message: SdkMessage): AdapterEvent[] {
    const event = asRecord(message["event"]);
    if (event === undefined) return this.#drop("stream_event:invalid", 1);
    const eventType = asString(event["type"]);
    const state = this.#ensureActiveTurn();
    const messageId = this.#currentMessageId(state, message);
    switch (eventType) {
      case "message_start": {
        const inner = asRecord(event["message"]);
        const id = asString(inner?.["id"]) ?? messageId;
        if (state !== undefined) state.currentMessageId = id;
        // W4：先用旧 #model 快照本轮 turn.started，再把 message_start 实测值学入 #model（供下一轮）——
        // 顺序反了会让本轮尚未发出的 turn.started 抢跑拿到流内 fallback 值。
        const turnStarted = this.#ensureTurnStarted(state);
        if (inner !== undefined && typeof inner["model"] === "string") this.#model = inner["model"];
        return [
          ...turnStarted,
          { type: "message.started", turnId: state?.turnId, payload: { channel: "assistant", messageId: id.slice(0, 128) } },
        ];
      }
      case "content_block_start": {
        const block = asRecord(event["content_block"]);
        const type = asString(block?.["type"]);
        const index = asNumber(event["index"]);
        if (type === "tool_use" && block !== undefined) {
          const id = asString(block["id"]) ?? `tool_${index ?? 0}`;
          const name = asString(block["name"]) ?? "unknown";
          if (state !== undefined) {
            if (index !== undefined) state.toolBlocks.set(index, id);
            state.toolStarted.add(id);
          }
          return [
            ...this.#ensureTurnStarted(state),
            {
              type: "tool.started",
              turnId: state?.turnId,
              payload: { toolCallId: id.slice(0, 128), name: name.slice(0, 128), kind: kindOfTool(name) },
            },
          ];
        }
        return [];
      }
      case "content_block_delta": {
        const delta = asRecord(event["delta"]);
        const deltaType = delta === undefined ? undefined : asString(delta["type"]);
        if (delta === undefined) return this.#drop("stream_event:delta-invalid", 1);
        if (deltaType === "text_delta") {
          const text = asString(delta["text"]) ?? "";
          if (text.length === 0) return [];
          return [
            ...this.#ensureTurnStarted(state),
            {
              type: "message.delta",
              turnId: state?.turnId,
              payload: { channel: "assistant", text, granularity: "token", messageId: (state?.currentMessageId ?? messageId).slice(0, 128) },
            },
          ];
        }
        if (deltaType === "thinking_delta") {
          const text = asString(delta["thinking"]) ?? "";
          if (text.length === 0) return [];
          state?.thinkingBuffer.push(text);
          return [
            ...this.#ensureTurnStarted(state),
            { type: "reasoning.delta", turnId: state?.turnId, payload: { text, granularity: "token" } },
          ];
        }
        if (deltaType === "input_json_delta") {
          const index = asNumber(event["index"]);
          const toolCallId = index === undefined ? undefined : state?.toolBlocks.get(index);
          if (toolCallId === undefined) return this.#drop("stream_event:input-json-no-tool", 1);
          const text = asString(delta["partial_json"]) ?? "";
          if (text.length === 0) return [];
          return [{ type: "tool.progress", turnId: state?.turnId, payload: { toolCallId: toolCallId.slice(0, 128), text: text.slice(0, 2000) } }];
        }
        return [];
      }
      case "message_delta": {
        const usage = asRecord(event["usage"]);
        if (usage === undefined) return [];
        const input = asNumber(usage["input_tokens"]);
        const output = asNumber(usage["output_tokens"]);
        if (state !== undefined) {
          if (input !== undefined) state.usage.inputTokens = input;
          if (output !== undefined) state.usage.outputTokens = output;
        }
        return [
          {
            type: "usage.updated",
            turnId: state?.turnId,
            payload: {
              usage: {
                ...(input === undefined ? {} : { inputTokens: input }),
                ...(output === undefined ? {} : { outputTokens: output }),
                estimated: false,
                scope: "turn",
              },
            },
          },
        ];
      }
      case "content_block_stop":
      case "message_stop":
      case "ping":
        return [];
      default:
        return this.#drop(`stream_event/${String(eventType)}`, 1);
    }
  }

  /* ------------------------------------------------------------------ assistant / user */

  #onAssistant(message: SdkMessage): AdapterEvent[] {
    const state = this.#ensureActiveTurn();
    const content = asArray(asRecord(message["message"])?.["content"]);
    const messageId = asString(message["uuid"]) ?? state?.currentMessageId ?? "msg_unknown";
    const assistantErrorName = message["error"];
    if (assistantErrorName !== undefined && state !== undefined) {
      state.assistantError = mapAssistantError(assistantErrorName, `assistant error: ${String(assistantErrorName)}`);
    }
    const events: AdapterEvent[] = [];
    const texts: string[] = [];
    const thinking: string[] = [];
    for (const block of content) {
      const record = asRecord(block);
      const type = asString(record?.["type"]);
      if (type === "text") {
        const text = asString(record?.["text"]);
        if (text !== undefined) texts.push(text);
      } else if (type === "thinking") {
        const text = asString(record?.["thinking"]);
        if (text !== undefined) thinking.push(text);
      } else if (type === "tool_use") {
        const id = asString(record?.["id"]) ?? `tool_${events.length}`;
        const name = asString(record?.["name"]) ?? "unknown";
        if (state === undefined || !state.toolStarted.has(id)) {
          state?.toolStarted.add(id);
          events.push({
            type: "tool.started",
            turnId: state?.turnId,
            payload: { toolCallId: id.slice(0, 128), name: name.slice(0, 128), kind: kindOfTool(name) },
          });
        }
      }
    }
    if (texts.length > 0) {
      const text = texts.join("");
      events.unshift({
        type: "message.completed",
        turnId: state?.turnId,
        payload: {
          channel: "assistant",
          text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
          messageId: messageId.slice(0, 128),
          ...(text.length > MAX_TEXT ? { truncated: true } : {}),
        },
      });
    }
    if (thinking.length > 0) {
      events.push({ type: "reasoning.summary", turnId: state?.turnId, payload: { text: thinking.join("\n").slice(0, MAX_TEXT) } });
    }
    // W4：轮内首批 message/tool 事件前补 turn.started；纯 thinking 批次不触发（保持既有顺序断言）。
    if (events.some((event) => event.type === "message.completed" || event.type === "tool.started")) {
      events.unshift(...this.#ensureTurnStarted(state));
    }
    return events;
  }

  #onUser(message: SdkMessage): AdapterEvent[] {
    const state = this.#ensureActiveTurn();
    const content = asArray(asRecord(message["message"])?.["content"]);
    const events: AdapterEvent[] = [];
    for (const block of content) {
      const record = asRecord(block);
      if (asString(record?.["type"]) !== "tool_result") continue;
      const blockValue = record as unknown as SdkUserContentBlock;
      const toolUseId = asString(blockValue.tool_use_id) ?? "tool_unknown";
      const isError = blockValue.is_error === true;
      events.push({
        type: "tool.completed",
        turnId: state?.turnId,
        payload: {
          toolCallId: toolUseId.slice(0, 128),
          status: isError ? "error" : "ok",
          outputDigest: digestOf(JSON.stringify(blockValue.content ?? "")),
        },
      });
    }
    if (events.length === 0) return this.#silentDrop("user:echo", 1);
    return events;
  }

  /* ------------------------------------------------------------------ result / 其他 */

  #onResult(message: SdkResultMessage): AdapterEvent[] {
    const state = this.#ensureActiveTurn();
    if (state === undefined) return this.#drop("result:no-active-turn", 1, true);
    if (state.terminal) return this.#silentDrop("result:late", 1);
    // W4：result 是轮内事件兜底——此前无任何轮内事件时，在这里补上每轮恰一条的 turn.started。
    // 先补（#ensureTurnStarted 会跳过已终态的轮）再落 terminal。
    const turnStarted = this.#ensureTurnStarted(state);
    state.terminal = true;
    const usage = this.#usageRef(message, state);
    const events: AdapterEvent[] = [
      ...turnStarted,
      {
        type: "usage.updated",
        turnId: state.turnId,
        payload: {
          usage: {
            ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
            ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
            ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
            ...(usage.durationMs === undefined ? {} : { durationMs: usage.durationMs }),
            estimated: false,
            scope: "turn",
          },
        },
      },
    ];
    if (state.interrupted) {
      events.push({ type: "turn.aborted", turnId: state.turnId, payload: { interruptMethod: "native", partial: true } });
      this.#activeTurnId = undefined;
      return events;
    }
    const subtype = String(message.subtype);
    const isError = message.is_error === true;
    const resultText = typeof message.result === "string" ? message.result.trim() : "";
    if (subtype === "success" && !isError && resultText.length > 0) {
      events.push({
        type: "turn.completed",
        turnId: state.turnId,
        payload: { stopReason: stopReasonOf(message.stop_reason), usage },
      });
    } else {
      const error =
        subtype === "success"
          ? adapterError("backend.internal-error", {
              message: "claude result was 'success' but empty or error-flagged",
              backendCode: "empty-success",
            })
          : mapResultError(subtype, message.errors, state.assistantError);
      events.push({ type: "turn.failed", turnId: state.turnId, payload: { error: toErrorRef(error), partial: true } });
    }
    this.#activeTurnId = undefined;
    return events;
  }

  #onToolProgress(message: SdkMessage): AdapterEvent[] {
    const state = this.#ensureActiveTurn();
    const toolUseId = asString(message["tool_use_id"]);
    if (toolUseId === undefined) return this.#drop("tool_progress:invalid", 1);
    const elapsed = asNumber(message["elapsed_time_seconds"]);
    const toolName = asString(message["tool_name"]) ?? "tool";
    return [
      {
        type: "tool.progress",
        turnId: state?.turnId,
        payload: {
          toolCallId: toolUseId.slice(0, 128),
          text: `${toolName} running${elapsed === undefined ? "" : ` ${elapsed}s`}`.slice(0, 2000),
        },
      },
    ];
  }

  #onRateLimit(message: SdkMessage): AdapterEvent[] {
    const info = asRecord(message["rate_limit_info"]);
    const status = asString(info?.["status"]);
    const overage = asString(info?.["overageDisabledReason"]);
    if (status === "rejected" && overage === "out_of_credits") {
      return [this.#warning("quota.usage-exhausted", "claude quota exhausted (out of credits)")];
    }
    if (status === "rejected") return [this.#warning("quota.rate-limited", "claude rate limit rejected")];
    return [this.#warning("rate-limit-warning", `claude rate limit ${String(status ?? "unknown")}`)];
  }

  #onAuthStatus(message: SdkMessage): AdapterEvent[] {
    const error = asString(message["error"]);
    if (error !== undefined && error.length > 0) {
      return [this.#warning("auth-status", `claude auth error: ${error.slice(0, 200)}`)];
    }
    if (message["isAuthenticating"] === true) return [];
    return this.#silentDrop("auth_status:idle", 1);
  }

  /* ------------------------------------------------------------------ 内部 */

  #ensureActiveTurn(): TurnState | undefined {
    if (this.#activeTurnId !== undefined) {
      const state = this.#turns.get(this.#activeTurnId);
      if (state !== undefined && !state.terminal) return state;
    }
    let latest: TurnState | undefined;
    for (const state of this.#turns.values()) {
      if (!state.terminal) latest = state;
    }
    this.#activeTurnId = latest?.turnId;
    return latest;
  }

  #activeState(): TurnState | undefined {
    return this.#activeTurnId === undefined ? undefined : this.#turns.get(this.#activeTurnId);
  }

  #currentMessageId(state: TurnState | undefined, message: SdkMessage): string {
    return state?.currentMessageId ?? asString(message["uuid"]) ?? "msg_stream";
  }

  /** 适配器在 send 时创建一轮（turnId 由适配器生成并登记）。 */
  createTurn(turnId: string): void {
    if (this.#turns.has(turnId)) return;
    this.#turns.set(turnId, {
      turnId,
      terminal: false,
      interrupted: false,
      started: false,
      currentMessageId: undefined,
      toolBlocks: new Map(),
      toolStarted: new Set(),
      thinkingBuffer: [],
      usage: {},
      assistantError: undefined,
    });
    this.#activeTurnId = turnId;
  }

  /**
   * W4：每轮首个轮内事件前补 `turn.started`（每轮恰一条；kimi/opencode 映射器同构）。
   * model 取 `system/init` / `message_start` 实测值；init 未到（stream 模式下 init 在
   * 首个输入之后）时为空串——facade 对空串不记 `reported`，投影回 configured/unknown，
   * 不伪造模型值。仅在确有活动轮时发（system/init 本身不触发）。
   */
  #ensureTurnStarted(state: TurnState | undefined): AdapterEvent[] {
    if (state === undefined || state.started || state.terminal) return [];
    state.started = true;
    return [
      {
        type: "turn.started",
        turnId: state.turnId,
        payload: { model: this.#model ?? "", delivery: "caller" },
      },
    ];
  }

  #failActive(error: AdapterError): AdapterEvent[] {
    const state = this.#ensureActiveTurn();
    if (state === undefined || state.terminal) return [this.#warning(error.code, error.message)];
    state.terminal = true;
    this.#activeTurnId = undefined;
    return [{ type: "turn.failed", turnId: state.turnId, payload: { error: toErrorRef(error), partial: true } }];
  }

  #usageRef(message: SdkResultMessage, state: TurnState): {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    durationMs?: number;
    estimated: boolean;
    scope: "turn";
  } {
    const usage: SdkUsage | undefined = message.usage;
    const input = usage?.input_tokens ?? state.usage.inputTokens;
    const output = usage?.output_tokens ?? state.usage.outputTokens;
    const cost = asNumber(message.total_cost_usd);
    const duration = asNumber(message.duration_ms);
    return {
      ...(input === undefined ? {} : { inputTokens: input }),
      ...(output === undefined ? {} : { outputTokens: output }),
      ...(cost === undefined ? {} : { costUsd: cost }),
      ...(duration === undefined ? {} : { durationMs: duration }),
      estimated: false,
      scope: "turn",
    };
  }

  #warning(code: string, message: string): AdapterEvent {
    return {
      type: "session.warning",
      payload: { code: code.slice(0, 64), message: message.slice(0, 400), degrade: true },
    };
  }

  /** 协议竞态类丢弃（不回告警）。 */
  #silentDrop(reason: string, count: number): AdapterEvent[] {
    this.#dropped.set(reason, (this.#dropped.get(reason) ?? 0) + count);
    this.#droppedTotal += count;
    return [];
  }

  #drop(reason: string, count: number, silent = false): AdapterEvent[] {
    if (silent) return this.#silentDrop(reason, count);
    this.#dropped.set(reason, (this.#dropped.get(reason) ?? 0) + count);
    this.#droppedTotal += count;
    const now = this.#now();
    if (now - this.#lastWarningAt < this.#warningWindowMs) return [];
    this.#lastWarningAt = now;
    this.#warnings += 1;
    const top = [...this.#dropped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const detail = top.map(([name, hits]) => `${name}×${hits}`).join(", ");
    return [this.#warning("adapter.event-dropped", `dropped ${this.#droppedTotal} unmapped messages (${detail})`)];
  }
}

function kindOfTool(toolName: string): string {
  if (["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"].includes(toolName)) return "read";
  if (["Write", "Edit", "NotebookEdit", "MultiEdit"].includes(toolName)) return "write";
  if (["Bash", "BashOutput", "KillShell"].includes(toolName)) return "execute";
  if (["WebFetch", "WebSearch"].includes(toolName)) return "network";
  if (toolName === "Task" || toolName === "Agent") return "subagent";
  return "unknown";
}

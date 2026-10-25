/**
 * opencode 原生事件 → ABI 事件映射（docs/adapters/opencode.md §5；事件名真源 = src/abi/events.ts）。
 *
 * 覆盖三个面：
 * - v2 SSE（实测 26 类；catalog 噪声必须丢弃计数）；
 * - ACP `session/update`（实测子集：agent_message_chunk / usage_update / config_option_update / available_commands_update）；
 * - CLI `--format json` JSONL（实测：step_start / text / step_finish / error）。
 *
 * 不变量：
 * - 一轮最多一个终态事件（turn.completed/failed/aborted），重复终态丢弃计数；
 * - 无法映射的 type 一律丢弃计数，不伪造 ABI 事件；
 * - 非 ABI 事件名不得外泄（原生名只出现在本文件内部）。
 */
import { createHash } from "node:crypto";
import type { AdapterEvent } from "../../abi/adapter.ts";
import type {
  ErrorRef,
  PermissionOption,
  PermissionRequestedPayload,
  PermissionRisk,
  StreamGranularity,
  UsageRef,
} from "../../abi/types.ts";
import { mapRawRuntimeError, toMoclError } from "./errors.ts";
import type { AcpPromptResult, AcpSessionUpdateParams, SseFrame, TokenUsage } from "./types.ts";

/** catalog / 工程元数据噪声：与任务无关，必须丢弃计数（§5.2 #27）。 */
export const CATALOG_NOISE_TYPES: ReadonlySet<string> = new Set([
  "integration.updated",
  "provider.updated",
  "model.updated",
  "agent.updated",
  "command.updated",
  "skill.updated",
  "websearch.updated",
  "reference.updated",
  "plugin.updated",
]);

/** 内部标记事件：不进 ABI，但需要计数（§5.5）。 */
const INTERNAL_TYPES: ReadonlySet<string> = new Set([
  "session.inbox.delivered",
  "session.step.started",
  "session.step.streamed",
  "session.instructions.updated",
]);

/** opencode 权限应答枚举（OpenAPI `Permission.Reply`）→ ABI options。 */
export const OPENCODE_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { id: "once", kind: "allow-once" },
  { id: "always", kind: "allow-always" },
  { id: "reject", kind: "deny-once" },
];

/** 丢弃计数器（catalog 噪声、内部标记、未知类型、重复终态…）。 */
export class EventDropCounters {
  readonly #counts = new Map<string, number>();

  inc(key: string): void {
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.#counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  get total(): number {
    let sum = 0;
    for (const value of this.#counts.values()) sum += value;
    return sum;
  }
}

export interface SseMapperOptions {
  readonly sessionId: string;
  readonly model: string;
}

/** v2 SSE / ACP update → ABI 事件状态机（一个适配器实例共享；按 turn 重置）。 */
export class OpenCodeEventMapper {
  readonly #sessionId: string;
  readonly #counters: EventDropCounters;
  #model: string;
  #turnId: string | null = null;
  #terminal = false;
  #turnStarted = false;
  #usage: UsageRef | null = null;
  #pendingAbort = false;
  #queuePosition = 0;
  #ready = false;

  constructor(options: SseMapperOptions, counters: EventDropCounters = new EventDropCounters()) {
    this.#sessionId = options.sessionId;
    this.#model = options.model;
    this.#counters = counters;
  }

  get counters(): EventDropCounters {
    return this.#counters;
  }

  get currentTurnId(): string | null {
    return this.#turnId;
  }

  get terminalEmitted(): boolean {
    return this.#terminal;
  }

  get usage(): UsageRef | null {
    return this.#usage;
  }

  /** 开始一轮（适配器 send 分配 turnId 后调用）。 */
  beginTurn(turnId: string, model?: string): void {
    this.#turnId = turnId;
    if (model !== undefined) this.#model = model;
    this.#terminal = false;
    this.#turnStarted = false;
    this.#usage = null;
    this.#pendingAbort = false;
    this.#queuePosition = 0;
  }

  /** 中断：若尚无终态则产出 turn.aborted（幂等）。 */
  interrupt(method: "native" | "process-kill" = "native"): AdapterEvent[] {
    if (this.#turnId === null || this.#terminal) return [];
    this.#terminal = true;
    return [this.#turnEvent("turn.aborted", { interruptMethod: method, partial: true })];
  }

  /** v2 SSE 帧 → ABI 事件数组。 */
  map(frame: SseFrame): AdapterEvent[] {
    const type = frame.type;
    if (CATALOG_NOISE_TYPES.has(type)) {
      this.#counters.inc("drop.catalog_event");
      return [];
    }
    if (INTERNAL_TYPES.has(type)) {
      this.#counters.inc("drop.internal_event");
      return [];
    }
    const data = frame.data ?? {};
    switch (type) {
      case "server.connected": {
        if (this.#ready) {
          this.#counters.inc("drop.duplicate_ready");
          return [];
        }
        this.#ready = true;
        return [
          {
            type: "transport.state-changed",
            payload: { transport: "http-api", state: "ready" },
          },
        ];
      }
      case "session.created": {
        this.#counters.inc("drop.duplicate_session_created");
        return [];
      }
      case "session.inbox.enqueued": {
        this.#queuePosition += 1;
        return [this.#turnEvent("turn.queued", { queuePosition: this.#queuePosition })];
      }
      case "session.execution.started": {
        return this.#ensureTurnStarted();
      }
      case "session.step.started": {
        const agent = data["agent"];
        const model = data["model"];
        void agent;
        if (isModelRefLike(model)) this.#model = `${model.providerID}/${model.id}`;
        return this.#ensureTurnStarted();
      }
      case "session.text.started": {
        const events = this.#ensureTurnStarted();
        const messageId = messageIdOf(data);
        return [...events, this.#turnEvent("message.started", { channel: "assistant", messageId })];
      }
      case "session.text.delta": {
        const events = this.#ensureTurnStarted();
        const messageId = messageIdOf(data);
        const text = typeof data["delta"] === "string" ? data["delta"] : "";
        // 实测 delta ≈50 字/chunk → ABI 粒度按 message（不宣称 token 级，§5.6）。
        const granularity: StreamGranularity = "message";
        return [...events, this.#turnEvent("message.delta", { channel: "assistant", text, granularity, messageId })];
      }
      case "session.text.ended": {
        const messageId = messageIdOf(data);
        const text = typeof data["text"] === "string" ? data["text"] : "";
        return [this.#turnEvent("message.completed", { channel: "assistant", text, messageId })];
      }
      case "session.reasoning.started": {
        return this.#ensureTurnStarted();
      }
      case "session.reasoning.delta": {
        const text = typeof data["delta"] === "string" ? data["delta"] : "";
        const messageId = optionalMessageId(data);
        return [
          this.#turnEvent("reasoning.delta", {
            text,
            granularity: "message",
            ...(messageId === undefined ? {} : { messageId }),
          }),
        ];
      }
      case "session.reasoning.ended": {
        const text = typeof data["text"] === "string" ? data["text"] : "";
        return text.length === 0 ? [] : [this.#turnEvent("reasoning.summary", { text })];
      }
      case "session.usage.updated": {
        this.#usage = usageFromTokens(data["tokens"], data["cost"], false);
        return [this.#turnEvent("usage.updated", { usage: this.#usage })];
      }
      case "session.step.ended": {
        this.#usage = usageFromTokens(data["tokens"], data["cost"], false);
        return [this.#turnEvent("usage.updated", { usage: this.#usage })];
      }
      case "session.step.failed": {
        const raw = data["error"];
        const type = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["type"] : undefined;
        if (type === "aborted") {
          this.#pendingAbort = true;
          return []; // execution.interrupted 会产出唯一终态
        }
        return this.#failTurn(raw);
      }
      case "session.execution.succeeded": {
        if (this.#terminal) {
          this.#counters.inc("drop.duplicate_terminal");
          return [];
        }
        this.#terminal = true;
        return [
          this.#turnEvent("turn.completed", {
            stopReason: "end-turn",
            usage: this.#usage ?? { estimated: true, scope: "turn" },
          }),
        ];
      }
      case "session.execution.failed": {
        if (this.#pendingAbort) return this.interrupt("native");
        return this.#failTurn(data["error"]);
      }
      case "session.execution.interrupted": {
        const reason = data["reason"];
        void reason;
        return this.interrupt("native");
      }
      case "permission.asked": {
        return [this.#permissionRequested(data)];
      }
      default: {
        this.#counters.inc(`drop.unknown_type.${sanitizeType(type)}`);
        return [];
      }
    }
  }

  /** ACP `session/update` → ABI 事件（§5.3）。 */
  mapAcpUpdate(params: AcpSessionUpdateParams): AdapterEvent[] {
    const update = params.update;
    const kind = typeof update["sessionUpdate"] === "string" ? update["sessionUpdate"] : "unknown";
    switch (kind) {
      case "agent_message_chunk": {
        const content = update["content"];
        const text = isTextContent(content) ? content.text : "";
        const messageId = optionalMessageId(update) ?? "msg_acp";
        return [this.#turnEvent("message.delta", { channel: "assistant", text, granularity: "message", messageId })];
      }
      case "agent_thought_chunk": {
        const content = update["content"];
        const text = isTextContent(content) ? content.text : "";
        return [this.#turnEvent("reasoning.delta", { text, granularity: "message" })];
      }
      case "tool_call": {
        const toolCallId = typeof update["toolCallId"] === "string" ? update["toolCallId"] : "tool_unknown";
        const title = typeof update["title"] === "string" ? update["title"] : "tool";
        const toolKind = typeof update["kind"] === "string" ? update["kind"] : undefined;
        return [
          this.#turnEvent("tool.started", {
            toolCallId,
            name: title,
            ...(toolKind === undefined ? {} : { kind: toolKind }),
          }),
        ];
      }
      case "tool_call_update": {
        const toolCallId = typeof update["toolCallId"] === "string" ? update["toolCallId"] : "tool_unknown";
        const status = update["status"];
        if (status === "in_progress") {
          const rawInput = update["rawInput"];
          const text = typeof rawInput === "string" ? rawInput : "";
          return [this.#turnEvent("tool.progress", { toolCallId, text })];
        }
        const rawOutput = update["rawOutput"];
        const output = typeof rawOutput === "string" ? rawOutput : "";
        return [
          this.#turnEvent("tool.completed", {
            toolCallId,
            status: "ok",
            outputDigest: digest(output),
          }),
        ];
      }
      case "usage_update": {
        this.#usage = usageFromAcpUsage(update);
        return [this.#turnEvent("usage.updated", { usage: this.#usage })];
      }
      case "available_commands_update":
      case "config_option_update":
      case "current_mode_update": {
        this.#counters.inc("drop.acp_internal");
        return [];
      }
      default: {
        this.#counters.inc(`drop.unknown_acp_update.${sanitizeType(kind)}`);
        return [];
      }
    }
  }

  /** `session/prompt` 结果 → turn.completed（ACP/CLI 同步终态路径）。 */
  mapPromptResult(result: AcpPromptResult): AdapterEvent[] {
    if (this.#terminal) {
      this.#counters.inc("drop.duplicate_terminal");
      return [];
    }
    this.#terminal = true;
    this.#usage = result.usage === undefined ? this.#usage : usageFromAcpUsage(result.usage);
    return [
      this.#turnEvent("turn.completed", {
        stopReason: mapAcpStopReason(result.stopReason),
        usage: this.#usage ?? { estimated: true, scope: "turn" },
      }),
    ];
  }

  /** CLI `--format json` JSONL 行 → ABI 事件（§5.4；最后兜底通道）。 */
  mapCliEvent(raw: Readonly<Record<string, unknown>>): AdapterEvent[] {
    const type = raw["type"];
    const part = raw["part"];
    const data = part !== null && typeof part === "object" ? (part as Record<string, unknown>) : {};
    switch (type) {
      case "step_start": {
        return this.#ensureTurnStarted();
      }
      case "text": {
        const text = typeof data["text"] === "string" ? data["text"] : "";
        const messageId = optionalMessageId(data) ?? "msg_cli";
        return [this.#turnEvent("message.completed", { channel: "assistant", text, messageId })];
      }
      case "step_finish": {
        if (this.#terminal) {
          this.#counters.inc("drop.duplicate_terminal");
          return [];
        }
        this.#terminal = true;
        this.#usage = usageFromTokens(data["tokens"], data["cost"], false);
        return [
          this.#turnEvent("turn.completed", {
            stopReason: mapCliStopReason(data["reason"]),
            usage: this.#usage,
          }),
        ];
      }
      case "error": {
        return this.#failTurn(raw["error"]);
      }
      default:
        this.#counters.inc(`drop.unknown_cli_type.${sanitizeType(String(type))}`);
        return [];
    }
  }

  /* ---------------- 内部 ---------------- */

  #ensureTurnStarted(): AdapterEvent[] {
    if (this.#terminal || this.#turnStarted) return [];
    this.#turnStarted = true;
    return [this.#turnEvent("turn.started", { model: this.#model, delivery: "caller" })];
  }

  #failTurn(raw: unknown): AdapterEvent[] {
    if (this.#terminal) {
      this.#counters.inc("drop.duplicate_terminal");
      return [];
    }
    this.#terminal = true;
    const error = mapRawRuntimeError(raw);
    const errorRef: ErrorRef = error.toErrorRef({ sessionId: this.#sessionId, ...(this.#turnId === null ? {} : { turnId: this.#turnId }) });
    return [this.#turnEvent("turn.failed", { error: errorRef, partial: false })];
  }

  #permissionRequested(data: Readonly<Record<string, unknown>>): AdapterEvent {
    const requestId = typeof data["id"] === "string" ? data["id"] : `per_${digest(JSON.stringify(data))}`;
    const action = typeof data["action"] === "string" ? data["action"] : "unknown";
    const resources = Array.isArray(data["resources"])
      ? (data["resources"] as readonly unknown[]).filter((item): item is string => typeof item === "string")
      : [];
    const payload: PermissionRequestedPayload = {
      requestId,
      tool: action,
      risk: permissionRiskFromAction(action, resources),
      options: OPENCODE_PERMISSION_OPTIONS,
      summary: resources.length === 0 ? action : `${action} ${resources.join(", ")}`,
    };
    return this.#turnEvent("permission.requested", payload);
  }

  #turnEvent(type: AdapterEvent["type"], payload: unknown): AdapterEvent {
    return this.#turnId === null ? { type, payload } : { type, turnId: this.#turnId, payload };
  }
}

/* ------------------------------------------------------------------ */
/* 导出工具                                                            */
/* ------------------------------------------------------------------ */

export function permissionRiskFromAction(action: string, resources: readonly string[] = []): PermissionRisk {
  const text = `${action} ${resources.join(" ")}`.toLowerCase();
  if (/websearch|webfetch|network|fetch|http/.test(text)) return "network";
  if (/bash|shell|command|exec|terminal/.test(text)) return "execute";
  if (/edit|write|patch|create|delete|remove|rename/.test(text)) return "write";
  if (/read|glob|grep|list|search|view/.test(text)) return "read";
  return "unknown";
}

export function mapAcpStopReason(reason: string): "end-turn" | "max-turns" | "stop-sequence" | "context-limit" | "other" {
  switch (reason) {
    case "end_turn":
      return "end-turn";
    case "max_tokens":
      return "context-limit";
    case "max_turns":
      return "max-turns";
    case "stop_sequence":
      return "stop-sequence";
    default:
      return "other";
  }
}

export function mapCliStopReason(reason: unknown): "end-turn" | "max-turns" | "stop-sequence" | "context-limit" | "other" {
  if (reason === "stop") return "end-turn";
  if (typeof reason === "string") return mapAcpStopReason(reason);
  return "other";
}

/** `{providerID,id}` 形状（step.started.model）。 */
function isModelRefLike(value: unknown): value is { readonly providerID: string; readonly id: string } {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["providerID"] === "string" && typeof record["id"] === "string";
}

function isTextContent(value: unknown): value is { readonly type: string; readonly text: string } {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record["type"] === "text" && typeof record["text"] === "string";
}

function messageIdOf(data: Readonly<Record<string, unknown>>): string {
  return optionalMessageId(data) ?? "msg_unknown";
}

function optionalMessageId(data: Readonly<Record<string, unknown>>): string | undefined {
  const id = data["assistantMessageID"] ?? data["messageID"] ?? data["messageId"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function sanitizeType(type: string): string {
  return type.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

export function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** 用量对象 → ABI `UsageRef`（缺省 estimated:true：没拿到 tokens 时不伪造 0）。 */
export function usageFromTokens(
  tokens: unknown,
  cost: unknown,
  estimatedWhenMissing = true,
): UsageRef {
  const usage: {
    -readonly [K in keyof UsageRef]: UsageRef[K];
  } = { estimated: false, scope: "turn" };
  if (tokens !== null && typeof tokens === "object") {
    const record = tokens as TokenUsage;
    if (typeof record.input === "number") usage.inputTokens = record.input;
    if (typeof record.output === "number") usage.outputTokens = record.output;
    if (typeof record.reasoning === "number") usage.reasoningTokens = record.reasoning;
  }
  const costValue = typeof cost === "number" ? cost : costAmount(cost);
  if (costValue !== undefined) usage.costUsd = costValue;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.reasoningTokens === undefined) {
    usage.estimated = estimatedWhenMissing;
  }
  return usage;
}

function usageFromAcpUsage(usage: unknown): UsageRef {
  if (usage === null || typeof usage !== "object") return { estimated: true, scope: "turn" };
  const record = usage as Record<string, unknown>;
  const ref: { -readonly [K in keyof UsageRef]: UsageRef[K] } = { estimated: false, scope: "turn" };
  if (typeof record["inputTokens"] === "number") ref.inputTokens = record["inputTokens"];
  if (typeof record["outputTokens"] === "number") ref.outputTokens = record["outputTokens"];
  const cost = record["cost"];
  const amount = costAmount(cost);
  if (amount !== undefined) ref.costUsd = amount;
  // 注意：ACP `usage_update.used/size` 是上下文窗口占用，不是 input/output token；
  // 不把 used 伪造成 inputTokens（与 docs/adapters/kimi.md 的处理一致）。
  if (ref.inputTokens === undefined && ref.outputTokens === undefined) ref.estimated = true;
  return ref;
}

function costAmount(cost: unknown): number | undefined {
  if (typeof cost === "number") return cost;
  if (cost !== null && typeof cost === "object") {
    const amount = (cost as Record<string, unknown>)["amount"];
    if (typeof amount === "number") return amount;
  }
  return undefined;
}

export { toMoclError };
export type { TokenUsage };

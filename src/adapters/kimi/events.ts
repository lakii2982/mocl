/**
 * kimi 原生事件 → ABI 事件映射（docs/adapters/kimi.md §5.2 的 27 条；事件名真源 = src/abi/events.ts）。
 *
 * 不变量（本文件的自检口径）：
 * 1. 一轮最多一个终态事件（`turn.completed` / `turn.failed` / `turn.aborted`）；重复终态 → 丢弃计数；
 * 2. 无法映射的原生项**一律丢弃 + 计数**，绝不伪造 ABI 事件、绝不透传原生名；
 * 3. token 级 fragment 原样映射为 `granularity:"token"`，但 `tool_call_update.rawInput` 的逐字符回显
 *    必须丢弃（实测 `{"path":"a` → `{"path":"a.txt"}`，kimi.md:386）；
 * 4. 权限请求**必须真的回包**，否则 turn 挂死（kimi.md:288 与 §7.2）。
 */
import { createHash } from "node:crypto";
import type { AdapterEvent } from "../../abi/adapter.ts";
import type {
  ErrorRef,
  MessageChannel,
  PermissionDecision,
  PermissionOption,
  PermissionRequestedPayload,
  PermissionRisk,
  SessionState,
  StreamGranularity,
  UsageRef,
} from "../../abi/types.ts";
import type { PermissionProfile } from "../../abi/types.ts";
import { moclError, type MoclError } from "../../broker/errors.ts";
import { mapJsonRpcError, toMoclError, type JsonRpcErrorShape } from "./errors.ts";
import { answerPermissionRequest, classifyRisk } from "./permissions.ts";
import type { KimiCliEvent, KimiPermissionOption, KimiPromptResult, KimiSessionUpdateParams } from "./types.ts";

/** 丢弃计数器（§5.3/§11.2：必须暴露，证明丢弃是显式而非漏映射）。 */
export class EventDropCounters {
  readonly #counts = new Map<string, number>();

  inc(key: string): void {
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  get(key: string): number {
    return this.#counts.get(key) ?? 0;
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

/** ACP 4 档 mode → 本适配器声明的 3 档 ABI 档（`default` 归保守侧）。 */
const MODE_TO_APPROVAL: Readonly<Record<string, string>> = {
  plan: "read-only",
  default: "read-only",
  auto: "safe-auto",
  yolo: "yolo",
};

/** kimi `session/update` 里与编排无关、只能丢弃计数的三类（§5.2 #6/#7/#9）。 */
const DROP_UPDATE_KEYS: Readonly<Record<string, string>> = {
  available_commands_update: "drop.available_commands_update",
  session_info_update: "drop.session_info_update",
  config_option_update: "drop.config_option_update",
};

/** CLI `stream-json` 的 meta 帧（system.version / session.resume_hint）→ 丢弃计数（§5.2 #1 类比）。 */
const DROP_CLI_META: ReadonlySet<string> = new Set(["system.version", "session.resume_hint"]);

/** 单个 tool 输出进事件的最大字节；超出只留 digest + truncated（§5.2 #14）。 */
const MAX_TOOL_OUTPUT_BYTES = 8 * 1024;
/** `tool.progress` 合并窗口（§5.2 #13 / §5.4）。 */
const TOOL_PROGRESS_THROTTLE_MS = 200;
/** 单个 assistant 消息保留的权威全文上限（防止内存无界）。 */
const MAX_MESSAGE_CHARS = 256 * 1024;

export interface KimiMapperOptions {
  readonly sessionId: string;
  readonly cwd: string;
  /** 期望的 ABI 档（用于 `current_mode_update` 漂移检测，§5.2 #8）。 */
  readonly expectedProfile: PermissionProfile;
  /** 是否把 reasoning fragment 送上游（默认 false；父会话不应看到 token 洪水）。 */
  readonly includeReasoning?: boolean;
  /** 时钟注入（测试用；默认 `() => new Date()`）。 */
  readonly clock?: () => Date;
}

interface ToolCallState {
  readonly name: string;
  readonly kind?: string;
  lastProgressAt: number;
  lastProgressText: string;
}

/** kimi 原生面 → ABI 事件状态机（每会话一个；按 turn 重置）。 */
export class KimiEventMapper {
  readonly #sessionId: string;
  readonly #cwd: string;
  readonly #counters: EventDropCounters;
  readonly #clock: () => Date;
  #includeReasoning: boolean;
  #expectedProfile: PermissionProfile;

  #turnId: string | null = null;
  #turnStarted = false;
  #terminal = false;
  #model = "";
  #reasoningEffort: string | undefined;

  #messageId: string | null = null;
  #messageStarted = false;
  #messageText = "";
  #messageTruncated = false;

  #usage: UsageRef | null = null;
  #usageWarned = false;
  #turnStartedAtMs: number | null = null;

  #currentModeId: string | null = null;
  #modeDriftWarned = false;

  #titles: string | null = null;
  readonly #tools = new Map<string, ToolCallState>();

  constructor(options: KimiMapperOptions, counters: EventDropCounters = new EventDropCounters()) {
    this.#sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#expectedProfile = options.expectedProfile;
    this.#includeReasoning = options.includeReasoning ?? false;
    this.#clock = options.clock ?? (() => new Date());
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

  /** 会话内部记录的 mode 快照（以 `current_mode_update` 为准，never `session/new.modes`）。 */
  get currentModeId(): string | null {
    return this.#currentModeId;
  }

  get usage(): UsageRef | null {
    return this.#usage;
  }

  /** 会话标题（`session_info_update` 带来的非事件信息）。 */
  get title(): string | null {
    return this.#titles;
  }

  /** 开始一轮（适配器 `send()` 分配 turnId 后调用）。 */
  beginTurn(turnId: string, model: string, reasoningEffort?: string): void {
    this.#turnId = turnId;
    this.#model = model;
    this.#reasoningEffort = reasoningEffort;
    this.#terminal = false;
    this.#turnStarted = false;
    this.#messageId = null;
    this.#messageStarted = false;
    this.#messageText = "";
    this.#messageTruncated = false;
    this.#usage = null;
    this.#turnStartedAtMs = this.#clock().getTime();
    this.#tools.clear();
  }

  /** 运行期切换期望档位（M14 之后；仅影响漂移检测）。 */
  expectProfile(profile: PermissionProfile): void {
    this.#expectedProfile = profile;
    this.#modeDriftWarned = false;
  }

  /** `session.new` 成功 → `session.created`（§5.2 #2）。 */
  sessionCreated(label?: string): AdapterEvent[] {
    return [
      {
        type: "session.created",
        payload: {
          state: "created" satisfies SessionState,
          cwd: this.#cwd,
          ...(label === undefined ? {} : { label }),
        },
      },
    ];
  }

  /** `session/load` 成功 → `session.recovered` + `session.state-changed`（§5.2 #3）。 */
  sessionRecovered(attempt = 1): AdapterEvent[] {
    return [
      {
        type: "session.recovered",
        payload: { strategy: "resume" as const, attempt, replayedEvents: 0 },
      },
      {
        type: "session.state-changed",
        payload: { previousState: "recovering" satisfies SessionState, state: "running" satisfies SessionState, reason: "resume" },
      },
    ];
  }

  /* ------------------------------------------------------------------ */
  /* ACP `session/update`（§5.2 #6–#16）                                  */
  /* ------------------------------------------------------------------ */

  mapAcpUpdate(params: KimiSessionUpdateParams): AdapterEvent[] {
    const update = params.update;
    const kind = typeof update["sessionUpdate"] === "string" ? update["sessionUpdate"] : "unknown";

    const dropKey = DROP_UPDATE_KEYS[kind];
    if (dropKey !== undefined) {
      // session_info_update 的 title 是有用的非事件信息：先记下再丢弃计数。
      if (kind === "session_info_update") {
        const title = update["title"];
        if (typeof title === "string" && title.length > 0) this.#titles = title.slice(0, 200);
      }
      this.#counters.inc(dropKey);
      return [];
    }

    switch (kind) {
      case "current_mode_update":
        return this.#onModeUpdate(update);
      case "agent_thought_chunk":
        return this.#onThoughtChunk(update);
      case "agent_message_chunk":
        return this.#onMessageChunk(update);
      case "tool_call":
        return this.#onToolCall(update);
      case "tool_call_update":
        return this.#onToolCallUpdate(update);
      case "usage_update":
        return this.#onUsageUpdate(update);
      default:
        this.#counters.inc(`drop.unknown_acp_update.${sanitizeType(kind)}`);
        return [];
    }
  }

  /** #8：mode 的**权威**来源；与期望不符 → `session.warning{permission.mode-drift}`。 */
  #onModeUpdate(update: Readonly<Record<string, unknown>>): AdapterEvent[] {
    const modeId = update["currentModeId"];
    if (typeof modeId !== "string") {
      this.#counters.inc("drop.current_mode_update.malformed");
      return [];
    }
    this.#currentModeId = modeId;
    const observedProfile = MODE_TO_APPROVAL[modeId] ?? "read-only";
    if (observedProfile === this.#expectedProfile || this.#modeDriftWarned) return [];
    this.#modeDriftWarned = true;
    return [
      {
        type: "session.warning",
        payload: {
          code: "permission.mode-drift",
          message: `kimi reported mode "${modeId}" (${observedProfile}) but "${this.#expectedProfile}" was requested; enforcing the stricter profile`,
          degrade: true,
          bits: ["permissionModes"],
        },
      },
    ];
  }

  /** #10：一句思考实测 161 条 fragment（kimi.md:386）→ 原样 token 粒度，默认不上抛。 */
  #onThoughtChunk(update: Readonly<Record<string, unknown>>): AdapterEvent[] {
    const text = textOf(update["content"]);
    if (text.length === 0) {
      this.#counters.inc("drop.reasoning_empty");
      return [];
    }
    if (!this.#includeReasoning) {
      this.#counters.inc("fold.reasoning_dropped");
      return [];
    }
    const events = this.#ensureTurnStarted();
    events.push(this.#turnEvent("reasoning.delta", { text, granularity: "token" satisfies StreamGranularity }));
    return events;
  }

  /** #11：`message.started` 首见一次 + `message.delta` 逐 fragment；轮末补权威全文。 */
  #onMessageChunk(update: Readonly<Record<string, unknown>>): AdapterEvent[] {
    const text = textOf(update["content"]);
    if (text.length === 0) {
      this.#counters.inc("drop.message_empty");
      return [];
    }
    const events = this.#ensureTurnStarted();
    const messageId = this.#ensureMessageId();
    if (!this.#messageStarted) {
      this.#messageStarted = true;
      events.push(this.#turnEvent("message.started", { channel: "assistant" satisfies MessageChannel, messageId }));
    }
    if (this.#messageText.length < MAX_MESSAGE_CHARS) {
      this.#messageText += text;
    } else {
      this.#messageTruncated = true;
      this.#counters.inc("fold.message_truncated");
    }
    events.push(
      this.#turnEvent("message.delta", {
        channel: "assistant" satisfies MessageChannel,
        text,
        granularity: "token" satisfies StreamGranularity,
        messageId,
      }),
    );
    return events;
  }

  /** #12：`tool_call`（status=pending，content 为空串）→ `tool.started`。 */
  #onToolCall(update: Readonly<Record<string, unknown>>): AdapterEvent[] {
    const toolCallId = stringOf(update["toolCallId"]) ?? `tool_${digest(JSON.stringify(update))}`;
    const name = stringOf(update["title"]) ?? "tool";
    const kind = stringOf(update["kind"]);
    this.#tools.set(toolCallId, {
      name,
      ...(kind === undefined ? {} : { kind }),
      lastProgressAt: Number.NEGATIVE_INFINITY,
      lastProgressText: "",
    });
    const events = this.#ensureTurnStarted();
    events.push(
      this.#turnEvent("tool.started", {
        toolCallId,
        name,
        ...(kind === undefined ? {} : { kind }),
      }),
    );
    return events;
  }

  /** #13/#14/#15：in_progress（节流）→ progress；completed → completed；failed → failed。 */
  #onToolCallUpdate(update: Readonly<Record<string, unknown>>): AdapterEvent[] {
    const toolCallId = stringOf(update["toolCallId"]) ?? "tool_unknown";
    const status = stringOf(update["status"]);
    const state = this.#tools.get(toolCallId);

    if (status === "failed") {
      const rawError = update["error"];
      const error = moclError("backend.internal-error", {
        message: "kimi tool call failed",
        details: {
          kind: "backend.internal-error",
          backendCode: "tool.failed",
          hint: `errorDigest=${digest(stringifySafe(rawError))}`,
        },
      });
      return [this.#turnEvent("tool.failed", { toolCallId, error: error.toErrorRef({ sessionId: this.#sessionId, ...(this.#turnId === null ? {} : { turnId: this.#turnId }) }), partial: true })];
    }

    if (status === "completed") {
      const rawOutput = update["rawOutput"];
      const output = typeof rawOutput === "string" ? rawOutput : contentTextOf(update["content"]);
      const bytes = Buffer.byteLength(output, "utf8");
      const truncated = bytes > MAX_TOOL_OUTPUT_BYTES;
      if (truncated) this.#counters.inc("fold.tool_output_truncated");
      const events = this.#ensureTurnStarted();
      events.push(
        this.#turnEvent("tool.completed", {
          toolCallId,
          status: "ok" as const,
          outputDigest: digest(output),
          ...(truncated ? { truncated: true } : {}),
        }),
      );
      return events;
    }

    if (status !== undefined && status !== "in_progress" && status !== "pending") {
      this.#counters.inc(`drop.unknown_tool_status.${sanitizeType(status)}`);
      return [];
    }

    // in_progress：rawInput 是逐字符回显（`{"path":"a` → `{"path":"a.txt"`）→ 丢弃计数。
    const rawInput = update["rawInput"];
    if (rawInput !== undefined) this.#counters.inc("drop.tool_rawinput_fragment");
    const text = typeof rawInput === "object" && rawInput !== null
      ? summarizeToolInput(rawInput as Readonly<Record<string, unknown>>)
      : "";
    if (text.length === 0) return [];

    const nowMs = this.#clock().getTime();
    if (state !== undefined && nowMs - state.lastProgressAt < TOOL_PROGRESS_THROTTLE_MS) {
      this.#counters.inc("coalesce.tool_progress");
      return [];
    }
    if (state !== undefined) {
      state.lastProgressAt = nowMs;
      state.lastProgressText = text;
    }
    const events = this.#ensureTurnStarted();
    events.push(this.#turnEvent("tool.progress", { toolCallId, text }));
    return events;
  }

  /**
   * #16：`usage_update{used,size}` 是**上下文窗口占用**，不是计费 token →
   * `usage.updated{estimated:true}` 且不伪造 `inputTokens`；首见补一条 `usage.coarse` warning。
   */
  #onUsageUpdate(update: Readonly<Record<string, unknown>>): AdapterEvent[] {
    const used = numberOf(update["used"]);
    const size = numberOf(update["size"]);
    if (used === null && size === null) {
      this.#counters.inc("drop.usage_malformed");
      return [];
    }
    const durationMs = this.#turnStartedAtMs === null ? undefined : this.#clock().getTime() - this.#turnStartedAtMs;
    this.#usage = {
      estimated: true,
      scope: "turn",
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    const events = this.#ensureTurnStarted();
    events.push(this.#turnEvent("usage.updated", { usage: this.#usage }));
    if (!this.#usageWarned) {
      this.#usageWarned = true;
      events.push({
        type: "session.warning",
        payload: {
          code: "usage.coarse",
          message: `kimi only reports context occupancy (used=${String(used)}, size=${String(size)}); usage is not billable token counts`,
          degrade: true,
          bits: ["usageReporting"],
        },
      });
    }
    return events;
  }

  /* ------------------------------------------------------------------ */
  /* 权限（§5.2 #17/#18）                                                */
  /* ------------------------------------------------------------------ */

  /**
   * `session/request_permission` → `permission.requested` + `permission.resolved`（一次产出，
   * 因为应答是**确定性策略**：无人值守不需要等人工）。
   *
   * @param requestId JSON-RPC 的 id（数字）
   * @returns `answer` 供调用方真的回包；**不回包即挂死**（§7.2）
   */
  mapPermissionRequest(
    requestId: number | string,
    params: Readonly<Record<string, unknown>>,
  ): { readonly events: readonly AdapterEvent[]; readonly answer: { readonly optionId: string; readonly decision: PermissionDecision; readonly risk: PermissionRisk; readonly escalationRequired: boolean } } {
    const toolCall = params["toolCall"];
    const toolRecord = toolCall !== null && typeof toolCall === "object" ? (toolCall as Readonly<Record<string, unknown>>) : {};
    const toolTitle = stringOf(toolRecord["title"]) ?? "unknown";
    const toolKind = stringOf(toolRecord["kind"]);
    const risk = classifyRisk(toolTitle, toolKind);
    const rawOptions = Array.isArray(params["options"]) ? (params["options"] as readonly unknown[]) : [];
    const options: KimiPermissionOption[] = rawOptions
      .filter((item): item is Readonly<Record<string, unknown>> => item !== null && typeof item === "object")
      .map((item) => ({
        optionId: stringOf(item["optionId"]) ?? "",
        ...(stringOf(item["name"]) === undefined ? {} : { name: stringOf(item["name"]) }),
        ...(stringOf(item["kind"]) === undefined ? {} : { kind: stringOf(item["kind"]) }),
      }));
    const answer = answerPermissionRequest(options, this.#profileForAnswering(), risk);

    const abiOptions: readonly PermissionOption[] = options.map((option) => ({
      id: option.optionId,
      kind: abiOptionKindOf(option.kind),
    }));
    const requested: PermissionRequestedPayload = {
      requestId: String(requestId),
      tool: toolTitle,
      risk,
      summary: `${toolTitle}${toolKind === undefined ? "" : ` (${toolKind})`}`,
      options: abiOptions.filter((option) => option.kind !== "cancel"),
    };
    const resolved: PermissionResolvedPayloadLike = {
      requestId: String(requestId),
      decision: answer.decision,
      by: "policy",
      ...(answer.escalationRequired ? { reason: "no matching permission option; fail-closed" } : {}),
    };
    return {
      events: [this.#turnEvent("permission.requested", requested), this.#turnEvent("permission.resolved", resolved)],
      answer,
    };
  }

  /** 当前用于自动应答的档位（`read-only` 一律 deny）。 */
  #profileForAnswering(): PermissionProfile {
    return this.#expectedProfile;
  }

  /* ------------------------------------------------------------------ */
  /* 终态（§5.2 #19–#25）                                                */
  /* ------------------------------------------------------------------ */

  /** #19/#20：`session/prompt` 结果 → `turn.completed`（+ 轮末权威 `message.completed`）。 */
  mapPromptResult(result: KimiPromptResult): AdapterEvent[] {
    if (this.#terminal) {
      this.#counters.inc("drop.duplicate_terminal");
      return [];
    }
    const events = this.#ensureTurnStarted();
    events.push(...this.#flushMessage());
    this.#terminal = true;
    const stopReason = mapStopReason(result.stopReason);
    events.push(
      this.#turnEvent("turn.completed", {
        stopReason,
        usage: this.#usage ?? { estimated: true, scope: "turn" },
      }),
    );
    return events;
  }

  /** #21/#22：`session/prompt` 错误 → `turn.failed`（`session.invalidated` 触发 R-1）。 */
  mapPromptError(error: unknown, context: { readonly method?: string } = {}): AdapterEvent[] {
    if (this.#terminal) {
      this.#counters.inc("drop.duplicate_terminal");
      return [];
    }
    const events = this.#ensureTurnStarted();
    this.#terminal = true;
    const normalized = normalizePromptError(error, context.method);
    events.push(
      this.#turnEvent("turn.failed", {
        error: normalized.toErrorRef({
          sessionId: this.#sessionId,
          ...(this.#turnId === null ? {} : { turnId: this.#turnId }),
        }),
        partial: this.#messageStarted,
      }),
    );
    return events;
  }

  /** #23：`maxTurnMs`/看门狗 → `turn.aborted{timeout}`（调用方随后杀进程组 + `session.lost`）。 */
  mapTimeout(reason: "idle" | "turn" = "turn"): AdapterEvent[] {
    if (this.#terminal) {
      this.#counters.inc("drop.duplicate_terminal");
      return [];
    }
    this.#terminal = true;
    this.#counters.inc(reason === "idle" ? "prompt.timeout.idle" : "prompt.timeout.turn");
    return [this.#turnEvent("turn.aborted", { interruptMethod: "timeout" as const, partial: true })];
  }

  /** #24：进程非本端退出（轮未完成）→ `turn.failed{process.crashed}`。 */
  mapProcessExit(code: number | null, signal: NodeJS.Signals | null): AdapterEvent[] {
    if (this.#terminal) {
      this.#counters.inc("drop.terminal_after_exit");
      return [];
    }
    this.#terminal = true;
    const crashed = moclError("process.crashed", {
      message: `kimi process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
    });
    return [
      this.#turnEvent("turn.failed", {
        error: crashed.toErrorRef({ sessionId: this.#sessionId, ...(this.#turnId === null ? {} : { turnId: this.#turnId }) }),
        partial: this.#messageStarted,
      }),
    ];
  }

  /** #25：本端 `killpg`（M5）→ `turn.aborted{process-kill}`（其中 `partial:true` 是硬语义）。 */
  interrupt(): AdapterEvent[] {
    if (this.#turnId === null || this.#terminal) {
      this.#counters.inc("drop.interrupt_without_active_turn");
      return [];
    }
    this.#terminal = true;
    return [this.#turnEvent("turn.aborted", { interruptMethod: "process-kill" as const, partial: true })];
  }

  /** 会话丢失（中断后 / EOF / 进程崩溃共用）。 */
  sessionLost(reason: string): AdapterEvent[] {
    return [{ type: "session.lost", payload: { reason, lastKnownSeq: 0 } }];
  }

  /** #27：stdout EOF → `transport.state-changed{closed}`。 */
  transportClosed(detail?: string): AdapterEvent[] {
    return [
      {
        type: "transport.state-changed",
        payload: { transport: "acp-stdio", state: "closed", ...(detail === undefined ? {} : { detail }) },
      },
    ];
  }

  /** #27：单帧解析失败 → 计数（连续 5 帧由客户端升级为 `protocol.bad-frame`）。 */
  frameInvalid(detail: string): AdapterEvent[] {
    this.#counters.inc("frame.invalid");
    return [];
  }

  /* ------------------------------------------------------------------ */
  /* CLI 兜底通道（`-p --output-format stream-json`，message-level）        */
  /* ------------------------------------------------------------------ */

  /** CLI 单行事件 → ABI 事件（`granularity:"message"`；本通道无 token 级增量）。 */
  mapCliEvent(raw: KimiCliEvent): AdapterEvent[] {
    const role = raw.role ?? "";
    const type = raw.type ?? "";
    if (role === "meta") {
      if (DROP_CLI_META.has(type)) {
        this.#counters.inc(`drop.cli_meta.${sanitizeType(type)}`);
        return [];
      }
      this.#counters.inc(`drop.unknown_cli_meta.${sanitizeType(type || "unknown")}`);
      return [];
    }
    if (role === "tool") {
      const toolCallId = raw.tool_call_id ?? "tool_cli";
      const output = typeof raw.content === "string" ? raw.content : "";
      const events = this.#ensureTurnStarted();
      events.push(
        this.#turnEvent("tool.completed", {
          toolCallId,
          status: "ok" as const,
          outputDigest: digest(output),
          ...(Buffer.byteLength(output, "utf8") > MAX_TOOL_OUTPUT_BYTES ? { truncated: true } : {}),
        }),
      );
      return events;
    }
    if (role === "assistant") {
      const events = this.#ensureTurnStarted();
      const toolCalls = raw.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        for (const call of toolCalls) {
          const toolCallId = call.id ?? `tool_${digest(JSON.stringify(call))}`;
          const name = call.function?.name ?? "tool";
          events.push(this.#turnEvent("tool.started", { toolCallId, name }));
        }
        return events;
      }
      const content = raw.content;
      if (typeof content === "string" && content.length > 0) {
        const messageId = this.#ensureMessageId();
        if (!this.#messageStarted) {
          this.#messageStarted = true;
          events.push(this.#turnEvent("message.started", { channel: "assistant" satisfies MessageChannel, messageId }));
        }
        this.#messageText += content;
        events.push(
          this.#turnEvent("message.delta", {
            channel: "assistant" satisfies MessageChannel,
            text: content,
            granularity: "message" satisfies StreamGranularity,
            messageId,
          }),
        );
        events.push(this.#turnEvent("message.completed", { channel: "assistant" satisfies MessageChannel, text: content, messageId }));
        return events;
      }
      this.#counters.inc("drop.cli_assistant_empty");
      return events;
    }
    this.#counters.inc(`drop.unknown_cli_role.${sanitizeType(role || "unknown")}`);
    return [];
  }

  /** CLI 进程正常退出 → `turn.completed`（无 `stopReason` 字段，按退出码判定结束）。 */
  finishCliTurn(exitCode: number | null): AdapterEvent[] {
    if (this.#terminal) {
      this.#counters.inc("drop.duplicate_terminal");
      return [];
    }
    const events = this.#ensureTurnStarted();
    events.push(...this.#flushMessage());
    this.#terminal = true;
    events.push(
      this.#turnEvent("turn.completed", {
        stopReason: exitCode === 0 ? ("end-turn" as const) : ("other" as const),
        usage: this.#usage ?? { estimated: true, scope: "turn" },
      }),
    );
    return events;
  }

  /* ---------------- 内部 ---------------- */

  #ensureTurnStarted(): AdapterEvent[] {
    if (this.#terminal || this.#turnStarted) return [];
    this.#turnStarted = true;
    return [
      this.#turnEvent("turn.started", {
        model: this.#model,
        delivery: "caller" as const,
        ...(this.#reasoningEffort === undefined ? {} : { reasoningEffort: this.#reasoningEffort }),
      }),
    ];
  }

  #ensureMessageId(): string {
    if (this.#messageId === null) {
      this.#messageId = `msg_${this.#turnId ?? "noturn"}`;
    }
    return this.#messageId;
  }

  /** 轮末补 `message.completed`（权威全文；ACP 只有 fragment）。 */
  #flushMessage(): AdapterEvent[] {
    if (!this.#messageStarted || this.#messageId === null) return [];
    const messageId = this.#messageId;
    this.#messageStarted = false;
    return [
      this.#turnEvent("message.completed", {
        channel: "assistant" satisfies MessageChannel,
        text: this.#messageText,
        messageId,
        ...(this.#messageTruncated ? { truncated: true } : {}),
      }),
    ];
  }

  #turnEvent(type: AdapterEvent["type"], payload: unknown): AdapterEvent {
    return this.#turnId === null ? { type, payload } : { type, turnId: this.#turnId, payload };
  }
}

/* ------------------------------------------------------------------ */
/* 导出工具                                                            */
/* ------------------------------------------------------------------ */

/** ACP `stopReason` → ABI `stopReason`（§5.2 #19/#20）。 */
export function mapStopReason(reason: string): "end-turn" | "max-turns" | "stop-sequence" | "context-limit" | "other" {
  switch (reason) {
    case "end_turn":
      return "end-turn";
    case "max_turns":
      return "max-turns";
    case "max_tokens":
      return "context-limit";
    case "refusal":
    case "stop_sequence":
      return "other";
    default:
      return "other";
  }
}

/** 权限 option 的原生 `kind` → ABI `kind`（本地重导出，避免上层依赖 permissions.ts 细节）。 */
function abiOptionKindOf(nativeKind: string | undefined): PermissionOption["kind"] {
  switch (nativeKind) {
    case "allow_once":
      return "allow-once";
    case "allow_always":
      return "allow-always";
    case "reject_always":
    case "reject_once":
      return "deny-once";
    case "cancel":
      return "cancel";
    default:
      return "deny-once"; // 未知 kind 一律按拒绝呈现（fail-closed）
  }
}

function normalizePromptError(error: unknown, method: string | undefined): MoclError {
  if (error instanceof Error && "code" in error && "message" in error) {
    const candidate = error as unknown as JsonRpcErrorShape;
    if (typeof candidate.code === "number") {
      return mapJsonRpcError(candidate, { sessionScoped: true, ...(method === undefined ? {} : { method }) });
    }
  }
  return toMoclError(error);
}

function textOf(content: unknown): string {
  if (content === null || typeof content !== "object") return "";
  const record = content as Readonly<Record<string, unknown>>;
  const text = record["text"];
  return typeof text === "string" ? text : "";
}

function contentTextOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Readonly<Record<string, unknown>>;
    const inner = record["content"];
    const text = textOf(inner);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("");
}

function summarizeToolInput(input: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(input).slice(0, 3);
  return entries
    .map(([key, value]) => `${key}=${typeof value === "string" ? value.slice(0, 60) : typeof value}`)
    .join(" ");
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringifySafe(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function sanitizeType(type: string): string {
  return type.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

export function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** `PermissionResolvedPayload` 的本地形状（避免与 types.ts 的 40+ 导出混在一起）。 */
interface PermissionResolvedPayloadLike {
  readonly requestId: string;
  readonly decision: PermissionDecision;
  readonly by: "policy" | "user";
  readonly reason?: string;
}

export type { ErrorRef };

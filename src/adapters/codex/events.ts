/**
 * codex 通知 → ABI 事件映射（施工 C4；设计 §5.2 表）。
 *
 * 约束：
 * - 只产出 ABI §7 已定义的事件名；原生名只出现在本文件内部；
 * - 无法映射 → **丢弃 + 计数 + 节流 `session.warning{code:"adapter.event-dropped"}`**；
 * - 终态之后不再发该轮事件（EV-4）；`turn.*` 终态恰一个；
 * - payload 必须满足 `impl/schema/event.json` 的 `payload_*` 必填字段。
 */
import { createHash } from "node:crypto";
import type { AdapterEvent } from "../../abi/adapter.ts";
import { adapterError, mapTurnError, toErrorRef } from "./errors.ts";

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

/** `TurnStatus` → ABI 终态种类。 */
function terminalKind(status: string | undefined): "completed" | "failed" | "aborted" | "other" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "aborted";
  return "other";
}

/** `TurnPlanStepStatus` → schema 的 `steps[].status` 枚举。 */
function planStatusOf(value: unknown): "pending" | "in-progress" | "completed" | "failed" | "skipped" {
  if (value === "completed") return "completed";
  if (value === "inProgress") return "in-progress";
  if (value === "failed") return "failed";
  if (value === "skipped") return "skipped";
  return "pending";
}

/** `PatchChangeKind`（`{type:add|delete|update,move_path?}`）→ schema 的文件状态。 */
function diffStatusOf(kind: unknown): "added" | "modified" | "deleted" | "renamed" {
  const record = asRecord(kind);
  const type = record === undefined ? undefined : asString(record["type"]);
  if (type === "add") return "added";
  if (type === "delete") return "deleted";
  if (type === "update") return asString(record?.["move_path"]) === undefined ? "modified" : "renamed";
  return "modified";
}

/** 统一 diff 文本 → 文件列表（`turn/diff/updated` 只给文本，ABI 要求 `files[]`）。 */
export function parseUnifiedDiff(diff: string): readonly { path: string; status: "added" | "modified" | "deleted" | "renamed" }[] {
  const files: { path: string; status: "added" | "modified" | "deleted" | "renamed" }[] = [];
  const lines = diff.split("\n");
  let pending: { path: string; status: "added" | "modified" | "deleted" | "renamed" } | undefined;
  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header !== null) {
      if (pending !== undefined) files.push(pending);
      pending = { path: header[2] ?? header[1] ?? "", status: "modified" };
      continue;
    }
    if (pending === undefined) continue;
    if (line.startsWith("new file mode")) pending.status = "added";
    else if (line.startsWith("deleted file mode")) pending.status = "deleted";
    else if (line.startsWith("rename from")) pending.status = "renamed";
  }
  if (pending !== undefined) files.push(pending);
  return files;
}

interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
}

interface TurnState {
  readonly turnId: string;
  terminal: boolean;
  started: boolean;
  summaryBuffers: Map<string, string>;
  diffEmitted: Set<string>;
  usage: UsageSnapshot;
  sawUsage: boolean;
}

export interface CodexEventMapperOptions {
  /** 后端 turn id → ABI turn id（由适配器持有映射，保证 `send()` 与事件一致）。 */
  readonly resolveTurnId: (remoteTurnId: string) => string;
  readonly model?: string | null;
  /** 丢弃告警节流窗口（默认 5s；ABI §11 折叠精神）。 */
  readonly warningWindowMs?: number;
  readonly now?: () => number;
}

/**
 * 有状态映射器：一个适配器实例一个（多会话场景下按 threadId 过滤由适配器完成）。
 */
export class CodexEventMapper {
  readonly #resolveTurnId: (remoteTurnId: string) => string;
  readonly #warningWindowMs: number;
  readonly #now: () => number;
  readonly #turns = new Map<string, TurnState>();
  readonly #dropped = new Map<string, number>();
  #model: string | undefined;
  #lastWarningAt = Number.NEGATIVE_INFINITY;
  #warnings = 0;
  #droppedTotal = 0;
  #terminalTurns = new Set<string>();

  constructor(options: CodexEventMapperOptions) {
    this.#resolveTurnId = options.resolveTurnId;
    this.#warningWindowMs = options.warningWindowMs ?? 5_000;
    this.#now = options.now ?? (() => Date.now());
    this.#model = options.model ?? undefined;
  }

  setModel(model: string | null | undefined): void {
    if (model !== null && model !== undefined && model.length > 0) this.#model = model;
  }

  droppedCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.#dropped);
  }

  get droppedTotal(): number {
    return this.#droppedTotal;
  }

  get warningCount(): number {
    return this.#warnings;
  }

  /** 处理一条通知，返回 0..n 个 ABI 事件。 */
  handleNotification(frame: { readonly method?: string; readonly params?: unknown }): AdapterEvent[] {
    const method = frame.method ?? "";
    const params = asRecord(frame.params) ?? {};
    try {
      return this.#dispatch(method, params);
    } catch (cause) {
      const error = adapterError("internal.unexpected", {
        message: `event mapping failed for ${method}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return [this.#warning("adapter.event-mapping-failed", error.message)];
    }
  }

  /** 适配器把传输层错误注入事件流时用（`diagnostic.log`）。 */
  diagnostic(level: "debug" | "info" | "warn" | "error", message: string): AdapterEvent {
    return { type: "diagnostic.log", payload: { level, message: message.slice(0, 1000), component: "adapter.codex" } };
  }

  #dispatch(method: string, params: Record<string, unknown>): AdapterEvent[] {
    switch (method) {
      case "turn/started":
        return this.#onTurnStarted(params);
      case "item/started":
        return this.#onItemStarted(params);
      case "item/agentMessage/delta":
        return this.#onAgentMessageDelta(params);
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return this.#onReasoningDelta(method, params);
      case "item/reasoning/summaryPartAdded":
        return this.#onReasoningPart(params);
      case "item/commandExecution/outputDelta":
      case "item/commandExecution/terminalInteraction":
      case "item/mcpToolCall/progress":
      case "item/fileChange/outputDelta":
        return this.#onToolProgress(method, params);
      case "item/fileChange/patchUpdated":
        return this.#onPatchUpdated(params);
      case "turn/diff/updated":
        return this.#onTurnDiffUpdated(params);
      case "turn/plan/updated":
        return this.#onPlanUpdated(params);
      case "item/plan/delta":
        return this.#drop(method, 1);
      case "thread/tokenUsage/updated":
        return this.#onTokenUsage(params);
      case "item/completed":
        return this.#onItemCompleted(params);
      case "turn/completed":
        return this.#onTurnCompleted(params);
      case "error":
        return this.#onErrorNotification(params);
      case "model/rerouted":
        return [this.#warning("model-rerouted", `model rerouted ${String(params["fromModel"] ?? "?")} → ${String(params["toModel"] ?? "?")}`)];
      case "thread/status/changed":
      case "remoteControl/status/changed":
      case "thread/queue/changed":
      case "account/rateLimits/updated":
      case "account/gatewayOAuth/changed":
      case "thread/attachment/updated":
      case "thread/prediction/updated":
      case "thread/readState/changed":
        return this.#drop(method, 1);
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
      case "turn/moderationMetadata":
        return this.#drop(method, 1);
      default:
        // `thread/realtime/*`、`fs/changed`、`hook/*`、`collabAgentToolCall`/`subAgentActivity`
        // 等：C4 不映射（子代理事件留给后续切片），统一计数 + 节流告警。
        return this.#drop(method, 1);
    }
  }

  /* ------------------------------------------------------------------ 轮次 */

  #onTurnStarted(params: Record<string, unknown>): AdapterEvent[] {
    const turn = asRecord(params["turn"]);
    const remoteTurnId = asString(turn?.["id"]);
    if (remoteTurnId === undefined) return this.#drop("turn/started:missing-id", 1);
    const state = this.#turnState(remoteTurnId);
    if (state.started || state.terminal) return [];
    state.started = true;
    const model = this.#model ?? asString(asRecord(turn)?.model) ?? "unspecified";
    return [{ type: "turn.started", turnId: state.turnId, payload: { model: model.slice(0, 128), delivery: "caller" } }];
  }

  #onTurnCompleted(params: Record<string, unknown>): AdapterEvent[] {
    const turn = asRecord(params["turn"]);
    const remoteTurnId = asString(turn?.["id"]);
    if (remoteTurnId === undefined) return this.#drop("turn/completed:missing-id", 1);
    const state = this.#turnState(remoteTurnId);
    if (state.terminal) return this.#drop("turn/completed:late", 1, { warn: false });
    state.terminal = true;
    this.#terminalTurns.add(state.turnId);
    const kind = terminalKind(asString(turn?.["status"]));
    const usage = this.#usageRef(state);
    if (kind === "completed") {
      return [
        {
          type: "turn.completed",
          turnId: state.turnId,
          payload: { stopReason: "end-turn", usage },
        },
      ];
    }
    if (kind === "aborted") {
      return [
        {
          type: "turn.aborted",
          turnId: state.turnId,
          payload: { interruptMethod: "native", partial: true },
        },
      ];
    }
    const errorRecord = asRecord(turn?.["error"]);
    const message = asString(errorRecord?.["message"]) ?? "turn failed without error message";
    const error = mapTurnError(errorRecord?.["codexErrorInfo"], message);
    return [
      {
        type: "turn.failed",
        turnId: state.turnId,
        payload: { error: toErrorRef(error), partial: true },
      },
    ];
  }

  #onErrorNotification(params: Record<string, unknown>): AdapterEvent[] {
    const message = asString(params["message"]) ?? "app-server error notification";
    const codexErrorInfo = params["codexErrorInfo"];
    const error = mapTurnError(codexErrorInfo, message);
    const active = this.#activeTurn();
    if (active !== undefined && !active.terminal) {
      active.terminal = true;
      this.#terminalTurns.add(active.turnId);
      return [
        {
          type: "turn.failed",
          turnId: active.turnId,
          payload: { error: toErrorRef(error), partial: true },
        },
      ];
    }
    return [this.#warning("backend-error", `${error.code}: ${message.slice(0, 200)}`)];
  }

  /* ------------------------------------------------------------------ 消息 */

  #onAgentMessageDelta(params: Record<string, unknown>): AdapterEvent[] {
    const itemId = asString(params["itemId"]);
    const delta = asString(params["delta"]);
    if (itemId === undefined || delta === undefined) return this.#drop("item/agentMessage/delta:invalid", 1);
    const turnId = this.#turnIdOf(params);
    if (turnId === undefined) return this.#drop("item/agentMessage/delta:no-turn", 1);
    const state = this.#turnStateById(turnId);
    if (state?.terminal === true) return this.#drop("item/agentMessage/delta:late", 1, { warn: false });
    return [
      {
        type: "message.delta",
        turnId,
        payload: { channel: "assistant", text: delta, granularity: "token", messageId: itemId.slice(0, 128) },
      },
    ];
  }

  #onReasoningDelta(method: string, params: Record<string, unknown>): AdapterEvent[] {
    const delta = asString(params["delta"]);
    const itemId = asString(params["itemId"]);
    if (delta === undefined || itemId === undefined) return this.#drop(`${method}:invalid`, 1);
    const turnId = this.#turnIdOf(params);
    if (turnId === undefined) return this.#drop(`${method}:no-turn`, 1);
    const state = this.#turnStateById(turnId);
    if (state?.terminal === true) return this.#drop(`${method}:late`, 1, { warn: false });
    if (method.endsWith("summaryTextDelta") && state !== undefined) {
      state.summaryBuffers.set(itemId, (state.summaryBuffers.get(itemId) ?? "") + delta);
    }
    return [
      {
        type: "reasoning.delta",
        turnId,
        payload: { text: delta, granularity: "token", messageId: itemId.slice(0, 128) },
      },
    ];
  }

  #onReasoningPart(params: Record<string, unknown>): AdapterEvent[] {
    const itemId = asString(params["itemId"]);
    if (itemId === undefined) return this.#drop("item/reasoning/summaryPartAdded:invalid", 1);
    const turnId = this.#turnIdOf(params);
    if (turnId === undefined) return this.#drop("item/reasoning/summaryPartAdded:no-turn", 1);
    const state = this.#turnStateById(turnId);
    const text = (state?.summaryBuffers.get(itemId) ?? "").slice(0, MAX_TEXT);
    if (text.length === 0) return this.#drop("item/reasoning/summaryPartAdded:empty", 1);
    return [{ type: "reasoning.summary", turnId, payload: { text } }];
  }

  #onItemStarted(params: Record<string, unknown>): AdapterEvent[] {
    const item = asRecord(params["item"]);
    if (item === undefined) return this.#drop("item/started:invalid", 1);
    const type = asString(item["type"]);
    const itemId = asString(item["id"]);
    if (type === undefined || itemId === undefined) return this.#drop("item/started:invalid", 1);
    const turnId = this.#turnIdOf(params);
    if (turnId === undefined) return this.#drop("item/started:no-turn", 1);
    const state = this.#turnStateById(turnId);
    if (state?.terminal === true) return this.#drop("item/started:late", 1, { warn: false });
    if (type === "agentMessage") {
      return [{ type: "message.started", turnId, payload: { channel: "assistant", messageId: itemId.slice(0, 128) } }];
    }
    const toolKind = toolKindOf(type);
    if (toolKind === undefined) return this.#drop(`item/started:${type}`, 1);
    return [
      {
        type: "tool.started",
        turnId,
        payload: { toolCallId: itemId.slice(0, 128), name: type.slice(0, 128), kind: toolKind },
      },
    ];
  }

  #onItemCompleted(params: Record<string, unknown>): AdapterEvent[] {
    const item = asRecord(params["item"]);
    if (item === undefined) return this.#drop("item/completed:invalid", 1);
    const type = asString(item["type"]);
    const itemId = asString(item["id"]);
    if (type === undefined || itemId === undefined) return this.#drop("item/completed:invalid", 1);
    const turnId = this.#turnIdOf(params);
    if (turnId === undefined) return this.#drop("item/completed:no-turn", 1);
    const state = this.#turnStateById(turnId);
    if (state?.terminal === true) return this.#drop("item/completed:late", 1, { warn: false });
    const events: AdapterEvent[] = [];

    if (type === "agentMessage") {
      const text = asString(item["text"]) ?? "";
      return [
        {
          type: "message.completed",
          turnId,
          payload: { channel: "assistant", text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text, messageId: itemId.slice(0, 128), ...(text.length > MAX_TEXT ? { truncated: true } : {}) },
        },
      ];
    }
    if (type === "reasoning") {
      const summary = reasoningSummaryOf(item);
      if (summary.length === 0) return this.#drop("item/completed:reasoning-empty", 1);
      return [{ type: "reasoning.summary", turnId, payload: { text: summary.slice(0, MAX_TEXT) } }];
    }
    if (type === "fileChange") {
      events.push(...this.#diffFromChanges(turnId, itemId, item, state));
      events.push(this.#toolCompleted(turnId, itemId, type, fileChangeStatus(item), ""));
      return events;
    }
    if (type === "commandExecution") {
      const output = asString(item["aggregatedOutput"]) ?? "";
      const exitCode = asNumber(item["exitCode"]);
      const status = commandStatus(item, exitCode);
      return [this.#toolCompleted(turnId, itemId, type, status, output)];
    }
    if (type === "mcpToolCall" || type === "dynamicToolCall") {
      const status = toolCallStatus(item);
      const payloadText = JSON.stringify(item["result"] ?? item["error"] ?? "");
      return [this.#toolCompleted(turnId, itemId, type, status, payloadText)];
    }
    if (type === "webSearch") {
      return [this.#toolCompleted(turnId, itemId, type, "ok", JSON.stringify(item["results"] ?? ""))];
    }
    // userMessage / plan / hookPrompt / collabAgentToolCall / subAgentActivity / sleep / imageView …
    return this.#drop(`item/completed:${type}`, 1);
  }

  #onToolProgress(method: string, params: Record<string, unknown>): AdapterEvent[] {
    const itemId = asString(params["itemId"]);
    if (itemId === undefined) return this.#drop(`${method}:invalid`, 1);
    const turnId = this.#turnIdOf(params);
    if (turnId === undefined) return this.#drop(`${method}:no-turn`, 1);
    const state = this.#turnStateById(turnId);
    if (state?.terminal === true) return this.#drop(`${method}:late`, 1, { warn: false });
    const text =
      method === "item/commandExecution/terminalInteraction"
        ? (asString(params["stdin"]) ?? "")
        : (asString(params["delta"]) ?? asString(params["message"]) ?? "");
    if (text.length === 0) return this.#drop(`${method}:empty`, 1);
    return [
      {
        type: "tool.progress",
        turnId,
        payload: { toolCallId: itemId.slice(0, 128), text: text.slice(0, 2000) },
      },
    ];
  }

  #onPatchUpdated(params: Record<string, unknown>): AdapterEvent[] {
    const itemId = asString(params["itemId"]);
    const turnId = this.#turnIdOf(params);
    if (itemId === undefined || turnId === undefined) return this.#drop("item/fileChange/patchUpdated:invalid", 1);
    const state = this.#turnStateById(turnId);
    if (state?.terminal === true) return this.#drop("item/fileChange/patchUpdated:late", 1, { warn: false });
    const changes = asArray(params["changes"]);
    const files = changes
      .map((change) => asRecord(change))
      .filter((change): change is Record<string, unknown> => change !== undefined)
      .map((change) => ({ path: String(change["path"] ?? "").slice(0, 512), status: diffStatusOf(change["kind"]) }))
      .filter((file) => file.path.length > 0);
    if (files.length === 0) return this.#drop("item/fileChange/patchUpdated:empty", 1);
    state?.diffEmitted.add(itemId);
    return [{ type: "diff.updated", turnId, payload: { files } }];
  }

  #onTurnDiffUpdated(params: Record<string, unknown>): AdapterEvent[] {
    const turnId = this.#turnIdOf(params);
    const diff = asString(params["diff"]);
    if (turnId === undefined || diff === undefined) return this.#drop("turn/diff/updated:invalid", 1);
    const state = this.#turnStateById(turnId);
    if (state?.terminal === true) return this.#drop("turn/diff/updated:late", 1, { warn: false });
    const files = parseUnifiedDiff(diff);
    if (files.length === 0) return this.#drop("turn/diff/updated:no-files", 1);
    const fingerprint = `turn:${files.map((f) => `${f.status}:${f.path}`).join("|")}`;
    if (state?.diffEmitted.has(fingerprint) === true) return this.#drop("turn/diff/updated:duplicate", 1, { warn: false });
    state?.diffEmitted.add(fingerprint);
    return [{ type: "diff.updated", turnId, payload: { files, patchDigest: digestOf(diff) } }];
  }

  #onPlanUpdated(params: Record<string, unknown>): AdapterEvent[] {
    const turnId = this.#turnIdOf(params);
    if (turnId === undefined) return this.#drop("turn/plan/updated:no-turn", 1);
    const state = this.#turnStateById(turnId);
    if (state?.terminal === true) return this.#drop("turn/plan/updated:late", 1, { warn: false });
    const steps = asArray(params["plan"])
      .map((step) => asRecord(step))
      .filter((step): step is Record<string, unknown> => step !== undefined)
      .map((step, index) => ({
        id: `p${index + 1}`,
        title: String(step["step"] ?? "").slice(0, 200),
        status: planStatusOf(step["status"]),
      }))
      .filter((step) => step.title.length > 0);
    if (steps.length === 0) return this.#drop("turn/plan/updated:empty", 1);
    return [{ type: "plan.updated", turnId, payload: { steps } }];
  }

  #onTokenUsage(params: Record<string, unknown>): AdapterEvent[] {
    const turnId = this.#turnIdOf(params);
    if (turnId === undefined) return this.#drop("thread/tokenUsage/updated:no-turn", 1);
    const usage = asRecord(params["tokenUsage"]);
    if (usage === undefined) return this.#drop("thread/tokenUsage/updated:invalid", 1);
    const last = asRecord(usage["last"]);
    const total = asRecord(usage["total"]);
    const state = this.#turnStateById(turnId);
    const events: AdapterEvent[] = [];
    if (last !== undefined) {
      const snapshot: UsageSnapshot = {
        inputTokens: asNumber(last["inputTokens"]),
        outputTokens: asNumber(last["outputTokens"]),
        reasoningTokens: asNumber(last["reasoningOutputTokens"]),
      };
      if (state !== undefined) {
        state.usage = { ...state.usage, ...stripUndefined(snapshot) };
        state.sawUsage = true;
      }
      events.push({
        type: "usage.updated",
        turnId,
        payload: { usage: { ...stripUndefined(snapshot), estimated: false, scope: "turn" } },
      });
    }
    if (total !== undefined) {
      const snapshot: UsageSnapshot = {
        inputTokens: asNumber(total["inputTokens"]),
        outputTokens: asNumber(total["outputTokens"]),
        reasoningTokens: asNumber(total["reasoningOutputTokens"]),
      };
      events.push({
        type: "usage.updated",
        turnId,
        payload: { usage: { ...stripUndefined(snapshot), estimated: false, scope: "session" } },
      });
    }
    return events.length === 0 ? this.#drop("thread/tokenUsage/updated:empty", 1) : events;
  }

  /* ------------------------------------------------------------------ 工具的事件构造 */

  #toolCompleted(
    turnId: string,
    itemId: string,
    type: string,
    status: "ok" | "error" | "denied",
    output: string,
  ): AdapterEvent {
    return {
      type: "tool.completed",
      turnId,
      payload: {
        toolCallId: itemId.slice(0, 128),
        status,
        outputDigest: digestOf(output),
        ...(output.length > 64 * 1024 ? { truncated: true } : {}),
      },
    };
  }

  #diffFromChanges(
    turnId: string,
    itemId: string,
    item: Record<string, unknown>,
    state: TurnState | undefined,
  ): AdapterEvent[] {
    if (state?.diffEmitted.has(itemId) === true) return [];
    const changes = asArray(item["changes"]);
    const files = changes
      .map((change) => asRecord(change))
      .filter((change): change is Record<string, unknown> => change !== undefined)
      .map((change) => ({ path: String(change["path"] ?? "").slice(0, 512), status: diffStatusOf(change["kind"]) }))
      .filter((file) => file.path.length > 0);
    if (files.length === 0) return [];
    state?.diffEmitted.add(itemId);
    return [{ type: "diff.updated", turnId, payload: { files } }];
  }

  /* ------------------------------------------------------------------ 内部 */

  #turnState(remoteTurnId: string): TurnState {
    const turnId = this.#resolveTurnId(remoteTurnId);
    let state = this.#turns.get(turnId);
    if (state === undefined) {
      state = {
        turnId,
        terminal: false,
        started: false,
        summaryBuffers: new Map(),
        diffEmitted: new Set(),
        usage: {},
        sawUsage: false,
      };
      this.#turns.set(turnId, state);
    }
    return state;
  }

  #turnStateById(turnId: string): TurnState | undefined {
    return this.#turns.get(turnId);
  }

  #turnIdOf(params: Record<string, unknown>): string | undefined {
    const remote = asString(params["turnId"]);
    if (remote === undefined) return undefined;
    return this.#resolveTurnId(remote);
  }

  #activeTurn(): TurnState | undefined {
    let latest: TurnState | undefined;
    for (const state of this.#turns.values()) {
      if (!state.terminal) latest = state;
    }
    return latest;
  }

  #usageRef(state: TurnState): {
    estimated: boolean;
    scope: "turn" | "session";
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
  } {
    return {
      ...stripUndefined(state.usage),
      estimated: !state.sawUsage,
      scope: "turn",
    };
  }

  #warning(code: string, message: string): AdapterEvent {
    return {
      type: "session.warning",
      payload: { code: code.slice(0, 64), message: message.slice(0, 400), degrade: true },
    };
  }

  /**
   * 丢弃并计数。
   * @param warn `false` 表示"协议竞态"类丢弃（终态后迟到、重复 diff 指纹），只计数不告警，
   *             避免把正常竞态变成用户可见噪声（设计 §5.5）。
   */
  #drop(method: string, count: number, options: { warn?: boolean } = {}): AdapterEvent[] {
    this.#dropped.set(method, (this.#dropped.get(method) ?? 0) + count);
    this.#droppedTotal += count;
    if (options.warn === false) return [];
    const now = this.#now();
    if (now - this.#lastWarningAt < this.#warningWindowMs) return [];
    this.#lastWarningAt = now;
    this.#warnings += 1;
    const top = [...this.#dropped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const detail = top.map(([name, hits]) => `${name}×${hits}`).join(", ");
    return [this.#warning("adapter.event-dropped", `dropped ${this.#droppedTotal} unmapped notifications (${detail})`)];
  }
}

/** 去掉 undefined（`usageRef` 不接受 null/undefined 字段；`additionalProperties:false`）。 */
function stripUndefined(value: UsageSnapshot): UsageSnapshot {
  const out: UsageSnapshot = {};
  if (value.inputTokens !== undefined) out.inputTokens = value.inputTokens;
  if (value.outputTokens !== undefined) out.outputTokens = value.outputTokens;
  if (value.reasoningTokens !== undefined) out.reasoningTokens = value.reasoningTokens;
  if (value.durationMs !== undefined) out.durationMs = value.durationMs;
  return out;
}

function toolKindOf(type: string): "execute" | "write" | "read" | "mcp" | "web" | undefined {
  switch (type) {
    case "commandExecution":
      return "execute";
    case "fileChange":
      return "write";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "mcp";
    case "webSearch":
      return "web";
    default:
      return undefined;
  }
}

function commandStatus(item: Record<string, unknown>, exitCode: number | undefined): "ok" | "error" | "denied" {
  const status = asString(item["status"]);
  if (status === "declined") return "denied";
  if (status === "failed") return "error";
  if (exitCode !== undefined && exitCode !== 0) return "error";
  return "ok";
}

function fileChangeStatus(item: Record<string, unknown>): "ok" | "error" | "denied" {
  const status = asString(item["status"]);
  if (status === "declined") return "denied";
  if (status === "failed") return "error";
  return "ok";
}

function toolCallStatus(item: Record<string, unknown>): "ok" | "error" | "denied" {
  const status = asString(item["status"]);
  if (status === "failed") return "error";
  return "ok";
}

function reasoningSummaryOf(item: Record<string, unknown>): string {
  const summary = asArray(item["summary"]);
  if (summary.length > 0) {
    return summary
      .map((part) => asRecord(part))
      .filter((part): part is Record<string, unknown> => part !== undefined)
      .map((part) => asString(part["text"]) ?? "")
      .join("\n");
  }
  const content = asArray(item["content"]);
  return content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .map((part) => asString(part["text"]) ?? "")
    .join("\n");
}


/**
 * ABI v0 事件类型（真源：docs/abi/abi-v0.md §7，35 个；与 schema/event.json 的 oneOf 变体一致）。
 *
 * 事件名是契约：只增不改；施工期不得透传后端原生事件名（如 `item/agentMessage/delta`）。
 */
export const EVENT_TYPES = [
  // §7.1 生命周期
  "session.created",
  "session.state-changed",
  "session.recovered",
  "session.lost",
  "session.closed",
  "session.archived",
  "session.warning",
  // §7.2 轮次
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.aborted",
  "turn.steered",
  "turn.queued",
  // §7.3 消息与推理
  "message.started",
  "message.delta",
  "message.completed",
  "reasoning.delta",
  "reasoning.summary",
  // §7.4 工具
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  // §7.5 计划 / 改动 / 用量
  "plan.updated",
  "diff.updated",
  "usage.updated",
  // §7.6 权限与输入
  "permission.requested",
  "permission.resolved",
  "input.requested",
  "input.resolved",
  // §7.7 子会话
  "child.spawned",
  "child.state-changed",
  "child.completed",
  // §7.8 传输与诊断
  "transport.state-changed",
  "diagnostic.log",
  "progress.folded",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_SET: ReadonlySet<EventType> = new Set(EVENT_TYPES);

export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value as EventType);
}

/** 事件家族（按 §7 小节），用于订阅过滤与指标分组。 */
export const EVENT_FAMILIES = {
  lifecycle: [
    "session.created",
    "session.state-changed",
    "session.recovered",
    "session.lost",
    "session.closed",
    "session.archived",
    "session.warning",
  ],
  turn: [
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.aborted",
    "turn.steered",
    "turn.queued",
  ],
  message: [
    "message.started",
    "message.delta",
    "message.completed",
    "reasoning.delta",
    "reasoning.summary",
  ],
  tool: ["tool.started", "tool.progress", "tool.completed", "tool.failed"],
  artifact: ["plan.updated", "diff.updated", "usage.updated"],
  interaction: [
    "permission.requested",
    "permission.resolved",
    "input.requested",
    "input.resolved",
  ],
  child: ["child.spawned", "child.state-changed", "child.completed"],
  transport: ["transport.state-changed", "diagnostic.log", "progress.folded"],
} as const satisfies Readonly<Record<string, readonly EventType[]>>;

/** 终态事件：不受父会话折叠上限约束（ABI §11.1）。 */
export const TERMINAL_EVENT_TYPES: readonly EventType[] = [
  "turn.completed",
  "turn.failed",
  "turn.aborted",
  "session.closed",
  "session.archived",
];

export function isTerminalEvent(type: EventType): boolean {
  return TERMINAL_EVENT_TYPES.includes(type);
}

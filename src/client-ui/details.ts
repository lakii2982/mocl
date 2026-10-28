/**
 * 展开详情的两层视图模型（W5 F2/F3）—— 设计真源：design-v11/DESIGN-v1.1.md §3/§4。
 *
 * - 纯函数、0 DOM：panel.tsx 只做通用渲染；tests/client-ui/details.test.ts 直接断言
 *   「默认展开区不含 cwd/depth/epoch/turnId 字样」「技术区恰为 5 个字段」「复制目标正确」。
 * - 顺序固定（§3.1）：任务 → 状态与时间 → 用量 → 实际运行体 → 模型 → 错误 →（其后）技术详情。
 * - 默认展开区禁止出现 cwd/depth/epoch/turnId 的字样与值；它们只存在于
 *   technicalDetailGroups 的输出（渲染层把后者放进默认收起的「技术详情」折叠区）。
 */
import {
  TEXT,
  durationText,
  formatEventTime,
  lastActivityText,
  modelParts,
  nativeSessionId,
  nativeShortId,
  shown,
  statusExplanation,
  statusFor,
  usageView,
  type PanelAgent,
} from "./status.ts";

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface DetailField {
  /** 键（dt，即标签）。 */
  readonly key: string;
  /** 展示值（dd）。缺失类信息由调用方先落「未知」。 */
  readonly value: string;
  /** 等宽字体（id / 模型 / code）。 */
  readonly code?: boolean;
  /** 复制按钮目标（完整原值）；缺失 → 不渲染复制按钮。 */
  readonly copyValue?: string;
  /** 模型来源后缀（实际/配置值/降级）；仅模型组使用。 */
  readonly suffixText?: string;
  readonly suffixSource?: string;
}

export interface DetailGroup {
  readonly title: string;
  readonly kind: "task" | "list" | "usage" | "error";
  /** kind=task：任务全文。 */
  readonly taskText?: string;
  readonly taskCopyValue?: string;
  readonly fields?: readonly DetailField[];
  /** kind=usage：estimated 时的「估算值，不用于计费对账」。 */
  readonly note?: string;
}

export interface TechnicalGroup {
  /** 一句话用途：只回答「排障时给谁看、有什么用」，不解释内部架构。 */
  readonly help: string;
  readonly fields: readonly DetailField[];
}

/**
 * 默认展开（人话区）。技术字段（childId/cwd/depth/epoch/turnId）一律不出现在这里。
 */
export function defaultDetailGroups(agent: PanelAgent | null | undefined, nowMs: number): readonly DetailGroup[] {
  const groups: DetailGroup[] = [];

  // 1. 任务：全文、不截断、可复制。
  const label = strOf(agent?.label);
  groups.push({
    title: TEXT.taskGroup,
    kind: "task",
    taskText: shown(label),
    ...(label !== null ? { taskCopyValue: label } : {}),
  });

  // 2. 状态与时间：状态说明 / 开始时间 / 最后活动 / 本轮耗时（缺失为未知，queued 耗时为未开始）。
  groups.push({
    title: TEXT.statusTimeGroup,
    kind: "list",
    fields: [
      { key: TEXT.statusExplanationLabel, value: statusExplanation(statusFor(agent)) },
      { key: TEXT.startedAtLabel, value: shown(formatEventTime(agent?.startedAt)) },
      { key: TEXT.lastActivityLabel, value: shown(lastActivityText(agent, nowMs)) },
      { key: TEXT.durationLabel, value: shown(durationText(agent, nowMs)) },
    ],
  });

  // 3. 用量：precision=none 或无 usage → 整组不渲染。
  const usage = usageView(agent, nowMs);
  if (usage !== null) {
    groups.push({
      title: TEXT.usageGroup,
      kind: "usage",
      fields: [
        { key: TEXT.inputTokensLabel, value: usage.inputTokens },
        { key: TEXT.outputTokensLabel, value: usage.outputTokens },
        { key: TEXT.costLabel, value: usage.costUsd },
        { key: TEXT.usageDurationLabel, value: usage.duration },
      ],
      ...(usage.estimated ? { note: TEXT.estimatedNote } : {}),
    });
  }

  // 4. 实际运行体：后端 / 通道 / 原生会话 id（短写展示、完整值复制）/ 后端版本；缺失为未知。
  const nativeFull = nativeSessionId(agent);
  const nativeShort = nativeShortId(agent);
  groups.push({
    title: TEXT.runtimeGroup,
    kind: "list",
    fields: [
      { key: TEXT.backendLabel, value: shown(agent?.backend) },
      { key: TEXT.transportLabel, value: shown(agent?.runtime?.transport) },
      {
        key: TEXT.nativeSessionIdLabel,
        value: shown(nativeShort === "" ? null : nativeShort),
        code: true,
        ...(nativeFull !== null ? { copyValue: nativeFull } : {}),
      },
      { key: TEXT.backendVersionLabel, value: shown(agent?.runtime?.backendVersion) },
    ],
  });

  // 5. 模型：实际生效模型 + 来源后缀（实际/配置值/降级；unknown → 未知且无后缀）。
  const model = modelParts(agent);
  groups.push({
    title: TEXT.modelGroup,
    kind: "list",
    fields: [
      {
        key: TEXT.modelKeyLabel,
        value: model.name,
        code: true,
        ...(model.note === "" ? {} : { suffixText: model.note, suffixSource: model.source }),
      },
    ],
  });

  // 6. 错误：仅有错误时渲染；retryable 展示 ABI 原值；traceId 可复制。
  const error = agent?.error;
  if (error !== null && error !== undefined) {
    const traceId = strOf(error.traceId);
    groups.push({
      title: TEXT.errorDetailsLabel,
      kind: "error",
      fields: [
        { key: "code", value: shown(error.code), code: true },
        { key: "userMessage", value: shown(error.userMessage) },
        { key: "retryable", value: shown(error.retryable) },
        {
          key: "traceId",
          value: shown(traceId),
          code: true,
          ...(traceId !== null ? { copyValue: traceId } : {}),
        },
      ],
    });
  }

  return groups;
}

/**
 * 第二层「技术详情」（§3.3）：默认收起；字段与顺序固定为
 * childId、turnId（均可复制）→ cwd、depth → epoch，各配一句排障用途说明。
 */
export function technicalDetailGroups(agent: PanelAgent | null | undefined): readonly TechnicalGroup[] {
  const childId = strOf(agent?.childId);
  const turnId = strOf(agent?.lastTurnId);
  return [
    {
      help: TEXT.technicalLocateHelp,
      fields: [
        { key: "childId", value: shown(childId), code: true, ...(childId !== null ? { copyValue: childId } : {}) },
        { key: "turnId", value: shown(turnId), code: true, ...(turnId !== null ? { copyValue: turnId } : {}) },
      ],
    },
    {
      help: TEXT.technicalContextHelp,
      fields: [
        { key: "cwd", value: shown(agent?.cwd), code: true },
        { key: "depth", value: shown(agent?.depth) },
      ],
    },
    {
      help: TEXT.technicalRecoveryHelp,
      fields: [{ key: "epoch", value: shown(agent?.epoch) }],
    },
  ];
}

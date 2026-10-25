/**
 * 父级投递策略（D-009 / ABI §11）：默认只投终态 1 条；可选摘要受硬上限约束。
 *
 * 硬上限（ABI §11.2，**不可被配置突破**）：
 * - 每轮摘要条目 ≤ 8；
 * - 每轮摘要字符 ≤ 1200；
 * - 单条摘要字符 ≤ 400。
 * 配置试图超过任一上限 → **构造期直接拒绝**（fail-closed，不静默裁剪）。
 */
import type { MoclEvent } from "../abi/types.ts";
import { isTerminalEvent } from "../abi/events.ts";
import type { FoldState } from "./fold.ts";

export const PARENT_HARD_LIMITS = Object.freeze({
  maxItems: 8,
  maxCharsPerTurn: 1200,
  maxCharsPerItem: 400,
} as const);

export type ParentProgressMode = "off" | "summary";

export interface ParentProgressConfig {
  /** `off`（默认，D-009）：只投终态；`summary`：终态 + 折叠摘要。 */
  readonly mode?: ParentProgressMode;
  readonly maxItemsPerTurn?: number;
  readonly maxCharsPerTurn?: number;
  readonly maxCharsPerItem?: number;
}

export interface ResolvedParentProgressConfig {
  readonly mode: ParentProgressMode;
  readonly maxItemsPerTurn: number;
  readonly maxCharsPerTurn: number;
  readonly maxCharsPerItem: number;
}

export type ParentDelivery =
  | {
      readonly sessionId: string;
      readonly kind: "terminal";
      readonly seq: number;
      readonly type: MoclEvent["type"];
      readonly event: MoclEvent;
      readonly at: string;
    }
  | {
      readonly sessionId: string;
      readonly kind: "summary";
      readonly seq: number;
      readonly at: string;
      readonly fold: FoldState;
    };

function assertPositiveInt(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** 解析并校验配置；超硬上限 → RangeError（启动期拒绝）。 */
export function resolveParentProgressConfig(config: ParentProgressConfig = {}): ResolvedParentProgressConfig {
  const mode = config.mode ?? "off";
  if (mode !== "off" && mode !== "summary") {
    throw new RangeError(`parentProgress.mode must be "off" | "summary"`);
  }
  const maxItemsPerTurn = assertPositiveInt("parentProgress.maxItemsPerTurn", config.maxItemsPerTurn ?? PARENT_HARD_LIMITS.maxItems);
  const maxCharsPerTurn = assertPositiveInt(
    "parentProgress.maxCharsPerTurn",
    config.maxCharsPerTurn ?? PARENT_HARD_LIMITS.maxCharsPerTurn,
  );
  const maxCharsPerItem = assertPositiveInt(
    "parentProgress.maxCharsPerItem",
    config.maxCharsPerItem ?? PARENT_HARD_LIMITS.maxCharsPerItem,
  );
  if (maxItemsPerTurn > PARENT_HARD_LIMITS.maxItems) {
    throw new RangeError(
      `parentProgress.maxItemsPerTurn=${maxItemsPerTurn} exceeds hard limit ${PARENT_HARD_LIMITS.maxItems}`,
    );
  }
  if (maxCharsPerTurn > PARENT_HARD_LIMITS.maxCharsPerTurn) {
    throw new RangeError(
      `parentProgress.maxCharsPerTurn=${maxCharsPerTurn} exceeds hard limit ${PARENT_HARD_LIMITS.maxCharsPerTurn}`,
    );
  }
  if (maxCharsPerItem > PARENT_HARD_LIMITS.maxCharsPerItem) {
    throw new RangeError(
      `parentProgress.maxCharsPerItem=${maxCharsPerItem} exceeds hard limit ${PARENT_HARD_LIMITS.maxCharsPerItem}`,
    );
  }
  return { mode, maxItemsPerTurn, maxCharsPerTurn, maxCharsPerItem };
}

/** 终态事件判定（复用 ABI 目录，避免第二套"终态"定义）。 */
export function isTerminalForParent(type: MoclEvent["type"]): boolean {
  return isTerminalEvent(type);
}

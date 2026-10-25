/**
 * opencode 模型分级与免费降级（D-019；docs/adapters/opencode.md §8.2）。
 *
 * 规则：
 * - 生产默认模型 = `opencode-go/deepseek-v4.1-flash`（用户口径，需要有效 opencode-go key）；
 * - 内置免费池 = `providerID === "opencode"` 且 id 含 `free`（默认可用，零费用）；
 * - 付费模型遇 401 `api_key_expired`（`auth.credential-expired`）→ **显式降级**到同系列免费模型
 *   `opencode/deepseek-v4.1-flash-free`，必须产生 warning 事件并标 `model=free-fallback`；
 * - **禁止静默降级**：`ModelPolicy` 的所有降级都返回 decision，调用方必须把 decision 投射成事件/结果。
 */
import { isApiKeyExpired, isAuthFailure } from "./errors.ts";
import type { ModelRef } from "./types.ts";

/** 生产默认模型（D-019）。 */
export const PRODUCTION_MODEL = "opencode-go/deepseek-v4.1-flash";
/** 免费降级模型（D-019；Lead 实测 rc=0 且 `-s` 续接成功）。 */
export const FREE_FALLBACK_MODEL = "opencode/deepseek-v4.1-flash-free";
/** 降级标记：写入 warning/结果，便于父级与测试断言（不得只在日志里）。 */
export const FREE_FALLBACK_MARKER = "model=free-fallback";

export type ModelTier = "free" | "paid" | "other";

/** `provider/model[#variant]` → ModelRef；无法解析时抛错（fail-closed，不猜）。 */
export function parseModelRef(model: string): ModelRef {
  const hashIndex = model.indexOf("#");
  const withoutVariant = hashIndex >= 0 ? model.slice(0, hashIndex) : model;
  const variant = hashIndex >= 0 ? model.slice(hashIndex + 1) : undefined;
  const slash = withoutVariant.indexOf("/");
  if (slash <= 0 || slash === withoutVariant.length - 1) {
    throw new Error(`invalid model ref (expected provider/model): ${model}`);
  }
  const providerID = withoutVariant.slice(0, slash);
  const id = withoutVariant.slice(slash + 1);
  return variant === undefined || variant.length === 0 ? { providerID, id } : { providerID, id, variant };
}

/** ModelRef → `provider/model[#variant]`。 */
export function formatModelRef(ref: ModelRef): string {
  const base = `${ref.providerID}/${ref.id}`;
  return ref.variant === undefined || ref.variant.length === 0 ? base : `${base}#${ref.variant}`;
}

/** 分级：`opencode/*-free` = 免费池；`opencode-go/*` = 付费池（名字带 -free 也仍是付费 provider）。 */
export function classifyModel(model: string): ModelTier {
  let ref: ModelRef;
  try {
    ref = parseModelRef(model);
  } catch {
    return "other";
  }
  if (ref.providerID === "opencode" && /free|pickle/i.test(ref.id)) return "free";
  if (ref.providerID === "opencode-go") return "paid";
  return "other";
}

/** 免费池模型列表（opencode models 实测 39 条 / 10 条含 free；这里是文档化的常用集合）。 */
export const FREE_MODELS: readonly string[] = [
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
  "opencode/big-pickle",
  "opencode/beam-free",
  "opencode/flint-40b-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/nemotron-3.5-super-vl-free",
];

export interface ModelFallbackWarning {
  readonly code: "model.free-fallback";
  readonly message: string;
  readonly degrade: true;
  readonly bits: readonly string[];
}

export interface ModelFallbackDecision {
  readonly previousModel: string;
  readonly model: string;
  readonly degraded: true;
  readonly marker: typeof FREE_FALLBACK_MARKER;
  readonly warning: ModelFallbackWarning;
}

export interface ModelPolicySnapshot {
  readonly model: string;
  readonly degraded: boolean;
  readonly marker: string | null;
  readonly warnings: readonly string[];
}

/**
 * 模型状态机：持有当前模型 + 是否已降级。
 *
 * 生命周期：
 * ```ts
 * const policy = new ModelPolicy(requestedModel ?? PRODUCTION_MODEL);
 * // 401 时：
 * const decision = policy.onCredentialExpired(policy.current);
 * if (decision !== null) { event = session.warning(decision.warning); model = decision.model; }
 * ```
 */
export class ModelPolicy {
  #model: string;
  #degraded = false;
  readonly #warnings: string[] = [];

  constructor(initialModel: string | null | undefined = PRODUCTION_MODEL) {
    this.#model = initialModel === null || initialModel === undefined ? PRODUCTION_MODEL : initialModel;
    if (this.#model.length === 0) this.#model = PRODUCTION_MODEL;
  }

  get current(): string {
    return this.#model;
  }

  get degraded(): boolean {
    return this.#degraded;
  }

  get warnings(): readonly string[] {
    return this.#warnings;
  }

  /** 调用方显式指定模型；同一请求内覆盖当前值（不清除既有 degraded 标记）。 */
  override(model: string | null | undefined): string {
    if (model !== null && model !== undefined && model.length > 0) this.#model = model;
    return this.#model;
  }

  /** 生产/付费模型？ */
  isPaidModel(model: string = this.#model): boolean {
    return classifyModel(model) === "paid";
  }

  /** 是否需要降级（付费池 → 免费池）；已在免费池/其他 provider → null。 */
  fallbackFor(model: string = this.#model): string | null {
    return classifyModel(model) === "paid" ? FREE_FALLBACK_MODEL : null;
  }

  /**
   * 凭据过期时的显式降级；返回 null 表示无需/不能降级（此时调用方按 `auth.credential-expired` 处理）。
   * 幂等：重复调用返回同一结果（不重复加 warning）。
   */
  onCredentialExpired(model: string = this.#model): ModelFallbackDecision | null {
    const next = this.fallbackFor(model);
    if (next === null) return null;
    const decision: ModelFallbackDecision = {
      previousModel: model,
      model: next,
      degraded: true,
      marker: FREE_FALLBACK_MARKER,
      warning: {
        code: "model.free-fallback",
        message: `production model ${model} rejected (api_key_expired); degraded to ${next} (${FREE_FALLBACK_MARKER})`,
        degrade: true,
        bits: ["modelRouting"],
      },
    };
    this.#model = next;
    this.#degraded = true;
    if (!this.#warnings.includes(FREE_FALLBACK_MARKER)) this.#warnings.push(FREE_FALLBACK_MARKER);
    return decision;
  }

  /** 手工标记降级（用于测试/预检已知 key 过期时直接选免费模型）。 */
  markDegraded(model: string = FREE_FALLBACK_MODEL): ModelPolicySnapshot {
    this.#model = model;
    this.#degraded = true;
    if (!this.#warnings.includes(FREE_FALLBACK_MARKER)) this.#warnings.push(FREE_FALLBACK_MARKER);
    return this.snapshot();
  }

  snapshot(): ModelPolicySnapshot {
    return {
      model: this.#model,
      degraded: this.#degraded,
      marker: this.#degraded ? FREE_FALLBACK_MARKER : null,
      warnings: [...this.#warnings],
    };
  }
}

/**
 * 是否“凭据过期（可降级）”：
 * - 送入 MoclError（`auth.credential-expired`）或原始 JSON/错误体（`api_key_expired` / provider.auth 401）；
 * - ACP `-32000 Authentication required` 归为凭据失败（可降级到免费模型后再试）—— 用 `isFallbackEligible`。
 */
export function isCredentialExpired(error: unknown): boolean {
  if (isMoclErrorLike(error)) {
    return error.code === "auth.credential-expired";
  }
  return isApiKeyExpired(error);
}

/** 任意“凭据类失败”（含 ACP -32000 / HTTP 401）→ 是否允许走免费降级。 */
export function isFallbackEligible(error: unknown): boolean {
  if (isMoclErrorLike(error)) {
    return (
      error.code === "auth.credential-expired" ||
      error.code === "auth.missing-credential" ||
      error.code === "auth.login-required"
    );
  }
  if (isApiKeyExpired(error) || isAuthFailure(error)) return true;
  // ACP JSON-RPC -32000（Auth required）
  if (error !== null && typeof error === "object") {
    const code = (error as Record<string, unknown>)["code"];
    if (code === -32000) return true;
    if (code === "jsonrpc.-32000") return true;
  }
  return false;
}

interface MoclErrorLike {
  readonly code: string;
}

function isMoclErrorLike(value: unknown): value is MoclErrorLike {
  return value !== null && typeof value === "object" && typeof (value as MoclErrorLike).code === "string";
}

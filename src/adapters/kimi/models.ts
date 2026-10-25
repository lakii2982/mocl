/**
 * kimi 模型 / 配置项路由（docs/adapters/kimi.md §8.2）。
 *
 * 实测事实（docs/research/kimi.md）：
 * - `session/new` 返回 `configOptions`，id 实测恒为 `model` / `thinking` / `mode`（kimi.md:232）；
 * - 切模型首选 `session/set_config_option{configId:"model", value}`，实测生效并把
 *   `currentValue` 从 `kimi-code/k3.1-pro` 改为 `deepseek/deepseek-flash`（kimi.md:237）；
 * - `session/set_model{modelId}` 亦可用（实测返回 `{}`，kimi.md:238）；
 * - 模型名形如 `"<provider>/<model>"`（config.toml `models."kimi-code/k3.1-pro"`，kimi.md:171-176）。
 */
import type { KimiConfigOption } from "./types.ts";

export const CONFIG_ID_MODEL = "model";
export const CONFIG_ID_MODE = "mode";
export const CONFIG_ID_THINKING = "thinking";

/** kimi 侧默认模型（本机 `config.toml: default_model`，kimi.md:164；仅作兜底展示，不覆盖用户配置）。 */
export const DEFAULT_KIMI_MODEL = "kimi-code/k3.1-pro";

/** 模型引用（`provider/model`；无 provider 前缀时按错误处理，不猜）。 */
export interface KimiModelRef {
  readonly provider: string;
  readonly model: string;
  readonly raw: string;
}

/** 解析 `provider/model`；格式非法 → null（调用方 fail-closed）。 */
export function parseKimiModelRef(value: string | null | undefined): KimiModelRef | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1), raw };
}

/** `configOptions` 中 id=model 的当前值（无则 null）。 */
export function currentModelOf(configOptions: readonly KimiConfigOption[] | undefined): string | null {
  const option = configOptions?.find((item) => item.id === CONFIG_ID_MODEL);
  return option?.currentValue ?? null;
}

/** `configOptions` 中 id=model 的可选值（用于诊断/能力上报，不用于自动改写）。 */
export function availableModels(configOptions: readonly KimiConfigOption[] | undefined): readonly string[] {
  const option = configOptions?.find((item) => item.id === CONFIG_ID_MODEL);
  return (option?.options ?? []).map((item) => item.value);
}

/** `configOptions` 中 id=thinking 的当前 effort（kimi 实测 low/high/max，kimi.md:232）。 */
export function currentThinkingOf(configOptions: readonly KimiConfigOption[] | undefined): string | null {
  const option = configOptions?.find((item) => item.id === CONFIG_ID_THINKING);
  return option?.currentValue ?? null;
}

/**
 * 解析请求里的模型：`null` → 用 `fallback`；非法格式 → 抛错（fail-closed，不静默降级）。
 */
export function resolveModel(requested: string | null | undefined, fallback: string): string {
  if (requested === null || requested === undefined) return fallback;
  const parsed = parseKimiModelRef(requested);
  if (parsed === null) {
    throw new Error(`invalid kimi model reference: ${JSON.stringify(requested)} (expected "provider/model")`);
  }
  return parsed.raw;
}

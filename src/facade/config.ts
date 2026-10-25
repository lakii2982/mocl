/**
 * 门面配置（C8）：`config.default.json` 的类型、默认值与校验。
 *
 * 安全默认（BRIEF §6-5 / D-016 / D-018）：
 * - `global.enabled=false`、四个后端 `enabled=false`（显式开启，fail-closed）；
 * - `permissionMode=read-only`、`allowDangerousModes=false`、`worktreeIsolation=required-for-write`；
 * - `maxConcurrent="runtime"`（跟随 DSH seam `subagent.maxActiveSubagents`，**禁止硬编码**）；
 * - 父级进度硬上限 8 条 / 1200 字符 / 单条 400 字符（超限配置直接拒绝）。
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BackendId, PermissionProfile } from "../abi/types.ts";

export const BACKEND_IDS = ["codex", "kimi", "claude-code", "opencode"] as const;
export type ConfigBackendId = (typeof BACKEND_IDS)[number];

export type MaxConcurrent = "runtime" | number;

export interface ProgressConfig {
  readonly mode: "off" | "summary";
  readonly maxItemsPerTurn: number;
  readonly maxCharsPerTurn: number;
  readonly maxCharsPerItem: number;
  readonly samplingWindowMs: number;
}

export interface BackendConfig {
  readonly enabled: boolean;
  readonly model: string | null;
  /** 仅 opencode 使用：生产模型失效时的免费降级（D-019）。 */
  readonly fallbackModel: string | null;
  readonly permissionMode: PermissionProfile;
  readonly allowDangerousModes: boolean;
  readonly maxConcurrent: MaxConcurrent;
  readonly maxDepth: number;
  readonly worktreeIsolation: "off" | "required-for-write" | "always";
  /** kimi/opencode：`acp` | `cli`（kimi 默认 acp；opencode 默认 http 语义用 acp 字段存 transport）。 */
  readonly channel: "acp" | "cli" | "http";
  readonly binaryPath: string | null;
  readonly env: Readonly<Record<string, string>>;
}

export interface GlobalConfig {
  readonly enabled: boolean;
  readonly maxConcurrent: MaxConcurrent;
  readonly maxDepth: number;
  readonly maxSessions: number;
  readonly turnTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly parentDelivery: "parent" | "caller";
  readonly progress: ProgressConfig;
  readonly dangerousModes: { readonly allowed: boolean };
  readonly worktree: { readonly root: string; readonly isolation: "off" | "required-for-write" | "always" };
  readonly journal: { readonly dir: string; readonly retentionDays: number };
  readonly logLevel: "silent" | "error" | "warn" | "info" | "debug";
}

export interface FacadeConfig {
  readonly version: 1;
  readonly global: GlobalConfig;
  readonly backends: Readonly<Record<ConfigBackendId, BackendConfig>>;
}

export const PARENT_PROGRESS_HARD_LIMITS = Object.freeze({
  maxItemsPerTurn: 8,
  maxCharsPerTurn: 1200,
  maxCharsPerItem: 400,
} as const);

const BACKEND_DEFAULTS: Omit<BackendConfig, "model" | "fallbackModel"> = {
  enabled: false,
  permissionMode: "read-only",
  allowDangerousModes: false,
  maxConcurrent: "runtime",
  maxDepth: 2,
  worktreeIsolation: "required-for-write",
  channel: "acp",
  binaryPath: null,
  env: {},
};

/** 默认配置（与 `config.default.json` 保持一致；测试断言两者相同）。 */
export const DEFAULT_CONFIG: FacadeConfig = {
  version: 1,
  global: {
    enabled: false,
    maxConcurrent: "runtime",
    maxDepth: 2,
    maxSessions: 16,
    turnTimeoutMs: 1_800_000,
    requestTimeoutMs: 30_000,
    idleTimeoutMs: 180_000,
    parentDelivery: "parent",
    progress: {
      mode: "off",
      maxItemsPerTurn: PARENT_PROGRESS_HARD_LIMITS.maxItemsPerTurn,
      maxCharsPerTurn: PARENT_PROGRESS_HARD_LIMITS.maxCharsPerTurn,
      maxCharsPerItem: PARENT_PROGRESS_HARD_LIMITS.maxCharsPerItem,
      samplingWindowMs: 5_000,
    },
    dangerousModes: { allowed: false },
    worktree: { root: "~/.mocl/worktrees", isolation: "required-for-write" },
    journal: { dir: "var", retentionDays: 7 },
    logLevel: "info",
  },
  backends: {
    codex: { ...BACKEND_DEFAULTS, model: null, fallbackModel: null },
    kimi: { ...BACKEND_DEFAULTS, model: null, fallbackModel: null },
    "claude-code": { ...BACKEND_DEFAULTS, model: null, fallbackModel: null },
    opencode: {
      ...BACKEND_DEFAULTS,
      model: "opencode-go/deepseek-v4.1-flash",
      fallbackModel: "opencode/deepseek-v4.1-flash-free",
      channel: "http",
    },
  },
};

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid MOCL config: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown, path: string, issues: string[]): unknown {
  if (override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) {
    if (Array.isArray(override)) return override;
    issues.push(`${path}: expected array`);
    return base;
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (!(key in base)) {
        issues.push(`${path}.${key}: unknown key`);
        continue;
      }
      out[key] = deepMerge(base[key], value, `${path}.${key}`, issues);
    }
    return out;
  }
  if (isPlainObject(base) !== isPlainObject(override)) {
    issues.push(`${path}: type mismatch`);
    return base;
  }
  return override;
}

function validatePermissionMode(
  issues: string[],
  path: string,
  backend: ConfigBackendId,
  mode: PermissionProfile,
  allowDangerousModes: boolean,
  worktreeIsolation: BackendConfig["worktreeIsolation"],
  globalDangerous: boolean,
): void {
  if (!["read-only", "safe-auto", "yolo"].includes(mode)) {
    issues.push(`${path}: permissionMode must be read-only|safe-auto|yolo`);
    return;
  }
  if (mode === "read-only") return;
  if (!globalDangerous) issues.push(`${path}: permissionMode=${mode} requires global.dangerousModes.allowed=true`);
  if (!allowDangerousModes) issues.push(`${path}: permissionMode=${mode} requires ${backend}.allowDangerousModes=true`);
  if (worktreeIsolation === "off") issues.push(`${path}: permissionMode=${mode} requires worktreeIsolation != off`);
}

/**
 * 深度合并默认值并校验；任何未知键/类型错误/硬上限越界 → `ConfigError`（fail-closed）。
 */
export function validateConfig(input: unknown = {}): FacadeConfig {
  if (!isPlainObject(input)) throw new ConfigError(["config root must be an object"]);
  const issues: string[] = [];
  const merged = deepMerge(DEFAULT_CONFIG, input, "config", issues) as FacadeConfig;
  const g = merged.global;

  if (typeof g.enabled !== "boolean") issues.push("global.enabled: expected boolean");
  if (g.maxConcurrent !== "runtime" && (!Number.isSafeInteger(g.maxConcurrent) || g.maxConcurrent <= 0)) {
    issues.push("global.maxConcurrent: expected \"runtime\" or positive safe integer");
  }
  if (!Number.isSafeInteger(g.maxDepth) || g.maxDepth < 1 || g.maxDepth > 3) {
    issues.push("global.maxDepth: expected integer 1..3");
  }
  if (!Number.isSafeInteger(g.maxSessions) || g.maxSessions <= 0) issues.push("global.maxSessions: expected positive integer");
  for (const key of ["turnTimeoutMs", "requestTimeoutMs", "idleTimeoutMs"] as const) {
    if (!Number.isSafeInteger(g[key]) || g[key] <= 0) issues.push(`global.${key}: expected positive integer`);
  }
  if (g.parentDelivery !== "parent" && g.parentDelivery !== "caller") issues.push("global.parentDelivery: expected parent|caller");
  if (!["off", "summary"].includes(g.progress.mode)) issues.push("global.progress.mode: expected off|summary");
  const limits = PARENT_PROGRESS_HARD_LIMITS;
  if (g.progress.maxItemsPerTurn < 1 || g.progress.maxItemsPerTurn > limits.maxItemsPerTurn) {
    issues.push(`global.progress.maxItemsPerTurn: hard limit 1..${limits.maxItemsPerTurn}`);
  }
  if (g.progress.maxCharsPerTurn < 1 || g.progress.maxCharsPerTurn > limits.maxCharsPerTurn) {
    issues.push(`global.progress.maxCharsPerTurn: hard limit 1..${limits.maxCharsPerTurn}`);
  }
  if (g.progress.maxCharsPerItem < 1 || g.progress.maxCharsPerItem > limits.maxCharsPerItem) {
    issues.push(`global.progress.maxCharsPerItem: hard limit 1..${limits.maxCharsPerItem}`);
  }
  if (!Number.isSafeInteger(g.progress.samplingWindowMs) || g.progress.samplingWindowMs < 1_000) {
    issues.push("global.progress.samplingWindowMs: expected integer >= 1000");
  }
  if (typeof g.dangerousModes.allowed !== "boolean") issues.push("global.dangerousModes.allowed: expected boolean");
  if (typeof g.worktree.isolation !== "string") issues.push("global.worktree.isolation: expected string");
  if (typeof g.journal.dir !== "string" || g.journal.dir.length === 0) issues.push("global.journal.dir: expected non-empty string");
  if (!Number.isSafeInteger(g.journal.retentionDays) || g.journal.retentionDays < 1) {
    issues.push("global.journal.retentionDays: expected positive integer");
  }
  if (!["silent", "error", "warn", "info", "debug"].includes(g.logLevel)) {
    issues.push("global.logLevel: expected silent|error|warn|info|debug");
  }

  for (const backendId of BACKEND_IDS) {
    const b = merged.backends[backendId];
    const path = `config.backends.${backendId}`;
    if (!isPlainObject(b)) {
      issues.push(`${path}: expected object`);
      continue;
    }
    if (typeof b.enabled !== "boolean") issues.push(`${path}.enabled: expected boolean`);
    if (b.model !== null && (typeof b.model !== "string" || b.model.length === 0)) issues.push(`${path}.model: expected string|null`);
    if (b.fallbackModel !== null && (typeof b.fallbackModel !== "string" || b.fallbackModel.length === 0)) {
      issues.push(`${path}.fallbackModel: expected string|null`);
    }
    validatePermissionMode(
      issues,
      `${path}.permissionMode`,
      backendId,
      b.permissionMode,
      b.allowDangerousModes,
      b.worktreeIsolation,
      g.dangerousModes.allowed,
    );
    if (typeof b.allowDangerousModes !== "boolean") issues.push(`${path}.allowDangerousModes: expected boolean`);
    if (b.maxConcurrent !== "runtime" && (!Number.isSafeInteger(b.maxConcurrent) || b.maxConcurrent <= 0)) {
      issues.push(`${path}.maxConcurrent: expected "runtime" or positive safe integer`);
    }
    if (!Number.isSafeInteger(b.maxDepth) || b.maxDepth < 1 || b.maxDepth > 3) issues.push(`${path}.maxDepth: expected integer 1..3`);
    if (!["off", "required-for-write", "always"].includes(b.worktreeIsolation)) {
      issues.push(`${path}.worktreeIsolation: expected off|required-for-write|always`);
    }
    if (!["acp", "cli", "http"].includes(b.channel)) issues.push(`${path}.channel: expected acp|cli|http`);
    if (b.binaryPath !== null && (typeof b.binaryPath !== "string" || !isAbsolute(b.binaryPath.startsWith("~") ? "/placeholder" : b.binaryPath))) {
      issues.push(`${path}.binaryPath: expected absolute path or null`);
    }
    if (!isPlainObject(b.env)) issues.push(`${path}.env: expected object`);
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return merged;
}

/** 默认配置文件的绝对路径（相对 `impl/` 根）。 */
export function defaultConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../config.default.json");
}

/** 读取并校验配置文件；`path` 省略时读 `MOCL_CONFIG` 或 `impl/config.default.json`。 */
export async function loadFacadeConfig(path?: string, overrides?: unknown): Promise<FacadeConfig> {
  const target = path ?? process.env.MOCL_CONFIG ?? defaultConfigPath();
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    throw new ConfigError([`cannot read config ${target}: ${(error as Error).message}`]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError([`config ${target} is not valid JSON: ${(error as Error).message}`]);
  }
  const base = validateConfig(parsed);
  return overrides === undefined ? base : validateConfig(deepMerge(base, overrides, "config", []));
}

/** 启用中的后端（顺序固定，供工具枚举/文档一致）。 */
export function enabledBackends(config: FacadeConfig): ConfigBackendId[] {
  return BACKEND_IDS.filter((backendId) => config.backends[backendId].enabled);
}

/** 配置摘要（不打印任何凭据；用于日志/状态）。 */
export function configDigest(config: FacadeConfig): string {
  const summary = {
    globalEnabled: config.global.enabled,
    maxConcurrent: config.global.maxConcurrent,
    backends: BACKEND_IDS.map((id) => ({
      id,
      enabled: config.backends[id].enabled,
      permissionMode: config.backends[id].permissionMode,
      model: config.backends[id].model,
      maxConcurrent: config.backends[id].maxConcurrent,
    })),
  };
  return JSON.stringify(summary);
}

export function joinConfigPath(...parts: string[]): string {
  return join(...parts);
}

export type { BackendId };

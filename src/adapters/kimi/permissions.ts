/**
 * kimi 权限语义映射（docs/adapters/kimi.md §3.2/§7.1/§7.2/§7.5；LEDGER **D-004**）。
 *
 * ## 本文档存在的唯一原因：kimi 的权限**命名是错位的**
 *
 * 实测（docs/research/kimi.md:88-104）：
 * | CLI 旗标 | 帮助原文语义 | 实际等价 ACP mode |
 * |---|---|---|
 * | `-y, --yolo` | "Ask When Needed: routine edits … risky actions/questions/plans still ask" | `auto` |
 * | `--auto`     | "Never Ask: never interrupts you"                                       | `yolo` |
 * | `--plan`     | "Start in plan mode"                                                    | `plan` |
 *
 * → 名字 `yolo` 对应的是 ACP `auto`（安全自动）；名字 `auto` 才是 ACP `yolo`（全放行）。
 * **任何按名字透传的实现都会把 `safe-auto` 放大成 `yolo`（安全降级事故）**，故本文件只做语义映射，
 * 并且导出一个反向断言函数 `assertSemanticMapping()` 供测试与握手期自检使用。
 *
 * 另一条硬约束（§7.5）：`-p` 与 `--auto`/`-y`/`--plan` 互斥（rc=1），所以 CLI 兜底通道的权限档位
 * **只能**由 `config.toml: default_permission_mode` 决定 → 见 `readKimiConfigProbe` / `cliFallbackAllowed`。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionProfile, PermissionRisk } from "../../abi/types.ts";
import type { KimiConfigProbe, KimiPermissionOption } from "./types.ts";

/** ABI 三档 → ACP `modeId`（唯一权威映射；缺 `default` 档，人工审批不由本适配器产生）。 */
export const ACP_MODE_BY_PROFILE: Readonly<Record<PermissionProfile, string>> = {
  "read-only": "plan", // 严格档：只读规划、无工具执行（§3.2；另有 default+规则白名单的"可用档"，默认不启用）
  "safe-auto": "auto", // 自动批准安全操作
  yolo: "yolo", // 自动批准一切
};

/** ACP `modeId` → ABI 档（反向；`default` 无等价档，归 read-only 的保守侧）。 */
export const PROFILE_BY_ACP_MODE: Readonly<Record<string, PermissionProfile>> = {
  default: "read-only",
  plan: "read-only",
  auto: "safe-auto",
  yolo: "yolo",
};

/** kimi 全部 4 档 ACP mode（实测 availableModes，kimi.md:97-102）。 */
export const KIMI_ACP_MODES: readonly string[] = ["default", "plan", "auto", "yolo"];

/**
 * CLI 旗标 →（语义, ACP mode）。
 *
 * **不要**用这个表去"把 ABI 档翻译成旗标"然后传给 `-p`（互斥，rc=1）。
 * 它只用于：① 文档/诊断文案；② 校验调用方没有按名字猜语义。
 */
export const CLI_FLAG_SEMANTICS: readonly {
  readonly flag: string;
  readonly semantics: "ask-when-needed" | "never-ask" | "plan-read-only" | "manual-approval";
  readonly acpMode: string;
  readonly abiProfile: PermissionProfile;
}[] = [
  { flag: "(默认)", semantics: "manual-approval", acpMode: "default", abiProfile: "read-only" },
  { flag: "--plan", semantics: "plan-read-only", acpMode: "plan", abiProfile: "read-only" },
  { flag: "-y, --yolo", semantics: "ask-when-needed", acpMode: "auto", abiProfile: "safe-auto" },
  { flag: "--auto", semantics: "never-ask", acpMode: "yolo", abiProfile: "yolo" },
];

/** ABI 档 → ACP modeId。 */
export function acpModeForProfile(profile: PermissionProfile): string {
  return ACP_MODE_BY_PROFILE[profile];
}

/** ABI 档 → CLI 旗标（仅供诊断；**禁止**把它拼到 `-p` 上）。 */
export function cliFlagForProfile(profile: PermissionProfile): string {
  switch (profile) {
    case "read-only":
      return "--plan";
    case "safe-auto":
      return "-y";
    case "yolo":
      return "--auto";
  }
}

/**
 * 自检：语义映射与"D-004 命名错位"事实一致。
 * 任何改动本文件映射表的人都必须让这里继续为真（测试 `permissions.test.ts` 直接断言）。
 */
export function assertSemanticMapping(): void {
  const contradictions: string[] = [];
  // CLI 的 `-y/--yolo` 不得映射到 ACP `yolo`
  if (CLI_FLAG_SEMANTICS.find((item) => item.flag.startsWith("-y"))?.acpMode === "yolo") {
    contradictions.push("CLI -y/--yolo must not map to ACP yolo (it is Ask-When-Needed ≈ auto)");
  }
  // CLI 的 `--auto` 必须映射到 ACP `yolo`
  if (CLI_FLAG_SEMANTICS.find((item) => item.flag === "--auto")?.acpMode !== "yolo") {
    contradictions.push("CLI --auto must map to ACP yolo (it is Never-Ask)");
  }
  // 三档必须一一对应且互不相同
  const modes = new Set(Object.values(ACP_MODE_BY_PROFILE));
  if (modes.size !== 3) contradictions.push("ACP_MODE_BY_PROFILE must be injective");
  for (const mode of modes) {
    if (!KIMI_ACP_MODES.includes(mode)) contradictions.push(`unknown ACP mode in mapping: ${mode}`);
  }
  // `plan` 必须落在 read-only（严格档）
  if (ACP_MODE_BY_PROFILE["read-only"] !== "plan") contradictions.push("read-only must map to ACP plan");
  if (contradictions.length > 0) {
    throw new Error(`kimi permission mapping self-check failed: ${contradictions.join("; ")}`);
  }
}

/* ------------------------------------------------------------------ */
/* 风险分级与自动应答（§7.2）                                          */
/* ------------------------------------------------------------------ */

/** 工具 title/kind → 风险分级。实测 kimi `kind ∈ {read, other}`，title 为 `Read`/`Write`/`Skill` 等。 */
export function classifyRisk(toolTitle: string, toolKind?: string): PermissionRisk {
  const title = toolTitle.toLowerCase();
  const kind = (toolKind ?? "").toLowerCase();
  if (kind === "read" || /^(read|grep|glob|ls|list)\b/.test(title)) return "read";
  if (/^(write|edit|apply_patch|patch|notebookedit)\b/.test(title)) return "write";
  if (/^(bash|shell|command|exec|run)\b/.test(title) || kind === "execute") return "execute";
  if (/^(webfetch|websearch|fetch|http)\b/.test(title)) return "network";
  if (/^skill\b/.test(title)) return "read"; // Skill 只加载指令，不改盘
  if (title.length === 0) return "unknown";
  return "unknown";
}

/** 风险 → 是否允许自动放行（`safe-auto` 只放到 write，`execute/network` 需 yolo）。 */
function autoApproveAllowed(profile: PermissionProfile, risk: PermissionRisk): boolean {
  switch (profile) {
    case "read-only":
      return false; // 严格档：任何请求一律 deny（read 也不放，因为 plan 模式本不该发请求）
    case "safe-auto":
      return risk === "read" || risk === "write";
    case "yolo":
      return true;
  }
}

/** ACP option `kind` → ABI option `kind`（§7.2；按 kind 匹配，**不按 optionId 字面**）。 */
export function abiOptionKind(nativeKind: string | undefined): "allow-once" | "allow-always" | "deny-once" | "cancel" | "unknown" {
  switch (nativeKind) {
    case "allow_once":
      return "allow-once";
    case "allow_always":
      return "allow-always";
    case "reject_once":
    case "reject_always":
      return "deny-once";
    case "cancel":
      return "cancel";
    default:
      return "unknown";
  }
}

/** 权限请求的自动应答结果。 */
export interface PermissionAnswer {
  /** 回给 ACP 的 `optionId`（必须是该请求里真实存在的 id）。 */
  readonly optionId: string;
  readonly decision: "allow-once" | "allow-always" | "deny" | "cancel";
  readonly risk: PermissionRisk;
  /** 无匹配 option 时为 true → 上层可发 `policy.escalation-required`。 */
  readonly escalationRequired: boolean;
}

/**
 * `session/request_permission` 的确定性自动应答（§7.2）。
 *
 * - 默认 **deny**（无人值守安全默认，BRIEF 硬约束 5）；
 * - `safe-auto`：仅 risk ∈ {read, write} 且存在 `allow_once` 时放行一次；**不**持久放行；
 * - `yolo`：优先 `allow_always`（若存在），否则 `allow_once`；
 * - 只按 `kind` 选择，`optionId` 随版本变（kimi.md:290）→ 找不到匹配就 deny + escalationRequired。
 */
export function answerPermissionRequest(
  options: readonly KimiPermissionOption[],
  profile: PermissionProfile,
  risk: PermissionRisk,
): PermissionAnswer {
  const byKind = (kind: string): KimiPermissionOption | undefined =>
    options.find((option) => option.kind === kind);

  const reject = byKind("reject_once") ?? byKind("reject_always") ?? options.find((option) => option.kind === "cancel");
  const denyAnswer = (escalationRequired: boolean): PermissionAnswer => ({
    optionId: reject?.optionId ?? "",
    decision: "deny",
    risk,
    escalationRequired,
  });

  if (!autoApproveAllowed(profile, risk)) return denyAnswer(false);

  if (profile === "yolo") {
    const always = byKind("allow_always");
    if (always !== undefined) return { optionId: always.optionId, decision: "allow-always", risk, escalationRequired: false };
  }
  const once = byKind("allow_once");
  if (once !== undefined) return { optionId: once.optionId, decision: "allow-once", risk, escalationRequired: false };

  // 放行档位但没有可用的 allow option → 只能 deny，并标记需要上层升级决策。
  return denyAnswer(true);
}

/* ------------------------------------------------------------------ */
/* config.toml 只读探测（§7.5）                                        */
/* ------------------------------------------------------------------ */

/** 默认配置路径：`$KIMI_HOME/config.toml` 或 `~/.kimi-code/config.toml`。 */
export function defaultConfigPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = env["KIMI_HOME"];
  return home === undefined || home.length === 0
    ? join(homedir(), ".kimi-code", "config.toml")
    : join(home, "config.toml");
}

/**
 * 只读解析 config.toml 的**三个非敏感键**（`default_model` / `default_permission_mode` / `default_plan_mode`）。
 *
 * 安全：绝不读取/返回 `api_key`、`key`、`oauth.*` 等值（ABI SEC-1）。解析失败 → `readable:false`。
 * 不引入 TOML 依赖（只有三个顶层键，且都在第一个 `[section]` 之前，见 kimi.md:164-166）。
 */
export function readKimiConfigProbe(
  filePath: string = defaultConfigPath(),
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): KimiConfigProbe {
  let text: string;
  try {
    text = readFile(filePath);
  } catch {
    return { defaultModel: null, defaultPermissionMode: null, defaultPlanMode: null, readable: false };
  }
  const probe = { defaultModel: null as string | null, defaultPermissionMode: null as string | null, defaultPlanMode: null as boolean | null, readable: true };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) break; // 顶层键只出现在第一个 section 之前
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = stripTomlScalar(line.slice(eq + 1).trim());
    if (key === "default_model") probe.defaultModel = value;
    else if (key === "default_permission_mode") probe.defaultPermissionMode = value;
    else if (key === "default_plan_mode") probe.defaultPlanMode = value === "true";
  }
  return probe;
}

function stripTomlScalar(value: string): string {
  const withoutComment = value.split("#")[0]?.trim() ?? "";
  if (withoutComment.length >= 2 && withoutComment.startsWith('"') && withoutComment.endsWith('"')) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

/**
 * CLI 兜底通道是否允许（§7.5 保守判定）。
 *
 * `-p` 无法指定权限档（与 `--auto`/`-y`/`--plan` 互斥），档位完全由
 * `config.toml: default_permission_mode` 决定。因此：
 * - 请求 `yolo`：配置必须是 `yolo`（同名同义，无歧义）；
 * - 请求 `safe-auto`：配置必须是 `auto`（**注意**：不能是 `yolo`）；
 * - 请求 `read-only`：配置必须是 `plan` 或 `default`（拒绝 `auto`/`yolo`）。
 * 配置不可读 / 键缺失 / 值未知 → **拒绝**（fail-closed）。
 *
 * @returns `{allowed:true}` 或 `{allowed:false, reason}`
 */
export function cliFallbackAllowed(
  profile: PermissionProfile,
  probe: KimiConfigProbe,
): { readonly allowed: boolean; readonly reason?: string } {
  if (!probe.readable) return { allowed: false, reason: "config.toml unreadable (fail-closed)" };
  const mode = probe.defaultPermissionMode;
  if (mode === null || mode.length === 0) {
    return { allowed: false, reason: "config.toml: default_permission_mode missing (fail-closed)" };
  }
  const allowedValues: Readonly<Record<PermissionProfile, readonly string[]>> = {
    "read-only": ["plan", "default"],
    "safe-auto": ["auto"],
    yolo: ["yolo"],
  };
  if (!allowedValues[profile].includes(mode)) {
    return {
      allowed: false,
      reason: `config.toml: default_permission_mode="${mode}" cannot satisfy permissionProfile="${profile}" (asymmetric: CLI -y=auto, --auto=yolo)`,
    };
  }
  return { allowed: true };
}

/**
 * 校验「不允许传给 `-p` 的模式旗标」没有出现（§7.5 的互斥约束编码成断言）。
 * 任何把 `-y`/`--auto`/`--plan` 拼进 prompt 参数列表的实现都会在这里被抓到。
 */
export function assertNoPromptModeFlags(argv: readonly string[]): void {
  const forbidden = ["-y", "--yolo", "--auto", "--plan"];
  const hit = argv.find((arg) => forbidden.includes(arg));
  if (hit !== undefined) {
    throw new Error(`kimi -p cannot be combined with ${hit} (kimi.md:106-115); headless mode is fixed by config.toml`);
  }
}

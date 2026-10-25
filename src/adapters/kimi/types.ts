/**
 * kimi-code 2.3.1 原生线格式类型（docs/adapters/kimi.md §2/§3/§5；证据 docs/research/kimi.md）。
 *
 * 纪律：
 * - 本文件只描述**实测过**的形状（recorded evidence），未观测字段一律 optional；
 * - 原生名只在本层出现，不得外泄到 ABI 事件（ABI §0 规则 2）。
 */

/** npm 侧无 kimi 包，这里按实测响应手写结构。 */
export interface KimiAcpInitResult {
  readonly protocolVersion: number;
  readonly agentInfo?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly agentCapabilities?: Readonly<Record<string, unknown>>;
  readonly authMethods?: readonly unknown[];
}

/** `session/new` 的 `configOptions[]`（实测 id ∈ model/thinking/mode，kimi.md:232）。 */
export interface KimiConfigOption {
  readonly id: string;
  readonly name?: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue?: string;
  readonly options?: readonly { readonly value: string; readonly name?: string }[];
}

/** `session/new` 的 `modes`（实测 availableModes = default/plan/auto/yolo，kimi.md:97-102）。 */
export interface KimiModes {
  readonly currentModeId?: string;
  readonly availableModes?: readonly { readonly id: string; readonly name?: string; readonly description?: string }[];
}

export interface KimiNewSessionResult {
  readonly sessionId: string;
  readonly configOptions?: readonly KimiConfigOption[];
  readonly modes?: KimiModes | null;
}

/** `session/prompt` 结果（实测 `{"stopReason":"end_turn"}`，kimi.md:239）。 */
export interface KimiPromptResult {
  readonly stopReason: string;
  /** kimi 未在 prompt result 里回 usage（用量走 `usage_update` 通知），保留字段仅为兼容。 */
  readonly usage?: unknown;
}

/** `session/update` 通知（实测 9 类，kimi.md:254-270）。 */
export interface KimiSessionUpdateParams {
  readonly sessionId: string;
  readonly update: Readonly<Record<string, unknown>> & { readonly sessionUpdate?: string };
}

/** `session/list` 条目（实测 {sessionId,cwd,title,updatedAt}，kimi.md:234）。 */
export interface KimiSessionSummary {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly title?: string | null;
  readonly updatedAt?: string;
}

/** `session/request_permission` 的 options 条目（实测 kind ∈ allow_once/allow_always/reject_once）。 */
export interface KimiPermissionOption {
  readonly optionId: string;
  readonly name?: string;
  readonly kind?: string;
}

/**
 * `-p --output-format stream-json` 的单行事件（实测 3 形，kimi.md:309-332）：
 * - `{role:"meta", type:"system.version", version}`；
 * - `{role:"meta", type:"session.resume_hint", session_id, command, content}`；
 * - `{role:"assistant", content}` / `{role:"assistant", tool_calls:[...]}` / `{role:"tool", tool_call_id, content}`。
 */
export interface KimiCliEvent {
  readonly role?: string;
  readonly type?: string;
  readonly version?: string;
  readonly content?: unknown;
  readonly session_id?: string;
  readonly command?: string;
  readonly tool_calls?: readonly KimiCliToolCall[];
  readonly tool_call_id?: string;
}

export interface KimiCliToolCall {
  readonly type?: string;
  readonly id?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

/** 预检读到的 config.toml 非敏感键（§7.5；只读键名与这三项的值）。 */
export interface KimiConfigProbe {
  readonly defaultModel: string | null;
  readonly defaultPermissionMode: string | null;
  readonly defaultPlanMode: boolean | null;
  readonly readable: boolean;
}

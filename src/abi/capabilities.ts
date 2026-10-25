/**
 * ABI v0 能力位（真源：docs/abi/abi-v0.md §3.2，34 位；A 组 15 = 能力矩阵行，B 组 19 = ABI 细分）。
 *
 * 握手期由适配器生成 `CapabilityDeclaration.bits`；运行期禁止临时切换降级路径（ABI §3.5）。
 */
export const CAPABILITY_STATES = ["native", "emulated", "unavailable"] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const CAPABILITY_BITS = [
  // A 组（15）：与能力矩阵行 1:1
  "headless",
  "streaming",
  "resumeSession",
  "forkSession",
  "listSessions",
  "interruptTurn",
  "nativeSubagents",
  "toolExtension",
  "permissionModes",
  "sandboxModes",
  "modelRouting",
  "concurrencyControl",
  "usageReporting",
  "structuredProtocol",
  "versionPinning",
  // B 组（19）：ABI 运行期细分
  "multiTurn",
  "steerTurn",
  "inputInbox",
  "tokenLevelStream",
  "planUpdates",
  "diffUpdates",
  "tokenUsage",
  "permissionAutoReply",
  "permissionRequestBridge",
  "childSessionUpdates",
  "sessionArchive",
  "sessionUnarchive",
  "sessionDelete",
  "sessionExport",
  "sessionReseed",
  "worktreeIsolation",
  "backgroundRuns",
  "processKillInterrupt",
  "handshakeVersion",
] as const;

export type CapabilityBit = (typeof CAPABILITY_BITS)[number];

export const CAPABILITY_GROUP_A: readonly CapabilityBit[] = CAPABILITY_BITS.slice(0, 15);
export const CAPABILITY_GROUP_B: readonly CapabilityBit[] = CAPABILITY_BITS.slice(15);

/** 能力位 → 状态；缺失等价 `unavailable`（`missingCapabilities` 的语义）。 */
export type CapabilitySet = Readonly<Partial<Record<CapabilityBit, CapabilityState>>>;

export interface CapabilityEntryLike {
  readonly bit: CapabilityBit;
  readonly state: CapabilityState;
}

export const CAPABILITY_BIT_SET: ReadonlySet<CapabilityBit> = new Set(CAPABILITY_BITS);

export function isCapabilityBit(value: string): value is CapabilityBit {
  return CAPABILITY_BIT_SET.has(value as CapabilityBit);
}

/** `CapabilityDeclaration.bits[]` → 便于查询的 CapabilitySet（同 bit 后到覆盖先到）。 */
export function toCapabilitySet(entries: readonly CapabilityEntryLike[]): CapabilitySet {
  const set: Partial<Record<CapabilityBit, CapabilityState>> = {};
  for (const entry of entries) set[entry.bit] = entry.state;
  return set;
}

/**
 * 返回 required 中**不可用**的能力位（缺失或 `unavailable`）。
 * `emulated` 视为可用，但会出现在 `degradedCapabilities` 中（调用方据此上报 degradeWarnings）。
 */
export function missingCapabilities(
  required: readonly CapabilityBit[],
  actual: CapabilitySet,
): CapabilityBit[] {
  return required.filter((bit) => {
    const state = actual[bit];
    return state === undefined || state === "unavailable";
  });
}

/** 返回 required 中**已降级**（`emulated`）的能力位；`native/unavailable` 不计入。 */
export function degradedCapabilities(
  required: readonly CapabilityBit[],
  actual: CapabilitySet,
): CapabilityBit[] {
  return required.filter((bit) => actual[bit] === "emulated");
}

/** required 是否全部 native 或 emulated（即无缺失）。 */
export function supportsAll(required: readonly CapabilityBit[], actual: CapabilitySet): boolean {
  return missingCapabilities(required, actual).length === 0;
}

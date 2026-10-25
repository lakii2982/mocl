/**
 * 后端适配器接口（ABI §4 绑定的 L1 边界；C2 先冻结控制面形状）。
 *
 * 说明：
 * - 本接口只描述 Broker(L2) 调用适配器(L1) 的最小面；事件流用 `events()` 异步迭代器，
 *   适配器内部负责把后端原生事件归一化为 `AdapterEvent`（ABI §7 事件名 + payload）。
 * - `capabilities` 必须来自握手实测（ABI §2.3/§3.3），不得用文档粘贴值。
 * - 不在此文件定义 Q4–Q7 的后端细节（那些属 `docs/adapters/*` 与对应切片）。
 */
import type { BackendId, CapabilityDeclaration, InputBlock, PermissionProfile } from "./types.ts";
import type { EventType } from "./events.ts";

/** `open` 请求：建后端会话（ABI §6 M2 的后端侧）。 */
export interface AdapterOpenRequest {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: string | null;
  readonly permissionProfile?: PermissionProfile;
  readonly epoch: number;
}

/** `open` 结果：后端会话 id（`backendSessionId`）。 */
export interface AdapterOpenResult {
  readonly remoteSessionId: string;
  readonly capabilities?: CapabilityDeclaration;
}

/** `send` 请求：启动一轮（ABI §6 M3 的后端侧）。 */
export interface AdapterSendRequest {
  readonly sessionId: string;
  readonly remoteSessionId: string;
  readonly input: readonly InputBlock[];
  /** 幂等键透传：适配器应在后端侧可对账时复用它（ABI §9）。 */
  readonly idempotencyKey: string;
}

/** `send` 结果：只代表「已接受」，终态以事件为准（ABI M3）。 */
export interface AdapterSendResult {
  readonly turnId: string;
  readonly acceptedAtSeq?: number;
}

/** `resume` 请求：冷恢复前的只读探测 + 续接（ABI §6 M4/M8）。 */
export interface AdapterResumeRequest {
  readonly sessionId: string;
  readonly remoteSessionId: string;
  readonly fromSeq: number;
}

/**
 * `resume` 结果：
 * - `exists=false` 表示后端会话已不存在/不可续（Broker 据此走 R-1：reseed 或 `session.not-found`）；
 * - `exists=true` 时 `remoteSessionId` 可回填（fork/reseed 会产生新 id）。
 */
export interface AdapterResumeResult {
  readonly exists: boolean;
  readonly remoteSessionId?: string;
  readonly reason?: string;
}

/** `interrupt` 请求（ABI §6 M5 的后端侧）。 */
export interface AdapterInterruptRequest {
  readonly sessionId: string;
  readonly remoteSessionId: string;
  readonly turnId?: string;
}

/** `close` 请求（ABI §6 M9 的后端侧）。 */
export interface AdapterCloseRequest {
  readonly sessionId: string;
  readonly remoteSessionId: string;
  readonly reason: "completed" | "failed" | "cancelled" | "operator";
}

/** 归一化后的适配器事件（`type` 必须是 ABI §7 的事件名）。 */
export interface AdapterEvent {
  readonly type: EventType;
  readonly turnId?: string;
  readonly payload: unknown;
}

/** L1 适配器最小接口（一个后端实例一个句柄）。 */
export interface BackendAdapter {
  readonly backendId: BackendId;
  /** 握手实测得到的能力声明（34 位；ABI §3.3）。 */
  readonly capabilities: CapabilityDeclaration;
  open(request: AdapterOpenRequest): Promise<AdapterOpenResult>;
  send(request: AdapterSendRequest): Promise<AdapterSendResult>;
  resume(request: AdapterResumeRequest): Promise<AdapterResumeResult>;
  interrupt(request: AdapterInterruptRequest): Promise<void>;
  close(request: AdapterCloseRequest): Promise<void>;
  /** 事件流（适配器生命周期内有效；Broker 消费到 close 或流结束）。 */
  events(): AsyncIterable<AdapterEvent>;
}

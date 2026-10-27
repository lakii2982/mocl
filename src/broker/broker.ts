/**
 * 会话代理 Broker（L2；施工 C2）。
 *
 * 职责（docs/architecture/01-layers.md §L2）：
 * - 会话注册表（`SessionRegistry`）+ 每后端适配器句柄（`BackendAdapter`）；
 * - 并发闸门一律运行时派生（`ConcurrencyLimiter` + `RuntimeConfigProvider`，D-016）；
 * - 幂等：`session.create/send/resume` 带 `clientRequestId`，同键同载荷返回既有结果、不重发；
 * - 冷恢复：`recover()` 只读探测 → epoch+1 → 不重放已终态轮次（02-state-machine §7/§8）。
 *
 * 非目标（后续切片）：事件流消费（C3 bus 独立；C4 起按适配器接入）、fork/steer/respond、
 * 跨进程租约（P2）。
 */
import { randomUUID } from "node:crypto";
import type { BackendAdapter } from "../abi/adapter.ts";
import type {
  BackendId,
  InputBlock,
  PermissionProfile,
  SessionState,
  TerminalReason,
} from "../abi/types.ts";
import { ConcurrencyLimiter, type RuntimeConfigProvider } from "./concurrency.ts";
import { moclError } from "./errors.ts";
import { hashRequest, IdempotencyLedger, ledgerKey } from "./idempotency.ts";
import { SessionRegistry, type SessionHandshake, type SessionRecord } from "./session-registry.ts";

export interface BrokerOptions {
  readonly runtime: RuntimeConfigProvider;
  readonly adapters: readonly BackendAdapter[];
  readonly registry?: SessionRegistry;
  readonly ledger?: IdempotencyLedger;
  readonly clock?: () => Date;
}

export interface OpenParams {
  readonly backend: BackendId;
  readonly cwd: string;
  readonly model?: string | null;
  readonly permissionProfile?: PermissionProfile;
  readonly childId?: string;
  readonly idempotencyKey?: string;
  /** W1（issue #18）：任务摘要（调用方规范化后的 label）；缺省不写入记录。 */
  readonly label?: string;
}

export interface OpenResult {
  readonly sessionId: string;
  readonly backend: BackendId;
  readonly backendSessionId: string;
  readonly epoch: number;
  readonly state: SessionState;
  readonly deduplicated: boolean;
}

export interface SendParams {
  readonly input: readonly InputBlock[];
  readonly idempotencyKey: string;
  readonly expect?: "turn" | "continue";
}

export interface SendResult {
  readonly sessionId: string;
  readonly turnId: string;
  readonly state: SessionState;
  readonly deduplicated: boolean;
}

export interface ResumeParams {
  readonly idempotencyKey: string;
  /** `none`（默认）：不存在即 `session.not-found`；`reseed`：新建并声明降级。 */
  readonly fallback?: "none" | "reseed";
  readonly model?: string | null;
}

export type ResumeStrategy = "resume" | "reseed";

export interface ResumeResult {
  readonly sessionId: string;
  readonly strategy: ResumeStrategy;
  readonly backendSessionId: string;
  readonly epoch: number;
  readonly degraded: boolean;
  readonly deduplicated: boolean;
}

export interface RecoverParams {
  readonly idempotencyKey?: string;
  readonly fallback?: "none" | "reseed";
}

export interface RecoverResult {
  readonly sessionId: string;
  readonly recovered: boolean;
  readonly strategy: ResumeStrategy | "aborted";
  readonly epoch: number;
  readonly replayedEvents: number;
  readonly deduplicated: boolean;
}

export interface SessionStatus {
  readonly sessionId: string;
  readonly backend: BackendId;
  readonly backendSessionId: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly state: SessionState;
  readonly epoch: number;
  readonly createdAt: string;
  readonly lastTurnId: string | null;
  readonly active: boolean;
}

interface SessionRuntime {
  record: SessionRecord;
  readonly adapter: BackendAdapter;
  state: SessionState;
  terminalReason: TerminalReason | null;
  lastTurnId: string | null;
  readonly releaseSlot: () => void;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `sess_` + 26 Crockford（ABI §0 的会话 id 形状）。 */
function newSessionId(): string {
  const bytes = randomUUID().replace(/-/g, "");
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    const hex = bytes.slice(i * 2, i * 2 + 2);
    out += CROCKFORD[Number.parseInt(hex.length === 0 ? "0" : hex, 16) % CROCKFORD.length] ?? "0";
  }
  return `sess_${out}`;
}

function newTurnId(): string {
  return `turn_${newSessionId().slice("sess_".length)}`;
}

function asArray<T>(value: readonly T[] | undefined): readonly T[] {
  return value ?? [];
}

export class Broker {
  readonly #runtime: RuntimeConfigProvider;
  readonly #limiter: ConcurrencyLimiter;
  readonly #adapters = new Map<BackendId, BackendAdapter>();
  readonly #registry: SessionRegistry;
  readonly #ledger: IdempotencyLedger;
  readonly #clock: () => Date;
  readonly #sessions = new Map<string, SessionRuntime>();
  #loaded = false;

  constructor(options: BrokerOptions) {
    this.#runtime = options.runtime;
    // fail-closed：运行时并发不可用 → Broker 构造失败（D-016）。
    this.#limiter = new ConcurrencyLimiter(this.#runtime);
    for (const adapter of asArray(options.adapters)) {
      if (this.#adapters.has(adapter.backendId)) {
        throw new TypeError(`duplicate adapter for backend: ${adapter.backendId}`);
      }
      this.#adapters.set(adapter.backendId, adapter);
    }
    this.#registry = options.registry ?? new SessionRegistry({ path: "var/sessions.json" });
    this.#ledger =
      options.ledger ??
      new IdempotencyLedger({ maxEntries: 4096, ...(options.clock === undefined ? {} : { clock: options.clock }) });
    this.#clock = options.clock ?? (() => new Date());
  }

  get limiter(): ConcurrencyLimiter {
    return this.#limiter;
  }

  get registry(): SessionRegistry {
    return this.#registry;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    await this.#registry.load();
    this.#loaded = true;
  }

  #adapterOf(backend: BackendId): BackendAdapter {
    const adapter = this.#adapters.get(backend);
    if (adapter === undefined) {
      throw moclError("capability.missing", {
        message: `backend not registered: ${backend}`,
        details: { kind: "capability.missing" },
      });
    }
    return adapter;
  }

  #runtimeOf(sessionId: string): SessionRuntime {
    const runtime = this.#sessions.get(sessionId);
    if (runtime === undefined) {
      throw moclError("session.not-found", { message: `active session not found: ${sessionId}` });
    }
    return runtime;
  }

  /** 建会话（ABI M2）。并发槽位在 open 时获取、close 时释放。 */
  async open(params: OpenParams): Promise<OpenResult> {
    await this.#ensureLoaded();
    const adapter = this.#adapterOf(params.backend);
    const method = "session.create";
    const requestHash = hashRequest({ backend: params.backend, cwd: params.cwd, model: params.model ?? null });
    const key = params.idempotencyKey === undefined ? undefined : ledgerKey("broker", method, params.idempotencyKey);
    if (key !== undefined) {
      this.#ledger.assertCompatible(key, requestHash);
      const hit = this.#ledger.lookup<OpenResult>(key, requestHash);
      if (hit.kind === "hit") return { ...hit.entry.result, deduplicated: true };
    }

    const sessionId = params.childId ?? newSessionId();
    if (this.#sessions.has(sessionId) || this.#registry.get(sessionId) !== undefined) {
      throw moclError("session.conflict", { message: `session already exists: ${sessionId}` });
    }

    const releaseSlot = this.#limiter.acquireOrThrow();
    try {
      const opened = await adapter.open({
        sessionId,
        cwd: params.cwd,
        model: params.model ?? null,
        permissionProfile: params.permissionProfile ?? "read-only",
        epoch: 1,
      });
      const capabilities = opened.capabilities;
      const record: SessionRecord = {
        childId: sessionId,
        backend: params.backend,
        remoteSessionId: opened.remoteSessionId,
        cwd: params.cwd,
        model: params.model ?? null,
        createdAt: this.#clock().toISOString(),
        epoch: 1,
        // W1（issue #18）：任务摘要与握手摘录为可选字段——缺省不写字段，旧记录/旧调用方兼容。
        ...(params.label === undefined ? {} : { label: params.label }),
        ...(capabilities === undefined
          ? {}
          : {
              handshake: {
                backendVersion: capabilities.backendVersion,
                transport: capabilities.transport,
              } satisfies SessionHandshake,
            }),
      };
      await this.#registry.upsert(record);
      this.#sessions.set(sessionId, {
        record,
        adapter,
        state: "created",
        terminalReason: null,
        lastTurnId: null,
        releaseSlot,
      });
      const result: OpenResult = {
        sessionId,
        backend: params.backend,
        backendSessionId: opened.remoteSessionId,
        epoch: record.epoch,
        state: "created",
        deduplicated: false,
      };
      if (key !== undefined) this.#ledger.commit(key, requestHash, result);
      return result;
    } catch (error) {
      releaseSlot();
      throw error;
    }
  }

  /** 发一轮（ABI M3）：同 `idempotencyKey` 命中直接返回既有结果，不调用适配器。 */
  async send(sessionId: string, params: SendParams): Promise<SendResult> {
    await this.#ensureLoaded();
    const runtime = this.#runtimeOf(sessionId);
    const method = "session.send";
    const requestHash = hashRequest({ input: params.input, expect: params.expect ?? "turn" });
    const key = ledgerKey(sessionId, method, params.idempotencyKey);
    this.#ledger.assertCompatible(key, requestHash);
    const hit = this.#ledger.lookup<SendResult>(key, requestHash);
    if (hit.kind === "hit") return { ...hit.entry.result, deduplicated: true };

    if (runtime.state === "completed" || runtime.state === "aborted" || runtime.state === "archived") {
      throw moclError("session.conflict", { message: `session is terminal: ${runtime.state}` });
    }
    const sent = await runtime.adapter.send({
      sessionId,
      remoteSessionId: runtime.record.remoteSessionId,
      input: params.input,
      idempotencyKey: params.idempotencyKey,
    });
    runtime.lastTurnId = sent.turnId;
    runtime.state = "running";
    const result: SendResult = {
      sessionId,
      turnId: sent.turnId,
      state: runtime.state,
      deduplicated: false,
    };
    this.#ledger.commit(key, requestHash, result);
    return result;
  }

  /**
   * 续接（ABI M4）：**顺序固定**——registry → 远端探测 → 不存在则 `session.not-found`/reseed。
   */
  async resume(sessionId: string, params: ResumeParams): Promise<ResumeResult> {
    await this.#ensureLoaded();
    const record = this.#registry.get(sessionId);
    if (record === undefined) {
      throw moclError("session.not-found", { message: `session not found in registry: ${sessionId}` });
    }
    const method = "session.resume";
    const requestHash = hashRequest({ model: params.model ?? record.model, fallback: params.fallback ?? "none" });
    const key = ledgerKey(sessionId, method, params.idempotencyKey);
    this.#ledger.assertCompatible(key, requestHash);
    const hit = this.#ledger.lookup<ResumeResult>(key, requestHash);
    if (hit.kind === "hit") return { ...hit.entry.result, deduplicated: true };

    const adapter = this.#adapterOf(record.backend);
    const probe = await adapter.resume({ sessionId, remoteSessionId: record.remoteSessionId, fromSeq: 0 });
    if (!probe.exists) {
      if ((params.fallback ?? "none") !== "reseed") {
        throw moclError("session.not-found", {
          message: `remote session no longer exists: ${record.remoteSessionId}`,
          details: { kind: "session.not-found", backendCode: probe.reason ?? "not-found" },
        });
      }
      const reopened = await adapter.open({
        sessionId,
        cwd: record.cwd,
        model: params.model ?? record.model,
        permissionProfile: "read-only",
        epoch: record.epoch + 1,
      });
      const next: SessionRecord = { ...record, remoteSessionId: reopened.remoteSessionId, epoch: record.epoch + 1 };
      await this.#registry.upsert(next);
      this.#sessions.set(sessionId, {
        record: next,
        adapter,
        state: "created",
        terminalReason: null,
        lastTurnId: null,
        releaseSlot: () => undefined,
      });
      const result: ResumeResult = {
        sessionId,
        strategy: "reseed",
        backendSessionId: reopened.remoteSessionId,
        epoch: next.epoch,
        degraded: true,
        deduplicated: false,
      };
      this.#ledger.commit(key, requestHash, result);
      return result;
    }

    const result: ResumeResult = {
      sessionId,
      strategy: "resume",
      backendSessionId: probe.remoteSessionId ?? record.remoteSessionId,
      epoch: record.epoch,
      degraded: false,
      deduplicated: false,
    };
    this.#ledger.commit(key, requestHash, result);
    return result;
  }

  /**
   * 冷恢复（ABI M8 的 C2 版）：只读探测远端 → epoch+1 → 不重放已终态轮次。
   * @returns `recovered=false` 表示远端不存在且未配置 reseed（调用方按 P0 处理）。
   */
  async recover(sessionId: string, params: RecoverParams = {}): Promise<RecoverResult> {
    await this.#ensureLoaded();
    const record = this.#registry.get(sessionId);
    if (record === undefined) {
      throw moclError("session.not-found", { message: `session not found in registry: ${sessionId}` });
    }
    const method = "session.recover";
    const idempotencyKey = params.idempotencyKey;
    const requestHash = hashRequest({ fallback: params.fallback ?? "none" });
    const key = idempotencyKey === undefined ? undefined : ledgerKey(sessionId, method, idempotencyKey);
    if (key !== undefined) {
      this.#ledger.assertCompatible(key, requestHash);
      const hit = this.#ledger.lookup<RecoverResult>(key, requestHash);
      if (hit.kind === "hit") return { ...hit.entry.result, deduplicated: true };
    }

    const adapter = this.#adapterOf(record.backend);
    const probe = await adapter.resume({ sessionId, remoteSessionId: record.remoteSessionId, fromSeq: 0 });
    if (!probe.exists) {
      if ((params.fallback ?? "none") !== "reseed") {
        const result: RecoverResult = {
          sessionId,
          recovered: false,
          strategy: "aborted",
          epoch: record.epoch,
          replayedEvents: 0,
          deduplicated: false,
        };
        if (key !== undefined) this.#ledger.commit(key, requestHash, result);
        return result;
      }
      const reopened = await adapter.open({
        sessionId,
        cwd: record.cwd,
        model: record.model,
        permissionProfile: "read-only",
        epoch: record.epoch + 1,
      });
      const next: SessionRecord = { ...record, remoteSessionId: reopened.remoteSessionId, epoch: record.epoch + 1 };
      await this.#registry.upsert(next);
      const result: RecoverResult = {
        sessionId,
        recovered: true,
        strategy: "reseed",
        epoch: next.epoch,
        replayedEvents: 0,
        deduplicated: false,
      };
      if (key !== undefined) this.#ledger.commit(key, requestHash, result);
      return result;
    }

    // fencing：先持久化 epoch 再改内存态（02-state-machine INV-L2-2）
    const bumped = await this.#registry.bumpEpoch(sessionId, record.epoch + 1);
    const existing = this.#sessions.get(sessionId);
    if (existing === undefined) {
      this.#sessions.set(sessionId, {
        record: bumped,
        adapter,
        state: "running",
        terminalReason: null,
        lastTurnId: null,
        releaseSlot: () => undefined,
      });
    } else {
      existing.record = bumped;
      existing.state = "running";
    }
    const result: RecoverResult = {
      sessionId,
      recovered: true,
      strategy: "resume",
      epoch: bumped.epoch,
      replayedEvents: 0, // C2 无事件重放；C3/C4 接 bus 后按 seq 补齐
      deduplicated: false,
    };
    if (key !== undefined) this.#ledger.commit(key, requestHash, result);
    return result;
  }

  /** 中断当前轮（ABI M5）：外部一次性执行时等价「永久停止」。 */
  async interrupt(sessionId: string, turnId?: string): Promise<void> {
    await this.#ensureLoaded();
    const runtime = this.#runtimeOf(sessionId);
    await runtime.adapter.interrupt({
      sessionId,
      remoteSessionId: runtime.record.remoteSessionId,
      ...(turnId === undefined ? {} : { turnId }),
    });
    runtime.state = "aborted";
    runtime.terminalReason = "interrupted";
  }

  /** 关闭（ABI M9）：幂等；释放并发槽位。 */
  async close(sessionId: string, reason: "completed" | "failed" | "cancelled" | "operator" = "operator"): Promise<void> {
    await this.#ensureLoaded();
    const runtime = this.#sessions.get(sessionId);
    if (runtime === undefined) {
      // 已关闭/未激活：幂等空操作（但会话必须存在于注册表）。
      if (this.#registry.get(sessionId) === undefined) {
        throw moclError("session.not-found", { message: `session not found: ${sessionId}` });
      }
      return;
    }
    await runtime.adapter.close({ sessionId, remoteSessionId: runtime.record.remoteSessionId, reason });
    runtime.state = "completed";
    runtime.terminalReason = reason === "completed" ? "delivered" : "operator";
    runtime.releaseSlot();
    this.#sessions.delete(sessionId);
  }

  /** 列举（ABI M7）：注册表为准（含未激活/冷会话）。 */
  async list(filter: { backend?: BackendId; state?: SessionState } = {}): Promise<readonly SessionStatus[]> {
    await this.#ensureLoaded();
    const out: SessionStatus[] = [];
    for (const record of this.#registry.list()) {
      if (filter.backend !== undefined && record.backend !== filter.backend) continue;
      const runtime = this.#sessions.get(record.childId);
      const state = runtime?.state ?? "lost";
      if (filter.state !== undefined && state !== filter.state) continue;
      out.push(this.#statusOf(record, runtime));
    }
    return out;
  }

  /** 查单会话（ABI M6）。 */
  async status(sessionId: string): Promise<SessionStatus> {
    await this.#ensureLoaded();
    const record = this.#registry.get(sessionId);
    if (record === undefined) {
      throw moclError("session.not-found", { message: `session not found: ${sessionId}` });
    }
    return this.#statusOf(record, this.#sessions.get(sessionId));
  }

  #statusOf(record: SessionRecord, runtime: SessionRuntime | undefined): SessionStatus {
    return {
      sessionId: record.childId,
      backend: record.backend,
      backendSessionId: record.remoteSessionId,
      cwd: record.cwd,
      model: record.model,
      state: runtime?.state ?? "lost",
      epoch: record.epoch,
      createdAt: record.createdAt,
      lastTurnId: runtime?.lastTurnId ?? null,
      active: runtime !== undefined,
    };
  }
}

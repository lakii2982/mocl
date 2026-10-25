/**
 * Broker 测试假件（C2）：假后端适配器 + 运行时 provider + 临时 registry。
 *
 * 纪律：假件只用于验证 Broker 的控制面语义（幂等/探测/epoch/并发），不模拟任何真实后端协议。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterCloseRequest,
  AdapterEvent,
  AdapterInterruptRequest,
  AdapterOpenRequest,
  AdapterOpenResult,
  AdapterResumeRequest,
  AdapterResumeResult,
  AdapterSendRequest,
  AdapterSendResult,
  BackendAdapter,
} from "../../src/abi/adapter.ts";
import { CAPABILITY_BITS, type CapabilityDeclaration } from "../../src/abi/index.ts";
import type { BackendId } from "../../src/abi/types.ts";
import type { RuntimeConfigProvider, RuntimeSnapshot } from "../../src/broker/concurrency.ts";
import { SessionRegistry } from "../../src/broker/session-registry.ts";

/** 固定运行时并发（测试里显式传值；生产实现从 DSH seam 读取）。 */
export function fixedRuntime(capacity: number): RuntimeConfigProvider {
  return { read: (): RuntimeSnapshot => ({ maxActiveSubagents: capacity }) };
}

/** 可变的运行时 provider（验证 D-016「每次读取运行时值」）。 */
export class MutableRuntime implements RuntimeConfigProvider {
  #capacity: number;
  constructor(initial: number) {
    this.#capacity = initial;
  }
  read(): RuntimeSnapshot {
    return { maxActiveSubagents: this.#capacity };
  }
  set(capacity: number): void {
    this.#capacity = capacity;
  }
}

export function capabilitiesOf(backendId: BackendId): CapabilityDeclaration {
  return {
    abiVersion: "0.1",
    backendId,
    backendVersion: "test-0",
    transport: "app-server-jsonrpc",
    bits: CAPABILITY_BITS.map((bit) => ({ bit, state: "native" as const })),
    limits: {
      maxTurnMs: 1_800_000,
      idleTimeoutMs: 180_000,
      maxSessionsPerBackend: 8,
      maxNestingDepth: 2,
      maxConcurrentTurns: 2,
    },
    warnings: [],
    observedAt: "2026-10-26T00:00:00.000Z",
  };
}

/** 假后端：可 kill（模拟进程死，但远端会话仍持久化）。 */
export class FakeAdapter implements BackendAdapter {
  readonly backendId: BackendId;
  readonly capabilities: CapabilityDeclaration;
  killed = false;
  remoteExists = true;
  openCalls = 0;
  sendCalls = 0;
  resumeCalls = 0;
  interruptCalls = 0;
  closeCalls = 0;
  readonly turns: string[] = [];
  #remoteSeq = 0;

  constructor(backendId: BackendId = "codex") {
    this.backendId = backendId;
    this.capabilities = capabilitiesOf(backendId);
  }

  async open(_request: AdapterOpenRequest): Promise<AdapterOpenResult> {
    this.openCalls += 1;
    this.killed = false;
    this.remoteExists = true;
    this.#remoteSeq += 1;
    return { remoteSessionId: `remote_${this.backendId}_${this.#remoteSeq}` };
  }

  async send(_request: AdapterSendRequest): Promise<AdapterSendResult> {
    if (this.killed) {
      const error = new Error("fake backend process is dead");
      (error as Error & { code?: string }).code = "process.crashed";
      throw error;
    }
    this.sendCalls += 1;
    const turnId = `turn_${this.backendId}_${this.sendCalls}`;
    this.turns.push(turnId);
    return { turnId };
  }

  async resume(_request: AdapterResumeRequest): Promise<AdapterResumeResult> {
    this.resumeCalls += 1;
    if (!this.remoteExists) return { exists: false, reason: "not-found" };
    // 冷恢复：远端会话仍在 → 新进程可续接（模拟 app-server 重启后 thread/resume 成功）。
    this.killed = false;
    return { exists: true, remoteSessionId: `remote_${this.backendId}_${this.#remoteSeq}` };
  }

  async interrupt(_request: AdapterInterruptRequest): Promise<void> {
    this.interruptCalls += 1;
  }

  async close(_request: AdapterCloseRequest): Promise<void> {
    this.closeCalls += 1;
  }

  // eslint-disable-next-line require-yield
  async *events(): AsyncIterable<AdapterEvent> {
    // C2 不消费事件流；C4 在真实适配器上实现。
  }

  kill(): void {
    this.killed = true;
  }

  deleteRemote(): void {
    this.remoteExists = false;
  }
}

/** 临时 registry（每个测试独立目录；测试后清理）。 */
export async function makeRegistry(): Promise<{ registry: SessionRegistry; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mocl-c2-"));
  const registry = new SessionRegistry({ path: join(dir, "sessions.json") });
  return {
    registry,
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 标准 Broker 测试装配（临时 registry + 单个假后端 + 固定运行时并发）。 */
export async function makeBroker(
  capacity: number,
  adapter: FakeAdapter = new FakeAdapter(),
): Promise<{
  broker: import("../../src/broker/broker.ts").Broker;
  adapter: FakeAdapter;
  registry: SessionRegistry;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const { Broker } = await import("../../src/broker/broker.ts");
  const { registry, dir, cleanup } = await makeRegistry();
  const broker = new Broker({
    runtime: fixedRuntime(capacity),
    adapters: [adapter],
    registry,
  });
  return { broker, adapter, registry, dir, cleanup };
}

/**
 * 门面测试假件（C8）：四后端假适配器 + 配置工厂 + 临时 registry。
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
import type { RuntimeConfigProvider } from "../../src/broker/concurrency.ts";
import { MoclFacade, type FacadeOptions } from "../../src/facade/facade.ts";
import { validateConfig, type ConfigBackendId, type FacadeConfig } from "../../src/facade/config.ts";

export function fixedRuntime(capacity: number): RuntimeConfigProvider {
  return { read: () => ({ maxActiveSubagents: capacity }) };
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

/** 可编排行为的假后端（零额度）。 */
export class FakeAdapter implements BackendAdapter {
  readonly backendId: BackendId;
  readonly capabilities: CapabilityDeclaration;
  openCalls = 0;
  sendCalls = 0;
  resumeCalls = 0;
  interruptCalls = 0;
  closeCalls = 0;
  readonly openRequests: AdapterOpenRequest[] = [];
  readonly sendRequests: AdapterSendRequest[] = [];
  remoteId: string;
  remoteExists = true;
  failSend: Error | null = null;
  failOpen: Error | null = null;
  #remoteSeq = 0;

  constructor(backendId: BackendId, options: { remoteId?: string } = {}) {
    this.backendId = backendId;
    this.capabilities = capabilitiesOf(backendId);
    this.remoteId = options.remoteId ?? `remote_${backendId}`;
  }

  async open(request: AdapterOpenRequest): Promise<AdapterOpenResult> {
    this.openCalls += 1;
    this.openRequests.push(request);
    if (this.failOpen !== null) throw this.failOpen;
    this.#remoteSeq += 1;
    return { remoteSessionId: this.remoteId };
  }

  async send(request: AdapterSendRequest): Promise<AdapterSendResult> {
    this.sendCalls += 1;
    this.sendRequests.push(request);
    if (this.failSend !== null) throw this.failSend;
    return { turnId: `turn_${this.backendId}_${this.sendCalls}` };
  }

  async resume(_request: AdapterResumeRequest): Promise<AdapterResumeResult> {
    this.resumeCalls += 1;
    if (!this.remoteExists) return { exists: false, reason: "not-found" };
    return { exists: true, remoteSessionId: this.remoteId };
  }

  async interrupt(_request: AdapterInterruptRequest): Promise<void> {
    this.interruptCalls += 1;
  }

  async close(_request: AdapterCloseRequest): Promise<void> {
    this.closeCalls += 1;
  }

  // eslint-disable-next-line require-yield
  async *events(): AsyncIterable<AdapterEvent> {
    // C8 门面不消费事件流（C9 接 bus）。
  }
}

export interface FacadeFixture {
  readonly facade: MoclFacade;
  readonly config: FacadeConfig;
  readonly adapters: Partial<Record<ConfigBackendId, FakeAdapter>>;
  readonly dir: string;
  cleanup(): Promise<void>;
}

/** 生成「开启全局 + 指定后端」的最小合法配置。 */
export function enabledConfig(overrides: {
  enabled?: readonly ConfigBackendId[];
  global?: Record<string, unknown>;
  backends?: Partial<Record<ConfigBackendId, Record<string, unknown>>>;
} = {}): FacadeConfig {
  const enabled = new Set(overrides.enabled ?? []);
  const backends: Record<string, unknown> = {};
  for (const id of ["codex", "kimi", "claude-code", "opencode"] as const) {
    backends[id] = {
      enabled: enabled.has(id),
      ...(overrides.backends?.[id] ?? {}),
    };
  }
  return validateConfig({
    global: { enabled: true, ...(overrides.global ?? {}) },
    backends,
  });
}

/** 装配一个注入假适配器的门面。 */
export async function makeFacade(options: {
  config?: FacadeConfig;
  runtime?: RuntimeConfigProvider;
  adapters?: Partial<Record<ConfigBackendId, FakeAdapter>>;
  registryPath?: string;
  clock?: () => Date;
} = {}): Promise<FacadeFixture> {
  const dir = await mkdtemp(join(tmpdir(), "mocl-c8-"));
  const config = options.config ?? enabledConfig({ enabled: ["codex"] });
  const adapters = options.adapters ?? { codex: new FakeAdapter("codex") };
  const facadeOptions: FacadeOptions = {
    config,
    runtime: options.runtime ?? fixedRuntime(4),
    adapters,
    registryPath: options.registryPath ?? join(dir, "sessions.json"),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const facade = await MoclFacade.create(facadeOptions);
  return {
    facade,
    config,
    adapters,
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

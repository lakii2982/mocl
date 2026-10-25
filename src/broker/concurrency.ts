/**
 * 并发闸门（D-016：**一律运行时派生**，禁止任何硬编码并发常量）。
 *
 * 设计约束（评审验收）：
 * - 容量只来自注入的 `RuntimeConfigProvider.read().maxActiveSubagents`；
 * - provider 缺失、读取抛错、值非法（非正安全整数）→ **构造即 fail-closed**（抛错，不猜默认）；
 * - 每次获取槽位都重读运行时值（配置热改/DSH 设置变化后无需重建 limiter）；
 * - 本文件不出现任何数字型并发默认值。
 */
import { moclError } from "./errors.ts";

/** 运行时配置快照（当前只需要并发容量；后续切片可扩展）。 */
export interface RuntimeSnapshot {
  readonly maxActiveSubagents: number;
}

/** 注入接口：实现方从 DSH `subagent.maxActiveSubagents` / Host 设置读取（不得返回常量）。 */
export interface RuntimeConfigProvider {
  read(): RuntimeSnapshot;
}

/** 运行时配置不可用/非法：fail-closed，不降级为默认容量。 */
export class RuntimeConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RuntimeConfigError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

function assertRuntimeValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeConfigError(
      `runtime.maxActiveSubagents must be a positive safe integer, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * 运行时派生的并发限制器。
 *
 * 用法：
 * ```ts
 * const limiter = new ConcurrencyLimiter(runtimeProvider); // provider 不可用时这里就抛
 * const release = limiter.acquireOrThrow();                // 满则抛 limit.concurrency-exceeded
 * release();                                               // 幂等释放
 * ```
 */
export class ConcurrencyLimiter {
  readonly #provider: RuntimeConfigProvider;
  #active = 0;

  constructor(provider: RuntimeConfigProvider) {
    if (provider === null || provider === undefined || typeof provider.read !== "function") {
      throw new RuntimeConfigError("RuntimeConfigProvider is required (fail-closed)");
    }
    this.#provider = provider;
    // 构造即校验一次：运行值缺失/非法 → 直接失败，不进入半可用状态。
    this.#readCapacity();
  }

  #readCapacity(): number {
    let snapshot: RuntimeSnapshot;
    try {
      snapshot = this.#provider.read();
    } catch (cause) {
      throw new RuntimeConfigError("failed to read runtime.maxActiveSubagents (fail-closed)", { cause });
    }
    if (snapshot === null || typeof snapshot !== "object") {
      throw new RuntimeConfigError("runtime snapshot is not an object (fail-closed)");
    }
    return assertRuntimeValue(snapshot.maxActiveSubagents);
  }

  /** 当前运行时容量（每次读取；读取失败抛 RuntimeConfigError）。 */
  get capacity(): number {
    return this.#readCapacity();
  }

  /** 已占用槽数（只单调由 acquire/release 维护；可观测用）。 */
  get active(): number {
    return this.#active;
  }

  get available(): number {
    return Math.max(0, this.capacity - this.#active);
  }

  /**
   * 尝试获取一个并发槽。
   * @returns 释放函数（幂等）；容量已满时返回 `null`（由调用方决定排队/拒绝）。
   * @throws RuntimeConfigError 运行时容量读取失败（fail-closed）
   */
  tryAcquire(): (() => void) | null {
    const capacity = this.#readCapacity();
    if (this.#active >= capacity) return null;
    this.#active += 1;
    return this.#makeRelease();
  }

  /**
   * 获取槽位，满则抛 ABI `limit.concurrency-exceeded`（调用方可重试）。
   * @throws RuntimeConfigError 运行时容量读取失败（fail-closed）
   */
  acquireOrThrow(): () => void {
    const release = this.tryAcquire();
    if (release === null) {
      throw moclError("limit.concurrency-exceeded", {
        message: "concurrency limit reached (runtime-derived)",
      });
    }
    return release;
  }

  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active = Math.max(0, this.#active - 1);
    };
  }
}

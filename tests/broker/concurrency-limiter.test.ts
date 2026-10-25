import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter, RuntimeConfigError } from "../../src/broker/concurrency.ts";
import { MoclError } from "../../src/broker/errors.ts";
import { fixedRuntime, MutableRuntime } from "./helpers.ts";

describe("ConcurrencyLimiter（D-016：运行时派生）", () => {
  it("构造时读取 runtime.maxActiveSubagents 并暴露容量", () => {
    const limiter = new ConcurrencyLimiter(fixedRuntime(3));
    expect(limiter.capacity).toBe(3);
    expect(limiter.active).toBe(0);
    expect(limiter.available).toBe(3);
  });

  it("provider 缺失 → 构造即 fail-closed", () => {
    expect(() => new ConcurrencyLimiter(undefined as never)).toThrow(RuntimeConfigError);
    expect(() => new ConcurrencyLimiter(null as never)).toThrow(RuntimeConfigError);
    expect(() => new ConcurrencyLimiter({} as never)).toThrow(RuntimeConfigError);
  });

  it("读取失败 → 构造即 fail-closed（不猜默认）", () => {
    const throwing = {
      read: (): never => {
        throw new Error("seam unavailable");
      },
    };
    expect(() => new ConcurrencyLimiter(throwing)).toThrow(RuntimeConfigError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("非法运行值 %s → 构造即 fail-closed", (value) => {
    expect(() => new ConcurrencyLimiter(fixedRuntime(value))).toThrow(RuntimeConfigError);
  });

  it("槽位获取/释放；满载抛 ABI limit.concurrency-exceeded", () => {
    const limiter = new ConcurrencyLimiter(fixedRuntime(2));
    const release1 = limiter.acquireOrThrow();
    const release2 = limiter.acquireOrThrow();
    expect(limiter.active).toBe(2);
    expect(limiter.tryAcquire()).toBeNull();
    expect(() => limiter.acquireOrThrow()).toThrow(MoclError);
    try {
      limiter.acquireOrThrow();
    } catch (error) {
      expect((error as MoclError).code).toBe("limit.concurrency-exceeded");
    }
    release1();
    expect(limiter.active).toBe(1);
    const release3 = limiter.acquireOrThrow();
    release3();
    release2();
    expect(limiter.active).toBe(0);
  });

  it("释放函数幂等（重复 release 不减计数）", () => {
    const limiter = new ConcurrencyLimiter(fixedRuntime(1));
    const release = limiter.acquireOrThrow();
    release();
    release();
    expect(limiter.active).toBe(0);
  });

  it("每次获取都重读运行时值（配置热改即刻生效，不缓存旧容量）", () => {
    const runtime = new MutableRuntime(1);
    const limiter = new ConcurrencyLimiter(runtime);
    limiter.acquireOrThrow();
    expect(limiter.tryAcquire()).toBeNull();
    runtime.set(2);
    expect(limiter.capacity).toBe(2);
    const release = limiter.tryAcquire();
    expect(release).not.toBeNull();
    release?.();
  });

  it("源码不含硬编码并发常量（静态检查）", () => {
    const srcDir = join(process.cwd(), "src");
    for (const file of ["broker/concurrency.ts", "broker/broker.ts"]) {
      const text = readFileSync(join(srcDir, file), "utf8");
      expect(text).not.toMatch(/maxActiveSubagents\s*[:=]\s*\d/);
      expect(text).not.toMatch(/DEFAULT_MAX_CONCURRENT/);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  ERROR_CATEGORIES,
  ERROR_CATEGORY,
  ERROR_CODES,
  RETRYABILITIES,
  RETRYABLE,
  categoryOf,
  isErrorCode,
  isRetryable,
  retryabilityOf,
} from "../../src/abi/index.ts";

describe("错误码目录（ABI §8.2）", () => {
  it("错误码恰好 46 个且无重复", () => {
    expect(ERROR_CODES).toHaveLength(46);
    expect(new Set(ERROR_CODES).size).toBe(46);
  });

  it("分类恰好 12 类且每个错误码都有分类", () => {
    expect(ERROR_CATEGORIES).toHaveLength(12);
    for (const code of ERROR_CODES) {
      expect(ERROR_CATEGORIES).toContain(ERROR_CATEGORY[code]);
      expect(categoryOf(code)).toBe(ERROR_CATEGORY[code]);
    }
  });

  it("retryable 覆盖全部错误码且取值在 wire 四值内", () => {
    expect(Object.keys(RETRYABLE).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(RETRYABILITIES).toContain(RETRYABLE[code]);
      expect(retryabilityOf(code)).toBe(RETRYABLE[code]);
    }
  });

  it("backend.internal-error 归 internal 分类且可重试一次（唯一前缀≠分类例外）", () => {
    expect(categoryOf("backend.internal-error")).toBe("internal");
    expect(retryabilityOf("backend.internal-error")).toBe("once");
    expect(isRetryable("backend.internal-error")).toBe(true);
  });

  it("isRetryable 与 retryable 列一致（抽样）", () => {
    expect(isRetryable("quota.rate-limited")).toBe(true);
    expect(isRetryable("session.locked")).toBe(true);
    expect(isRetryable("internal.unexpected")).toBe(false);
    expect(isRetryable("auth.missing-credential")).toBe(false);
    expect(isRetryable("session.invalidated")).toBe(false);
  });

  it("isErrorCode 区分已知/未知码", () => {
    expect(isErrorCode("quota.rate-limited")).toBe(true);
    expect(isErrorCode("quota.rate-limit")).toBe(false);
  });
});

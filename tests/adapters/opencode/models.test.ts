import { describe, expect, it } from "vitest";
import { moclError } from "../../../src/broker/errors.ts";
import {
  FREE_FALLBACK_MARKER,
  FREE_FALLBACK_MODEL,
  FREE_MODELS,
  ModelPolicy,
  PRODUCTION_MODEL,
  classifyModel,
  formatModelRef,
  isCredentialExpired,
  isFallbackEligible,
  parseModelRef,
} from "../../../src/adapters/opencode/models.ts";

describe("opencode 模型分级与免费降级（D-019）", () => {
  it("parseModelRef/formatModelRef 支持 provider/model#variant", () => {
    expect(parseModelRef("opencode/deepseek-v4.1-flash-free")).toEqual({
      providerID: "opencode",
      id: "deepseek-v4.1-flash-free",
    });
    expect(parseModelRef("opencode-go/deepseek-v4.1-flash#high")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
      variant: "high",
    });
    expect(formatModelRef({ providerID: "opencode", id: "big-pickle" })).toBe("opencode/big-pickle");
    expect(() => parseModelRef("broken")).toThrow(/invalid model ref/);
  });

  it("分级：opencode/*-free 免费池；opencode-go/* 一律付费（名字带 -free 也算）", () => {
    expect(classifyModel("opencode/deepseek-v4.1-flash-free")).toBe("free");
    expect(classifyModel("opencode/big-pickle")).toBe("free");
    expect(classifyModel(PRODUCTION_MODEL)).toBe("paid");
    expect(classifyModel("opencode-go/iceman-contributor-free")).toBe("paid");
    expect(classifyModel("github-copilot/gpt-5")).toBe("other");
    expect(FREE_MODELS).toContain(FREE_FALLBACK_MODEL);
  });

  it("默认模型 = 生产模型（D-019 用户口径）", () => {
    const policy = new ModelPolicy();
    expect(policy.current).toBe(PRODUCTION_MODEL);
    expect(policy.degraded).toBe(false);
    expect(policy.snapshot().marker).toBeNull();
  });

  it("付费模型 401 → 显式降级到同系列免费模型并标 model=free-fallback", () => {
    const policy = new ModelPolicy(PRODUCTION_MODEL);
    const decision = policy.onCredentialExpired();
    expect(decision).toMatchObject({
      previousModel: PRODUCTION_MODEL,
      model: FREE_FALLBACK_MODEL,
      degraded: true,
      marker: FREE_FALLBACK_MARKER,
    });
    expect(decision?.warning).toMatchObject({ code: "model.free-fallback", degrade: true });
    expect(policy.current).toBe(FREE_FALLBACK_MODEL);
    expect(policy.degraded).toBe(true);
    expect(policy.snapshot().warnings).toContain(FREE_FALLBACK_MARKER);
    // 幂等：再次降级不重复加 warning
    expect(policy.onCredentialExpired()).toBeNull();
    expect(policy.snapshot().warnings.filter((item) => item === FREE_FALLBACK_MARKER)).toHaveLength(1);
  });

  it("已在免费池 → 无需降级（fallbackFor/onCredentialExpired 返回 null）", () => {
    const policy = new ModelPolicy(FREE_FALLBACK_MODEL);
    expect(policy.fallbackFor()).toBeNull();
    expect(policy.onCredentialExpired()).toBeNull();
    expect(policy.current).toBe(FREE_FALLBACK_MODEL);
    expect(policy.degraded).toBe(false);
  });

  it("override 可显式切换模型（调用方指定优先）", () => {
    const policy = new ModelPolicy(PRODUCTION_MODEL);
    policy.override("opencode/glm-5.3-flash-free");
    expect(policy.current).toBe("opencode/glm-5.3-flash-free");
    policy.override(null);
    expect(policy.current).toBe("opencode/glm-5.3-flash-free");
  });

  it("凭据失败判定：MoclError / raw provider 401 / ACP -32000", () => {
    expect(isCredentialExpired(moclError("auth.credential-expired"))).toBe(true);
    expect(
      isCredentialExpired({ status: 401, error: { type: "provider.auth", code: "api_key_expired" } }),
    ).toBe(true);
    expect(isCredentialExpired(moclError("quota.rate-limited"))).toBe(false);
    expect(isFallbackEligible(moclError("auth.missing-credential"))).toBe(true);
    expect(isFallbackEligible({ code: -32000 })).toBe(true);
    expect(isFallbackEligible(moclError("protocol.invalid-params"))).toBe(false);
  });

  it("markDegraded 可直接标记（预检已知 key 过期时避免一次失败轮）", () => {
    const policy = new ModelPolicy(PRODUCTION_MODEL);
    const snapshot = policy.markDegraded();
    expect(snapshot).toMatchObject({ model: FREE_FALLBACK_MODEL, degraded: true, marker: FREE_FALLBACK_MARKER });
  });
});

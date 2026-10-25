import { describe, expect, it } from "vitest";
import {
  CAPABILITY_BITS,
  CAPABILITY_GROUP_A,
  CAPABILITY_GROUP_B,
  CAPABILITY_STATES,
  degradedCapabilities,
  isCapabilityBit,
  missingCapabilities,
  supportsAll,
  toCapabilitySet,
} from "../../src/abi/index.ts";

describe("能力位目录（ABI §3.2）", () => {
  it("恰好 34 位、A 组 15 + B 组 19、无重复", () => {
    expect(CAPABILITY_BITS).toHaveLength(34);
    expect(new Set(CAPABILITY_BITS).size).toBe(34);
    expect(CAPABILITY_GROUP_A).toHaveLength(15);
    expect(CAPABILITY_GROUP_B).toHaveLength(19);
    expect([...CAPABILITY_GROUP_A, ...CAPABILITY_GROUP_B]).toEqual([...CAPABILITY_BITS]);
  });

  it("能力状态只有 native/emulated/unavailable 三值", () => {
    expect(CAPABILITY_STATES).toEqual(["native", "emulated", "unavailable"]);
  });

  it("toCapabilitySet 把数组转成可查询集合（同 bit 后到覆盖）", () => {
    const set = toCapabilitySet([
      { bit: "resumeSession", state: "unavailable" },
      { bit: "resumeSession", state: "native" },
      { bit: "streaming", state: "emulated" },
    ]);
    expect(set["resumeSession"]).toBe("native");
    expect(set["streaming"]).toBe("emulated");
  });

  it("missingCapabilities：缺失与 unavailable 计入，emulated 不计入", () => {
    const actual = toCapabilitySet([
      { bit: "resumeSession", state: "unavailable" },
      { bit: "streaming", state: "emulated" },
      { bit: "headless", state: "native" },
    ]);
    const missing = missingCapabilities(
      ["headless", "streaming", "resumeSession", "interruptTurn"],
      actual,
    );
    expect(missing).toEqual(["resumeSession", "interruptTurn"]);
  });

  it("degradedCapabilities 只返回 emulated 项，且 supportsAll 视其为可用", () => {
    const actual = toCapabilitySet([
      { bit: "streaming", state: "emulated" },
      { bit: "headless", state: "native" },
    ]);
    expect(degradedCapabilities(["headless", "streaming"], actual)).toEqual(["streaming"]);
    expect(supportsAll(["headless", "streaming"], actual)).toBe(true);
    expect(supportsAll(["headless", "resumeSession"], actual)).toBe(false);
  });

  it("isCapabilityBit 区分已知/未知位名", () => {
    expect(isCapabilityBit("resumeSession")).toBe(true);
    expect(isCapabilityBit("canResume")).toBe(false);
  });
});

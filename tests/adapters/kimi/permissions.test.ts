import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_MODE_BY_PROFILE,
  CLI_FLAG_SEMANTICS,
  PROFILE_BY_ACP_MODE,
  answerPermissionRequest,
  assertNoPromptModeFlags,
  assertSemanticMapping,
  classifyRisk,
  cliFallbackAllowed,
  cliFlagForProfile,
  readKimiConfigProbe,
} from "../../../src/adapters/kimi/permissions.ts";

describe("D-004 权限语义映射（名字≠语义）", () => {
  it("自检通过：映射表与命名错位事实一致", () => {
    expect(() => assertSemanticMapping()).not.toThrow();
  });

  it("ABI 三档 → ACP mode（read-only=plan / safe-auto=auto / yolo=yolo）", () => {
    expect(ACP_MODE_BY_PROFILE["read-only"]).toBe("plan");
    expect(ACP_MODE_BY_PROFILE["safe-auto"]).toBe("auto");
    expect(ACP_MODE_BY_PROFILE.yolo).toBe("yolo");
  });

  it("CLI `-y/--yolo` 的语义是 Ask-When-Needed ≈ ACP auto，**不是** yolo", () => {
    const yoloFlag = CLI_FLAG_SEMANTICS.find((item) => item.flag.startsWith("-y"));
    expect(yoloFlag?.semantics).toBe("ask-when-needed");
    expect(yoloFlag?.acpMode).toBe("auto");
    expect(yoloFlag?.acpMode).not.toBe("yolo");
  });

  it("CLI `--auto` 的语义是 Never-Ask ≈ ACP yolo", () => {
    const autoFlag = CLI_FLAG_SEMANTICS.find((item) => item.flag === "--auto");
    expect(autoFlag?.semantics).toBe("never-ask");
    expect(autoFlag?.acpMode).toBe("yolo");
  });

  it("反查表与正向表一致（无环、无重名）", () => {
    for (const profile of ["read-only", "safe-auto", "yolo"] as const) {
      expect(PROFILE_BY_ACP_MODE[ACP_MODE_BY_PROFILE[profile]]).toBe(profile);
    }
  });

  it("cliFlagForProfile 给出名称即可，但**不得**被用于 -p（互斥）", () => {
    expect(cliFlagForProfile("read-only")).toBe("--plan");
    expect(cliFlagForProfile("safe-auto")).toBe("-y");
    expect(cliFlagForProfile("yolo")).toBe("--auto");
  });

  it("assertNoPromptModeFlags 拦住 -y/--yolo/--auto/--plan", () => {
    expect(() => assertNoPromptModeFlags(["-p", "hi", "--output-format", "stream-json"])).not.toThrow();
    for (const flag of ["-y", "--yolo", "--auto", "--plan"]) {
      expect(() => assertNoPromptModeFlags(["-p", "hi", flag])).toThrowError(/cannot be combined/);
    }
  });
});

describe("风险分级（§7.2）", () => {
  it("按 title/kind 分级：read / write / execute / network / unknown", () => {
    expect(classifyRisk("Read", "read")).toBe("read");
    expect(classifyRisk("Grep")).toBe("read");
    expect(classifyRisk("Glob")).toBe("read");
    expect(classifyRisk("Write", "other")).toBe("write");
    expect(classifyRisk("Edit")).toBe("write");
    expect(classifyRisk("Bash", "other")).toBe("execute");
    expect(classifyRisk("webfetch")).toBe("network");
    expect(classifyRisk("Skill", "other")).toBe("read");
    expect(classifyRisk("SomethingNew")).toBe("unknown");
  });
});

describe("session/request_permission 自动应答（K5）", () => {
  const kimiOptions = [
    { optionId: "approve_once", kind: "allow_once" },
    { optionId: "approve_always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ];

  it("read-only 档：Write 请求一律 deny（默认安全档）", () => {
    const answer = answerPermissionRequest(kimiOptions, "read-only", "write");
    expect(answer.decision).toBe("deny");
    expect(answer.optionId).toBe("reject");
    expect(answer.escalationRequired).toBe(false);
  });

  it("safe-auto 档：read/write 放行**一次**，不持久放行", () => {
    expect(answerPermissionRequest(kimiOptions, "safe-auto", "read")).toMatchObject({
      optionId: "approve_once",
      decision: "allow-once",
    });
    expect(answerPermissionRequest(kimiOptions, "safe-auto", "write")).toMatchObject({ decision: "allow-once" });
  });

  it("safe-auto 档：execute/network 仍 deny", () => {
    expect(answerPermissionRequest(kimiOptions, "safe-auto", "execute").decision).toBe("deny");
    expect(answerPermissionRequest(kimiOptions, "safe-auto", "network").decision).toBe("deny");
  });

  it("yolo 档：优先 allow_always；execute 也放行", () => {
    expect(answerPermissionRequest(kimiOptions, "yolo", "execute")).toMatchObject({
      optionId: "approve_always",
      decision: "allow-always",
    });
  });

  it("按 kind 匹配而非 optionId 字面（id 随版本变也安全）", () => {
    const renamed = [
      { optionId: "v2-allow-once", kind: "allow_once" },
      { optionId: "v2-deny", kind: "reject_once" },
    ];
    expect(answerPermissionRequest(renamed, "safe-auto", "read")).toMatchObject({ optionId: "v2-allow-once" });
    expect(answerPermissionRequest(renamed, "read-only", "read")).toMatchObject({ optionId: "v2-deny" });
  });

  it("放行档位但无 allow option → deny + escalationRequired", () => {
    const onlyReject = [{ optionId: "reject", kind: "reject_once" }];
    expect(answerPermissionRequest(onlyReject, "yolo", "read")).toMatchObject({
      decision: "deny",
      escalationRequired: true,
    });
  });

  it("请求里连 reject 都没有 → optionId 为空（调用方回 null，仍会回包不挂死）", () => {
    expect(answerPermissionRequest([], "read-only", "read").optionId).toBe("");
  });
});

describe("config.toml 只读探测（§7.5）", () => {
  it("只解析三个非敏感键，绝不泄露 api_key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mocl-c6-cfg-"));
    try {
      const path = join(dir, "config.toml");
      await writeFile(
        path,
        [
          'default_model = "kimi-code/k3.1-pro"',
          'default_permission_mode = "auto"',
          "default_plan_mode = true",
          "",
          '[providers."managed:kimi-code"]',
          'api_key = "sk-SHOULD-NEVER-APPEAR"',
          "",
        ].join("\n"),
        "utf8",
      );
      const probe = readKimiConfigProbe(path);
      expect(probe).toEqual({
        defaultModel: "kimi-code/k3.1-pro",
        defaultPermissionMode: "auto",
        defaultPlanMode: true,
        readable: true,
      });
      expect(JSON.stringify(probe)).not.toContain("sk-SHOULD");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("文件不可读 → readable:false（fail-closed 依据）", () => {
    const probe = readKimiConfigProbe("/nonexistent/config.toml");
    expect(probe.readable).toBe(false);
    expect(probe.defaultPermissionMode).toBeNull();
  });

  it("缺 default_permission_mode → 值保持 null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mocl-c6-cfg2-"));
    try {
      const path = join(dir, "config.toml");
      await writeFile(path, 'default_model = "x/y"\n', "utf8");
      const probe = readKimiConfigProbe(path);
      expect(probe.defaultPermissionMode).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI 兜底档位判定（§7.5 fail-closed）", () => {
  const probe = (mode: string, readable = true) => ({
    defaultModel: "kimi-code/k3.1-pro",
    defaultPermissionMode: mode,
    defaultPlanMode: false,
    readable,
  });

  it("yolo 需要配置 yolo", () => {
    expect(cliFallbackAllowed("yolo", probe("yolo")).allowed).toBe(true);
    expect(cliFallbackAllowed("yolo", probe("auto")).allowed).toBe(false);
  });

  it("safe-auto 需要配置 auto（**不能**是 yolo）", () => {
    expect(cliFallbackAllowed("safe-auto", probe("auto")).allowed).toBe(true);
    expect(cliFallbackAllowed("safe-auto", probe("yolo")).allowed).toBe(false);
  });

  it("read-only 只接受 plan/default", () => {
    expect(cliFallbackAllowed("read-only", probe("plan")).allowed).toBe(true);
    expect(cliFallbackAllowed("read-only", probe("default")).allowed).toBe(true);
    expect(cliFallbackAllowed("read-only", probe("auto")).allowed).toBe(false);
    expect(cliFallbackAllowed("read-only", probe("yolo")).allowed).toBe(false);
  });

  it("配置不可读/键缺失/未知值 → 拒绝（带原因）", () => {
    expect(cliFallbackAllowed("safe-auto", probe("unknown")).allowed).toBe(false);
    expect(cliFallbackAllowed("safe-auto", probe("", true)).allowed).toBe(false);
    expect(cliFallbackAllowed("safe-auto", { ...probe("auto"), readable: false }).allowed).toBe(false);
    expect(cliFallbackAllowed("safe-auto", probe("yolo")).reason).toContain("default_permission_mode");
  });
});

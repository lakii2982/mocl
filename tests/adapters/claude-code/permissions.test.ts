import { describe, expect, it } from "vitest";
import {
  BASE_DISALLOWED_TOOLS,
  READ_ONLY_ALLOWED_TOOLS,
  allowedToolsFor,
  createCanUseTool,
  decideToolUse,
  disallowedToolsFor,
  permissionModeFor,
  riskOf,
  sanitizedEnv,
} from "../../../src/adapters/claude-code/permissions.ts";

describe("claude-code 权限映射（设计 §7.1）", () => {
  it("ABI 三档 → SDK 权限模式（只使用约定的 5 个模式）", () => {
    expect(permissionModeFor("read-only")).toBe("dontAsk");
    expect(permissionModeFor("safe-auto")).toBe("acceptEdits");
    expect(permissionModeFor("yolo")).toBe("bypassPermissions");
  });

  it("disallowedTools：始终禁 AskUserQuestion/ExitPlanMode；只读档再加写/执行/网络", () => {
    expect(disallowedToolsFor("safe-auto")).toEqual([...BASE_DISALLOWED_TOOLS]);
    const readOnly = disallowedToolsFor("read-only");
    expect(readOnly).toContain("AskUserQuestion");
    expect(readOnly).toContain("ExitPlanMode");
    expect(readOnly).toContain("Write");
    expect(readOnly).toContain("Bash");
    expect(readOnly).toContain("WebFetch");
    expect(allowedToolsFor("read-only")).toEqual(READ_ONLY_ALLOWED_TOOLS);
    expect(allowedToolsFor("safe-auto")).toBeUndefined();
  });

  it("工具风险分类覆盖 read/write/execute/network/unknown", () => {
    expect(riskOf("Read")).toBe("read");
    expect(riskOf("Write")).toBe("write");
    expect(riskOf("Bash")).toBe("execute");
    expect(riskOf("WebFetch")).toBe("network");
    expect(riskOf("SomeMcpTool")).toBe("unknown");
  });

  it("read-only：只放行只读工具，写/执行/网络/未知一律 deny", () => {
    const allow = decideToolUse({ profile: "read-only" }, "Read", {});
    expect(allow.decision).toBe("allow");
    for (const tool of ["Write", "Edit", "Bash", "WebFetch", "Unknown"]) {
      expect(decideToolUse({ profile: "read-only" }, tool, {}).decision).toBe("deny");
    }
  });

  it("safe-auto：允许读写，拒绝执行/网络/未知（需外部 worktree + 显式策略）", () => {
    expect(decideToolUse({ profile: "safe-auto" }, "Write", {}).decision).toBe("allow");
    expect(decideToolUse({ profile: "safe-auto" }, "Read", {}).decision).toBe("allow");
    expect(decideToolUse({ profile: "safe-auto" }, "Bash", {}).decision).toBe("deny");
    expect(decideToolUse({ profile: "safe-auto" }, "WebFetch", {}).decision).toBe("deny");
    expect(decideToolUse({ profile: "safe-auto" }, "Unknown", {}).decision).toBe("deny");
  });

  it("yolo：全部放行（但需外部 worktree 隔离，属调用方责任）", () => {
    expect(decideToolUse({ profile: "yolo" }, "Bash", {}).decision).toBe("allow");
    expect(decideToolUse({ profile: "yolo" }, "Unknown", {}).decision).toBe("allow");
  });

  it("blockedPath/aborted 在非 yolo 档 deny；extra allowedTools 生效", () => {
    expect(decideToolUse({ profile: "safe-auto" }, "Read", { blockedPath: "/etc/passwd" }).decision).toBe("deny");
    const aborted = new AbortController();
    aborted.abort();
    expect(decideToolUse({ profile: "safe-auto" }, "Read", { signal: aborted.signal }).decision).toBe("deny");
    expect(decideToolUse({ profile: "safe-auto", allowedTools: ["CustomTool"] }, "CustomTool", {}).decision).toBe("allow");
    expect(decideToolUse({ profile: "read-only", allowedTools: ["CustomRead"] }, "CustomRead", {}).decision).toBe("allow");
  });

  it("canUseTool：allow/deny 返回 SDK PermissionResult 形状（永不 null）", async () => {
    const canUseTool = createCanUseTool({ profile: "read-only" });
    const allow = await canUseTool("Read", {}, { toolUseID: "t1" });
    expect(allow).toEqual({ behavior: "allow", toolUseID: "t1" });
    const deny = await canUseTool("Write", {}, { toolUseID: "t2" });
    expect(deny.behavior).toBe("deny");
    expect((deny as { message: string }).message).toContain("read-only");
    expect(JSON.stringify(deny)).not.toContain("null");
  });

  it("canUseTool：决策超时 → deny + timedOut 记录（fail-closed，不挂起）", async () => {
    const decisions: { timedOut: boolean; decision: string }[] = [];
    const canUseTool = createCanUseTool({
      profile: "safe-auto",
      timeoutMs: 20,
      onDecision: (record) => decisions.push({ timedOut: record.timedOut, decision: record.decision }),
      decideToolUse: () => new Promise(() => undefined), // 永不 resolve：模拟挂起策略
    });
    const startedAt = Date.now();
    const result = await canUseTool("Bash", {}, { toolUseID: "t3" });
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(decisions).toEqual([{ timedOut: true, decision: "deny" }]);
  });

  it("canUseTool：策略抛错 → deny（异常不会泄漏给 SDK/不会挂起）", async () => {
    const canUseTool = createCanUseTool({
      profile: "safe-auto",
      decideToolUse: () => {
        throw new Error("policy exploded");
      },
    });
    const result = await canUseTool("Read", {}, {});
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("decision error");
  });

  it("onDecision 记录 risk/toolUseId，便于适配器发 permission.* 事件", async () => {
    const records: { toolName: string; risk: string; decision: string; toolUseId?: string }[] = [];
    const canUseTool = createCanUseTool({
      profile: "read-only",
      onDecision: (record) => records.push({ toolName: record.toolName, risk: record.risk, decision: record.decision, ...(record.toolUseId === undefined ? {} : { toolUseId: record.toolUseId }) }),
    });
    await canUseTool("Bash", {}, { toolUseID: "toolu_9" });
    expect(records).toEqual([{ toolName: "Bash", risk: "execute", decision: "deny", toolUseId: "toolu_9" }]);
  });

  it("env 白名单：只保留系统变量与 ANTHROPIC_/CLAUDE_（敏感前缀剔除，不打印值）", () => {
    const env = sanitizedEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "zh_CN.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-fake",
      CLAUDE_CODE_USE_BEDROCK: "0",
      GITHUB_TOKEN: "ghp_fake",
      AWS_SECRET_ACCESS_KEY: "aws_fake",
      RANDOM_VAR: "x",
    });
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "HOME", "LANG", "PATH"]);
    expect(JSON.stringify(env)).not.toContain("ghp_fake");
    expect(JSON.stringify(env)).not.toContain("aws_fake");
  });
});

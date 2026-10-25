import { describe, expect, it } from "vitest";
import {
  buildResumeOptions,
  classifyResumeFailure,
  createFileSessionProber,
  isSafeSessionId,
  projectsDir,
} from "../../../src/adapters/claude-code/resume.ts";

describe("claude-code 续接（设计 §4.1/§4.4）", () => {
  it("sessionId 安全集：拒绝路径穿越与非法字符", () => {
    expect(isSafeSessionId("0f7c1f0e-1111-4222-8333-944455556666")).toBe(true);
    expect(isSafeSessionId("abcDEF123")).toBe(true);
    expect(isSafeSessionId("../../etc/passwd")).toBe(false);
    expect(isSafeSessionId("a/b")).toBe(false);
    expect(isSafeSessionId("short")).toBe(false);
    expect(isSafeSessionId("")).toBe(false);
  });

  it("projectsDir 默认为 ~/.claude/projects，CLAUDE_CONFIG_DIR 可覆盖", () => {
    const base = projectsDir({ HOME: "/home/u" } as NodeJS.ProcessEnv);
    expect(base.endsWith("/.claude/projects")).toBe(true);
    const overridden = projectsDir({ CLAUDE_CONFIG_DIR: "/tmp/claude-cfg" } as NodeJS.ProcessEnv);
    expect(overridden).toBe("/tmp/claude-cfg/projects");
  });

  it("文件探测器：只读目录清单，命中 <sessionId>.jsonl 即存在（支持嵌套路径）", async () => {
    const calls: string[] = [];
    const prober = createFileSessionProber({
      projectsDir: "/tmp/projects",
      readdir: async (path) => {
        calls.push(path);
        return ["proj-a/0f7c1f0e-1111-4222-8333-944455556666.jsonl", "proj-a/other.jsonl"];
      },
    });
    expect(await prober.exists("0f7c1f0e-1111-4222-8333-944455556666")).toBe(true);
    expect(await prober.exists("missing-session-id")).toBe(false);
    expect(calls).toEqual(["/tmp/projects", "/tmp/projects"]);
  });

  it("文件探测器：非法 id 直接 false，不触碰文件系统（防穿越）", async () => {
    let called = false;
    const prober = createFileSessionProber({
      readdir: async () => {
        called = true;
        return [];
      },
    });
    expect(await prober.exists("../../etc/passwd")).toBe(false);
    expect(called).toBe(false);
  });

  it("文件探测器：目录不存在 → false（不是故障）", async () => {
    const prober = createFileSessionProber({
      projectsDir: "/definitely/not/exists",
      readdir: async () => {
        const { readdir } = await import("node:fs/promises");
        return readdir("/definitely/not/exists", { recursive: true });
      },
    });
    expect(await prober.exists("0f7c1f0e-1111-4222-8333-944455556666")).toBe(false);
  });

  it("buildResumeOptions：resume/forkSession/resumeSessionAt 走 SDK Options（不手拼 CLI flag）", () => {
    expect(buildResumeOptions({ sessionId: "0f7c1f0e-1111-4222-8333-944455556666" })).toEqual({
      resume: "0f7c1f0e-1111-4222-8333-944455556666",
    });
    expect(buildResumeOptions({ sessionId: "abcDEF123", forkSession: true })).toEqual({
      resume: "abcDEF123",
      forkSession: true,
    });
    expect(buildResumeOptions({ sessionId: "abcDEF123", resumeSessionAt: "uuid-1" })).toEqual({
      resume: "abcDEF123",
      resumeSessionAt: "uuid-1",
    });
    expect(() => buildResumeOptions({ sessionId: "../bad" })).toThrowError(/unsafe session id/);
  });

  it("classifyResumeFailure：探测不到 → session.not-found；探测到但续接报错 → session.resume-failed", () => {
    expect(classifyResumeFailure(false, new Error("no file")).code).toBe("session.not-found");
    expect(classifyResumeFailure(true, new Error("No conversation found")).code).toBe("session.resume-failed");
  });
});

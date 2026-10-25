import { describe, expect, it } from "vitest";
import {
  AsyncInputQueue,
  ClaudeQueryHandle,
  buildQueryOptions,
  toSdkUserMessage,
} from "../../../src/adapters/claude-code/sdk-client.ts";
import { createCanUseTool } from "../../../src/adapters/claude-code/permissions.ts";
import { FakeQuery } from "./helpers.ts";
import type { SdkUserMessage } from "../../../src/adapters/claude-code/types.ts";

const baseInput = {
  cwd: "/tmp/work",
  permissionProfile: "read-only" as const,
  permissionMode: "dontAsk",
  model: "claude-sonnet-5",
  canUseTool: createCanUseTool({ profile: "read-only" }),
  abortController: new AbortController(),
  env: { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_fake", ANTHROPIC_API_KEY: "sk-ant-fake" } as NodeJS.ProcessEnv,
};

const BASE_DISALLOWED = ["AskUserQuestion", "ExitPlanMode"];

describe("claude-code SDK 选项构造（设计 §2.1/§4.1/§7）", () => {
  it("硬要求：persistSession=true、permissionPrompts=host、canUseTool 存在、partial/forward 打开", () => {
    const options = buildQueryOptions({ ...baseInput }, "dontAsk", [...BASE_DISALLOWED, "Write"]);
    expect(options["persistSession"]).toBe(true);
    expect(options["permissionPrompts"]).toBe("host");
    expect(options["permissionMode"]).toBe("dontAsk");
    expect(options["includePartialMessages"]).toBe(true);
    expect(options["forwardSubagentText"]).toBe(true);
    expect(typeof options["canUseTool"]).toBe("function");
    expect(options["disallowedTools"]).toEqual([...BASE_DISALLOWED, "Write"]);
    // 不传裸 allowedTools（否则 SDK 会跳过 canUseTool，见 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED）
    expect("allowedTools" in options).toBe(false);
    expect(options["cwd"]).toBe("/tmp/work");
    expect(options["abortController"]).toBeInstanceOf(AbortController);
  });

  it("env 白名单：敏感变量不传（GITHUB_TOKEN 被剔除，ANTHROPIC_* 保留）", () => {
    const options = buildQueryOptions({ ...baseInput }, "dontAsk", BASE_DISALLOWED);
    const env = options["env"] as Record<string, string>;
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-fake");
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
  });

  it("续接只通过 Options：resume / forkSession / resumeSessionAt（不出现手拼 CLI flag）", () => {
    const options = buildQueryOptions(
      { ...baseInput, resumeSessionId: "0f7c1f0e-1111-4222-8333-944455556666", forkSession: true, resumeSessionAt: "uuid-1" },
      "dontAsk",
      BASE_DISALLOWED,
    );
    expect(options["resume"]).toBe("0f7c1f0e-1111-4222-8333-944455556666");
    expect(options["forkSession"]).toBe(true);
    expect(options["resumeSessionAt"]).toBe("uuid-1");
    expect(JSON.stringify(options)).not.toContain("--resume");
  });

  it("无 resume 时 options 不含 resume 相关键；safe-auto 不给 allowedTools", () => {
    const options = buildQueryOptions(
      { ...baseInput, permissionProfile: "safe-auto", permissionMode: "acceptEdits" },
      "acceptEdits",
      BASE_DISALLOWED,
    );
    expect("resume" in options).toBe(false);
    expect("forkSession" in options).toBe(false);
    expect("allowedTools" in options).toBe(false);
    expect(options["permissionMode"]).toBe("acceptEdits");
  });

  it("新建会话可钉死 sessionId（Options.sessionId，先于 init 可知，保证可续接）", () => {
    const options = buildQueryOptions(
      { ...baseInput, sessionId: "0f7c1f0e-1111-4222-8333-944455556666" },
      "dontAsk",
      BASE_DISALLOWED,
    );
    expect(options["sessionId"]).toBe("0f7c1f0e-1111-4222-8333-944455556666");
    expect("resume" in options).toBe(false);
  });

  it("sessionId 与 resume 互斥（SDK 硬约束；forkSession 才允许）", () => {
    expect(() =>
      buildQueryOptions(
        { ...baseInput, sessionId: "0f7c1f0e-1111-4222-8333-944455556666", resumeSessionId: "abcDEF123" },
        "dontAsk",
        BASE_DISALLOWED,
      ),
    ).toThrowError(/cannot be combined/);
    const forked = buildQueryOptions(
      {
        ...baseInput,
        sessionId: "0f7c1f0e-1111-4222-8333-944455556666",
        resumeSessionId: "abcDEF123",
        forkSession: true,
      },
      "dontAsk",
      BASE_DISALLOWED,
    );
    expect(forked["sessionId"]).toBe("0f7c1f0e-1111-4222-8333-944455556666");
    expect(forked["resume"]).toBe("abcDEF123");
    expect(forked["forkSession"]).toBe(true);
  });

  it("非法 sessionId 在构造 options 时就被拒绝（防路径穿越）", () => {
    expect(() => buildQueryOptions({ ...baseInput, resumeSessionId: "../bad" }, "dontAsk", BASE_DISALLOWED)).toThrowError(
      /unsafe session id/,
    );
  });

  it("toSdkUserMessage：text/image/file 映射为 SDK 用户消息（不读文件内容）", () => {
    const message = toSdkUserMessage(
      [
        { type: "text", text: "hello" },
        { type: "image", text: "", path: "/tmp/a.png" },
        { type: "file", text: "", path: "/tmp/a.ts" },
      ],
      "0f7c1f0e-1111-4222-8333-944455556666",
    );
    expect(message.type).toBe("user");
    expect(message.message.content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "[image] /tmp/a.png" },
      { type: "text", text: "[file] /tmp/a.ts" },
    ]);
    expect(message.session_id).toBe("0f7c1f0e-1111-4222-8333-944455556666");
  });
});

describe("claude-code SDK 输入队列与控制面", () => {
  it("AsyncInputQueue：FIFO 投递，close 后迭代结束", async () => {
    const queue = new AsyncInputQueue<SdkUserMessage>();
    const iterator = queue[Symbol.asyncIterator]();
    const first = iterator.next();
    const msg: SdkUserMessage = { type: "user", message: { role: "user", content: [{ type: "text", text: "a" }] }, parent_tool_use_id: null };
    queue.push(msg);
    expect(await first).toEqual({ value: msg, done: false });
    queue.close();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("ClaudeQueryHandle：interrupt/close/streamInput/setModel 透传到 SDK Query", async () => {
    const fake = new FakeQuery();
    const handle = new ClaudeQueryHandle(fake);
    await handle.interrupt();
    expect(fake.interrupts).toHaveLength(1);
    await handle.setModel("claude-opus-5");
    expect(fake.models).toEqual(["claude-opus-5"]);
    const queue = new AsyncInputQueue<SdkUserMessage>();
    const streaming = handle.streamInput(queue);
    queue.push({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null });
    queue.close();
    await streaming;
    expect(fake.streamedInputs).toHaveLength(1);
    handle.close();
    expect(fake.closed).toBe(true);
    expect(handle.closed).toBe(true);
    handle.close(); // 幂等
  });
});

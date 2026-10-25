import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FetchLike } from "../../../src/adapters/opencode/types.ts";
import {
  OpenCodeHttpClient,
  readServicePassword,
  resolveHttpConfig,
  SseParser,
} from "../../../src/adapters/opencode/http-client.ts";
import { dataResponse, FakeFetch, jsonResponse, makeTempDir, sseResponse } from "./helpers.ts";

const PASSWORD = "test-password-not-a-secret";

function clientFor(fetch: FetchLike, overrides: { timeoutMs?: number; maxGetRetries?: number } = {}): OpenCodeHttpClient {
  return new OpenCodeHttpClient({
    baseUrl: "http://opencode.test:49374/",
    password: PASSWORD,
    fetch,
    ...overrides,
  });
}

describe("opencode v2 HttpApi 客户端（§2.2/§3.1/§4.3）", () => {
  it("构造 Basic auth（user=opencode）并 unwrap {data} 包络", async () => {
    const fake = new FakeFetch({
      "GET /api/info": dataResponse({ version: "2.1.4", pid: 42 }),
    });
    const info = await clientFor(fake.fetch).getInfo();
    expect(info).toMatchObject({ version: "2.1.4", pid: 42 });
    const authorization = fake.calls[0]?.headers["Authorization"];
    expect(authorization).toBe(`Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`);
    expect(fake.calls[0]?.url).toBe("http://opencode.test:49374/api/info");
  });

  it("POST 失败不重试（非幂等）：500 只调用一次并映射 backend.internal-error", async () => {
    const fake = new FakeFetch({ "POST /api/session": jsonResponse({ error: "boom" }, 500) });
    const client = clientFor(fake.fetch);
    await expect(
      client.createSession({
        agent: "plan",
        model: { id: "deepseek-v4.1-flash-free", providerID: "opencode" },
        location: { directory: "/tmp" },
      }),
    ).rejects.toMatchObject({ code: "backend.internal-error" });
    expect(fake.count("POST", "/api/session")).toBe(1);
  });

  it("幂等 GET 对瞬时失败重试（默认 2 次）", async () => {
    let attempts = 0;
    const fake = new FakeFetch({
      "GET /api/session": () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new DOMException("connection reset", "AbortError"));
        }
        return dataResponse([{ id: "ses_1" }]);
      },
    });
    const sessions = await clientFor(fake.fetch).listSessions({ limit: 3 });
    expect(attempts).toBe(2);
    expect(sessions).toEqual([{ id: "ses_1" }]);
    expect(fake.calls[0]?.url).toContain("/api/session?limit=3");
  });

  it("超时 → transport.timeout（且错误文案不含密码）", async () => {
    const never: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    const client = clientFor(never, { timeoutMs: 20, maxGetRetries: 0 });
    let message = "";
    try {
      await client.getInfo();
    } catch (error) {
      message = String(error);
      expect(error).toMatchObject({ code: "transport.timeout" });
    }
    expect(message).not.toContain(PASSWORD);
  });

  it("401 api_key_expired → auth.credential-expired（D-019 触发条件）", async () => {
    const fake = new FakeFetch({
      "POST /api/session/ses_1/interrupt": jsonResponse(
        { type: "provider.auth", message: "This API key has expired.", status: 401, response: { body: "{\"error\":{\"code\":\"api_key_expired\"}}" } },
        401,
      ),
    });
    await expect(clientFor(fake.fetch).interrupt("ses_1", true)).rejects.toMatchObject({
      code: "auth.credential-expired",
    });
  });

  it("401 UnauthorizedError → auth.credential-rejected（server Basic 鉴权失败）", async () => {
    const fake = new FakeFetch({
      "GET /api/info": jsonResponse({ _tag: "UnauthorizedError", message: "Authentication required" }, 401),
    });
    await expect(clientFor(fake.fetch).getInfo()).rejects.toMatchObject({ code: "auth.credential-rejected" });
  });

  it("400 model_not_available_for_integrator → auth.provider-mismatch", async () => {
    const fake = new FakeFetch({
      "POST /api/session": jsonResponse(
        { type: "provider.invalid-request", message: "not available", status: 400 },
        400,
      ),
    });
    await expect(
      clientFor(fake.fetch).createSession({
        agent: "plan",
        model: { id: "x", providerID: "opencode-go" },
        location: { directory: "/tmp" },
      }),
    ).rejects.toMatchObject({ code: "auth.provider-mismatch" });
  });

  it("404 会话 → session.not-found；拦截/权限应答走对应端点", async () => {
    const fake = new FakeFetch({
      "GET /api/session/ses_missing": jsonResponse({ _tag: "NotFoundError" }, 404),
      "POST /api/session/ses_1/permission/per_1/reply": new Response(null, { status: 204 }),
    });
    const client = clientFor(fake.fetch);
    await expect(client.getSession("ses_missing")).rejects.toMatchObject({ code: "session.not-found" });
    await client.replyPermission("ses_1", "per_1", "once");
    expect(fake.calls.at(-1)?.url).toContain("/api/session/ses_1/permission/per_1/reply");
    expect(fake.calls.at(-1)?.body).toEqual({ decision: "once" });
  });

  it("switchModel 请求体是 {model: Model.Ref}（OpenAPI 契约，不是裸对象）", async () => {
    const fake = new FakeFetch({ "POST /api/session/ses_1/model": dataResponse({ id: "ses_1" }) });
    await clientFor(fake.fetch).switchModel("ses_1", {
      id: "deepseek-v4.1-flash-free",
      providerID: "opencode",
    });
    expect(fake.calls[0]?.body).toEqual({
      model: { id: "deepseek-v4.1-flash-free", providerID: "opencode" },
    });
  });

  it("权限待批列表带 location[directory] 查询（location 作用域坑）", async () => {
    const fake = new FakeFetch({ "GET /api/permission/request": dataResponse([]) });
    await clientFor(fake.fetch).listPermissionRequests("/tmp/work");
    expect(fake.calls[0]?.url).toContain("location%5Bdirectory%5D=%2Ftmp%2Fwork");
  });

  it("SSE 解析：data 行 + heartbeat + 半帧拼接", async () => {
    const frames = [
      { id: "evt_1", type: "server.connected", data: {} },
      { id: "evt_2", type: "session.text.delta", data: { delta: "OK" } },
    ];
    const fake = new FakeFetch({
      "GET /api/event": () => sseResponse(frames.map((frame) => JSON.stringify(frame)), { splitFrames: true }),
    });
    const received: string[] = [];
    await clientFor(fake.fetch).subscribeEvents((frame) => {
      received.push(frame.type);
    });
    expect(received).toEqual(["server.connected", "session.text.delta"]);
  });

  it("SseParser 丢弃坏帧与注释，不抛错", () => {
    const parsed: string[] = [];
    const parser = new SseParser((frame) => parsed.push(frame.type));
    parser.push(": heartbeat\n\ndata: {not-json}\n\ndata: {\"type\":\"session.created\"}\n\n");
    parser.end();
    expect(parsed).toEqual(["session.created"]);
  });

  it("凭据解析：env 优先，其次 service.json（只读不打印）", async () => {
    const temp = await makeTempDir();
    try {
      const serviceDir = join(temp.dir, ".config", "opencode");
      await mkdir(serviceDir, { recursive: true });
      await writeFile(join(serviceDir, "service.json"), JSON.stringify({ password: "file-pass" }));
      expect(readServicePassword(temp.dir)).toBe("file-pass");
      const config = resolveHttpConfig({ MOCL_OPENCODE_URL: "http://127.0.0.1:1" }, temp.dir);
      expect(config).toMatchObject({ baseUrl: "http://127.0.0.1:1", password: "file-pass" });
      // env 优先
      expect(
        resolveHttpConfig(
          { MOCL_OPENCODE_URL: "http://127.0.0.1:1", MOCL_OPENCODE_PASSWORD: "env-pass" },
          temp.dir,
        )?.password,
      ).toBe("env-pass");
      // 缺 URL → undefined（端口随机，不猜）
      expect(resolveHttpConfig({}, temp.dir)).toBeUndefined();
    } finally {
      await temp.cleanup();
    }
  });
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpApi } from "../../src/adapters/opencode/acp-client.ts";
import type { OpenCodeHttpApi } from "../../src/adapters/opencode/http-client.ts";
import { MoclError } from "../../src/broker/errors.ts";
import { LazyAcpClient, createBackendAdapter } from "../../src/facade/adapters.ts";
import { spawnAcpTransport } from "../../src/adapters/opencode/acp-client.ts";
import { validateConfig } from "../../src/facade/config.ts";
import { fixedRuntime } from "./helpers.ts";

/**
 * C8/C7 门面装配回归：`createBackendAdapter("opencode", ...)` 必须注入 http/acp 客户端。
 *
 * 缺陷背景（issue #8 / scenarios KI-01）：旧实现直接 `new OpenCodeAdapter({transport})`，
 * 构造器对缺失客户端抛 `TypeError: OpenCodeAdapter(http) requires options.http`，
 * 于是「启用 opencode」会让整个门面装配失败，并连累其他后端。
 *
 * 本测试只验证装配边界：不访问网络、不 spawn 子进程（客户端用假件注入或懒创建）。
 */

const NO_ENV: Readonly<Record<string, string | undefined>> = {};
const NO_HOME = "/nonexistent-mocl-opencode-home";

function opencodeConfig(channel: "http" | "acp") {
  const config = validateConfig({ backends: { opencode: { enabled: true, channel } } });
  return config.backends.opencode;
}

/** Minimal stand-ins: the adapter only receives them in this suite, never calls them. */
const fakeHttp = {} as OpenCodeHttpApi;
const fakeAcp = { onUpdate: () => {} } as unknown as AcpApi;

const savedUrl = process.env["MOCL_OPENCODE_URL"];
const savedPassword = process.env["MOCL_OPENCODE_PASSWORD"];

afterEach(() => {
  if (savedUrl === undefined) delete process.env["MOCL_OPENCODE_URL"];
  else process.env["MOCL_OPENCODE_URL"] = savedUrl;
  if (savedPassword === undefined) delete process.env["MOCL_OPENCODE_PASSWORD"];
  else process.env["MOCL_OPENCODE_PASSWORD"] = savedPassword;
});

/** Poll for the marker file; returns true as soon as it appears (bounded wait). */
async function markerAppears(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(path);
}

describe("createBackendAdapter — opencode 客户端注入", () => {
  it("http 通道：注入假 http 客户端即可装配成功，不再抛 TypeError", () => {
    const adapter = createBackendAdapter("opencode", opencodeConfig("http"), fixedRuntime(2), {
      opencodeHttp: fakeHttp,
    });
    expect(adapter.backendId).toBe("opencode");
  });

  it("http 通道：配置缺失 → fail-closed 抛 ABI 错误（auth.missing-credential），不是 TypeError", () => {
    expect(() =>
      createBackendAdapter("opencode", opencodeConfig("http"), fixedRuntime(2), {
        opencodeEnv: NO_ENV,
        opencodeHome: NO_HOME,
      }),
    ).toThrowError(MoclError);

    try {
      createBackendAdapter("opencode", opencodeConfig("http"), fixedRuntime(2), {
        opencodeEnv: NO_ENV,
        opencodeHome: NO_HOME,
      });
      expect.unreachable("expected a fail-closed error");
    } catch (error) {
      expect(error).toBeInstanceOf(MoclError);
      expect((error as MoclError).code).toBe("auth.missing-credential");
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });

  it("http 通道：环境变量齐备时可装配（真实客户端只构造、不联网）", () => {
    const adapter = createBackendAdapter("opencode", opencodeConfig("http"), fixedRuntime(2), {
      opencodeEnv: {
        MOCL_OPENCODE_URL: "http://127.0.0.1:1",
        MOCL_OPENCODE_PASSWORD: "test-password",
      },
      opencodeHome: NO_HOME,
    });
    expect(adapter.backendId).toBe("opencode");
  });

  it("acp 通道：注入假 acp 客户端即可装配成功", () => {
    const adapter = createBackendAdapter("opencode", opencodeConfig("acp"), fixedRuntime(2), {
      opencodeAcp: fakeAcp,
    });
    expect(adapter.backendId).toBe("opencode");
  });

  it("acp 通道：装配阶段不 spawn 子进程（记录型假二进制，0 次 spawn）", async () => {
    // G5 打回 B1/B2：OpenCodeAdapter 构造器会同步 onUpdate()，懒客户端必须只缓存 handler，
    // 不能在装配阶段 spawn。用 OPENCODE_BIN 记录型假二进制做行为断言。
    // 注意：不能用固定短 sleep —— 本机假二进制首次执行延迟实测 265–465ms，会假阴性；
    // 这里对 marker 轮询 2s（eager spawn 在装配期同步发生，2s 足以覆盖进程启动延迟）。
    const dir = mkdtempSync(join(tmpdir(), "mocl-acp-spy-"));
    const marker = join(dir, "spawned.log");
    const fakeBin = join(dir, "opencode");
    writeFileSync(fakeBin, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    const previous = process.env["OPENCODE_BIN"];
    process.env["OPENCODE_BIN"] = fakeBin;
    try {
      const adapter = createBackendAdapter("opencode", opencodeConfig("acp"), fixedRuntime(2));
      expect(adapter.backendId).toBe("opencode");
      expect(await markerAppears(marker, 2_000)).toBe(false);

      // Closing an unknown session must also not spawn (terminate is a no-op before creation).
      await adapter.close({ sessionId: "sess-never-opened", remoteSessionId: "never-opened", reason: "cancelled" });
      expect(await markerAppears(marker, 500)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["OPENCODE_BIN"];
      else process.env["OPENCODE_BIN"] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("LazyAcpClient：未创建客户端时 onUpdate/terminate 都不 spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mocl-acp-spy-"));
    const marker = join(dir, "spawned.log");
    const fakeBin = join(dir, "opencode");
    writeFileSync(fakeBin, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    const previous = process.env["OPENCODE_BIN"];
    process.env["OPENCODE_BIN"] = fakeBin;
    try {
      const lazy = new LazyAcpClient(opencodeConfig("acp"));
      lazy.onUpdate(() => {});
      await lazy.terminate();
      expect(await markerAppears(marker, 500)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["OPENCODE_BIN"];
      else process.env["OPENCODE_BIN"] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spawn spy 正向对照：真实 spawn 会写 marker（证明断言不是空转）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mocl-acp-spy-"));
    const marker = join(dir, "spawned.log");
    const fakeBin = join(dir, "opencode");
    writeFileSync(fakeBin, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    const previous = process.env["OPENCODE_BIN"];
    process.env["OPENCODE_BIN"] = fakeBin;
    try {
      const transport = spawnAcpTransport({ cwd: process.cwd() });
      try {
        expect(await markerAppears(marker, 2_000)).toBe(true);
      } finally {
        transport.close();
      }
    } finally {
      if (previous === undefined) delete process.env["OPENCODE_BIN"];
      else process.env["OPENCODE_BIN"] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("其他后端装配不受影响（回归）", () => {
    const config = validateConfig({
      backends: {
        codex: { enabled: true },
        "claude-code": { enabled: true },
        kimi: { enabled: true },
      },
    });
    for (const id of ["codex", "claude-code", "kimi"] as const) {
      const adapter = createBackendAdapter(id, config.backends[id], fixedRuntime(2));
      expect(adapter.backendId).toBe(id);
    }
  });
});

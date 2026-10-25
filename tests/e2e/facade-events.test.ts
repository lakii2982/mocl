import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MoclFacade } from "../../src/facade/facade.ts";
import { validateConfig } from "../../src/facade/config.ts";
import { SessionRegistry } from "../../src/broker/session-registry.ts";
import { StreamingFakeAdapter } from "./helpers.ts";

function configFor(backend: "codex" | "kimi"): ReturnType<typeof validateConfig> {
  return validateConfig({
    global: { enabled: true },
    backends: { [backend]: { enabled: true, ...(backend === "kimi" ? { channel: "cli" } : {}) } },
  });
}

async function makeFacade(backend: "codex" | "kimi", adapter: StreamingFakeAdapter, registryPath: string): Promise<MoclFacade> {
  return MoclFacade.create({
    config: configFor(backend),
    runtime: { read: () => ({ maxActiveSubagents: 4 }) },
    adapters: { [backend]: adapter },
    registryPath,
  });
}

async function waitForTerminal(facade: MoclFacade, childId: string, timeoutMs = 3_000) {
  const started = Date.now();
  let status = await facade.status(childId);
  while (Date.now() - started < timeoutMs && (status.state === "running" || status.state === "created")) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
    status = await facade.status(childId, status.cursor.lastSeq ?? 0);
  }
  return status;
}

describe("门面事件流（C9：adapter.events → EventBus）+ D-020 持久化", () => {
  it("open 后 status 收敛到 completed，含事件计数/usage/parent 投递", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mocl-c9-"));
    const adapter = new StreamingFakeAdapter("codex");
    const facade = await makeFacade("codex", adapter, join(dir, "sessions.json"));
    try {
      const opened = await facade.open("codex", "只回答 OK", { cwd: dir });
      const status = await waitForTerminal(facade, opened.childId);
      expect(status.state).toBe("completed");
      expect(status.cursor.total).toBeGreaterThan(0);
      expect(status.cursor.events).toBeGreaterThan(0);
      expect(status.usage).not.toBeNull();
      expect(status.degraded).toBe(false);
      expect(status.parentDeliveries).toBe(1);
      expect(status.lastEventType).toBe("turn.completed");
      // 增量游标：从 lastSeq 再拉应为空
      const next = await facade.status(opened.childId, status.cursor.lastSeq ?? 0);
      expect(next.cursor.events).toBe(0);
    } finally {
      await facade.close((await facade.list()).children[0]?.childId ?? "");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("D-020：kimi CLI 空 id → 首轮后回填并持久化（重启仍 bound）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mocl-c9-"));
    const adapter = new StreamingFakeAdapter("kimi", { remoteId: "", backfillAfterSend: true });
    const facade = await makeFacade("kimi", adapter, join(dir, "sessions.json"));
    try {
      const opened = await facade.open("kimi", "task", { cwd: dir });
      const status = await waitForTerminal(facade, opened.childId);
      expect(status.remoteIdState).toBe("bound");
      expect(status.backendSessionId).toBe("remote_after_turn");

      // 重启：新 Registry 实例读同一文件仍 bound；新门面 status 读 registry 也 bound
      const restartedRegistry = new SessionRegistry({ path: join(dir, "sessions.json") });
      await restartedRegistry.load();
      expect(restartedRegistry.get(opened.childId)?.remoteSessionId).toBe("remote_after_turn");

      const facade2 = await makeFacade("kimi", new StreamingFakeAdapter("kimi"), join(dir, "sessions.json"));
      const status2 = await facade2.status(opened.childId);
      expect(status2.remoteIdState).toBe("bound");
      expect(status2.backendSessionId).toBe("remote_after_turn");
      await facade2.close(opened.childId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("degraded warning 进入 status.warnings / degraded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mocl-c9-"));
    const adapter = new StreamingFakeAdapter("codex");
    adapter.degraded = true;
    const facade = await makeFacade("codex", adapter, join(dir, "sessions.json"));
    try {
      const opened = await facade.open("codex", "task", { cwd: dir });
      const status = await waitForTerminal(facade, opened.childId);
      expect(status.degraded).toBe(true);
      expect(status.warnings).toContain("auth.credential-expired");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adapters.events 抛错不拖垮门面（status 仍可读）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mocl-c9-"));
    const adapter = new StreamingFakeAdapter("codex");
    adapter.events = async function* broken(): AsyncIterable<never> {
      throw new Error("stream boom");
    } as unknown as typeof adapter.events;
    const facade = await makeFacade("codex", adapter, join(dir, "sessions.json"));
    try {
      const opened = await facade.open("codex", "task", { cwd: dir });
      const status = await facade.status(opened.childId);
      expect(status.childId).toBe(opened.childId);
      expect(status.state).toBe("running"); // 流失败不伪造终态
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

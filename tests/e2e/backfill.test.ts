import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRegistry, type SessionRecord } from "../../src/broker/session-registry.ts";
import { makeRegistry } from "../broker/helpers.ts";

function baseRecord(childId: string): SessionRecord {
  return {
    childId,
    backend: "kimi",
    remoteSessionId: "",
    cwd: "/tmp/work",
    model: null,
    createdAt: "2026-10-26T00:00:00.000Z",
    epoch: 1,
  };
}

describe("D-020：SessionRegistry.backfillRemoteId（持久化回填）", () => {
  it("空 remoteId → 回填成功；epoch 不变", async () => {
    const { registry, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(baseRecord("sess_kimi"));
      const updated = await registry.backfillRemoteId("sess_kimi", "remote_abc");
      expect(updated.remoteSessionId).toBe("remote_abc");
      expect(updated.epoch).toBe(1);
      expect(registry.get("sess_kimi")?.remoteSessionId).toBe("remote_abc");
    } finally {
      await cleanup();
    }
  });

  it("新 Registry 实例读同一文件后仍 bound（重启持久化）", async () => {
    const { registry, dir, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(baseRecord("sess_kimi"));
      await registry.backfillRemoteId("sess_kimi", "remote_persisted");
      const restarted = new SessionRegistry({ path: join(dir, "sessions.json") });
      await restarted.load();
      expect(restarted.get("sess_kimi")?.remoteSessionId).toBe("remote_persisted");
      expect(restarted.get("sess_kimi")?.epoch).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("sessions.json 损坏时 journal 重放仍保留回填值", async () => {
    const { registry, dir, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(baseRecord("sess_kimi"));
      await registry.backfillRemoteId("sess_kimi", "remote_from_journal");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "sessions.json"), "corrupted", "utf8");
      const rebuilt = new SessionRegistry({ path: join(dir, "sessions.json") });
      await rebuilt.load();
      expect(rebuilt.get("sess_kimi")?.remoteSessionId).toBe("remote_from_journal");
    } finally {
      await cleanup();
    }
  });

  it("重复回填同一 id → 幂等（不写坏文件）", async () => {
    const { registry, dir, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(baseRecord("sess_kimi"));
      await registry.backfillRemoteId("sess_kimi", "remote_abc");
      const before = await readFile(join(dir, "sessions.json"), "utf8");
      const again = await registry.backfillRemoteId("sess_kimi", "remote_abc");
      const after = await readFile(join(dir, "sessions.json"), "utf8");
      expect(again.remoteSessionId).toBe("remote_abc");
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it("已 bound 后回填不同 id → session.conflict（不覆盖）", async () => {
    const { registry, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(baseRecord("sess_kimi"));
      await registry.backfillRemoteId("sess_kimi", "remote_first");
      await expect(registry.backfillRemoteId("sess_kimi", "remote_second")).rejects.toMatchObject({
        code: "session.conflict",
      });
      expect(registry.get("sess_kimi")?.remoteSessionId).toBe("remote_first");
    } finally {
      await cleanup();
    }
  });

  it("未知会话 → session.not-found；空/非字符串 id → protocol.invalid-params", async () => {
    const { registry, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(baseRecord("sess_kimi"));
      await expect(registry.backfillRemoteId("sess_missing", "remote_x")).rejects.toMatchObject({ code: "session.not-found" });
      await expect(registry.backfillRemoteId("sess_kimi", "")).rejects.toMatchObject({ code: "protocol.invalid-params" });
      await expect(
        registry.backfillRemoteId("sess_kimi", 42 as unknown as string),
      ).rejects.toMatchObject({ code: "protocol.invalid-params" });
    } finally {
      await cleanup();
    }
  });
});

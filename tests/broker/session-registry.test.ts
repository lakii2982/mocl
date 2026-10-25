import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MoclError } from "../../src/broker/errors.ts";
import { SessionRegistry, type SessionRecord } from "../../src/broker/session-registry.ts";
import { makeRegistry } from "./helpers.ts";

function record(childId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    childId,
    backend: "codex",
    remoteSessionId: `remote_${childId}`,
    cwd: "/tmp/work",
    model: null,
    createdAt: "2026-10-26T00:00:00.000Z",
    epoch: 1,
    ...overrides,
  };
}

describe("SessionRegistry（持久化 + 原子写 + journal 重建）", () => {
  it("upsert 后重载可读；sessions.json 为合法 JSON 且无 .tmp 残留", async () => {
    const { registry, dir, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(record("sess_A"));
      const second = new SessionRegistry({ path: join(dir, "sessions.json") });
      await second.load();
      expect(second.get("sess_A")?.remoteSessionId).toBe("remote_sess_A");
      const files = await readdir(dir);
      expect(files.some((name) => name.includes(".tmp-"))).toBe(false);
      const parsed = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as {
        version: number;
        sessions: SessionRecord[];
      };
      expect(parsed.version).toBe(1);
      expect(parsed.sessions).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("sessions.json 损坏时从 journal 重建（不猜测、不丢失已提交记录）", async () => {
    const { registry, dir, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(record("sess_A"));
      await registry.upsert(record("sess_B", { epoch: 2 }));
      // 模拟半写/损坏
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "sessions.json"), "{ this is not json", "utf8");
      const rebuilt = new SessionRegistry({ path: join(dir, "sessions.json") });
      await rebuilt.load();
      expect(rebuilt.size).toBe(2);
      expect(rebuilt.get("sess_A")?.childId).toBe("sess_A");
      expect(rebuilt.get("sess_B")?.epoch).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("bumpEpoch 只增；回退 epoch 抛 session.conflict", async () => {
    const { registry, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(record("sess_A", { epoch: 1 }));
      const bumped = await registry.bumpEpoch("sess_A", 2);
      expect(bumped.epoch).toBe(2);
      await expect(registry.bumpEpoch("sess_A", 2)).rejects.toMatchObject({ code: "session.conflict" });
      await expect(registry.bumpEpoch("sess_A", 1)).rejects.toBeInstanceOf(MoclError);
    } finally {
      await cleanup();
    }
  });

  it("remove 后不再可读，并从 journal 重放时保持删除", async () => {
    const { registry, dir, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await registry.upsert(record("sess_A"));
      await registry.remove("sess_A");
      expect(registry.get("sess_A")).toBeUndefined();
      const reloaded = new SessionRegistry({ path: join(dir, "sessions.json") });
      await reloaded.load();
      expect(reloaded.get("sess_A")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("未知会话 bumpEpoch → session.not-found", async () => {
    const { registry, cleanup } = await makeRegistry();
    try {
      await registry.load();
      await expect(registry.bumpEpoch("sess_missing", 2)).rejects.toMatchObject({ code: "session.not-found" });
    } finally {
      await cleanup();
    }
  });

  it("journal 完全不可解析 → session.mapping-corrupt（不静默清空）", async () => {
    const { registry, dir, cleanup } = await makeRegistry();
    try {
      await registry.load();
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "journal.jsonl"), "not-json-line\n{also bad\n", "utf8");
      await writeFile(join(dir, "sessions.json"), "broken", "utf8");
      const broken = new SessionRegistry({ path: join(dir, "sessions.json") });
      await expect(broken.load()).rejects.toMatchObject({ code: "session.mapping-corrupt" });
    } finally {
      await cleanup();
    }
  });
});

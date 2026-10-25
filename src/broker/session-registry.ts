/**
 * 会话注册表（L2 持久化映射：`sessions.json` + append-only `journal.jsonl`）。
 *
 * 契约（C2）：
 * - 记录形状：`childId ↔ { backend, remoteSessionId, cwd, model, createdAt, epoch }`；
 * - `sessions.json` 原子写（临时文件 + rename），避免半写；
 * - `sessions.json` 损坏/不可解析时，从 `journal.jsonl` 重建（映射 = journal 的物化视图，
 *   对应 02-state-machine §7.4：禁止猜测，能重建则重建，重建不出则抛 `session.mapping-corrupt`）。
 */
import { mkdir, readFile, rename, writeFile, appendFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BackendId } from "../abi/types.ts";
import { moclError } from "./errors.ts";

export interface SessionRecord {
  /** ABI 逻辑会话 id（C2 起即 `childId`；与 L4 的 DSH childId 一一对应）。 */
  readonly childId: string;
  readonly backend: BackendId;
  readonly remoteSessionId: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly createdAt: string;
  /** fencing epoch：只增（02-state-machine §5 / INV-L2-2）。 */
  readonly epoch: number;
}

interface RegistryFile {
  readonly version: 1;
  readonly sessions: readonly SessionRecord[];
}

interface JournalRecord {
  readonly op: "upsert" | "remove" | "epoch";
  readonly at: string;
  readonly record?: SessionRecord;
  readonly childId?: string;
  readonly epoch?: number;
}

export interface SessionRegistryOptions {
  /** `sessions.json` 路径（目录不存在会自动创建）。 */
  readonly path: string;
  /** `journal.jsonl` 路径；省略时与 `path` 同目录的 `journal.jsonl`。 */
  readonly journalPath?: string;
}

function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.childId === "string" &&
    typeof v.backend === "string" &&
    typeof v.remoteSessionId === "string" &&
    typeof v.cwd === "string" &&
    (typeof v.model === "string" || v.model === null) &&
    typeof v.createdAt === "string" &&
    typeof v.epoch === "number"
  );
}

/** JSONL 行 → 记录；坏行计数（恢复时容忍尾部半条/坏行，见 02-state-machine §10.1）。 */
function parseJournal(text: string): { records: SessionRecord[]; removed: string[]; epochs: Map<string, number>; badLines: number } {
  const records: SessionRecord[] = [];
  const removed: string[] = [];
  const epochs = new Map<string, number>();
  let badLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as JournalRecord;
      if (parsed.op === "upsert" && parsed.record !== undefined && isRecord(parsed.record)) {
        records.push(parsed.record);
      } else if (parsed.op === "remove" && typeof parsed.childId === "string") {
        removed.push(parsed.childId);
      } else if (parsed.op === "epoch" && typeof parsed.childId === "string" && typeof parsed.epoch === "number") {
        epochs.set(parsed.childId, parsed.epoch);
      } else {
        badLines += 1;
      }
    } catch {
      badLines += 1;
    }
  }
  return { records, removed, epochs, badLines };
}

/** 内存映射 + 双文件持久化。 */
export class SessionRegistry {
  readonly #path: string;
  readonly #journalPath: string;
  readonly #records = new Map<string, SessionRecord>();

  constructor(options: SessionRegistryOptions) {
    if (typeof options.path !== "string" || options.path.length === 0) {
      throw new TypeError("SessionRegistry: path is required");
    }
    this.#path = options.path;
    this.#journalPath = options.journalPath ?? join(dirname(options.path), "journal.jsonl");
  }

  get path(): string {
    return this.#path;
  }

  get journalPath(): string {
    return this.#journalPath;
  }

  /**
   * 加载：优先 `sessions.json`；损坏（读失败/解析失败/结构不符）→ 从 journal 重建。
   * @throws MoclError(`session.mapping-corrupt`) 两处都不可读且无法重建时
   */
  async load(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    let fileText: string | null = null;
    try {
      fileText = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fileText = null;
      }
    }
    if (fileText !== null) {
      try {
        const parsed = JSON.parse(fileText) as RegistryFile;
        if (parsed !== null && parsed.version === 1 && Array.isArray(parsed.sessions) && parsed.sessions.every(isRecord)) {
          this.#records.clear();
          for (const record of parsed.sessions) this.#records.set(record.childId, record);
          return;
        }
      } catch {
        // fall through to journal rebuild
      }
    }
    await this.#rebuildFromJournal();
  }

  async #rebuildFromJournal(): Promise<void> {
    let text = "";
    try {
      text = await readFile(this.#journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // 两个文件都不存在 = 全新仓库；空注册表是合法初始态。
        this.#records.clear();
        return;
      }
      throw moclError("session.mapping-corrupt", {
        message: `registry unreadable and journal unreadable: ${(error as Error).message}`,
      });
    }
    const { records, removed, epochs, badLines } = parseJournal(text);
    if (records.length === 0 && badLines > 0 && text.trim().length > 0) {
      throw moclError("session.mapping-corrupt", {
        message: "journal has no valid records; refusing to guess mapping",
      });
    }
    this.#records.clear();
    for (const record of records) {
      const epoch = epochs.get(record.childId);
      this.#records.set(record.childId, epoch === undefined ? record : { ...record, epoch });
    }
    for (const childId of removed) this.#records.delete(childId);
    await this.#flushFile();
  }

  get(childId: string): SessionRecord | undefined {
    return this.#records.get(childId);
  }

  getByRemoteSessionId(remoteSessionId: string): SessionRecord | undefined {
    for (const record of this.#records.values()) {
      if (record.remoteSessionId === remoteSessionId) return record;
    }
    return undefined;
  }

  list(): readonly SessionRecord[] {
    return [...this.#records.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  get size(): number {
    return this.#records.size;
  }

  /** 写入/更新（原子：临时文件 + rename），并追加 journal。 */
  async upsert(record: SessionRecord): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    this.#records.set(record.childId, record);
    await appendFile(this.#journalPath, JSON.stringify({ op: "upsert", at: record.createdAt, record } satisfies JournalRecord) + "\n", "utf8");
    await this.#flushFile();
  }

  /** 推进 epoch（fencing；只增）。 */
  async bumpEpoch(childId: string, epoch: number): Promise<SessionRecord> {
    const current = this.#records.get(childId);
    if (current === undefined) {
      throw moclError("session.not-found", { message: `session ${childId} not found in registry` });
    }
    if (!Number.isSafeInteger(epoch) || epoch <= current.epoch) {
      throw moclError("session.conflict", { message: `epoch must increase (current=${current.epoch}, next=${epoch})` });
    }
    const next: SessionRecord = { ...current, epoch };
    this.#records.set(childId, next);
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#journalPath, JSON.stringify({ op: "epoch", at: new Date().toISOString(), childId, epoch } satisfies JournalRecord) + "\n", "utf8");
    await this.#flushFile();
    return next;
  }

  async remove(childId: string): Promise<void> {
    if (!this.#records.delete(childId)) return;
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#journalPath, JSON.stringify({ op: "remove", at: new Date().toISOString(), childId } satisfies JournalRecord) + "\n", "utf8");
    await this.#flushFile();
  }

  async #flushFile(): Promise<void> {
    const payload: RegistryFile = { version: 1, sessions: this.list() };
    const tmp = `${this.#path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await rename(tmp, this.#path);
    await rm(tmp, { force: true });
  }
}

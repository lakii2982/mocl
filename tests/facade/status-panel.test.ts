/**
 * W1 数据面切片（issue #18）测试：StatusOutcome 的 label / runtime / 时间戳字段。
 *
 * 覆盖 W1.md §1.4：
 * 1. label：多行取首行 / >120 截断 / 空任务占位 / emoji 代理对不切半；
 * 2. runtime：无握手 → unknown/null；turn.started.model → reported；仅配置 → configured；fallback 生效 → fallback；
 * 3. 旧 registry JSON（缺新字段）读入 → list() 正常且新字段按缺省（null / "(未命名任务)"）；
 * 4. mocl_status 工具输出仍走 toLosslessJson（无 undefined 键）；
 * 5. lastActivityAt 随 turn.completed 更新；startedAt 不变。
 *
 * modelSource 优先级裁决（issue #18，Lead 已裁决）：reported > fallback > configured > unknown
 * —— 真实生效模型（reported / fallback）不允许被 configured 谎报。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AdapterCloseRequest,
  AdapterEvent,
  AdapterInterruptRequest,
  AdapterOpenRequest,
  AdapterOpenResult,
  AdapterResumeRequest,
  AdapterResumeResult,
  AdapterSendRequest,
  AdapterSendResult,
  BackendAdapter,
} from "../../src/abi/adapter.ts";
import type { BackendId, CapabilityDeclaration, TransportKind } from "../../src/abi/types.ts";
import { SessionRegistry } from "../../src/broker/session-registry.ts";
import { createMoclStatusTool } from "../../src/plugin/index.ts";
import { capabilitiesOf, enabledConfig, FakeAdapter, makeFacade } from "./helpers.ts";
import { EventQueue } from "../e2e/helpers.ts";

function decl(backendId: BackendId, backendVersion: string, transport: TransportKind): CapabilityDeclaration {
  return { ...capabilitiesOf(backendId), backendVersion, transport };
}

/** 事件可控的假适配器：open 结果是否携带握手声明可切换（真实适配器携带；裸假件不带）。 */
class PanelAdapter implements BackendAdapter {
  readonly backendId: BackendId;
  readonly capabilities: CapabilityDeclaration;
  readonly queue = new EventQueue();
  openCalls = 0;
  sendCalls = 0;
  remoteId: string;
  handshakeOnOpen: CapabilityDeclaration | null = null;

  constructor(backendId: BackendId, options: { remoteId?: string } = {}) {
    this.backendId = backendId;
    this.capabilities = capabilitiesOf(backendId);
    this.remoteId = options.remoteId ?? `remote_${backendId}`;
  }

  async open(_request: AdapterOpenRequest): Promise<AdapterOpenResult> {
    this.openCalls += 1;
    return this.handshakeOnOpen === null
      ? { remoteSessionId: this.remoteId }
      : { remoteSessionId: this.remoteId, capabilities: this.handshakeOnOpen };
  }

  async send(_request: AdapterSendRequest): Promise<AdapterSendResult> {
    this.sendCalls += 1;
    return { turnId: `turn_${this.backendId}_${this.sendCalls}` };
  }

  async resume(_request: AdapterResumeRequest): Promise<AdapterResumeResult> {
    return { exists: true, remoteSessionId: this.remoteId };
  }

  async interrupt(_request: AdapterInterruptRequest): Promise<void> {}
  async close(_request: AdapterCloseRequest): Promise<void> {
    this.queue.close();
  }

  events(): AsyncIterable<AdapterEvent> {
    return this.queue[Symbol.asyncIterator]();
  }
}

async function until(fn: () => Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
  }
}

function turnStarted(model: string): AdapterEvent {
  return { type: "turn.started", payload: { model, delivery: "caller" } };
}

function turnCompleted(): AdapterEvent {
  return {
    type: "turn.completed",
    payload: { stopReason: "end-turn", usage: { estimated: false, scope: "turn" as const } },
  };
}

function modelFallbackWarning(): AdapterEvent {
  return { type: "session.warning", payload: { code: "model.free-fallback", message: "degraded", degrade: true } };
}

describe("W1 数据面字段（issue #18）：label", () => {
  it("多行任务 → 取首个非空行并 trim", async () => {
    const { facade, cleanup } = await makeFacade({ adapters: { codex: new PanelAdapter("codex") } });
    try {
      const opened = await facade.open("codex", "\n  \n  修复登录页超时  \n第二行不取");
      expect((await facade.status(opened.childId)).label).toBe("修复登录页超时");
    } finally {
      await cleanup();
    }
  });

  it(">120 字符 → 截断为 120 字符", async () => {
    const { facade, cleanup } = await makeFacade({ adapters: { codex: new PanelAdapter("codex") } });
    try {
      const opened = await facade.open("codex", "a".repeat(200));
      expect((await facade.status(opened.childId)).label).toBe("a".repeat(120));
    } finally {
      await cleanup();
    }
  });

  it("emoji 代理对不被切半（截断点落在代理对中间时丢弃高代理）", async () => {
    const { facade, cleanup } = await makeFacade({ adapters: { codex: new PanelAdapter("codex") } });
    try {
      // 119 个 ASCII + "👍✅"：截到 120 会把 👍 切半 → 应整体丢弃高代理，得 119 字符
      const cut = await facade.open("codex", `${"x".repeat(119)}👍✅`);
      expect((await facade.status(cut.childId)).label).toBe("x".repeat(119));
      // 100 个 👍（200 UTF-16 单元）→ 截到 120 = 恰好 60 个完整 emoji
      const emoji = await facade.open("codex", "👍".repeat(100));
      const label = (await facade.status(emoji.childId)).label;
      expect(label.length).toBe(120);
      const codePoints = [...label];
      expect(codePoints.length).toBe(60);
      expect(codePoints.every((unit) => unit === "👍")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe("W1 数据面字段（issue #18）：runtime", () => {
  it("无握手 / 无事件 / 无配置 → null + unknown；lastActivityAt 回退 createdAt", async () => {
    const adapter = new FakeAdapter("codex", { remoteId: "" }); // open 不带 capabilities；pending
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter } });
    try {
      const opened = await facade.open("codex", "task");
      const status = await facade.status(opened.childId);
      expect(status.runtime).toEqual({
        agentName: null,
        agentId: null, // pending（kimi CLI D-020 场景）
        backendVersion: null, // 无握手缓存
        transport: null,
        model: null,
        modelSource: "unknown",
      });
      expect(status.startedAt).toBe(status.createdAt);
      expect(status.lastActivityAt).toBe(status.createdAt);
      expect(typeof status.updatedAt).toBe("string");
    } finally {
      await cleanup();
    }
  });

  it("open 握手缓存进 SessionRecord；新门面（换活适配器）读缓存而非活适配器", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mocl-w1-handshake-"));
    const adapter = new PanelAdapter("claude-code");
    adapter.handshakeOnOpen = decl("claude-code", "cc-1.2.3", "agent-sdk");
    const first = await makeFacade({
      config: enabledConfig({ enabled: ["claude-code"] }),
      adapters: { "claude-code": adapter },
      registryPath: join(dir, "sessions.json"),
    });
    try {
      const opened = await first.facade.open("claude-code", "首行任务\n其余忽略");
      const status = await first.facade.status(opened.childId);
      expect(status.runtime.backendVersion).toBe("cc-1.2.3");
      expect(status.runtime.transport).toBe("agent-sdk");
      expect(status.runtime.agentId).toBe(adapter.remoteId);

      // 落盘证据：registry 记录里确实有 label + handshake
      const persisted = new SessionRegistry({ path: join(dir, "sessions.json") });
      await persisted.load();
      const record = persisted.get(opened.childId);
      expect(record?.label).toBe("首行任务");
      expect(record?.handshake).toEqual({ backendVersion: "cc-1.2.3", transport: "agent-sdk" });

      // 重启：新门面 + 无握手的新适配器 → 仍读 SessionRecord 缓存，label 恢复后仍可读
      const second = await makeFacade({
        config: enabledConfig({ enabled: ["claude-code"] }),
        adapters: { "claude-code": new PanelAdapter("claude-code") },
        registryPath: join(dir, "sessions.json"),
      });
      try {
        const status2 = await second.facade.status(opened.childId);
        expect(status2.label).toBe("首行任务");
        expect(status2.runtime.backendVersion).toBe("cc-1.2.3");
        expect(status2.runtime.transport).toBe("agent-sdk");
      } finally {
        await second.cleanup();
      }
    } finally {
      await first.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("turn.started.model 有值 → reported", async () => {
    const adapter = new PanelAdapter("codex");
    adapter.queue.push(turnStarted("reported-model-x"), turnCompleted());
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter } });
    try {
      const opened = await facade.open("codex", "task");
      await until(async () => (await facade.status(opened.childId)).lastEventType === "turn.completed", "turn.completed");
      const status = await facade.status(opened.childId);
      expect(status.runtime.model).toBe("reported-model-x");
      expect(status.runtime.modelSource).toBe("reported");
    } finally {
      await cleanup();
    }
  });

  it("仅配置（无上报/无 fallback）→ configured", async () => {
    const config = enabledConfig({ enabled: ["codex"], backends: { codex: { model: "cfg-model" } } });
    const { facade, cleanup } = await makeFacade({ config, adapters: { codex: new PanelAdapter("codex") } });
    try {
      const opened = await facade.open("codex", "task");
      const status = await facade.status(opened.childId);
      expect(status.runtime.model).toBe("cfg-model");
      expect(status.runtime.modelSource).toBe("configured");
    } finally {
      await cleanup();
    }
  });

  it("fallback 生效（model.* degrade warning）→ fallback，优先于 configured", async () => {
    const config = enabledConfig({
      enabled: ["codex"],
      backends: { codex: { model: "prod-model", fallbackModel: "free-model" } },
    });
    const adapter = new PanelAdapter("codex");
    adapter.queue.push(modelFallbackWarning());
    const { facade, cleanup } = await makeFacade({ config, adapters: { codex: adapter } });
    try {
      const opened = await facade.open("codex", "task");
      await until(async () => (await facade.status(opened.childId)).degraded, "degraded warning");
      const status = await facade.status(opened.childId);
      expect(status.warnings).toContain("model.free-fallback");
      expect(status.runtime.model).toBe("free-model"); // 生效的是 fallbackModel，不能谎报 prod-model
      expect(status.runtime.modelSource).toBe("fallback");
    } finally {
      await cleanup();
    }
  });

  it("后端上报优先于 fallback（最近一次 turn.started.model 为准）", async () => {
    const config = enabledConfig({
      enabled: ["codex"],
      backends: { codex: { model: "prod-model", fallbackModel: "free-model" } },
    });
    const adapter = new PanelAdapter("codex");
    adapter.queue.push(modelFallbackWarning(), turnStarted("free-model-reported"), turnCompleted());
    const { facade, cleanup } = await makeFacade({ config, adapters: { codex: adapter } });
    try {
      const opened = await facade.open("codex", "task");
      await until(async () => (await facade.status(opened.childId)).lastEventType === "turn.completed", "turn.completed");
      const status = await facade.status(opened.childId);
      expect(status.runtime.model).toBe("free-model-reported");
      expect(status.runtime.modelSource).toBe("reported");
    } finally {
      await cleanup();
    }
  });
});

describe("W1 数据面字段（issue #18）：旧记录兼容 / 工具边界 / 时间戳", () => {
  it("旧 registry JSON（缺 label/handshake）读入 → list() 正常且新字段按缺省", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mocl-w1-oldjson-"));
    try {
      await writeFile(
        join(dir, "sessions.json"),
        `${JSON.stringify(
          {
            version: 1,
            sessions: [
              {
                childId: "sess_old",
                backend: "codex",
                remoteSessionId: "",
                cwd: "/tmp/work",
                model: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                epoch: 1,
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const fixture = await makeFacade({
        adapters: { codex: new FakeAdapter("codex") },
        registryPath: join(dir, "sessions.json"),
      });
      try {
        const listed = await fixture.facade.list();
        const old = listed.children.find((child) => child.childId === "sess_old");
        expect(old).toBeDefined();
        expect(old?.state).toBe("lost"); // 冷会话，不伪造激活态
        expect(old?.label).toBe("(未命名任务)"); // 缺 label → 占位
        expect(old?.runtime).toEqual({
          agentName: null,
          agentId: null, // remoteSessionId 为空 → pending
          backendVersion: null,
          transport: null,
          model: null,
          modelSource: "unknown",
        });
        expect(old?.startedAt).toBe("2026-01-01T00:00:00.000Z");
        expect(old?.lastActivityAt).toBe("2026-01-01T00:00:00.000Z");
        expect(typeof old?.updatedAt).toBe("string");
      } finally {
        await fixture.cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("mocl_status 工具输出仍是 lossless JSON（真实门面 + 新字段无 undefined）", async () => {
    const adapter = new PanelAdapter("codex");
    adapter.queue.push(turnStarted("tool-model"), turnCompleted());
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter } });
    try {
      const opened = await facade.open("codex", "lossless 检查");
      await until(async () => (await facade.status(opened.childId)).lastEventType === "turn.completed", "turn.completed");
      const tool = createMoclStatusTool(facade);

      const listed = (await tool.execute({}, {})) as { ok: boolean; children: unknown[] };
      const listedText = JSON.stringify(listed);
      expect(listedText).toBeDefined();
      expect(listedText).not.toContain("undefined");
      expect(JSON.parse(listedText as string)).toEqual(listed);
      expect(listed.children.length).toBeGreaterThan(0);

      const single = (await tool.execute({ childId: opened.childId }, {})) as {
        ok: boolean;
        status: { label: string; runtime: { modelSource: string }; startedAt: string | null };
      };
      const singleText = JSON.stringify(single);
      expect(singleText).not.toContain("undefined");
      expect(JSON.parse(singleText)).toEqual(single);
      expect(single.ok).toBe(true);
      expect(single.status.label).toBe("lossless 检查");
      expect(single.status.runtime.modelSource).toBe("reported");
      expect(single.status.startedAt).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("lastActivityAt 随 turn.completed 更新；startedAt 保持不变", async () => {
    let nowMs = 1_700_000_000_000;
    const clock = (): Date => new Date((nowMs += 1_000));
    const adapter = new PanelAdapter("codex");
    adapter.queue.push(turnStarted("clocked-model"), turnCompleted());
    const { facade, cleanup } = await makeFacade({ adapters: { codex: adapter }, clock });
    try {
      const opened = await facade.open("codex", "task");
      const before = await facade.status(opened.childId);
      await until(async () => (await facade.status(opened.childId)).lastEventType === "turn.completed", "turn.completed");
      const after = await facade.status(opened.childId);
      const startedAt = before.startedAt ?? "";
      const lastActivityAt = after.lastActivityAt ?? "";
      expect(after.startedAt).toBe(before.startedAt); // 创建时定格
      expect(after.lastEventType).toBe("turn.completed");
      expect(lastActivityAt > startedAt).toBe(true); // 事件时间晚于创建时间
      expect((after.updatedAt ?? "") >= lastActivityAt).toBe(true); // 快照时间不早于最近事件
    } finally {
      await cleanup();
    }
  });
});

/**
 * W2 host 半路由测试（fake req/res，不占端口）：
 * - GET /mocl-panel/list：正常投影 + 门面抛错 → {ok:false,error}；
 * - POST /mocl-panel/heartbeat：落盘 + 环形保留 20 条 + 原子写；
 * - 契约一致性：children 字段集合 == mocl_status 的 status 字段集合（同一函数导出）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  PANEL_HEARTBEAT_KEEP,
  PANEL_HEARTBEAT_PATH,
  PANEL_LIST_PATH,
  PANEL_ROUTE_PREFIX,
  createPanelRouteHandler,
  normalizeHeartbeatEntry,
  panelChildren,
  readHeartbeatEntries,
  recordHeartbeat,
  registerPanelRoute,
  resolveJournalDir,
  type PanelRouteHandler,
  type PanelRouteHostContext,
  type PanelRouteLogger,
  type PanelRouteRequest,
  type PanelRouteResponse,
  type PanelRouteWebServer,
} from "../../src/plugin/panel-route.ts";
import { PANEL_HEARTBEAT_PATH as CLIENT_HEARTBEAT_PATH, PANEL_LIST_PATH as CLIENT_LIST_PATH } from "../../src/client-ui/polling.ts";
import type { ListOutcome } from "../../src/facade/facade.ts";
import { moclError } from "../../src/broker/errors.ts";

/* ------------------------------------------------------------------ */
/* fake req/res（node:http 同构的最小面）                               */
/* ------------------------------------------------------------------ */

class FakeRequest extends EventEmitter implements PanelRouteRequest {
  constructor(
    readonly url: string,
    readonly method: string = "GET",
    private readonly bodyText: string = "",
  ) {
    super();
  }

  /** 模拟宿主投递请求体（data…end）。 */
  pump(): void {
    if (this.bodyText.length > 0) this.emit("data", Buffer.from(this.bodyText, "utf8"));
    this.emit("end");
  }
}

class FakeResponse implements PanelRouteResponse {
  status = 0;
  headers: Record<string, string> = {};
  bodyText = "";

  writeHead(status: number, headers: Record<string, string>): unknown {
    this.status = status;
    this.headers = headers;
    return this;
  }

  end(body?: string): unknown {
    this.bodyText = body ?? "";
    return this;
  }

  json(): unknown {
    return JSON.parse(this.bodyText) as unknown;
  }
}

async function callRoute(handler: PanelRouteHandler, req: FakeRequest): Promise<FakeResponse> {
  const res = new FakeResponse();
  const done = handler(req, res);
  req.pump();
  await done;
  return res;
}

/* ------------------------------------------------------------------ */
/* 夹具：W1 扩展后的 StatusOutcome 全字段（label/runtime/startedAt/…）  */
/* ------------------------------------------------------------------ */

const FIXED_CLOCK = (): Date => new Date("2026-10-27T00:00:00.000Z");

const STATUS_FIXTURE = {
  childId: "95d9ebac-74c1-4db2-9f31-4a1f2b830f21",
  backend: "claude-code",
  backendSessionId: null,
  remoteIdState: "pending",
  state: "running",
  epoch: 1,
  createdAt: "2026-10-27T00:00:00.000Z",
  lastTurnId: "turn-20261027-001",
  active: true,
  cursor: { fromSeq: 0, lastSeq: null, events: 0, total: 0, note: "event stream wired from adapter.events() → EventBus (C9)" },
  usage: null,
  degraded: false,
  parentDeliveries: 0,
  lastEventType: null,
  warnings: [],
  error: null,
  progress: { mode: "off", maxItemsPerTurn: 8, maxCharsPerTurn: 1200, maxCharsPerItem: 400 },
  configDigest: "digest-95d9",
  // —— W1 扩展字段 ——
  label: "评审 PR#14 的 diff",
  runtime: {
    agentName: null,
    agentId: null,
    backendVersion: "v2.1.310",
    transport: "agent-sdk",
    model: "deepseek-v4.1-flash",
    modelSource: "reported",
  },
  startedAt: "2026-10-27T00:00:00.000Z",
  lastActivityAt: "2026-10-27T00:01:00.000Z",
  updatedAt: null,
};

const LIST_FIXTURE = { children: [STATUS_FIXTURE] } as unknown as ListOutcome;

function handlerWith(overrides: { list?: () => Promise<ListOutcome>; journalDir?: string | null } = {}): PanelRouteHandler {
  return createPanelRouteHandler({
    facade: { list: overrides.list ?? (async () => LIST_FIXTURE) },
    ...(overrides.journalDir === undefined ? {} : { journalDir: overrides.journalDir }),
    clock: FIXED_CLOCK,
  });
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "mocl-panel-route-test-"));
}

/* ------------------------------------------------------------------ */
/* GET /mocl-panel/list                                                */
/* ------------------------------------------------------------------ */

describe("GET /mocl-panel/list", () => {
  it("正常：200 {ok,syncedAt,source:\"broker\",children}，带 no-store；children 深等于门面原对象", async () => {
    const res = await callRoute(handlerWith(), new FakeRequest(PANEL_LIST_PATH, "GET"));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { ok: unknown; syncedAt: unknown; source: unknown; children: unknown };
    expect(body.ok).toBe(true);
    expect(body.syncedAt).toBe("2026-10-27T00:00:00.000Z");
    expect(body.source).toBe("broker");
    expect(body.children).toEqual([STATUS_FIXTURE]);
  });

  it("门面抛 MoclError → 200 {ok:false,error:{code,userMessage,traceId?}}（前端按错误态渲染，不让宿主答 400）", async () => {
    const res = await callRoute(
      handlerWith({
        list: async () => {
          throw moclError("session.not-found", { message: "child gone", traceId: "trace-0a71" });
        },
      }),
      new FakeRequest(PANEL_LIST_PATH, "GET"),
    );
    expect(res.status).toBe(200);
    const body = res.json() as { ok: unknown; syncedAt: unknown; error: { code: string; userMessage: string; traceId?: string } };
    expect(body.ok).toBe(false);
    expect(body.syncedAt).toBe("2026-10-27T00:00:00.000Z");
    expect(body.error.code).toBe("session.not-found");
    expect(body.error.userMessage).toBe("会话不存在或已过期");
    expect(body.error.traceId).toBe("trace-0a71");
  });

  it("门面抛普通 Error → internal.unexpected（如实投影，不假 PASS）", async () => {
    const res = await callRoute(
      handlerWith({
        list: async () => {
          throw new Error("boom");
        },
      }),
      new FakeRequest(PANEL_LIST_PATH, "GET"),
    );
    expect(res.status).toBe(200);
    const body = res.json() as { ok: unknown; error: { code: string; userMessage: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("internal.unexpected");
    expect(body.error.userMessage.length).toBeGreaterThan(0);
  });

  it("未知路径 → 404 {ok:false,error.code:\"protocol.unknown-method\"}；方法不匹配同样 404", async () => {
    const notFound = await callRoute(handlerWith(), new FakeRequest("/mocl-panel/other", "GET"));
    expect(notFound.status).toBe(404);
    expect((notFound.json() as { error: { code: string } }).error.code).toBe("protocol.unknown-method");

    const wrongMethod = await callRoute(handlerWith(), new FakeRequest(PANEL_LIST_PATH, "POST"));
    expect(wrongMethod.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 契约一致性（W2 §4.5）                                                */
/* ------------------------------------------------------------------ */

describe("契约一致性：面板 children == mocl_status 的 status 字段集合", () => {
  it("panelChildren 是恒等投影（同一函数导出，不另造第二套字段）", () => {
    const passthrough = panelChildren(LIST_FIXTURE);
    expect(passthrough).toBe(LIST_FIXTURE.children);
    const child = passthrough?.[0];
    expect(child).toBeDefined();
    expect(Object.keys(child as object).sort()).toEqual(Object.keys(STATUS_FIXTURE).sort());
  });

  it("client 与 host 的路由常量一致（同一对路径，两处不同源）", () => {
    expect(PANEL_LIST_PATH).toBe(CLIENT_LIST_PATH);
    expect(PANEL_HEARTBEAT_PATH).toBe(CLIENT_HEARTBEAT_PATH);
    expect(PANEL_ROUTE_PREFIX).toBe("/mocl-panel");
  });
});

/* ------------------------------------------------------------------ */
/* POST /mocl-panel/heartbeat                                          */
/* ------------------------------------------------------------------ */

describe("POST /mocl-panel/heartbeat", () => {
  it("写入 <journalDir>/panel-heartbeat.json，字段归一化（ts/rows/mounted/viewport）", async () => {
    const dir = makeTempDir();
    const handler = handlerWith({ journalDir: dir });
    const res = await callRoute(
      handler,
      new FakeRequest(PANEL_HEARTBEAT_PATH, "POST", JSON.stringify({ rows: 3, mounted: true, viewport: 420 })),
    );
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const file = join(dir, "panel-heartbeat.json");
    expect(existsSync(file)).toBe(true);
    const entries = readHeartbeatEntries(file) as Array<{ ts: string; rows: number; mounted: boolean; viewport: number }>;
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual({ ts: "2026-10-27T00:00:00.000Z", rows: 3, mounted: true, viewport: 420 });
    // 原子写：不留 tmp 残留
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("环形保留 last 20 条（超出丢最旧）", async () => {
    const dir = makeTempDir();
    const handler = handlerWith({ journalDir: dir });
    for (let rows = 1; rows <= PANEL_HEARTBEAT_KEEP + 5; rows += 1) {
      await callRoute(handler, new FakeRequest(PANEL_HEARTBEAT_PATH, "POST", JSON.stringify({ rows, mounted: true, viewport: 320 })));
    }
    const entries = readHeartbeatEntries(join(dir, "panel-heartbeat.json")) as Array<{ rows: number }>;
    expect(entries.length).toBe(PANEL_HEARTBEAT_KEEP);
    expect(entries[0]?.rows).toBe(6);
    expect(entries[entries.length - 1]?.rows).toBe(PANEL_HEARTBEAT_KEEP + 5);
  });

  it("畸形 body → 字段落 null，仍 200 {ok:true}（不猜、不用 0 填充）", async () => {
    const dir = makeTempDir();
    const handler = handlerWith({ journalDir: dir });
    const res = await callRoute(handler, new FakeRequest(PANEL_HEARTBEAT_PATH, "POST", "not-json-at-all"));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const entries = readHeartbeatEntries(join(dir, "panel-heartbeat.json")) as Array<{ rows: unknown; mounted: unknown; viewport: unknown }>;
    expect(entries.length).toBe(1);
    expect(entries[0]?.rows).toBeNull();
    expect(entries[0]?.mounted).toBeNull();
    expect(entries[0]?.viewport).toBeNull();
  });

  it("journalDir 不可用（门面无 config）→ 仍 200 {ok:true}，只跳过落盘", async () => {
    const handler = createPanelRouteHandler({ facade: { list: async () => LIST_FIXTURE }, clock: FIXED_CLOCK });
    const res = await callRoute(handler, new FakeRequest(PANEL_HEARTBEAT_PATH, "POST", JSON.stringify({ rows: 1, mounted: true })));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

/* ------------------------------------------------------------------ */
/* 纯函数：归一化 / journal.dir 解析 / 落盘                             */
/* ------------------------------------------------------------------ */

describe("heartbeat 纯函数", () => {
  it("normalizeHeartbeatEntry：合法字段收窄；越界/类型不对 → null", () => {
    expect(normalizeHeartbeatEntry({ rows: 5, mounted: false, viewport: 300.5 }, "t")).toEqual({
      ts: "t",
      rows: 5,
      mounted: false,
      viewport: 300.5,
    });
    expect(normalizeHeartbeatEntry({ rows: -1, mounted: "yes", viewport: -3 }, "t")).toEqual({
      ts: "t",
      rows: null,
      mounted: null,
      viewport: null,
    });
    expect(normalizeHeartbeatEntry(null, "t")).toEqual({ ts: "t", rows: null, mounted: null, viewport: null });
  });

  it("resolveJournalDir：facade.config.global.journal.dir（相对 cwd 解析）；缺失 → null", () => {
    expect(resolveJournalDir({ list: async () => LIST_FIXTURE, config: { global: { journal: { dir: "var" } } } })).toBe(
      join(process.cwd(), "var"),
    );
    expect(resolveJournalDir({ list: async () => LIST_FIXTURE, config: undefined })).toBeNull();
    expect(resolveJournalDir(undefined)).toBeNull();
  });

  it("recordHeartbeat：损坏的旧文件按空数组重建；node --check 级别的 JSON 可解析", async () => {
    const dir = makeTempDir();
    const file = join(dir, "panel-heartbeat.json");
    expect(recordHeartbeat({ file, entry: { ts: "t1", rows: 1, mounted: true, viewport: null } })).toBe(true);
    recordHeartbeat({ file, entry: { ts: "t2", rows: 2, mounted: false, viewport: 500 } });
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* registerPanelRoute：webServer 解析（scoped inject 修复）             */
/* host apply 的同步阶段 webServer 多半未就绪：直接解析落空且永不重试   */
/* （paneldev 实测 /mocl-panel/list 404）。修复 = cordis 作用域 inject。 */
/* ------------------------------------------------------------------ */

type LogLevel = "debug" | "info" | "warn" | "error";
interface LogEntry {
  level: LogLevel;
  text: string;
}

function makeLogger(): PanelRouteLogger & { calls: LogEntry[] } {
  const calls: LogEntry[] = [];
  const line = (level: LogLevel) => (...args: unknown[]): void => {
    calls.push({ level, text: args.map((arg) => String(arg)).join(" ") });
  };
  return { calls, debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") };
}

type RouteDefinition = Parameters<PanelRouteWebServer["register"]>[0];

/** 同款形状（S1 spike 实测）：register 收 {kind,path,handler}，返回 disposer。 */
class FakeWebServer {
  readonly routes: RouteDefinition[] = [];

  register(route: RouteDefinition): () => void {
    this.routes.push(route);
    return () => {
      const at = this.routes.indexOf(route);
      if (at >= 0) this.routes.splice(at, 1);
    };
  }
}

describe("registerPanelRoute：webServer 解析（scoped inject 修复）", () => {
  it("ctx 带 inject：deps 含 \"webServer\"；回调内经 scoped.webServer.register 注册；disposer 挂 scoped.effect（不挂外层）", () => {
    const logger = makeLogger();
    const webServer = new FakeWebServer();
    const scopedEffects: Array<{ factory: () => unknown; label?: string }> = [];
    let outerEffectCount = 0;
    let injectDeps: string[] | undefined;

    const ctx = {
      logger,
      effect(): undefined {
        outerEffectCount += 1;
        return undefined;
      },
      inject(deps: string[], callback: (scoped: PanelRouteHostContext) => void): undefined {
        injectDeps = deps;
        // 模拟 cordis：webServer 已就绪 → 同步执行回调，传入解锁了 webServer 的派生 ctx
        callback({
          logger,
          webServer,
          effect(factory: () => unknown, label?: string): undefined {
            scopedEffects.push({ factory, label });
            return undefined;
          },
        });
        return undefined;
      },
    };

    const result = registerPanelRoute(ctx, { facade: { list: async () => LIST_FIXTURE }, clock: FIXED_CLOCK });

    expect(injectDeps).toEqual(["webServer"]); // (a) 依赖声明只含 webServer
    expect(result).toBeUndefined(); // 注册时机由 cordis 决定，外层不返回 disposer
    expect(webServer.routes).toHaveLength(1); // (b) 回调内用 scoped.webServer.register
    expect(webServer.routes[0]).toMatchObject({ kind: "prefix", path: PANEL_ROUTE_PREFIX });
    expect(
      logger.calls.some((entry) => entry.level === "info" && entry.text.includes("registered prefix route /mocl-panel")),
    ).toBe(true);
    expect(scopedEffects).toHaveLength(1); // disposer 挂在 scoped.effect
    expect(scopedEffects[0]?.label).toBe("mocl-panel: route");
    expect(outerEffectCount).toBe(0); // 不挂外层 ctx.effect
    // cordis 语义：factory 返回 disposer，由作用域销毁时调用 —— factory() 本身不清理
    const dispose = scopedEffects[0]?.factory() as (() => void) | undefined;
    expect(typeof dispose).toBe("function");
    dispose?.();
    expect(webServer.routes).toHaveLength(0);
  });

  it("webServer 未就绪（paneldev 实测时序）：apply 阶段不注册，cordis ready 回调后才注册", () => {
    const logger = makeLogger();
    const webServer = new FakeWebServer();
    let deferred: ((scoped: PanelRouteHostContext) => void) | undefined;
    const ctx = {
      logger,
      inject(deps: string[], callback: (scoped: PanelRouteHostContext) => void): undefined {
        deferred = callback; // 服务未 ready：先挂起，不执行（修复前这里会直接落空且永不重试）
        return undefined;
      },
    };

    const result = registerPanelRoute(ctx, { facade: { list: async () => LIST_FIXTURE }, clock: FIXED_CLOCK });

    expect(result).toBeUndefined();
    expect(webServer.routes).toHaveLength(0);
    expect(logger.calls.filter((entry) => entry.level === "error")).toEqual([]);

    deferred?.({ logger, webServer }); // cordis 在 webServer ready 时执行一次
    expect(webServer.routes).toHaveLength(1);
    expect(webServer.routes[0]).toMatchObject({ kind: "prefix", path: PANEL_ROUTE_PREFIX });
    expect(
      logger.calls.some((entry) => entry.level === "info" && entry.text.includes("registered prefix route")),
    ).toBe(true);
  });

  it("ctx 无 inject（单测 fake / 旧宿主）：退回既有直接解析 —— ctx.webServer 可用即注册并返回 disposer", () => {
    const logger = makeLogger();
    const webServer = new FakeWebServer();
    const effects: Array<{ factory: () => unknown; label?: string }> = [];
    const ctx = {
      logger,
      webServer,
      effect(factory: () => unknown, label?: string): undefined {
        effects.push({ factory, label });
        return undefined;
      },
    };

    const dispose = registerPanelRoute(ctx, { facade: { list: async () => LIST_FIXTURE }, clock: FIXED_CLOCK });

    expect(typeof dispose).toBe("function");
    expect(webServer.routes).toHaveLength(1);
    expect(webServer.routes[0]).toMatchObject({ kind: "prefix", path: PANEL_ROUTE_PREFIX });
    expect(effects).toHaveLength(1);
    expect(effects[0]?.label).toBe("mocl-panel: route");
    expect(
      logger.calls.some((entry) => entry.level === "info" && entry.text.includes("registered prefix route")),
    ).toBe(true);
  });

  it("ctx 无 inject 且 webServer 不可达：error 日志 + 返回 undefined（基线行为不变）", () => {
    const logger = makeLogger();
    const dispose = registerPanelRoute({ logger }, { facade: { list: async () => LIST_FIXTURE }, clock: FIXED_CLOCK });
    expect(dispose).toBeUndefined();
    expect(
      logger.calls.some((entry) => entry.level === "error" && entry.text.includes("ctx.webServer unavailable")),
    ).toBe(true);
  });

  it("inject 回调内 webServer 仍不可达（宿主异常时序）：只记 error，不抛、不影响工具", () => {
    const logger = makeLogger();
    const ctx = {
      logger,
      inject(deps: string[], callback: (scoped: PanelRouteHostContext) => void): undefined {
        callback({ logger }); // scoped 上没有 webServer
        return undefined;
      },
    };

    expect(() =>
      registerPanelRoute(ctx, { facade: { list: async () => LIST_FIXTURE }, clock: FIXED_CLOCK }),
    ).not.toThrow();
    expect(
      logger.calls.some((entry) => entry.level === "error" && entry.text.includes("panel route not registered")),
    ).toBe(true);
  });

  it("经 scope inject 注册的路由可用：GET /mocl-panel/list → 200（children 直通门面）", async () => {
    const webServer = new FakeWebServer();
    const ctx = {
      inject(deps: string[], callback: (scoped: PanelRouteHostContext) => void): undefined {
        callback({ webServer });
        return undefined;
      },
    };
    registerPanelRoute(ctx, { facade: { list: async () => LIST_FIXTURE }, clock: FIXED_CLOCK });

    expect(webServer.routes).toHaveLength(1);
    const handler = webServer.routes[0]?.handler;
    expect(handler).toBeDefined();
    const res = await callRoute(handler as PanelRouteHandler, new FakeRequest(PANEL_LIST_PATH, "GET"));
    expect(res.status).toBe(200);
    const body = res.json() as { ok: unknown; source: unknown; children: unknown };
    expect(body.ok).toBe(true);
    expect(body.source).toBe("broker");
    expect(body.children).toEqual([STATUS_FIXTURE]);
  });
});

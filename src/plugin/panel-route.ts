/**
 * 面板数据路由（W2 host 半）—— 由 src/plugin/index.ts 的 apply 调用。
 *
 * 契约（.agentspec/issues/18/W2.md §1）：
 *   GET  /mocl-panel/list
 *     200 {"ok":true,"syncedAt":"<ISO>","source":"broker","children":[StatusOutcome...]}
 *     失败 200 {"ok":false,"syncedAt":...,"error":{code,userMessage,traceId?}}
 *   POST /mocl-panel/heartbeat   body {"rows":N,"mounted":true,"viewport":px}
 *     → 200 {"ok":true}；落盘 <journal.dir>/panel-heartbeat.json（tmp+rename 原子写，环形保留 20 条）
 *
 * 硬事实（S1 spike 实测，见 spike/REPORT.md）：
 * - 路由对象形状 `{ kind: "prefix"|"exact", path, handler }`；重复 (kind,path) 抛错；
 *   handler 抛错由宿主答 400；req.url 是完整路径（spike 以 /mocl-panel/ping 全名匹配成功）。
 * - 只读门面：复用 apply 里同一个 facade ready Promise，不新建门面。
 * - DshHostContext 类型未声明 webServer（dsh-types.d.ts 基线 0.2.1-rc.3）：先试属性访问
 *   （cordis 未 inject 会抛，需捕获），再退 `ctx.get("webServer")`（不受 inject 限制）。
 *   解析失败只记日志、不影响工具注册。
 * - 时序（paneldev 实测 404）：host 插件 apply 的同步阶段 webServer 服务多半尚未就绪，
 *   直接解析必然落空且永不重试。registerPanelRoute 改走 cordis 作用域 inject：
 *   `ctx.inject(["webServer"], cb)` —— cb 由 cordis 在 webServer ready 时执行一次（已 ready
 *   则同步），路由 disposer 挂 scoped.effect，插件卸载时随作用域自动清理；无 inject 成员的
 *   ctx（单测 fake / 旧宿主）退回既有直接解析兜底。禁止改成插件级 `inject = ["webServer"]`：
 *   headless/tui profile 没有该服务，插件级声明会让整个插件（含工具）永远 pending —— 工具消失，回归。
 * - SSE（/mocl-panel/events）为 P1，不实现；v1 前端 2s 轮询（本响应带 no-store）。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ListOutcome } from "../facade/facade.ts";
import { toErrorRef } from "../facade/errors.ts";

export const PANEL_ROUTE_PREFIX = "/mocl-panel";
export const PANEL_LIST_PATH = "/mocl-panel/list";
export const PANEL_HEARTBEAT_PATH = "/mocl-panel/heartbeat";
export const PANEL_LIST_SOURCE = "broker";
/** 心跳环形保留条数（W2 §1：last 20 条）。 */
export const PANEL_HEARTBEAT_KEEP = 20;
const HEARTBEAT_BODY_LIMIT_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ */
/* 类型（宿主/请求/响应的最小结构面；不依赖未声明的 dsh-types 字段） */
/* ------------------------------------------------------------------ */

export interface PanelRouteLogger {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

export interface PanelRouteRequest {
  readonly method?: string;
  readonly url?: string;
  on(event: string, listener: (chunk?: unknown) => void): unknown;
  destroy?(): void;
}

export interface PanelRouteResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
}

export type PanelRouteHandler = (req: PanelRouteRequest, res: PanelRouteResponse) => Promise<void>;

export interface PanelRouteWebServer {
  /** 返回 disposer（S1 实测：register 返回函数；形状探测时容忍其它返回值）。 */
  register(route: {
    readonly kind: "exact" | "prefix";
    readonly path: string;
    readonly handler: PanelRouteHandler;
  }): unknown;
}

/** 与 DshHostContext 结构兼容（logger?/get? 均可缺），index.ts 可直接透传 ctx。 */
export interface PanelRouteHostContext {
  readonly logger?: PanelRouteLogger;
  /**
   * cordis 注入代理下的服务属性：插件未声明依赖时属性访问会抛（必须经 resolveWebServer
   * 的 try/catch），仅在作用域 inject 回调的 scoped ctx 上保证可用。
   */
  readonly webServer?: PanelRouteWebServer;
  effect?(factory: () => unknown, label?: string): unknown;
  get?(service: string): unknown;
  /**
   * cordis 作用域 inject（Context 原型成员，不受注入代理限制）：deps 里的服务 ready 时
   * 执行一次 callback（入参 scoped 解锁 deps 的属性访问）；callback 内挂到 scoped.effect
   * 的 disposer 随插件卸载自动清理。缺此成员的 ctx（单测 fake / 旧宿主）由调用方退回直接解析。
   */
  inject?(deps: string[], callback: (scoped: PanelRouteHostContext) => void): unknown;
}

/** 只读门面视图：MoclFacadeLike 满足；`config` 用于解析 journal.dir（MoclFacade 有该 getter）。 */
export interface PanelFacadeSource {
  list(): Promise<ListOutcome>;
  config?: unknown;
}

export interface PanelRouteDeps {
  /** apply 里同一个 ready Promise（或已就绪实例）；禁止在此新建门面。 */
  readonly facade: PanelFacadeSource | Promise<PanelFacadeSource>;
  /** 心跳落盘目录；缺省从 `facade.config.global.journal.dir` 解析（相对 cwd）。 */
  readonly journalDir?: string | null;
  readonly clock?: () => Date;
  readonly logger?: PanelRouteLogger;
  readonly heartbeatKeep?: number;
}

/* ------------------------------------------------------------------ */
/* 契约一致性（W2 §4.5）：children 就是 facade.list() 的原对象，不经转手 */
/* ------------------------------------------------------------------ */

/** 唯一投影函数：mocl_status 的 status 字段集合 == 面板 children 字段集合（同一函数导出，避免两套）。 */
export function panelChildren(list: ListOutcome): ListOutcome["children"] {
  return list.children;
}

/* ------------------------------------------------------------------ */
/* webServer 解析与注册                                                */
/* ------------------------------------------------------------------ */

function isWebServer(value: unknown): value is PanelRouteWebServer {
  return typeof value === "object" && value !== null && typeof (value as { register?: unknown }).register === "function";
}

/** 先属性访问（try/catch：cordis 未 inject 会抛），再 `ctx.get("webServer")`。 */
export function resolveWebServer(ctx: PanelRouteHostContext): PanelRouteWebServer | undefined {
  try {
    const direct = ctx.webServer;
    if (isWebServer(direct)) return direct;
  } catch {
    // cordis: 未 inject 的服务属性访问会抛 —— 走 ctx.get 兜底。
  }
  try {
    const viaGet = ctx.get?.("webServer");
    if (isWebServer(viaGet)) return viaGet;
  } catch {
    // 服务不存在：按无 webServer 处理。
  }
  return undefined;
}

export function resolveJournalDir(facade: PanelFacadeSource | undefined | null): string | null {
  const config = facade?.config as { global?: { journal?: { dir?: unknown } } } | undefined;
  const dir = config?.global?.journal?.dir;
  if (typeof dir !== "string" || dir.length === 0) return null;
  return resolve(process.cwd(), dir);
}

/**
 * 注册面板路由（best-effort），两条路径：
 * - 真实宿主 ctx 带 cordis 作用域 inject：回调由 cordis 在 webServer ready 时执行一次
 *   （已 ready 则同步）——修掉「apply 同步阶段 webServer 未就绪 → 直接解析落空且永不重试」
 *   的时序缺陷；路由 disposer 挂 scoped.effect，插件卸载时随作用域清理。本函数同步返回
 *   undefined（注册时机由 cordis 决定；index.ts 不消费返回值）。
 * - 缺 inject 成员的 ctx（单测 fake / 旧宿主）：退回既有直接解析（行为同基线）。
 * 不改插件级 `inject` 声明：headless/tui 没有 webServer，插件级声明会让工具永远 pending（回归）。
 */
export function registerPanelRoute(ctx: PanelRouteHostContext, deps: PanelRouteDeps): (() => void) | undefined {
  const logger = deps.logger ?? ctx.logger;
  if (typeof ctx.inject === "function") {
    logger?.debug?.("mocl-panel: deferring webServer registration via scope inject (fires when service ready)");
    ctx.inject(["webServer"], (scoped) => {
      registerWithResolvedWebServer(scoped, deps);
    });
    return undefined;
  }
  // 兜底：保留既有直接解析（单测 fake ctx / 旧宿主）。
  return registerWithResolvedWebServer(ctx, deps);
}

/** 解析 webServer 并注册 prefix 路由；解析/注册失败只记日志（工具不受影响）。 */
function registerWithResolvedWebServer(ctx: PanelRouteHostContext, deps: PanelRouteDeps): (() => void) | undefined {
  const logger = deps.logger ?? ctx.logger;
  const webServer = resolveWebServer(ctx);
  if (webServer === undefined) {
    logger?.error?.("mocl-panel: ctx.webServer unavailable; panel route not registered (tools unaffected)");
    return undefined;
  }
  const handler = createPanelRouteHandler(deps);
  let disposer: unknown;
  try {
    disposer = webServer.register({ kind: "prefix", path: PANEL_ROUTE_PREFIX, handler });
  } catch (error) {
    logger?.error?.(`mocl-panel: register(${PANEL_ROUTE_PREFIX}) rejected: ${describeError(error)}`);
    return undefined;
  }
  const dispose = typeof disposer === "function" ? (disposer as () => void) : () => undefined;
  ctx.effect?.(() => dispose, "mocl-panel: route");
  logger?.info?.(`mocl-panel: registered prefix route ${PANEL_ROUTE_PREFIX} (list|heartbeat)`);
  return dispose;
}

/* ------------------------------------------------------------------ */
/* 路由 handler（fake req/res 可单测）                                  */
/* ------------------------------------------------------------------ */

export function createPanelRouteHandler(deps: PanelRouteDeps): PanelRouteHandler {
  const clock = deps.clock ?? (() => new Date());
  const facadePromise = Promise.resolve(deps.facade);
  const keep = deps.heartbeatKeep ?? PANEL_HEARTBEAT_KEEP;

  let explicitDir = deps.journalDir !== undefined ? deps.journalDir : undefined;
  let resolvedDir: string | null | undefined;

  async function journalDir(): Promise<string | null> {
    if (explicitDir !== undefined) return explicitDir;
    if (resolvedDir !== undefined) return resolvedDir;
    let facade: PanelFacadeSource | undefined;
    try {
      facade = await facadePromise;
    } catch {
      facade = undefined;
    }
    resolvedDir = resolveJournalDir(facade);
    if (resolvedDir === null) {
      deps.logger?.warn?.("mocl-panel: journal.dir unavailable from facade config; heartbeat not persisted");
    }
    return resolvedDir;
  }

  return async function panelRouteHandler(req, res) {
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = pathnameOf(req);
    try {
      if (pathname === PANEL_LIST_PATH && method === "GET") {
        try {
          const facade = await facadePromise;
          const list = await facade.list();
          sendJson(
            res,
            200,
            { ok: true, syncedAt: clock().toISOString(), source: PANEL_LIST_SOURCE, children: panelChildren(list) },
            { "cache-control": "no-store" },
          );
        } catch (error) {
          deps.logger?.warn?.(`mocl-panel: list failed: ${describeError(error)}`);
          sendJson(
            res,
            200,
            { ok: false, syncedAt: clock().toISOString(), error: errorPayloadOf(error) },
            { "cache-control": "no-store" },
          );
        }
        return;
      }
      if (pathname === PANEL_HEARTBEAT_PATH && method === "POST") {
        const raw = await readBody(req);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          parsed = null;
        }
        const entry = normalizeHeartbeatEntry(parsed, clock().toISOString());
        const dir = await journalDir();
        if (dir !== null) {
          const persisted = recordHeartbeat({ file: join(dir, "panel-heartbeat.json"), entry, keep });
          if (!persisted) deps.logger?.warn?.("mocl-panel: heartbeat persistence failed");
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, {
        ok: false,
        error: { code: "protocol.unknown-method", userMessage: `no such route: ${method} ${pathname}` },
      });
    } catch (error) {
      // 最后一道兜底：按宿主 webserver 语义，handler 抛错 → 400（spike 同款）。
      deps.logger?.error?.(`mocl-panel: handler failure on ${method} ${pathname}: ${describeError(error)}`);
      throw error;
    }
  };
}

/* ------------------------------------------------------------------ */
/* 心跳落盘（原子写 + 环形保留）                                        */
/* ------------------------------------------------------------------ */

export interface PanelHeartbeatEntry {
  readonly ts: string;
  readonly rows: number | null;
  readonly mounted: boolean | null;
  readonly viewport: number | null;
}

/** 宽松归一化：畸形字段一律 null（不猜、不用 0 填充）。 */
export function normalizeHeartbeatEntry(input: unknown, ts: string): PanelHeartbeatEntry {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const rows = record["rows"];
  const viewport = record["viewport"];
  return {
    ts,
    rows: typeof rows === "number" && Number.isSafeInteger(rows) && rows >= 0 ? rows : null,
    mounted: typeof record["mounted"] === "boolean" ? (record["mounted"] as boolean) : null,
    viewport: typeof viewport === "number" && Number.isFinite(viewport) && viewport >= 0 ? viewport : null,
  };
}

/** 容错读：文件缺失/损坏 → 空数组（心跳日志是旁路数据，不能拖垮路由）。 */
export function readHeartbeatEntries(file: string): unknown[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed;
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/** 追加 1 条并截断为最后 `keep` 条；tmp+rename 原子写。失败返回 false（调用方记日志）。 */
export function recordHeartbeat(input: { file: string; entry: unknown; keep?: number }): boolean {
  const keep = input.keep ?? PANEL_HEARTBEAT_KEEP;
  try {
    mkdirSync(dirname(input.file), { recursive: true });
    const next = [...readHeartbeatEntries(input.file), input.entry].slice(-keep);
    const tmp = `${input.file}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, input.file);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

function pathnameOf(req: PanelRouteRequest): string {
  try {
    return new URL(req.url ?? "/", "http://dsh.local").pathname;
  } catch {
    return String(req.url ?? "");
  }
}

function sendJson(res: PanelRouteResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** 任意异常 → {code, userMessage, traceId?}（门面统一 ABI 错误投影；不打印堆栈）。 */
export function errorPayloadOf(error: unknown): { code: string; userMessage: string; traceId?: string } {
  const ref = toErrorRef(error);
  const payload: { code: string; userMessage: string; traceId?: string } = {
    code: ref.code,
    userMessage: ref.userMessage,
  };
  if (typeof ref.traceId === "string" && ref.traceId.length > 0) payload.traceId = ref.traceId;
  return payload;
}

function readBody(req: PanelRouteRequest, limit: number = HEARTBEAT_BODY_LIMIT_BYTES): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk?: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
      size += buffer.length;
      if (size > limit) {
        rejectBody(new Error(`mocl-panel: heartbeat body exceeds ${limit} bytes`));
        req.destroy?.();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error?: unknown) => rejectBody(error instanceof Error ? error : new Error(String(error ?? "request error"))));
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

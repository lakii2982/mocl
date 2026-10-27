/**
 * 面板数据面（W2）：2s 轮询 + 心跳 + 可见性暂停。
 *
 * - 契约：.agentspec/issues/18/W2.md §2 —— fetch("/mocl-panel/list") 2s setInterval；
 *   tab 卸载 / apply 的 disposer 必须 clearInterval + AbortController.abort()；
 *   document.hidden 时暂停；页面可见后立即刷新；挂载后心跳（mount/unmount 各一次 + 每 30s）。
 * - 可测性：fetch / 可见性 / 心跳全部注入 → node + vitest fake timers 覆盖生命周期
 *   （tests/client-ui/polling.test.ts），不依赖 DOM。
 * - 数据单一真相：children 原样透传（服务端 StatusOutcome），不做二次加工。
 */
import type { PanelAgent } from "./status.ts";

/** host 半路由常量（panel-route.ts 有同一对；tests/client-ui/panel-route.test.ts 断言一致）。 */
export const PANEL_LIST_PATH = "/mocl-panel/list";
export const PANEL_HEARTBEAT_PATH = "/mocl-panel/heartbeat";

export const PANEL_POLL_INTERVAL_MS = 2000;
export const PANEL_HEARTBEAT_INTERVAL_MS = 30000;

/** GET /mocl-panel/list 响应体（ok:false 时前端按错误态渲染）。 */
export interface PanelListBody {
  readonly ok?: boolean;
  readonly syncedAt?: string | null;
  readonly source?: string | null;
  readonly children?: readonly PanelAgent[] | null;
  readonly error?: {
    readonly code?: string | null;
    readonly userMessage?: string | null;
    readonly traceId?: string | null;
  } | null;
}

export interface PanelErrorView {
  readonly code: string;
  readonly userMessage: string;
  readonly traceId: string | null;
}

export type PanelPhase = "loading" | "ready" | "error";

export interface PanelSnapshot {
  readonly phase: PanelPhase;
  /** 服务端 children 原样透传（契约：与 mocl_status 的 status 字段集合一致）。 */
  readonly children: readonly PanelAgent[];
  readonly syncedAt: string | null;
  /** 客户端时钟：最近一次成功同步的时刻（ms），用于「已同步 · Ns 前」。 */
  readonly lastSyncAt: number | null;
  readonly error: PanelErrorView | null;
}

export function initialPanelSnapshot(): PanelSnapshot {
  return { phase: "loading", children: [], syncedAt: null, lastSyncAt: null, error: null };
}

export interface PanelHeartbeatMeta {
  readonly mounted: boolean;
}

export interface PanelDataControllerOptions {
  /** 拉取 /mocl-panel/list（由组件层用 fetch + AbortSignal 实现）。 */
  fetchList(signal: AbortSignal): Promise<PanelListBody>;
  /** 心跳回调（组件层 POST /mocl-panel/heartbeat）；mount/unmount 各一次 + 每 30s。 */
  heartbeat?(snapshot: PanelSnapshot, meta: PanelHeartbeatMeta): void;
  intervalMs?: number;
  heartbeatIntervalMs?: number;
  /** 缺省恒为可见（node 测试注入真实实现）。 */
  isHidden?(): boolean;
  /** 订阅页面可见性变化；返回退订函数。 */
  subscribeVisibility?(onChange: () => void): () => void;
}

export interface PanelDataController {
  start(): void;
  /** clearInterval + AbortController.abort() + unmount 心跳。 */
  dispose(): void;
  /** 手动刷新（重试入口 / 可见性恢复共用）；成功失败都会重置轮询节奏。 */
  refresh(): Promise<void>;
  getSnapshot(): PanelSnapshot;
  subscribe(listener: (snapshot: PanelSnapshot) => void): () => void;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === "AbortError";
}

export function createPanelDataController(options: PanelDataControllerOptions): PanelDataController {
  const intervalMs = options.intervalMs ?? PANEL_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? PANEL_HEARTBEAT_INTERVAL_MS;
  const isHidden = options.isHidden ?? (() => false);

  let snapshot: PanelSnapshot = initialPanelSnapshot();
  const listeners = new Set<(snapshot: PanelSnapshot) => void>();
  let started = false;
  let disposed = false;
  let inFlight = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let unsubscribeVisibility: (() => void) | null = null;

  function setSnapshot(next: PanelSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  }

  function emitHeartbeat(mounted: boolean): void {
    options.heartbeat?.(snapshot, { mounted });
  }

  function schedulePoll(): void {
    if (!started || disposed) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pollTick();
    }, intervalMs);
  }

  async function pollTick(): Promise<void> {
    if (!started || disposed) return;
    // document.hidden 时暂停：跳过本次抓取，节奏照常推进。
    if (!isHidden()) await fetchOnce();
    schedulePoll();
  }

  function scheduleHeartbeat(): void {
    if (!started || disposed) return;
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (!started || disposed) return;
      emitHeartbeat(true);
      scheduleHeartbeat();
    }, heartbeatIntervalMs);
  }

  async function fetchOnce(): Promise<void> {
    if (!started || disposed || inFlight) return;
    inFlight = true;
    const controller = new AbortController();
    abort = controller;
    try {
      const body = await options.fetchList(controller.signal);
      if (disposed || !started) return;
      if (body !== null && typeof body === "object" && body.ok === true) {
        setSnapshot({
          phase: "ready",
          children: Array.isArray(body.children) ? body.children : [],
          syncedAt: body.syncedAt ?? null,
          lastSyncAt: Date.now(),
          error: null,
        });
      } else {
        const rawError = body !== null && typeof body === "object" ? body.error : null;
        setSnapshot({
          phase: "error",
          children: snapshot.children,
          syncedAt: (body !== null && typeof body === "object" ? body.syncedAt : null) ?? null,
          lastSyncAt: snapshot.lastSyncAt,
          error: {
            code: typeof rawError?.code === "string" && rawError.code.length > 0 ? rawError.code : "unknown",
            userMessage: typeof rawError?.userMessage === "string" ? rawError.userMessage : "",
            traceId: typeof rawError?.traceId === "string" ? rawError.traceId : null,
          },
        });
      }
    } catch (error) {
      if (disposed || !started || isAbortError(error)) return;
      setSnapshot({
        phase: "error",
        children: snapshot.children,
        syncedAt: null,
        lastSyncAt: snapshot.lastSyncAt,
        error: { code: "fetch-failed", userMessage: "", traceId: null },
      });
    } finally {
      inFlight = false;
      abort = null;
    }
  }

  /** 刷新入口：立即抓取一次并重置轮询节奏（对外 refresh / 可见性恢复共用同一序列）。 */
  async function refreshNow(): Promise<void> {
    await fetchOnce();
    schedulePoll();
  }

  function onVisibilityChange(): void {
    if (!started || disposed) return;
    // 页面可见后立即刷新（并重置轮询节奏）。
    if (!isHidden()) void refreshNow();
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      emitHeartbeat(true);
      if (options.subscribeVisibility !== undefined) {
        unsubscribeVisibility = options.subscribeVisibility(onVisibilityChange);
      }
      void (async () => {
        await fetchOnce();
        schedulePoll();
      })();
      scheduleHeartbeat();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (unsubscribeVisibility !== null) {
        unsubscribeVisibility();
        unsubscribeVisibility = null;
      }
      const inFlightAbort = abort;
      abort = null;
      inFlightAbort?.abort();
      emitHeartbeat(false);
    },
    refresh: () => refreshNow(),
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener: (snapshot: PanelSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

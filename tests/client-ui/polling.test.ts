/**
 * W2 面板数据面生命周期测试（fake timers；fetch/可见性/心跳全部注入，无 DOM）。
 * 契约：2s 间隔；dispose 后不再请求且 abort 在途；hidden 暂停；可见立即刷新；心跳 mount/30s/unmount。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PANEL_HEARTBEAT_INTERVAL_MS,
  PANEL_POLL_INTERVAL_MS,
  createPanelDataController,
  type PanelDataControllerOptions,
  type PanelListBody,
} from "../../src/client-ui/polling.ts";

afterEach(() => {
  vi.useRealTimers();
});

function makeHarness(overrides: Partial<PanelDataControllerOptions> = {}) {
  const signals: AbortSignal[] = [];
  const fetchList = vi.fn(async (signal: AbortSignal): Promise<PanelListBody> => {
    signals.push(signal);
    return { ok: true, syncedAt: "2026-10-27T00:00:00.000Z", children: [{ childId: `child-${signals.length}` }] };
  });
  const heartbeats: Array<{ rows: number; mounted: boolean }> = [];
  let hidden = false;
  const visibilityListeners = new Set<() => void>();
  const controller = createPanelDataController({
    fetchList,
    heartbeat: (snap, meta) => {
      heartbeats.push({ rows: snap.children.length, mounted: meta.mounted });
    },
    isHidden: () => hidden,
    subscribeVisibility: (onChange) => {
      visibilityListeners.add(onChange);
      return () => {
        visibilityListeners.delete(onChange);
      };
    },
    ...overrides,
  });
  return {
    controller,
    fetchList,
    signals,
    heartbeats,
    setHidden(value: boolean) {
      hidden = value;
    },
    fireVisible() {
      for (const listener of [...visibilityListeners]) listener();
    },
  };
}

describe("面板数据控制器（2s 轮询 + 心跳 + 可见性）", () => {
  it("常量契约：轮询 2s、心跳 30s", () => {
    expect(PANEL_POLL_INTERVAL_MS).toBe(2000);
    expect(PANEL_HEARTBEAT_INTERVAL_MS).toBe(30000);
  });

  it("start 立即取一次，此后每 2s 一次；成功 → ready + children 透传", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchList).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PANEL_POLL_INTERVAL_MS);
    expect(h.fetchList).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PANEL_POLL_INTERVAL_MS);
    expect(h.fetchList).toHaveBeenCalledTimes(3);

    const snapshot = h.controller.getSnapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.syncedAt).toBe("2026-10-27T00:00:00.000Z");
    expect(snapshot.children).toEqual([{ childId: "child-3" }]);
    h.controller.dispose();
  });

  it("dispose 后不再请求，快照冻结", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.controller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.fetchList).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().children).toEqual([{ childId: "child-1" }]);
  });

  it("dispose 中止在途请求（AbortController.abort）；迟到的响应不写入快照", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    // 断言为联合类型初始化：若直接 `= null`，TS CFA 会把变量收窄成 null（Promise
    // executor 内的赋值不参与流分析），下方 resolveFetch?.() 会报 TS2349 'never'。
    let resolveFetch = null as ((body: PanelListBody) => void) | null;
    const fetchList = vi.fn((signal: AbortSignal): Promise<PanelListBody> => {
      signals.push(signal);
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    });
    const controller = createPanelDataController({ fetchList });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals.length).toBe(1);
    controller.dispose();
    expect(signals[0]?.aborted).toBe(true);
    resolveFetch?.({ ok: true, children: [{ childId: "late" }] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("loading");
  });

  it("document.hidden 时暂停轮询；恢复可见后立即刷新并恢复节奏", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchList).toHaveBeenCalledTimes(1);

    h.setHidden(true);
    await vi.advanceTimersByTimeAsync(PANEL_POLL_INTERVAL_MS * 3);
    expect(h.fetchList).toHaveBeenCalledTimes(1);

    h.setHidden(false);
    h.fireVisible();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchList).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PANEL_POLL_INTERVAL_MS);
    expect(h.fetchList).toHaveBeenCalledTimes(3);
    h.controller.dispose();
  });

  it("心跳：mount 一次 + 每 30s 一次 + unmount 一次（rows 随快照）", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.heartbeats).toEqual([{ rows: 0, mounted: true }]);
    await vi.advanceTimersByTimeAsync(PANEL_HEARTBEAT_INTERVAL_MS);
    expect(h.heartbeats.length).toBe(2);
    expect(h.heartbeats[1]).toEqual({ rows: 1, mounted: true });
    h.controller.dispose();
    expect(h.heartbeats[h.heartbeats.length - 1]).toEqual({ rows: 1, mounted: false });
  });

  it("抓取异常 → error 态（fetch-failed）；下一轮自动恢复 ready", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchList = vi.fn(async (): Promise<PanelListBody> => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { ok: true, children: [{ childId: "c1" }] };
    });
    const controller = createPanelDataController({ fetchList });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().phase).toBe("error");
    expect(controller.getSnapshot().error?.code).toBe("fetch-failed");
    await vi.advanceTimersByTimeAsync(PANEL_POLL_INTERVAL_MS);
    expect(controller.getSnapshot().phase).toBe("ready");
    controller.dispose();
  });

  it("服务端 ok:false → 透传 error.code，children 保留上次快照", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchList = vi.fn(async (): Promise<PanelListBody> => {
      calls += 1;
      if (calls === 1) return { ok: true, children: [{ childId: "c1" }] };
      return { ok: false, syncedAt: "2026-10-27T00:00:01.000Z", error: { code: "policy.permission-denied", userMessage: "MOCL 已停用" } };
    });
    const controller = createPanelDataController({ fetchList });
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().phase).toBe("ready");
    await vi.advanceTimersByTimeAsync(PANEL_POLL_INTERVAL_MS);
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe("error");
    expect(snapshot.error?.code).toBe("policy.permission-denied");
    expect(snapshot.children.length).toBe(1);
    controller.dispose();
  });

  it("refresh() 手动立即刷新（重试入口）并重置节奏", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await h.controller.refresh();
    expect(h.fetchList).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PANEL_POLL_INTERVAL_MS);
    expect(h.fetchList).toHaveBeenCalledTimes(3);
    h.controller.dispose();
  });
});

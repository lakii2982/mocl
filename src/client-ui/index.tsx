/**
 * MOCL 面板 client 半入口（W2）—— esbuild bundle 的 entry，导出 `name / inject / apply`。
 *
 * - 加载形状（S1 实测）：宿主 ModuleLoader 执行本 bundle 的 lazy-CJS 包装
 *   （见 tools/build-client.mjs 的 banner/footer；骨架照抄 spike/panel-spike/client.js）。
 * - tab 注册（W2 §6.1/§6.2 实测铁律）：
 *   `ctx.sidebarRightTabs.register({ id, kind, title, guide: [...] })` +
 *   `ctx.slots.register({ name: "sidebar.right.pane.tab", key: id }, Component)`；
 *   guide 条目是唯一入口（右侧栏默认停在 guide 页，未注册 guide 则面板不可达）；
 *   client ctx 只能访问 inject 过的键 —— 未 inject 键的属性访问会在页面激活期抛错、整插件 failed，
 *   因此不做任何 `ctx[其它键]` 探测；manifest 层 `dsh.client.inject`（package.json，
 *   见 tools/build-plugin-package.mjs）声明包名 `@deepseek-ai/dsh-client-ui-sidebar-right`
 *   只影响 bundle 加载顺序，不是 cordis 服务键，两者都要写、含义不同。
 * - 注册寿命 = 插件寿命：两个注册都挂在本插件自己的 ctx.effect 内（返回 disposer 兜底）。
 */
import { TEXT } from "./status.ts";
import panelCss from "./panel.css";
import { ExternalAgentPanel } from "./panel.tsx";

/** cordis 插件名（client 半独立于 host 半的 `mocl`）。 */
export const name = "mocl-panel";

/**
 * 运行层注入声明（服务键，同官方 sidebar-right bundle 的 `inject = ["slots", …]`；
 * spike 实测：`provide("sidebarRightTabs", tabs)` + `ctx.slots.inject("sidebar.right.pane.tab",…)`）。
 */
export const inject = ["sidebarRightTabs", "slots"];

const TAB_ID = "@mocl/dsh-plugin";
const TAB_KIND = "mocl-panel";
const STYLE_ELEMENT_ID = "mocl-panel-client-styles";

/** 客户端 ctx（宿主 ModuleLoader 提供；形状按 spike 实测，全部防御性解析）。 */
export interface PanelClientContext {
  readonly sidebarRightTabs?: unknown;
  readonly slots?: unknown;
  readonly logger?: {
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
    error?(...args: unknown[]): void;
  };
  effect?(factory: () => unknown, label?: string): unknown;
}

interface Registerable {
  register(...args: unknown[]): unknown;
}

function isRegisterable(value: unknown): value is Registerable {
  return typeof value === "object" && value !== null && typeof (value as { register?: unknown }).register === "function";
}

/**
 * 从 ctx 上解析侧栏服务（W2 §6.2 铁律：只访问 inject 过的键，不做任意键探测；
 * 未注入时由 apply 打日志显式失败，不静默）。
 */
export function resolveTabs(ctx: PanelClientContext): Registerable | undefined {
  return isRegisterable(ctx.sidebarRightTabs) ? ctx.sidebarRightTabs : undefined;
}

export function resolveSlots(ctx: PanelClientContext): Registerable | undefined {
  return isRegisterable(ctx.slots) ? ctx.slots : undefined;
}

/** CSS 运行时注入（幂等；disposer 移除）。 */
export function ensureStyles(doc: Document): () => void {
  const existing = doc.getElementById(STYLE_ELEMENT_ID);
  if (existing !== null) return () => undefined;
  const element = doc.createElement("style");
  element.id = STYLE_ELEMENT_ID;
  element.textContent = panelCss;
  doc.head.appendChild(element);
  return () => {
    element.remove();
  };
}

/**
 * client 半插件入口：注入样式 + 注册「外部代理」tab 与 body 槽。
 * 返回 disposer（同时挂 ctx.effect；按官方插件模式二者皆可）。
 */
export function apply(ctx: PanelClientContext): (() => void) | undefined {
  const logger = ctx.logger ?? console;
  const removeStyles = typeof document !== "undefined" ? ensureStyles(document) : () => undefined;

  const tabs = resolveTabs(ctx);
  const slots = resolveSlots(ctx);
  if (tabs === undefined || slots === undefined) {
    const keys = Object.keys(ctx as Record<string, unknown>).join(",");
    logger.error(
      `mocl-panel: cannot resolve sidebar services (tabs=${String(tabs !== undefined)} slots=${String(slots !== undefined)}); ctx keys: [${keys}]`,
    );
    removeStyles();
    return undefined;
  }

  // 阶段 1：tab 类型 + guide 入口（W2 §6.1：guide 页是唯一入口，缺了面板不可达）。
  // 阶段 2：tab 本体（slot key = definition.id）。不声明 keepMounted（§6.3：关闭即卸载即释放）。
  const disposeTab = tabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => TEXT.tab,
    // 官方渲染器（spike/reference/sidebar-right-client.js §EntryBox/ShippedGuide）
    // 对 guide entry 一律惰性求值：`entry.title()`（无 ?.) 与 `entry.description?.()`，
    // 传字符串即 TypeError（issue-18 实测）。两个字段都必须是函数。
    guide: [{ id: "mocl-panel", title: () => TEXT.tab, description: () => TEXT.guideDescription }],
  });
  const disposeBody = slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, ExternalAgentPanel as unknown);

  const disposer = (): void => {
    if (typeof disposeBody === "function") disposeBody();
    if (typeof disposeTab === "function") disposeTab();
    removeStyles();
  };
  ctx.effect?.(() => disposer, "mocl-panel: sidebar tab");
  logger.info?.(`mocl-panel: sidebar tab registered (id=${TAB_ID} kind=${TAB_KIND})`);
  return disposer;
}

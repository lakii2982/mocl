import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'prototype.html'), 'utf8');
const design = readFileSync(join(here, 'DESIGN-v1.2.md'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const defaultDetails = html.split('<!-- DEFAULT-DETAILS-START -->')[1]?.split('<!-- DEFAULT-DETAILS-END -->')[0] ?? '';
const technicalDetails = html.split('<!-- TECHNICAL-DETAILS-START -->')[1]?.split('<!-- TECHNICAL-DETAILS-END -->')[0] ?? '';

const officialTokens = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-specific-sidebar-fill', '--dsw-specific-sidebar-nav-item-active', '--dsw-alias-border-l2', '--dsw-alias-border-l3',
  '--dsw-alias-button-ghost-active-fill', '--dsw-alias-button-ghost-active-hover', '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover', '--dsw-alias-state-business-primary', '--dsw-focus-ring-width', '--dsw-alias-bg-skeleton',
  '--dsw-static-deepseek-600', '--dsw-static-amber-900', '--dsw-static-amber-400', '--dsw-static-green-900',
  '--dsw-static-green-400', '--dsw-static-red-900', '--dsw-static-red-400', '--dsw-static-neutral-bluish-700',
  '--dsw-static-neutral-bluish-300', '--dsw-alias-markdown-code-block', '--dsw-alias-code-diff-deleted',
  '--dsw-font-markdown-base', '--dsw-font-markdown-base-strong', '--dsw-font-xxs-12', '--dsw-font-xxs-strong-12',
  '--dsw-radius-xs', '--dsw-radius-sm', '--ds-font-family-code', '--ds-transition-duration-fast', '--ds-ease-in-out'
]);

const checks = [];
const check = (name, condition) => checks.push({ name, condition: Boolean(condition) });
const has = fragment => html.includes(fragment);
const cssHas = fragment => css.includes(fragment);
const scriptHas = fragment => script.includes(fragment);
const scriptParses = () => {
  try {
    new Function(script);
    return true;
  } catch (error) {
    console.error(error.message);
    return false;
  }
};

check('01 中文离线文档与 token 引用', /<!doctype html>/i.test(html) && has('lang="zh-CN"') && has('href="inputs/dsh-official-tokens.css"'));
check('02 原型脚本语法可解析', scriptParses());
check('03 不新增面板 header', !/<header\b/i.test(html));
check('04 顶部总览在滚动区之外', has('class="panel-top"') && has('id="metric-grid"') && has('id="overview-line"'));
check('05 独立滚动区保留', has('id="panel-scrollport"') && cssHas('overflow-y: auto'));
check('06 四个计数块顺序完整', ['running', 'queued', 'failed', 'completed'].every(key => has(`{ key: '${key}', label:`)) && scriptHas('const metricDefinitions'));
check('07 计数块为可切换 button', has('class="metric-card tone-') && has('aria-pressed="${selected}"') && has('data-filter="${metric.key}"'));
check('08 大数字和状态色条', cssHas('font-size: 27px') && has('class="metric-accent"') && cssHas('.metric-card[aria-pressed="true"]'));
check('09 再点同块取消筛选', scriptHas("filterState.filter === key ? 'all' : key"));
check('10 选中后强制展开目标组', scriptHas("if (filterState.filter !== 'all') groupOpen[filterState.filter] = true"));
check('11 计数基于全量快照', scriptHas('function countFor(key)') && scriptHas('rows.filter(agent => statusFor(agent).key === key).length'));
check('12 加载和错误计数为未知', has("available ? countFor(metric.key) : '未知'") && has('共 未知'));
check('13 一行总览含总数同步相对时间', has('共 ${rows.length}') && has("const syncText = '已同步 · 2s 前'") && has('class="sync-status"'));
check('14 隐藏 lost 说明不改总数', has('（隐藏 ${hiddenLost} 已丢失）') && scriptHas('rows.filter(agent => agent.state === \'lost\').length'));
check('15 指标键盘导航完整', scriptHas("['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)") && scriptHas('metricFocusKey = metricDefinitions[next].key'));

const expectedGroups = ['running', 'queued', 'failed', 'completed', 'lost'];
const groupPositions = expectedGroups.map(key => script.indexOf(`{ key: '${key}', label:`));
check('16 五组顺序固定', groupPositions.every(position => position > 0) && groupPositions.every((position, index) => index === 0 || position > groupPositions[index - 1]));
check('17 前三组展开且完成丢失折叠', has("{ key: 'running', label: '运行中', icon: 'running', defaultOpen: true }") && has("{ key: 'queued', label: '排队', icon: 'queued', defaultOpen: true }") && has("{ key: 'failed', label: '失败', icon: 'failed', defaultOpen: true }") && has("{ key: 'completed', label: '已完成', icon: 'completed', defaultOpen: false }") && has("{ key: 'lost', label: '已丢失', icon: 'lost', defaultOpen: false }"));
check('18 组 header 在滚动区内 sticky', cssHas('.group-header {') && cssHas('position: sticky') && cssHas('top: 0') && has('data-group-header="${group.key}"'));
check('19 组 header 图标名称计数箭头完整', has('class="group-name"') && has('class="group-count"') && has('class="group-chevron"'));
check('20 组折叠 aria 与 hidden 同步', has('aria-expanded="${open}" aria-controls="group-list-') && scriptHas('groupOpen[key] = !expanded') && scriptHas('hidden = expanded'));
check('21 其他状态仅作兜底且不丢行', has("{ key: 'other', label: '其他状态', icon: 'other' }") && scriptHas('!groupDefinitions.some(item => item.key === key)'));
check('22 显示已丢失开关默认关闭', has('role="switch"') && has('aria-checked="${!filterState.hideLost}"') && has("{ filter: 'all', hideLost: true }") && has('显示已丢失'));
check('23 筛选持久化键兼容并增加 queued', has("const FILTER_STORAGE_KEY = 'mocl.panel.filter.v1'") && scriptHas("const filterKeys = ['all', ...metricDefinitions.map(metric => metric.key)]"));
check('24 空筛选态与查看全部恢复存在', has('该筛选下没有代理') && has('data-action="show-all"') && has("{ filter: 'all', hideLost: false }"));
check('25 列表与列表项语义保留', has('role="list"') && has('role="listitem"') && has('role="group"'));

check('26 行使用色条任务主体右时间网格', cssHas('grid-template-columns: minmax(0, 1fr) 52px') && has('class="status-bar tone-') && has('class="timing-column"'));
check('27 任务名 15px/600 且截断 title', cssHas('font-size: 15px') && cssHas('font-weight: 600') && has('class="task-label" title="${escapeHtml(agent.label)}"') && cssHas('text-overflow: ellipsis'));
check('28 后端 12px 次级文字且行内容契约完整', cssHas('.runtime {') && cssHas('font-size: 12px') && cssHas('color: var(--dsw-alias-label-secondary)') && scriptHas('const runtimeText = fullRuntime'));
check('29 状态芯片包含点图标中文', has('class="status-chip tone-') && has('class="status-dot" role="img" aria-label="状态：') && has('${status.label}</span></span><span class="task-label"'));
check('30 模型独立 chip 且保留 title', has('class="model" title="${escapeHtml(modelTitle)}"') && has('class="model-name"') && cssHas('.model {'));
check('31 右列两段时间与 queued 未开始', has('class="duration"') && has('title="最后活动') && scriptHas("status.key === 'queued' ? '未开始'"));
check('32 hover active 与 focus ring 完整', cssHas('.agent-row:hover') && cssHas('.agent-row[aria-expanded="true"]') && cssHas('outline-color: var(--dsw-alias-state-business-primary)') && cssHas('outline-width: var(--dsw-focus-ring-width)'));
check('33 行间留白与无阴影卡片化行', cssHas('.agent-item { min-width: 0; padding: 0 8px 6px; }') && !/box-shadow\s*:/.test(css));
check('34 行展开区域语义完整', has('class="agent-row" type="button"') && has('aria-expanded="false" aria-controls="details-') && has('role="region"') && has('详情" hidden'));
check('35 行键盘导航仅走可见行且 Esc 保留', scriptHas("event.key === 'ArrowDown'") && scriptHas("event.key === 'ArrowUp'") && scriptHas("event.key === 'Escape'") && scriptHas('item.getClientRects().length > 0') && scriptHas('row.focus({ preventScroll: true })'));
check('36 单后端禁用提示保留', has('BACKEND_DISABLED') && has('该后端已禁用，可在宿主设置中启用。'));

const technicalFields = ['cwd', 'depth', 'epoch', 'turnId'];
check('37 默认展开人话区不含技术字段', defaultDetails.length > 0 && technicalFields.every(field => !new RegExp(`\\b${field}\\b`).test(defaultDetails)));
check('38 技术详情默认收起且 aria 同步', technicalDetails.includes('<details') && technicalDetails.includes('<summary') && technicalDetails.includes('aria-expanded="false"') && technicalFields.every(field => technicalDetails.includes(field)) && scriptHas("summary.setAttribute('aria-expanded', String(details.open))"));
check('39 人话详情组顺序保留', ['任务全文', '状态与时间', '实际运行体', '模型'].every(label => defaultDetails.includes(`aria-label="${label}"`)) && defaultDetails.includes('renderUsageDetails(agent)') && defaultDetails.includes('renderErrorDetails(agent.error, index)'));
check('40 用量 none 不挂载且估算说明保留', scriptHas("if (!usage || usage.precision === 'none') return ''") && has('估算值，不用于计费对账'));
check('41 模型四来源直白标识完整', has("source === 'reported' ? '实际'") && has("source === 'configured' ? '配置值'") && has("source === 'fallback' ? '降级'") && has("source === 'unknown'") && !has('≈配置值') && !has('降级:free'));
check('42 原生 id 短写复制完整值', scriptHas('value.slice(0, 8)') && scriptHas("if (kind === 'nativeId') return nativeSessionId(agent)"));
check('43 复制成功失败反馈保留', has('已复制') && has('复制失败，请手动复制'));

check('44 状态优先级 lost recovering failed 保留', script.indexOf("if (state === 'lost')") < script.indexOf("if (state === 'recovering')") && script.indexOf("if (state === 'recovering')") < script.indexOf("if (turnState === 'failed')"));
check('45 queued 优先于 running 且独立计数', script.indexOf("if (activation === 'queued')") < script.indexOf("if (state === 'running' || turnState === 'running')") && has("{ key: 'queued', label: '排队', icon: 'queued' }"));
check('46 完成优先于 queued 且失败优先于完成', script.indexOf("if (turnState === 'failed')") < script.indexOf("if (state === 'completed' || turnState === 'completed')") && script.indexOf("if (state === 'completed' || turnState === 'completed')") < script.indexOf("if (activation === 'queued')"));
check('47 缺失值统一未知', scriptHas("return value === undefined || value === null || value === '' ? '未知' : String(value)"));

check('48 加载骨架与 aria-busy 保留', has('class="loading-view" aria-busy="true"') && has('row.repeat(3)'));
check('49 全局空态文案保留', has('无外部子代理') && has('外部子代理会在这里出现'));
check('50 查询错误与重试保留', has('无法获取外部代理状态') && has('HOST_UNAVAILABLE') && has('data-action="retry"') && scriptHas('function retry()'));
check('51 长文本与 20 行滚动演示保留', has('data-scenario="long"') && has('data-scenario="twenty"') && has('twentyLabels.map'));
check('52 明暗主题切换保留', has('data-ds-dark-theme') && has('id="theme-toggle"'));
check('53 reduced-motion 关闭动效', cssHas('@media (prefers-reduced-motion: reduce)') && cssHas('animation: none !important') && cssHas('transition: none !important') && cssHas('scroll-behavior: auto !important'));
check('54 320px 窄屏同一四块网格', cssHas('min-width: 320px') && cssHas('grid-template-columns: repeat(4, minmax(0, 1fr))') && cssHas('@media (max-width: 380px)'));
check('55 截图模式支持宽窄明暗和折叠', scriptHas("params.get('theme') === 'dark'") && scriptHas("params.get('view') === 'collapsed'") && scriptHas("params.get('capture') === '1'"));

check('56 运行与等待组明暗令牌', cssHas('--dsw-static-deepseek-600') && cssHas('--dsw-static-amber-900') && cssHas('--dsw-static-amber-400'));
check('57 完成失败中性组明暗令牌', cssHas('--dsw-static-green-900') && cssHas('--dsw-static-green-400') && cssHas('--dsw-static-red-900') && cssHas('--dsw-static-red-400') && cssHas('--dsw-static-neutral-bluish-300'));
check('58 主辅背景与详情令牌', cssHas('background-color: var(--dsw-alias-bg-base)') && cssHas('background-color: var(--dsw-alias-markdown-code-block)') && cssHas('color: var(--dsw-alias-label-primary)'));
check('59 所有圆角仅使用官方令牌', [...css.matchAll(/border-radius\s*:\s*([^;}]+)/g)].every(match => /^var\(--dsw-radius-(?:xs|sm)\)$/.test(match[1].trim())));
check('60 无十六进制或函数裸色值', !/#[\da-f]{3,8}\b/i.test(css) && !/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/i.test(css));
check('61 颜色声明仅引用令牌或 currentColor', [...css.matchAll(/(?:^|[;{])\s*(?:color|background-color|border-color|outline-color|fill|stroke)\s*:\s*([^;}]+)/g)].every(match => /var\(--(?:dsw|ds)-/.test(match[1]) || match[1].trim() === 'currentColor'));
const usedTokens = [...css.matchAll(/var\((--[\w-]+)\)/g)].map(match => match[1]);
check('62 无未知令牌且过渡使用官方令牌', usedTokens.every(token => officialTokens.has(token)) && cssHas('var(--ds-transition-duration-fast)') && cssHas('var(--ds-ease-in-out)'));
check('63 设计文档覆盖方向契约与验收', design.includes('A 分组仪表盘') && design.includes('功能') && design.includes('sticky') && design.includes('shot-560-light.png') && design.includes('技术详情'));

if (checks.length !== 63) {
  console.error(`FAIL: 检查项数量应为 63，实际为 ${checks.length}`);
  process.exit(1);
}

let failed = 0;
for (const [index, item] of checks.entries()) {
  if (item.condition) console.log(`ok ${String(index + 1).padStart(2, '0')} - ${item.name}`);
  else {
    failed += 1;
    console.error(`not ok ${String(index + 1).padStart(2, '0')} - ${item.name}`);
  }
}

if (failed > 0) {
  console.error(`FAIL: ${failed}/${checks.length} 项未通过`);
  process.exit(1);
}
console.log(`PASS: ${checks.length} 项检查通过`);

# 外部代理面板 v1.2 视觉重做：分组仪表盘

> 基线：`design-v11/DESIGN-v1.1.md`、`docs/design/external-agent-panel/DESIGN.md` §3.3 与 `STATES.md`。v1.2 采用 **A 分组仪表盘**，只改变视觉层级、分组导航和筛选入口；功能契约不推翻：状态判定、详情两层、模型来源、缺失值、复制反馈、四种页面态与数据字段均沿用基线。

## 1. 方向与不变项

v1.1 把状态、任务、runtime、模型和时间平铺在同一文本带里，扫读时缺少主次。v1.2 将面板分成两个清晰层级：

1. **总览层**：四个大数字回答「现在有多少需要关注」，点击后只看对应组。
2. **工作队列层**：按状态分组，任务名成为主标题，状态、后端、模型和时间各有固定位置。

保持不变：

- 无面板自身 header；宿主 tab strip 与独立滚动区保留，不增加整卡阴影或大圆角外框。
- `statusFor` 的 13 条优先级不变；lost 不等于 failed，queued 不计入 running，draining 仍属于 running。
- 所有计数基于本次成功查询的全量快照，不受当前筛选和 lost 可见性影响。
- 加载、全局空、查询错误、正常四态及重试保留；筛选空态不是第五种页面态。
- 详情默认是人话区，`cwd / depth / epoch / turnId` 只在默认收起的「技术详情」中。
- 模型只读 `runtime.model / runtime.modelSource`，明确标注「实际 / 配置值 / 降级 / 未知」。
- 缺失值显示「未知」；不用 `0` 填充，不根据 backend 猜模型、版本、通道或能力。
- 只使用官方 `--dsw-*` / `--ds-*` 令牌；320–560px 共用同一 DOM，支持明暗主题与 reduced-motion。

## 2. 总览层

### 2.1 四个计数块

顶部为四等分网格，顺序固定：**运行中 → 排队 → 失败 → 已完成**。每块包含：

- 24–28px 大数字；
- 12px 状态标签；
- 顶部 3px 状态色条与小状态图标，不只依赖颜色表达选中态；
- 原生 `button type=button`、`aria-pressed` 和完整 accessible name，例如「只看运行中，2 个代理」。

交互：

- 未选时点击计数块：筛选为该主状态，滚动区只显示该组，组自动展开。
- 再次点击同一块：取消筛选，恢复全部组及各组默认展开态。
- 点击另一块：直接切换筛选，焦点留在新按钮。
- 四块均不选中表示全部；没有额外「全部」 chip。
- ←/→ 在四块间循环移动焦点，Home/End 到首/尾；Enter/Space 切换。筛选不触发页面滚动。
- 选中态同时使用状态色顶条、边框、背景和 `✓ 只看此组` 无障碍文本；不是仅改数字颜色。

计数口径：

| 计数块 | 口径 |
|---|---|
| 运行中 | `statusFor(agent).key === running`，含 draining，不含 queued/recovering |
| 排队 | 仅 queued |
| 失败 | 仅 failed，不含 lost/aborted/blocked |
| 已完成 | 仅 completed，不含 archived/aborted |

加载或查询失败时四块显示「未知」并 disabled；成功空查询显示 `0`。

### 2.2 一行总览与 lost 开关

计数块下方是一行总览：

```text
共 6[（隐藏 1 已丢失）]                         已同步 · 2s 前
```

- 左侧 `共 N` 为全量行数，包含 lost；存在隐藏 lost 时追加隐藏说明。
- 右侧同步状态与相对时间单行省略，完整内容放入 `title`。
- 错误态显示「共 未知」与「同步失败」，并提供可见重试入口。

总览下方为轻量工具行，右侧是原生 `button role=switch` 的 **「显示已丢失」**：

- 默认 `false`，即默认隐藏 lost；打开后 lost 组出现在组序末尾。
- 开关只控制可见性，不改变任何计数块的 N 或「共 N」。
- 选择 running/queued/failed/completed 时，即使开关打开也不会混入 lost。
- 延续 v1.1 存储键 `mocl.panel.filter.v1`，结构仍为 `{ filter, hideLost }`；`filter` 在既有 `all/running/failed/completed` 上增加本版本明确需要的 `queued`。读取旧值完全兼容，损坏或越界回退 `{ filter: 'all', hideLost: true }`。
- 不持久化组展开态、滚动位置或演示主题。

## 3. 分组工作队列

### 3.1 组序与默认展开

正常全量视图按以下顺序渲染非空组：

1. 运行中
2. 排队
3. 失败
4. 已完成（默认折叠）
5. 已丢失（仅「显示已丢失」开启时出现）

默认展开前三组；已完成折叠。用户可独立展开/折叠每个可见组，展开代理详情不改变组展开态。

既有映射还包含等待输入、恢复中、已中止、已归档、已阻塞、待启动和未知。为避免这些行在全量视图中消失，只有在快照实际包含它们时，才在五个主组之后追加 **「其他状态」** 组；其内部仍严格显示各自行主状态，不计入四个主状态计数，默认折叠。这是兜底分组，不改变 `STATES.md` 的任何分类口径。

筛选某个主组时，其他组（包括其他状态与 lost）均不渲染。当前组没有行时显示筛选空态：「该筛选下没有代理 / 可切换状态，或查看全部代理。 / 查看全部」。「查看全部」设置 `filter=all, hideLost=false` 并持久化，然后把焦点送入第一行。

### 3.2 sticky 组 header

每组 header 位于独立滚动区内：

```text
[状态图标] 运行中                         [2] [⌄]
```

- 使用原生 button，包含图标、组名、计数与折叠箭头；`aria-expanded / aria-controls` 同步。
- `position: sticky; top: 0`，滚动时当前组 header 保持在列表顶部；下一组 header 自然推走前一组。
- header 使用不透明令牌背景、底部分隔线和 12px 强调字，不加阴影。
- 计数是该组全量行数，不因其他组折叠变化；筛选其他组后回到全部仍保留全量口径。
- 组内容使用 `role=list`，行容器为 `role=listitem`；组 header 不伪装成列表行。

### 3.3 行视觉与内容

行不再是三列平铺文字，而是「状态色条 + 任务主体 + 右列时间」：

```text
┃ [● 运行中] 评审 PR#14 的 diff             01:23
┃ claude-code · agent-sdk · 95d9ebac · v2.1.310  [claude-sonnet… 实际]  12s 前
```

- 左侧 3px 状态色条贯穿行高；行内状态芯片同时有点、图标和中文。
- 任务名 15px / 600 / 22px，单行省略，`title` 与 accessible name 保留全文。
- 后端信息为 12px 次级文字，严格保留 §3.3 的 `backend · 通道 · 原生 id 短写 · 版本`；单行省略，`title` 显示完整组合，任一项缺失为「未知」。
- 模型是独立 chip，模型主体优先，来源后缀可省略；完整组合放入 `title`。
- 右列固定两段时间：本轮耗时 / 最后活动；queued 第一段可为「未开始」。
- 行高由内容决定，默认约 76px；行间距 6px、左右留白 8px、内部 padding 10px，避免密排。
- hover 使用交互底色；展开使用 active 底色；键盘 `:focus-visible` 使用令牌焦点环。
- 状态 chip、模型 chip 使用小圆角与边框，不使用阴影；色条、芯片、文字三者共同建立层级。

行操作契约不变：整行 button 展开详情；↑/↓ 在当前可见行移动，Home/End 到首/尾，Enter/Space 展开，Esc 收起并保留焦点。roving tabindex 只作用于可见行，折叠组内的行不可聚焦。

## 4. 两层详情

行展开后顺序与 v1.1 完全一致：

1. 任务全文与复制；
2. 状态与时间；
3. 用量（`precision=none` 时整个不挂载）；
4. 实际运行体；
5. 模型与来源；
6. 可选错误详情；
7. 默认收起的「技术详情」。

`cwd / depth / epoch / turnId` 的字样和值只能出现在技术详情内。技术区使用原生 `details/summary`，收起时字段与复制按钮不进入无障碍树。复制仍反馈「已复制 / 复制失败，请手动复制」，不抢焦点。

## 5. 响应式、主题与动效

- 320–560px 都是单列：四个计数块始终一行等分，组列表不改成多列卡片，不隐藏模型或时间。
- 320px 时计数块缩小水平 padding 与间距，标签不换行；极长数字省略并提供 `title`。
- 行主区使用 `minmax(0,1fr)`，模型、后端和任务分别截断；详情长值 `overflow-wrap:anywhere`，页面无横向滚动。
- 主题只通过 `body[data-ds-dark-theme]` 和官方令牌解析切换；同一 DOM、间距和图标，不用透明度代替次级文字。
- 动效只用于 hover 背景、选中态与箭头旋转，使用 `--ds-transition-duration-fast` 和 `--ds-ease-in-out`；`prefers-reduced-motion: reduce` 下全部立即完成。
- 原型 `inputs/dsh-official-tokens.css` 仅是离线截图用的 token 解析层；产品样式仍只引用令牌，不消费裸色值。

## 6. 组件树

```text
ExternalAgentPanel
├─ PanelTop[滚动区之外]
│  ├─ MetricGrid
│  │  ├─ RunningMetric[aria-pressed]
│  │  ├─ QueuedMetric[aria-pressed]
│  │  ├─ FailedMetric[aria-pressed]
│  │  └─ CompletedMetric[aria-pressed]
│  ├─ OverviewLine（共 N / 隐藏 lost / 已同步 / 相对时间 / 重试）
│  └─ ListTools（显示已丢失 switch）
└─ PanelScrollport
   ├─ LoadingView / EmptyView / ErrorView / FilterEmptyView
   └─ StatusGroup[sticky GroupHeader]
      └─ AgentList
         └─ AgentListItem
            ├─ AgentRowButton（色条 / 状态 chip / 任务 / 后端 / 模型 chip / 两段时间）
            └─ ExpandedDetails
               ├─ HumanDetails
               └─ TechnicalDetails[默认收起]
```

## 7. 验收

`node design-v12/check.mjs` 必须通过，覆盖：

- 四计数块、切换筛选、 queued 新入口与全量计数口径；
- 五组顺序、sticky header、默认展开/折叠、lost 开关和兜底组；
- 15px/600 任务名、12px 后端、状态色条/chip、模型 chip、两段时间、hover/focus；
- 两层详情与模型四来源；
- 四态、复制、键盘、明暗主题、reduced-motion、令牌与无裸色约束。

四张 Chrome headless 自测图：`shot-560-light.png`、`shot-560-dark.png`、`shot-390-light.png`、`shot-groups-collapsed.png`。另需在 320/390/500/560px 检查无横向溢出，筛选、再点取消、组折叠、lost 开关和详情展开均可操作。

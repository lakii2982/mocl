# DSH Web GUI 外部子代理运行状态面板 v1

## 1. 目标与边界

在右侧栏 `sidebar.right.pane.tab` 的「外部代理」tab 内，让用户先看清**每个外部子代理在干什么**，再看实际 backend、通道、原生 id、版本、模型、状态和时间。

- 第一优先级：主行只使用任务摘要 `label`，采用「动作 + 对象」，例如「评审 PR#14 的 diff」。backend、childId、模型名都不能代替任务摘要。
- 面板是会话页面的一列：无面板自身 header、无整卡阴影、无大圆角外框。上方 tab chip 属于宿主 tab strip。
- v1 只做查询、状态呈现、行展开与复制；不做启动、停止、审批、筛选、排序或外部树操作。
- 只呈现既有数据。缺失值统一显示「未知」，不从其他字段猜测，不用 `0` 填充未知数值。
- 样式只引用 `inputs/tokens-reference.md` 中的官方 `--dsw-*` / `--ds-*` 令牌。

## 2. 方案比较与选择

| 方案 | 优点 | 代价 | 结论 |
|---|---|---|---|
| A. 任务摘要优先的紧凑列表 | 全局状态一眼可扫；320px 下仍优先保留任务；符合官方列表密度 | 长 runtime 与模型需要截断并查看 title | **推荐，v1 采用** |
| B. 按 backend 分组 | 便于比较同类 backend | 增加分组标题，割裂 running/queued 全局扫描；20 行更稀疏 | 不采用 |
| C. 指标卡片 + 大行 | 可展示更多装饰性指标 | 违背页面列形态，挤压任务摘要，滚动效率低 | 不采用 |

## 3. 信息架构

### 3.1 层级与阅读顺序

1. **宿主 tab strip**：提供「外部代理」chip，不属于面板 DOM。
2. **吸顶汇总条（一行）**：`运行中 N` / `排队 N` / `失败 N` / `共 N`；随后是同步状态；查询失败时右侧出现重试入口。
3. **独立滚动内容区**：加载、空、错误或正常列表，四者互斥。
4. **代理行**：左状态、中间任务与运行信息、右时间；整行可展开。
5. **行内展开详情**：完整标识、运行上下文、本轮信息和错误；P1 仅占位，不产生可见 UI。

阅读顺序固定为：**任务摘要 → 状态点/图标/文案 → runtime 与模型 → 时间 → 详情**。视觉实现中状态位于左列，但不能让 backend 或状态成为主标题。

### 3.2 汇总口径

汇总与行主状态使用同一映射结果，不另建状态口径：

- `运行中 N`：主状态为「运行中」的行数，含 draining 收尾中的运行行；不含 accepted、queued。
- `排队 N`：主状态为「排队中」的行数；绝不能计入运行中。
- `失败 N`：主状态为「失败」的行数；lost、aborted、backend disabled 不擅自并入失败。
- `共 N`：本次成功查询得到的全部行数，包含等待、完成、归档等其他状态。
- 空查询成功时 N 可为 `0`；加载或查询失败时 N 为「未知」，不能显示 `0`。
- 同步状态只表达同步渠道：`已同步 seq=123 · 2s 前`、`订阅中`、`轮询中` 或 `同步失败`。时间缺失显示「未知」，seq 缺失显示 `seq=未知`。

### 3.3 每行内容契约

| 区域 | 展示 | 截断与缺失 |
|---|---|---|
| 左列 | 状态点 + 状态图标 + 中文状态；queued 增加「等待槽位」 | 点、图标、文案三者同时存在，不依赖颜色 |
| 主行 | **任务摘要 `label`** | 单行省略；`title` 与可聚焦行的 accessible name 保留全文；缺失为「未知」 |
| 次行前部 | `backend · 通道 · 原生 id 短写 · 版本`，如 `claude-code · agent-sdk · 95d9ebac · v2.1.310` | 单行省略，`title` 显示完整组合；任一项缺失为「未知」 |
| 次行尾部 | 实际模型；配置/降级标记直接后缀，如 `≈配置值`、`降级:free` | 不覆盖主行；空间不足时模型自身省略并提供 `title`；缺失为「未知」 |
| 右列第一行 | 本轮耗时 `01:23` | queued 尚未开始可显示「未开始」；其他缺失为「未知」 |
| 右列第二行 | 最后活动 `12s 前` | 缺失为「未知」；不虚构绝对时间 |
| 行内提示 | 单后端禁用时显示「该后端已禁用」及设置提示 | 只影响对应行，不升级为整页错误 |
| 展开区 | childId 全文、cwd、depth、epoch、turnId；错误块 code/userMessage/retryable/traceId | 定义列表键值对；长值换行；childId/traceId 可复制；无错误不渲染错误块 |

短 id 仅是展示截断，展开区必须保留 childId 全文。模型后的 `≈配置值` 表示并非已确认的实际返回值；`降级:free` 只描述模型，不改写运行状态。

## 4. 组件树

```text
SidebarRightTab（宿主提供，不在面板内）
└─ ExternalAgentPanel[会话底色，无 header]
   ├─ SummaryBar[sticky, one-line]
   │  ├─ CountGroup
   │  │  ├─ RunningCount / QueuedCount / FailedCount / TotalCount
   │  ├─ SyncStatus
   │  └─ RetryIconButton（仅查询失败）
   └─ PanelScrollport[独立滚动]
      ├─ LoadingView（骨架行 ×3）
      ├─ EmptyView
      ├─ ErrorView（主文案 + code + 可见「重试」按钮）
      └─ AgentList[role=list]
         └─ AgentListItem[role=listitem]
            ├─ AgentRowButton[aria-expanded]
            │  ├─ StatusColumn（dot + icon + text / secondary text）
            │  ├─ TaskColumn
            │  │  ├─ TaskLabel[title=全文]
            │  │  └─ RuntimeAndModel
            │  ├─ TimingColumn（本轮耗时 / 最后活动）
            │  └─ BackendDisabledNotice（可选，仍在整行点击区内）
            └─ ExpandedDetails[role=region]
               ├─ DefinitionList（childId/cwd/depth/epoch/turnId）
               ├─ CopyChildIdButton
               ├─ ErrorDetails（code/userMessage/retryable/traceId + CopyTraceIdButton）
               └─ P1 注释占位（无可见内容、无可聚焦内容）
```

## 5. 四种页面态矩阵

| 页面态 | 汇总条 | 内容区 | 操作与焦点 | 禁止 |
|---|---|---|---|---|
| 加载中 | 计数骨架；同步显示「订阅中」或「轮询中」 | 静态骨架行 ×3，使用骨架色令牌；`aria-busy=true` | 保留宿主 tab 焦点；不自动移动焦点 | 不用旋转器、 shimmer 或抖动 |
| 空态 | 已知的四项 `0`；正常同步信息 | 「无外部子代理」+「外部子代理会在这里出现」 | 无内容按钮；宿主重试/刷新不伪造为内容 CTA | 不放「创建代理」等假按钮、不放大图标 |
| 错误态 | 四项「未知」；「同步失败」；右侧重试图标 | 「无法获取外部代理状态。请确认宿主已启用并可访问，然后重试。」+ `code` +「重试」 | 重试后进入加载；错误不抢焦点；主文案不超过 60 字 | 不把内部 code 当主文案；不显示堆栈 |
| 正常态 | 实际四项计数；正常同步信息 | 1–5 行混合 running/queued/completed/failed；可含行内禁用；20 行保持同密度滚动 | 行按钮支持键盘展开；复制反馈在行内 | 不因行数增加而隐藏任务、模型或时间 |

单后端禁用不是第五种页面态。整页错误只用于整个查询不可用；局部失败保留其他成功行。

## 6. 行状态与图标

完整判定优先级、三字段组合与边界见 `STATES.md`。面板只使用以下既有状态源：`state`（9）、`activation`（4）、`turn.state`（6）。

| 主状态 | 图标语义 | 副文案/备注 |
|---|---|---|
| 运行中 | 向右三角/活动 | draining 时加「正在收尾」 |
| 排队中 | 三条队列线/时钟 | 必须加「等待槽位」 |
| 等待输入 | 问号/输入光标 | 不写成运行中 |
| 已完成 | 对勾 | — |
| 已中止 | 停止方块 | — |
| 失败 | 感叹号 | 展开区给错误详情 |
| 恢复中 | 回转箭头 | 不伪装成正常运行 |
| 已丢失 | 断链/感叹号 | 保留 last activity；不等同失败 |
| 已归档 | 归档盒 | 只读历史表现 |
| 已阻塞 | 暂停/竖线 | state=blocked 的直译，不猜阻塞原因 |
| 待启动 | 空心圆/起点 | created 或 accepted 尚未运行 |
| 未知 | 问号 | 数据缺失或组合无法判定；不编造状态 |

状态点为 8px，状态图标为 14px；状态列宽约 76px。状态点有 `role=img` 与 `aria-label="状态：<主状态>"`，SVG 图标 `aria-hidden=true`，旁边始终有可见中文。

## 7. 令牌映射

### 7.1 结构、文字与交互

| 可视元素 | 令牌 |
|---|---|
| 页面/面板/吸顶条背景 | `background-color: var(--dsw-alias-bg-base)` |
| 汇总条、行、详情分隔线 | `border-color: var(--dsw-alias-border-l2)` |
| 主任务、主要数值 | `color: var(--dsw-alias-label-primary)` |
| runtime、模型、时间、同步、辅助说明 | `color: var(--dsw-alias-label-secondary)` |
| 占位但仍有意义的说明 | `color: var(--dsw-alias-label-tertiary)`；仅非关键大字或装饰，不用于 12px 关键数据 |
| 行 hover | `background-color: var(--dsw-alias-interactive-bg-hover)` |
| 行 active/展开触发器 | `background-color: var(--dsw-alias-interactive-bg-active)` |
| 展开区背景 | `background-color: var(--dsw-alias-markdown-code-block)` |
| 次按钮背景 | `background-color: var(--dsw-alias-button-ghost-active-fill)` |
| 次按钮 hover | `background-color: var(--dsw-alias-button-ghost-active-hover)` |
| 按钮边框 | `border-color: var(--dsw-alias-border-l3)` |
| 焦点环 | `outline-color: var(--dsw-alias-state-business-primary)`；`outline-width: var(--dsw-focus-ring-width)` |
| 错误块背景 | `background-color: var(--dsw-alias-code-diff-deleted)` |
| 骨架 | `background-color: var(--dsw-alias-bg-skeleton)` |
| 滚动条 | 沿用原表 `--dsw-alias-scrollbar-*` 映射，不新增样式 |
| 正文字体 | `font: var(--dsw-font-markdown-base)` |
| 任务强调 | `font: var(--dsw-font-markdown-base-strong)` |
| 12px 辅助文字 | `font: var(--dsw-font-xxs-12)`；强调用 `--dsw-font-xxs-strong-12` |
| 代码、id、code、traceId | `font-family: var(--ds-font-family-code)`；字号继承所在文本 |
| 控件/骨架圆角 | `border-radius: var(--dsw-radius-xs)` 或 `--dsw-radius-sm` |
| 状态点圆角 | `border-radius: var(--dsw-radius-xs)`（8px 点上形成圆形） |
| hover/颜色过渡 | `--ds-transition-duration-fast` + `--ds-ease-in-out` |
| reduced motion | `animation: none`、`transition: none`、`scroll-behavior: auto` |

面板外框不使用 radius 或 elevation。任何菜单/浮层若由宿主后续提供，只能沿用宿主与 `--dsw-elevation-*`，v1 原型不创建浮层。

### 7.2 状态颜色与明暗对比

以下颜色同时用于状态点、图标和状态文字；正文背景为 `--dsw-alias-bg-base`。亮色不直接使用对比不足的绿色、亮蓝或浅黄作为文字。

| 状态组 | 亮色令牌（对比度） | 暗色令牌（对比度） |
|---|---|---|
| 运行中 / 排队中 / 恢复中 | `--dsw-static-deepseek-600`（5.39:1） | `--dsw-alias-state-business-primary`（7.83:1） |
| 等待输入 / 已阻塞 / 配置或降级标记 | `--dsw-static-amber-900`（15.46:1） | `--dsw-static-amber-400`（9.53:1） |
| 已完成 | `--dsw-static-green-900`（11.97:1） | `--dsw-static-green-400`（9.33:1） |
| 失败 / 已丢失 | `--dsw-static-red-900`（14.35:1） | `--dsw-static-red-400`（5.55:1） |
| 待启动 / 已归档 / 禁用提示 | `--dsw-static-neutral-bluish-700`（5.80:1） | `--dsw-static-neutral-bluish-300`（12.11:1） |
| 未知 | `--dsw-alias-label-secondary`（5.80:1） | 同令牌（12.11:1） |

对比度按各令牌在官方原表中的实际解析值与对应会话底色计算；所有状态文字均达到 4.5:1。错误、等待、完成仍同时依赖图标与文字，而非仅靠颜色。

## 8. 间距、字号、圆角与密度

- 基础间距步进：4 / 8 / 12 / 16 / 24px；本设计不创建新的间距令牌。
- 汇总条：左右 12px、上下 8px；计数间距 6px；同步区可单行省略并保留完整 `title`。
- 行：左右 12px、上下 4px；列间距 8px；默认两行文本总高约 52px。整行都是点击区域。
- 主行：`--dsw-font-markdown-base-strong`，默认 14px/24px，跟随宿主内容字号。
- 次行、状态、右列：`--dsw-font-xxs-12`，默认 12px/18px；runtime 与模型不换成更小字号。
- 详情：左右 12px、上下 12px；键值间距 8px；组间距 12px；长路径和 id 使用 `overflow-wrap:anywhere`。
- 按钮：最小高 28px，水平 padding 8px，圆角 `--dsw-radius-xs`；行按钮的 hover/焦点圆角同样不超过 `--dsw-radius-xs`，面板外框无圆角。
- 图标：状态 14px，操作 14px；不用插画填补空态。
- 20 行：不改变行高、不缩小字体、不隐藏字段；列表独立滚动，汇总始终可见。v1 不引入虚拟滚动。

## 9. 明暗主题差异

- 主题只通过宿主 `body[data-ds-dark-theme]` 和官方令牌解析切换；不在面板另存主题、不复制官方色表。
- 亮色面板为 `--dsw-alias-bg-base`，暗色同令牌自动切换；分隔线、hover、骨架、详情底均随官方 alias 变化。
- 状态颜色按 §7.2 分组切换，保证文字对比；不通过降低透明度制造次要状态。
- 暗色不新增阴影、发光或外框；明暗信息架构、DOM、图标和文案完全一致。
- 焦点环在两种主题均使用当时解析的 business primary；不能被官方默认透明 focus ring 覆盖。

## 10. 响应式三档（同一 DOM）

宿主布局仍在视口 ≥768px 时使用 320–560px 右侧栏，在 <768px 时切换为 fullscreen；原型用 `clamp(320px, 38vw, 560px)` 演示常规右侧栏。三档验收均使用相同行网格：`状态 76px + minmax(0,1fr) + 时间 52px`，列间距 8px，左右 padding 各 12px。

| 档位 | 验收宽度 | 中间列宽 | 次行列宽与截断规则 |
|---|---:|---:|---|
| 窄 | 390px | 222px | runtime 占用模型之后的剩余宽度并单行省略；模型最多占次行 65%，优先完整显示模型名，配置/降级后缀先省略 |
| 中 | 500px | 332px | 规则不变；模型按内容取宽、最多 65%，常见模型名及后缀比窄档展示更多，runtime 使用剩余宽度 |
| 宽 | 560px | 392px | 规则不变；常见模型及后缀可完整显示，超长模型仍单行省略 |

- 模型名与后缀分段截断，二者及 runtime 的完整内容均通过 `title` 查看；外层容器不得产生横向滚动。
- 时间列固定 52px、右对齐，runtime 与模型不得挤压或覆盖两段时间。
- 窄屏不改变字段、不改成卡片、不增加面板 header；汇总仍为一行，同步文本可省略但重试入口保持可达。
- 页面与 `.runtime` / `.model` 均不横向溢出；详情内长值换行。320px 仍保留任务、状态、模型与两段时间，不以窄屏为由只显示 backend。

## 11. 键盘、语义与复制反馈

- 列表 `role=list`，每行容器 `role=listitem`；行触发器使用原生 `button`。
- 采用 roving tabindex：Tab 进入当前行，↑/↓ 移动行焦点，Home/End 可到首/尾；Enter/Space 展开或收起。
- `aria-expanded` 与详情 `hidden` 同步；详情 `role=region` 并以任务摘要命名。Esc 收起当前行并把焦点留在其触发器。
- 展开、复制和状态更新不自动抢焦点；异步刷新后尽量按 childId 保留逻辑焦点，不跳到列表顶部。
- childId/traceId 的复制按钮有可见「复制」文字及 `title`；成功后按钮短暂显示「已复制」，失败显示「复制失败，请手动复制」，不使用自动弹窗。
- 所有 tab 内焦点可见；状态更新可用礼貌 live region 汇总，不让每行计时每秒触发播报。

## 12. 中文文案清单

| 用途 | 文案 |
|---|---|
| tab | 外部代理 |
| 汇总 | 运行中 / 排队 / 失败 / 共 |
| 同步 | 已同步 / 订阅中 / 轮询中 / 同步失败 |
| 行状态 | 运行中 / 排队中 / 等待输入 / 已完成 / 已中止 / 失败 / 恢复中 / 已丢失 / 已归档 / 已阻塞 / 待启动 / 未知 |
| queued 副文案 | 等待槽位 |
| draining 副文案 | 正在收尾 |
| 模型标记 | ≈配置值 / 降级:free |
| 空态标题 | 无外部子代理 |
| 空态说明 | 外部子代理会在这里出现 |
| 查询错误 | 无法获取外部代理状态。请确认宿主已启用并可访问，然后重试。 |
| 行内后端禁用 | 该后端已禁用，可在宿主设置中启用。 |
| 操作 | 重试 / 复制 / 已复制 / 展开详情 / 收起详情 |
| 复制失败 | 复制失败，请手动复制 |
| 详情键 | childId / cwd / depth / epoch / turnId / code / userMessage / retryable / traceId |
| 时间 | 本轮耗时 / 最后活动 / 未开始 / 未知 |
| 通用缺失 | 未知 |

## 13. P1 预留契约（v1 不渲染）

预留只是展开区中的文档顺序与原型注释，不显示「即将上线」、不占高度、不进无障碍树、不提供空折叠控件。

1. **进度折叠面板**：位于基本定义列表之后、错误块之前；仅当未来进度数据完整且能力可用时挂载。展开/收起独立于代理行展开，不能把 accepted/queued 猜成百分比。
2. **用量行**：位于进度之后；仅在真实用量数据存在时出现。缺失仍是「未知」，不能用 0 token 代替未知。
3. **外部原生子代理树**：位于用量之后、错误块之前；仅在真实父子关系可用时挂载，不根据 depth 或 childId 猜树。树节点沿用本行状态映射与对比规则。

P1 的字段、来源和能力检测需在对应版本另行定义；v1 不新增任何 API 字段，也不以注释中的名称为数据契约。原型只保留 `P1-PROGRESS`、`P1-USAGE`、`P1-CHILD-TREE` 三处 HTML 注释。

## 14. 原型与验收

`prototype.html` 使用原生 JS，离线通过相对路径引用 `inputs/dsh-official-tokens.css`。演示控制位于面板外，明确标为「非面板 UI」，可切换四种页面态、明暗主题、长文本与 20 行。

运行 `node design/check.mjs`：检查裸颜色、非令牌圆角、未知令牌、四态、明暗主题与 reduced-motion；退出码必须为 0。

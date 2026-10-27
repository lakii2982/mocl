# 外部子代理状态映射与边界

## 1. 输入与原则

只使用三个既有状态源：

- `state`：`created / running / awaiting-input / blocked / completed / aborted / lost / recovering / archived`
- `activation`：`inactive / queued / active / draining`
- `turn.state`：`accepted / running / awaiting-input / completed / failed / aborted`

不新增状态字段，不把 UI 文案回写为数据。状态判断基于同一快照；若字段缺失或组合未覆盖，显示「未知」，详情仍保留可见的原始值。

呈现原则：

1. 先表达 lost/recovering 和本轮失败/中止等结果，再处理 queued，避免把异常粉饰为排队或成功。
2. `activation=queued` 的优先级高于 running/accepted，因此**排队永远不会显示为运行中**。
3. `turn.state` 描述本轮，`state` 描述外部子代理生命周期，`activation` 描述调度；模型降级不属于其中任何一个。
4. 每行始终同时有状态点、图标、中文文案；汇总计数复用行映射结果。

## 2. 组合判定优先级

从上到下取第一个命中项。「或」表示任一字段命中；未提及字段不参与该条判断。

| 优先级 | 条件 | 主文案 | 副文案 | 图标 | 亮色令牌 | 暗色令牌 |
|---:|---|---|---|---|---|---|
| 1 | `state=lost` | 已丢失 | 保留最后活动时间 | 断链 + 感叹号 | `--dsw-static-red-900` | `--dsw-static-red-400` |
| 2 | `state=recovering` | 恢复中 | 不声称已恢复 | 回转箭头 | `--dsw-static-deepseek-600` | `--dsw-alias-state-business-primary` |
| 3 | `turn.state=failed` | 失败 | 错误详情可展开 | 感叹号三角 | `--dsw-static-red-900` | `--dsw-static-red-400` |
| 4 | `state=aborted` 或 `turn.state=aborted` | 已中止 | 不等同失败 | 停止方块 | `--dsw-static-neutral-bluish-700` | `--dsw-static-neutral-bluish-300` |
| 5 | `state=archived` | 已归档 | 保留历史时间与结果详情 | 归档盒 | `--dsw-static-neutral-bluish-700` | `--dsw-static-neutral-bluish-300` |
| 6 | `state=completed` 或 `turn.state=completed` | 已完成 | — | 对勾圆 | `--dsw-static-green-900` | `--dsw-static-green-400` |
| 7 | `activation=queued` | 排队中 | **等待槽位** | 队列线 + 小时钟 | `--dsw-static-deepseek-600` | `--dsw-alias-state-business-primary` |
| 8 | `state=awaiting-input` 或 `turn.state=awaiting-input` | 等待输入 | 不显示运行中 | 问号/输入光标 | `--dsw-static-amber-900` | `--dsw-static-amber-400` |
| 9 | `state=blocked` | 已阻塞 | 原因未知时不猜原因 | 双竖线 | `--dsw-static-amber-900` | `--dsw-static-amber-400` |
| 10 | `activation=draining` 且（`state=running` 或 `turn.state=running`） | 运行中 | 正在收尾 | 活动三角 + 收尾线 | `--dsw-static-deepseek-600` | `--dsw-alias-state-business-primary` |
| 11 | `state=running` 或 `turn.state=running` | 运行中 | active 不加副文案 | 活动三角 | `--dsw-static-deepseek-600` | `--dsw-alias-state-business-primary` |
| 12 | `state=created` 或 `turn.state=accepted` | 待启动 | 未计入运行中 | 空心起点 | `--dsw-static-neutral-bluish-700` | `--dsw-static-neutral-bluish-300` |
| 13 | 其他/缺失 | 未知 | 不推断 | 问号 | `--dsw-alias-label-secondary` | `--dsw-alias-label-secondary` |

补充规则：

- 失败排在完成之前：同一快照若同时出现 `turn.state=failed` 与完成态，优先暴露本轮失败；不能静默美化。
- 归档排在 queued 之前：历史归档行不显示为当前排队。
- `state=lost` 单独计入「共」，不擅自计入「失败」；其连接/心跳含义由既有数据决定，UI 不推断原因。
- `state=created + activation=inactive + turn.state=accepted` 显示「待启动」，不是「运行中」。

## 3. 单字段含义

### 3.1 `state`

| 值 | 默认呈现 | 可被更高优先级覆盖的情况 |
|---|---|---|
| `created` | 待启动 | queued 显示排队中；turn failed/aborted 等先显示结果 |
| `running` | 运行中 | lost/recovering、turn 结果、queued、等待输入优先 |
| `awaiting-input` | 等待输入 | lost/recovering、turn 结果、queued 优先 |
| `blocked` | 已阻塞 | lost/recovering、turn 结果、queued、等待输入优先 |
| `completed` | 已完成 | lost/recovering、failed、aborted、archived 优先 |
| `aborted` | 已中止 | lost/recovering、failed 优先 |
| `lost` | 已丢失 | 无；最高优先级 |
| `recovering` | 恢复中 | lost 优先 |
| `archived` | 已归档 | lost/recovering、failed、aborted 优先 |

### 3.2 `activation`

| 值 | 呈现职责 | 禁止 |
|---|---|---|
| `inactive` | 不单独改写生命周期；created/accepted 显示待启动 | 不擅自写成「已暂停」 |
| `queued` | 主状态改为排队中，副文案「等待槽位」；终态/异常按优先级处理 | 不得显示运行中，也不得计入运行中 N |
| `active` | 不额外加文案，由 state/turn.state 决定运行或结果 | active 不等于 running |
| `draining` | 正在运行时保留「运行中」并加「正在收尾」 | 不写成 queued，也不提前写成 completed |

### 3.3 `turn.state`

| 值 | 呈现职责 |
|---|---|
| `accepted` | 尚未运行，默认「待启动」；queued 时显示「排队中」 |
| `running` | 默认「运行中」；queued、lost、recovering 等更高优先级先处理 |
| `awaiting-input` | 「等待输入」，不能继续显示「运行中」 |
| `completed` | 「已完成」，但更高优先级失败/中止/丢失不被覆盖 |
| `failed` | 「失败」，显示错误块入口；仅 lost/recovering 可优先 |
| `aborted` | 「已中止」，不计入失败 |

## 4. 边界契约

### 4.1 queued

- 典型组合：`state=created + activation=queued + turn.state=accepted` → **排队中 / 等待槽位**。
- 即使 `state=running` 或 `turn.state=running` 与 queued 同时出现，只要不是更高优先级终态/异常，仍显示**排队中**。
- 本轮尚未开始时右列可显示「未开始」；最后活动时间缺失显示「未知」，不能显示 `0s 前`。
- 汇总时只进入「排队 N」和「共 N」，不进入「运行中 N」。

### 4.2 lost

- `state=lost` 是独立主状态「已丢失」，不改写成「失败」「已完成」或「运行中」。
- 保留任务摘要、实际 runtime、模型和最后活动时间，方便判断丢失前在做什么。
- 若存在错误详情则正常展开；没有错误详情时不编造 code/userMessage。
- 不计入「失败 N」；是否重试由既有错误 `retryable` 与后续操作能力决定，v1 不提供行级重启按钮。

### 4.3 degraded

`degraded` 不是新增 `state`，不另造主状态或颜色：

- **模型降级**：只在模型值后追加既有标记，如 `deepseek-v4.1-flash 降级:free`；主状态仍由三字段决定。配置未确认值使用 `≈配置值`，不得伪装成实际模型。
- **订阅降级为轮询**：只把同步状态写为「轮询中」，不把每个代理行标成失败或丢失。
- 没有明确配置/降级信息时只显示模型原值或「未知」，UI 不根据名称、延迟或失败自行推断降级。

### 4.4 单后端禁用

- 只在对应行显示「该后端已禁用，可在宿主设置中启用。」；其他行与汇总仍可正常展示。
- 行主状态仍按三字段映射，禁用提示是附加行内信息，不创建第十种 `state`。
- 不触发整页查询错误，不提供伪造的设置跳转按钮；若查询整体未启用/不可达，才使用整页错误态。

### 4.5 字段缺失与冲突

- 任一必显值缺失显示「未知」；id 不用 `00000000`，时间不用 `0`，模型不用猜测名称。
- `label` 缺失只显示「未知」，不得以 backend 或 childId 替代，以免用户误以为知道任务内容。
- 冲突快照仍按 §2 显示，并在详情保留 turnId、childId 等定位信息；不增加「数据冲突」新状态。
- 页面查询失败时所有计数为「未知」；只有成功返回空集合才显示四项 `0`。

## 5. 汇总与无障碍复核

- 「运行中 N」只统计主文案为运行中的行；「排队 N」只统计排队中；「失败 N」只统计失败；「共 N」统计全部行。
- 状态点 `aria-label` 使用映射后的中文状态；queued 的「等待槽位」必须是可见文本。
- 图标统一 `aria-hidden=true`，避免与状态文案重复播报。
- 状态文字与背景在明暗主题均 ≥4.5:1；图标/点不是唯一信息载体。
- lost、failed、queued、degraded 的文案和计数各有独立口径，互不合并。

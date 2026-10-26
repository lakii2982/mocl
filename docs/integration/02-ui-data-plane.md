# 02 — UI 数据面：GUI 需要显示什么、现在能显示什么、不新增 UI 时怎么降级

> **写域**：`docs/integration/*`（D6）。本文只定义**数据面**（字段、来源、上限、呈现规则），不做视觉设计（BRIEF §5 非目标）。
> **事实基线**：DSH 0.2.1-rc.3 的 `@deepseek-ai/dsh-client-ui-subagent`（下称 UI 包）与 `@deepseek-ai/dsh-subagent`（seam）安装物；证据以包内 README 原文为准（asar 内路径见 `.astra/CONTEXT-DSH-SEAM.md` §1）。ABI 事件/字段以 `docs/abi/abi-v0.md` §7/§11 为准。
> **路线前提**：路线 A（`00-dsh-integration.md`）。官方 UI 对外部子级的「叶子、只读、不显示执行状态」是 seam 的硬事实（S5），不是本文能改的；要改属于路线 B。

---

## 0. 结论（一页）

| 问题 | 答案 |
|---|---|
| 官方 GUI 现在能显示外部后端的什么？ | **只有一条不可打开的叶子条目**（label/mode），**不显示执行状态/进度/用量/错误/子代理树**；父级对话里另有一条完成通知（最终回答 + 结构化结果 + 诊断）。证据：UI 包 README「概述」「目录派生」；seam README「catalog 不携带执行状态」。 |
| 一期不新增 UI 时靠什么？ | **完成通知（终态 1 条）+ `mocl_status` 查询工具 + 落盘文件**（journal/progress/report）。父会话零中间消息，符合 BRIEF §6-3 与 KV cache 约束。 |
| 二期 UI 需要新增的最小集合 | **5 项**：① 状态徽标 ② 可折叠进度 ③ 用量行 ④ 结构化错误块 ⑤ 外部原生子代理树（只读）。 |
| 新增 UI 的最小改动面 | 新增自己的 client-ui 插件 `@mocl/dsh-client-ui-mocl`（读 Bridge 服务），**不 fork/不改** `dsh-client-ui-subagent`；官方叶子条目仍保持叶子（除非走路线 B）。 |
| 数据上限（硬） | 进度：**≤8 条/轮、≤1200 字符/轮、≤400 字符/条、折叠窗口 1–60s（默认 5s）**；终态永不折叠。与 `01-config-and-enable.md` G12–G15 同一组硬上限。 |

---

## 1. 现有 DSH UI 事实（逐条证据）

| # | 事实（README 原文/等价表述） | 对数据面的含义 |
|---|---|---|
| U1 | 会话页头可以浏览「本地子代理对话与外部任务」；**本地对话展示活跃状态、token 用量和耗时**；**外部任务显示为不可打开的叶子项，不展示执行状态** | 外部后端的状态/用量/耗时没有现成渲染位；不能把「UI 可见」当验收前提 |
| U2 | 可继续子代理「接受后续提示词并支持 Stop」；**外部任务**没有输入框/Stop（一次性、执行一次） | 外部后端的「继续/中断」只能走兼容层工具（`mocl_*`），UI 一期无按钮 |
| U3 | 「历史一次性对话以只读记录打开」；one-shot child 始终选用只读编辑器 | 完成后的外部任务若被官方 UI 打开，也只能只读；不作为我们的主视图 |
| U4 | 目录行显示 `mode`、活动状态、可选 title；尾随列显示 token 用量总计与活跃轮耗时（针对本地子会话） | 需要的字段在 UI 包内**已有渲染概念**（状态点/token/耗时），但数据源是本地 Session 投影，外部条目走不到 |
| U5 | 「外部行始终为叶子，不加载子 Session」；catalog「仅创建时记录一次成员关系，**不携带执行状态**」 | 连「外部任务的状态」都没有落进 DSH 的 projection；要显示必须由兼容层自己提供数据源 |
| U6 | 普通侧边栏省略子代理对话；独立的 `@` 来源只插入运行中**本地** child 的标签，且「不授予继续执行权限」 | 外部后端不能被 `@` 引用/续接；不要设计「@ 一个 kimi 子代理继续聊」的交互 |
| U7 | `list_agents` **主动省略外部条目**；`send_message` 只对本地可继续子级；`interrupt_agent` 对外部执行是「永久停止」 | DSH 原生控制面不覆盖外部后端；UI 若做「停止」按钮，只能调兼容层工具 |
| U8 | 完成通知：父级投递发送「包含子级最终输出中非空文本块的 user-role 状态通知」；**外部通知还说明不支持后续消息**；结构化结果以 `Structured result: <JSON>` 附带，另附提供方安全诊断 | 一期唯一「免新增 UI」的结果通道；它**只承载终态**，不是进度通道 |
| U9 | 插件页有「**子智能体**」设置页（Host `subagent` / `subagent-model-selection`）：最大递归深度、并行数量上限、模型选择 | 配置的面板已有，不需要我们另做；但只覆盖 seam 的深度/容量，不覆盖兼容层 per-backend 配置 |
| U10 | UI 包「已知限制」：目录不区分失败/取消/拒绝/token 耗尽等 inactive 原因；`@` label 有歧义 | 即使 UI 二期，也要用**错误码**弥补「状态只有一个点」的信息损失 |

> 证据位置：`@deepseek-ai/dsh-client-ui-subagent/README.zh.md`（概述、使用本包三节、目录派生、已知限制）；`@deepseek-ai/dsh-subagent/README.zh.md`（Activation 结算/catalog 段）；`@deepseek-ai/dsh-tool-subagent-control/README.zh.md`（三个控制工具）；`@deepseek-ai/dsh-client-ui-settings-subagent/README.zh.md`（插件→子智能体页）。asar 内路径：`…/dsh/node_modules/@deepseek-ai/<pkg>/README.zh.md`。

---

## 2. 数据面总览（谁产生、谁消费）

```text
后端原生事件
  → L1 适配器归一化（docs/adapters/* §5）
  → L2 Broker 分配 seq/epoch + journal 持久化（EV-6）
  → L3 总线：校验/去重/折叠 → progress.folded（≤8 条/1200 字符/轮）
  → 三个消费面：
     (a) 父会话：seam 完成通知（终态 1 条，自动）
     (b) 工具面：mocl_status / mocl_interrupt / mocl_recover（按需）
     (c) 文件面：journal.jsonl / progress.jsonl / report.json / artifacts
  → 二期：自有 client-ui 插件读同一服务（不开新真相）
```

**硬规则**

1. **单一真相**：UI/工具/文件都读 Broker；UI 不得自己推断状态（INV-L4-3）。
2. **终态必达**：`turn.completed|failed|aborted`、`session.state-changed` 终态**永不被折叠丢弃**（ABI §11.1；`01-layers.md` INV-L3-2）。
3. **中间进度可折叠、可关闭**：`progress.mode=off` 时中间态为 0 条，但终态与结果完整（ABI §11.3）。
4. **只追加**：父会话只出现完成通知，不回写/不修改已有前缀（KV cache）。
5. **敏感信息**：状态/进度/错误中不得出现凭据/Authorization/stderr 原文（ABI SEC-1；错误只给 `code`+`userMessage`+`traceId`）。

---

## 3. 字段清单（GUI 要显示的数据）

> 来源列：`E` = ABI 事件（`docs/abi/abi-v0.md` §7）；`Q` = ABI 查询方法（M6/M7）；`L` = L3 折叠输出（§11.1）；`C` = 兼容层补充（配置/映射/版本）。

### 3.1 会话与身份（8 字段）

| 字段 | 类型/枚举 | 来源 | 说明/上限 |
|---|---|---|---|
| `sessionId` | string `sess_*` | Q/C | 兼容层会话唯一 id（INV-L4-1） |
| `childId` | string | C | seam activation id（与 `sessionId` 双向映射持久化） |
| `parentSessionId` | string/null | Q/C | 嵌套父会话；深度校验依据 |
| `backendId` | enum `codex|kimi|claude-code|opencode` | C | 四后端统一命名（与 ABI schema 一致） |
| `label` | string ≤120 字符 | C | 建议格式 `[backend] 任务摘要`（官方叶子条目唯一可辨认信息） |
| `cwd` | string（绝对路径） | C | 家目录按配置脱敏；跨出允许根 → `policy.sandbox-violation` |
| `depth` | int 0–3 | C | `maxDepth` 校验值（默认 2） |
| `mode` | enum `external`/`one-shot`/`continuable` | C | 路线 A 下恒为 `external`（seam catalog 语义） |

### 3.2 状态（6 字段）

| 字段 | 类型/枚举 | 来源 | 说明 |
|---|---|---|---|
| `state` | `created/running/awaiting-input/blocked/completed/aborted/lost/recovering/archived` | E `session.state-changed` | 唯一权威状态（02-state-machine §2）；UI 不得自算 |
| `previousState` | 同上 | E | 转移事件必带（EV-5） |
| `reason` | string ≤160 | E | `stateReason`（如 `invalidated`/`quota-exhausted`/`orphan-mapping`） |
| `activation` | `inactive/queued/active/draining` | Q | 并发槽位；`queued` 时 UI 显示「排队中」而不是「运行中」 |
| `turn.state` | `accepted/running/awaiting-input/completed/failed/aborted` | E | 当前轮状态；用于「正在做什么」文案 |
| `turn.turnId` | string | E | 关联进度/结果 |

### 3.3 进度（`progress.folded`，冻结对象 ABI §11.1）

| 字段 | 类型/上限 | 来源 | 说明 |
|---|---|---|---|
| `window.startMs/endMs` | int（毫秒） | L | 折叠窗口（默认 5000ms，最小 1000ms） |
| `items[]` | 数组 **≤8 条/轮** | L | 每项 `{kind ∈ state/turn/tool/plan/diff/usage/child/error/result, key, text, count?}`；`kind` 决定图标/分组 |
| `items[].text` | string **≤400 字符** | L | 超长截断 + `truncated:true`；自包含（不依赖上一条） |
| `chars` | int **≤1200/轮** | L | 本轮累计字符；达到上限后只发 1 条「已折叠 N 条」收尾 |
| `dropped` | `{count, kinds[]}` | L | 丢弃计数（必须展示，否则用户以为没发生） |
| `truncated` | bool | L | 是否被截断 |
| `lastSeq` | int 单调 | Q | 断线/重连/轮询的游标；UI 显示「已同步到 seq=N」 |

**呈现规则**：同 `key` 跨窗口去重（后到覆盖先到）；`kind=child` 与 `kind=error` 优先保留；`reasoning` 默认不显示（`includeReasoning:false`）。

### 3.4 用量（ABI §7.5 `usage.updated`）

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `inputTokens` / `outputTokens` / `reasoningTokens` | int/null | E | 拿不到就省略，不填 0 |
| `costUsd` | number/null | E | **只在后端提供时显示**；codex 无（G8），claude/opencode 有，kimi 不可对账 |
| `durationMs` | int | E/C | 轮次耗时（UI 包本地行已有同概念） |
| `estimated` | bool | E | `true` 时 UI 加「≈」 |
| `precision` | `exact/coarse/none` | C | kimi `coarse`（ACP `usage_update`）、无 usage 后端 `none`；`none` 时隐藏用量区块 |
| `scope` | `turn/session` | E | 轮次或累计，标签不同 |

### 3.5 子代理树（外部后端原生子代理）

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `childSessionId` | string | E `child.*` | ABI §7.7 |
| `nativeAgentId` | string/null | E | codex `receiverThreadIds` / claude `agent-*.meta.json` 的 id |
| `name` / `label` | string/null | E | 后端提供时显示；否则回退 id（与 UI 包「无 label 回退会话 id」一致） |
| `depth` | int | E | 相对外部会话的层数 |
| `state` | 同 3.2 | E `child.state-changed` | 无 `childSessionUpdates` 时只有 `child.completed`（R-14 降级） |
| `summary` | string ≤400 | E `child.completed` | 终态摘要；中间过程折叠进父 `progress.folded` |

**降级事实**：kimi ACP 无子代理方法 → 树为空（`childSessionUpdates=unavailable`）；opencode 子会话事件存在（`parentSessionID`/`childSessionID`）但**事件全集未验证**（C7 补测；免费模型已可用，D-018/D-019）；codex/claude 可观测。**不要画「四后端都有统一子代理树」的承诺**。

### 3.6 错误（ABI §8）

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `code` | enum 46 码（ABI §8.2） | E/Q | 如 `session.invalidated`、`limit.concurrency-exceeded`、`policy.permission-denied` |
| `category` | enum 12 类 | E | 分组色/文案（transport/auth/quota/protocol/process/capability/session/policy/storage/limit/security/internal） |
| `userMessage` | string ≤60 字 | E | **UI 主文案**（中文），禁止透传 stderr（INV-L4-4） |
| `retryable` | `no/once/backoff/after-recovery` | E | 决定是否显示「可重试」 |
| `retryAfterMs` | int/null | E | 显示倒计时/建议等待 |
| `severity` | `warning/error/fatal` | E | 徽标颜色 |
| `traceId` | string | E | 可复制（排障锚点） |
| `preservedThroughSeq` | int/null | E/C | 失败时「结果保留到 seq=N」 |
| `backendCode` | string/null | E | 折叠在「详情」里，不主显 |

### 3.7 集成/可观测（辅助排障，可折叠）

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `backendVersion` | string | C | 如 `0.153.4`/`2.3.1`（握手断言结果） |
| `transport` | enum 5 值 | C | `app-server-jsonrpc/acp-stdio/agent-sdk/http-api/cli-stream-json` |
| `protocolVersion` | string/null | C | 原生协议版本 |
| `degradeWarnings[]` | string[] | C | 能力降级/版本未钉住等（ABI `warnings`） |
| `configDigest` | string（前 12 位） | C | 排查「配置没生效」的第一现场（01 文档 §5.5 V2） |

---

## 4. 逐项「现有 DSH 能渲染 / 需要新增」

| # | GUI 数据 | 现有 DSH 能渲染？ | 证据/原因 | 一期处理 | 二期新增 |
|---|---|---|---|---|---|
| R1 | 外部任务存在与 label | ✅ 能（叶子条目） | UI 包「外部任务显示为不可打开的叶子项」；catalog `mode:'external'` | label 带 `[backend]` 前缀 | 无 |
| R2 | 生命周期**状态** | ❌ 不能 | UI 包「不展示执行状态」；catalog「不携带执行状态」 | `mocl_status.state` + 完成通知；文件 | **新增**状态徽标（3.2） |
| R3 | 激活态（排队/运行/收尾） | ❌ 不能 | 外部条目无 Session 投影 | `mocl_status.activation` | 并入状态徽标（副文案） |
| R4 | **进度**（折叠项/丢弃计数） | ❌ 不能 | 外部条目无 Session 投影；进度只存在于 Broker | `mocl_status` 返回最新 `progress.folded`；`progress.jsonl` 文件 | **新增**可折叠进度面板（3.3） |
| R5 | **用量**（token/成本/耗时） | ❌ 不能（外部） | UI 包 token/耗时只对本地子会话生效 | `mocl_status.usage` + `report.json` | **新增**用量行（3.4） |
| R6 | 子代理**树** | 🟡 部分（本地可展开；外部为叶子且不加载子 Session） | UI 包「外部行始终为叶子，不加载子 Session」；`list_agents` 省略外部 | `mocl_status.children[]`（有则显示）；无则明示「该后端不上报子代理」 | **新增**只读树（3.5） |
| R7 | **错误码/可重试/traceId** | ❌ 不能（外部） | 完成通知只有文本 + 诊断串，无结构化错误码 | `mocl_status.error` + 完成通知的 `userMessage` | **新增**结构化错误块（3.6） |
| R8 | 继续输入（send_message） | ❌ 不能 | `send_message` 只对本地可继续子级；外部通知明说「不支持后续消息」 | 用 `mocl_recover`/重新派发；不承诺「继续聊」 | 需路线 B 才可原生 |
| R9 | 中断 / Stop | ❌ 不能（外部） | UI 输入框对 one-shot 只读；`interrupt_agent` 对外部是永久停止（工具面可用） | `mocl_interrupt` 工具 | **新增**可选（需产品确认「停止」语义为永久停止） |
| R10 | `@` 引用外部任务 | ❌ 不能 | `@` 来源只列运行中本地 child | 不做 | 不做（无继续语义，引用无意义） |
| R11 | 版本/降级警告/configDigest | ❌ 不能 | 无外部投影 | `mocl_status` 折叠区 + 日志 | 并入「详情」抽屉 |
| R12 | 完成通知（最终回答） | ✅ 能（自动） | seam 完成通知（最终文本 + `Structured result` + 诊断） | 依赖它作为唯一「免 UI」结果通道 | 保持 |

> 「需要新增」的判定口径：**官方 UI 包在不 fork 的前提下无法从外部条目或父会话拿到该数据**。R1/R12 是现有可用的两个锚点；其余 5 项（R2/R4/R5/R6/R7）就是 §0 的最小集合。

---

## 5. 最小新增集合（≤5 项，二期）

| 优先级 | 组件 | 必显字段 | 数据源 | 上限/交互规则 |
|---|---|---|---|---|
| P0 | **状态徽标** | `state` + `activation` + `turn.state` + `reason`（tooltip） | `mocl_status` / 订阅 `session.state-changed` | 状态色不依赖文案；`lost/recovering` 显示「恢复中」+ 可查 `mocl_recover` |
| P0 | **可折叠进度面板** | `items[].{kind,text,count}` + `dropped.count/kinds` + `lastSeq` | `mocl_status.progress` / `progress.folded` 订阅 | 默认折叠为一行「3 个工具 · 2 条计划更新 · 丢弃 274 条」；展开后**最多 8 条、总 1200 字符**；终态单独固定展示 |
| P1 | **用量行** | tokens（in/out/reasoning）、costUsd、durationMs、`estimated`/`precision` | `usage.updated`（经 `mocl_status.usage`） | `precision=none` 隐藏；`estimated=true` 加「≈」；不用于计费对账（见 `docs/research/capability-matrix.md` `usage-observability` 对策列） |
| P1 | **结构化错误块** | `code`、`category`、`userMessage`、`retryable`、`retryAfterMs`、`traceId`、`preservedThroughSeq` | `error` 事件（经 `mocl_status.error`） | 主显 `userMessage`；`code`/`traceId` 可复制；禁止展示 stderr/绝对凭据路径 |
| P2 | **外部原生子代理树** | `children[].{childSessionId,name,state,depth,summary}` | `child.*` 事件（经 `mocl_status.children`） | 只读、最多 `maxDepth` 层；无数据时明示「该后端不上报子代理」而不是空白 |

**明确不做（一期/二期都不做）**：外部子代理的输入框/继续对话、`@` 引用、token 级实时打字效果、官方叶子条目「可打开」（后者需要路线 B 改 catalog/UI 契约）。

**实现约束（二期）**：

1. 新包 `@mocl/dsh-client-ui-mocl`，**不 fork** `dsh-client-ui-subagent`；注册自己的 Sidebar tab/面板（可用自有 resource scheme；第三方 client 插件能否注册 Sidebar tab 属 A3 待验证项，若不支持则退化为会话内独立面板），数据来自 Bridge 暴露的只读查询面（与 `mocl_status` 同源）。
2. 订阅优先（Broker 推送 `progress.folded`/`state-changed`），**不开 <1s 轮询**；面板关闭即释放订阅。
3. 渲染前二次校验上限（8/1200/400），超限截断并显示 `truncated`；折叠算法不在 UI 重做（L3 输出即最终值，INV-L3-3）。
4. 外部条目在官方目录中仍为叶子：自有面板与官方叶子并存，不改官方行为（路线 A 的 UI 一致性边界，见 `00-dsh-integration.md` §3.1）。

---

## 6. 不新增 UI 时的降级呈现（一期默认）

### 6.1 三个载体

| 载体 | 内容 | 上限/位置 | 谁消费 |
|---|---|---|---|
| **工具返回值** | 派发确认 `started subagent <childId>`（seam 原生）；`mocl_status` 返回完整状态对象（3.1–3.7）；`mocl_interrupt`/`mocl_recover` 返回结果 | 状态对象 ≤2 KiB；进度最多返回最新 1 个窗口 | 父代理（模型） |
| **完成通知** | 最终回答文本 + `Structured result: <JSON>` + 提供方安全诊断（seam 原生，终态 1 条） | 沿用 seam 上限；`progress.*` 不再向父会话追加中间消息 | 用户（对话流） |
| **文件** | `~/.mocl/state/sessions/<sess_id>/journal.jsonl`（追加事件）、`progress.jsonl`（有界环形，最近 64 窗）、`report.json`（终态摘要）、`~/.mocl/artifacts/*`（大输出） | journal 按 `journal.retentionDays`；progress 环形；report ≤16 KiB | 用户/排障工具 |

### 6.2 降级呈现模板（给父代理的提示词约定）

派发后父代理应向用户说明（由工具描述/系统提示保证，不逐条写死）：

```text
已派发 [codex] 子任务 <label>（会话 sess_… / childId …）。
状态与进度：调用 mocl_status(sessionId="sess_…") 查询（默认只查本父链）。
中断：mocl_interrupt(sessionId=…)；恢复：mocl_recover(sessionId=…)。
结果：完成时会收到 1 条完成通知；明细见 ~/.mocl/state/sessions/<sess_id>/report.json。
限制：本后端在 DSH 官方 UI 中只显示为不可打开的叶子条目（无实时状态），这是当前 seam 的已知限制。
```

### 6.3 降级下的「可接受性」判定（避免自欺）

| 场景 | 仅工具+文件是否可接受 | 理由 |
|---|---|---|
| 单次委派、看最终结果（PR 评审、批量修复、调研） | ✅ 可接受 | 完成通知足够；进度只在长任务时需要 |
| 需要实时看「在干什么」的小时级任务 | ❌ 不可接受 | 只能轮询 `mocl_status`；轮询消耗父上下文 token（R21） |
| 需要中途干预/继续对话/Stop | ❌ 不可接受 | 兼容层只能「重建/恢复/永久停止」，语义与本地子代理不同（S3） |
| 多子代理并行、要看树 | 🟡 部分 | `mocl_status.children` 可看终态/已知状态；无实时树（S5/R-14） |

> 若目标用户主要是「单次委派看结果」→ 一期降级成立；若长任务/交互是主场景 → 提前启动 A3（自有 UI）或路线 B（`00-dsh-integration.md` §6.4）。

### 6.4 文件面格式（最小契约，施工 C8 落地）

```text
~/.mocl/state/sessions/sess_<id>/
├─ journal.jsonl     # 每行一条 ABI 事件/状态记录（含 seq/epoch/ts），append-only
├─ progress.jsonl    # 每行一个 progress.folded 窗口（环形保留最近 64 个）
└─ report.json       # 终态摘要：{sessionId, backendId, state, turn, usage?, error?, children[], resultRef, preservedThroughSeq}
```

- `report.json` 字段与 §3 同名同义；`resultRef` 指向 artifact（若结果超限）。
- 文件写入与 journal 同事务边界（先写后投递，EV-6）；`report.json` 原子替换（临时文件 + rename）。
- 权限：目录 `0700`，文件 `0600`；不含凭据（SEC-1）。

---

## 7. 与父会话增量/配置的关系

| 配置 | 对 UI 数据面的影响 |
|---|---|
| `global.parentDelivery` | `parent`（默认）才有完成通知与 catalog 条目；`caller` 下 UI 完全不可见（仅工具/文件） |
| `global.progress.mode` | `off` = 无中间进度（终态仍达）；`summary`（默认）= 折叠窗口；`events` = 更密（仍受 8/1200 硬上限） |
| `progress.samplingWindowMs` | UI 刷新节奏（≥1000ms） |
| `progress.includeReasoning` | 是否展示思考摘要（默认 false） |
| `global.journal.dir` / `retentionDays` | 文件面位置/保留期 |
| `backends.<b>.logLevel` | 排障详情（不直接进 UI） |
| 路线 B（二期） | catalog 带状态后，官方 UI 可直接显示；自有面板退化为增强 |

**父会话呈现规则（ABI §11 落地）**：终态结果作为**最后一条**追加；中间进度不写入父会话（路线 A）。`progress.folded` 一期只服务工具/文件/自有 UI，不增加父会话消息数。

---

## 8. 验收断言（可执行）

| ID | 断言 | 方法/证据 |
|---|---|---|
| UI-T1 | `mocl_status` 返回对象含 §3.1–3.7 全部**必显**字段（缺失以 `null` 表示，不允许缺键） | JSON Schema 校验（施工 C8 `schema/status.schema.json`） |
| UI-T2 | 进度上限：任一 30s 轮次 `items ≤ 8 && chars ≤ 1200 && 每条 chars ≤ 400`；`progress.mode=off` 时中间态 0 条但终态与结果完整 | 事件序列断言（与 L3 测试同一 fixture） |
| UI-T3 | 折叠确定性：同一事件流重放两次，`progress.folded` byte-level 相同 | ABI-T1 同款回放测试 |
| UI-T4 | 终态不被折叠：注入 10k token 事件后，`turn.completed|failed|aborted` 恰好 1 条且必达 | 故障注入 F18 |
| UI-T5 | 错误块无敏感信息：`mocl_status.error` 与 `report.json` 不含 `Bearer`/`sk-`/长 token/原始 stderr；`userMessage` 非空 ≤60 字 | 正则扫描 + golden file |
| UI-T6 | 外部条目不假装可继续：官方 UI 打开外部行时仍为只读；`@` 不列外部；`send_message` 对外部返回明确失败 | 手工/UI 自动化断言（与 UI 包行为对齐） |
| UI-T7 | 免 UI 降级可用：只装官方 UI 时，完成通知到达、`report.json` 字段齐全、`mocl_status` 可查 | 端到端 smoke（`00-dsh-integration.md` §9.3 S2/S4） |
| UI-T8 | 二期面板：订阅优先、无 <1s 轮询、关闭即释放；渲染上限二次校验 | 面板单测 + 网络/订阅计数断言 |
| UI-T9 | 安全：状态/进度/用量/错误中无凭据；路径仅绝对路径且家目录按配置脱敏 | 配置 `logLevel=debug` 下扫描日志/事件 |

---

## 9. 待澄清（本文新增）

| ID | 事项 | 冲突/缺口 | 建议 |
|---|---|---|---|
| D6-U1 | R21 风险「进度只存在于工具返回值，无处查询」 | `docs/risk/00-risk-register.md` R21 的兜底是「会话代理暴露 status/list + 事件落 jsonl」——本文正是该兜底，但风险登记册尚未引用本文 | D7 复核时把 R21 的「验证方式」指向本文 UI-T1/T7 |
| D6-U2 | UI 包「活动状态」对本地子会话可用，但外部子级没有；`mocl_status` 的状态枚举与 UI 包的活动状态不是一套 | 两套状态词汇（ABI state vs UI 活动状态） | 自有面板只显示 ABI `state` + `activation` 两列，明确不做「绿点/灰点」的单点压缩（避免丢失失败/取消原因，见 UI 包已知限制 U10） |
| D6-U3 | 路线 A 下官方 UI「外部叶子」无法显示状态，是否要在自有面板里注册新的官方 resource 以避免用户找不到 | UI 包注册 `dsh-resource://subagentchat/...`，自有插件应用不同 scheme，不能复用官方行 | 二期在自有 tab 提供入口；若产品要求「官方叶子可点开」，只能走路线 B（`00-dsh-integration.md` §6.4 条件 1） |
| D6-U4 | 中断按钮语义 | UI 包 Stop 只对运行中可继续子级；外部后端中断 = `mocl_interrupt`（codex/claude/opencode 原生或 kimi 进程级） | 一期不提供 UI 按钮（仅工具）；二期若加，文案必须是「中断（不可继续）」，不得复用「停止」 |
| D6-U5 | opencode 子代理树数据 | `parentSessionID`/`childSessionID` 存在但事件全集未验证（C7 补测；免费模型可用，D-018/D-019） | UI 树对该后端显示「**待验证**」而非「不可用」，不伪造层级；opencode 本身已可用（生产 key 需新建，D-019） |

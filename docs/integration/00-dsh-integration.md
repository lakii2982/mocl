# 00 — DSH 接入方案：旁路插件 vs seam 改造（DEC-2 / DEC-3）

> **写域**：本文件与 `01-config-and-enable.md`、`02-ui-data-plane.md`（D6）。本文回答「兼容层怎么接进 DSH、两条路线怎么选、推荐哪条、什么时候改走另一条、怎么迁移」。
> **上游真源**：seam 硬事实以 `.astra/CONTEXT-DSH-SEAM.md` 与 DSH 0.2.1-rc.3 安装物为准（本文每条都标证据位置）；ABI/架构/适配器分别以 `docs/abi/abi-v0.md`、`docs/architecture/*`、`docs/adapters/*` 为准，本文只引用不重定义。
> **验证命令**（在本仓库根执行）：`python3 tools/check_docs.py integration`；本机 DSH 组合校验配方见 §9。

---

## 0. 结论（60 秒版）

| 决策 | 结论 | 一句话理由 |
|---|---|---|
| **DEC-2 路线** | **推荐路线 A（A1 形态：旁路插件 + seam 公开 provider 扩展点；不改 seam 源码/契约）**，一期落地；路线 B（扩展 seam 让外部后端 continuable）作为二期立项候选 | A 的改动面全部在「新增 profile 插件 + 配置」，DSH 升级只影响 provider 契约的薄适配层；B 要改 seam 契约 + catalog + 控制工具 + 官方 UI 四件套，且 DSH 以 asar 分发，本地改核心与 BRIEF §5「不 fork 官方包」直接冲突 |
| **DEC-3 进度载体** | **一期：终态完成通知（seam 原生，1 条）+ `mocl_status` 查询工具 + 落盘文件（journal/progress/report）**；不向父会话写中间进度消息 | 走 seam 的外部子级没有「工具返回值增量」通道（工具立即返回 `started subagent <childId>`），而往父会话追加中间消息会直接触犯 BRIEF §6-3 与 KV cache 约束；查询 + 文件是唯一零上下文成本的载体 |
| **立项顺序** | A0（provider 契约 spike，1–2 人日）→ A1（Bridge MVP：Broker 投影 + 4 provider + 配置，3–5 人日）→ A2（统一工具 + 控制工具，2–3 人日）→ A3（自有 UI，6–10 人日，可与 A2 并行）→ **B0 并行工作流 W1（RFC/issue 草案 + 接口预留 + 原型，不阻塞 A0–A3；D-017）** | A0/A1 是任何路线都要的（L4 投影 + ABI 会话真相），先做不浪费；B 的前置是上游契约变更，本地无法验证 |
| **回滚** | 配置级回滚：删/停用 patch 行 + `dsh plugin --profile desktop remove`，目标 ≤5 分钟，无数据迁移 | A 不碰 DSH 核心文件，回滚 = 恢复 patch 备份 + 重启；journal 是追加数据，保留不影响旧路径 |
| **codex 基线** | **生产基线 = 最新版 0.164.0（D-015）**；bundle 0.153.4 是待升级旧载荷，升级路径与验收（两处 `--version` 一致）见 `HANDOFF.md` C11 前置 | 旧 bundle 与 host 协议差（0.153.4：99/81；0.164.0：106/85），不升级会长期双版本维护 |
| **后端交付完整性** | **四后端链路全部可用（D-018/D-019）**：opencode 生产模型 `opencode-go/deepseek-v4.1-flash` 需用户**新建 key**（旧 key 已过期且重登录不续期）；key 失效时降级免费模型 `opencode/deepseek-v4.1-flash-free`（已实测 rc=0 + `-s` 续接），发 `degraded` 事件并声明 `model=free-fallback`，不静默 | opencode 不再是交付缺口；唯一剩余是一次性人工动作（新建 key） |

**本方案不做什么**：不修改 DSH 安装目录/asar 内任何文件；不 fork `@deepseek-ai/dsh-*` 官方包；不写实现代码；不改 `docs/architecture/*`、`docs/abi/*`、`docs/adapters/*` 的结论。若本文与它们冲突，以 `.astra/LEDGER.md` 的裁定为准（D-007 opencode 走 v2 HTTP 优先；D-015 codex 基线 0.164.0；D-016 并发取运行时；D-017 B0 并行；D-018/D-019 opencode 链路可用 + 生产/free 模型分级，本文全部遵守）。

---

## 1. seam 硬事实基线（方案不得与之矛盾）

> 以下每一条都来自本机 0.2.1-rc.3 安装物或 Lead 已核验的 `.astra/CONTEXT-DSH-SEAM.md`；`…/dsh-subagent/…` 路径均在 asar 内，读取方法见 CONTEXT §1。

| # | 事实（原文/证据） | 对方案的硬约束 | 路线 A 如何绕过 | 路线 B 如何解除 |
|---|---|---|---|---|
| S1 | **两类子级**：本地（spawn/fork，持久会话、可续接、可冷恢复）与**外部**（ACP/DSH SDK/Codex/Claude Code，**执行一次、拒绝后续输入**）。证据：`@deepseek-ai/dsh-subagent/README.zh.md`「本地与外部子级」「已知限制」；`.astra/CONTEXT-DSH-SEAM.md` §2 | 不能把「续接/多轮/冷恢复」寄托在 seam 的外部条目上 | 会话真相（id 映射、状态机、journal、冷恢复、续接）**全部由兼容层 Broker 自管**；seam 只被当作「一次执行 + 完成通知」的投递通道（L4 投影），每次交互走 Broker 自己的控制工具（§4.3） | 扩展 provider 契约，让外部 provider 也实现可继续执行（persistent remote session id + 逐子级 continuation 能力声明，即 seam dev-note 明列的延期项） |
| S2 | 外部后端能力位写死 **`NO_START_CAPABILITIES = { agentOptions:false, agentPreset:false, outputSchema:false, depthLimit:false }`**。源码注释原文：*"A child in another process cannot honor parent-enforced start features … the service rejects a request needing any of them before `start` runs — never accepted-then-ignored."* 证据：`.astra/CONTEXT-DSH-SEAM.md` §2；`…/dsh-subagent/lib/index.js`（常量定义处） | 经 seam 请求外部后端时**不能**携带 `agentOptions`（模型/推理档）、`agentPreset`、`outputSchema`、数值 `maxDepth`；否则请求在 `start` 前被拒绝（`UNSUPPORTED_CAPABILITY`），不是「接受后忽略」 | 模型/权限/深度/输出 schema **不进 seam 请求**，改由兼容层的配置与自有工具参数承载，在 Broker `session.create/send` 参数里执行（ABI M2/M3 已有 `model`/`permissionProfile`/`limits` 字段）；工具行必须配 `maxDepth: provider-managed`（数值会触发拒绝，见 §4.4） | 让外部 provider 能声明并真正执行这四项（跨进程透传 + 父级侧校验），seam 才可恢复数值 maxDepth 与 agentOptions 语义 |
| S3 | `send_message` / `interrupt_agent` / **冷恢复**只对本地 `mode: continuable` 生效；`send_message` 要求「确切在线 sender」；`list_agents` **主动省略外部条目**。证据：`…/dsh-tool-subagent-control/README.zh.md`（`send_message`/`interrupt_agent`/`list_agents` 三节）；`.astra/CONTEXT-DSH-SEAM.md` §2 | 不能承诺「用 DSH 的 `send_message` 继续外部后端会话」；UI 的输入框对一次性子级只读、Stop 只对运行中可继续子级可用 | 兼容层提供自己的控制工具（`mocl_status` / `mocl_interrupt` / `mocl_recover`），内部走 Broker + ABI M5/M8；`interrupt_agent` 对外部只作为「永久停止」的语义使用（seam 原文如此），结果由 Broker 映射为 `turn.aborted{interruptMethod:"process-kill"}` / `aborted` | seam 为外部子级增加持久邮箱/租约与 `prepareContinuable()`（dev-note 两条延期项），`list_agents` 纳入外部、控制工具可路由；UI 输入框/Stop 按本地同级放行 |
| S4 | `maxDepth: 'provider-managed'` = **不向进程外后端发送上限**；数值深度要求 provider 具备 `depthLimit` 能力。证据：`…/dsh-tool-subagent/README.zh.md`（`maxDepth` 字段与「达到上限」两节）；S2 | 外部后端的委派工具必须 `maxDepth: provider-managed`；「深度上限」只能由兼容层自己执行 | 兼容层在 `session.create` 前校验 `parentSessionId` 链深度（配置 `maxDepth`，默认 2，依据 codex 原生 `[agents] max_depth=2`，见 `docs/adapters/codex.md` §9.1 / `docs/architecture/00-overview.md` AR-V4），超限拒绝并返回 `limit.nesting-exceeded`；seam 侧不校验（也不显示深度提示） | provider 声明 `depthLimit:true` 后，seam 可接收数值 `maxDepth` 并在启动前执行父级上限，深度提示/拒绝统一由 seam 表达 |
| S5 | `subagent/catalog` **对外部条目只记叶子**：外部创建仅在使用 `delivery:'parent'` 时追加目录事实，`mode:'external'`（catalog payload v2），「目录仅在创建时记录一次成员关系，**不携带执行状态**」；UI 侧「外部任务显示为不可打开的叶子项，不展示执行状态」。证据：`…/dsh-subagent/README.zh.md`（Activation 结算 / catalog 段）；`…/dsh-subagent/lib/types/catalog.js`（`externalCatalogSchema`）；`…/dsh-client-ui-subagent/README.zh.md`（概述 + 目录派生） | 官方 GUI 只能显示「有一个外部任务」，看不到状态/进度/用量/子代理树/错误码；不能把「UI 可见」当作验收前提 | 接受这一事实：官方 catalog 行只作「任务存在 + label」；状态/进度/用量经 `mocl_status` 工具与落盘文件提供；二期用**自有 client-ui 插件**（不改官方包）补齐面板（`02-ui-data-plane.md`） | catalog 升 v3：外部条目携带 `state/progressSummary/usage/error`，UI 按可继续/只读详情展示，官方条目不再只是叶子 |

补充事实（影响配置与容量，不单独列行）：

- seam 容量（R24/**D-016**）：`maxActiveSubagents` **一律运行时读取**（Host `subagent` 设置/组合配置），拒绝码 `ACTIVATION_LIMIT_REACHED`；**禁止硬编码任何默认值**（不写死 8）；本机 desktop 当前运行值为 20（仅实例值，文档不写死）；读取失败/字段缺失 → **fail-closed 拒绝启动**，不猜默认。兼容层上限必须 ≤ 该运行值（R24）。
- codex 基线（**D-015**）：生产基线 = **0.164.0**；bundle 0.153.4 是待升级旧载荷，升级步骤与验收（两处 `--version` 一致）在 `HANDOFF.md`「C11 前置」。
- 委派深度 Host 设置默认 **1**（`- id: subagent` 的 `maxDepth` 字段默认值；本机 patch 未覆盖它）。走 `provider-managed` 的工具不受它约束（S4）。
- 插件组合顺序：bundle 层 → profile 层 `cordis.patch.yml` → `--patch` 覆盖层（`~/.dsh/profiles/desktop/cordis.yml` 注释与 `dsh --dump-config-schema` 的 `$comment` 原文）；本机 `desktop` profile 由 Electron 独占管理，`dsh --profile desktop --dump-config` 会被拒绝（§9.2）。
- 工具 schema 成本：`dsh-tool-subagent` **每个实例**贡献一个工具 schema + 一段系统提示词 section；`dsh-tool-subagent-control` 的 `send_message`/`interrupt_agent`/`list_agents` 也各为一个固定 schema（README「Token 影响」节）。这直接决定 §5 的工具形态选择。

---

## 2. 两条路线定义与边界

### 2.1 路线 A —— 旁路插件（自管会话，不改 seam）

「旁路」的准确含义：**不修改 `@deepseek-ai/dsh-subagent` 的契约、不修改 asar 内任何文件、不 fork 官方包**；只通过 DSH 已公开的扩展点接入：

- **A1（推荐）**：新增 Host 插件 `@mocl/dsh-bridge`，把 4 个后端注册为 seam 的**具名 provider**（`ctx.subagents.registerProvider`，provider 契约就是 seam 为外部后端设计的接入口：`capabilities = NO_START_CAPABILITIES`、`start(request)`、`inheritsParentContext=false`）；会话真相、状态机、journal、冷恢复全在 Bridge 的 Broker 内。再配一个自有模型面工具 `@mocl/dsh-tool-subagent-agent`（统一入口）与自有控制工具 `@mocl/dsh-tool-mocl`（状态/中断/恢复）。
- **A2（备选，不推荐）**：完全不挂 seam（不用 `startActivation`），工具与事件全自建。少一层依赖，但失去 seam 的完成通知、容量准入、catalog 叶子条目，UI 更差、与 DSH 会话生命周期脱节更严重。只在 A1 被 upstream 某版本破坏且短期无解时启用。

### 2.2 路线 B —— 扩展 seam 让外部后端 continuable

- **B1（首选形态）**：向上游提交契约扩展（PR）：外部 provider 可声明 `agentOptions/agentPreset/outputSchema/depthLimit`、可提供 `prepareContinuable()`、catalog 携带执行状态、`send_message/interrupt/list_agents` 覆盖外部、UI 支持外部继续执行。
- **B2（备选形态）**：profile patch 用本地维护的 fork 包**覆盖** `- id: subagent` / `- id: tool-subagent-control` 等行的 `name`。技术上可行（loader 支持按 id 覆盖 name+config），但**违反 BRIEF §5「不 fork 官方包」**，需要用户显式签字，且每次 DSH 升级要 rebase。
- 路线 B 完全不改 L1 适配器与 ABI（这是 B 的主要优点：适配器规格保持有效）。

### 2.3 路线边界（防止评审时口径漂移）

| 事项 | A | B |
|---|---|---|
| 改 seam 源码/契约（`NO_START_CAPABILITIES`、provider 契约、catalog schema、control 工具、UI） | **否** | 是（B1 上游 / B2 fork） |
| 改 DSH 安装目录/asar | 否 | 否（B2 通过 profile 覆盖，仍不碰 asar；但维护 fork） |
| 新增 profile 插件行 | 是 | 是 |
| 会话真相归属 | Broker（兼容层） | seam + Broker 双写（seam 拥有 activation，Broker 仍拥有 ABI 会话与 journal） |
| 外部后端能否「续接/发送/中断后继续」 | 能（经兼容层自有工具）；**不能**经 DSH 原生控制工具/UI 输入框 | 能（原生同级） |
| 官方 UI 对子代理的可见性 | 叶子（无状态） | 完整（状态/进度/用量/子代理树） |

---

## 3. 逐项对比

### 3.1 对比总表

| 维度 | 路线 A（A1） | 路线 B（B1，若上游接受） | 判定 |
|---|---|---|---|
| **改动面** | 新增 2–3 个 profile 插件包（Bridge / 统一工具 / 控制工具）+ 1 段 patch YAML（+ 二期 1 个 client-ui 包）。不改任何官方包 | seam 核心（provider 契约、`NO_START_CAPABILITIES`、catalog、manager 续接路径）+ `dsh-tool-subagent-control` + `dsh-client-ui-subagent` + 可能的 session projection/UI 契约；5 个官方包、跨进程邮箱/租约协议 | A 明显小；B 是跨包协议改造 |
| **升级耦合**（DSH 每次发版要跟着改什么） | ① provider 注册/`startActivation` 签名；② 工具注册 API；③ catalog payload 版本（读取器现支持 v0/v1/v2，新版本需跟随）；④ `maxActiveSubagents`/`maxDepth` 设置语义；⑤ profile patch schema（`dsh --dump-config-schema` 可回归）。预计 **0.5–2 人日/版本**（有 smoke 后趋近 0.5） | 除①–⑤外：⑥ 把 seam 改动 rebase 到新 `lib/index.js`/types；⑦ catalog/UI 契约与官方 UI 一起改；⑧ 若未合并，每次发版都要重放 fork 补丁，**2–5 人日/版本**，且回归面覆盖 6 类 seam 行为（发送/中断/列举/冷恢复/catalog/UI 输入框） | A 可维护；B 长期维护成本取决于上游是否合并 |
| **风险** | ① 双真相/映射漂移（R07）；② UI 鸿沟（外部条目无状态，用户可能误以为「卡住」）；③ 工具/ provider 双注册冲突（R25）；④ 与 seam 容量双闸门不一致（R24）；⑤ 升级破坏 provider 契约（低-中） | ① 改核心 → 升级即冲突，且 asar 不可改（B2 需 fork，与 BRIEF §5 冲突）；② 跨进程继续执行 = 持久邮箱 + 租约，是分布式一致性问题（seam dev-note 明示延期）；③ UI/控制/catalog 三处行为回归面大；④ 上游不接收 → 永久 fork；⑤ 验证成本高（需真实多客户端/重启场景） | A 风险可控且有兜底；B 风险高且不可回滚 |
| **可维护性** | 官方契约不变，兼容层内部演进自由；缺陷边界清晰（L4/Broker）；测试可 mock provider | 每个 DSH 版本都可能改 seam 内部结构；文档与实现易脱节；需要长期跟踪上游 dev-note | A |
| **UI 一致性** | 官方 UI：外部任务=不可打开叶子、无执行状态（S5）→ 与本地子代理**不一致**；需自有 UI 插件补齐（二期），仍无法改变官方叶子行为 | 与本地子代理同级：状态/进度/用量/子代理树/输入框/Stop 全部一致 | B 胜；但这正是 B 的主要成本 |
| **工作量（人日，估算）** | A0 1–2 + A1 3–5 + A2 2–3 + A3（UI）6–10 = **12–20**（不含 C4–C7 四适配器，约 20–30 人日，两路线相同） | B0 提案/原型 5–8 + B1 核心 8–14 + B1 UI/控制 5–8 + 邮箱/租约 4–6 + 迁移/回归 3–5 = **25–41**（若上游合并可省 fork/回归约 8–13） | A 约一半 |
| **可回滚性** | 配置级：删/停用 patch 行、`dsh plugin remove`、重启；**≤5 分钟**；journal 追加数据保留；无 schema 迁移 | 需要「seam 双栈窗口」：回滚 fork 包 → catalog v3 数据被旧读取器忽略/不可读 → 需迁移/兼容验证；**小时级**，且回滚后外部会话续接能力消失（依赖其上的会话需 reseed） | A 明显好 |
| **对 S1–S5 的效果** | S1/S2/S3/S4 绕过，S5 接受（官方 UI 降级）；换来「能续接/能中断/有进度数据」，只是不走原生通道 | S1–S5 全部解除，原生一致 | 看验收标准：若「UI 一致性」是硬指标 → B；否则 A |
| **前置依赖** | 无（DSH 0.2.1-rc.3 即可）；需在施工 C8 验证 provider 契约未变 | 上游评审/合并，或用户批准 fork；需要 DSH 版本升级策略配合 | A 可立即排队 |

### 3.2 工作量拆解（供 Lead 排期）

| 阶段 | 路线 | 产出 | 验收命令/断言 | 估算（人日） |
|---|---|---|---|---|
| A0 | A | provider 契约 spike：注册一个 `echo` provider，跑通 `startActivation` → 完成通知 → catalog 叶子；记录真实签名/错误码 | `pnpm test -- provider-spike`；断言 4 个拒绝码（`UNSUPPORTED_CAPABILITY`/`ACTIVATION_LIMIT_REACHED`/`DUPLICATE_CHILD`/`CONTINUATION_UNAVAILABLE`）都能复现 | 1–2 |
| A1 | A | `@mocl/dsh-bridge`：4 provider + Broker 投影 + 配置 schema + journal + 状态机（ABI M2/M3/M5/M8） | 契约测试：create→send→completed→interrupt→recover；同 `clientRequestId` 不重复执行 | 3–5 |
| A2 | A | `@mocl/dsh-tool-subagent-agent`（统一工具）+ `@mocl/dsh-tool-mocl`（status/interrupt/recover）+ patch 片段 + 回滚脚本 | `dsh --dump-config` 组合校验 + 运行时 smoke（§9.3） | 2–3 |
| A3 | A | `@mocl/dsh-client-ui-mocl`（自有面板，不改官方包） | 面板字段断言（02 文档 §5 最小集） | 6–10 |
| B0 | B | 上游设计提案 + 原型（外部 provider `prepareContinuable` 最小实现） | 原型跑通「重启后继续同一外部会话」1 次 | 5–8 |
| B1 | B | seam + control + UI 改造，双栈/迁移 | 6 类 seam 行为回归 + catalog 迁移测试 | 20–33 |
| **公共** | A/B | C4–C7 四适配器（`docs/adapters/*` 已定规格） | 各适配器 §12 验收 | 20–30（两路线相同，不计入路线差） |

> 估算口径：单人、熟悉本机环境、不含返工。opencode 链路已可用（D-018/D-019：生产模型待用户新建 key，免费模型可立即验证；事件全集仍归 C7 补测，不阻塞设计包）。人日为**区间**，施工 C8 前需 Lead 用 A0 实测校准。

### 3.3 反方论点与回应

| 反方 | 回应 |
|---|---|
| 「A 是假旁路，还是在用 seam 的 provider 注册」 | 是**有意**的：provider 注册是 seam 公开、稳定的扩展点，用它换来完成通知/容量/目录叶子，比 A2 全自建更贴近 DSH 生命周期；而「会话真相」仍在兼容层，所以 seam 的能力限制（S1–S4）绕过了，而不是被违反。若评审要求「一字不碰 seam」，退到 A2 即可，代价是 UI 与完成通知都要自建。 |
| 「A 只做一次性，等于放弃 BRIEF 的续接目标」 | 不成立：续接由 Broker 自管（ABI M4/M8），只是不走 seam 的 continuation 面、不走 DSH 输入框。验收方式见 §9.3（同一 `sess_id` 二次 send + kill 后 recover）。 |
| 「B 才是正解，A 是技术债」 | 若产品验收把「DSH 原生 UI 一致 + 原生 `send_message` 续接」列为硬指标，B 确实更优。本文不否定 B，只主张**顺序**：先用 A 拿到可交付、可回滚的能力，同时用 B0 原型与上游对齐；A 的 Broker/ABI 资产在 B 下完全不浪费（§7）。 |
| 「A 的 UI 鸿沟不可接受」 | 取决于用途：单次委派看结果（PR 评审、批量修复）可接受；小时级长任务/需要中途干预的场景不可接受 → 这正是 §6.4 的 B 触发条件。 |

---

## 4. 路线 A 的落点（怎么接进去）

### 4.1 组件与包

```text
DSH Host（desktop profile）
├─ @deepseek-ai/dsh-subagent（seam，不改）
│    └─ provider registry ← 注册 4 个外部 provider（能力位全 false，符合 S2）
├─ @mocl/dsh-bridge（新增，Host 插件，id: mocl-bridge）
│    ├─ L2 Broker：会话真相 / 状态机 / journal / 幂等 / 配额 / 冷恢复
│    ├─ L3 事件总线：归一化 / 折叠 / 有界环形缓冲
│    ├─ L1 适配器 ×4：codex / kimi / claude-code / opencode（按 docs/adapters/*）
│    └─ L5 控制面：配置 / 策略 / 指标 / 审计 / doctor
├─ @mocl/dsh-tool-subagent-agent（新增）：唯一模型面工具 subagent_agent(backend=...)
└─ @mocl/dsh-tool-mocl（新增）：mocl_status / mocl_interrupt / mocl_recover
```

- **L4 投影**：本路线把架构里的 L4 落到「provider adapter + 自有工具」两处；L4 仍禁止直连 L1/L0（`docs/architecture/01-layers.md` §6.1），所有调用走 Broker 的 ABI 方法。
- **会话真相**：一个 DSH 子代理 ↔ 一个 ABI `sess_id`（INV-L4-1）；`childId`（seam activation id）↔ `sess_id` 做**双向映射**并持久化，映射丢失时按 `02-state-machine.md` §7.4 隔离为 orphan，禁止猜测 attach。

### 4.2 四条 seam 约束在路线 A 下的具体绕过方式

| 约束 | 绕过实现（A1） | 可验证断言（施工 C8） |
|---|---|---|
| S2 能力位全 false | 统一工具只把「任务文本 + `cwd`」传进 `startActivation` 的 `request`（`label` 走 activation 的 label 字段）；模型/权限/深度/输出 schema **不放进 request**，而是 Bridge 配置 + 工具参数 → Broker `session.create{model, permissionProfile, limits, firstInput}`。模型覆盖默认关闭（`global.allowModelOverride=false`），避免 ABI 之外的第二套模型语义。 | 用 `agentOptions` 或数值 `maxDepth` 构造请求 → 断言 `start` 前被 seam 拒绝（`UNSUPPORTED_CAPABILITY`），证明兼容层从不依赖这两条通道；同时正常路径能跑通 1 turn。 |
| S3 续接/中断/冷恢复仅本地 | `mocl_status`（查状态/进度/用量/错误）→ Broker `session.query`；`mocl_interrupt` → ABI M5；`mocl_recover` → ABI M8；DSH 侧「停止」= seam `dispose()`（取消 activation）→ Bridge 映射 `session.interrupt` 或 `close`，并如实上报 `interruptMethod`。 | 同一 `sess_id` 连续两次 `session.send(expect=continue)` 成功；`kill -9` 后端进程后 `mocl_recover` 返回 `strategy=resume`（或按能力 `reseed`），不重复计费。 |
| S4 `maxDepth: provider-managed` | 工具行固定 `maxDepth: provider-managed`；深度由 Bridge 在 `session.create` 前按 `parentSessionId` 链校验 `backends.<b>.maxDepth`（默认 2）与 `global.maxDepth` 取小，超限 `limit.nesting-exceeded`。绝不给 seam 传数值。 | 构造 depth=3 请求 → 断言被 Bridge 拒绝且 seam 未被调用（工具结果含 `limit.nesting-exceeded`）；depth=2 通过。 |
| S5 catalog 叶子 | 接受官方 UI 只显示叶子（`mode:'external'`）；**label 里带 backend 前缀**（如 `[codex] review PR #42`）让叶子至少可辨认；状态/进度/用量走 `mocl_status` + 文件；二期自有 UI 插件读 Bridge 服务渲染面板。 | catalog 只追加 1 条 `subagent/catalog`（v2/mode external）；`list_agents` 不返回该条目（预期）；`mocl_status` 返回 `02-ui-data-plane.md` §3.1–3.7 的必显字段（缺值为 `null`，不允许缺键）。 |

### 4.3 自有控制工具（对 S3 的正式替代面）

| 工具 | 入参 | 语义 | 对应 ABI |
|---|---|---|---|
| `mocl_status` | `sessionId?` / `label?` / `all?` | 返回会话状态、activation、当前轮、`progress.folded` 最新窗口、usage、错误、最近事件 seq、可选子代理树 | M6/M7 + L3 `progressOf` |
| `mocl_interrupt` | `sessionId` / `turnId?` | 中断当前轮；`interruptMethod` 如实返回；外部一次性执行时等价「永久停止」 | M5 |
| `mocl_recover` | `sessionId` / `strategy?` | 冷恢复（探测→续接/fork/reseed/abort）；幂等 | M8 |

> 这三个工具是「DSH 原生控制工具不能作用于外部子级」的**声明式降级**，不是偷偷扩 seam。它们与 `send_message`/`interrupt_agent`/`list_agents` **并存但不重叠**：原生工具负责本地 spawn/fork 子级，mocl 工具负责四个外部后端。

### 4.4 工具层必须遵守的 seam 兼容硬约束（违反即全部委派失败）

| 项 | 正确配置 | 配错的后果（已由 seam 源码注释确认） |
|---|---|---|
| `maxDepth` | `provider-managed` | 数值 → 外部 provider 无 `depthLimit` → **`start` 前拒绝**（即便任务本身合法） |
| `modelSelectionSettings` | `false` | `true` 要求 provider 支持 `agentOptions` → 外部后端被明确拒绝 |
| `agentPreset` / `allowedAgentPresets` | 不配置 | 外部后端拒绝 preset 选项 |
| `delivery` | `parent`（完成时通知） | `caller` 不产生 parent catalog 条目，UI 连叶子都没有 |
| `toolName` | 全局唯一（推荐 `subagent_agent`） | 同一实例名冲突 → 加载期报错（R25） |

### 4.5 容量与并发：与 DSH seam 对齐（R24）

- 双闸门顺序：**seam `maxActiveSubagents` 是第一道**（`ACTIVATION_LIMIT_REACHED`），Bridge 配额是第二道。**D-016**：Bridge 启动时**读取** seam 运行值，`global.maxConcurrent`/每后端 `maxConcurrent` 缺省 `runtime` 跟随；配置值 > 运行值 → 启动断言失败（fail-closed），不静默收敛、不写死默认值。本机当前运行值 20 仅为实例值。
- `ACTIVATION_LIMIT_REACHED` → ABI `limit.concurrency-exceeded`（`queued` 或拒绝 + `retryAfterMs`），不要伪装成 `internal.unexpected`。
- 配置快照不可变（INV-L5-1）：修改 seam 容量后只影响新会话；Bridge 每次 `session.create` 重新读取。

### 4.6 与现有 codex / claude-code 插件的关系（R25）

现状：desktop profile 同时安装了 `@deepseek-ai/dsh-subagent-codex` 与 `@deepseek-ai/dsh-subagent-claude-code`，它们的 `cordis.patch.yml` 各插入一个 provider 行（`subagent-codex` / `subagent-claude-code`）与一个工具行（`tool-subagent-codex` / `tool-subagent-claude-code`，`toolName` 分别为 `subagent_codex` / `subagent_claude_code`，`maxDepth: provider-managed`）。

**处理（推荐）**：统一工具方案下，用 profile patch 在同一层：

1. `- id: subagent-codex`、`- id: subagent-claude-code` **`disabled: true`**（停用两个一次性 provider，避免同名 provider 双注册）；
2. `- id: tool-subagent-codex`、`- id: tool-subagent-claude-code` **`disabled: true`**（停用两个旧工具，避免与 `subagent_agent` 竞争模型注意力、也避免同名 `toolName` 冲突）；
3. 由 Bridge 注册 `codex` / `claude-code` 两个 provider（名字沿用默认，兼容老调用路径的语义）；
4. 回滚时反向恢复上述 4 行（配置级，见 `01-config-and-enable.md` §6）。

**不推荐**「保留旧工具 + 加新工具」：模型可见 3 个能力重叠工具，选择准确率下降，且旧工具仍是一次性语义，用户会困惑「为什么 codex 有两套行为」。若必须平滑迁移，可保留一个 MINOR 周期，把旧工具描述改为「deprecated，请用 subagent_agent」，并在下一版本删除。

---

## 5. 工具形态选择：四个独立工具 vs 一个 `subagent_agent(backend=...)`

### 5.1 两个方案

- **四工具**：四个 `dsh-tool-subagent` 实例（`toolName` = `subagent_codex` / `subagent_kimi` / `subagent_claude_code` / `subagent_opencode`），各指向 Bridge 的一个 provider。
- **一工具（推荐）**：`@mocl/dsh-tool-subagent-agent` 注册单一 `subagent_agent`，schema 含 `backend` 枚举（`codex|kimi|claude-code|opencode`，按 `enabled` 动态裁剪）+ 必填 `task` + 可选 `cwd` / `label` / `timeout_ms`（只能缩短、不能超过 per-backend `turnTimeoutMs`）。内部仍调 `ctx.subagents.startActivation`（`delivery:'parent'`），所以完成通知、catalog 叶子、容量准入都保留。

### 5.2 取舍表

| 维度 | 四工具 | 一工具（推荐） |
|---|---|---|
| 工具 schema token 成本 | 4 份 schema + 4 段系统提示词 section + 委派指导里多 3 个名字。按 `dsh-tool-subagent` README 的「每个实例一个 schema + 一段 section」口径估算，约 **1.6k–3.2k token/父级请求**（区间估算，施工 C8 用 tokenizer 实测回填） | 1 份 schema + 1 段 section，约 **0.5k–0.9k token/父级请求**（估算） |
| 模型选择准确率 | 高：工具名自解释，模型不太会选错后端；但四个能力重叠工具会拉低「该不该委派」的判断 | 稍低：需要读 `backend` 枚举描述；用「每后端一行能力摘要 + 默认后端 + 校验错误列出可选值」弥补；对「需要中断/长任务」等场景在描述里直接写明 kimi 无中断 |
| `maxDepth` 约束 | 每个实例都必须 `provider-managed`（4 处配置，易漏） | 1 处配置，默认值写死 `provider-managed`，漏配风险低 |
| `toolName` 唯一性 | 4 个名字必须全局唯一，且与现有 `subagent_codex`/`subagent_claude_code` 冲突（R25） | 单名 `subagent_agent`，天然唯一；仍存在 R25（旧的同名工具需停用），但冲突面减半 |
| 与现有插件冲突（R25） | 旧 2 个工具名会被完全遮蔽/重复注册 → 必须停用旧插件，或给新工具加前缀（`agent_codex` 等），破坏「统一入口」假设 | 停用旧 2 个工具行即可；`subagent_agent` 不占用旧名，回滚清晰 |
| 未来加后端 | 加一个工具实例 + 一行配置 | 枚举加一项 + provider 注册，模型面不变（schema 前缀更稳定，利于 KV cache） |
| 实现工作量 | 复用官方 `dsh-tool-subagent`，几乎零工具代码 | 需自写一个薄工具插件（约 150–250 行）+ 测试；换取长期 token 与一致性收益 |
| 与 `subagent_codex`/`subagent_claude_code` 的语义兼容 | 可沿用旧名（`toolName` 不变），用户无感，但一个名字背后行为从「一次性」变「可续接」，文档必须标注 | 名字全新，语义清晰；旧名停用需在 release note 写明 |

### 5.3 推荐与理由

**推荐一个统一工具 `subagent_agent(backend=...)`**，理由按权重：

1. **BRIEF §8 的假设就是「DSH 侧一个统一入口 + 四个后端可选」**；四工具与用户预期相反。
2. **token 成本**：四工具是「每个父级请求」的固定成本，按 4 次估算每次省 1–2k token；长会话累计显著，且与 BRIEF §6-4 的成本约束方向一致。
3. **schema 前缀稳定**：新增后端只改枚举描述，不改工具集合 → 父会话 KV cache 前缀稳定（BRIEF §6-3 / ABI §11.3 的同一逻辑）。
4. **冲突面小**：只有一个工具名，R25 只需停用旧的两行工具配置；四工具还要处理「旧名复用 vs 新名并存」的二义性。
5. **`maxDepth` 只需配一次**，减少「漏配一个实例导致该后端全部委派被 seam 拒绝」的运维事故。

**代价与缓解**：自写工具插件（C8 工作量 +1–2 人日）；模型选择准确率略降 → 用枚举描述 + `mocl_status` 的错误提示（如「后端 kimi 已禁用/无凭据」）+ 默认后端配置缓解；若实测准确率不可接受，回退到四工具只需把统一工具换成 4 个官方 `dsh-tool-subagent` 实例，Bridge provider 不变（**可逆决策**）。

---

## 6. 推荐与立项顺序 + 何时改走 B

### 6.1 推荐

**一期（现在）路线 A（A1）**：它把「可交付、可回滚、不碰核心」三点同时满足，且 A0/A1/A2 的产出（ABI Broker 投影、provider 适配、统一工具、配置/回滚）在路线 B 下**全部保留**（B 只替换投递通道与 UI）。B 的问题不是「不值得做」，而是「现在做无法本地验证、回滚代价高、且与 BRIEF 非目标冲突」。

### 6.2 立项顺序

| 顺序 | 切片 | 依赖 | 完成判据（可执行） |
|---|---|---|---|
| 1 | A0 provider 契约 spike | 无 | 4 个 seam 错误码可复现；`startActivation` 完成通知 + catalog 叶子出现 |
| 2 | A1 Bridge MVP（配置 + 4 provider + Broker 投影） | A0 | 1 个后端 1 turn 端到端；配置非法 fail-closed |
| 3 | A2 统一工具 + 控制工具 + 启用/回滚手册 | A1 | §9.2 组合校验 + §9.3 smoke 全绿 |
| 4 | A3 自有 UI 面板 | A2 | `02-ui-data-plane.md` §5 最小集字段全可见 |
| ∥ | **W1/B0** 上游提案 + 原型（并行工作流，不阻塞 C0–C10；D-017） | 无 | RFC/issue 草案落盘 + 接口预留文档 + 原型跑通「DSH 重启后继续同一外部会话」1 次（详见 §6.2.1） |

### 6.2.1 B0 并行工作流（W1，D-017）

> 定位：B0 不再是「仅登记不排期」，而是与 A0–A3 **并行推进**的工作流；**不阻塞本期交付**（C0–C10 不依赖 W1 的任何产出）。

| 项 | 内容 |
|---|---|
| 目标 | 把「外部子代理可续接 + progress 事件」做成可被 DSH 上游接受的契约提案，降低二期路线 B 的成本 |
| 产出物（W1 完成定义） | ① **RFC/设计草案**（`docs/rfcs/` 或项目 issue 草稿）：外部 provider 的 `prepareContinuable()`、能力位协商、catalog v3（携带状态/进度/用量）、progress 事件、跨进程邮箱/租约；② **上游 issue/PR 草案**（含契约 diff 与兼容/迁移影响）；③ **与施工期的接口预留**：provider 注册层预留 `continuable` 能力探测、Bridge 的 `progress.fold` 输出保持可映射为 `progress` 事件、catalog 写出保持 v2 且字段可扩展；④ 原型（可选，跑通「DSH 重启后继续同一外部会话」1 次） |
| 节奏 | 与 C0–C10 并行，每周一次同步；W1 的任何结论不改变 C0–C10 的验收命令 |
| 与路线切换的关系 | 触发条件仍以 §6.4 为准；W1 完成只降低 B 的成本，不等于自动切换路线（切换需 Lead/用户裁定） |
| 禁止 | 不因 W1 而提前 fork 官方包（D-011 仍生效）；不把 W1 的未定契约写进 ABI 主表（先提案后 MINOR） |

### 6.3 A 的一期不做什么

- 不承诺官方 GUI 显示外部子代理状态（S5 是硬事实）；不承诺 `send_message`/Stop/输入框对外部子级可用。
- 不做跨 DSH 进程的会话共享（P2 部署形态属二期，`docs/architecture/00-overview.md` §6）；一期 P1 单进程，DSH 退出即会话 `lost`，恢复需重启后显式 `mocl_recover`。
- **opencode 默认 `enabled:true`（D-018）**：生产模型基线 `opencode-go/deepseek-v4.1-flash`（用户口径，D-019）需**新建 API key**（旧 key `api_key_expired` 且重登录不续期）；key 失效时兼容层降级免费模型 `opencode/deepseek-v4.1-flash-free`（实测 rc=0、`-s` 续接成功），发 `degraded` 事件并声明 `model=free-fallback`（不允许静默降级）。opencode 不再是交付缺口。

### 6.4 何时应该改走路线 B（可观测判据，任一成立即触发重评估）

1. **产品验收把 UI 一致性列为硬指标**：要求官方子代理目录里的外部条目能展开、显示状态/进度/用量，或用输入框继续、用 Stop 中断 —— A 无法在「不 fork 官方 UI」前提下做到（S5）。
2. **跨 DSH 重启/多窗口继续同一外部会话成为常态需求**（P2 形态）：A 的 Broker 可做，但若用户期望的是「在 DSH 会话树里原地继续」，仍需 seam 的 continuable 外部子级。
3. **上游 seam 出现「外部 continuable」或接受 B 提案**（dev-note 两条延期项被实现）：此时 B 的维护成本骤降，升级耦合从 2–5 人日/版本降到 0.5–1 人日/版本，A 的 workaround 就变成技术债。
4. **A 的运维成本连续 2 个 DSH 版本超过 B 的 rebase 成本**：以「每次升级修复 provider/工具/catalog 适配的人日」度量；若 A ≥2 人日/版本且 B0 原型已证明可行，切换。
5. **`mocl_status` 轮询占比 >30% 的委派**（遥测可得）：说明工具/文件数据面不足以支撑实际使用，UI 缺口成为瓶颈 → 启动 B 或 A3 提前。

### 6.5 反例预注册自检（PLAN 末尾 6 条）

| 反例 | 本文是否命中 | 证据 |
|---|---|---|
| 能力矩阵无证据结论 | 否（本文不写矩阵） | — |
| 适配器缺失败降级/写 unknown | 否（本文不改适配器；引用其 §10） | `docs/adapters/*` §10 |
| 「再来一次就恢复」的隐含假设 | 否：恢复=写操作对账 + 幂等键（§4.3、ABI §9），明确禁止盲目重发 | 本文件 §4.2/§4.3 |
| 未定义父会话进度上限 | 否：父会话零中间消息 + 硬上限表 | `01-config-and-enable.md` §2（G13–G15）与 §3.1（B16–B18）、`02-ui-data-plane.md` §3.3/§5 |
| 安全默认 = 放行一切 | 否：read-only 默认 + 危险档双闸 + worktree 强制 | `01-config-and-enable.md` §3.3（BRIEF §6-5 行） |
| 施工切片无验证命令/依赖人工观察 | 否：A0–A3 均有可执行判据；运行时断言见 §9.3 | 本文件 §6.2/§9 |

---

## 7. 迁移路径（A → B，不重写适配器）

前提：B1 落地（上游或 fork），且 A 已经交付。迁移按「增加能力、不改语义」进行：

| 步 | 动作 | 兼容性 |
|---|---|---|
| M1 | provider 契约升级：Bridge 的 4 个 provider 增加 `prepareContinuable()`（或 seam 侧替代方法），把 `backendSessionId` 与 channel 暴露给 seam | 不改 ABI；A 的 `sess_id` 与后端会话 id 映射保持不变 |
| M2 | seam 的 `startActivation` 走 continuable 路径；`send_message`/`interrupt_agent`/`list_agents` 自动覆盖外部 | Bridge 的 `mocl_send`/`mocl_interrupt` 退化为「转发到 seam」或保留为兼容别名 |
| M3 | catalog v3：外部条目携带状态/进度/用量；官方 UI 可展开 | 旧 catalog v0/v1/v2 读取器必须继续可读（seam 已有三版读取器实现，可加 v3 分支）；A 期间的旧 journal 不需要改，投影层补字段即可 |
| M4 | 自有 UI 面板（A3）退化为可选增强；官方 UI 成为主视图 | 删除自有面板不丢数据（数据源同一 Broker 服务） |
| M5 | 删除 A 的 workaround 配置（`mocl_*` 工具、`maxDepth: provider-managed` 强制项） | 配置 schema 保留 key 但标 deprecated；一个 MINOR 周期后移除 |
| M6 | 双栈验收：同一任务分别走「A 工具」与「seam 原生续接」，断言 ABI 事件序列一致（除 `source` 字段） | 事件/错误码不变 → L3/L5 测试复用 |

**不迁移的资产**：L1 适配器、ABI 语义、journal 格式、配置的 per-backend 字段、监控指标口径 —— 这些与投递通道无关。

---

## 8. 风险与缓解（本方案新增/放大的）

| ID | 风险 | 等级 | 触发 | 缓解 | 验证 |
|---|---|---|---|---|---|
| D6-R1 | 双真相：seam activation id 与 Broker `sess_id` 映射漂移 | 高 | 插件重启/会话恢复/catalog 重建 | 映射写 journal（`childId ↔ sess_id` 双向唯一）；恢复前只读对账；歧义即 orphan（02 §7.4） | 故障注入：删映射后断言 orphan 而非误 attach |
| D6-R2 | UI 鸿沟导致用户误判「卡住」（外部叶子无状态） | 中 | 长任务 | label 带状态摘要不可行（catalog 无状态）→ 用 `mocl_status` + 终端/文件提示；文档明示限制 | 用户测试/验收清单；`02-ui-data-plane.md` 降级模板 |
| D6-R3 | R25 双注册：旧 codex/claude 工具与统一工具并存 | 中 | 忘记禁用旧行 | patch 一次性禁用 4 行；启动自检工具名集合；冲突即拒绝加载 | `dsh --dump-config` + 工具列表断言 |
| D6-R4 | R24 双闸门不一致：Bridge 并发 > seam 容量 | 中 | 配置漂移/硬编码 | **D-016**：启动读取 seam 运行值，配置缺省 `runtime` 跟随；读取失败 fail-closed；指标暴露两者 | 并发 `runtime+1` 个（本机 runtime 20）断言统一错误码；把运行值改小后重启断言新值生效 |
| D6-R5 | seam provider 契约在 DSH 升级中变化（本机 0.2.1-rc.3） | 中 | DSH 发版 | A0 的 spike 测试进 CI；发版即跑；失败即禁用 Bridge 而不影响官方插件 | 版本矩阵 smoke（当前版本 + 下一版本） |
| D6-R6 | 工具返回值语义误导：`started subagent <childId>` 不是结果 | 低 | 模型把 childId 当结果 | 工具描述/系统提示明确「异步，结果以完成通知为准」；`mocl_status` 校验 | prompt 回归测试 |

---

## 9. 验收命令与方法

### 9.1 文档闸门

```bash
cd /Users/lakii2982/项目/多智能体编排
python3 tools/check_docs.py integration; echo "rc=$?"
```

### 9.2 配置组合校验（可复跑，零安装、零副作用）

```bash
# 1) 把 01 文档的「全局段 + 四个后端段 + 装配段」另存为 /tmp/mocl.patch.yml
#    只保留 insert 行（disable/override 行 targeting desktop-only ids 在 headless 下会告警 "not found" 但不阻断）
# 2) 用 headless profile 叠加 patch 并打印合成树；dump 成功 = YAML 语法/结构合法
dsh --profile headless --patch /tmp/mocl.patch.yml --dump-config | tail -40
echo "rc=$?"                       # 期望 0，且末尾出现 "# == /tmp/mocl.patch.yml"

# 3) 打印 patch 条目的 JSON Schema（判断 insert/override/disabled 字段是否合法）
dsh --profile headless --dump-config-schema | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['\$defs']['patchList']['type'], d['\$defs']['patch']['type'])"

# 4) 注意：desktop profile 由 Electron 独占管理，不能用 dump-config 校验
dsh --profile desktop --dump-config 2>&1 | head -2
#    期望输出：error: profile "desktop" is managed exclusively by the Electron application
```

> 本机已实证：`--patch` 叠加后 `--dump-config` 会额外打印 `# == <patch 文件>` 段（测试片段见本文附录 A）；且指向不存在 id 的 patch 行会在 **stderr** 打 `patch: entry "<id>" not found` 警告并继续（进程 rc 仍 0）——所以「dump 通过」只证明语法，不证明 override/disable 生效，生效必须看警告与 GUI/运行日志（`01-config-and-enable.md` §5）。

### 9.3 运行时 smoke（施工 C8 执行；设计阶段只列断言，不消耗额度）

| # | 断言 | 方法 |
|---|---|---|
| S1 | `subagent_agent` 在父会话工具列表中可见，且 schema 含 `backend` 枚举（仅已启用后端） | 会话内 `list tools`/宿主工具目录快照 |
| S2 | 派发 1 个只读任务（默认 `permissionMode=read-only`）→ 工具返回 `started subagent <childId>`；父级在完成后收到 1 条完成通知 | 录制会话事件；断言通知数 == 1 |
| S3 | catalog 出现 1 条外部条目（`mode:'external'`），官方 UI 显示为叶子；`list_agents` 不返回它 | 读父会话 catalog projection + UI 截图 |
| S4 | `mocl_status` 返回 `02-ui-data-plane.md` §3.1–3.7 的必显字段（缺值 `null`，不缺键），`lastSeq` 单调 | JSON Schema 校验 + 连续两次调用断言单调 |
| S5 | 同一 `sess_id` 连续两次 `session.send(expect=continue)` 成功（工具面/契约测试；证明 Broker 自管续接，不依赖 seam） | 契约测试/手工两次派发 |
| S6 | `kill -9` 后端进程后 `mocl_recover` 成功（或按能力声明降级为 reseed），返回 `strategy` 与 `substitutions[]`/`recovery` | 故障注入 |
| S7 | 禁用某后端后，`backend` 枚举不含它，旧值调用返回明确错误（含可用项） | 配置热重启后测试 |
| S8 | 危险档位双闸：`permissionMode=yolo` 且 `allowDangerousModes=false` 时拒绝建会话（`policy.escalation-required`）；显式开启但无 worktree 时拒绝（`policy.sandbox-violation`） | 配置矩阵测试 |

### 9.4 回滚演练（必须实际做一次）

见 `01-config-and-enable.md` §6；验收判据：恢复 patch 备份 + remove 包 + 重启后，`subagent_codex`/`subagent_claude_code` 恢复可见、`subagent_agent` 消失、`~/.mocl` 可按清单清理、无残留进程/端口/socket。

---

## 10. 待澄清（与 D4/D5/BRIEF 的新冲突或缺口）

| ID | 事项 | 冲突/缺口 | 建议裁定（Lead） |
|---|---|---|---|
| D6-Q1 | DEC-3 的「工具返回值增量」与 seam 工具模型冲突：官方委派工具**立即返回** `started subagent <childId>`，不承载后续增量；要拿增量只能另发查询 → 与 DEC-3「一期工具增量」字面不一致 | BRIEF §7 DEC-3 vs `dsh-tool-subagent` 行为 | 采纳本文 §0：一期 = 终态通知 + `mocl_status` + 文件；DEC-3 在 LEDGER 里标注为「工具可查询增量」 |
| D6-Q2 | `docs/architecture/01-layers.md` INV-L4 的「L4 禁止按 backend 分支」与统一工具 `backend` 枚举 | 架构 §6.7 反模式 2 | 明确：`backend` → provider 的**路由表是配置数据**，不是业务 if/else；本文件已按此写，若评审不同意需改架构条款措辞 |
| D6-Q3 | `docs/architecture/00-overview.md` AR-V3/AR-V4 委托 D6 的未决项 | 本文已决定父会话载体（§0）与嵌套默认 2（§4.2/01 §3），但未改架构文档 | 由 D10 integrator 把 AR-V3/AR-V4 标为「由 D6 §0/§4.2 回答」，不改写架构正文 |
| D6-Q4（**已关闭，D-016**） | 并发默认值口径 | 旧稿把默认值写成固定整数、并把本机实例值当作文档默认 | 一律运行时读取，缺省 `runtime` 跟随；读取失败 fail-closed；文档不写死任何默认值 |
| D6-Q5 | 路线 B 的 B2（本地 fork 官方包）与 BRIEF §5 非目标冲突 | 非目标 vs 可选路线 | 仅登记为「需用户书面批准才可启用」，一期不排期 |
| D6-Q6（**已关闭，D-018/D-019**） | opencode 交付完整性 | 旧结论「opencode 待凭据、默认关闭」 | opencode 默认 `enabled:true`；生产模型需新建 key（旧 key 过期且重登录不续期），key 失效自动降级免费模型并标 `degraded`；四后端链路全部可用 |

---

## 附录 A — 本机组合校验原始记录（2026-10-25，可复跑）

```text
$ cat /tmp/mocl-test.patch.yml
- insert:
    - id: mocl-selftest
      name: '@mocl/dsh-subagent-bridge'
      config:
        enabled: true
        maxConcurrent: 2

$ dsh --profile headless --patch /tmp/mocl-test.patch.yml --dump-config > /tmp/mocl-dump.txt
$ echo "rc=$?"
rc=0
$ grep -B2 -A6 mocl-selftest /tmp/mocl-dump.txt
# == /tmp/mocl-test.patch.yml
- id: mocl-selftest
  name: '@mocl/dsh-subagent-bridge'
  config:
    enabled: true
    maxConcurrent: 2

$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application

$ dsh --version
0.2.1-rc.3
```

结论：`--patch + --dump-config` 可用于**语法与组合**校验；desktop 的生效校验必须走 GUI/运行日志（见 `01-config-and-enable.md` §5.3–§5.5）。

---

## 交叉引用

- 配置 schema、启用步骤、开关矩阵、回滚：`docs/integration/01-config-and-enable.md`
- UI 字段清单与降级呈现：`docs/integration/02-ui-data-plane.md`
- seam 事实基线：`.astra/CONTEXT-DSH-SEAM.md`
- 架构边界与 L4 职责：`docs/architecture/01-layers.md` §L4、`docs/architecture/00-overview.md` §4/§6
- 状态机与冷恢复：`docs/architecture/02-state-machine.md` §7/§8
- 能力位/降级表/事件：`docs/abi/abi-v0.md` §3.5、§7、§11
- 每后端「不支持 + 兜底」：`docs/adapters/{codex,claude-code,kimi,opencode}.md` §10（或 kimi/opencode §10.1）

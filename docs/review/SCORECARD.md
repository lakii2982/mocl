# SCORECARD — D9 红队评审 + 五维评分 + 判定（fresh judge）

> 角色：独立评审（新上下文）。只依据产物与可复跑证据，不采信作者解释；发现错误只写报告，不改被评产物。
> 复验证据见同目录 `docs/review/VERIFY-GATE.md`（命令、退出码、原始输出摘要）。时间：2026-10-25。

## 1. 预注册反例逐条检查（`.astra/PLAN.md` 末尾 6 条）

| # | 预注册反例 | 检查方式 | 结论 |
|---|---|---|---|
| 1 | 能力矩阵出现无证据的「支持/不支持」结论 | 全库 `*.md:行号` 引用机械校验（833 条，0 失效）＋60 格逐格看证据 + 抽查 10 条强断言（codex resume/stream、kimi interrupt、opencode sandbox、claude resume） | **未命中**（详见 §3.1 已验证 8 项；另见观察 O-1） |
| 2 | 适配器缺「失败与降级」或把失败都写成 `unknown` | 四份适配器 `§10` 逐份通读；`unknown` 出现次数：codex 3 / kimi 2 / claude 2 / opencode 1，且均在「未验证形状」而非兜底结论 | **未命中**（降级表逐条给替代路径/父级差异/允许报错条件） |
| 3 | 存在「再来一次就恢复」隐含假设而无幂等/去重 | 读 `03-failure-modes.md` F01/F10/F12、`02-state-machine.md` §5 转移表 + §7 幂等账本、`adapters/codex.md` §4.5 判定顺序 | **未命中**（写操作先对账再决定；同键重放后端调用数==1 有断言 ABI-T4；显式禁止超时后重发 `session/prompt`） |
| 4 | 未定义父会话进度上限（父子上下文爆炸） | 读 `01-config-and-enable.md` G11–G16 / B15–B18、`01-layers.md` §6.3 INV-L4-2、`02-ui-data-plane.md` §父会话 | **未命中**（`progress.mode` 默认 `summary` 可 `off`；`maxItemsPerTurn≤8`/`maxCharsPerTurn≤1200`/`maxCharsPerItem≤400` 为**硬上限**，超限拒绝启动；父会话只追加、零中间消息） |
| 5 | 安全默认档位等于「放行一切改动」 | 读 `01-config-and-enable.md` §0 速查 + B01/B07/B08/B20，对照 opencode 产品默认全放行 | **未命中**（四后端默认 `enabled:false`、`permissionMode:read-only`、`allowDangerousModes:false`、`worktreeIsolation:required-for-write`，fail-closed） |
| 6 | 施工切片无验证命令或依赖人工观察 | 逐片读 `.astra/PLAN.md` Part B C0–C10「验收命令」列 | **命中** → **F5**（C8 含「在 DSH 中 `subagent_*` 可见且可派发」纯人工观察；C4/C5/C6/C7 的「真实二进制 smoke（1 turn）」「ACP 握手 + 1 turn」也是描述而非命令） |

## 2. 打回项（F1–F8；F1–F6 阻断，F7–F8 非阻断）

- F1｜阻断｜能力矩阵与已生效裁定冲突**：位置 `docs/research/capability-matrix.md` §2「派生表 A：传输通道选型」opencode 行（第 39 行仍写「首选 ACP over stdio、v2 HttpApi 备选」）。问题：与 LEDGER `D-007`（采纳 v2 HTTP 优先 + ACP 兜底，矩阵 §2 由 D10 修订）及 `docs/adapters/opencode.md` §0.2/§0.3 相反。为什么违反：BRIEF A1 要求矩阵与适配器规格/ABI 能力位一致；D-007 已生效，评审把 LEDGER 当既定决策。修法：D10 integrator 按 D-007 改写该行为「v2 HttpApi 优先（控制面+事件主干）+ ACP 兜底」，并在矩阵 §2 加「按后端选型」声明与 `D-007` 回指；同时把 §3 能力位表里 opencode `interrupt/permission` 走 HTTP 备通道的约束写进对策列。

- F2｜阻断｜codex「最小可运行示例」按原文不可运行**：位置 `docs/adapters/codex.md` §4.6（第 331–368 行）。问题：①`env` 默认把 `CODEX_HOME` 指向空目录 `/tmp/mocl-codex-home`，静默丢弃 `~/.codex/auth.json` 登录态（实测 `turn/start` 返回 `inProgress` 后 45s 无终态、stderr 空）；②全示例无任何读超时，`wait_turn_end()` 永久阻塞（90s 原文执行 `[timeout]`，零输出）；③缺「验收预期」段（kimi/opencode 示例都有）。为什么违反：PLAN 反例 3/6 的工程底线——不可判定即等于不可验证；且示例是被 D5a 下游 C4 直接照抄的入口。修法：默认继承真实 `CODEX_HOME`（或首帧断言 auth 存在，否则 fail fast）；`rpc()`/`wait_turn_end()` 加 `select` 超时并在超时时杀进程组；补「验收预期：`thread: <id>` / `turn: <id> -> completed` / `resume` 同 id」；对 9 类 `ServerRequest` 至少给「自动拒绝」桩，避免审批阻塞。

- F3｜阻断｜kimi「最小可运行示例」按原文崩溃**：位置 `docs/adapters/kimi.md` §3.4（第 229–276 行）。问题：示例实现 `fs/read_text_file` 时直接 `open()`，未处理文件不存在；实测 0.9s `FileNotFoundError`（缺失文件为 kimi 自己会话目录下的 `agents/main/plans/damage-wiccan-dove.md`），读线程崩溃、脚本退出码 1。为什么违反：该示例是 D-003「handler 必须 fail-closed、否则 prompt 永久挂死」的示范代码，自身却未 fail-closed；施工 C6 照抄会得到不稳定基线。修法：`except FileNotFoundError → send({"error":{"code":-32602,...}})`、其他异常 `-32603`；把该语义补进 §2.3 handler 契约表并引用 D-003；验收预期补「若 plans 文件不存在也必须正常走到 `end_turn`」。旁证：仅加 6 行 catch 后原文其余不动 → 24.6s 两轮 `end_turn` PASS，说明是示例代码 bug，不是能力结论错。

- F4｜阻断｜协议计数口径系统性错误并扩散到三份文档**：位置 `repro/probe-codex.sh` 的 `methods()`（只收集含 `/` 的枚举值）→ `docs/research/codex.md:22,45,203`、`docs/adapters/codex.md:44,49,386`、`docs/research/capability-matrix.md:36`。问题：真值为 0.153.4 `ClientRequest=99 / ServerNotification=81`、0.164.0 `=106 / 85`，文档写 `97→104 / 76→80`；被漏掉的正是无斜杠方法 `error`、`warning`、`configWarning`、`deprecationNotice`、`guardianWarning`。其中 `error` 通知在 live 复验中承载 turn 失败的 `codexErrorInfo`（实测 `"codexErrorInfo":"other"`），而 adapter §5.2 #35 把它归入「丢弃（分类计数）」桶 —— 与「下表覆盖普通 turn 通知全集」的声明冲突。为什么违反：BRIEF §6-6「所有结论必须有证据」+ A11「结果与文档一致」；计数是 CI 漂移断言的期望值（`adapters/codex.md:49` 写明「期望 39/97/76」），错值会让 CI 放过真实漂移。修法：`methods()` 改为读 `properties.method` 的 enum/const（不过滤斜杠），重跑导出；订正三处数字；`error` 通知单独建映射行（`turn.failed` 主源、`session.warning` 诊断源）并说明与 `turn/completed.error` 的去重优先级。

- F5｜阻断｜施工切片验收依赖人工观察**：位置 `.astra/PLAN.md` Part B C8（「在 DSH 中 `subagent_*` 可见且可派发」）、C4/C5/C6/C7（「真实二进制 smoke（1 turn）」「ACP 握手 + 1 turn」）、C2（「kill 进程后能按 id 恢复（测试内断言）」）。问题：验收列混入叙述而非可执行命令；C8 尤其没有任何命令能判定「可见且可派发」。为什么违反：直接命中 PLAN 反例 6（施工切片无验证命令或依赖人工观察），且与 `docs/test/00-test-plan.md` §0「不允许人工看一眼」自相矛盾。修法：每片给 1 条脚本化命令 + 断言，例如 C8 用 `node scripts/assert-tools.mjs --expect subagent_agent,mocl_status`（读 `dsh --dump-config` + 会话工具清单）或 `pnpm -s smoke -- --backend=codex --assert=tool-visible`；C4–C7 用 `pnpm -s smoke -- --backend=<b> --turn=1 --assert=exit0`；C2 写成 `pnpm -s test -- broker -- --case=kill-recover`。

- F6｜阻断｜风险登记册与测试计划使用非 ABI 错误码（命名双轨）**：位置 `docs/risk/00-risk-register.md` R01 `quota-denied`、R08 `session-gone`、R16 `bad-cwd`；`docs/test/00-test-plan.md` FI-1 `crashed`、FI-2 `bad-frame`、FI-3 `quota-denied`/`auth-failed`/`service`、FI-7 `session-gone`、FI-10 `bad-cwd`、§3 `unknown-frame`。问题：这些码在 `docs/abi/abi-v0.md`（0 次出现）与 `docs/abi/schema/error.json`（45 个码）里都不存在。为什么违反：ABI §0 规则 3「一个概念只有一张表，其他文档引用不得另起同义命名」；BRIEF A6/A8 要求风险与测试文档可直接施工，双轨命名会让 C5/C9 实现出第二套错误分类，直接触发测试计划 §7-3「unknown 占比 >5% 判失败」。修法：统一替换为 ABI 码（`quota-denied→quota.rate-limited` 或 `quota.usage-exhausted` 按语义二选一、`auth-failed→auth.credential-rejected|auth.login-required`、`bad-cwd→policy.sandbox-violation|transport.invalid-params`（以 ABI §8 表为准）、`session-gone→session.invalidated`、`crashed→process.crashed`、`bad-frame/unknown-frame→transport.frame-invalid`）；并在 `check_docs.py` 增加「风险/测试文档只允许出现 error.json 枚举内的码」的机械校验。

- F7｜非阻断｜测试门禁自相矛盾（人工确认）**：位置 `docs/test/00-test-plan.md` §7 门禁 4「录制回放的快照 diff 必须人工确认后合入」，与 §0「每条用例都必须能由 CI 或一条命令判定，不允许"人工看一眼"」冲突。修法：改为 golden 文件 + 白名单字段（`ts`/`requestId`/绝对路径）由脚本比对，人工只在白名单变更时介入并留 PR 记录。

- F8｜非阻断｜文档规模与速读路径**：位置 全库（`docs/` 864KB、12.5k 行；最大文件 `event.json` 1765 行、`abi-v0.md` 851 行），`docs/00-README.md` 属 D10 尚未产出。问题：当前评审者/施工者/用户没有「1 页入口 + 分层阅读顺序」，认知成本高，且本次评审已实测到「同一事实散落三处、口径漂移」（F4）。修法：D10 的 `docs/00-README.md` 给 ≤1 页速读路径（任务→按角色：施工读 ABI→适配器→测试；用户读 INTEGRATION+HANDOFF）；对 `abi-v0.md`/`event.json` 加「按用途索引」小节；把「同一数字/计数只在一处定义、其他处引用」写成文档纪律并进 check_docs。

## 3. 已验证项（反例 1–5 的正面证据，≥8 项）

1. **codex resume 真在契约**：双二进制 `generate-json-schema`，`thread/resume` = `ClientRequest.oneOf[2]`，`ThreadResumeParams` 含 thread_id/history/path 三种续接（VERIFY §2.1）。
2. **claude resume/fork 真在 typings**：`sdk.d.ts:1925 resume?`、`:1939 resumeSessionAt`、`:1574 forkSession?`、`:738 forkSession()`（VERIFY §2.2）。
3. **kimi 无中断**：自起 ACP，`session/cancel → {"code":-32601,"message":"Method not found: session/cancel"}`（VERIFY §2.3）。
4. **kimi 会话可续接**：`initialize.sessionCapabilities={list,resume,close,delete,fork,...}`，同会话两轮 `end_turn`（修示例后实测 24.6s）。
5. **opencode v2 端点真实存在**：`/openapi.json` 124 paths，interrupt/fork/inbox/permission.reply/worktree/SSE 全在（VERIFY §2.4）。
6. **DSH 外部能力位全 false**：asar 抽出 `lib/index.js:2790-2795`，四值全 false；`send_message/interrupt/冷恢复仅本地 continuable` 与 BRIEF 一致（VERIFY §2.5）。
7. **安全默认非全放行**：`enabled:false` + `permissionMode:read-only` + `allowDangerousModes:false` + `worktreeIsolation:required-for-write`（配置 §0/§3.1）。
8. **父会话进度有硬上限与关闭开关**：`progress.mode∈{off,summary,events}` 默认 summary；G13/G14/G15 硬上限超限拒绝启动；父会话只追加（INV-L4-2）。
9. **无「重发即恢复」假设**：codex §4.5 判定顺序「查账本→产品侧对账→决策矩阵」，显式禁止盲目重发；kimi §10.3 禁止超时重发 `session/prompt`。
10. **凭据不泄漏**：`check_docs.py secrets` PASS；评审另用 `~/.claude/settings.json` 真实 `ANTHROPIC_AUTH_TOKEN` 的 8 字符前缀在 docs/.astra/repro/tools 全域检索 → 0 命中（只读、未打印值）。
11. **未遗漏清单项**：额度耗尽/429（ABI §8 + 03-failure F01/F13 + 风险 R01）、并发写同一 worktree（R05 + FI-8）、子代理越权（R04/R13/R15/FI-11 + 威胁模型）、卸载回滚（R20 + 配置 §6 + integration §3.2 回滚 ≤5min）、kimi 无中断（D-008 + 适配器 §10.1）、opencode 无凭据（D-013 + 适配器 §10.1/§10.4）、跨后端会话迁移（architecture 00 §16/§261 明确列为 v0 非目标，非遗漏）。
12. **DAG 无环、切片 ≥15、命令 ≥10**：`check_docs.py plan` PASS；Part A D0→D10 与 Part B C0→C10 依赖单调。

## 4. 必查清单覆盖（任务书要求逐项）

| 检查项 | 结论 | 关键证据 |
|---|---|---|
| 能力矩阵无证据结论 | 未发现（833 引用 0 失效；60 格均带证据） | VERIFY §1.3；矩阵 §1/§4 |
| 矩阵 vs 适配器 vs ABI 能力位一致 | **F1**（opencode 通道选型矛盾）；位名 34 个与 `capabilities.json` enum 完全一致 | 矩阵 §2/§3；`capabilities.json` |
| 适配器「失败与降级」是否全 `unknown` | 否；四份 §10 均给替代路径/父级差异/允许报错条件 | adapters §10 |
| 「重发即恢复」假设/幂等 | 未发现；写操作先对账、同键单次执行有 ABI-T4 断言 | codex §4.5、02-state-machine §5/§7 |
| 父会话进度上限与关闭开关 | 有；G11–G16 硬上限 + INV-L4-2 只追加 | 配置 §2、layers §6.3 |
| 安全默认是否全放行 | 否；fail-closed 四闸 | 配置 §0/§3.1 |
| 凭据泄漏（含 `~/.claude/settings.json`） | 未发现；文档只引用键名/来源枚举 | VERIFY §3、threat-model §1 |
| ABI 版本协商容纳「后端不支持 resume/fork/interrupt」 | 能；R-1/R-2/R-3 声明式降级 + `substitutions[]`，运行期禁止临时切换 | abi-v0 §2.2/§3.5 |
| C0–C10 验收命令可执行 | **F5**（C8 人工观察，C4–C7 非命令）；其余可执行 | PLAN Part B |
| 遗漏项（429/并发 worktree/越权/迁移/回滚/kimi/opencode） | 未遗漏（迁移为明示非目标） | 见 §3 第 11 项 |
| 文档规模（864KB）与速读路径 | **F8**（无入口，D10 待产） | `du -sk docs`=864 |

## 5. 五维评分（0–5，加权）

| 维度 | 权重 | 分数 | 理由 |
|---|---|---|---|
| 可用性 | 25% | **4.0** | 四后端均有可施工规格与命令；闸门/探针 22s 全绿；但两条入门示例不可运行、C8 靠人工，扣 1 分 |
| 正确性 | 30% | **4.0** | 关键能力断言 5/5 独立成立，833 行号引用 0 失效，ABI/能力位/schema 自洽；但计数口径错、非 ABI 错误码、矩阵选型矛盾各扣分 |
| 完整性 | 20% | **4.5** | BRIEF A1–A8/A10/A11 全覆盖：矩阵 60 格、ABI 45 码/34 位/6 schema、风险 26 条、威胁 5 类、四份适配器 12 节、失败模式 20+；仅 A9（本评审）与 A10 的 D10 交付物未到 |
| 品味与工艺 | 15% | **3.5** | 结构、命名、对照表、证据纪律优秀；但示例代码未做超时/fail-closed、探针口径糙、864KB 无速读入口 |
| 可维护性 | 10% | **3.5** | 机械闸门 + 833 条可解析引用 + 单一命名真源设计好；但计数/错误码双轨会被复制，文档体量与入口缺失抬升维护成本 |
| **加权总分** | 100% | **3.98** | 0.25×4.0 + 0.30×4.0 + 0.20×4.5 + 0.15×3.5 + 0.10×3.5 = **3.975 ≈ 3.98** |

## 6. 判定

- **阻断条数：6**（F1–F6）；非阻断 2（F7–F8）。
- 数值门槛：加权 **3.98 ≥ 3.5**、正确性 **4.0 ≥ 4** —— 两项达标；但**阻断 ≠ 0**。
- **判定：不通过（修复后可复评，无需重做设计）**。
  - 主体设计（ABI/架构/矩阵/接入/风险/测试）质量达标，无方向性错误、无伪造证据；
  - 不通过原因是 6 项**可局部修复**的工程缺陷：1 项一致性（F1）、2 项示例代码（F2/F3）、1 项证据口径+映射（F4）、1 项验收可执行性（F5）、1 项命名契约（F6）。
  - 复评只需：重跑两个示例（各 ≤90s）、重跑 `generate-json-schema` 核对计数、grep 错误码、核对 PLAN C 列命令——预计 ≤30 分钟。

## 7. 给施工会话的必须修正项（按优先级，≤10）

1. **[F1]** `capability-matrix.md §2` opencode 行改为「v2 HttpApi 优先 + ACP 兜底」，回指 `D-007`，并在矩阵头加「按后端选型」声明（D10 integrator 写域）。
2. **[F4]** 修 `repro/probe-codex.sh` 计数口径（按 `properties.method` 计数，不过滤 `/`）；订正 `research/codex.md`、`adapters/codex.md`、`capability-matrix.md` 的 `97/104/76/80`；`error` 通知单列映射行。
3. **[F3]** `adapters/kimi.md §3.4`：`fs/read_text_file` 缺文件回 `-32602`、其他异常回 `-32603`；§2.3 契约同步；验收预期加「plans 文件缺失也须 `end_turn`」。
4. **[F2]** `adapters/codex.md §4.6`：默认继承真实 `CODEX_HOME`（或首帧断言 auth）+ 读超时 + 杀进程组 + `ServerRequest` 自动拒绝桩 + 补「验收预期」。
5. **[F5]** `.astra/PLAN.md` Part B：C4–C8 每片补 1 条脚本化断言命令；C8 用工具清单断言脚本替换「在 DSH 中可见且可派发」。
6. **[F6]** 风险/测试文档错误码统一为 `error.json` 枚举；`check_docs.py` 增「非 ABI 码即 FAIL」校验。
7. **[F7]** `test/00-test-plan.md §7-4` 人工确认改为 golden + 白名单字段的机器比对。
8. **[F8]** D10 `docs/00-README.md` 提供 ≤1 页速读路径（按角色）+「单一事实单处定义」纪律。
9. **[遗留]** HANDOFF 写入 opencode live turn 补测步骤（`PROBE_LIVE=1`，凭据就绪后跑）与 codex 成功 turn 的可用模型基线（本机 `gpt-6.1-sol` 对 ChatGPT 账号返回 `model_not_found`，C4 需显式配可用模型）。
10. **[记录]** 本机 `/tmp/mocl-codex-home` 已被探针创建为无凭据 CODEX_HOME；施工勿复用，作为 F2 的复现物料保留说明。

## 8. 遗留核验（不阻塞本次交接）

| 项 | 状态 | 原因 / 下一步 |
|---|---|---|
| opencode 真实 turn 与事件全集 | **未能复验** | 本机 provider 凭据过期（D-013）；按 `adapters/opencode.md §10.4` 补凭据后跑 `PROBE_LIVE=1` |
| codex 成功 turn（非仅生命周期） | **未能复验** | 上游代理对 `gpt-6.1-sol` 返回 `model_not_found`（ChatGPT 账号不支持）；需可用的 codex 模型基线后由 C4 补 |
| kimi 跨进程 `session/load` 续接 | 文档自标 TO-VERIFY | §3.4 已给补测步骤；C6 落测 |
| claude 最小示例（§4.6） | 未执行（任务只要求 codex+kimi 各 1 条） | 其余断言已在 typings 层复验 |
| DSH seam 运行期行为（外部子级实际拒绝 send_message/interrupt） | 仅验证常量与类型 | 施工 C8 用负例断言（构造 `agentOptions`/数值 `maxDepth` 请求 → `UNSUPPORTED_CAPABILITY`） |
| D10 四份文件 | 未产出（预期） | `python3 tools/check_docs.py all` 复跑应全绿 |

## 9. 未命中但需观察（O 项，不计入打回）

- **O-1** `native-subagents` 对 kimi/claude 记 ✅ 的依据是「产品内存在 + 盘上痕迹/二进制字符串」，非「可编程编排通道实测」（kimi ACP 无 subagent 方法、claude `SendMessage/ListAgents` 无公开 typing）。矩阵 §4 C8 已按证据强度分级并给施工补测项，暂不构成反例 1；建议施工 C5/C6 一旦确认无通道，及时把 ✅ 降为 🟡 并更新风险。
- **O-2** `MultiAgentMode` 文档简写为 `explicitRequestOnly|proactive|custom`，真 schema 是 `oneOf[enum(2), {custom:string}]`（0.153.4 实测）。语义不误导，建议在适配器类型绑定处按 oneOf 生成，避免枚举假设。
- **O-3** `repro/run_all.sh` 默认不跑 ACP 会话级探针（`PROBE_ACP_SESSION=1` 才跑），A11 的「≥5 条可复跑且一致」成立，但 kimi/opencode 的 `session/*` 结论默认不在回归内；建议 C6/C7 把 §5b/§6b 纳入 nightly。

---

## 9. 复评（D10 后）

> 触发：Lead 复评请求（时间盒 ≤15 分钟，只做定向复核）。D10/Lead 声称已按 F1–F8 修复；
> 本节逐条**重新取证**，不采信修复说明。复评时全闸门状态：
> `python3 tools/check_docs.py all` → **exit 0 / 393 checks / 0 failures**（含新增 `errcodes` 闸门）；
> `bash repro/run_all.sh` → **exit 0 / 4/4 PASS**。

### 9.1 F1–F8 逐条复核

| # | 复核命令（摘要） | 结论 | 证据 |
|---|---|---|---|
| F1 矩阵选型 | `sed -n '32,45p' capability-matrix.md`；`grep D-007` | **已修复** | §2 标题改为「派生表 A：传输通道选型（**按后端选型**；opencode 按 LEDGER **D-007** = v2 HttpApi 优先 + ACP 兜底）」；opencode 行首选改为 `v2 HttpApi（优先；D-007 裁定）`、备选 `ACP over stdio（兜底）`，选型结论同步回指 D-007；与 `adapters/opencode.md §0.2` 一致 |
| F2 codex §4.6 | 抽取原文 python 块 → `CODEX_HOME=/tmp/mocl-empty-home` 运行（限 30s） | **已修复** | `EXIT: 1 elapsed=0.02s`，`FATAL: /tmp/mocl-empty-home/auth.json 不存在；请先 codex login…`（fail-fast）；代码已含 `queue+next_frame 超时→killpg`、10 个 `ServerRequest` 自动拒绝桩、`error` 通知打印；新增「验收预期」5 条（成功路径/本机限制/fail-fast/超时可判定/禁止依赖） |
| F3 kimi §3.4 | 抽取原文 → `py_compile` + 运行一次（限 60s） | **已修复** | `py_compile OK`；运行 `EXIT: 0 / 7.5s`，输出两行 `turn 1/2 session_ecace3cc-… end_turn`；代码含 `FileNotFoundError → -32602`、其他异常 → `-32603`；§3.4 验收预期新增「plans 文件缺失也须走 end_turn」 |
| F4 计数口径 | 读 `probe-codex.sh` `methods()`；grep 三份文档数字 | **已修复** | `methods()` 改为读 `properties.method` 的 `enum/const`（注释直指 F4），不再按 `/` 过滤；`research/codex.md:22` = `99 → 106 / 81 → 85`、`ServerRequest 10`；`adapters/codex.md:49` CI 期望 = `39 / 99 / 81`、`:452` 注明「旧稿 76 漏计无斜杠 5 个」、`:803` 导出回显 99/81/10；`error` 通知单列 `#36` 行（`turn.failed` 主源 / `session.warning` 诊断源，终态优先去重），`D8` 条目标记已闭环 |
| F5 施工验收脚本化 | `grep "可见且可派发" PLAN`；逐行读 Part B | **已修复** | `可见且可派发` = **0 命中**；C2 `pnpm -s test -- broker -- --case=kill-recover`、C4–C7 `pnpm -s smoke -- --backend=… --turn=1 --assert=exit0`、C8 `node scripts/assert-tools.mjs --expect subagent_agent,mocl_status --session=<id>` + `--assert=tool-visible`、C9/C10 均带断言；剩余「人工观察」仅出现在反例预注册规则原文（非验收项） |
| F6 错误码统一 | `check_docs.py errcodes`；grep 旧码 | **已修复** | `PASS errcodes / checks=52 / failures=0`；`quota-denied|auth-failed|bad-cwd|session-gone|crashed|bad-frame|unknown-frame` 在 `docs/risk`、`docs/test` 命中 **0**；替换后实际使用 `quota.rate-limited`/`quota.usage-exhausted`/`auth.credential-rejected`/`policy.sandbox-violation`/`session.not-found`/`process.crashed`/`transport.frame-invalid`/`protocol.bad-frame`/`internal.unexpected`/`transport.timeout`，均在 `error.json` 枚举内 |
| F7 回放门禁 | `sed -n '/## 7. 执行与门禁/,/## 8/p' 00-test-plan.md` | **已修复** | 门禁 4 改为「golden 文件 + 白名单字段（`ts`/`requestId`/绝对路径）自动 diff，无白名单变更时零差异即通过；白名单变更须在 PR 单独记录（禁止人工看一眼式放行）」 |
| F8 速读路径/ABI 索引 | `wc -l docs/00-README.md`；grep ABI 索引 | **已修复** | `docs/00-README.md` 90 行 = 1 页：30 秒速查 6 问 + 按角色阅读路径（施工/评审/用户）+ 文档地图（每份一句话）；`abi-v0.md §12.1 按用途索引（速查：先读哪张表）` 已存在并被 README/HANDOFF 引用 |

**附带项（Lead 指定）**：`error.json` 现有 **46 码**（新增 `backend.internal-error`，`category=internal`，12 类不变），
`abi-v0.md:612/722/838`、`architecture/03-failure-modes.md:42/224`、`integration/02-ui-data-plane.md:134`
均已写 46 并回指 ABI §13.3 变更记录；全库 `grep "45 个|45 码"` 在 `docs/`（除本评审历史记录与
`.astra/INTEGRATION.md` 的修复记录外）**0 残留**。`configurations/capabilities/events` 数字抽检：
能力位 34（`capabilities.json` enum=34）、事件 35（`event.json` oneOf=35）、方法 18（`abi-v0 §6` M1–M18）
与 README/HANDOFF 声称完全一致。

### 9.2 新发现（F9，非阻断）

- F9｜非阻断｜双源数字漂移风险：`docs/00-README.md`、`HANDOFF.md` 与 `abi-v0.md`/schema 各复制了一遍
  「34 能力位/18 方法/35 事件/46 错误码/版本基线」。本次 F4 的事故形态正是「同一事实多处复制后漂移」。
  当前值一致（复评已核），但建议后续把 README/HANDOFF 改为「引用 `abi-v0.md §12.1` + `check_docs.py` 输出」，
  只保留一处定义；或在 `check_docs.py` 增加「README/HANDOFF 数字 == schema 实测数字」的交叉断言。
  （不影响本次交付；C10 硬化时处理即可。）

### 9.3 最终评分（复评后重算）

| 维度 | 权重 | 初评 | 复评 | 变化理由 |
|---|---|---|---|---|
| 可用性 | 25% | 4.0 | **4.5** | 两个入门示例现均可运行（codex fail-fast 可判、kimi 7.5s 两轮 end_turn）；C0–C10 全部脚本化；opencode live 仍按 D-013 明示待凭据 |
| 正确性 | 30% | 4.0 | **4.5** | 计数口径订正为 99/81/106/85 并同步三份文档；`error` 通知补映射与去重规则；错误码单一真源 + 新 `errcodes` 闸门；46 码与 34/35/18 数字抽检全一致 |
| 完整性 | 20% | 4.5 | **4.5** | D10 四件套（00-README/HANDOFF/INTEGRATION/JOURNAL）已产出；A1–A11 全绿；open-blockers 清零，TO-VERIFY 项按设计保留在 HANDOFF |
| 品味与工艺 | 15% | 3.5 | **4.0** | 示例补了安全脚手架与验收预期（fail-closed/超时/进程组）；文档有 1 页入口与按角色路径；扣分点：脚手架使「最小」示例变 78 行，需读者跳读 |
| 可维护性 | 10% | 3.5 | **4.0** | 新增 `errcodes` 机械闸门（393 checks）；833 条行号引用 0 失效；单一命名真源 + ABI 按用途索引；残留 F9 双源数字风险 |
| **加权总分** | 100% | 3.98 | **4.38** | 0.25×4.5 + 0.30×4.5 + 0.20×4.5 + 0.15×4.0 + 0.10×4.0 = **4.375 ≈ 4.38** |

### 9.4 最终判定

- **剩余阻断数：0**（F1–F8 全部复核为「已修复」，证据见 §9.1）。
- 非阻断：F9（双源数字风险）+ 既有 F8 已修的残余提示。
- 数值门槛：加权 **4.38 ≥ 3.5**；正确性 **4.5 ≥ 4**；阻断 **0** —— 三项全部达标。
- **最终判定：通过（可交付施工）**。
- 交付边界（如实声明，不视为阻断）：opencode 真实 turn 待凭据（D-013，HANDOFF §8 有补测步骤）；
  kimi 跨进程 `session/load` 仍为 TO-VERIFY（C6 落测）；codex 成功 turn 需可用模型基线（本机
  `gpt-6.1-sol` 对 ChatGPT 账号 `model_not_found`，已写入示例验收预期第 2 条）。

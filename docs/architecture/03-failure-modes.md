# 03 — 失败模式、重试与降级

> 本文回答：**失败如何被检测、归为哪个分类码、能不能重试、怎么降级、父级看到什么、用户看到什么、用什么信号观测**。
> 错误码/能力位/事件名以 `docs/abi/abi-v0.md` 为唯一真源（§3 能力位、§7 事件、§8 错误码、§9 幂等）；状态与恢复以 `docs/architecture/02-state-machine.md` 为准。
> 后端原生错误 → 分类码的具体映射表属 `docs/adapters/*`（D5）；本文只给**归类规则与阈值**。

---

## 1. 三条总原则

1. **分类只在 L1 发生一次**（原生 → ABI 错误码）；L2 决定「重试/降级/终止」，L4 决定「怎么呈现」，L5 负责观测。禁止各层各自解释错误。
2. **写操作永不盲目重试**：先对账（查询后端真实状态），再决定补结果或同键重发；只读操作可安全重试。依据：abi-v0 §9、02 §7.2。
3. **降级必须是声明式的**：运行期不临时发明替代路径；能力缺失按 abi-v0 §3.5 的 R-1..R-19 执行，失败按本节 §4 的阶梯落到明确状态。

## 2. 失败模式表（20 类，含 BRIEF 要求的 12 类）

> 列说明：**可重试**取值 `no` / `once` / `backoff` / `after-recovery`；**父级影响**取值见 §6；**用户可见提示**即 ABI `error.userMessage` 的默认文案。

| # | 失败模式 | 检测信号 | 分类码 | 可重试 | 重试/退避策略 | 降级动作 | 对父级的影响 | 用户可见提示 | 可观测信号 |
|---|---|---|---|---|---|---|---|---|---|
| F01 | **429 限流** | HTTP 429 / JSON-RPC error.data 含 rate；或 `retryAfterMs` 返回 | `quota.rate-limited` | backoff | 尊重 `Retry-After`；否则 1s→2s→4s→8s→16s，±20% 抖动，最多 5 次；超限 → `blocked` | 暂停该会话派发；其它后端会话不受影响；请求排队而非失败 | P2（延迟） | 后端限流，正在退避重试 | `mocl.errors{code=quota.rate-limited}` 速率、`mocl.retries` |
| F02 | **认证失败** | 401/403、`api_key_expired`、`invalid key`、ACP 登录提示 | `auth.missing-credential` / `auth.credential-expired` / `auth.credential-rejected` / `auth.login-required` | no（expired 可刷新 1 次） | 不循环重试（防账号锁定）；`credential-expired` 且后端支持刷新时最多 1 次 | 该后端所有会话 fail fast：`blocked` → 运维处理；不自动重派 | P1（不可完成） | 后端凭据缺失/过期/被拒绝，请重新登录 | `mocl.errors{category=auth}`；`auth` 事件只在握手期 |
| F03 | **协议坏帧** | JSON 解析失败、行不完整、重复/未知 request id | `transport.frame-invalid` / `protocol.bad-frame` | 有条件 | 单帧丢弃 + 计数；连续 5 帧坏 → 重建连接（1 次）；重建后仍坏 → `lost` + 恢复 | 断开重连 → 冷恢复；不重放坏帧 | P2（延迟）/P0（若恢复失败） | 协议异常，正在重建连接 | `mocl.frames.invalid`、`mocl.frames.continuous_errors` |
| F04 | **进程崩溃** | 退出码非零 / 被信号杀死 / 轮次未终态 | `process.crashed` | after-recovery | 不原地重启；走 T8→T12 冷恢复（最多 5 次，退避 2s 起） | 会话 `lost` → `recovering`；恢复成功继续，失败 `aborted` | P2→P0 | 后端进程崩溃，正在恢复会话 | `mocl.process.exits{signal,code}`、`mocl.recoveries` |
| F05 | **hang（无输出但未退出）** | 心跳缺失 + 无事件 > `idleTimeoutMs`（180s）；请求超时 | `process.hung` / `transport.timeout` | after-recovery | 先只读探测（不立刻杀）；确认无响应 → SIGTERM→SIGKILL（1 次）→ 恢复 | 中断当前轮 → `lost`/`recovering`；保留已产出事件 | P2（延迟）/P0 | 后端无响应，正在重启恢复 | `mocl.idle.timeouts`、`mocl.process.kills` |
| F06 | **磁盘满** | ENOSPC、写 journal/快照失败 | `storage.disk-full` | 有条件（释放后） | 不重试写；等待空间恢复；每 30s 探测一次空间 | **只读降级**：拒绝新轮次/新会话，保留已提交结果与查询；不删 journal | P1（无法新任务） | 本地磁盘已满，已暂停新任务 | `mocl.journal.bytes`、`disk_free_bytes`、`mocl.errors{code=storage.disk-full}` |
| F07 | **会话失效** | resume/load 返回 not-found/已删除；list 中消失 | `session.invalidated` | no（可 reseed） | 只探测 1 次；unarchive/fork/reseed 各最多 1 次（02 §7.3） | 默认 `aborted(invalidated)`，保留 `preservedThroughSeq`；reseed 需显式策略 | P0（需重派） | 会话在后端已失效，无法续接 | `mocl.errors{code=session.invalidated}`、`mocl.recoveries{strategy}` |
| F08 | **能力缺失** | 握手声明 `unavailable`；运行期 `-32601`/unsupported | `capability.missing` / `capability.unsupported-method` | no | 不重试；按 abi-v0 §3.5 找替代路径（resume→reseed、interrupt→kill、multiTurn→新建…） | 声明式降级；运行期才发现的缺口 → `blocked` 并等决策（不静默换路径） | P2（行为差异） | 后端缺少所需能力：<bits> | `mocl.capabilities{bit,state}`、`mocl.substitutions` |
| F09 | **嵌套超限** | 请求 spawn 时 `depth > maxNestingDepth`（默认 2） | `limit.nesting-exceeded` | no | 不重试 | 拒绝该子会话创建；父级可改用平级任务或降低深度 | P1（子任务） | 子代理嵌套超过上限 | `mocl.limit.rejections{kind=nesting}` |
| F10 | **并发冲突** | 同会话并发写 / 槽位满 / 租约冲突 / 双写 | `session.locked` / `limit.concurrency-exceeded` / `session.conflict` | 是（`retryAfterMs`） | 锁冲突：按 `retryAfterMs` 重试 1–2 次；槽位满：排队 `queued`，超时 `limit.concurrency-exceeded`；租约冲突：旧写者退出，新 epoch 接管（不重试旧写） | 排队或拒绝；绝不双写同一后端会话 | P2（延迟） | 会话正忙/并发已达上限，请稍后重试 | `mocl.leases.conflicts`、`mocl.sessions.queued` |
| F11 | **版本漂移** | 二进制/SDK/协议版本与钉住值不一致；`claude --version`/`codex --version`/ACP `agentInfo.version` 断言失败 | `protocol.version-mismatch` | no | 不重试；拒绝混跑 | fail fast：该后端标记不可用（`blocked`/握手失败）；提示需对齐版本 | P1（不可完成） | 后端版本不匹配，已阻止启动 | `mocl.version.mismatch_total`、`capability.warnings` |
| F12 | **凭据泄漏** | 日志/事件命中凭据模式；后端明文回显密码（opencode `serve` 行为）；错误体含 token | `security.credential-leak-suspected` | no | 不重试；丢弃该内容、脱敏日志、告警 | 阻断相关输出；保留审计；不把内容传给父级/UI | P1（阻断泄漏） | 检测到凭据泄漏风险，已脱敏并告警 | `mocl.security.leak_suspected_total`、审计记录 |
| F13 | **额度耗尽** | 余额/配额错误（非 429） | `quota.usage-exhausted` | no（需补额度） | 不重试 | `blocked`，停止派发；保留事件与结果 | P1（不可完成） | 后端额度已耗尽，请补充额度 | `mocl.errors{code=quota.usage-exhausted}` |
| F14 | **上下文溢出** | 上下文窗口错误 / `stopReason=context-limit` | `quota.context-overflow` | no（同输入） | 不重试 | 压缩/分叉/重开（能力允许时）；否则 `aborted` 并保留结果 | P1（本轮失败） | 上下文超出窗口，已尝试压缩/重开 | `mocl.turns.context_overflow` |
| F15 | **权限拒绝 / 越权** | 自动策略 deny；路径越界；非 worktree 写入 | `policy.permission-denied` / `policy.sandbox-violation` / `policy.escalation-required` | no | 不重试 | 拒绝该动作（工具失败但会话可继续）；严重越界 → `aborted` | P2（任务部分完成） | 操作被权限策略拒绝 / 越过沙箱边界已阻止 | `mocl.policy.denials{tool,risk}` |
| F16 | **传输中断** | EOF / pipe 断 / ws close | `transport.disconnected` | after-recovery | 冷恢复；不原地重放未确认请求 | `lost` → 恢复；恢复失败 `aborted` | P2→P0 | 与后端的连接中断，正在恢复会话 | `mocl.transport.disconnects` |
| F17 | **请求超时** | 单请求超时（读/写） | `transport.timeout` | 读=backoff；写=after-recovery | 读：最多 2 次；写：**先对账**，不盲目重发 | 对账后补结果或同键重发；仍失败 → `blocked`/`aborted` | P2 | 后端响应超时，正在核对会话状态 | `mocl.timeouts{method}` |
| F18 | **事件风暴 / 背压** | 事件率超阈值；消费者 ack 滞后；缓冲水位高 | `transport.backpressure` | 是（延迟） | 不重试；缩短折叠窗口（最小 1s）→ 丢弃低优先级 → 保留终态 | 折叠率提高；父级进度变稀疏；不丢终态 | P3（进度稀疏） | 后端输出过快，进度已折叠 | `mocl.events.dropped`、`mocl.fold_ratio` |
| F19 | **重复投递 / 事件乱序** | 同 `eventId` 重复；seq gap；旧 epoch 事件 | `protocol.unexpected-response`（若来自后端）/ 本地去重 | 是（本地修复） | 按 `eventId` 去重；gap → `session.replay` 补齐；旧 epoch 丢弃 | 不改变状态；补发缺失事件 | P3（短暂乱序） | （通常不可见） | `mocl.events.gaps`、`mocl.events.duplicates` |
| F20 | **存储损坏** | journal checksum 失败；快照损坏；映射歧义 | `storage.corrupt` / `session.mapping-corrupt` | no（需修复） | 不重试；截断到最后有效记录 + 重建；orphan 隔离 | 只读降级；orphan 等 `admin.repair`；不自动 attach | P1（该会话不可用） | 本地状态文件损坏，正在修复 | `mocl.storage.corrupt_total`、`mocl.orphans` |

> 未列入但必须归类的：`process.spawn-failed`（启动失败 → 换路径/绑定 1 次后 fail）、`protocol.invalid-params`（兼容层缺陷 → `internal` 处理路径）、`internal.unexpected`（兜底，必须带 `traceId`）。完整 46 个错误码见 abi-v0 §8.2。

## 3. 重试策略（统一规则）

### 3.1 可重试性判定矩阵

| 操作类型 | 幂等安全？ | 允许重试 | 前置动作 |
|---|---|---|---|
| 只读（query/list/read/replay） | 是 | `once`/`backoff`（≤2 次） | 无 |
| 建会话（`session.create`） | 是（同键） | `backoff`（≤2 次） | 查账本；同键返回同一 `sess_id` |
| 发消息（`session.send`） | 同键安全 | **仅对账后**（`after-recovery`） | `session.query` 确认该轮是否已产生 |
| 续接/恢复 | 同键安全 | `backoff`（阶梯，≤5 次） | 只读探测 |
| 中断 | 是 | `once` | 查当前轮状态 |
| 应答权限/输入 | 同 `requestId` 安全 | `once` | 查 pending 表 |
| 关闭/归档 | 是 | `once` | 查状态 |

### 3.2 退避公式与上限

```text
delay(n) = min(cap, base * 2^(n-1)) * (1 + jitter),  jitter ∈ [-0.2, +0.2]
base = 500ms, cap = 30s, maxAttempts = 5（恢复另有窗口 10min）
若存在 Retry-After/retryAfterMs → delay = max(delay, serverSuggested)
```

- **重试预算**：单会话单轮最多 5 次重试；单后端连续 30 次重试失败 → 熔断（§3.3）。重试次数计入指标，不静默。
- **重试键不变**：写操作重试必须复用原 `clientRequestId`（INV-L4-6）；新键重试等于新请求，禁止用于「补救」。
- **禁止重试**：认证类、参数类、版本类、能力缺失、权限拒绝、凭据泄漏（重试只会放大问题）。
- **超时分层**：单请求超时（30s 默认）≠ 单轮超时（30min）≠ 恢复窗口（10min）；任何一层超时都不得直接判「完成」。

### 3.3 熔断（per backend）

| 状态 | 进入条件 | 行为 | 退出 |
|---|---|---|---|
| `closed` | 正常 | 正常派发 | — |
| `open` | 连续失败 ≥ 阈值（默认 10 次/5min，或认证/版本类 1 次） | 新会话直接 `blocked`/拒绝（`quota.usage-exhausted`/`auth.*` 等），不发后端请求 | 冷却 60s 后 → `half-open` |
| `half-open` | 冷却结束 | 放行 1 个探测请求；成功 → `closed`；失败 → `open`（冷却翻倍，上限 10min） | 见左 |

熔断状态由 L5 控制面持有，L2 在 spawn 前查询；熔断不丢已有会话的恢复能力（恢复请求仍放行 1 个）。

## 4. 降级阶梯（D0–D4）

> 「降级」不是单一动作，而是按可用性逐级下降。每级都必须可观测、可回退。

| 级别 | 名称 | 触发 | 行为 | 父级可见 | 何时升级到下一级 |
|---|---|---|---|---|---|
| **D0** | 全功能 | 能力齐全 | 原生路径 + 流式 + 折叠增量 | 正常 | — |
| **D1** | 能力降级 | 某能力 `unavailable` | 按 abi-v0 §3.5 替代路径（reseed/process-kill/消息级流/无子会话树…） | 行为差异 + `degradeWarnings` | 替代路径也失败 |
| **D2** | 只发终态 | 事件风暴/折叠器异常/背压持续 | 停发中间态，只发 `turn.*` 终态与状态转移；进度归零 | 进度不可见，但结果正确 | 后端不稳定继续 |
| **D3** | 只读 / 暂停派发 | 存储写失败、磁盘满、映射损坏、熔断 open | 拒绝新会话/新轮次；查询与已提交结果可读；已有会话等待修复 | 新任务被拒（明确原因） | 修复失败或保留期到 |
| **D4** | 终止（终态） | 不可恢复（invalidated、预算耗尽、策略拒绝、恢复窗口耗尽） | `aborted`，保留事件与部分结果，tombstone | 「已终止：原因 + 可读范围」 | —（需人工/新派发） |

降级决策表（按失败模式）：

| 失败模式 | 初始级别 | 可自动升级 | 回退条件 |
|---|---|---|---|
| F01 429 | D1（延迟，不降能力） | 持续 5 次 → D3（该后端暂停） | 限流解除且探测成功 |
| F02 认证 | D4（该后端） | 不自动 | 人工修复凭据后重新握手 |
| F03 坏帧 | D1（重连） | 重连失败 → 恢复 → D4 | 恢复成功 |
| F04 崩溃 / F05 hang | D1（恢复） | 恢复失败 → D4 | 恢复成功 |
| F06 磁盘满 | D3 | 不自动升级 | 空间恢复 |
| F07 会话失效 | D1（reseed）→ D4 | reseed 失败 → D4 | 新会话可用 |
| F08 能力缺失 | D1 | 运行期新缺口 → D3（blocked 等决策） | 决策后恢复 |
| F09 嵌套超限 | 拒绝该子任务（D4 子级） | 不自动 | 调用方降深度 |
| F10 并发冲突 | D1（排队/延迟） | 持续满 → D3（拒绝） | 槽位释放 |
| F11 版本漂移 | D4（该后端） | 不自动 | 对齐版本 |
| F12 凭据泄漏 | D1（脱敏）+ 告警 | 不自动 | 人工确认 |
| F13 额度耗尽 | D3（该后端） | 不自动 | 补额度 |
| F14 上下文溢出 | D1（压缩/分叉） | 失败 → D4（本轮） | 新会话 |
| F15 权限拒绝 | D1（工具级失败） | 越权严重 → D4 | 策略修正 |
| F16 传输中断 | D1（恢复） | 失败 → D4 | 恢复成功 |
| F17 超时 | D1（对账） | 对账不可判定 → D3（blocked） | 对账完成 |
| F18 事件风暴 | D2 | 持续 → D3 | 事件率回落 |
| F19 重复/乱序 | D1（去重/重放） | 不升级（本地可修） | 无 gap |
| F20 存储损坏 | D3（只读 + 修复） | 不可修 → D4（该会话） | 修复完成 |

## 5. 错误 → 会话状态映射

| 分类码前缀 | 会话状态 | 是否终态 | 说明 |
|---|---|---|---|
| `transport.*` | `lost`（恢复）或 `blocked`（不可恢复） | 否/否 | 传输问题先恢复，不直接终态 |
| `auth.*` | `blocked`（该后端全部会话） | 否 | 需人工；不重试 |
| `quota.rate-limited` | 保持当前状态（延迟） | 否 | 不改变生命周期，只影响派发 |
| `quota.usage-exhausted` / `quota.context-overflow` | `blocked` / 本轮 `failed` | 否/是 | 前者等额度，后者本轮失败 |
| `protocol.version-mismatch` | `blocked`（该后端） | 否 | 需对齐版本 |
| `protocol.*`（其他） | `lost` → 恢复；或 `blocked` | 否 | 按 02 §8 |
| `process.*` | `lost` → 恢复 | 否 | 恢复失败 → `aborted` |
| `capability.*` | `blocked`（运行期）或握手失败 | 否 | 需决策/降级 |
| `session.invalidated` | `aborted`（`terminalReason=invalidated`） | **是** | 02 §7.3 |
| `session.conflict` / `session.locked` | 保持当前状态（拒绝本次调用） | 否 | 调用方可重试 |
| `session.mapping-corrupt` | `blocked`（orphan） | 否 | 等 `admin.repair` |
| `policy.permission-denied` | 保持当前状态（工具失败） | 否 | 会话可继续 |
| `policy.sandbox-violation` | `aborted`（严重）或工具失败 | 视情况 | 越界写默认终止 |
| `storage.disk-full/write-failed/corrupt` | `blocked` / 只读降级 | 否 | 修复后恢复 |
| `limit.nesting-exceeded` | 拒绝子会话（父级不受影响） | 否 | — |
| `limit.concurrency-exceeded` | `queued` 或拒绝 | 否 | 可重试 |
| `limit.budget-exceeded` / `limit.turn-timeout` | `aborted`（本轮）/ 会话按策略 | 视情况 | 保留部分结果 |
| `security.credential-leak-suspected` | 当前状态不变 + 告警 | 否 | 内容隔离 |
| `internal.unexpected` | `blocked`（保守） | 否 | 带 `traceId`，人工排查 |

## 6. 对父级的影响分级

| 级别 | 含义 | 父级看到什么 | 需要父级做什么 |
|---|---|---|---|
| **P0** | 子任务不可完成，结果缺失 | 终态 `aborted` + 原因 + `preservedThroughSeq` | 重新派发或人工接手 |
| **P1** | 子任务部分完成 / 无法继续 | `completed(partial)` 或 `blocked`；明确缺失项 | 决策：补参数、换后端、放弃 |
| **P2** | 延迟 / 降级但结果可用 | 「恢复中」「退避重试中」进度；不改变最终结果 | 通常无需动作（可等待） |
| **P3** | 仅进度可见性下降 | 进度稀疏/折叠；终态照常 | 无 |

父级影响必须在事件里可判定：`error.userMessage` + `session.state-changed.reason` + `result.status` 三者一致，禁止「报错但结果看似成功」。

## 7. 可观测信号与告警阈值（L5 落地）

| 信号 | 类型 | 告警阈值（默认） | 用途 |
|---|---|---|---|
| `mocl.errors{code,category,backend}` | counter | 5min 内同 code 增长 > 20 或任意 `security.*` > 0 | 失败画像 |
| `mocl.retries{code,attempt}` | counter | 单会话 > 5 / 单轮 | 重试风暴 |
| `mocl.recoveries{strategy,result}` | counter | 失败率 > 30%/10min | 恢复健康度 |
| `mocl.events.dropped{kind}` | counter | 丢弃率 > 10% | 折叠/背压调参 |
| `mocl.fold_ratio` | gauge | > 100:1 持续 5min | token 级风暴 |
| `mocl.journal.bytes` / `disk_free_bytes` | gauge | 剩余 < 2 GiB 或 journal > 1 GiB | 磁盘满预警（F06） |
| `mocl.leases.conflicts` | counter | > 0 | 双写/fencing 异常 |
| `mocl.orphans` | gauge | > 0 | 映射损坏/需人工（F20） |
| `mocl.capabilities{bit,state}` | gauge | 任意必需位 `unavailable` | 接入前检查（F08） |
| `mocl.parent_progress.chars_per_turn` | histogram | P95 > `maxCharsPerTurn` 的 80% | 父会话预算（BRIEF 硬约束 3） |
| `mocl.version.mismatch_total` | counter | > 0 | 版本漂移（F11） |
| `mocl.security.leak_suspected_total` | counter | > 0（立即告警） | 凭据泄漏（F12） |

错误日志字段（强制）：`ts, level, traceId, sessionId?, turnId?, backendId, code, category, retryable, attempt, userMessage, degradedFrom?, redacted=true`。**禁止**记录原始 stderr、token、Authorization。

## 8. 后端错误形态的归类指引（不写具体后端映射，只给规则）

| 原生形态 | 归类 | 备注 |
|---|---|---|
| HTTP 401 / 403 / `api_key_expired` / OAuth 过期 | `auth.*` | 区分 `missing/expired/rejected`；登录提示 → `auth.login-required` |
| HTTP 429 / `rate limit` / `too many requests` | `quota.rate-limited` | 提取 `Retry-After`/`retryAfterMs` |
| 余额/配额耗尽（非 429） | `quota.usage-exhausted` | 不可重试 |
| JSON-RPC -32601 / Method not found | `protocol.unknown-method` | 同时把对应能力位标 `unavailable` |
| JSON-RPC -32602 / Invalid params | `protocol.invalid-params` | 视为兼容层缺陷，记 `traceId` |
| JSON-RPC -32603 / Internal error | 视上下文：`internal.unexpected` 或映射到会话错误 | 需 `details.backendCode` |
| `ECONNREFUSED` / `ENOENT` / `EACCES`（spawn） | `process.spawn-failed` / `transport.connect-failed` | 换路径/绑定 1 次后 fail |
| 非零退出 / signal 终止 | `process.crashed` | 带 exit code/signal |
| 读超时 / 无响应 | `process.hung` / `transport.timeout` | 先探测后杀 |
| ENOSPC | `storage.disk-full` | 只读降级 |
| 权限/审批拒绝 | `policy.permission-denied` | 工具级失败 |
| 上下文窗口错误 | `quota.context-overflow` | 压缩/分叉/重开 |
| 未知错误体 | `internal.unexpected` + `backendCode` | 禁止裸文本上抛 |

## 9. 故障注入清单（供 D8 测试计划落地）

| 注入点 | 注入方式 | 断言 |
|---|---|---|
| F01 429 | mock 适配器返回 429 + Retry-After | 退避次数、最终状态、不重复副作用 |
| F02 认证 | mock 401 | 不重试、`blocked`、父级收到 userMessage |
| F03 坏帧 | 传输层注入半行 JSON / 未知 id | 单帧隔离、连续 5 帧重建、会话恢复 |
| F04 崩溃 | kill -9 子进程 | `lost` → 恢复成功/失败路径、epoch 递增 |
| F05 hang | 停止输出但保持进程 | 探测→SIGTERM→恢复；无永久挂起 |
| F06 磁盘满 | 挂载小盘/模拟 ENOSPC | 只读降级、不丢已提交、恢复后继续 |
| F07 会话失效 | 删除后端会话后 resume | `session.invalidated`、reseed/abort 各一次、无死循环 |
| F08 能力缺失 | 握手声明 resume=unavailable | R-1 降级、`substitutions[]`、无裸异常 |
| F09 嵌套 | 构造 depth=3 请求 | `limit.nesting-exceeded`、父级不受影响 |
| F10 并发 | 同会话并发 send / 双 Broker | `session.locked` / `session.conflict`，无双写 |
| F11 版本漂移 | 改版本断言 | 握手 fail fast、不混跑 |
| F12 凭据泄漏 | 在 stderr 注入 `Bearer ...` 模式 | 脱敏、告警、不进事件 |
| F18 风暴 | 注入 10k token 级事件 | 折叠比、丢弃计数、终态必达 |
| F19 重复/乱序 | 重复投递 + 打乱 seq | 去重、gap 触发 replay、状态一致 |
| F20 损坏 | 破坏 journal 尾部/映射 | 截断重建、orphan 隔离、只读降级 |

## 10. 反模式（禁止）

1. 用「重试」掩盖分类错误（把未知错误一律 `backoff`）。
2. 把认证/版本/能力错误当作网络错误重试（会放大故障）。
3. 写操作超时后直接重发（可能重复副作用）。
4. 降级时静默改变语义而不上报（父级无法判断结果可信度）。
5. 只写日志不计数（无法做告警与回归）。
6. 在错误信息里带原始 stderr/凭据（违反 SEC-1）。
7. 为「看起来成功」把失败轮标成 completed（PLAN 反例 3 的变体）。

## 11. 验收断言（可执行）

| ID | 断言 | 证据 |
|---|---|---|
| FM-T1 | §2 表中每一行都有非空 `分类码`、`可重试`、`降级动作`、`用户可见提示` | 文档解析脚本（施工期 C10） |
| FM-T2 | 46 个 ABI 错误码全部能在 §2/§5/§8 找到归类或映射 | 表驱动测试（ABI-T7） |
| FM-T3 | 对 §9 的 15 个注入点，故障测试全部按预期状态机路径结束（无挂起、无双写） | `docs/test/*`（D8） |
| FM-T4 | 任意失败下父会话收到的 `userMessage` 非空且不含内部路径/token | 快照断言 |
| FM-T5 | 重试率与熔断指标可在故障注入中观测到 | 指标断言 |

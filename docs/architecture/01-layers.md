# 01 — 分层契约（L0–L5：职责 / 接口 / 不变量 / 降级）

> 本文是 `docs/architecture/00-overview.md` §4 的展开。每层给出四件事：**职责、对外接口、不变量（INV）、失败时的降级**。
> 事件名/方法名/错误码/能力位**只引用** `docs/abi/abi-v0.md`（§3 能力位、§6 方法、§7 事件、§8 错误码），不在此重复定义。
> 不写各后端原生字段映射（D5 写域），不写 DSH 插件配置（D6 写域）。

---

## L0 传输层（Transport）

### 职责

1. 进程/连接生命周期：spawn、握手前健康检查、优雅关闭、进程组 SIGTERM→SIGKILL 升级。
2. 帧：按绑定形态切帧（ACP/app-server = 逐行 JSON-RPC；SDK = in-process 回调；CLI = JSONL；opencode `http-api` = HTTP JSON + SSE `data:` 行），执行帧大小上限。
3. 请求关联：分配/回收 request id；匹配响应；丢弃未知/重复 id。
4. 超时与健康：每请求独立超时；心跳（`sys.ping` 或绑定等价物）；记录 last-frame-at / RTT。
5. 反向请求通道：把后端→客户端的请求（权限、`fs/*`、`terminal/*`、工具调用审批）交给 L1 注册的 handler，**默认 fail-closed**。
6. 背压：上行缓冲水位、下行写阻塞检测；超水位时通知 L1/L3 降级（丢弃可折叠帧，保留终态帧）。
7. 诊断：采集 stderr（脱敏）、连接状态、帧计数；**不得**把 stderr 原文当事件投递。

### 对外接口（L1 只依赖这 8 个原语）

| 原语 | 语义 | 失败返回 |
|---|---|---|
| `open(spec) -> Conn` | 启动/连接后端；`spec` 含绑定类型、二进制路径、cwd、env 白名单、权限档 | `transport.connect-failed` / `process.spawn-failed` |
| `request(conn, method, params, timeoutMs) -> Result` | 一次请求-响应 | `transport.timeout` / `protocol.*` |
| `notify(conn, method, params)` | 单向通知（无响应） | `transport.disconnected` |
| `onNotification(conn, handler)` | 订阅服务端推送 | — |
| `onReverseRequest(conn, handler)` | 注册反向请求处理器；**未注册 = deny** | handler 超时 → 自动 deny 并记 `policy.escalation-required` |
| `health(conn) -> Health` | `{state, lastFrameAt, rttMs, inflight, bytesIn/Out}` | — |
| `close(conn, reason)` | 幂等关闭；先 SIGTERM，N ms 后 SIGKILL 进程组 | — |
| `bindingCapabilities()` | 该绑定支持的能力（如是否支持双向请求、是否有 Content-Length、是否 SSE） | — |

### 不变量

| 编号 | 不变量 | 违反后果 |
|---|---|---|
| INV-L0-1 | 每个连接**只有一个写者**（单线程/单锁串行），禁止并发写 stdin。 | 帧交错 → 后端解析错乱 |
| INV-L0-2 | 每请求都有超时；禁止「无超时等待」。 | kimi 这类无内置超时后端会永久挂起（research kimi §3.9） |
| INV-L0-3 | 反向请求必须在 `reverseTimeoutMs`（默认 1500ms）内给出应答；无 handler 视为 deny。 | 挂起 → 整个 turn 卡死 |
| INV-L0-4 | 单帧 > `maxFrameBytes`（默认 1 MiB）拒绝并计数；连续 5 次坏帧升级为 `protocol.bad-frame`。 | 内存放大 / 被单条坏帧拖死 |
| INV-L0-5 | 进程组统一回收：子进程及其后代不得残留（按 pgid/pid + 启动 nonce 双重校验）。 | 僵尸进程、端口/文件锁泄漏 |
| INV-L0-6 | stderr/日志在进入任何上层之前必须脱敏（凭据模式、Authorization、password 键）。 | 凭据泄漏（`security.credential-leak-suspected`） |
| INV-L0-7 | L0 不解释业务语义：不判断会话状态、不重试业务错误、不做能力降级。 | 语义散落，ABI 失效 |

### 失败与降级

| 失败 | 检测 | 降级/动作 | 升级分类码 |
|---|---|---|---|
| spawn/连接失败 | 退出码/errno/连接拒绝 | 若有声明备通道则切换一次；否则 fail fast | `transport.connect-failed` |
| 连接 EOF / pipe 断 | read 返回 0 / ws close / 进程退出 | 通知 L1/L2 → 会话 `lost`，进入冷恢复 | `transport.disconnected` |
| 请求超时 | 定时器 | **不自动重发**（写操作可能已生效）；通知 L2 对账 | `transport.timeout` |
| 坏帧/未知 id | 解析失败 / id 不在 inflight | 丢弃 + 计数；连续坏帧重建连接 | `transport.frame-invalid` / `protocol.bad-frame` |
| 帧过大 | 长度检查 | 拒绝帧；若是事件则要求 L1 截断+artifact | `transport.frame-too-large` |
| 写阻塞/水位高 | 缓冲区水位 | 通知 L3 丢弃可折叠事件；保留终态 | `transport.backpressure` |
| 反向请求 handler 缺失/超时 | 注册表/定时器 | 自动 deny（fail-closed），turn 继续 | `policy.escalation-required` |
| 版本断言失败 | 握手比对 | 拒绝该绑定（不降级混跑） | `protocol.version-mismatch` |

---

## L1 适配器层（Adapter）

### 职责

1. **握手与能力声明**：跑原生握手（ACP `initialize` / codex `initialize` / SDK 启动），把结果翻译成 `CapabilityDeclaration`（34 个位，native/emulated/unavailable），并断言后端版本（abi-v0 §2.3）。
2. **方法与事件映射**：把 ABI 方法映射为原生调用；把原生通知映射为 ABI 事件（一次原生事件 → 0..N 个 ABI 事件；无法映射的丢弃并计数）。
3. **错误映射**：原生错误 → ABI 错误码；无法识别 → `internal.unexpected` + `details.backendCode`，**不得**返回裸文本。
4. **反向请求策略**：按会话的 `permissionProfile` 与 L5 策略应答权限/输入/`fs/*`；无人值守默认 deny。
5. **会话连续性实现**：`resume`/`fork`/`interrupt`/`close` 的原生实现选择（如中断优先原生，否则进程信号；续接优先 load/resume，否则报告 unavailable）。
6. **子会话归组**：把原生子代理事件按 `childSessionId` 归组（如 codex `collabAgentToolCall`、opencode `_meta child-session-updates`）。
7. **用量归一**：token/成本/时长 → `usage.updated`（拿不到就 `estimated:true`）。

### 对外接口（L2 视角，按会话粒度）

| 方法 | 语义 | 备注 |
|---|---|---|
| `probe(backendId, spec) -> CapabilityDeclaration` | 探测能力/版本（可缓存，带 TTL 与 spec 哈希） | 结果必须来自实测握手，不能来自文档 |
| `open(spec) -> AdapterSession` | 建立绑定并完成握手；返回 `backendSessionId?` | 若首轮未发，`backendSessionId` 可为 null |
| `send(input, opts) -> {turnId, nativeRef}` | 启动一轮 | 返回仅代表「已接受」 |
| `resume(backendSessionId, fromSeq, input?) -> ResumeResult` | 续接 | 不支持 → 返回 `state:"unavailable"`，由 L2 走降级（不抛异常） |
| `fork(backendSessionId, opts)` / `close()` / `respond(requestId, decision)` / `setMode()` / `setModel()` / `interrupt(turnId)` | 对应 ABI 方法 | 能力缺失时返回结构化 unavailable |
| `onEvent(cb)` / `onReverseRequest(cb)` | 事件与反向请求回调 | 事件必须已归一化 |
| `stats() -> {eventsEmitted, eventsDropped, nativeErrors}` | 适配器自监控 | 供 L5 指标 |

### 不变量

| 编号 | 不变量 |
|---|---|
| INV-L1-1 | **适配器不持有会话真相**：不决定 `state`，不分配 `seq/epoch`，不写 journal。 |
| INV-L1-2 | 只允许产出 abi-v0 §7 表中的事件名；**禁止透传原生事件名**。 |
| INV-L1-3 | 能力声明必须附实测证据（`detail`），`emulated` 必须写替代路径；未验证的能力一律 `unavailable`，不得乐观声明。 |
| INV-L1-4 | 每轮**恰好一个**终态事件（`turn.completed|failed|aborted`）；终态后不得再发该 `turnId` 事件。 |
| INV-L1-5 | 所有反向请求必须有确定性应答（默认 deny）；**不允许静默挂起**。 |
| INV-L1-6 | 任何日志/事件不得包含凭据（ABI SEC-1）；错误 `message` 必须脱敏。 |
| INV-L1-7 | 有界缓冲：内部队列超过 `adapterQueueMax` 必须丢弃可折叠事件并计数，不能无限增长。 |
| INV-L1-8 | 子会话事件必须带 `childSessionId`，不得混入父会话 `message.*`。 |

### 失败与降级

| 失败 | 检测 | 降级/动作 | 分类码 |
|---|---|---|---|
| 能力缺失（resume/fork/interrupt/multiTurn…） | 握手声明 | 返回 `unavailable`，由 L2 按 abi-v0 §3.5（R-1..R-19）处；**不报错** | 不抛；必要时 `capability.missing` |
| 原生方法不存在（-32601 / Method not found） | 错误码 | 标记该位 `unavailable`（本次会话内），走降级 | `protocol.unknown-method` |
| 认证失败 | 401/403/登录提示 | 立即停止该后端所有会话，避免重试风暴 | `auth.*` |
| 限流（429） | HTTP 429 / 错误体 | 透传 `retryAfterMs`，由 L2 退避 | `quota.rate-limited` |
| 挂起（无输出） | 心跳缺失 + 无事件 > `idleTimeoutMs` | 由 L0 探测 → L2 判 `lost` | `process.hung` |
| 进程崩溃 | 退出码/信号 | 发 `session.lost`（若轮次进行中），由 L2 恢复 | `process.crashed` |
| 上下文溢出 | 原生错误/stopReason | 发 `turn.failed` + 建议压缩/重开 | `quota.context-overflow` |
| 事件无法映射 | 未知原生事件 | 丢弃 + 计数 + 诊断（不伪造） | `abi.warning`（`session.warning`） |
| 无法中断 | 无原生中断 | 若 `processKillInterrupt` → 杀进程并标记；否则返回不可中断 | `capability.missing` / 成功降级 |

---

## L2 会话代理（Broker）

> Broker 是**唯一**的会话真相持有者。文档级状态机与恢复算法见 `docs/architecture/02-state-machine.md`，本节只给边界与不变量。

### 职责

1. **注册表与 id 映射**：`sess_id ↔ (backendId, backendSessionId, transport, epoch)`；映射是 journal 的物化视图，可重建；终态保留 tombstone。
2. **状态机**：唯一允许修改会话状态的组件；转移必须命中 02 文档的转移表（含守卫与副作用）。
3. **幂等账本**：`(scope, method, clientRequestId)` → intent/committed + 结果快照；重放返回缓存；同键不同载荷 → `session.conflict`。
4. **write-ahead journal**：`intent → 执行 → commit` 只追加；事件先落 journal 再投 L3（EV-6）。
5. **租约与 fencing**：单写者 actor；每次接管/恢复 `epoch+1`；旧 epoch 写操作拒绝、旧 epoch 事件丢弃。
6. **配额**：并发会话、并发轮次、嵌套深度、父会话增量预算；在 spawn 前校验。
7. **冷恢复编排**：`session.recover` 的探测/续接/分叉/重播种/终止策略与退避（02 §6）。
8. **孤儿与回收**：`queued`/`draining`/`blocked` 的超时回收；terminal 归档；orphan 隔离。

### 对外接口

| 类别 | 接口 | 说明 |
|---|---|---|
| ABI 方法 | `abi.negotiate`、`session.create/send/resume/interrupt/query/list/recover/close/fork/archive/respond/steer/setMode/setModel/subscribe/replay` | 见 abi-v0 §6；Broker 是这些方法的唯一实现方 |
| 事件入口 | `ingest(adapterEvent)` | 来自 L1；Broker 分配 `seq/epoch`、持久化、再转 L3 |
| 事件出口 | `publish(event)` → L3 | 只发已持久化事件 |
| 内部查询 | `lookup(sessionId)`、`snapshot(sessionId)` | 供 L3/L4/L5 只读 |
| 运维 | `reap(now)`、`rebuildRegistry()`、`repairJournal()` | 供 L5 控制面调用 |

### 不变量

| 编号 | 不变量 |
|---|---|
| INV-L2-1 | **单写者**：同一会话的写操作串行；同一会话最多一个进行中轮（turnLock）。 |
| INV-L2-2 | `seq` 在会话内严格 +1，跨 epoch 不重置；`epoch` 只增。 |
| INV-L2-3 | 任何对外的「已接受」应答，必须先有 journal 记录；未持久化不得 ack。 |
| INV-L2-4 | 状态转移只能走 02 文档转移表；terminal（completed/aborted/archived）不可回退。 |
| INV-L2-5 | 幂等：重复写请求不产生第二次后端副作用；结果可重放，窗口 ≥24h。 |
| INV-L2-6 | 配额在**副作用之前**校验；拒绝时不得留下半建状态（先 intent 后 spawn，失败则补偿 tombstone）。 |
| INV-L2-7 | 映射表损坏时**禁止猜测**：无法唯一匹配的会话隔离为 orphan，等待修复；不得挂到错误的后端会话。 |
| INV-L2-8 | 禁止「静默重启」：后端会话失效且无 reseed 授权时，必须进入 `aborted` 并上报，不得自动再花一次成本。 |
| INV-L2-9 | 事件必须先持久化再发布；发布失败不得回滚已持久化事件（重放补偿）。 |

### 失败与降级

| 失败 | 检测 | 降级/动作 | 分类码 |
|---|---|---|---|
| journal 写失败 | IO 错误 | 降级只读模式（拒绝新轮次），保留已提交结果 | `storage.write-failed` |
| 磁盘满 | ENOSPC | 暂停新任务；不删 journal；告警 | `storage.disk-full` |
| journal/快照损坏 | 校验和 | 截断到最后有效记录 → 重建映射 → 无法判定则 orphan | `storage.corrupt` / `session.mapping-corrupt` |
| 租约冲突（双写） | epoch 落后 | 旧写者退出；新写者 `epoch+1` 接管 | `session.conflict` |
| 后端恢复失败 | 探测/续接错误 | `resume → fork → reseed → abort`（按 02 §6）；不无限重试 | `session.resume-failed` / `session.invalidated` |
| 并发/嵌套超限 | 配额计数 | 排队（`queued`）或拒绝 | `limit.concurrency-exceeded` / `limit.nesting-exceeded` |
| 同会话并发发送 | turnLock | 拒绝并给 `retryAfterMs` | `session.locked` |
| 未知 sessionId | 注册表 miss | 返回 not-found + 最近列表 | `session.not-found` |

---

## L3 事件总线（Event Bus）

### 职责

1. **校验**：事件 schema、`seq` 连续性、`epoch` 新旧、`turnId` 终态唯一性。
2. **顺序**：按会话保序；跨会话不承诺全局序（只承诺因果：子会话终态不早于父会话结束）。
3. **去重**：按 `eventId` 去重；对 L4 至少一次投递。
4. **折叠/采样/限流**：把高频事件压成 `progress.folded`（上限见 abi-v0 §11.2），终态不受限。
5. **环形缓冲与重放**：每会话保留最近 N 条（默认 2048）与最近 M 字节（默认 8 MiB）；更早走 journal 重放。
6. **扇出与背压**：多订阅者（L4 父会话、L5 观测）；慢订阅者丢低优先级事件，不拖慢其它订阅者。
7. **告警信号**：gap、丢弃率、折叠比、背压次数 → L5 指标。

### 对外接口

| 接口 | 语义 |
|---|---|
| `ingest(event)` | 来自 L2（已持久化）；校验后进入会话流 |
| `subscribe(filter, fromSeq, handler) -> Subscription` | 订阅（父会话/子会话/backend/type 过滤）；断线重连带 `lastSeq` |
| `replay(sessionId, fromSeq, toSeq) -> Event[]` | 从环形缓冲/journal 重放 |
| `progressOf(sessionId) -> progress.folded` | 取当前窗口折叠结果（供 L4 增量） |
| `ack(subscriptionId, seq)` | 消费者确认；用于环形缓冲回收 |
| `stats() -> {ingested, dropped, folded, gaps, backpressure}` | 指标 |

### 不变量

| 编号 | 不变量 |
|---|---|
| INV-L3-1 | 每会话事件保序；不同会话之间不承诺顺序。 |
| INV-L3-2 | 终态事件**永不被折叠丢弃**；折叠上限只作用于中间态（abi-v0 §11.1）。 |
| INV-L3-3 | 折叠必须**确定性**：同输入窗口 → 同输出（可重放、可测试）。 |
| INV-L3-4 | 内存有界：环形缓冲满时丢最旧（已 ack 优先），并记 `dropped`；不得 OOM。 |
| INV-L3-5 | 丢弃必须计数并分类（`dropped.kinds`），L5 可观测；静默丢弃禁止。 |
| INV-L3-6 | `epoch` 更旧的事件直接丢弃（EV-3）；发现 gap 时标记 `resync-required`，由订阅者调 `replay`。 |
| INV-L3-7 | 父会话增量只从 `progress.folded` 产生，且满足 abi-v0 §11.2 的全部上限。 |

### 失败与降级

| 失败 | 检测 | 降级/动作 | 分类码/信号 |
|---|---|---|---|
| 消费者慢 | ack 滞后 / 队列水位 | 丢弃低优先级；保留终态；告警 | `transport.backpressure`（语义借用）+ 指标 |
| 事件风暴（token 级） | 单会话事件率阈值 | 折叠窗口缩短到最小 1s，再超则丢弃 | 指标 `foldRatio` |
| 环形缓冲溢出 | 容量 | 丢最旧、标记需 replay | 指标 `ringOverflow` |
| gap | seq 不连续 | 通知订阅者 replay；无法补齐则 `session.warning` | `session.warning` |
| 父会话增量失败（载体拒收） | L4 返回失败 | 转 artifact/摘要指针（L4 决定载体），不重试风暴 | `transport.backpressure` |
| 折叠器异常 | 内部错误 | 退化为「只发终态」模式 | `internal.unexpected` + 降级标记 |

### L3 → L4 父会话增量策略（BRIEF 硬约束 3 的落地规则）

> ABI 只冻结 `progress.folded` 对象与上限字段（`docs/abi/abi-v0.md` §11）；**折叠算法在 L3**，**呈现载体在 L4**（D6 决定用工具返回值增量还是父会话摘要）。

| 规则 | 默认值 | 说明 |
|---|---|---|
| 关闭开关 | `parentProgress.mode = summary` | 取值 `off` / `summary` / `events`；`off` 时仍保留本地 journal 与查询能力，只是不产生父级增量；**终态永不受开关影响** |
| 采样窗口 | 5 s（滚动/整窗，窗口从「首个被折叠事件」开启） | 每窗口最多产出 1 条 `progress.folded`；窗口内新增事件只累加计数，不追加写入 |
| 单条上限 | 400 字符 | 超出截断 + `truncated:true`；摘要本身不再递归压缩 |
| 单轮总量上限 | 8 条 / 1200 字符 | 只约束中间态；终态（`turn.*`、`session.state-changed` 终态）走**旁路**，不占额度 |
| 丢弃优先级 | `message-delta` → `tool-progress` → `reasoning-delta` → `usage` → `diff` → `plan` → `child` → `state` | 从先丢到后丢；`error`/`result` **永不丢**；丢弃必须计数（`dropped:{count,kinds}`） |
| 合并规则 | 同类计数合并（`Read ×3`）、快照类取最新（plan/diff/usage）、`key` 相同跨窗口去重 | 折叠必须**确定性**（同输入 → 同输出），便于重放与测试 |
| reasoning | 默认不进父会话 | `includeReasoning=false`；需要时单独开关并计入同一预算 |
| 超额行为 | 达到单轮上限后：只发 1 条「已折叠 N 条」的收尾项，然后静默直到终态 | 禁止「边超边发」 |
| 背压 | 若 L4 载体拒收/超时：丢低优先级、保终态、记 `transport.backpressure` | 不重试风暴 |

**与 KV cache（只追加）的兼容方式**：

1. 每条增量是**新的追加消息**，`progressSeq` 单调递增；已发出的内容**不可编辑/撤回**（更正以新条目表达）。
2. 增量**自包含**（不依赖上一条才能读懂），字段顺序与 header 固定，尽量让父会话前缀稳定以提高 cache 命中。
3. **批量写入**：只在窗口边界写一次，绝不 per-token / per-event 写父会话。
4. 关闭或降级只影响**未来**追加，不回滚历史；终态结果始终作为最后一条追加。

**验收断言**（施工 C3/C9）：任一 30s 轮次的父会话增量满足 `items ≤ 8 && chars ≤ 1200`；`mode=off` 时中间态为 0 条但终态与结果完整；同一事件流重放两次产出 byte-level 相同的折叠结果。
---

## L4 DSH 接入层（DSH Adapter）

> 本节只定义**边界与不变量**；seam 改造/旁路插件路线、配置项、启用步骤、UI 数据面均属 `docs/integration/*`（D6），不在本文展开。

### 职责

1. **投影**：把 ABI 方法投影为 DSH 可调用的工具/Provider；把 DSH 的 start/delivery 语义映射到 ABI `session.create`/`session.send`（`delivery: caller|parent`）。
2. **能力边界执行**：遵守 DSH seam 对外部后端的硬限制（外部条目 `NO_START_CAPABILITIES` 全 false）；不得谎报 `agentOptions/agentPreset/outputSchema/depthLimit`。
3. **父会话增量**：消费 `progress.folded`，按载体（工具返回值增量 / 父会话摘要）投影；**只追加**，遵守 abi-v0 §11 上限。
4. **错误呈现**：把 ABI `error.userMessage` 呈现给上层；不得把后端原始报错直接抛给用户。
5. **生命周期**：DSH 会话结束/取消时，按策略 close/archive 对应 ABI 会话；DSH 重启后通过 `session.list/query` 重连（P2）或标 `lost`（P1）。

### 对外接口（消费方契约）

| 方向 | 内容 |
|---|---|
| 调用 ABI | `session.create/send/resume/interrupt/query/list/recover/close`（禁止绕过 ABI 直连 L1/L0） |
| 消费事件 | `session.state-changed`、`turn.*`、`progress.folded`、`permission.*`、`child.*`、`diagnostic.log` |
| 产生 | DSH 工具调用/结果、父会话增量、用户可见错误文案 |
| 禁止 | 自行分配会话 id、自行重试写操作、自行推断状态、按 backend 分支写业务逻辑 |

### 不变量

| 编号 | 不变量 |
|---|---|
| INV-L4-1 | **一个 DSH 子代理 ↔ 一个 ABI `sess_id`**，一一对应；不得复用给不同能力档案。 |
| INV-L4-2 | 父会话只追加：任何增量不得改写已发出的前缀；不得逐 token 写入。 |
| INV-L4-3 | L4 不持有会话真相；状态一律来自 `session.state-changed`/`session.query`。 |
| INV-L4-4 | 所有用户可见错误都必须来自 ABI `error.userMessage`（或更友好的包装），禁止透传后端 stderr。 |
| INV-L4-5 | 不谎报 DSH 能力位；DSH 不支持的能力（如外部后端 outputSchema）在映射层显式降级。 |
| INV-L4-6 | 重试写操作必须复用同一 `clientRequestId`（幂等），不得生成新键。 |

### 失败与降级

| 失败 | 降级/动作 | 用户可见 |
|---|---|---|
| 后端不支持 resume | 按 R-1：新会话 + 交接摘要（若可用），或返回「不可续接」+ 保留结果 | 明确提示「续接转换为新会话」 |
| DSH 无进度通道 | 只用工具返回值增量（一期默认） | 不提示 |
| L3 折叠不可用 | 只呈终态 | 进度稀疏 |
| DSH 重启且无 P2 | 会话标 `lost`；恢复需上层显式 `session.recover` | 「会话可能中断，可尝试恢复」 |
| 权限被自动拒绝 | 呈现 `policy.permission-denied` 的 `userMessage` | 「操作被权限策略拒绝」 |

---

## L5 控制面（Control Plane）

### 职责

1. **配置**：配置 schema、默认值、热加载边界（会话内快照不可变）。
2. **策略**：权限档位（read-only/safe-auto/yolo）、沙箱/路径白名单、worktree 隔离要求、无人值守应答策略。
3. **配额**：并发、嵌套、预算、父会话增量上限、事件率；配额获取/释放幂等。
4. **能力注册表**：后端目录、能力快照（带 observedAt/证据）、版本矩阵。
5. **可观测**：指标（各层）、结构化日志、审计（谁在何时对哪个会话做了什么）。
6. **运维**：reap（回收僵尸/超时）、archive、orphan 修复、journal 修复、后端熔断开关。

### 对外接口

| 接口 | 语义 |
|---|---|
| `config.load()/reload(scope)` | 加载/热加载；非法配置 → fail closed |
| `policy.evaluate(action, ctx) -> allow|deny|escalate` | 权限/路径/档位判定 |
| `quota.acquire(kind, n) / release(kind, n)` | 配额；release 幂等 |
| `registry.snapshot(backendId) -> CapabilityDeclaration` | 能力快照 |
| `metrics.emit(name, tags, value)` | 指标（非阻塞、有界） |
| `audit.append(record)` | 审计（只追加、脱敏） |
| `admin.reap(now)` / `admin.repair(sessionId)` / `admin.breaker(backendId, open|close)` | 运维 |

### 不变量

| 编号 | 不变量 |
|---|---|
| INV-L5-1 | 会话创建时对配置做**不可变快照**；热加载只影响新会话。 |
| INV-L5-2 | 安全默认 fail-closed：策略引擎不可用 → deny；配置非法 → 拒绝启动。 |
| INV-L5-3 | 指标/日志/审计**禁止**包含凭据；脱敏在产生侧完成（不能指望下游）。 |
| INV-L5-4 | 审计只追加；删除/归档留 tombstone 与操作者。 |
| INV-L5-5 | 配额 release 幂等；超卖只能发生在 `concurrencyControl=unavailable` 的已知降级路径，并计数告警。 |

### 失败与降级

| 失败 | 降级/动作 |
|---|---|
| 配置非法 | 拒绝启动（fail-fast），打印校验错误，不进入半配置状态 |
| 指标后端不可用 | 本地有界缓冲 + 丢弃最旧；不影响数据面 |
| 策略引擎异常 | deny all（fail-closed），告警 |
| 审计写失败 | 阻断高危动作（yolo/写入），只读动作继续 |
| 注册表陈旧 | 会话创建前强制重新 `probe`（带缓存 TTL 与 spec 哈希） |

---

## 6. 跨层契约

### 6.1 允许的调用关系

| 调用方 ↓ / 被调方 → | L0 | L1 | L2 | L3 | L4 | L5 |
|---|---|---|---|---|---|---|
| L0 | — | 回调 | 事件 | — | — | 指标 |
| L1 | ✔ | — | 方法/事件 | 事件（经 L2） | — | 诊断 |
| L2 | — | ✔ | — | 发布 | — | 策略/配额/指标 |
| L3 | — | — | 只读查询 | — | 投递 | 指标 |
| L4 | ✘ | ✘ | ✔（仅 ABI） | ✔（订阅） | — | 配置 |
| L5 | 运维关闭 | 运维 | 运维/只读 | 只读 | — | — |

**禁止**：L4 直连 L1/L0；L1 直接改状态；L3 回写业务状态；L0 做业务重试。

### 6.2 错误在哪一层分类、在哪一层重试

| 阶段 | 层 | 行为 |
|---|---|---|
| 原生错误出现 | L1 | 映射为 ABI 错误码（唯一分类点）；无法识别 → `internal.unexpected` + `backendCode` |
| 是否需要重试 | L2 | 只对 `retryable ∈ {once,backoff,after-recovery}` 且**幂等安全**的操作重试；写操作先对账 |
| 是否降级 | L2 + L5 | 能力缺失走 abi-v0 §3.5；策略/配额走 L5 |
| 如何呈现 | L4 | 用 `userMessage`；不暴露内部细节 |
| 如何观测 | L5 | 指标 + 审计 + 结构化日志 |

### 6.3 事件生命周期（谁对什么负责）

```text
L1 归一化（原生 → ABI 事件，丢弃不可映射）
  → L2 分配 seq/epoch + journal 持久化（EV-6）
  → L3 校验/去重/折叠/缓冲 → 订阅者
  → L4 父会话增量（只取 progress.folded + 终态）
  → L5 指标/审计
```

### 6.4 新增一个后端（扩展点清单）

1. 只写 L1 适配器（实现 L0 原语之上的映射）+ 能力声明；
2. 若需要新事件/能力位 → 先改 `docs/abi/abi-v0.md`（MINOR），再加实现；
3. 若原生面缺失关键能力 → 在能力声明中如实标 `unavailable` 并在 §3.5 表补降级路径；
4. L2/L3/L4/L5 **零改动**；若必须改，说明抽象漏了，先补契约再改。

### 6.5 容量点（默认值，配置 schema 由 D6 落地）

| 项 | 默认 | 所在层 | 行为 |
|---|---|---|---|
| 单后端并发会话 | 8 | L2 | 超出 `queued` 或拒绝（`limit.concurrency-exceeded`） |
| 并发轮次 | 8 | L2 | turnLock + 全局计数 |
| 嵌套深度 | 2 | L2 | `limit.nesting-exceeded` |
| 单事件字节 | 256 KiB | L2/L3 | 截断 + artifact |
| 单帧字节 | 1 MiB | L0 | `transport.frame-too-large` |
| 父会话增量 | 8 条 / 1200 字符 / 轮 | L3/L4 | 折叠 + 丢弃优先级 |
| 环形缓冲 | 2048 事件 / 8 MiB | L3 | 丢旧 + replay |
| 轮次超时 | 30 min | L2 | `limit.turn-timeout` |
| 空闲超时 | 3 min | L0/L2 | `process.hung` 探测 |
| 租约 TTL | 30 s | L2 | lease 过期 → `lost` |

### 6.6 可观测性口径（最小集）

| 指标 | 类型 | 层 | 用途 |
|---|---|---|---|
| `mocl.sessions.active` | gauge（按 backend/state） | L2 | 容量与卡死发现 |
| `mocl.turns.duration_ms` | histogram | L1/L2 | 性能与时延 |
| `mocl.events.ingested` / `dropped` / `folded` | counter | L3 | 折叠比与丢弃率 |
| `mocl.errors` | counter（按 code/category） | L1/L2 | 失败画像（03 文档表格的数据源） |
| `mocl.retries` | counter（按 code/attempt） | L2 | 重试风暴检测 |
| `mocl.leases.conflicts` | counter | L2 | fencing/双写告警 |
| `mocl.journal.bytes` / `age` | gauge | L2 | 磁盘满预警 |
| `mocl.parent_progress.chars_per_turn` | histogram | L3/L4 | 父会话预算 |

### 6.7 分层反模式（禁止）

1. 在 L1 里改会话状态（会导致双真相）。
2. 在 L4 里按 backend 写 if/else 业务分支（抽象漏了）。
3. 在 L3 里做「是否继续/是否终止」的业务决策（总线只做流）。
4. 在 L0 里解析业务事件（传输不解释语义）。
5. 用「再发一次」处理超时写操作（必须先对账，见 03 §4）。
6. 把父会话增量做成逐 token 追加（违反 BRIEF 硬约束 3）。

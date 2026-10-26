# codex 适配器规格（D5a / L1 适配器）

> 本文件只写 **codex → ABI** 的映射与实现约束。ABI 定义一律引用 `docs/abi/abi-v0.md`（**唯一命名真源**），
> 不在此处重述事件/错误码/能力位/方法名；DSH 接入属 `docs/integration/*`（D6 写域），不在本文。
> 写域：本文件 + `docs/adapters/claude-code.md`。

| 项 | 值 |
|---|---|
| `backendId` | `codex` |
| `transport` | `app-server-jsonrpc`（ABI §4 绑定表） |
| 基线二进制（唯一） | `PATH` 上的 `codex`（解析为绝对路径后钉住）：`/Users/lakii2982/.nvm/versions/node/v24.18.1/bin/codex` → **`codex-cli 0.164.0`** |
| 旧载荷（待升级） | `~/.dsh/profiles/desktop/node_modules/@openai/codex*` = `0.153.4`（DSH 插件当前使用；**不得作为基线**，升级见 §1.2） |
| 上游契约 | `docs/abi/abi-v0.md`、`docs/research/codex.md`（下称 `R`）、`docs/research/capability-matrix.md`（下称 `M`）、`.astra/CONTEXT-DSH-SEAM.md`（下称 `C`） |
| 状态 | design-frozen（本文能力声明为**握手期应产出**的目标值；标 `[未验证]` 的断言留给 C4 用真实 turn 补测） |

**证据标记**：`[实测]` = 本机命令可复跑（`bash repro/probe-codex.sh`）；`[实测-本轮]` = 本次规格编写时的只读探测（复跑命令见 §12.3、原始输出见附录 A）；`[文档]` = 官方导出物/帮助文本；`[推断]` = 前两者推导、未直接执行。

**一句话架构**：`Broker(L2) → L1 codex 适配器 → L0 app-server-jsonrpc → codex app-server 进程（一个进程多线程）`。ABI 事件 = `ServerNotification` 直接映射 + 轮次/会话生命期推导，两者都写进 L2 journal 后才投递（ABI EV-6）。

---

## 1. 身份与版本

### 1.1 身份字段

| 字段 | 取值 | 证据 |
|---|---|---|
| `backendId` | `codex` | ABI `capabilities.json` 枚举 |
| `backendVersion` | `0.164.0`（来自基线二进制的 `--version`；旧载荷 0.153.4 **不是**本适配器的版本） | `R:9-20`、`repro/probe-codex.sh §1` `[实测]` |
| `transport` | `app-server-jsonrpc` | `R:76` `[实测]` |
| `nativeProtocolVersion` | `0.164.0/app-server-v2`（拼接式：二进制版本 + 协议导出目录 `codex_app_server_protocol.v2.schemas.json`） | 见 §2.3「无独立协议版本字段」 `[实测-本轮]` |
| `pinnedBinaryPath` | 基线绝对路径（注册表持久化；支持 `codex.binaryPath` 配置覆盖） | `R:9-20` |
| `protocolSchema` | `exportable`（`generate-json-schema`：**39 条目 = 37 JSON + `v1/`、`v2/` 两个子目录**；CI 期望 `ClientRequest=106` / `ServerNotification=85` / `ServerRequest=10`） | `R:22`、`R:196`、`probe §4` `[实测]` |

### 1.2 唯一基线 0.164.0 与旧载荷升级（**最容易踩的坑 #1**）

**R2 裁定：codex 以最新版为基线，老版本必须更新上来。** 本文只认 **0.164.0** 一个基线；`0.153.4` 是 DSH profile 内尚未升级的旧载荷，只作迁移对照。

| 角色 | 版本 | 证据 | 用途 |
|---|---|---|---|
| **基线（唯一）** | **0.164.0** | `codex --version` → `codex-cli 0.164.0`（`R:11-14`）`[实测]` | 适配器只连它；类型/契约/CI 期望值全取它 |
| 旧载荷（待升级） | 0.153.4 | `R:15-16` `[实测]` | 迁移对照；**不得**当基线、不得作为 schema/类型来源 |

**升级路径（二选一，推荐 A）**

| 路径 | 做法 | 说明 |
|---|---|---|
| **A：升级 profile 依赖（推荐）** | 在 `~/.dsh/profiles/desktop/package.json` 加 `pnpm.overrides`：`{"@openai/codex":"0.164.0","@openai/codex-darwin-arm64":"0.164.0"}` → `pnpm -C ~/.dsh/profiles/desktop install` → 重启 DSH | 插件对 `@openai/codex` 是**精确依赖** `0.153.4`（插件 `package.json` `[实测]`）；插件用 `require.resolve("@openai/codex/package.json")` 决定二进制（`lib/index.js:535`），**无配置项**可绕开 → 只能 override。`pnpm-lock` 里 `darwin-x64/linux-*` 旧平台包一并 override（本机只加载 darwin-arm64） |
| **B：适配器配置指向基线（仅兼容层）** | 本项目 L1 适配器 `codex.binaryPath` 指向基线绝对路径 | 只影响新兼容层；DSH 现有插件仍用 0.153.4 → 两套路径并存期必须显式声明用哪套 |

**升级验收（必须全过；前 3 条零额度）**

1. **两处 `--version` 一致**：`codex --version` 与 `~/.dsh/profiles/desktop/node_modules/@openai/codex-darwin-arm64/.../bin/codex --version` 同为 `codex-cli 0.164.0`（`probe-codex.sh §1` 打印 `版本一致性: SAME`）；
2. 0.164.0 能只读打开旧 rollout（`thread/read`，§12.4 A0）；
3. 插件所用三方法在 0.164.0 仍存在且同形：`thread/start`、`turn/start`、`turn/interrupt`（`probe §4` + 插件依赖检查 `probe §8`）；
4. 1 个真实 turn 冒烟（C4，消耗额度）。

**协议差异表（0.153.4 → 0.164.0，迁移参考；不作为双基线）** `[实测]`：

| 维度 | 0.153.4 | 0.164.0 | 差异 |
|---|---|---|---|
| `ClientRequest` | 99 | **106** | +8 / −1（删 `thread/rollback`） |
| `ServerNotification` | 81 | **85** | +4（`account/gatewayOAuth/changed`、`thread/attachment/updated`、`thread/prediction/updated`、`thread/readState/changed`） |
| `ServerRequest` | 10 | **10** | 无变化（8 现代 + 2 legacy） |
| v2 definitions | 622 | **668** | +48 / −2（删 `ThreadRollbackParams/Response`）、53 个同名定义变化 |
| `TurnStartParams` | 16 props | +`disabledPluginIds`,`parentTurnId`,`rootTurnId` | 纯增量可选 |
| `ThreadResumeResponse` | — | +`collaborationMode`,`disabledPluginIds` | 纯增量可选 |
| `Thread` 等响应 | — | +`disabledPluginIds`/`originator` | 纯增量可选 |
| 运行时独有（schema 未导出） | `server/diagnostics` | 再加 `userVerification/*`、`Thread.environments[]`、`thread/list.readStates` | 不得写进契约（§2.4） |

**基线规则（强制）**：

1. 注册表记录 `(binaryPath, version, schemaExportDir)`；启动只用基线路径，**不查旧载荷**；环境变量/配置只能指向基线版本，指向 0.153.4 → 拒绝启动（`protocol.version-mismatch`）。
2. 生成绑定类型只允许用基线导出物；CI 断言 `39 / 106 / 85 / 10`（漂移即失败，`probe §4`）。
3. rollout 跨版本混写是既成事实：本机 93 条中 `cli_version` = 0.163×64 / 0.162×5 / 0.153.4×2（`R:5`）。升级后冷恢复仍必须「先 `thread/read` 再 `thread/resume`」，失败降级为新建（§4.4）。
4. 旧载荷未升级期间，任何只在 0.153.4 上验证过的行为必须标注 `[legacy-0.153.4]`（例：`thread/archive` 在未 materialize 时的行为两版本不同，§2.4）。

### 1.3 版本断言（三个断言点，全部通过才 `versionPinning=native`）

| # | 断言点 | 期望 | 失败分类 |
|---|---|---|---|
| V0 | 启动前比对 profile 内旧载荷 `--version` 与基线 | 期望 `SAME`；`DIFF` → 记 warning「旧载荷未升级」并**禁止**把旧载荷当基线 | `session.warning{code:"legacy-payload-not-upgraded"}` |
| V1 | spawn 后执行 `<pinnedBin> --version` | `codex-cli 0.164.0` | `protocol.version-mismatch`（fail fast，不混跑） |
| V2 | `initialize` 响应的 `userAgent` 含 `0.164.0` | 见附录 A-1 实测串 | `protocol.version-mismatch` |
| V3 | `thread/start` 响应的 `thread.cliVersion` | `0.164.0` | `session.warning`（不阻断：历史 rollout 可能是旧版本写的） |

ABI `versionPinning` 位：`state=native`，`detail="V0 旧载荷一致性 + V1/V2/V3 三断言"`，`constraint="rollout cliVersion 可混写（R:5）"`；`CapabilityDeclaration.warnings[]` 至少含两条：「旧载荷 0.153.4 未升级前不得作为基线」「历史 rollout 由 0.162/0.163/0.164（及 2 条 0.153.4）写就」。

---

## 2. 启动与握手

### 2.1 传输通道选型：app-server JSON-RPC（为什么不选 `codex exec`）

| 通道 | 判定 | 依据 |
|---|---|---|
| **app-server JSON-RPC（选）** | 全量 `thread/*`+`turn/*`+`item/*` 通知；可**离线导出 schema**；支持 `stdio://`/`unix://`/`ws://`；`turn/interrupt`、`turn/steer`、10 个 method 的反向请求都在这个面上 | `R:76`、`R:49-52`、`R:196`、`probe §4` `[实测]` |
| `codex exec --json`（不选为主通道） | 只有 `--json` JSONL，**事件 schema 无离线导出命令**（`R:82`）；无 `thread/resume` 的等价控制面、无 `interrupt`、无反向请求应答通道 → 等于丢掉 ABI 的 `interruptTurn`/`steerTurn`/`permissionRequestBridge`/`tokenLevelStream` 四个位 | `R:82`、`R:70-72` |
| ACP（不选） | codex **没有** `acp` 子命令，产品面不存在该传输 | `M:36`、`probe §2` `[实测]` |
| `codex agents` / TUI（不选） | TUI 无 `--json`，不可脚本化；会话枚举走 `thread/list` | `R:74`、`R:127` |

**为什么 `exec --json` 只能是"救急而非主通道"**：它每次调用是一个**进程级**一次性执行，`resume` 只能靠再起一个进程 + `exec resume <id>`；期间拿不到权限反向请求（`approvals`），无人值守下遇到需审批动作只能整轮失败或降级；而 app-server 面有 10 个 method 的 `ServerRequest`（8 现代 + 2 v1 legacy，见 §7.2）可**逐条确定性应答**，这是 `permissionAutoReply=native` 的物理前提。

**切换成本（若未来被迫退回 `exec --json`）**：ABI 不变，只换 L0/L1 实现；但必须把 `resumeSession` 降为 `emulated`（进程级 `exec resume`）、`interruptTurn` 降为 `processKillInterrupt`、`steerTurn` 降 `unavailable`、`tokenLevelStream` 降 `unavailable`、`permissionAutoReply` 降 `unavailable`，并触发 ABI §3.5 的 R-1/R-3/R-6/R-15 四条降级路径——等于把一个 14✅ 后端降成 kimi 水平（`M:7` 的统计口径）。故不作为备选实现，只在 app-server 无法启动时**拒绝注册**该后端。

### 2.2 spawn 与进程模型

```bash
"$PINNED_BIN" app-server --listen stdio://
```

- **一个后端一个 app-server 进程**，进程内多线程（`thread/loaded/list` 可列，`[实测-本轮]`）；不为每个 ABI 会话起进程（每次冷启动都要重建连接与 10 个反向请求应答器，且 `thread/resume` 的价值被稀释）。进程崩溃的影响面 = 该进程内所有线程 → 统一走 §4.4 冷恢复。
- `cwd`：进程级 `cwd` 不重要（`thread/start` 每线程带 `cwd`）；但**必须**在 spawn 时设置 `CODEX_HOME`（生产默认 `~/.codex`；测试/隔离指到临时目录，见 §12.3）。
- **`CODEX_HOME` 必须已存在**（基线 0.164.0 行为变化）：目录不存在时 app-server **直接退出**：`Error: CODEX_HOME points to "…", but that path does not exist`（旧载荷 0.153.4 会自动创建，`[实测]`）。适配器**不得**替用户静默创建该目录（防止在错误路径初始化出假登录态），只校验并 fail fast（`storage.write-failed` 或 `auth.missing-credential`，按原因归类）；测试脚本先 `mkdir -p`。
- 基线启动 stderr 可能有一条**无害** warning：`could not create PATH aliases`（`CODEX_HOME` 指向非默认位置时出现，不阻断，只进 `diagnostic.log{debug}`）。
- `env`：只透传白名单变量（`HOME`/`PATH`/`CODEX_HOME`/代理相关），父进程敏感变量清洗（BRIEF 硬约束 5、`C:37` 的同款做法参照 claude 插件 `scrubbedParentEnv()`）。
- 帧：**newline-delimited JSON-RPC 2.0**（每帧一行 JSON，无 `Content-Length` 头）—— `[实测-本轮]` 按此写入即被接受；与 ABI §4 的 `acp-stdio` 行同形态，但**不得**因形态相同就复用 ACP 客户端（方法名空间完全不同）。

### 2.3 握手序列（含 ABI 三阶段握手的后端侧落点）

```text
L1 → codex : {"jsonrpc":"2.0","id":1,"method":"initialize",
              "params":{"clientInfo":{"name":"mocl-codex","version":"0.1"}}}
codex → L1 : {"id":1,"result":{"userAgent":"mocl-codex/0.164.0 (macOS; arm64) …","codexHome":"…",
              "platformFamily":"unix","platformOs":"macos"}}
```

- `InitializeParams` 必填只有 `clientInfo{name,version}`；可选 `capabilities{experimentalApi, optOutNotificationMethods, extensions…}`（`ClientInfo`/`InitializeCapabilities` 定义见导出物）。
- **没有独立的协议版本字段（ABI AB-V1 结论）**：`InitializeResponse` 只有 `userAgent`/`codexHome`/`platformFamily`/`platformOs`（v1 导出物 `InitializeResponse`，`[实测-本轮]` 抓真实握手）。`nativeProtocolVersion` 因此按 §1.1 拼接；不要伪造 `protocolVersion`。
- 运行时方法表里还有 `server/diagnostics`（`[实测-本轮]`：`thread/doesNotExist` 的报错把合法方法名列了出来），但**未出现在导出 schema** → 视为内部方法，不用于健康检查（见 §11.2）。
- 能力声明必须来自**本次**握手实测，禁止用文档粘贴（ABI SEC-5）。落盘形态（`capabilities.json` 校验通过）：

```json
{
  "abiVersion": "0.1",
  "backendId": "codex",
  "backendVersion": "0.164.0",
  "transport": "app-server-jsonrpc",
  "nativeProtocolVersion": "0.164.0/app-server-v2",
  "bits": [
    {"bit": "backgroundRuns", "state": "emulated", "detail": "app-server daemon 存在但生命周期由 Broker 托管"},
    {"bit": "childSessionUpdates", "state": "native", "detail": "collabAgentToolCall + subAgentActivity"},
    {"bit": "concurrencyControl", "state": "native", "detail": "运行时读取 config.agents.max_concurrent_threads_per_session / max_depth（本机当前 3 / 2，非默认值；读不到 fail-closed）"},
    {"bit": "diffUpdates", "state": "native", "detail": "turn/diff/updated + item/fileChange/patchUpdated"},
    {"bit": "forkSession", "state": "native", "detail": "thread/fork + lastTurnId"},
    {"bit": "handshakeVersion", "state": "native", "detail": "initialize.userAgent 含 0.164.0"},
    {"bit": "headless", "state": "native", "detail": "app-server stdio，无 TTY"},
    {"bit": "inputInbox", "state": "unavailable", "detail": "thread/queue/changed 只带 threadId，无可列/可取消队列"},
    {"bit": "interruptTurn", "state": "native", "detail": "turn/interrupt"},
    {"bit": "listSessions", "state": "native", "detail": "thread/list + thread/loaded/list"},
    {"bit": "modelRouting", "state": "native", "detail": "thread/start|turn/start 的 model/modelProvider/serviceTier"},
    {"bit": "multiTurn", "state": "native", "detail": "同一 thread 连续 turn/start"},
    {"bit": "nativeSubagents", "state": "native", "detail": "CollabAgentTool 9 值（multi_agent v1）"},
    {"bit": "permissionAutoReply", "state": "native", "detail": "10 类 ServerRequest 逐条预注册（§7.2）"},
    {"bit": "permissionModes", "state": "native", "detail": "AskForApproval × ApprovalsReviewer × SandboxMode"},
    {"bit": "permissionRequestBridge", "state": "native", "detail": "ServerRequest 反向请求通道"},
    {"bit": "planUpdates", "state": "native", "detail": "turn/plan/updated"},
    {"bit": "processKillInterrupt", "state": "emulated", "detail": "SIGTERM 后 thread/resume 接回（依赖 rollout 已落盘）"},
    {"bit": "resumeSession", "state": "native", "detail": "thread/resume（3 种方式）+ rollout"},
    {"bit": "sandboxModes", "state": "native", "detail": "SandboxMode 3 值 + SandboxPolicy"},
    {"bit": "sessionArchive", "state": "native", "detail": "thread/archive"},
    {"bit": "sessionDelete", "state": "native", "detail": "thread/delete"},
    {"bit": "sessionExport", "state": "emulated", "detail": "无导出方法；thread/read{includeTurns} + thread/turns/list 自建转写（items/list 未实现）"},
    {"bit": "sessionReseed", "state": "emulated", "detail": "新建线程 + seedSummary 注入首轮"},
    {"bit": "sessionUnarchive", "state": "native", "detail": "thread/unarchive"},
    {"bit": "steerTurn", "state": "native", "detail": "turn/steer（expectedTurnId 乐观锁）"},
    {"bit": "streaming", "state": "native", "detail": "14 个 item/* delta + turn/plan|diff/updated"},
    {"bit": "structuredProtocol", "state": "native", "detail": "generate-json-schema 39 文件"},
    {"bit": "tokenLevelStream", "state": "native", "detail": "item/agentMessage/delta"},
    {"bit": "tokenUsage", "state": "native", "detail": "thread/tokenUsage/updated"},
    {"bit": "toolExtension", "state": "native", "detail": "mcpServer/tool/call + plugin/* + skills/*"},
    {"bit": "usageReporting", "state": "native", "detail": "TokenUsageBreakdown + account/usage/read"},
    {"bit": "versionPinning", "state": "native", "detail": "V0/V1/V2/V3 四断言（§1.3）"},
    {"bit": "worktreeIsolation", "state": "emulated", "detail": "无协议方法；外层建 worktree 后以其 cwd 启动线程"}
  ],
  "limits": {"maxTurnMs": 1800000, "idleTimeoutMs": 120000, "maxSessionsPerBackend": 20,
             "maxNestingDepth": 2, "maxConcurrentTurns": 3},
  "warnings": ["旧载荷 0.153.4 未升级前不得作为基线（V0）",
               "历史 rollout 由 0.162/0.163/0.164 混写，冷恢复需先 thread/read 探测"],
  "observedAt": "2026-10-25T13:54:07.123Z"
}
```

> `limits` 的 5 个数字是**运行时派生快照**（本机：seam `subagent.maxActiveSubagents`=20、后端 `[agents].max_concurrent_threads_per_session`=3、`max_depth`=2），**不是默认常量**；派生规则见 §9.1。
>
> 34 个位必须**全部出现**（`capabilities.json` 的 `bits` 是数组，缺失位按 `unavailable` 处理会误触降级）；上例已按 `bit` 名排序并含 **34 位全量**（`capabilities.json` 可校验）。`inputInbox=unavailable` 与 `steerTurn=native` 并存是有意的：codex 能**转向**但**不能列/取消队列**（§9.3）。

### 2.4 schema ≠ runtime：启动时探测"运行时方法集"（**最容易踩的坑 #4**）

导出 schema 里有、运行时**没有实现**的方法会造成"设计上依赖了不存在的能力"。`[实测-本轮]`：

| 方法 | 导出 schema | 基线 0.164.0 运行时 | 结论 |
|---|---|---|---|
| `initialize` / `thread/start` / `thread/resume` / `thread/fork` / `thread/read` / `thread/list` / `thread/loaded/list` / `thread/archive` / `thread/unarchive` / `thread/unsubscribe` / `thread/delete` / `turn/start` / `turn/steer` / `turn/interrupt` / `config/read` | 有 | 有 | 可用 |
| `thread/turns/list` | 有 | **有条件**：未 materialize 时报 `-32600 thread … is not materialized yet; thread/turns/list is unavailable before first user message` | 首个 user message 之后才可用 |
| **`thread/items/list`** | **有** | **无**：`-32601 thread/items/list is not supported yet` | **禁止依赖**（item 级对账不可用） |
| `thread/archive`（未 materialize 线程） | 有 | **成功**（返回 `{}`）；`[legacy-0.153.4]` 旧载荷报 `-32600 no rollout found` | 归档不要求先落盘；**不得**把"archive 失败=未落盘"当判据 |
| `thread/unsubscribe` | 有 | `{status:"notLoaded"|"unsubscribed"}` | 两值都算成功，勿做枚举穷举 |
| `thread/read` / `thread/list` 响应 | 只导出 `Thread` 字段 | 额外带 `environments[]` / `readStates{}` | 运行时超集：解析时忽略未知字段（ABI §0 规则 5） |
| `server/diagnostics`、`userVerification/{status,enroll,delete,verify}` | **无** | 有（运行时方法表里有） | 不使用（未导出/账户面） |

→ 适配器在握手中做一次**运行时方法集探测**（只读、零额度）：`thread/loaded/list`（必通）、`config/read`（必通）、`thread/items/list`（探测结果记入 `CapabilityDeclaration.warnings[]`，并决定对账路径 §4.5）。**schema 只用于生成类型，不用于判断"能不能调"。**

**禁止依赖清单（基线 0.164.0 实测；`[legacy-0.153.4]` 标注为旧载荷对照；违反即运行期必然失败）**

| # | 方法/通道 | 实测事实 | 禁止方式 | 替代路径 |
|---|---|---|---|---|
| B1 | **`thread/items/list`** | 两版本导出物**有**、运行时 **`-32601 thread/items/list is not supported yet`** | 不得用于 item 级对账/审计；不得写进 C4 断言以外的成功路径 | `thread/read{includeTurns:true}` + materialize 后的 `thread/turns/list`（§4.5） |
| B2 | `thread/turns/list` | 未 materialize（首个 user message 之前）返回 `-32600 … not materialized yet` | 不得在首轮前调用；不得据此判断"无会话" | 先用 `thread/read`/`thread/loaded/list` |
| B3 | `thread/list` | 只返回**已落盘**会话；`thread/start` 后未产生 rollout 前不出现 | 不得把 `data:[]` 当"没有会话" | `thread/loaded/list`（内存中）+ rollout 路径（`thread.start` 响应） |
| B4 | `server/diagnostics` | 运行时方法表有（用于列合法方法），但**未出现在导出 schema** | 不作健康探针/契约依赖 | `thread/loaded/list`、`config/read` |
| B5 | `thread/*` 通知全集里的 `thread/realtime/*`、`thread/attachment/*`（基线新增）、`thread/prediction/*`（基线新增）、`thread/readState/*`（基线新增） | 客户端 UI/IDE/账户面，不属 turn 事件流 | 不得映射为 ABI 事件 | 丢弃 + 计数（§5.4 D3/D5/D10） |
| B6 | `codex exec --json` | 无 schema 导出、无反向请求通道、无 `turn/interrupt` | 不得作为主通道/契约源 | 仅救急（§2.1） |
| B7 | `CODEX_HOME` 不存在的目录 | 基线直接 fail：`Error: CODEX_HOME points to "…", but that path does not exist` | 不得由适配器静默创建 | 先校验/由部署方创建；测试先 `mkdir -p`（§2.2） |


### 2.5 超时、心跳与重建

| 项 | 值 | 理由 |
|---|---|---|
| 单请求超时 | 30 s（`thread/*`、`turn/interrupt`、`turn/steer`） | ABI §4「超时是传输层义务」 |
| `turn/start` 接受超时 | 30 s（只等"已接受"，不等结果） | ABI M3：同步只表示已接受 |
| 空闲判定 | 120 s 无任何帧且无进行中轮 → `transport.timeout` 探测 | 与 `limits.idleTimeoutMs` 一致 |
| 健康探针 | `thread/loaded/list {}`（轻、只读、`[实测-本轮]`） | 不用 `server/diagnostics`（未导出，§2.3） |
| 坏帧 | 单帧丢弃 + 计数；连续 5 帧 → `protocol.bad-frame` + 重建连接 | ABI §4 三条要求 |
| 重建后 | 所有 `loaded` 线程→`lost`；`thread/resume` 接回（§4.4） | 进程内状态丢失，rollout 是唯一真相 |

---

## 3. 会话生命周期

### 3.1 建立（ABI `session.create`）

```text
L1 → codex : thread/start {cwd:"/abs/path", ephemeral:false,
                            approvalPolicy:"never"|"on-request"|"untrusted",
                            sandbox:"read-only"|"workspace-write"|"danger-full-access",
                            model?, modelProvider?, serviceTier?, developerInstructions?}
codex → L1 : {thread:{id:"01a1…", sessionId:"01a1…", ephemeral:false,
                      path:"…/sessions/2026/10/26/rollout-….jsonl", cliVersion:"0.164.0",
                      cwd:"/abs/path", status:{type:"idle"}}, model, modelProvider, sandbox, …}
```

- `thread.id` 即 `backendSessionId`（同时 `thread.sessionId` 与它相同；**同一 session 树**内子代理线程共享 `sessionId`，`Thread.sessionId` 字段语义见导出物）。适配器以 `thread.id` 作为唯一后端键。
- **必须显式 `ephemeral:false`**（省略时默认也是 `false`，`[实测-本轮]`，但显式写死防止未来默认值变化），理由见 §4.2。
- `thread/start` **不要求 `cwd` 存在，也不要求绝对路径**：`cwd:"relative/path"` 被静默解析为 `/private/tmp/relative/path`（相对 app-server 进程 cwd），`cwd:"/tmp/definitely-not-exist-xyz"` 直接接受（`[实测-本轮]`，附录 A-3）。→ **路径合法性必须由适配器自己校验**（§7.4），不能指望后端。
- 成功后落 `session.created`（payload `state=created` + `cwd`），随后把 `backendSessionId` 回填并落 `session.state-changed{created→running}`（ABI M2 的 `backendSessionId` 允许先 `null` 后回填）。
- **反直觉（`[实测-本轮]`）**：客户端发起的 `thread/start` **不会**产生 `thread/started` 通知（只看到 `remoteControl/status/changed`）。→ 会话建立必须**以 RPC 响应为准**，不得等通知。

### 3.2 一轮（ABI `session.send` / `session.resume`+input）

```text
L1 → codex : turn/start {threadId, input:[{"type":"text","text":"…"}],
                         clientUserMessageId?, model?, effort?, outputSchema?, approvalPolicy?, sandboxPolicy?}
codex → L1 : {turn:{id:"0199…", status:"inProgress", items:[]}}
然后：turn/started → (item/* 流) → turn/completed|…（终态恰一个）
```

- `turn.id` 是 UUIDv7（导出物描述）→ 作为 ABI `turnId`（`turn_` + ULID 由 Broker 生成，见 §5.1 的 id 映射约定）。
- **同一线程最多一个进行中轮**；并发 `turn/start` 由适配器用线程级 turnLock 拦截并返回 `session.locked`（不依赖后端报错）。
- `turn/start` 失败**不等于**会话失败：会话保持 `created/running`，只发 `turn.failed`（ABI M2 的失败语义，§6.2）。
- 幂等辅助：`TurnStartParams.clientUserMessageId` 会写入 `userMessage` 项的 `clientId`（`ThreadItem` 变体 `userMessage` 有 `clientId` 字段）→ 适配器把 ABI `clientRequestId` 放这里，崩溃后可用 `thread/read{includeTurns:true}`（materialize 后加 `thread/turns/list`）反查"这条输入是否已经进过后端"（§4.5；`thread/items/list` 未实现，§2.4）。

### 3.3 关闭 / 归档 / 删除

| ABI 方法 | codex 原语 | 幂等/注意 |
|---|---|---|
| `session.close`（M9） | `thread/unsubscribe {threadId}` → `{status:"unsubscribed"｜"notLoaded"}`（两值都算成功）；不删 rollout | 重复调用返回 `{closed:true,alreadyClosed:true}`，不发第二次 RPC |
| `session.archive`（M11） | `thread/archive`；`thread/unarchive` 反归档 | **基线允许未 materialize 归档**（返回 `{}`；`[legacy-0.153.4]` 旧载荷报 `-32600 no rollout found`，附录 A-2）→ 归档前是否落盘由策略决定，不要依赖版本相关行为 |
| *（ABI v0 无删除方法，只有 `sessionDelete` 位）* | `thread/delete` → `{}`（**未 materialize 也能删**，`[实测-本轮]`） | 真删后端；ABI 侧只走 M11 归档 + Broker tombstone。**不发明** `session.delete`：新增方法须 D4 走 MINOR（ABI §13.1） |
| 会话枚举 | `thread/list {cwd?,limit?,cursor?,archived?}` → `{data:[Thread],nextCursor}`；`thread/loaded/list` → 内存中线程 id | **未落盘线程不出现在 `thread/list` 里**（`[实测-本轮]`：`thread/list` 返回 `data:[]`，同刻 `thread/loaded/list` 有 id）；枚举权威仍是 Broker 注册表（M 的 `session-list` 对策列） |

### 3.4 状态映射（ABI `session.state-changed` 的唯一来源）

| codex 信号 | 判定 | ABI 会话状态 | 备注 |
|---|---|---|---|
| `thread/start` 成功 | 响应即事实 | `created` → `running` | 不发通知，见 §3.1 |
| `thread/status/changed` `status.type=idle` | 无进行中轮 | `running`（空闲） | `running` 是"会话可用"，不等于"有轮在跑" |
| `status.type=active` 且 `activeFlags` 含 `waitingOnApproval` | 有反向请求未答 | `awaiting-input` | `ThreadActiveFlag` 导出枚举 `waitingOnApproval`/`waitingOnUserInput` |
| `status.type=active` 且 `waitingOnUserInput` | `item/tool/requestUserInput` 挂起 | `awaiting-input` | 无人值守下应在应答后立即离开该态 |
| `status.type=systemError` | 后端自报系统错 | `blocked` + `error.code` | 若同时能确认进程存活 |
| 进程退出 / pipe EOF | 适配器判定 | `lost`（先发 `session.lost`） | 随后 `session.recover` |
| `thread/archive` 成功 | 响应即事实 | `archived` | 归档前先确认 rollout 存在 |
| 轮终态 | `turn.completed|failed|aborted` | **不改变会话状态** | 会话继续可发下一轮（`multiTurn=native`） |

不变量：`session.state-changed` 必须在引发它的业务事件**之后**发（ABI EV-5）；`turn.*` 终态恰一个（EV-4）。

---

## 4. 续接与恢复

### 4.1 `thread/resume` 的真实契约

`ThreadResumeParams` required 仅 `threadId`（13 个属性），导出物描述给出**三种续接方式与优先级**（`[实测]` 导出原文）：

1. **by `thread_id`**：从磁盘按 id 加载（推荐）；
2. **by `history`**：从内存历史实例化；
3. **by `path`**：按 rollout 路径加载。

> 非运行中线程优先级：`history > 非空 path > thread_id`（若用 history/path，`thread_id` 被忽略）；若 `thread_id` 指向**运行中**线程，app-server 会重新加入该线程，此请求里非空 `path` 只作一致性校验。**首选 `thread_id`**。

响应 `ThreadResumeResponse` 含 `thread`（含 `turns`）、`itemsBackwardsCursor`、`turnsBackwardsCursor`、`model`/`sandbox`/`approvalPolicy` 等回读值 → 适配器用它回填 `backendSessionId`、模型、沙箱与"已加载到哪一页"。

**续接的物理前提是 rollout 已落盘**（`R:112-117`：`~/.codex/sessions/**/*.jsonl`，首行 `session_meta.payload` 含 `session_id/parent_thread_id/cwd/cli_version/multi_agent_version`）。

### 4.2 `ephemeral:true` 必须改成持久线程（**最容易踩的坑 #2**）

- 现状：DSH 现有插件每次 `thread/start` 固定带 `ephemeral:true`，并且**断言返回值必须 ephemeral**（`C:47`、`R:123`：`if (thread.ephemeral !== true) throw`）。这不是"没实现续接"，是**主动拒绝**。
- 本文要求：`thread/start` 显式 `ephemeral:false`，**删除**该断言（改造点在适配器/L4，不在本设计阶段）。
- `[实测-本轮]` 已证明非 ephemeral 线程成立：响应 `thread.ephemeral=false`，并给出 `path=…/sessions/2026/10/25/rollout-…jsonl`、`cliVersion=0.164.0`、`historyMode=paginated`（附录 A-1）。
- **但**：**线程刚建、还没有任何 turn 时没有 rollout 文件**，此时 `thread/resume`/`thread/fork`/`thread/archive` 一律报 `-32600 no rollout found for thread id …`（`[实测-本轮]`，附录 A-2）。→ 适配器的建会话必须二选一：
  - **(A) 建会话即跑首轮**（`session.create` 带 `firstInput`）——推荐；
  - **(B) 懒持久化**：`session.created` 后标记 `backendSessionId` 但 `resumable=false`；**materialize 的判据 = 出现首个 user message**（此时 `thread/turns/list` 才可用、rollout 才落盘，`[实测-本轮]`）；此后置 `resumable=true`。期间崩溃只能 R-11（abort）或 R-1（reseed）。
- **`thread/resume` 没有 `ephemeral` 参数**（`ThreadResumeParams` 13 属性，`R:62`）→ 无法"resume 成持久"，只能"start 时就持久"。

### 4.3 fork

- `thread/fork {threadId, lastTurnId?}`，`lastTurnId` 描述为 *"Optional last turn id to fork through, inclusive"*（`R:62`）→ ABI `session.fork` 的"分叉点"直接用它。
- 同样受 rollout 约束（未落盘即 `no rollout found`，`[实测-本轮]`）。
- fork 出的线程 `forkedFromId` 回指源线程；`threadSource` 可标注来源。恢复策略把 fork 放在 resume 之后（§4.4），因为 fork 会新建 id、丢原会话连续性（ABI R-2）。

### 4.4 冷恢复阶梯（ABI M8 `session.recover`，策略 `auto`）

```text
1) 探测：thread/read {threadId}  → 有 thread 即后端认得；再 thread/turns/list 取最后轮状态
           thread/loaded/list    → 是否仍在内存（进程没死但连接断了）
2) 重连：重建 apps-server 连接 → initialize → 重新注册全部反向请求 handler（顺序不能反）
3) resume：thread/resume {threadId, cwd} → epoch+1；成功后 session.recovered{strategy:"resume"}
4) fork  ：thread/fork {threadId,lastTurnId}（调用方要求隔离时）
5) reseed：thread/start + 注入交接摘要（seedSummary）→ strategy:"reseed"
6) abort ：会话置 aborted，保留事件与 preservedThroughSeq（R-11）
任一步成功即停；尝试次数/耗时写入 recovery{attempt,strategy,replayedEvents}
```

判定细则：

| 观察 | 结论 | 动作 |
|---|---|---|
| `thread/read` 报 `no rollout found` | 从未持久化（§4.2 情形 B） | 跳过 resume → reseed（R-1） |
| `thread/read` 成功但 `status=systemError` | 后端认为线程坏了 | 先 `thread/read` 取历史 → fork 或 reseed |
| `thread/turns/list` 末轮 `status=inProgress` | 崩溃时轮未终结 | **不重放该轮**；标 `turn.failed{partial:true}`（`process.crashed`）→ resume 后开新轮 |
| `thread/turns/list` 末轮 `status=interrupted` | 已中断 | 补 `turn.aborted{interruptMethod:"process-kill"|"native"}` |
| 进程 `loaded` 但连接已重建 | 线程仍在内存 | `thread/read` 直接复用，不 resume（避免重复加载） |

### 4.5 幂等 / 去重（判定顺序：**先查产品侧，再决定重发/补读**）

**幂等键**：ABI `clientRequestId`（§9.1）。codex **本身没有幂等键**（`turn/start` 没有 `idempotencyKey` 类字段）→ 幂等只能"账本 + 产品侧事实核对"两层实现。

判定顺序（写死，避免"再来一次就恢复"的隐含假设，见 PLAN 反例 3）：

```text
① 查 Broker 幂等账本 (scope=sessionId, method, clientRequestId)
   ├─ state=committed → 直接回放 result，deduplicated=true，不碰后端（ABI §9.1-2）
   ├─ state=started   → 进入 ②对账（禁止盲目重发）
   └─ 无记录          → 进入 ②对账（判断是否"上次已送达但进程崩了"）
② 产品侧对账（只读，按代价从低到高；**只能用运行时确实可调的方法**）
   ├─ thread/loaded/list                 → 线程是否还在内存？
   ├─ thread/read {threadId}             → 线程是否存在（未 materialize 也可读）
   ├─ thread/read {includeTurns:true}    → turns[]/items[] 里是否已有 clientId == clientRequestId 的 userMessage
   ├─ thread/turns/list {limit:1}        → 仅 materialize 后可用；[未验证] 是否总能给出 clientId（C4 补）
   └─ thread/items/list                  → **不可用**（-32601 not supported yet，§2.4）→ 不得依赖
③ 决策矩阵
   ├─ 找到同 clientId 的 userMessage 且该轮已终态 → 视为已完成：补写 result + deduplicated=true
   ├─ 找到同 clientId 的 userMessage 且该轮 inProgress → 视为已接受：补 turn.started，等待终态（不重发）
   ├─ 线程存在但无该 clientId → 未送达：允许重发 turn/start（一次），重新把 clientId 写入
   └─ 线程不存在/rollout 缺失 → session.invalidated → 走 §4.4 的 reseed/abort
④ 同键不同载荷（requestHash 不符）→ session.conflict，不执行、不覆盖
```

三条场景的落地：

| 场景 | 判定与处置 |
|---|---|
| **重复发同一 prompt**（同 `clientRequestId`） | 只产生 1 个后端 turn（ABI ABI-T4 的 codex 版断言：`turn/start` 调用次数 == 1） |
| **重复发同一 prompt（不同 `clientRequestId`）** | **是两次请求**：codex 无内容去重，会产生两个 turn；适配器不合成、不静默丢弃，只在 `progress.folded` 里保留两条（避免上层误以为去重） |
| **turn 中途崩溃后重发** | 先 ②对账：末轮 `inProgress` → 不重发，标该轮 `turn.failed{partial:true,error.code:"process.crashed"}`，resume 后由调用方决定是否重发（新 `clientRequestId`）；若 `thread/read{includeTurns:true}` 的 turns[] 显示该轮已 `completed` → 用其中的 items 补生成 `message.completed`/`usage.updated`，再补 `turn.completed` |
| **映射表损坏**（journal 校验失败/threadId 冲突） | 产品侧能读出线程 → 以产品侧为存在性真源、journal 为 seq 真源重建映射（新 epoch，`replayedEvents=0` + `session.warning`）；product 侧读不出 → `session.mapping-corrupt`，隔离为 orphan，**不**尝试"猜"映射 |

### 4.6 最小可运行示例（Python / stdio JSONL；含安全脚手架）

> **变更说明（评审 F2 + R2）**：F2 版补的安全脚手架保持不动（① 继承真实 `CODEX_HOME` 且缺 `auth.json` 即 fail fast；② 读走 `queue + 超时`、超时 killpg 进程组；③ 10 个 `ServerRequest` 自动拒绝桩；④「验收预期」段）。R2 版只改**基线**：二进制改为基线 0.164.0（`MOCL_CODEX_BIN` 或 `which codex` 解析，**不再用 profile 旧载荷**）；并补 `CODEX_HOME` **必须已存在**的基线校验（0.164.0 对不存在目录直接 fail）。

```python
# codex_min.py — 建会话 → 一轮 → 续接（仅标准库；安全脚手架见上方变更说明）
import json, os, queue, signal, subprocess, threading, time
import shutil
BIN = os.environ.get("MOCL_CODEX_BIN") or shutil.which("codex")   # R2：基线 0.164.0，禁止用 profile 旧载荷
if not BIN:
    raise SystemExit("FATAL: 找不到基线 codex（PATH 无 codex；可设 MOCL_CODEX_BIN 指向 0.164.0 绝对路径）")
assert "codex-cli 0.164.0" in subprocess.run([BIN, "--version"], capture_output=True, text=True).stdout, \
    "FATAL: 基线版本不是 0.164.0（V1 断言失败）"
# ① 默认继承真实登录态；显式 CODEX_HOME 指向无 auth 的目录时立即失败，绝不静默降级
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
if not os.path.isdir(CODEX_HOME):                       # 基线 0.164.0：目录必须已存在，不由适配器创建
    raise SystemExit(f"FATAL: CODEX_HOME {CODEX_HOME} 不存在（基线要求先创建，见 §2.2）")
if not os.path.isfile(os.path.join(CODEX_HOME, "auth.json")):
    raise SystemExit(f"FATAL: {CODEX_HOME}/auth.json 不存在；请先 `codex login` 或显式指定已登录的 CODEX_HOME")
env = {**os.environ, "CODEX_HOME": CODEX_HOME}
p = subprocess.Popen([BIN, "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                     bufsize=1, env=env, start_new_session=True)   # 独立进程组：超时可整组杀
q, _seq = queue.Queue(), 0
threading.Thread(target=lambda: [q.put(json.loads(l)) for l in p.stdout if l.strip()],
                 daemon=True).start()

# ② §7.2 的 10 个 ServerRequest method：逐条自动应答；未知请求也回 error（fail-closed）
APPROVALS = {
    "item/commandExecution/requestApproval": {"decision": "decline"},
    "item/fileChange/requestApproval": {"decision": "decline"},
    "item/permissions/requestApproval": {"decision": "decline"},
    "item/tool/call": {"success": False, "content": []},
    "item/tool/requestUserInput": {"answers": {}},
    "mcpServer/elicitation/request": {"action": "decline"},
    "account/chatgptAuthTokens/refresh": None,     # None → 回 error：不伪造/不刷新用户凭据
    "attestation/generate": None,
    "applyPatchApproval": {"decision": "decline"},      # v1 legacy
    "execCommandApproval": {"decision": "decline"},     # v1 legacy
}
def send(o):
    p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()

def next_frame(timeout):
    try:
        return q.get(timeout=timeout)
    except queue.Empty:                            # ③ 任何读超时 → 杀进程组，绝不永久阻塞
        os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        raise TimeoutError("no frame; killed app-server process group")

def service(msg):                                  # 反向请求统一入口：没有 handler 也要回
    m = msg.get("method")
    if m in APPROVALS and APPROVALS[m] is not None:
        send({"jsonrpc": "2.0", "id": msg["id"], "result": APPROVALS[m]})
    else:
        send({"jsonrpc": "2.0", "id": msg["id"],
              "error": {"code": -32601, "message": f"mocl denies {m}"}})

def rpc(method, params, timeout=30):
    global _seq
    _seq += 1; rid = _seq
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    while True:
        msg = next_frame(timeout)
        if msg.get("id") == rid:
            return msg
        if msg.get("method") and msg.get("id") is not None:
            service(msg)                           # 反向请求：只应答，不混进响应流

def wait_turn_end(timeout=300):
    end = time.time() + timeout
    while time.time() < end:
        msg = next_frame(max(1, end - time.time()))
        if msg.get("method") and msg.get("id") is not None:
            service(msg); continue
        if msg.get("method") == "error":           # #36：失败细节必须可见，不再静默丢弃
            print("error-notification:", json.dumps(msg.get("params", {}), ensure_ascii=False)[:200])
        elif msg.get("method") == "turn/completed":
            return msg["params"]["turn"]
    raise TimeoutError("turn end timeout")

rpc("initialize", {"clientInfo": {"name": "mocl-codex", "version": "0.1"}})
tid = rpc("thread/start", {"cwd": os.getcwd(), "ephemeral": False,
                           "approvalPolicy": "never", "sandbox": "read-only"})["result"]["thread"]["id"]
print("thread:", tid)
turn = rpc("turn/start", {"threadId": tid, "input": [{"type": "text", "text": "只回复 OK"}]})["result"]["turn"]
print("turn:", turn["id"], "->", wait_turn_end()["status"])
print("resume:", rpc("thread/resume", {"threadId": tid, "cwd": os.getcwd()})["result"]["thread"]["id"])
p.terminate()
```

**验收预期**（评审 F2 强制项，施工 C4 逐条断言）：

1. **成功路径**（需可用模型基线）：stdout 依次出现 `thread: <uuid>`、`turn: <uuid> -> completed`、`resume: <同一 uuid>`，进程 rc=0、总耗时 <30s。
2. **本机已知限制**（评审实测：`gpt-6.1-sol` 对 ChatGPT 账号返回 `model_not_found`）：允许 `turn: … -> failed`，但必须先打印 `error-notification:`（含 `codexErrorInfo`），总耗时 <60s、**绝不挂死**。
3. **fail-fast**：`CODEX_HOME` 缺 `auth.json` → 启动前 `FATAL` 退出（非零），不静默改用空目录。
4. **超时可判定**：人为让后端不响应时，`TimeoutError` 必须在配置超时内抛出，且 `pgrep -f 'app-server --listen stdio'` 无残留进程。
5. **禁止依赖**：示例不以 `thread/items/list` 作为成功前提（基线 0.164.0 仍返回 `-32601 not supported yet`，见 §2.4 禁止依赖清单）。

---

## 5. 流事件映射

### 5.1 映射原则

1. **只映射 ABI §7 已定义的事件名**；原生名只出现在本表左列（ABI §0 规则 2）。
2. **信封字段由适配器生成**：`eventId`（ULID）、`seq`（会话内严格 +1，跨 epoch 继续递增）、`epoch`、`ts`（RFC 3339 UTC 毫秒）、`backend{id,version}`（ABI EV-1/EV-3、§5.2）。
3. `turnId` 用 ABI 形态 `turn_<ULID>`，与后端 `turn.id`（UUIDv7）**双向映射**并持久化（`session.mapping-corrupt` 的检测点之一）。
4. `messageId` 用后端 `itemId`/`item.id`（codex 的 `agentMessage`/`reasoning` 项都有稳定 `id`，`item/*/delta` 也带 `itemId`）→ 满足 `message.delta`/`message.completed` 的 `messageId` 必填（`event.json`）。
5. `toolCallId` 用 `itemId`（`commandExecution`/`fileChange`/`mcpToolCall`/`dynamicToolCall` 项的 `id`）。
6. **delta 与 completed 双发**：delta 可丢、completed 是权威文本（ABI §7.3）。二者用同一 `messageId` 关联。
7. 无法映射 → **丢弃 + 计数 + 记 `session.warning`**（`code:"adapter.event-dropped"`、`degrade:true`；这是会话级 warning code，**不是** ABI 错误码），绝不伪造事件（ABI §7 前言）。

### 5.2 主映射表（`ServerNotification` → ABI）

导出计数：`ServerNotification` **85 个（基线 0.164.0）**；旧载荷 0.153.4 为 81（差 4 类，见 §1.2）。计数口径按 `properties.method` 的 enum/const 取，**不再**用「含斜杠字符串」猜方法（旧稿因此漏计无斜杠的 `error`/`warning`/`configWarning`/`deprecationNotice`/`guardianWarning`，见 `repro/probe-codex.sh` §4）。下表覆盖产品在**一个普通 turn**里会出现的通知全集与关键退化通知。`payload` 列为 ABI 必填字段（以 `event.json` 为准）。

| # | codex 原始通知 | 关键字段（导出物） | → ABI 事件 | ABI payload | 映射规则/备注 |
|---|---|---|---|---|---|
| 1 | `turn/started` | `threadId`,`turn{id,status}` | `turn.started` | `model`,`delivery`,`inputDigest?`,`reasoningEffort?` | 收到 `turn/started` 才发（**不要**在 `turn/start` 响应处提前发，避免"已接受但未开始"误判）；`model` 取 thread/start 回读值 |
| 2 | `item/agentMessage/delta` | `itemId`,`turnId`,`threadId`,`delta` | `message.delta` | `channel:"assistant"`,`text:delta`,`granularity:"token"`,`messageId:itemId` | token 级；同一 `itemId` 的 delta 可被 L3 合并；`item/completed` 到时以完整 `text` 覆盖 |
| 3 | `item/reasoning/textDelta` | `itemId`,`contentIndex`,`delta` | `reasoning.delta` | `text`,`granularity:"token"` | 默认不进父会话（`parentProgress.includeReasoning=false`） |
| 4 | `item/reasoning/summaryTextDelta` | `itemId`,`summaryIndex`,`delta` | `reasoning.delta` | `text`,`granularity:"token"` | 与 #3 同型；用 `summaryIndex` 区分"摘要流"（落 `diagnostic.log` 的 `reasoningKind` 便于区分，不影响 ABI 字段） |
| 5 | `item/reasoning/summaryPartAdded` | `itemId`,`summaryIndex` | `reasoning.summary` | `text`（本段落累积文本） | 段落边界 → 发一次摘要；段落文本由适配器累积，不伪造内容 |
| 6 | `item/started`（`agentMessage`） | `item{type:"agentMessage",id}` | `message.started` | `channel:"assistant"`,`messageId:item.id` | 见 §5.6 schema 覆盖说明 |
| 7 | `item/started`（`commandExecution`/`fileChange`/`mcpToolCall`/`dynamicToolCall`/`webSearch`） | `item{id,type,…}` | `tool.started` | `toolCallId:item.id`,`name`（按 type 命名，如 `commandExecution`） | `kind` 填 `execute`/`write`/`read`/`mcp`/`web` 之一（自由短串，≤32） |
| 8 | `item/commandExecution/outputDelta` | `itemId`,`delta` | `tool.progress` | `toolCallId:itemId`,`text:delta` | 高频，折叠优先级最低（ABI §11.2 `dropPriority`） |
| 9 | `item/commandExecution/terminalInteraction` | `itemId,stdin` | `tool.progress` | `toolCallId`,`text` | 同上；无 `stdin` 内容时丢弃 |
| 10 | `item/mcpToolCall/progress` | `itemId`,`message` | `tool.progress` | `toolCallId`,`text:message` | 同上 |
| 11 | `item/fileChange/outputDelta` | `itemId`,`delta` | `tool.progress` | `toolCallId`,`text:delta` | 同上 |
| 12 | `item/fileChange/patchUpdated` | `itemId`,`changes[{path,kind,diff}]` | `diff.updated` | `files:[{path,status,additions?,deletions?}]`,`patch?` | **结构化来源优先**：`changes[].path/kind` → `files[]`；`diff` 全文超上限时只给 digest/artifact；`kind` 映射 `patch→modified`、`add→added`、`delete→deleted` |
| 13 | `turn/diff/updated` | `threadId`,`turnId`,`diff`（统一 diff 文本） | `diff.updated` | `files[]`,`patch?` | **需派生**：解析 `diff --git a/… b/…` 头得到 `files[]`（ABI 要求 `files` 必填）；与 #12 可能同时到 → 按 `(turnId, 文件集指纹)` 去重，保留信息更全的一条 |
| 14 | `turn/plan/updated` | `turnId`,`explanation?`,`plan:[{step,status}]` | `plan.updated` | `planId?`,`steps:[{id,title,status}]` | **全量快照**（ABI 要求非增量）；`step→title`，`id` 用索引派生（`p1..pn`，稳定不随状态变化）；`status` 映射 `pending→pending`、`inProgress→inProgress`、`completed→completed`（与 `TurnPlanStepStatus` 同名，见 §5.4） |
| 15 | `item/plan/delta` | `itemId`,`delta` | **丢弃** | — | 纯文本计划增量，ABI 的 `plan.updated` 要求结构化全量；已由 #14 覆盖（避免双源不一致） |
| 16 | `item/completed`（`agentMessage`） | `item{id,text,phase?,memoryCitation?}` | `message.completed` | `channel:"assistant"`,`text:item.text`,`messageId:item.id` | **权威文本**；超 `maxItemChars` 截断并置 `truncated:true`，全文进 artifact |
| 17 | `item/completed`（`reasoning`） | `item{id,content?,summary?}` | `reasoning.summary` | `text`（`summary` 拼接；无 summary 时用 content 首个摘要） | 一轮最多 1 条折叠进父会话 |
| 18 | `item/completed`（`commandExecution`） | `item{id,status,exitCode,aggregatedOutput,durationMs}` | `tool.completed` / `tool.failed` | `toolCallId,status,outputDigest,artifact?,truncated?` | `status` 映射见 §5.3；`exitCode!=0` → `status:"error"`（ABI `tool.completed` 的 `status=error`，不用 `tool.failed`：进程确实跑完了） |
| 19 | `item/completed`（`mcpToolCall`/`dynamicToolCall`） | `item{id,status,result?,error?}` | `tool.completed` / `tool.failed` | 同上 | `status:"failed"` → `tool.failed`；`readOnlyHint` 可填 `kind` |
| 20 | `item/completed`（`fileChange`） | `item{id,status,changes[]}` | `tool.completed` + 复用 #12 的 `diff.updated` | 同上 | 文件改动既有工具语义也有 diff 语义，**两事件都发**（消费者各取所需） |
| 21 | `item/completed`（`webSearch`） | `item{type:"webSearch",id,query,results}` | `tool.completed` | `toolCallId:item.id`,`status:"ok"`,`outputDigest` | 有真实外部查询语义，保留 |
| 22 | `item/completed`（`collabAgentToolCall`） | `item{tool,status,senderThreadId,receiverThreadIds[],agentsStates{}}` | `child.spawned` / `child.state-changed` / `child.completed` | 见 §6.2 | 原生子代理的唯一结构化来源 |
| 23 | `item/completed`（`subAgentActivity`） | `item{agentThreadId,agentPath,kind}` | `child.state-changed` / `child.completed` | `childSessionId`,`previousState`,`state` | `kind:started|interacted|interrupted|completed` |
| 24 | `thread/tokenUsage/updated` | `threadId`,`turnId`,`tokenUsage{last,total,modelContextWindow}` | `usage.updated` | `usage{inputTokens?,outputTokens?,reasoningTokens?,costUsd?,durationMs?}`,`estimated:false`,`scope:"turn"|"session"` | `last`→`scope:"turn"`（本通知带 `turnId`），`total`→`scope:"session"`；`costUsd` codex 不提供 → 省略（禁止编造） |
| 25 | `turn/completed` | `threadId`,`turn{id,status,error?,durationMs?,items[]}` | `turn.completed` / `turn.failed` / `turn.aborted` | `stopReason`,`usage` / `error`,`partial` / `interruptMethod`,`partial` | 终态恰一个（EV-4）；`status` 映射见 §5.3；`usage` 取自最近一次 #24（**必填**，缺失时发 `{estimated:true,scope:"turn"}` 占位） |
| 26 | `thread/status/changed` | `threadId`,`status{type,activeFlags?}` | `session.state-changed` | `previousState`,`state`,`reason` | 映射见 §3.4；`activeFlags` 决定是否 `awaiting-input` |
| 27 | `thread/started` | `thread` | `session.created`（仅当**非本客户端**发起，如 daemon 侧恢复出的线程） | `state`,`cwd` | 客户端 `thread/start` 不发此通知（§3.1），故正常路径不依赖它 |
| 28 | `thread/archived`/`thread/unarchived`/`thread/deleted`/`thread/closed` | `threadId` | `session.archived` / `session.state-changed` / `session.closed` | 按 ABI §7.1 | 外部（daemon/其他客户端）改动时同步本地状态 |
| 29 | `thread/name/updated` | `threadId`,`name` | `session.warning` 或丢弃 | — | 标题对 ABI 无信息量 → **丢弃 + 计数** |
| 30 | `model/rerouted` | `fromModel,toModel,reason,turnId` | `session.warning` | `code:"model-rerouted"`,`message`,`degrade:true` | 模型被后端切换必须让父级可见（否则成本/能力判断失真） |
| 31 | `turn/moderationMetadata` | `metadata` | **丢弃** | — | 无 ABI 语义；如需审计进 `diagnostic.log` |
| 32 | `autoApprovalReview/strictReviewRequired`、`item/autoApprovalReview/{started,completed}` | 审批自动评审内部态 | `session.warning`（仅 completed 且 **deny** 时） | `code:"approval-auto-review-denied"` | 与 `permission.resolved` 的 `by:"policy"` 配对；started 丢弃 |
| 33 | `account/rateLimits/updated` | `rateLimits{…}` | `session.warning` + 触发 `quota.rate-limited` 判定 | `code:"rate-limited"` | 见 §9.4 |
| 34 | `process/exited`/`process/outputDelta`/`command/exec/outputDelta` | 进程输出 | **丢弃** | — | 属 `command/exec` 工具面，不属 thread turn 事件流；仅进 `diagnostic.log`（debug 级） |
| 35 | `thread/realtime/*`、`mcpServer/event/stream/notification`、`fs/changed`、`fuzzyFileSearch/*`、`hook/*`、`skills/changed`、`plugin/*`、`app/*`、`account/*`（除 #33/#37）、`windowsSandbox/*`、`remoteControl/status/changed`、`thread/project/updated`、`thread/environment/*`、`thread/queue/changed`、`thread/goal/*`、`thread/settings/updated`、`thread/compacted`、`thread/reverted` | — | **丢弃（分类计数）** | — | 逐类理由见 §5.4/§5.5 |
| 36 | `error`（JSON-RPC 级 `ErrorNotification`：`message`、`codexErrorInfo?`）**不再丢弃** | `message`、`codexErrorInfo` | **`turn.failed`（主源）/ `session.warning`（诊断源）** | `error{code,message,partial}` / `code:"backend.internal-error"`,`degrade:true` | 若同轮尚无终态 → 发 `turn.failed`（`code` 按 §10.1 `codexErrorInfo` 映射；无映射则 `backend.internal-error`，ABI §8.2 MINOR 增补）；若该轮已有终态 → 只发 `session.warning`（补诊断，不改终态）。与 `turn/completed.error` 去重：**终态优先**，`error` 通知只补细节；同 `(turnId, code)` 只发一次 |

| 37 | `account/gatewayOAuth/changed`（基线新增） | `status…` | `session.warning` | `code:"auth-changed"`,`degrade:true` | 账户/网关认证态变化必须让上层可见（否则后续轮次失败会被误判为网络故障）；不含任何 token 内容（SEC-1） |
| 38 | `thread/attachment/updated`、`thread/prediction/updated`、`thread/readState/changed`（基线新增） | 附件元数据 / 输入预测 / 已读态 | **丢弃** | — | 客户端 UI/IDE / 账户面，不属 turn 事件流 → 丢弃 + 计数（§5.4 D10） |

> `thread/queue/changed` 只有 `{threadId}`（导出物确认）→ **无法**给出 ABI `turn.queued.queuePosition`，故丢弃并据此声明 `inputInbox=unavailable`（§9.3）。

### 5.3 枚举映射细则

| 源枚举 | 值 | ABI |
|---|---|---|
| `TurnStatus` | `completed` | `turn.completed{stopReason:"end-turn"}` |
| | `interrupted` | `turn.aborted{interruptMethod:"native"}`（进程级中断时填 `"process-kill"`） |
| | `failed` | `turn.failed{error:映射(§10.1),partial:<是否有 items>}` |
| | `inProgress` | 非终态（崩溃恢复时据此判"未终结轮"） |
| `TurnPlanStepStatus` | `pending`/`inProgress`/`completed` | 同名直通（ABI `plan.updated.steps[].status`） |
| `commandExecution.status` | `completed`+`exitCode==0` | `tool.completed{status:"ok"}` |
| | `completed`+`exitCode!=0` | `tool.completed{status:"error"}`（进程完成但失败） |
| | `failed`/`declined`/`interrupted` | `tool.failed` / `tool.completed{status:"denied"}` / `tool.failed`（`process.crashed` 不适用） |
| `CollabAgentStatus` | `running`/`pendingInit` | `child.state-changed{state:"running"}` |
| | `completed`/`errored`/`interrupted`/`shutdown`/`notFound` | `child.completed{status}`（详见 §6.2） |
| `CodexErrorInfo`（`TurnError.codexErrorInfo`） | 见 §10.1 逐值表 | ABI 错误码 |

### 5.4 无对应 → 丢弃 + 理由（逐类）

| # | 原生事件类 | 丢弃理由 | 计数维度 |
|---|---|---|---|
| D1 | `item/plan/delta` | 文本增量，ABI `plan.updated` 只收结构化全量；#14 已给全量 | `drop:plan-delta` |
| D2 | `thread/name/updated`、`thread/project/updated`、`thread/settings/updated`、`thread/section/*` | 元数据/展示层，ABI 无对应字段；会话 label 由 Broker 管 | `drop:metadata` |
| D3 | `thread/realtime/*`（sdp/audio/transcript 等） | 语音实时面，不属编码智能体语义 | `drop:realtime` |
| D4 | `fs/changed`、`fuzzyFileSearch/*` | 客户端文件浏览面（其实是 app-server 给 IDE 用的），不属于 turn 事件流 | `drop:fs-ui` |
| D5 | `hook/*`、`skills/changed`、`plugin/*`、`app/*`、`marketplace/*` | 扩展生命周期通知，无 ABI 事件；重要项转 `diagnostic.log` | `drop:extension` |
| D6 | `item/completed`（`sleep`/`imageView`/`enteredReviewMode`/`exitedReviewMode`/`contextCompaction`） | 无工具副作用可表达（`contextCompaction` 转 `session.warning{code:"context-compacted"}` 更合适，故**不全丢弃**） | `drop:item-noop` |
| D7 | `turn/moderationMetadata`、`item/autoApprovalReview/started`、`remoteControl/status/changed`、`windowsSandbox/*` | 内部/平台态，无 ABI 语义 | `drop:internal` |
| D8 | ~~`error` 通知（JSON-RPC 级 `ErrorNotification`）~~ | **已改为映射（#36）**：不再丢弃。旧处置只进 `diagnostic.log`，会让 turn 失败时父级只看到笼统终态、丢失 `codexErrorInfo` | `map:error-notif` |
| D9 | `thread/queue/changed` | 只有 `threadId`，无法填 `turn.queued.queuePosition` | `drop:queue` |
| D10 | `thread/attachment/updated`、`thread/prediction/updated`、`thread/readState/changed`（基线新增 4 类中的 3 类） | UI/IDE/账户面元数据，无 ABI 语义；`account/gatewayOAuth/changed` 已在 #37 映射为 warning，不在此列 | `drop:baseline-new-ui` |

> 丢弃率进指标（§11.3）：单轮丢弃事件数 / 总通知数，超过 30% 说明映射覆盖不足，需回看本节。

### 5.5 顺序与去重（生成侧不变量）

- 每个 `turnId` 内：`turn.started` 必须最先发；`turn.*` 终态之后**禁止**再发该 `turnId` 的任何事件（EV-4）。适配器用 turn 级 `closed` 标记丢弃迟到通知（迟到 = 终态后的 delta/completed，常见于中断竞态）。
- `item/completed` 与 `item/*/delta` 竞争：完成态后到达的 delta 丢弃（可丢，ABI §7.3）。
- `diff.updated` 双源（#12/#13）→ 同 turn 内按"文件集指纹 + 最大 `patch` 长度"保留最新一条（内容取并集，`seq` 不重复消耗）。
- `error` 通知（#36）与 `turn/completed.error` 竞争：**终态事件优先**；`error` 先到且终态未到 → 缓存，收到终态后合并成一条 `turn.failed`/`turn.completed`（禁止先发 `turn.failed` 再发 `turn.completed`）；同 `(turnId, code)` 幂等只发一次。
- `message.completed` 为权威：L3 折叠时可用它替代同 `messageId` 的全部 delta。

### 5.6 与 `docs/abi/schema/event.json` 的覆盖核对（已闭合）

`event.json` 已覆盖 ABI §7 的**全部 35 个事件变体**：`type.enum` 35 项、顶层 `oneOf` 35 个分支（15 个完整信封定义 + 20 个以 `payload_*` `$defs` 组合的内联分支），并通过 `abi-v0.md` §12.2 的结构自检（每个对象节点 `required` + `additionalProperties:false`）。因此本文映射表的目标事件**全部有 schema 变体**，不存在“schema 未覆盖即跳过”的缺口；`error` 通知映射到新增的 `backend.internal-error`（ABI §8.2 MINOR，见 ABI v0.1 变更记录）。若后续新增原生事件，顺序是：先改 `abi-v0.md §7`（MINOR）→ 再改 schema → 再进本表（ABI §13.1）。
---

## 6. 原生子代理与嵌套

### 6.1 产品能力（不是"拟支持"）

- `CollabAgentTool` 9 值：`spawnAgent, sendInput, resumeAgent, wait, closeAgent, sendMessage, followupTask, interruptAgent, listAgents`；`collabAgentToolCall` 是 `ThreadItem` 一等变体，字段 `agentsStates{threadId→{status,message}}`、`senderThreadId`、`receiverThreadIds[]`、`prompt`、`model`、`reasoningEffort`、`tool`、`status`（`R:54-56` `[实测]`）。
- 子代理是**独立持久化线程**：87 条 rollout 中 31 条 `thread_source=subagent`、82 条有非空 `parent_thread_id`（`R:116-117` `[实测]`）。
- 硬上限在配置层：`[agents] enabled=true, max_depth=2, max_concurrent_threads_per_session=3`（`R:89-96`）。
- **`multi_agent = stable true`，`multi_agent_v2 = stable false`**（`R:77`、`R:126` `[实测]`）；本机模型目录全部声明 `multi_agent_version: v1`（`R:78`）。→ **`multi_agent_v2=false` 不要当默认面**：适配器/文档/测试一律按 v1 语义；不得依赖 v2 才有的行为，也不要求用户开 `--enable multi_agent_v2`（V-CX-5 明确非一期目标）。`MultiAgentMode` = `explicitRequestOnly | proactive | {custom}`，由 thread/turn 参数传入，属"策略提示"而非开关。

### 6.2 事件映射（`collabAgentToolCall` → `child.*`）

| 原生信号 | 判定 | ABI 事件 | payload |
|---|---|---|---|
| `collabAgentToolCall.tool="spawnAgent"` 且 `status=inProgress` | 收到 `receiverThreadIds` 即登记子会话 | `child.spawned` | `childSessionId`（Broker 新建 `sess_*` 并与 `receiverThreadIds[i]` 建映射）、`nativeAgentId`（后端 threadId）、`name`（`prompt` 前 40 字摘要）、`depth=parent.depth+1` |
| `agentsStates[tid].status=running/pendingInit` | 状态推进 | `child.state-changed` | `childSessionId`、`previousState`、`state="running"` |
| `agentsStates[tid].status=completed` | 终态 | `child.completed` | `status="ok"`、`summary`（`message` 字段；无则省略） |
| `errored` | 终态 | `child.completed` | `status="failed"` |
| `interrupted`/`shutdown` | 终态 | `child.completed` | `status="aborted"` |
| `notFound` | 终态 | `child.completed` | `status="failed"`（`detail` 记 notFound） |
| `tool="wait"`/`"listAgents"`/`"sendMessage"`/`"followupTask"`/`"sendInput"`/`"resumeAgent"`/`"closeAgent"`/`"interruptAgent"` 的 `status` | 工具动作，不是子会话生命周期 | `tool.started`/`tool.completed`（`name="collab:"+tool`） | 不要为这些动作伪造 `child.*` |
| `item/completed`（`subAgentActivity`，`kind=started|interacted|interrupted|completed`） | 补充证据（有些运行时只发这个） | `child.state-changed`（interacted→`running`，interrupted→`running`+`session.warning`，completed→`child.completed`） | 与 `agentsStates` 去重：同一 `agentThreadId` 同状态只发一次 |

### 6.3 兼容层职责边界（只透传，不统一编排语义）

- ABI `nativeSubagents`、`childSessionUpdates` 声明为 `native`，但**只保证"看得见"**，不保证跨后端统一编排（`M:19` 对策列、`C:63`）。
- 子会话**必须登记为独立 ABI 会话**（`parentSessionId` 指向父、`rootSessionId` 指向根），才能复用 `session.query/subscribe/interrupt`；其 `backendSessionId` = 子线程 id。若子线程从未能被 `thread/read`（未落盘），则只发 `child.spawned`+`child.completed`，`subscribe` 返回 `capability.missing`（对应 ABI R-14）。
- 深度：`depth ≤ limits.maxNestingDepth`（默认 2，与 `[agents] max_depth=2` 对齐）。超限请求由 Broker 拒绝（`limit.nesting-exceeded`），**不**把 `max_depth` 调大去迎合调用方。
- 受 `[agents] max_concurrent_threads_per_session=3` 约束：同会话并行子代理 ≤3。适配器在 `child.spawned` 前计数，超限转 `session.warning{code:"product-concurrency-limit"}`（不阻断，因为决定权在模型）。

---

## 7. 权限与沙箱

### 7.1 三档语义映射（ABI 只认语义，禁止按名字透传）

| ABI `permissionProfile` | codex 参数组合 | 语义说明 | 风险 |
|---|---|---|---|
| `read-only`（默认） | `approvalPolicy:"never"` + `approvalsReviewer:"user"` + `sandbox:"read-only"` | 不需要审批（因为只能读），任何写/执行都会因沙箱被拒 | 最低 |
| `safe-auto` | `approvalPolicy:"on-request"` + `sandbox:"workspace-write"` + 全部反向请求自动应答（只放行 workspace 内读/写，执行需显式策略） | 有审批面，但适配器"代答" | 中（误放行=越权） |
| `yolo` | `approvalPolicy:"never"` + `sandbox:"danger-full-access"`；**必须**外层 worktree 隔离 | 全放行 | 高；缺 worktree → `policy.sandbox-violation`（ABI SEC-4） |

`ApprovalsReviewer` 三值 `user | auto_review | guardian_subagent`（`R:64`）：`auto_review` 是"让子代理评审审批请求"的产品能力，与 ABI `permissionAutoReply` 不等价——适配器自己的确定性命中表**优先**，`auto_review` 只作为兜底策略且需在 `CapabilityDeclaration.warnings[]` 声明"审批由后端子代理评审，可观测性有限"。

### 7.2 10 个 method 的 `ServerRequest` 自动应答（**最容易踩的坑 #3**：未注册即挂起）

无人值守必须**逐条预注册**；任何未注册的 `ServerRequest` 视为 fail-closed deny（ABI §4 要求 1、SEC-3、ABI-T8），**不允许"无 handler → 静默挂起"**。

| # | `ServerRequest.method` | 应答形状（导出物） | 无人值守策略 |
|---|---|---|---|
| 1 | `item/commandExecution/requestApproval` | `CommandExecutionApprovalDecision`: `accept`/`acceptForSession`/`acceptWithExecpolicyAmendment`/`decline`/`cancel` | `read-only`/`safe-auto` → `decline`（`cancel` 会连带中断 turn，仅在超时兜底用） |
| 2 | `item/fileChange/requestApproval` | `FileChangeApprovalDecision`: `accept`/`acceptForSession`/`decline`/`cancel` | 同上；`grantRoot` 请求一律 `decline`（不允许扩根） |
| 3 | `item/permissions/requestApproval` | `PermissionsRequestApprovalResponse`（权限档位/目录） | `decline`（不扩权限；对应 `policy.escalation-required`） |
| 4 | `item/tool/call` | `DynamicToolCallResponse`（客户端动态工具） | 无动态工具注册 → 返回结构化失败（`details.reason="no-dynamic-tools"`） |
| 5 | `item/tool/requestUserInput` | `ToolRequestUserInputResponse{answers:{qid→{answers[]}}}` | 无人值守 → `answers:{}` + `input.resolved{decision:"declined"}` |
| 6 | `mcpServer/elicitation/request` | `McpServerElicitationRequestResponse{action:"accept"|"decline"|"cancel", content?}` | `decline`；其中 `mode:"openai/form"` 分支同样 `decline` |
| 7 | `account/chatgptAuthTokens/refresh` | `ChatgptAuthTokensRefreshResponse` | 适配器不持有 token → 返回错误，触发 `auth.credential-expired`（**不**尝试刷新用户凭据） |
| 8 | `attestation/generate` | `AttestationGenerateResponse` | 返回错误（不伪造证明） |
| 9 | `applyPatchApproval`（v1 legacy） | `ApplyPatchApprovalResponse` | `decline`（旧版客户端才走这条） |
| 10 | `execCommandApproval`（v1 legacy） | `ExecCommandApprovalResponse` | `decline` |

> **口径修正（有证据）**：旧稿记"9 类 `ServerRequest`"（`R:63`；`docs/research/codex.md` §2 已按实测订正为 10 个 method），其清单把 `mcpServer/elicitation/request` 内部的 `mode:"openai/form"` 计为独立一类，同时漏掉了两个 v1 legacy 变体。基线 0.164.0 与旧载荷 0.153.4 的 `ServerRequest.json` **实测均为 10 个 method 变体**（`[实测-本轮]`，附录 A-4）。适配器按 **10 个 method** 注册应答器；对外表述可写"9 类现代 + 2 类 legacy（共 10 个 method）"，避免与调研文档的字面数字打架。

### 7.3 沙箱

- `SandboxMode` 三值 `read-only | workspace-write | danger-full-access`；`SandboxPolicy`（`writableRoots`/`networkAccess`/`excludeTmpdirEnvVar`）可细调（`R:64`、`R:192`）。适配器只允许在 `safe-auto` 下用 `workspace-write` + `writableRoots=[cwd]`，**禁止**自定义 `danger-full-access` 的 roots（全开就是全开）。
- 产品级沙箱是**OS 级**（`codex sandbox` 子命令存在，`R:192`）→ `sandboxModes=native`。
- `worktreeIsolation=emulated`：app-server 无"建 worktree"方法；由 L4/外层先建 worktree，再以该路径作 `thread/start.cwd`（ABI R-16）。

### 7.4 cwd/路径校验（后端不校验，适配器必须校验）

`[实测-本轮]` 证明后端**静默接受**相对路径与不存在的路径（附录 A-3）。因此 L1 在 `thread/start`/`thread/resume`/`turn/start` 前必须：

1. `os.path.isabs(cwd)`，否则 `policy.sandbox-violation`（ABI SEC-2：`cwd` 一律绝对路径）；
2. `cwd` 真实存在且是目录，且 realpath 落在允许根（worktree 根）内；
3. 拒绝符号链接越界（realpath 后再比较）；
4. `yolo` 档额外要求 cwd 是独立 worktree（`git rev-parse --show-toplevel` 与主仓不同），否则 `policy.sandbox-violation`。

---

## 8. 认证与模型路由

### 8.1 认证

| 项 | 事实 | 证据 |
|---|---|---|
| 认证面 | app-server 有 `account/read`、`account/login/start|cancel`、`account/logout`、`account/rateLimits/read`、`account/usage/read` | 导出 `ClientRequest` `[实测]` |
| 凭据位置 | `CODEX_HOME`（默认 `~/.codex`）下的 auth 存储；**本文不读取内容**，只检查存在性与 `account/read` 返回的登录态 | 纪律同 `R:98`、BRIEF §5 |
| 未登录 | `account/read` 表明未认证，或 `turn/start` 返回 `CodexErrorInfo.unauthorized` | `[推断]`（凭据态未实测，C4 补） |
| 交互式登录 | `account/login/start` 是**交互式**（浏览器/设备码）→ 无人值守**禁止**走；未登录即 `auth.login-required` + `blocked` | ABI §8 `auth.login-required` |

适配器**不缓存、不落盘、不打印**凭据；`diagnostic.log`/错误 `details` 命中凭据模式一律脱敏（ABI SEC-1、`security.credential-leak-suspected` 路径）。

### 8.2 模型路由

| ABI | codex 原语 | 生效粒度 |
|---|---|---|
| `session.create.model` | `thread/start.model` + `modelProvider` + `serviceTier` | 会话默认 |
| `session.setModel`（M15） | `turn/start.model` / `turn/start.effort` / `serviceTierForTurn` | **下一轮起**（`ThreadStartParams`→"this turn and subsequent turns"） |
| `reasoningEffort` | `TurnStartParams.effort`（`ReasoningEffort` 枚举） | 每轮 |
| 模型可用性 | `codex debug models` 15 个模型，含 `multi_agent_version`、`supported_reasoning_levels`（`R:78` `[实测]`） | 注册表缓存，`session.setModel` 前校验 |
| 不可用模型 | `model/list` / `debug models` 不在目录 → `auth.provider-mismatch`（fail fast，不重试） | — |
| 被后端改道 | `model/rerouted` 通知 → `session.warning{code:"model-rerouted"}` | 立即 |

`modelRouting=native`；`session.setModel` 的语义是"下一轮生效"，**已在跑的轮不受影响**（需要在 `result` 里写明，避免调用方以为立刻切）。子代理模型：`[agents] default_subagent_model`（配置级，见 `R:94`）——适配器不覆盖它，只在 `CapabilityDeclaration.warnings[]` 说明"子代理模型由用户配置决定"。

---

## 9. 限流与并发

### 9.1 并发模型（**一律按运行时值派生，禁止硬编码**）

适配器**不持有任何并发常量**。所有上限由 Broker 在 `adapter.open` / `session.create` 时从**运行时配置**联合派生（R2 裁定：并发一律按运行时值）。

| 运行时来源 | 读取方式 | 本机当前值（**示例，非默认值**） | 作用 |
|---|---|---|---|
| DSH seam `subagent.maxActiveSubagents` | 运行时读取 profile 的 `cordis.patch.yml` 中 `- id: subagent` 的 `config`（注入接口 `RuntimeConfigProvider`，与施工 C2 一致） | `20`（`~/.dsh/profiles/desktop/cordis.patch.yml`） | **外层硬上限**：同时活跃的后端子会话/后端进程总数 |
| codex 生效配置 `agents.max_concurrent_threads_per_session` | **优先**协议面 `config/read` → `result.config.agents.*`；**fallback** 只读解析 `~/.codex/config.toml` 的 `[agents]` | `3` | 单会话树内子代理并发 |
| codex 生效配置 `agents.max_depth` | 同上 | `2` | 单会话树嵌套深度 |
| `thread/loaded/list` | 协议运行时 | 动态 | 观测：进程内已加载线程数（发现超卖） |

**派生规则（写死、可单测）**

```text
seamCap        = subagent.maxActiveSubagents           # 运行时读取；读不到 → **fail-closed**（不派生、不启动适配器）
backendThreads = config.agents.max_concurrent_threads_per_session   # 运行时；读不到 → fail-closed
backendDepth   = config.agents.max_depth                            # 运行时；读不到 → fail-closed

maxSessionsPerBackend = min(configured ?? seamCap,        seamCap)            # 必须 ≤ seam 运行时值
maxConcurrentTurns    = min(configured ?? backendThreads, backendThreads,
                            maxSessionsPerBackend)
maxNestingDepth       = min(configured ?? backendDepth,   backendDepth)

配置缺省 = 跟随运行时（不写常量默认）
configured > 运行时值 → 取运行时值 + session.warning{code:"limit-clamped-to-runtime"}
```

**三条约束**

1. 三个上限的配置值**只能下调**，不得高于运行时来源值（ABI §3.2 `concurrencyControl`："后端声明并强制"）。
2. 运行时值变化（改 patch / `codex -c` 覆盖 / 升级后配置变更）→ **下一次** `session.create` 重新派生；已运行会话不重算（运行期不改语义，ABI §3.5 硬规则 2）。
3. **读取失败 ≠ 降级**：任一来源读不到（seam 配置缺失、`config/read` 返回 `agents:null`、TOML 无 `[agents]`）→ **fail-closed**：`adapter.open` 拒绝并返回 `capability.missing{missingBits:["concurrencyControl"]}`（施工 C2 要求"构造即 fail-closed"），**禁止**用文档/代码里的常量或本地信号量顶替（`.astra/LEDGER.md` D-016）。
   - 本轮实测：空 `CODEX_HOME` 下 `config/read` 返回 `"agents": null`（`[实测]`）→ 必须由部署方在 `~/.codex/config.toml` 或 `codex -c` 显式提供，或由 Broker 注入；不读真实 home 的一次实测留给 C4（避免触发 daemon/sqlite 写入）。

`concurrencyControl=native` 的依据是"产品有声明上限且可运行时读取"，**不是**任何固定数字；轮次时长仍取 ABI `limits.maxTurnMs`（ABI §11.2 契约默认值，不属本适配器的并发常量）。

### 9.2 排队

- Broker 侧队列（`activation=queued`）：进程内满负荷时 `session.send` 返回 `state=queued` 或 `session.locked{retryAfterMs}`（ABI M3 turnLock 语义）。
- **不做**产品侧排队：codex 的 `thread/queue/*` 只有变更通知、无入队/取消 API（§5.4 D9）→ `inputInbox=unavailable`（ABI §3.5 无该位的默认行为）。

### 9.3 转向 vs 队列（两个位分开声明）

- `steerTurn=native`：`turn/steer {threadId, expectedTurnId, input}`，`expectedTurnId` 是乐观锁（导出物描述：*"Required active turn id precondition. The request fails when it does not match the currently active turn."*）→ 适配器用它实现"运行中转向"，失败即 `session.conflict`（说明轮已换）。
- `inputInbox=unavailable`：无法列/取消队列 → 运行中"排队而非转向"的请求返回 `session.locked`，由调用方决定重试（ABI R-15 降级）。
- 被接受的转向发 `turn.steered{steerSeq}`（`seq` 内自增即可）。

### 9.4 限流与配额

| 信号 | 映射 | 处置 |
|---|---|---|
| `account/rateLimits/updated` | 更新本地配额快照；`status` 达阈值 → `session.warning{code:"rate-limited"}` | 不阻断已有轮 |
| `TurnError.codexErrorInfo=rateLimitExceeded` | `quota.rate-limited`（retryable=backoff，尊重 `retryAfterMs`，≤5 次） | 暂停该会话，其他会话可跑 |
| `usageLimitExceeded` | `quota.usage-exhausted`（retryable=no） | `blocked`，停止派发 |
| `sessionBudgetExceeded` | `limit.budget-exceeded` | 中断该轮并保留结果 |
| `account/usage/read` | 补 `usage.updated{scope:"session",estimated:false}` 的累计值 | 周期采样（≥30 s） |

> 429 的**具体形态**（HTTP 头/`error.data`）在本机未实测（ABI AB-V4）→ 上述映射对 `codexErrorInfo` 确定，对裸 429 先用"错误消息包含 rate/limit + 有 `retryAfter`"的保守判定，并记 `TO-VERIFY` 到 C4。

---

## 10. 失败与降级

### 10.1 JSON-RPC / `CodexErrorInfo` → ABI 错误码

`[实测-本轮]`（基线 0.164.0）的关键发现：**codex 把语义错误也用 `-32600` 返回，且方法名不存在时也是 `-32600`（不是 -32601）**。因此匹配必须 `code + message` 双条件，不能只按 code：

| 观察到的响应 | 实测原文摘录 | ABI 错误码 | retryable |
|---|---|---|---|
| `-32600` + `"unknown variant \`thread/doesNotExist\`"` | `Invalid request: unknown variant \`thread/doesNotExist\`, expected one of \`initialize\`, …` | `protocol.unknown-method` | no |
| `-32600` + `"no rollout found for thread id"`（`resume`） | `no rollout found for thread id 01a1…` | `session.resume-failed` → 降级 fork/reseed | 恢复重试 |
| `-32600` + `"no rollout found for thread id"`（`archive`/`fork`） | 同上 | `session.invalidated`（操作对象尚未持久化） | no |
| `-32600` + `"no active turn to interrupt"` | `no active turn to interrupt` | **不是错误**：按幂等处理，返回当前轮状态 + `deduplicated:true`（ABI M5） | — |
| `-32602` | 参数校验失败 | `protocol.invalid-params`（兼容层缺陷，带 traceId） | no |
| `-32603` | 后端内部错误（非兼容层缺陷） | `backend.internal-error` + `details.backendCode`（ABI §8.2 v0.1 MINOR；**不要**混用 `internal.unexpected`） | 幂等读 ≤1 次 |
| `-32601` + `"is not supported yet"` | `thread/items/list is not supported yet` | `capability.unsupported-method`（能力缺口，不是协议错） | no |
| `-32601`（其他） | 未知方法 | `protocol.unknown-method` | no |
| `-32600` + `"no active turn to steer"` | `no active turn to steer` | `session.conflict`（转向目标轮已不存在；调用方用 `session.send`） | no |

`TurnError.codexErrorInfo` 逐值映射（枚举来自导出物 `CodexErrorInfo`，`[实测]`）：

| `codexErrorInfo` | ABI 错误码 | 备注 |
|---|---|---|
| `contextWindowExceeded` | `quota.context-overflow` | 可降级：压缩/分叉/重开（视能力） |
| `sessionBudgetExceeded` | `limit.budget-exceeded` | 保留部分结果 |
| `usageLimitExceeded` | `quota.usage-exhausted` | `blocked` |
| `rateLimitExceeded` | `quota.rate-limited` | backoff，≤5 次 |
| `serverOverloaded` | `quota.rate-limited` | 语义最接近；`details.kind="serverOverloaded"` 保留原值；retryable=backoff |
| `cyberPolicy` / `misalignmentPolicyViolation` | `policy.permission-denied` | 后端安全策略拒绝；**不重试**，`details.codexErrorInfo` 留原值 |
| `unauthorized` | `auth.credential-rejected` | 不循环重试（防锁定） |
| `badRequest` | `protocol.invalid-params` | 适配器构造错误 |
| `threadRollbackFailed` | `session.resume-failed` | 回滚失败 → 降级 fork/reseed |
| `sandboxError` | `policy.sandbox-violation` | 沙箱拒绝执行 |
| `internalServerError` / `other` | `backend.internal-error` + `details.backendCode`（保留原 `codexErrorInfo`） | ABI v0.1 MINOR 已增补该码（§8.2/§13.3）；不再落到 `internal.unexpected` |

**用户可见文案**：一律用 ABI §8.2 表里的 `userMessage`（中文 ≤60 字），不把 codex 英文报错直出给用户；原文进 `diagnostic.log`（脱敏后）。

### 10.2 超时与中断阶梯

```text
轮时长 > maxTurnMs(1800s)
 → ① turn/interrupt {threadId,turnId}            （native，保留会话）
 → ② 3s 无 turn/completed → 现杀 app-server 进程（process-kill）
 → ③ session.recover：thread/read → thread/resume → 补 turn.aborted{interruptMethod:"process-kill",partial:true}
 → ④ resume 失败 → reseed（R-1，交接摘要）→ 失败即 aborted（R-11）
```

- 中断后**绝不重放**该轮（避免副作用重复；PLAN 反例 3）。
- `turn/interrupt` 对已结束轮返回 `-32600 no active turn to interrupt` → 按幂等成功处理（§10.1），不升级为故障。

### 10.3 不支持 + 兼容层兜底（明确清单，不是报错）

| # | codex 做不到的 ABI 能力 | 兜底（降级路径） | 父级可观测差异 |
|---|---|---|---|
| G1 | 无产品侧事件重放 API（`thread/replay` 不存在） | Broker journal 是唯一重放源；`session.replay` 只读 journal；断线补偿靠 `thread/read{includeTurns}` + `thread/turns/list` 重建**状态**而非事件 | `replayedEvents` 计数；补发事件 `seq` 连续但 `ts` 为补发时间？**不**——按 ABI EV-2 保留原 `seq/ts`，`eventId` 不变 |
| G2 | 无会话导出方法（无 `thread/export`） | `sessionExport=emulated`：`thread/read{includeTurns}` + 分页 `thread/turns/list` 拼转写，落 artifact | 导出为"尽力而为"，大历史分页可能缺尾（`itemsView` 字段会告警） |
| G3 | 无入队/取消队列 API | `inputInbox=unavailable`：运行中发送 → `session.locked`，由调用方排队（R-15） | 无即时排队反馈 |
| G4 | 无 OS 级 worktree 创建方法 | `worktreeIsolation=emulated`：外层建 worktree，`cwd` 传入；`yolo` 强制校验独立 worktree | 隔离责任在调用方（R-16） |
| G5 | `thread/start` 后无 rollout 前不可 resume/fork/archive | 二选一：首轮即跑（推荐）或懒持久化 + `resumable=false` 标记（§4.2） | 冷恢复只能 reseed/abort（R-1） |
| G6 | `multi_agent_v2` 关闭 | 只用 v1（`collabAgentToolCall`）；不提供 v2 语义 | v2 专属编排能力不可见 |
| G7 | ~~ABI v0 无 `backend.internal-error`~~ **已闭环**（D10 集成） | `-32603`/`internalServerError`/无法归类的后端内部错误 → `backend.internal-error`，`details.backendCode` 保留原值；`internal.unexpected` 仅用于兼容层自身缺陷 | 父级看到"后端内部错误"，`details` 可区分 |
| G8 | 成本（USD）不可得 | `usageReporting=native` 但只到 token 级；`usage.updated` 省略 `costUsd`；预算控制只用 token/时长 | 无金额门禁（R-9 的 codex 版：token 可硬控、金额不可） |
| G9 | `codex agents` 是 TUI | `listSessions` 走 `thread/list`/`thread/loaded/list`；`thread/list` 只列**已落盘**会话 | 未落盘线程不出现在枚举里（§3.3） |
| G10 | 无独立协议版本字段 | `nativeProtocolVersion` 拼接式 + 三断言（§1.3） | 版本漂移只能靠断言发现 |
| G11 | `thread/items/list` 未实现（schema 有、运行时 `-32601`） | 对账降级为 `thread/read{includeTurns}` + `thread/turns/list`（materialize 后）；item 级审计不可用 | 无法逐 item 核对，只能按 turn 粒度核对 |

### 10.4 失败模式表

| 触发 | 检测 | 分类码 | 动作 | 父级可见 |
|---|---|---|---|---|
| 二进制缺失/不可执行 | spawn `ENOENT`/`EACCES` | `process.spawn-failed` | 退避重试 ≤2 → 拒绝注册该后端 | 「后端可执行文件无法启动」 |
| 版本不符 | V1/V2 断言失败 | `protocol.version-mismatch` | fail fast，不混跑 | 「版本不匹配，已阻止启动」 |
| 握手 5s 无响应 | 读超时 | `transport.connect-failed` | 重建连接一次 | 「后端启动失败，正在重试」 |
| 连接中断但进程未报错 | pipe EOF / 心跳超时 | `transport.disconnected` | `session.lost` → 冷恢复 | 「连接中断，正在恢复会话」 |
| 自动化审批未注册 | 出现未注册 `ServerRequest` | （不应发生）兜底 `policy.escalation-required` | **立即** deny + 告警（fail-closed），不挂起 | 「需要人工批准，已拒绝」 |
| 轮超时 | 计时器 | `limit.turn-timeout` | §10.2 阶梯 | 「单轮超时，已中断并保留部分结果」 |
| 上下文溢出 | `codexErrorInfo=contextWindowExceeded` | `quota.context-overflow` | 压缩（`thread/compact/start`）或 reseed | 「上下文超出窗口，已尝试压缩/重开」 |
| 坏帧 | JSON 解析失败 | `transport.frame-invalid` | 丢弃 + 计数，连续 5 次 `protocol.bad-frame` 重建 | 「收到无法解析的消息，已隔离」 |
| 映射损坏 | journal 校验失败 | `session.mapping-corrupt` | 隔离 orphan，不猜 | 「会话映射损坏，需人工介入」 |
| 磁盘满 | journal 写失败 | `storage.disk-full` | 暂停新轮，保留内存态 | 「本地磁盘已满，已暂停新任务」 |

---

## 11. 可观测性

### 11.1 事件与诊断

| 输出 | 内容 | 约束 |
|---|---|---|
| `diagnostic.log` | `component:"adapter.codex"`，字段：`rawMethod`、`threadId`、`turnId`、`itemId`、`mappedType`、`dropReason`、`rpcId`、`durationMs`、`traceId` | 不含凭据/Authorization/明文密码（SEC-1）；路径按配置脱敏家目录（SEC-2） |
| `session.warning` | 能力 emulated、事件丢弃、模型改道、限流、审批自动评审拒绝 | 折叠后 ≤1/窗口（ABI §11.2 `maxItemsPerTurn`） |
| `transport.state-changed` | `connecting→ready→degraded→closed/failed` + `detail` | 每次重连 1 条 |
| 计数（内存 + 周期落盘） | `rpc.requests`、`rpc.errors`、`notif.total`、`notif.dropped{reason}`、`turn.count`、`turn.durationMs`、`turn.timeout`、`reconnect.count`、`approval.auto_resolved{tool}`、`child.max_depth` | 用于 §5.5 丢弃率阈值与 §10 失败率 |

### 11.2 健康与活性

- `sys.ping`（ABI M18）→ 适配器实现为 `thread/loaded/list {}`（轻、只读、`[实测-本轮]`），失败即 `transport.state-changed{state:"degraded"}`。
- **不用** `server/diagnostics`（未在导出 schema，§2.3）；不用 `--listen ws://` 做探活（多一层）。
- 会话级活性：`thread/read{threadId}` 取 `status`；轮级活性：最近一条 `turn/*` 通知时间戳。

### 11.3 折叠与上限（对齐 ABI §11）

- 高频事件优先级（从先丢起）：`tool.progress`（commandExecution outputDelta）> `message.delta` > `reasoning.delta` > `usage.updated` > `diff.updated` > `plan.updated` > `child.*` > 终态。
- 单轮 `tool.progress` 最多 1 条/5 s 窗口（L3 侧折叠；适配器仍按 ABI 全量发，L3 负责折叠——**适配器不自行丢事件**，只在背压时按 ABI §11.2 的 `dropPriority` 丢可折叠类）。
- 大输出：`commandExecution.aggregatedOutput` / `diff` 超 64 KiB → 存 artifact，事件里只给 `outputDigest`（sha256 前 16 hex）+ `artifact` 路径 + `truncated:true`（ABI §7.4 `tool.completed` 语义）。

---

## 12. 验收命令

### 12.1 上游证据复跑（只读、零额度、幂等）

```bash
cd /Users/lakii2982/项目/多智能体编排
bash repro/probe-codex.sh                    # 默认探测基线 0.164.0；退出码 0 = 基线断言全过
bash repro/probe-codex.sh --legacy           # 额外输出 0.153.4→0.164.0 迁移差异（对照用）
# 期望在 stdout 看到：
#  [1] 基线 0.164.0（唯一）+ 旧载荷 0.153.4 + `版本一致性: SAME|DIFF`
#  [2] 基线子命令面（含 app-server，无 acp）
#  [4] 基线断言：schema 条目=39 / ClientRequest=106 / ServerNotification=85 / ServerRequest=10
#  [4b] 运行时方法集：items/list=-32601、turns/list=not materialized、archive 可归档、相对 cwd 被接受
#  [5] [agents] 键名（并发/深度是运行时值）； [6] rollout 数与 cli_version 混写
#  [7] multi_agent_v2=false； [8] 插件钉的 @openai/codex 版本（升级检查点）+ ephemeral 断言
# 加 --legacy 才输出 [4c] 0.153.4→0.164.0 迁移差异（99→106 / 81→85 / 622→668 等）
```

### 12.2 文档闸门

```bash
python3 tools/check_docs.py adapters; echo "rc=$?"
# 本文件相关必须零 FAIL（kimi/opencode 缺失属另一片未完成，正常）
```

### 12.3 零额度握手 smoke（基线 0.164.0；`[实测-本轮]` 已通过；不写 `~/.codex`、不花额度）

```bash
cd /Users/lakii2982/项目/多智能体编排
CODEX_HOME=$(mktemp -d) python3 - <<'PY'
import json, os, shutil, subprocess
BIN = os.environ.get("MOCL_CODEX_BIN") or shutil.which("codex")   # 基线 0.164.0（不用 profile 旧载荷）
assert BIN, "找不到基线 codex"
assert "codex-cli 0.164.0" in subprocess.run([BIN, "--version"], capture_output=True, text=True).stdout
p = subprocess.Popen([BIN, "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
n = 0
def rpc(m, params):
    global n
    n += 1
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": n, "method": m, "params": params}) + "\n")
    p.stdin.flush()
    while True:
        msg = json.loads(p.stdout.readline())
        if msg.get("id") == n:
            return msg
init = rpc("initialize", {"clientInfo": {"name": "mocl-smoke", "version": "0.1"}})["result"]
assert "0.164.0" in init["userAgent"], init            # 断言 V2
st = rpc("thread/start", {"cwd": os.getcwd(), "ephemeral": False})["result"]["thread"]
assert st["ephemeral"] is False and st["cliVersion"] == "0.164.0", st   # 断言 V3 + 持久线程
assert st["path"].endswith(".jsonl")                    # 已分配 rollout 路径
res = rpc("thread/resume", {"threadId": st["id"]})      # 未 materialize 时必然失败，形态要稳定
assert res["error"]["code"] == -32600 and "no rollout found" in res["error"]["message"], res
tl = rpc("thread/turns/list", {"threadId": st["id"], "limit": 1})   # 未 materialize → not materialized yet
assert tl["error"]["code"] == -32600 and "not materialized" in tl["error"]["message"], tl
il = rpc("thread/items/list", {"threadId": st["id"], "limit": 1})   # schema 有、运行时未实现（基线仍如此）
assert il["error"]["code"] == -32601 and "not supported" in il["error"]["message"], il
ar = rpc("thread/archive", {"threadId": st["id"]})      # 基线行为：未 materialize 也可归档
assert "result" in ar, ar
print("OK", init["userAgent"], st["id"])
p.terminate()
PY
echo "rc=$?"
```

> 前置：`CODEX_HOME` 由 `mktemp -d` **先创建** —— 基线 0.164.0 对不存在的目录直接 fail（§2.2 / B7）。

### 12.4 C4 施工验收（**消耗额度**，1 个 turn；本文只列断言，不在设计阶段执行）

| # | 断言 | 命令/证据 |
|---|---|---|
| A0 | **升级门禁**：profile 旧载荷升到 0.164.0 后，两处 `--version` 一致；0.164.0 能只读打开旧 rollout（`thread/read`） | `bash repro/probe-codex.sh`（[1] `版本一致性: SAME`）+ 对一条 0.153.4 写的会话执行 `thread/read` |
| A1 | 非 ephemeral 线程 + 首轮成功，`~/.codex/sessions/**` 新增 1 条 rollout | `thread/start{ephemeral:false}` → `turn/start` → `find ~/.codex/sessions -newer …` |
| A2 | 同一 `threadId` 第二轮成功（`multiTurn`） | 连续两次 `turn/start`，两次 `turn/completed` |
| A3 | 干净退出后再 `thread/resume` 得到**同一** `thread.id`，且 `turns` 可读 | 重启 app-server → `thread/resume{threadId}` |
| A4 | `turn/interrupt` 在 3 s 内得到 `status=interrupted` | 长任务 + `turn/interrupt`，断言终态 |
| A5 | 10 个 `ServerRequest` method 全部注册后，`on-request` 档不出现挂起 | 在 `safe-auto` 下跑需审批命令，断言 2 s 内被自动 deny（ABI-T8） |
| A6 | 子代理：出现 `collabAgentToolCall(tool=spawnAgent)` 时产出 `child.spawned`，`receiverThreadIds` 与子线程 id 一致 | 显式要求"用子代理探索"的 prompt |
| A7 | `thread/tokenUsage/updated` → `usage.updated{scope:"turn"}` 的 token 数与终态 `usage` 一致 | 对比 `turn.completed.usage` |
| A8 | 同 `clientRequestId` 重放 `session.send`，`turn/start` 调用次数 == 1 | 录制/回放（ABI-T4） |
| A9 | materialize 后 `thread/turns/list` 可取到 `turns[]` 且 `userMessage.clientId == clientRequestId` | 首轮后调用 `thread/turns/list`（若不成立 → 对账只能降级到 `thread/read{includeTurns}`） |

> 本文全部 codex 调研证据由 `repro/probe-codex.sh` 复跑；上级事实基线见 `docs/research/codex.md`、`docs/research/capability-matrix.md`。

---

## 附录 A — 本轮零额度只读探测记录（基线 0.164.0，可复现）

环境：macOS arm64，**基线 codex `0.164.0`**（`shutil.which("codex")`），`CODEX_HOME=$(mktemp -d)`（先创建；不写 `~/.codex`），未发起任何 `turn/start`。命令：`bash repro/probe-codex.sh`（§4b 段）。

**A-1 握手与非 ephemeral 线程成立**

```text
INIT: {"result":{"userAgent":"mocl-164/0.164.0 (Mac OS 27.0.1; arm64) dumb (mocl-164; 0.1)",
                  "codexHome":"/private/tmp/mocl-verify-home-164","platformFamily":"unix","platformOs":"macos"}}
THREAD: id=01a173db-…  ephemeral=false  cliVersion=0.164.0
        path=<CODEX_HOME>/sessions/2026/10/26/rollout-….jsonl  （已分配，未落盘）
NOTIFS_AFTER_START: ['remoteControl/status/changed']（无 thread/started）
```

**A-2 未 materialize 时 resume/fork 失败，但 archive 成功（基线行为变化）**

```text
thread/resume  → {"error":{"code":-32600,"message":"no rollout found for thread id 01a1…"}}
thread/fork    → {"error":{"code":-32600,"message":"no rollout found for thread id 01a1…"}}
thread/archive → {"result":{}}      # 基线：未 materialize 也能归档；[legacy-0.153.4] 旧载荷报 no rollout found
thread/unsubscribe → {"result":{"status":"notLoaded"}}   # 旧载荷见 "unsubscribed"
thread/delete  → {"result":{}}
```

**A-3 后端不校验 cwd（相对/不存在都接受）**

```text
thread/start{cwd:"relative/path"}            → 成功，响应 cwd=<app-server 进程 cwd>/relative/path
thread/start{cwd:"/tmp/definitely-not-exist-xyz"} → 成功，响应 cwd=/tmp/definitely-not-exist-xyz
thread/start{ephemeral 省略}                 → 成功，thread.ephemeral=false
```

**A-4 `ServerRequest` = 10 个 method 变体（基线与旧载荷一致）**

```text
account/chatgptAuthTokens/refresh, applyPatchApproval, attestation/generate, execCommandApproval,
item/commandExecution/requestApproval, item/fileChange/requestApproval,
item/permissions/requestApproval, item/tool/call, item/tool/requestUserInput,
mcpServer/elicitation/request
# `openai/form` 不是独立 method：它是 mcpServer/elicitation/request.params.mode 的枚举值
```

**A-5 `thread/list` 只列已落盘会话**

```text
thread/start(无 turn) → thread/list{limit:3} = {"data":[],"readStates":{},"nextCursor":null}
同一时刻        → thread/loaded/list = {"data":["01a173db-…"]}
```

**A-6 客户端 `thread/start` 不产生 `thread/started` 通知**：见 A-1 的 `NOTIFS_AFTER_START`。

**A-7 运行时方法集（schema 有 ≠ 能调；基线实测）**

```text
thread/turns/list {threadId,limit:1} → {"error":{"code":-32600,
   "message":"thread … is not materialized yet; thread/turns/list is unavailable before first user message"}}
thread/items/list {threadId,limit:1} → {"error":{"code":-32601,"message":"thread/items/list is not supported yet"}}
turn/steer（无进行中轮）            → {"error":{"code":-32600,"message":"no active turn to steer"}}
turn/interrupt（无进行中轮）        → {"error":{"code":-32600,"message":"no active turn to interrupt"}}
thread/doesNotExist                  → {"error":{"code":-32600,"message":"Invalid request: unknown variant `thread/doesNotExist`,
                                        expected one of `initialize`, `server/diagnostics`, `userVerification/…`, …"}}
config/read                          → {"result":{"config":{…}}}     # 轻量健康探针
```

**A-8 `CODEX_HOME` 必须已存在（基线行为变化）**

```text
CODEX_HOME=/tmp/nonexistent-dir codex app-server --listen stdio://
→ stderr: WARNING: proceeding, even though we could not create PATH aliases: CODEX_HOME points to "…", but that path does not exist
→ Error: CODEX_HOME points to "…", but that path does not exist   （rc=1，进程直接退出）
# 旧载荷 0.153.4 会自动创建该目录
```

**A-9 基线运行时 > 导出 schema（解析时必须忽略未知字段）**

```text
thread/read  → thread 响应含 environments[{environmentId:"local",…}]（导出 Thread 无此字段）
thread/list  → 响应含 readStates{}（导出 ThreadListResponse 无此字段）
运行时方法表包含 server/diagnostics、userVerification/{status,enroll,delete,verify}（导出 ClientRequest 均无）
```

**A-10 旧载荷对照（仅 `--legacy`）**

```text
版本一致性: DIFF（基线 0.164.0 / 旧载荷 0.153.4）
ClientRequest 99→106（+8/−1，删 thread/rollback）；ServerNotification 81→85（+4）；ServerRequest 10→10
v2 definitions 622→668（+48/−2：删 ThreadRollbackParams/Response）；同名定义变化 53
TurnStartParams +disabledPluginIds/parentTurnId/rootTurnId；ThreadResumeResponse +collaborationMode/disabledPluginIds
```

## 附录 B — 交叉引用与遗留

- ABI：`docs/abi/abi-v0.md` §2.2/§2.3（握手/版本断言）、§3.2/§3.5（能力位与降级）、§4（传输绑定与反向请求）、§5.2（信封不变量）、§6.1/§6.2（M2/M3/M4/M5/M8）、§7（事件）、§8.2（错误码）、§9（幂等）、§10（安全）、§11（折叠上限）。
- 上游事实：`docs/research/codex.md`（R）、`docs/research/capability-matrix.md`（M）、`.astra/CONTEXT-DSH-SEAM.md`（C）。
- 交给 C4 的未决：V-CX-1（0.164.0 真实 turn 往返）、V-CX-2（kill→resume 同一 rollout）、V-CX-3（10 个反向请求不挂起）、AB-V4（429 形态）。
- 交给升级动作的未决（R2）：V-CX-6（0.164.0 读 0.153.4 rollout）、V-CX-7（插件三方法 + `ephemeral` 断言在新版成立）、A0 验收；升级完成后必须复跑 §12.4 全部断言。
- 已闭环：`event.json` 35 变体全覆盖（§5.6）；`backend.internal-error` 已按 ABI v0.1 MINOR 增补（§8.2）。

---

> **本规格的全部探测证据可复跑**：`bash repro/probe-codex.sh`（默认基线 0.164.0；`--legacy` 才对照 0.153.4；幂等、只读、零额度；退出码 0 = 基线断言通过）。
> 验收命令见 §12（12.1 证据复跑 / 12.2 文档闸门 / 12.3 零额度握手 smoke / 12.4 C4 一轮与续接断言）。

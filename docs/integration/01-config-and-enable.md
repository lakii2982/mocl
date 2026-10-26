# 01 — 配置 schema 与启用 / 停用 / 回滚

> **写域**：`docs/integration/*`（D6）。本文给出路线 A（旁路插件，见 `00-dsh-integration.md`）的完整配置契约：全局段 + 四后端段 + 工具段、默认值/取值范围/危险级别/失败影响、与 BRIEF §6 硬约束的对应、可直接照做的启用步骤、停用与回滚（含残留清理）。
> **真源**：seam 事实见 `.astra/CONTEXT-DSH-SEAM.md`；ABI 上限字段见 `docs/abi/abi-v0.md` §11.2；每后端能力/通道见 `docs/adapters/*`；容量默认值见 `docs/architecture/01-layers.md` §6.5。当前 DSH `0.2.1-rc.3`。
> **验证**：`python3 tools/check_docs.py integration`；配置组合校验配方见 §5.3（本机已实证）。

---

## 0. 一页速查

| 项 | 值 |
|---|---|
| 配置文件 | `~/.dsh/profiles/desktop/cordis.patch.yml`（追加；**不要**改同目录 `cordis.yml`，其注释明写 "Edit cordis.patch.yml, not this file"） |
| 插件包（施工 C8 产出，当前未安装） | `@mocl/dsh-bridge`（Host 插件，id `mocl-bridge`）、`@mocl/dsh-tool-subagent-agent`（id `tool-subagent-agent`，工具 `subagent_agent`）、`@mocl/dsh-tool-mocl`（id `tool-mocl`，工具 `mocl_status`/`mocl_interrupt`/`mocl_recover`） |
| 数据目录 | `~/.mocl/state`（journal/progress/report/logs）、`~/.mocl/worktrees`（worktree 隔离根）、`~/.mocl/artifacts`（大输出） |
| 可配键数量 | **顶层键 99 个**（全局 19 + 每后端 19 × 4 + 后端专属 4；叶子键 125 个）。另见 §4.3 的 3 个 seam 强制项 |
| 默认是否启用 | **codex/kimi/claudeCode 默认 `enabled:false`（显式开启）；opencode 默认 `enabled:true`（D-018）**；`permissionMode` 默认 `read-only`，`allowDangerousModes` 默认 `false` |
| 生效方式 | 修改 patch → **完全退出并重启 DSH**（profile patch 在每次启动时按 bundle→profile→`--patch` 顺序合成）；会话内配置快照不可变（INV-L5-1） |
| 回滚粒度 | 单后端开关 = 配置级 + 重启；全量回滚 = 恢复 patch 备份 + `dsh plugin remove` + 重启（§6） |
| 校验命令 | `dsh --profile headless --patch /tmp/mocl.check.yml --dump-config`（语法）；`dsh --profile desktop --dump-config` **不可用**（Electron 独占，§5.3） |

---

## 1. 配置模型与加载顺序

### 1.1 三层合成（本机实证）

```text
DSH 启动
  → bundle 层（package.json 的 dsh.profile.bundles：dsh-base / dsh-web-app / … / dsh-subagent-codex / dsh-subagent-claude-code）
  → profile 层：~/.dsh/profiles/desktop/cordis.patch.yml（本文改这里；顶层 YAML 数组）
  → CLI 覆盖层：dsh --patch <file>（可重复，最后应用；仅用于校验/临时调试）
```

证据：`~/.dsh/profiles/desktop/cordis.yml` 注释（"The tree is composed as patches: each bundle …, then cordis.patch.yml, then any --patch overlays. Edit cordis.patch.yml, not this file."）；`dsh --dump-config-schema` 的 `$comment`（"Bundle, profile, home, and CLI layers apply in that order. A patch config replaces the whole config."）。

### 1.2 patch 行语义（必须知道的 4 条）

| 行形态 | 语义 | 注意 |
|---|---|---|
| `- insert: [ {id, name, config}, … ]` | 追加新 Loader 行 | `name` 是包 specifier；本地开发可用 `file:`/link 安装（本机已有 `@local/agent-team-model-picker` link 先例） |
| `- id: <已有行>, config: {...}` | **整段替换**该行 config | 必须重述该行原有全部字段；漏写即回默认（例：覆盖 `subagent` 时 `maxActiveSubagents` 必须一起写） |
| `- id: <已有行>, disabled: true` | 停用该行 | 目标 id 不存在时向 stderr 打警告 `patch: entry "<id>" not found` 并**继续**（进程 rc 仍为 0，本机实证）——所以「disable 是否命中」不能看退出码，必须看警告/运行态 |
| `- id: <已有行>, name: <另一个包>` | 用另一个实现替换该行（B2 路线会用） | 本文路线 A 不用；B2 违反 BRIEF §5 非目标 |

### 1.3 配置优先级

1. 本文 patch 行（合成配置）是**唯一权威**；
2. GUI「插件 → 子智能体」页保存的是 **Host 设置层**（`subagent.maxDepth` / `subagent.maxActiveSubagents` / 模型选择），**用户值覆盖组合配置**（`dsh-client-ui-settings-subagent` README「使用本包」）；
3. 因此：seam 深度/容量建议在 GUI 设置页维护，或 patch 覆盖 `- id: subagent` 时写全（§4.5）。

---

## 2. 全局段 schema（`mocl-bridge.config.global`：19 个顶层键 / 29 个叶子键）

> 危险级别：**高** = 一旦放宽直接造成越权写/成本失控/上下文爆炸；**中** = 影响稳定性/成本；**低** = 可观测/维护性。所有「失败影响」遵循 L5 规则：配置非法 → **拒绝启动（fail-closed）**，不进入半配置状态（`docs/architecture/01-layers.md` §L5 INV-L5-2）。

| # | 键 | 类型 | 默认 | 取值范围 | 危险级别 | 失败影响（配错时） |
|---|---|---|---|---|---|---|
| G01 | `enabled` | bool | `true` | true/false | 低 | `false` 时桥插件整体不注册 provider/工具（急停开关）；已存在的外部会话仍可由 journal 查询，但不能派发新任务 |
| G02 | `maxConcurrent` | int \| `"runtime"` | **`runtime`（跟随 seam 运行值；D-016）** | `runtime` 或 1..runtime；未配置 = 跟随；配置值 > runtime → 启动断言失败（fail-closed） | 中 | 超过 seam 容量 → `ACTIVATION_LIMIT_REACHED`；**禁止硬编码默认值**；runtime 读取失败/字段缺失 → 拒绝启动（不猜默认） |
| G03 | `maxSessions` | int | `16` | 4–64 | 中 | 超限新会话进入 `queued`/拒绝（`limit.concurrency-exceeded`）；进程内存随会话数线性增长 |
| G04 | `maxDepth` | int | `2` | 1–3 | 中 | 过大 → 子代理再派子代理指数膨胀（R13）；过大且后端无原生上限时由 Bridge 单独强制 |
| G05 | `turnTimeoutMs` | int | `1800000` | 60000–7200000 | 中 | 过小 → 长任务被 `limit.turn-timeout` 中断（保留部分结果）；过大 → 卡死任务占用槽位 |
| G06 | `requestTimeoutMs` | int | `30000` | 5000–120000 | 中 | 过小 → 误判 `transport.timeout`（kimi 无内置超时，靠它兜底）；过大 → 半死连接长时间占用 |
| G07 | `idleTimeoutMs` | int | `180000` | 30000–900000 | 中 | 过小 → 慢思考被误杀（`process.hung`）；过大 → hang 发现延迟 |
| G08 | `parentDelivery` | enum | `parent` | `parent`/`caller` | 低 | `caller` 不产生父会话完成通知、也不产生 catalog 条目（UI 完全看不到该任务）；默认 `parent` |
| G09 | `capacityPolicy` | enum | `min` | `min`/`seam-first` | 低 | `min` = Bridge 上限与 seam 上限取小（R24 推荐）；`seam-first` = 只用 seam 准入，Bridge 不额外限流（并发风险升高） |
| G10 | `allowModelOverride` | bool | `false` | true/false | 中 | `true` 允许工具参数传 `model`（绕过配置的模型路由；成本/一致性风险）；`false` 时模型只认 per-backend `model` |
| G11 | `progress.mode` | enum | `summary` | `off`/`summary`/`events` | 中 | `events` 试图把更多中间事件投影到父级/UI（仍需过 G13–G15 硬上限）；`off` 只保留终态与本地 journal |
| G12 | `progress.samplingWindowMs` | int | `5000` | 1000–60000 | 中 | 过小 → 父级/UI 增量变密（逼近上下文爆炸）；过大 → 进度迟钝 |
| G13 | `progress.maxItemsPerTurn` | int | `8` | **1–8（硬上限）** | 高 | 超过 8 直接配置非法 → 拒绝启动（BRIEF §6-3 的机器强制）；不是「建议值」 |
| G14 | `progress.maxCharsPerTurn` | int | `1200` | **200–1200（硬上限）** | 高 | 同上；ABI §11.2 冻结值 |
| G15 | `progress.maxCharsPerItem` | int | `400` | **80–400（硬上限）** | 高 | 单条超限 → 截断 + `truncated:true`；配置超上限 → 拒绝启动 |
| G16 | `progress.includeReasoning` | bool | `false` | true/false | 中 | `true` 把思考内容计入父级/UI 预算（默认关闭；开启仍需计入同一 1200 字符额度） |
| G17 | `recovery.enabled` | bool | `true` | true/false | 中 | `false` 时 `lost` 直接按 `aborted` 处理（不自动冷恢复；R-1 降级路径仍可用） |
| G18 | `recovery.maxAttempts` | int | `5` | 1–10 | 中 | 过大 → 恢复风暴与重复成本；过小 → 瞬时故障被误判终态 |
| G19 | `recovery.windowMs` | int | `600000` | 60000–3600000 | 中 | 超窗即 `aborted`（`session.resume-failed`） |
| G20 | `worktree.isolation` | enum | `required-for-write` | `off`/`required-for-write`/`always` | **高** | `off` + 写操作 = 越权写主工作区（R04/R05）；`yolo` 档在非 `always`/非显式 worktree 时直接拒绝（`policy.sandbox-violation`） |
| G21 | `worktree.root` | string | `~/.mocl/worktrees` | 绝对路径（展开 `~` 后校验） | 中 | 非法/不可写 → 需 worktree 的任务建会话失败（`policy.sandbox-violation`）；不得指向仓库内 |
| G22 | `journal.dir` | string | `~/.mocl/state` | 绝对路径（展开后） | 中 | 不可写 → `storage.write-failed`/只读降级（D3），拒绝新轮次 |
| G23 | `journal.retentionDays` | int | `7` | 1–30 | 低 | 过短 → 幂等账本/审计历史不足（重放窗口 <24h 违反 ABI §9.2）；过长 → 磁盘增长 |
| G24 | `journal.fsync` | bool | `true` | true/false | 中 | `false` 提升吞吐但断电可能丢已 ack 请求（违反 INV-L2-3 的意图，不建议） |
| G25 | `dangerousModes.allowed` | bool | `false` | true/false | **高** | 这是 `yolo`/`danger-full-access` 的**总闸**；`true` 只是允许配置层出现危险档，仍需 per-backend `allowDangerousModes:true` + worktree（双闸，§4.4） |
| G26 | `env.allowlist` | string[] | `[HOME, PATH, LANG, LC_ALL, TMPDIR, HTTP_PROXY, HTTPS_PROXY, NO_PROXY]` | 不允许通配 `*`；每项必须是大写 env 名 | 中 | 漏项 → 后端缺依赖环境（spawn 失败）；多放（如 `*` 或带 `TOKEN` 的项）→ 凭据泄漏风险（R14），配置校验直接拒绝 `*` |
| G27 | `logLevel` | enum | `info` | `silent`/`error`/`warn`/`info`/`debug` | 低 | `debug` 日志量/磁盘增长；`silent` 丢失排障信息；日志始终脱敏（ABI SEC-1） |
| G28 | `metrics.enabled` | bool | `true` | true/false | 低 | `false` 关闭本地指标（`mocl.*`），不影响数据面 |
| G29 | `artifact.maxBytes` | int | `262144` | 1024–1048576 | 低 | 超限事件/工具输出截断 + artifact 引用（ABI 单事件上限 256 KiB） |

> 计数说明：`G01–G29` 共 29 个**叶子键** = 10 个非分组键（G01–G10）+ 8 个分组（`progress.*` 6、`recovery.*` 3、`worktree.*` 2、`journal.*` 3、`dangerousModes.*` 1、`env.*` 1、`metrics.*` 1、`artifact.*` 1，共 18 个叶子）+ `logLevel`（1）。按顶层 property 归并后为 **19 个顶层键**（`enabled`/`maxConcurrent`/`maxSessions`/`maxDepth`/`turnTimeoutMs`/`requestTimeoutMs`/`idleTimeoutMs`/`parentDelivery`/`capacityPolicy`/`allowModelOverride`/`progress`/`recovery`/`worktree`/`journal`/`dangerousModes`/`env`/`logLevel`/`metrics`/`artifact`）。下文按分组呈现，机器校验以 JSON Schema 为准（施工 C8 产出 `schema/config.schema.json`）。

---

## 3. 每后端段 schema（`mocl-bridge.config.backends.<id>`）

> 四个后端共用 **19 个通用键**（上表 B01–B23 归并后；叶子键 23 个），默认值按后端能力差异化，另有一个后端专属键（§3.2）。`<b>` ∈ `codex|kimi|claudeCode|opencode`。
> 键 `protocol`/`channel`/`nativeMaxDepth` 的取值由 `docs/adapters/*` 的选型结论锁定（§3.2），改它等于换传输，需重新跑该适配器验收。

### 3.1 通用键表（每个后端 19 个顶层键 / 23 个叶子键）

| # | 键 | 类型 | 默认（通用） | 取值范围 | 危险级别 | 失败影响 |
|---|---|---|---|---|---|---|
| B01 | `enabled` | bool | **`false`** | true/false | 中 | `false` 时该后端不注册 provider、`subagent_agent` 的 `backend` 枚举不含它；调用旧值返回「后端未启用，可用：…」（fail-closed，不隐式兜底到别的后端） |
| B02 | `providerName` | string | 见 §3.2 | `^[a-z][a-z0-9-]{1,31}$` | 中 | 与工具映射不一致 → 该后端所有委派 404/未知 provider（启动自检会拒绝加载） |
| B03 | `protocol` | enum | 见 §3.2 | `app-server-jsonrpc`/`acp-stdio`/`agent-sdk`/`http-api` | 高 | 选错 = 适配器握手失败（`protocol.version-mismatch`/`transport.connect-failed`），该后端不可用 |
| B04 | `channel` | enum | 见 §3.2 | `native`/`http-api`/`acp`/`cli-stream-json` | 中 | 仅 opencode 有双通道；控制类动作（中断/权限应答/切模型）必须与创建通道一致（D-007 / `docs/adapters/opencode.md` §10.3），跨通道 → `session.conflict` |
| B05 | `binaryPath` | string | 见 §3.2（**绝对路径**） | 展开 `~` 后必须是可执行绝对路径 | 中 | 缺失/不可执行 → `process.spawn-failed`（退避 ≤2 后拒绝注册该后端）；codex 生产基线 **0.164.0（D-015）**，bundle 0.153.4 为待升级旧载荷：升级前后都要断言实际 `--version`，禁止混用两版 schema |
| B06 | `model` | string/null | `null`（后端默认） | Provider/model 字符串，≤128 字符 | 中 | 无效模型 → `auth.provider-mismatch`（不静默换模型）；`null` 时使用后端默认模型（成本不可预测，要求用户显式固定，见 R02） |
| B07 | `permissionMode` | enum | **`read-only`** | `read-only`/`safe-auto`/`yolo` | **高** | 语义三档映射（不按名字透传，`docs/research/capability-matrix.md` §4 C1）；非法值拒绝启动；`safe-auto`/`yolo` 受 `allowDangerousModes` + worktree 双闸约束 |
| B08 | `allowDangerousModes` | bool | **`false`** | true/false | **高** | `true` 才允许 `permissionMode` 取 `safe-auto`/`yolo`；`dangerousModes.allowed=false` 时本键强制视为 false（双闸），配置矛盾 → 拒绝启动 |
| B09 | `maxConcurrent` | int \| `"runtime"` | **`runtime`（跟随 `global.maxConcurrent`；D-016）** | `runtime` 或 1..`global.maxConcurrent`；未配置 = 跟随 | 中 | 超限 → `queued`/`limit.concurrency-exceeded`；kimi 必须 `1`（一任务一进程，D-008，属进程隔离而非运行值），配 >1 启动告警并收敛为 1 |
| B10 | `maxDepth` | int | `2` | 1–3 | 中 | 兼容层强制深度（绕过 seam 的 S4 约束，见 `00-dsh-integration.md` §4.2）；超限 → `limit.nesting-exceeded`，父级不受影响 |
| B11 | `nativeMaxDepth` | int/null | 见 §3.2 | 1–3 或 null | 中 | 仅在透传原生子代理深度时使用（codex `[agents] max_depth`）；其他后端只能观测（claude spawnDepth）或不可见（kimi/opencode 视证据）；`null` = 不限制原生层（仍受 B10 约束） |
| B12 | `turnTimeoutMs` | int | `1800000` | 60000–7200000 | 中 | 见 G05；kimi 必须显式依赖它（无内置超时） |
| B13 | `requestTimeoutMs` | int | `30000` | 5000–120000 | 中 | 见 G06；ACP/app-server 单请求超时 |
| B14 | `idleTimeoutMs` | int | `180000` | 30000–900000 | 中 | 见 G07；`process.hung` 判定窗口 |
| B15 | `progress.mode` | enum | `inherit` | `inherit`/`off`/`summary`/`events` | 中 | `inherit` 用全局；per-backend 收紧/放宽只影响投影量，不能突破 G13/G14 硬上限 |
| B16 | `progress.maxItemsPerTurn` | int | `8` | 1–**8** | 高 | 同 G13；per-backend 只能 ≤8 |
| B17 | `progress.maxCharsPerTurn` | int | `1200` | 200–**1200** | 高 | 同 G14；per-backend 只能 ≤1200 |
| B18 | `progress.samplingWindowMs` | int | `5000` | 1000–60000 | 中 | 同 G12 |
| B19 | `logLevel` | enum | `inherit` | `inherit`/`silent`/`error`/`warn`/`info`/`debug` | 低 | per-backend 日志级别；`debug` 仍脱敏 |
| B20 | `worktreeIsolation` | enum | `required-for-write` | `off`/`required-for-write`/`always` | **高** | 非 `read-only` 档必须 ≠ `off`；否则建会话被拒（`policy.sandbox-violation`）。`off` 只允许与 `permissionMode: read-only` 同时出现 |
| B21 | `env.allowlist` | string[] | `[]`（继承全局） | 同 G26 | 中 | 追加给该后端的白名单（取并集）；不接受通配 |
| B22 | `env.extra` | map<string,string> | `{}` | 键为大写 env 名；值不得含凭据字面量（SEC-1） | 高 | 值疑似凭据（`sk-`/`Bearer`/长 token）→ 配置校验拒绝启动；凭据应由后端自身登录态/系统 keychain 提供 |
| B23 | `healthProbeTimeoutMs` | int | `5000` | 1000–30000 | 低 | 健康探测超时；过短 → 误判不健康并熔断 |

> 说明：上表 B01–B23 共 **23 个叶子键**；把 `progress.*`（4 个叶子）与 `env.*`（2 个叶子）按分组归并后，每个后端为 **19 个顶层键**。四后端各 19 → 76，加全局 19，再加后端专属键 4（`processIsolation`/`sdkPath`/`serverPasswordEnv`/`fallbackModel`）→ **顶层键 99 个（叶子键 125 个）**。
>
> **三个同名 `maxDepth` 不要混**：① 工具行 `maxDepth: provider-managed`（seam 契约，只能 `provider-managed`）；② 本文 per-backend `backends.<b>.maxDepth`（兼容层嵌套深度，默认 2，映射 ABI `limits.maxNestingDepth`，即 BRIEF 要求的「嵌套深度上限」）；③ Host 设置 `subagent.maxDepth`（seam 本地 spawn/fork 委派深度，默认 1，见 §4.5）。
>
> **`timeoutMs` 键的拆分**：任务/契约所说的单一 `timeoutMs` 在本文拆成三项——`turnTimeoutMs`（单轮，默认 30 min，等价于 ABI `limits.maxTurnMs`）、`requestTimeoutMs`（单请求，默认 30 s）、`idleTimeoutMs`（空闲探测，默认 180 s）。三者都在全局与 per-backend 两级可配。

### 3.2 四后端默认值差异（必须按此钉死）

| 项 | codex | kimi | claudeCode | opencode |
|---|---|---|---|---|
| `providerName` | `codex` | `kimi` | `claude-code` | `opencode` |
| `protocol` | `app-server-jsonrpc`（`docs/adapters/codex.md` §2.1） | `acp-stdio`（`docs/adapters/kimi.md` §0.2，CLI `stream-json` 为备） | `agent-sdk`（`docs/adapters/claude-code.md` §2.1，CLI stream-json 为备） | `http-api`（**D-007 裁定：v2 HTTP 优先 + ACP 兜底**，`docs/adapters/opencode.md` §0.2） |
| `channel` | `native` | `native` | `native` | `http-api`（备 `acp`） |
| `binaryPath`（D-015 基线） | **生产基线 = 0.164.0**（`PATH` 的 `codex`，如 `~/.nvm/versions/node/v24.18.1/bin/codex`）；bundle 0.153.4 为**待升级旧载荷**（升级与「两处 `--version` 一致」验收见 `HANDOFF.md` C11 前置）；跨版本 schema 差异：0.153.4=99/81，0.164.0=106/85 | `~/.kimi-code/bin/kimi` = 2.3.1 | **适配器基线 = SDK 0.3.263 + SDK 内置 CLI 2.1.263**（`~/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk`；默认不配 `claudeCodeExecutable`）；宿主 `~/.nvm/versions/node/v24.18.1/bin/claude` = 2.1.310 属**另一条升级线**，默认不使用 | `~/.opencode/bin/opencode` = 2.1.4 |
| 额外键 | — | `processIsolation: per-task`（必须；`killpg` 中断，D-008） | `sdkPath`（必填，绝对路径）；`claudeCodeExecutable` 仅外部 CLI 线（2.1.310）才配 | `serverPasswordEnv: OPENCODE_SERVER_PASSWORD`（只写键名，不写值；`serve` 会把 password 打到 stdout，禁止收集其 stdout，`docs/adapters/opencode.md` §10.1）；`fallbackModel`（默认 `opencode/deepseek-v4.1-flash-free`，D-019） |
| `enabled` 默认 | `false` | `false` | `false` | **`true`（D-018）** |
| `model` 默认 | `null` | `null` | `null` | **`opencode-go/deepseek-v4.1-flash`（生产基线，D-019）；key 失效降级 `opencode/deepseek-v4.1-flash-free`** |
| `maxConcurrent` 默认 | **`runtime`** | **`1`**（一任务一进程） | **`runtime`** | **`runtime`** |
| `maxDepth` 默认 | `2`（与原生 `[agents] max_depth=2` 一致） | `1`（ACP 无子代理方法） | `2`（原生子代理可观测但宿主不能强制派发，`docs/adapters/claude-code.md` §10.3 G1） | `1`（原生子代理证据在，但跨通道归属未验证，先保守） |
| `nativeMaxDepth` 默认 | `2` | `null` | `null`（靠 `spawnDepth` 观测） | `null` |
| `permissionMode` 默认 | `read-only` | `read-only`（CLI `-p` 与模式旗标互斥，headless 档位受 `config.toml` 约束，§7.5） | `read-only`（CLI `manual`≠SDK `default` 命名坑，§7.1） | `read-only`（默认 `build` 全放行，必须显式收窄，§7.3） |
| 危险档前置条件 | `danger-full-access` 必须 worktree + `allowDangerousModes` | `yolo` 必须 worktree + `allowDangerousModes`（命名错位，按语义映射） | `bypassPermissions` 类档必须 worktree + 显式开启 | `--auto`/build 全放行必须 worktree + 显式开启 |
| 无 OS 沙箱事实 | 有 `SandboxMode`（`docs/adapters/codex.md` §7.3） | **无**（§7.4） | 仅工具级收窄（§7.3） | **无**，默认全放行（§7.4） |

### 3.3 与 BRIEF §6 硬约束的对应（逐条可核查）

| BRIEF §6 | 约束原文要点 | 落地键/机制 | 机器强制方式 |
|---|---|---|---|
| §6-1 版本基线 | 四后端版本必须实测后写入 | `binaryPath` 钉死 + `protocol` + 握手断言（适配器 `versionPinning` 位）+ `mocl_status.backendVersion` | 版本断言失败 → `protocol.version-mismatch` fail fast，不混跑 |
| §6-2 无人值守 | 不能依赖人工审批，交互必须可自动拒/自动答 | `permissionMode` 默认 `read-only`；`allowDangerousModes:false`；各适配器 fail-closed 反向请求应答（ABI §10 SEC-3） | 任何反向请求无 handler → deny；`policy.escalation-required` 上报，不挂起 |
| §6-3 父会话只增量、可折叠、有限量、不改前缀 | 进度上限是硬要求 | `parentDelivery=parent`（仅终态 1 条）+ `progress.mode=off/summary` + `samplingWindowMs` + `maxItemsPerTurn≤8` + `maxCharsPerTurn≤1200` + `maxCharsPerItem≤400`；中间进度走 `mocl_status`/文件 | G13/G14/G15 是**硬上限**：配置超过 → 拒绝启动；投影器在发送前二次断言 |
| §6-4 成本可控 | 嵌套数量与并发必须有硬上限，默认写进 schema | `global.maxConcurrent=runtime`（D-016 跟随 seam）、`global.maxDepth=2`、`global.maxSessions=16`、per-backend `maxConcurrent`、`turnTimeoutMs`；seam `maxActiveSubagents` 为外层闸（R24） | 配额在副作用前校验（INV-L2-6）；拒绝码 `limit.concurrency-exceeded`/`limit.nesting-exceeded` |
| §6-5 安全默认 | 默认最小权限；危险档显式开启 + worktree | `permissionMode=read-only`；`dangerousModes.allowed=false` + per-backend `allowDangerousModes=false`（双闸）；`worktree.isolation=required-for-write`；`env.allowlist` 白名单 | 双闸缺一 → 危险档拒绝（`policy.sandbox-violation`）；`env` 含 `*`/凭据字面量 → 拒绝启动 |
| §6-6 文档中文/证据 | 结论有证据 | 每个键的默认值/上限均可回指 ABI/架构/适配器条款（表中已标） | `check_docs.py` + 施工 C8 的 JSON Schema 校验 |

---

## 4. 工具段 schema 与 seam 强制项

### 4.1 统一工具（`tool-subagent-agent`）

| 键 | 类型 | 默认 | 范围 | 危险级别 | 失败影响 |
|---|---|---|---|---|---|
| `toolName` | string | `subagent_agent` | 全局唯一，`^[a-z][a-z0-9_]{2,31}$` | 中 | 与既有工具重名 → 加载失败（R25）；建议保留默认 |
| `maxDepth` | enum/string | **`provider-managed`（强制）** | 只允许 `provider-managed` | **高** | 配成数值 → 外部 provider 无 `depthLimit` → 每次委派在 `start` 前被 seam 拒绝（`UNSUPPORTED_CAPABILITY`，见 `00-dsh-integration.md` §4.4） |
| `delivery` | enum | `parent` | `parent`（固定） | 低 | `caller` 无完成通知、无 catalog 条目，UI 完全不可见 |
| `modelSelectionSettings` | bool | `false`（强制） | 只允许 `false` | **高** | `true` 要求 `agentOptions` → 外部后端被拒绝 |
| `backends` | map | `{codex: codex, kimi: kimi, claude-code: claude-code, opencode: opencode}` | 值必须是已注册 providerName | 中 | 映射指向未注册 provider → 该后端调用失败（启动自检拒绝加载） |
| `defaultBackend` | string | `codex` | 已启用后端之一 | 中 | 指向已禁用后端 → 启动自检拒绝加载 |
| `concurrencyHint` | bool | `true` | true/false | 低 | `true` 时在工具描述里提示「先看前置检查/按后端能力选型」，不改变行为 |

### 4.2 控制工具（`tool-mocl`）

| 键 | 类型 | 默认 | 范围 | 危险级别 | 失败影响 |
|---|---|---|---|---|---|
| `toolNamePrefix` | string | `mocl_` | `mocl_`/`mocl` | 低 | 改前缀会导致文档/提示词失配（模型仍能看到工具，但指引不匹配） |
| `enableStatus` / `enableInterrupt` / `enableRecover` | bool | `true` | true/false | 中 | 关闭某项 → 对应能力无工具入口（`mocl_interrupt` 关闭后，外部后端只能靠 seam `interrupt_agent` 永久停止） |
| `allowCrossSessionQuery` | bool | `false` | true/false | 中 | `true` 允许查任意 `sess_id`（多会话排障用）；`false` 只能查本父链下的会话（最小权限） |

### 4.3 seam 强制项（漏配即故障；不计入 99 个可配键，但必须同时满足）

| 项 | 值 | 证据/原因 | 漏配的失败形态 |
|---|---|---|---|
| 工具 `maxDepth` | `provider-managed` | `NO_START_CAPABILITIES.depthLimit=false`（`.astra/CONTEXT-DSH-SEAM.md` §2） | 全部委派被 seam 在启动前拒绝（`UNSUPPORTED_CAPABILITY`） |
| 委派 `delivery` | `parent` | 外部条目只在 `delivery:'parent'` 时写入 catalog（`dsh-subagent/README.zh.md` Activation 结算） | UI 无任何条目，父级无完成通知 |
| 旧工具行 | 停用 `tool-subagent-codex` / `tool-subagent-claude-code` 与两个 provider 行 | R25；避免同名 provider/工具双注册 | 加载失败或行为不确定（同名遮蔽） |

### 4.4 危险档双闸（配置层强制，不接受「只开一个」）

```text
permissionMode ∈ {safe-auto, yolo}
  ∧ global.dangerousModes.allowed = true
  ∧ backends.<b>.allowDangerousModes = true
  ∧ (backends.<b>.worktreeIsolation ≠ off)
  ∧ cwd ∈ worktree root（或调用方显式提供已验证的隔离 cwd）
  → 允许建会话；否则 policy.sandbox-violation / policy.escalation-required
```

### 4.5 与 seam 容量/深度的对齐（R24）

- **D-016：并发一律取运行时。** seam 的 `maxActiveSubagents` 由 Host 设置/组合配置决定（本机 desktop 当前为 20，仅为实例值；文档**不写死**任何默认整数）。
- Bridge 启动时**读取** seam 运行值并断言：`global.maxConcurrent`/per-backend `maxConcurrent` 缺省 `runtime` 跟随；显式配置值 > runtime → 启动失败（fail-closed）；runtime 读取失败/缺失 → 启动失败（fail-closed）。
- `mocl_status` 返回 `seamCapacity`（运行时值）+ `configDigest`，便于核对；**不要**在文档/配置里写「必须等于 20」之类固定值。
- 若确实要固定容量：在 GUI「插件 → 子智能体」或 patch 覆盖 `- id: subagent` 设置**显式值**（`config` 整段替换），并让 Bridge 启动断言 `runtime == 显式值`；不得只改一边。

```yaml
# 仅在「确实要固定容量」时使用；默认不要覆盖 subagent 行（跟随 GUI/运行时）
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
  config:
    maxDepth: 2                 # 默认 1；数值深度只影响本地 spawn/fork 工具
    maxActiveSubagents: <显式值>  # 必须与 GUI/运行值一致；Bridge 启动断言 runtime == 该值
```

> 注意：GUI「插件 → 子智能体」页保存的是用户设置层，**用户值会覆盖上面的组合配置**；改完以 GUI 显示值为准。

---

## 5. 启用步骤（照做版）

### 5.0 前置检查（零副作用）

```bash
cd /Users/lakii2982/项目/多智能体编排

# 1) DSH 版本
dsh --version                                   # 期望 0.2.1-rc.3

# 2) 四后端二进制/版本（与 docs/research/* 一致）
codex --version                                  # 0.164.0（D-015 生产基线；两处 --version 不一致先走 HANDOFF C11 前置）
~/.dsh/profiles/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --version   # 升级后应为 0.164.0（bundle 旧载荷=待升级）
~/.kimi-code/bin/kimi --version                 # 2.3.1
claude --version                                # 2.1.310 (Claude Code) = 宿主线（另一条升级线；适配器基线用 SDK 内置 CLI 2.1.263）
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json')))['version'])"   # 2.1.263 = SDK 内置 CLI（适配器基线）
~/.opencode/bin/opencode --version              # opencode v2.1.4

# 3) 现有插件（确认旧 codex/claude provider 行存在，稍后要停用）
dsh plugin --profile desktop list

# 4) 备份 patch（回滚依赖它，必须做）
cp ~/.dsh/profiles/desktop/cordis.patch.yml \
   ~/.dsh/profiles/desktop/cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)
ls -l ~/.dsh/profiles/desktop/cordis.patch.yml.bak-*

# 5) 凭据存在性（只看存在性，不打印内容）
test -f ~/.kimi-code/credentials.json && echo KIMI_CRED_PRESENT || echo KIMI_CRED_MISSING
# opencode 凭据分级（D-019）：production 模型 key 已过期（重登录不续期，需 Console 新建 key）；
# free 模型可立即验证；不把「key 过期」当交付缺口（四后端链路全部可用）
```

### 5.1 安装插件包（施工 C8 产出后；当前不存在）

```bash
# 本地开发/验证用 link；发布形态用 tarball 或 registry spec。
# 命令形态来自 dsh --help（`dsh plugin --profile <name> <pnpm-args...>`）；
# 本机已实证 `dsh plugin --profile desktop list` 可用，add/remove 尚未在本环境执行。
dsh plugin --profile desktop add /abs/path/mocl-bridge \
                                  /abs/path/mocl-tool-subagent-agent \
                                  /abs/path/mocl-tool-mocl
dsh plugin --profile desktop list    # 期望新增 3 个 @mocl/*（当前 profile 已有 local link 先例）
```

> 不要用 `pnpm add` 手改 `node_modules`：`dsh plugin` 会保持 profile 的 lock/工作区一致；桌面端修改 profile 后需重启应用。

### 5.2 追加 YAML（五段：全局 + 四后端；再追加装配/停用段）

**① 全局段**

```yaml
- insert:
    - id: mocl-bridge
      name: '@mocl/dsh-bridge'
      config:
        global:
          enabled: true
          maxConcurrent: runtime          # D-016：跟随 seam 运行值（禁止硬编码 8/2）
          maxSessions: 16
          maxDepth: 2
          turnTimeoutMs: 1800000
          requestTimeoutMs: 30000
          idleTimeoutMs: 180000
          parentDelivery: parent
          capacityPolicy: min
          allowModelOverride: false
          progress:
            mode: summary
            samplingWindowMs: 5000
            maxItemsPerTurn: 8
            maxCharsPerTurn: 1200
            maxCharsPerItem: 400
            includeReasoning: false
          recovery:
            enabled: true
            maxAttempts: 5
            windowMs: 600000
          worktree:
            root: ~/.mocl/worktrees
            isolation: required-for-write
          journal:
            dir: ~/.mocl/state
            retentionDays: 7
            fsync: true
          dangerousModes:
            allowed: false
          env:
            allowlist: [HOME, PATH, LANG, LC_ALL, TMPDIR, HTTP_PROXY, HTTPS_PROXY, NO_PROXY]
          logLevel: info
          metrics:
            enabled: true
```

**② codex 段**（`backends.codex`，追加到同一个 `mocl-bridge.config` 下）

```yaml
        backends:
          codex:
            enabled: true                     # codex 显式开启（opencode 默认开启，D-018）
            providerName: codex
            protocol: app-server-jsonrpc
            binaryPath: ~/.nvm/versions/node/v24.18.1/bin/codex   # 0.164.0 生产基线（D-015）
            model: null
            permissionMode: read-only
            allowDangerousModes: false
            maxConcurrent: runtime        # D-016：跟随 seam 运行值
            maxDepth: 2
            nativeMaxDepth: 2
            turnTimeoutMs: 1800000
            requestTimeoutMs: 30000
            idleTimeoutMs: 180000
            progress:
              mode: inherit
              maxItemsPerTurn: 8
              maxCharsPerTurn: 1200
              samplingWindowMs: 5000
            worktreeIsolation: required-for-write
            logLevel: inherit
            healthProbeTimeoutMs: 5000
```

**③ kimi 段**（一任务一进程；无 OS 沙箱，`yolo` 默认不可用）

```yaml
          kimi:
            enabled: false
            providerName: kimi
            protocol: acp-stdio
            channel: native
            binaryPath: ~/.kimi-code/bin/kimi
            model: null
            permissionMode: read-only
            allowDangerousModes: false
            maxConcurrent: 1                  # 硬约束：一任务一进程（D-008）
            maxDepth: 1
            nativeMaxDepth: null
            turnTimeoutMs: 1800000
            requestTimeoutMs: 30000
            idleTimeoutMs: 180000
            processIsolation: per-task        # killpg(SIGTERM→SIGKILL) 实现「中断」
            progress:
              mode: inherit
              maxItemsPerTurn: 8
              maxCharsPerTurn: 1200
              samplingWindowMs: 5000
            worktreeIsolation: required-for-write
            logLevel: inherit
            healthProbeTimeoutMs: 5000
```

**④ claudeCode 段**（基线：SDK 0.3.263 + SDK 内置 CLI 2.1.263；宿主 CLI 2.1.310 为另一条升级线）

```yaml
          claudeCode:
            enabled: false
            providerName: claude-code
            protocol: agent-sdk
            channel: native
            # binaryPath：默认不配 → 用 SDK 平台包内置 CLI 2.1.263；仅外部 CLI 线（2.1.310）才配
            sdkPath: ~/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk
            model: null
            permissionMode: read-only
            allowDangerousModes: false
            maxConcurrent: runtime        # D-016：跟随 seam 运行值
            maxDepth: 2
            nativeMaxDepth: null              # spawnDepth 只可观测，不可由宿主强制派发
            turnTimeoutMs: 1800000
            requestTimeoutMs: 30000
            idleTimeoutMs: 180000
            progress:
              mode: inherit
              maxItemsPerTurn: 8
              maxCharsPerTurn: 1200
              samplingWindowMs: 5000
            worktreeIsolation: required-for-write
            logLevel: inherit
            healthProbeTimeoutMs: 5000
```

**⑤ opencode 段**（默认开启，D-018；生产模型需新建 key，key 失效自动降级 free 模型，D-019）

```yaml
          opencode:
            enabled: true                     # D-018：默认开启
            providerName: opencode
            protocol: http-api
            channel: http-api                # D-007：v2 HTTP 优先，ACP 兜底
            binaryPath: ~/.opencode/bin/opencode
            serverPasswordEnv: OPENCODE_SERVER_PASSWORD   # 只写键名，不写值
            model: opencode-go/deepseek-v4.1-flash        # 生产基线（D-019；key 需新建）
            fallbackModel: opencode/deepseek-v4.1-flash-free  # key 失效时降级；发 degraded 事件
            permissionMode: read-only
            allowDangerousModes: false
            maxConcurrent: runtime            # D-016：跟随 seam 运行值
            maxDepth: 1
            nativeMaxDepth: null
            turnTimeoutMs: 1800000
            requestTimeoutMs: 30000
            idleTimeoutMs: 180000
            progress:
              mode: inherit
              maxItemsPerTurn: 8
              maxCharsPerTurn: 1200
              samplingWindowMs: 5000
            worktreeIsolation: required-for-write
            logLevel: inherit
            healthProbeTimeoutMs: 5000
```

**⑥ 装配段：工具行 + 停用旧行（同一 patch 文件）**

> 说明：本节前两条 `    - id: …` 是 **① 的 `insert:` 列表的继续**（保持 4 空格缩进，与 `mocl-bridge` 同级）；其后的四条 `- id: … disabled: true` 是**新的顶层 patch 行**（0 缩进）。

```yaml
    - id: tool-subagent-agent
      name: '@mocl/dsh-tool-subagent-agent'
      config:
        toolName: subagent_agent
        maxDepth: provider-managed        # 强制；数值会被 seam 拒绝
        delivery: parent
        modelSelectionSettings: false     # 强制；外部后端无 agentOptions
        backends:
          codex: codex
          kimi: kimi
          claude-code: claude-code
          opencode: opencode
        defaultBackend: codex
        concurrencyHint: true

    - id: tool-mocl
      name: '@mocl/dsh-tool-mocl'
      config:
        toolNamePrefix: mocl_
        enableStatus: true
        enableInterrupt: true
        enableRecover: true
        allowCrossSessionQuery: false

# 停用旧的一次性 codex/claude provider 与工具（R25；回滚时恢复）
- id: subagent-codex
  disabled: true
- id: subagent-claude-code
  disabled: true
- id: tool-subagent-codex
  disabled: true
- id: tool-subagent-claude-code
  disabled: true
```

> **整段替换注意**：`backends` 的五个子段必须写在同一张 `insert` 行的同一个 `config` 下（YAML 缩进一致）；本文为了可读拆成 5 段展示，合并时 `backends:` 只出现一次。若改用逐行覆盖一个**不存在的** `- id:`，stderr 会警告 `patch: entry "<id>" not found` 并继续（不会生效）——所以必须用 `insert` 新增行，或用**已存在**的行 id 覆盖。

### 5.3 语法 / 组合校验（本机已实证可用）

```bash
# 1) 把「只含 insert 行」的片段另存为 /tmp/mocl.check.yml（不要带 desktop 专属 override）
dsh --profile headless --patch /tmp/mocl.check.yml --dump-config | tail -40
echo "rc=$?"        # 期望 rc=0，且末尾出现 "# == /tmp/mocl.check.yml"

# 2) 校验 patch 条目结构（insert/id/config/disabled 是否合法）
dsh --profile headless --dump-config-schema \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('patchList:', d['\$defs']['patchList']['type']); print('patch:', d['\$defs']['patch']['type'])"

# 3) desktop 不能用 dump-config（Electron 独占）；本机实测原文：
#    error: profile "desktop" is managed exclusively by the Electron application
dsh --profile desktop --dump-config 2>&1 | head -2

# 4) 若把「停用旧行」也放进 headless 校验文件：4 个 desktop-only id 会触发预期警告
#    dsh: [.../mocl.check.yml] patch: entry "subagent-codex" not found   （rc 仍 0，非语法错误）
#    只有在 desktop 上这些 id 才存在，此时应**没有**该警告
```

### 5.4 生效方式

1. **完全退出** DSH 桌面应用（不是关窗口），确认进程退出：`pgrep -fl 'DeepSeek Harness' || echo NO_DSH_PROCESS`；
2. 重新启动；启动时按 bundle→profile→`--patch` 重新合成，`mocl-bridge` 注册 provider/工具；
3. **会话内生效边界**：已存在会话的配置快照不可变（INV-L5-1）——改配置后**新会话**才用新值；旧会话继续用旧快照（含权限档、上限）；
4. 若只改 GUI「插件 → 子智能体」设置（深度/容量），下一次委派即生效（seam README「委派设置」）。

### 5.5 验证生效（必须逐项，不可只看「没报错」）

| # | 验证项 | 方法 | 期望 |
|---|---|---|---|
| V1 | 插件已加载 | GUI 侧栏 **插件** 页 → 插件列表 | 出现 `@mocl/dsh-bridge` / `@mocl/dsh-tool-subagent-agent` / `@mocl/dsh-tool-mocl`，状态为启用 |
| V2 | Bridge 配置合法 | 启动日志（`~/.mocl/state/bridge.log`，`logLevel:info`） | 一行 `configDigest=<sha256前12位> backends=enabled:[codex,opencode] seamCapacity=<runtime 读取值>`，无 `config-invalid`；`seamCapacity` 必须来自运行时而非配置写死 |
| V3 | 工具可见 | 新会话里让模型列工具，或宿主工具目录快照 | `subagent_agent`（含 `backend` 枚举，默认启用 `codex`+`opencode`）与 `mocl_status`/`mocl_interrupt`/`mocl_recover` 可见；`subagent_codex`/`subagent_claude_code` **不可见**（旧行已停用） |
| V4 | seam 设置生效 | GUI **插件 → 子智能体** + 启动日志 | 「最大递归深度」「子智能体并行数量上限」显示值 = 运行时值；Bridge 日志 `seamCapacity` 与 GUI 一致（D-016；不允许写死 8/20） |
| V5 | 端到端 smoke（零/低额度） | 分别调用 `subagent_agent(backend="codex")` 与 `backend="opencode"`（opencode 用 free 模型或已新建 key） | 工具返回 `started subagent <childId>`；父会话收到 1 条完成通知；`mocl_status` 返回 `state=completed`、`usage`、`lastSeq`；opencode key 失效时 `usage.model=free-fallback` 且出现 `degraded` 事件 |
| V6 | catalog 叶子 | GUI 子代理目录（页头后代数量触发器） | 出现 1 条外部条目（不可打开、无状态，label 形如 `[codex] …`） |
| V7 | 配置快照/热改 | 改 `global.maxSessions` → 重启 → 新会话 | 新会话用新值，旧会话不变（可查 `mocl_status.configDigest` 前后不同） |
| V8 | 负向：禁用后端 | `subagent_agent(backend="kimi")`（kimi `enabled:false`） | 工具返回明确错误「kimi 未启用，可用：codex」，不隐式改用 codex |
| V9 | 负向：危险档双闸 | 设 `permissionMode: yolo` 但 `allowDangerousModes:false` → 重启 → 建会话 | 拒绝：`policy.escalation-required`（或配置非法直接拒绝启动），日志可查 |
| V10 | 只读默认 | 不传 model/permission 的 smoke | 生效档位为 `read-only`（`mocl_status.permissionMode`），后端无写操作 |

### 5.6 opencode 凭据分级与启用（D-018/D-019）

**现状（D-019，Lead 复测）**：

- 凭据文件 `~/.local/share/opencode/auth.json` 存在 `opencode-go`（`oc_s…`）key；`opencode auth list` 显示 OpenCode Go + GitHub Copilot stored；
- 生产模型 `opencode-go/deepseek-v4.1-flash` → 401 `api_key_expired`，原文明确「**Signing in again will not renew this key**」（重新登录不续期）；
- 免费模型 `opencode/deepseek-v4.1-flash-free` → 实测 rc=0，`-s <sessionID>` 续接成功。

**唯一修法（一次性人工动作）**：到 OpenCode Console（opencode.ai 控制台）**新建 API key**，替换到 `~/.local/share/opencode/auth.json`（或 `opencode auth login` 后手动替换）。

**兼容层行为（不允许静默降级）**：

| 条件 | 行为 |
|---|---|
| production model 调用成功 | 正常；`usage.model=opencode-go/deepseek-v4.1-flash` |
| production model 返回 401/`api_key_expired` | 自动改用 `fallbackModel`（默认 `opencode/deepseek-v4.1-flash-free`）重试 1 次；发 `degraded` 事件（`code:"model.free-fallback"`），结果里声明 `model=free-fallback` |
| fallback 也失败 | `turn.failed{auth.credential-expired}` → `blocked`；提示「opencode 生产 key 过期，请到 Console 新建 key（重登录不续期）」；不重试风暴 |

**启用步骤**：① 先跑 `opencode run -m opencode/deepseek-v4.1-flash-free "只回复 OK"` 确认免费链路（零风险）；② `backends.opencode.enabled` 默认已 `true`，`model` 保持生产基线；③ 按 §5.5 V5 跑 smoke，断言免费降级路径可达；④ 用户新建 key 后，重跑 V5 断言 `model` 回到生产基线。

---

## 6. 停用与回滚（含残留清理）

### 6.1 只停某个后端（最快，配置级）

```yaml
# 在 backends: 下把目标后端的 enabled 改为 false，并重启 DSH
        backends:
          kimi:
            enabled: false
            # …其余键保持原值（config 是整段替换，insert 行内不改其他键不受影响）
```

验证：`subagent_agent.backend` 枚举不含 kimi；已有 kimi 会话在 `mocl_status` 中可见但不可再派发（状态按 `session.closed`/`archived` 处理）；进程退出后无残留（§6.5）。

### 6.2 全量停用（保留包，先关行为）

方案 1（关总闸，保留其余配置）：

```yaml
      config:
        global:
          enabled: false
```

方案 2（停用三个插件行，保留包便于再开；两种方案二选一）：

```yaml
- id: mocl-bridge
  disabled: true
- id: tool-subagent-agent
  disabled: true
- id: tool-mocl
  disabled: true
# 同时把 §5.2⑥ 的四个 disabled:true 删除或改回，恢复旧工具行
```

重启后验证：`subagent_codex`/`subagent_claude_code` 重新可见；`subagent_agent` 消失。

### 6.3 全量回滚（卸载 + 恢复原状，目标 ≤5 分钟）

```bash
# 0) 完全退出 DSH
pgrep -fl 'DeepSeek Harness' && echo "先退出 DSH" && exit 1

# 1) 恢复 patch 备份（选最近一个 bak）
ls -t ~/.dsh/profiles/desktop/cordis.patch.yml.bak-* | head -1
cp "$(ls -t ~/.dsh/profiles/desktop/cordis.patch.yml.bak-* | head -1)" \
   ~/.dsh/profiles/desktop/cordis.patch.yml

# 2) 卸载三个插件包
dsh plugin --profile desktop remove @mocl/dsh-bridge \
                                    @mocl/dsh-tool-subagent-agent \
                                    @mocl/dsh-tool-mocl
dsh plugin --profile desktop list        # 期望不再有 @mocl/*

# 3) 残留清理（先确认解析出的绝对路径再删；不要对通配符/未展开变量做 rm -rf）
python3 - <<'PY'
import os
for p in ['~/.mocl', '~/.mocl/state', '~/.mocl/worktrees', '~/.mocl/artifacts']:
    print(os.path.realpath(os.path.expanduser(p)))
PY
# 人工核对输出为 /Users/<you>/.mocl 后再执行：
rm -rf ~/.mocl

# 4) worktree 残留（在受影响的仓库里逐个执行）
git worktree list
git worktree prune
# 若 ~/.mocl/worktrees 下仍有目录：核对 `git worktree list` 无引用后再删

# 5) 进程/端口/文件残留
pgrep -fl 'mocl|codex app-server|kimi acp|opencode serve' || echo NO_MOCL_PROC
ls -l ~/.mocl 2>/dev/null || echo NO_MOCL_DIR          # 步骤 3 已删则无
lsof -U 2>/dev/null | grep -i mocl || echo NO_MOCL_SOCKET
```

重启 DSH；按 §5.5 V3/V4 反向验证（旧代码/工具恢复、seam 设置仍为原值）。

### 6.4 回滚的数据兼容性

| 数据 | 回滚后处理 | 说明 |
|---|---|---|
| `~/.mocl/state/journal.jsonl` | 保留或删除均可；建议保留 1 个版本周期用于审计 | 追加格式，不参与 DSH 启动；删除前确认无待排查会话 |
| 后端会话（codex thread / kimi session / claude session） | **不删除**；它们是产品侧数据 | 回滚后 `mocl_status`/`mocl_*` 不可用，但会话仍留在产品侧（用后端自身 CLI/UI 可访问）；不要用官方 `thread/delete` 批量清 |
| `~/.mocl/worktrees` | 按 §6.3 步骤 4 清理 | 未合入的改动需用户确认；默认不自动删除用户改动 |
| 旧 codex/claude 插件配置 | 恢复 patch 备份即恢复 | 若曾用 GUI 改过 seam 设置，注意用户设置层仍生效（§4.5） |

### 6.5 残留清单（逐项检查，缺一不可）

| 残留类型 | 位置/命令 | 清理方式 | 验收 |
|---|---|---|---|
| 插件包 | `~/.dsh/profiles/desktop/node_modules/@mocl/` | `dsh plugin remove` | `ls` 无 `@mocl` |
| patch 行 | `~/.dsh/profiles/desktop/cordis.patch.yml` | 恢复备份 | `grep -n mocl` 无结果 |
| 数据目录 | `~/.mocl` | `rm -rf`（核对绝对路径后） | 不存在 |
| worktree | `~/.mocl/worktrees` + 各仓库 `.git/worktrees` | `git worktree prune` | `git worktree list` 干净 |
| 进程 | `pgrep -fl 'codex app-server\|kimi acp\|opencode'` | 先 `SIGTERM`，5s 后 `SIGKILL`（只杀带 mocl 标记的进程组，见适配器 INV-L0-5） | 无 pgrep 输出 |
| 端口/套接字 | `lsof -iTCP -sTCP:LISTEN \| grep -E 'codex\|opencode'`；`lsof -U \| grep mocl` | 随进程退出 | 无监听 |
| 环境变量 | `env \| grep -i mocl` | 从启动脚本/launchd 配置移除 | 无输出 |
| 日志/artifact | `~/.mocl/state/*.log`、`~/.mocl/artifacts` | 随数据目录删除 | 不存在 |
| 旧工具恢复 | GUI/会话工具列表 | 恢复旧 patch 后重启 | `subagent_codex`、`subagent_claude_code` 可见 |

---

## 7. 开关矩阵（feature × backend）

> 语义：✅ 原生可用；🟡 降级/仅特定通道；❌ 不可用（由兼容层兜底或拒绝）；「A 下」= 路线 A 的最终行为（Broker 统一执行）。证据列指向适配器规格。

| 能力 | codex | kimi | claude-code | opencode | A 下统一行为 |
|---|---|---|---|---|---|
| 启用默认（D-018） | `false` | `false` | `false` | **`true`** | codex/kimi/claude 显式开启；opencode 默认开启；未开启不进 `backend` 枚举 |
| 续接（Broker 自管） | ✅ `thread/resume`（§4.1） | ✅ ACP `session/load`（§4） | ✅ SDK `resume`（需 `persistSession:true`，§4.2） | ✅ v2 `session` / ACP load（§4，需凭据） | 统一 `session.send(expect=continue)`；不可续时按 R-1 reseed/aborted |
| 中断 | ✅ `turn/interrupt`（§10.2） | ❌ 只能 `killpg`（§10.1） | ✅ `Query.interrupt()`（§10.2） | 🟡 仅 v2 `interrupt?resume=`（§10.1） | 原生优先，否则进程级杀；`interruptMethod` 如实上报（D-008：kimi 一任务一进程） |
| 原生子代理 | ✅ `collabAgentToolCall`（v1，§6） | ❌ ACP 无方法（§6.2） | 🟡 可观测、宿主不能强制派发（§10.3 G1） | 🟡 `parentSessionID`/`childSessionID`（§6，未验证项 U7/U8） | 只透传能力位；深度由 Bridge 校验；不做统一编排语义 |
| 流粒度 | ✅ token 级（14 个 item delta） | ✅ token 级（ACP） | ✅ partial messages（仅 `--print`+stream-json） | 🟡 事件全集未验证 | L3 统一折叠；父级/UI 只见 `progress.folded` |
| 权限档 | ✅ 三维（approval×reviewer×sandbox） | 🟡 4 档但 CLI/ACP 命名错位（§7.1） | ✅ 6 档，CLI/SDK 命名不同（§7.1） | 🟡 ACP 仅 build/plan（§7.1） | 只认三档语义；映射不到 → read-only + warning |
| OS 沙箱 | ✅ `SandboxMode` | ❌ | 🟡 工具级收窄 | ❌（默认全放行） | 外层 worktree + 路径白名单兜底；无沙箱后端禁 yolo |
| worktree 隔离 | ✅ 原生 | ❌ 外层 | ❌ 外层 | 🟡 v2 `/worktree` 端点 | 统一 `worktreeIsolation` 配置；`required-for-write` 默认 |
| 模型路由 | ✅ | ✅ ACP `session/set_model` | ✅ `setModel` | ✅ v2 `/model`（ACP 缺 set_model）；生产 `opencode-go/deepseek-v4.1-flash` / 降级 `opencode/deepseek-v4.1-flash-free`（D-019） | Bridge 策略下发；**降级必须发 `degraded` 事件并声明 `model=free-fallback`**，不静默换模型 |
| 并发硬上限 | ✅ `[agents] max_concurrent_threads_per_session=3` | ❌（证据缺口） | ❌（证据缺口） | ❌（证据缺口） | Bridge 信号量权威（G02/B09），原生上限只作下限修正 |
| 用量 | ✅ tokenUsage + usage | ✅ ACP `usage_update`（coarse） | ✅ cost/usage/modelUsage | ✅ session.list 含 cost/tokens | 统一 `usage.updated`，`precision` 标注，不做计费对账 |
| 危险档（yolo） | 需 `danger-full-access` + worktree | 需 `yolo` + worktree | 需 bypass 类 + worktree | 需 `--auto` + worktree | 双闸（§4.4）；任一不满足 → 拒绝 |

---

## 8. 变更影响面与热加载边界

| 配置类别 | 生效时机 | 影响 | 风险 |
|---|---|---|---|
| 全局/后端 `enabled`、`permissionMode`、`maxConcurrent`、`progress.*` | 重启后**新会话** | 新会话快照；旧会话不变（INV-L5-1） | 误以为热生效 → 用旧档位跑任务；验证命令 `mocl_status.configDigest` |
| GUI 子智能体设置（深度/容量/模型选择） | 下一次委派 | 立即影响新委派（seam README「修改在下一次委派时生效」） | 用户设置覆盖组合配置，排障要看 GUI 值（§4.5） |
| `binaryPath`/`protocol`/`channel` | 重启后新会话 | 等同换传输：必须重跑该适配器 §12 验收 | 旧会话映射可能失效 → orphan 隔离，不自动 attach |
| `journal.*`/`worktree.*` | 重启后 | 路径变更不迁移旧数据 | 旧 journal 留在旧目录；回滚时可读 |
| 工具行（`toolName`/`maxDepth`/`modelSelectionSettings`） | 重启 | 模型可见工具集合变化 → 父会话前缀变化（KV cache 失效一次） | 工具名变更导致历史会话中的旧调用无法重放 |

---

## 9. 待澄清（本文新增）

| ID | 事项 | 说明 | 建议 |
|---|---|---|---|
| D6-C1 | `insert` 行内 `backends.<id>` 的 YAML 结构校验能否在 `--dump-config` 阶段发现拼写错误 | `--dump-config` 只校验 Loader 行结构，插件 config 的 Schema 由插件自己校验（启动时） | C8 必须提供 `schema/config.schema.json` + `mocl doctor --check-config`，并纳入 §5.3 校验链 |
| D6-C2 | 桌面端「完全重启」的可脚本化程度 | Electron 管理 profile，`--dump-config` 被拒；GUI 无命令行重启 | C8 提供 `mocl doctor` 读日志确认生效；文档保留 GUI 路径 |
| D6-C3 | kimi `maxConcurrent:1` 与用户希望并行 kimi 的矛盾 | D-008 裁定一任务一进程（中断语义需要） | 若需并行，开多个 provider 实例（`providerName: kimi-2`）各自一进程，仍受 `global.maxConcurrent` 限制；列入二期 |
| D6-C4 | claude `persistSession:true` 与「只读探测」的隐私边界 | 打开持久化会写 `~/.claude/projects` | 文档明示：正式启用前需用户确认；默认配置不改后端全局设置，由适配器 `session.create` 参数控制 |
| D6-C5 | `env.extra` 是否允许放代理等非秘密变量 | 目前值禁止凭据字面量；非秘密值允许 | C8 的 schema 需给出「允许键名白名单 + 值扫描规则」 |
| D6-C6 | opencode 生产 key 过期且重登录不续期（D-019） | 唯一修法是 Console 新建 key；免费模型可立即验证 | 施工/用户一次性动作：新建 key 并替换 `~/.local/share/opencode/auth.json`；C7 先验 free 路径，再验 production 路径 |

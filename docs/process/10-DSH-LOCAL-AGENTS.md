# 10 — DSH + GitHub + 本地 agent 运行架构

> 目标：把 `docs/process/00`–`09` 的流程落到**真实进程**上：谁在什么目录、用什么命令、读取哪个 prompt、写哪份审计日志、失败时如何降级。
> 实现归属：`orchestrator/` 由 R4 实现（`cli.mjs` + `lib/` + `test/`）；角色 prompt 由本仓库 `agents/roles/*.md` 提供；本文件定义**契约**，实现必须与之对齐。契约不一致时以本文件 + `agents/README.md` 为准并开 issue 修正实现。

## 1. 运行拓扑

```text
用户（只写 issue / 决策 / 验收）
   │  GitHub Issue（.github/ISSUE_TEMPLATE/requirement.yml）
   ▼
GitHub ────── issue + labels（agent:ready / status/*）+ PR + Actions + Release
   ▲                                   │
   │ gh（只读+受控写）                  │ webhook/poll（gh issue list）
   │                                   ▼
┌────────────────────────────────────────────────────────────────┐
│ 本地 orchestrator（node orchestrator/cli.mjs，零依赖，Node ≥24）│
│  intake ─► deliver ─► verify ─► (G5/G6 由角色执行) ─► status    │
│    │          │           │                                    │
│    │          ├─ worktree .worktrees/issue-<n>（隔离写域）      │
│    │          ├─ runner：MOCL_AGENT_CMD（默认 dsh headless）    │
│    │          └─ 审计 .agentspec/runs/<iso>/                    │
│    ▼                                                           │
│  DSH 角色 agent：读 agents/roles/<role>.md 全文 + 实例段         │
└────────────────────────────────────────────────────────────────┘
```

数据流关键点：
1. **GitHub 是状态真源**；本地只缓存（`.agentspec/`），可随时删除重建。
2. **agent 不直接操作 `main`**：所有改动经 worktree → 分支 → PR → G4 → G5 → G6。
3. **合并与发版不在 orchestrator 契约内**（`intake|deliver|verify|watch|status` 五个子命令）；G6 `gh pr merge` 由 release-manager 角色执行，保持「引擎只做可复算的机械动作，人/角色做判定」。
4. 所有外部命令经可注入 `exec`（测试用 fake），禁止散落 `child_process` 直调。

## 2. CLI 契约（R4 实现，本文件为消费方契约）

| 命令 | 语义 | 关键 flag | 退出码 |
|---|---|---|---|
| `node orchestrator/cli.mjs status [--json]` | 列出 `agent:ready` issue、分支/PR 状态、最近 run；只读 | `--repo` `--offline` `--json` | 0 成功；4 环境不可用（无 gh/网络，`--offline` 可读缓存） |
| `node orchestrator/cli.mjs intake --issue <n>` | 读 issue → 生成 `.agentspec/issues/<n>/BRIEF.md` | `--dry-run` `--repo` | 0 成功；1 字段缺失；2 用法错误 |
| `node orchestrator/cli.mjs deliver --issue <n>` | 分支 + worktree + 角色 prompt + runner + 本地门禁 + commit/push/PR | `--dry-run` `--runner mock\|dsh` `--repo` | 0 成功；1 门禁失败；3 重试耗尽/`status/blocked`+`agent:blocked` |
| `node orchestrator/cli.mjs verify --pr <n>` | 干净 worktree 跑 G4 门禁（可选跑 verifier/reviewer 角色） | `--dry-run` `--runner` `--repo` | 0 PASS；1 FAIL；4 环境不可用 |
| `node orchestrator/cli.mjs watch` | 轮询 `agent:ready` 并派发 deliver | `--once` `--interval <s>` `--max <n>` | 0 正常退出；收到 SIGINT 后 0 |

约定：
- 默认 `--max 1`（同时只交付一个 issue，避免写域冲突）；`--once` 执行一轮后退出，便于测试。
- 失败必须把原因写进 issue 评论与 `events.jsonl`，并打 `status/blocked` + `agent:blocked`（连续失败 ≥2 次）。
- `--repo` 缺省从 `gh repo view --json nameWithOwner` 或 `git remote get-url origin` 推断；推断失败 → 退出码 2。
- **标签真源**：`.github/labels.yml`。CLI 读写的标签名必须与其逐字一致（如 `status/in-review`、`agent:ready`），不得硬编码另一套命名。
- **禁止**：force push、直推 `main`、删除分支保护、打印凭据。

## 3. 角色 prompt 的拼装与加载

每次 runner 调用 = **角色文件全文** + **实例段**（不得省略角色文件，不得让模型自由发挥角色）：

```text
<agents/roles/{role}.md 全文>          # 六段式：职责/输入/输出/禁止/完成判据/回报格式
---
## 本次实例
- issue：#<n>
- 角色：<role>　门禁：<G0..G7>
- 工作目录：<worktree 绝对路径>
- 验收口径：<issue AC 原文，截断至 8000 字符>
- 写域：<issue 声明的目录列表>
- 证据落点：<run_dir>/verify/ 或 <run_dir>/logs/
- 返回要求：严格按角色文件「回报格式」输出；不读本仓库之外的路径
---
```

规则：
- 角色文件 ≤ 200 行、实例段 ≤ 8000 字符，总 prompt 建议 ≤ 12k 字符（避免上下文浪费）。
- 角色文件是**唯一角色定义**；orchestrator 不得在代码里另写一套提示词（避免漂移）。
- 角色索引与不变量检查：`node agents/verify-agents.mjs`。
- 角色文件不得包含具体 issue 内容、凭据、个人路径。

## 4. Runner 抽象（`MOCL_AGENT_CMD`）

| 项 | 契约 |
|---|---|
| 默认命令 | `dsh headless "{prompt}"`（本机实测 `dsh --version` = 0.2.1-rc.3；帮助示例 `dsh headless "run the tests"`） |
| 覆盖 | 环境变量 `MOCL_AGENT_CMD` 可替换整个命令模板；测试/无 DSH 环境用 `--runner mock` |
| 占位符 | `{prompt}`（必须整体 shell 转义，禁止拼接注入）、`{cwd}`、`{role}`、`{run_dir}` |
| 执行 | `sh -c <cmd>`，`cwd = worktree`，env 白名单（见 §5） |
| 超时 | `MOCL_AGENT_TIMEOUT` 秒，默认 1800；超时 → 杀进程组，退出码 3，记 `runner.timeout` |
| 成功判定 | 进程 exit 0 **且** stdout 非空；否则记失败并保存 stderr 末 200 行 |
| Mock runner | 内置确定性假执行器：按 fixture 生成改动/PR body，供 `node --test orchestrator/test/` 使用；证据标记 `mode=mock` |

**本机沙箱事实（必须如实告知使用方）**：`dsh headless` 启动时会写 `$DSH_HOME/profiles/headless/cordis.yml`；在 DSH 文件沙箱内该写入被拒，实测报 `Error: EPERM: operation not permitted, open ~/.dsh/profiles/headless/cordis.yml`。因此：
- 在沙箱内（含本仓库的自动化 CI）一律用 `--runner mock` 或 `--dry-run`；
- 真实 `dsh headless` 只能在沙箱外（用户终端）运行，或预先准备可写 profile；
- 文档与报告不得把 mock 证据写成真实执行证据（`00` §2 三态）。

三档证据严格分离：

| 档 | 含义 | 可证明 | 不可证明 |
|---|---|---|---|
| `dry-run` | 只打印步骤，零副作用 | 路径/参数正确 | 任何执行结果 |
| `mock` | 假 runner 跑通全链路 | 编排逻辑/契约 | 模型真实产出质量 |
| `real` | 真 DSH + 真 GitHub | 端到端可用 | 其他环境可复现 |

## 5. 凭据与最小权限

| 主体 | 需要的权限 | 禁止 |
|---|---|---|
| orchestrator | `gh` 已登录（`repo` scope）；本地 git 读写 | 读取/打印 token；把 token 写进 prompt 或日志；`gh auth refresh`（升级 E-03） |
| runner 子进程 | `PATH` `HOME` `LANG` `TZ` `MOCL_*` 白名单 | 透传全部 env（含 `GH_TOKEN`/云凭据）；访问 `~/.ssh` 明文 |
| agent 角色 | 读写 worktree、执行仓库内命令 | 访问仓库外路径、网络写入、改 `main`、改 `.github/**` |
| CI（Actions） | `permissions: contents: read` | 任何写操作（发布 workflow 单独 `contents: write`） |

启动自检（交付前必跑，失败即停）：

```bash
gh auth status                                  # 必须成功
gh repo view --json nameWithOwner               # 必须返回仓库
git status --short                              # 必须为空（干净基线）
node --version                                  # 必须 ≥24
```

## 6. 失败降级（三档，逐级下降且必须声明）

| 档 | 触发 | 行为 | 证据标注 |
|---|---|---|---|
| D0 真实模式 | 凭据/网络/DSH 均可用 | 全自动 | `mode=real` |
| D1 Mock 模式 | 无 DSH/沙箱限制/凭据不可用 | 用 mock runner 跑通编排与门禁，PR 标记「mock 证据」 | `mode=mock` + 交付报告声明 |
| D2 离线手工模式 | GitHub 不可用 | `--offline` 读 `.agentspec/cache/issues/`；生成可手工执行的命令清单交人 | `mode=offline` |

降级规则：
- 降级必须**显式**（日志 + 交付报告 + PR 标签 `evidence:mock`），禁止静默；
- 同一 issue 自动重试 ≤2 次；超过 → `status/blocked` + `agent:blocked` + issue 评论 + 升级（`09` §2 E-09/E-03）；
- 网络恢复后不得自动跳档到 real 而不重跑；必须重新走 G4。

## 7. 审计日志（`.agentspec/runs/`）

目录契约（全部 gitignored，不入公开仓库）：

```text
.agentspec/
├── issues/<n>/BRIEF.md          # intake 产物（需求摘要/AC/风险/非目标）
├── issues/<n>/LOCK              # 派发锁：{pid, ts, issue}，防重复派发
├── cache/issues/<n>.json        # --offline 用的 gh 只读缓存
├── runs/<iso>/                  # 一次 runner 调用 = 一个 run 目录
│   ├── events.jsonl             # append-only 审计事件
│   ├── prompt/<role>.md         # 实际发送的完整 prompt（脱敏后）
│   ├── logs/<G4-ID>.log         # 门禁完整输出
│   ├── verify/{evidence.md,summary.json,redteam.md}
│   ├── DELIVERY-REPORT.md
│   └── escalations.jsonl
└── metrics/<YYYY-MM>.md
```

`events.jsonl` 每行一条，字段契约（有序、必填）：

```json
{"ts":"2026-10-26T10:15:00+08:00","run":"20261026T101500","issue":12,"role":"implementer","phase":"G3","action":"runner.start","cmd":"dsh headless","exit":null,"artifacts":[".agentspec/runs/20261026T101500/prompt/implementer.md"]}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `ts` | string | ISO 8601 带时区 |
| `run` | string | run 目录名 |
| `issue` | number | issue 编号 |
| `role` | string | 8 角色之一 |
| `phase` | string | `G0`–`G7` |
| `action` | string | `runner.start` / `runner.exit` / `gate.run` / `pr.create` / `label.set` / `escalate` |
| `exit` | number \| null | 命令退出码 |
| `artifacts` | string[] | 相关产物相对路径 |

保留期：90 天（`summary.json` 与 `DELIVERY-REPORT.md` 长期保留）；轮转按 run 目录整目录删除。

## 8. worktree 隔离与并发

| 规则 | 实现 |
|---|---|
| 一 issue 一 worktree | `.worktrees/issue-<n>`，分支 `agent/<n>-<slug>` |
| 一 worktree 一写者 | `.agentspec/issues/<n>/LOCK` 存在则拒绝再次派发 |
| 并行上限 | `watch --max <n>`，默认 1；>1 时各 issue 写域必须不相交 |
| 清理 | 合并后 `git worktree remove`；异常退出残留由 `git worktree prune` 清理 |
| 禁止 | 在仓库根直接改文件（必须进 worktree）；跨 worktree 复制未提交改动 |

## 9. 权限边界（引擎能做什么）

| 动作 | orchestrator | 角色 agent | 说明 |
|---|---|---|---|
| 读 issue/PR/CI | 允许 | 允许 | |
| 创建分支/worktree | 允许 | 允许（在 worktree 内） | |
| commit/push `agent/*` | 允许 | 允许 | |
| 开 PR / 评论 / 打 `status/*`、`agent:*` | 允许 | 允许 | |
| 合并 PR | **禁止** | **禁止** | 仅 release-manager 按 G6 执行 |
| 打 tag / 发 Release | 禁止 | 禁止 | 仅 release-manager |
| 改 `.github/**`/`agents/**`/`docs/process/**` | 禁止 | 禁止自行合并 | 命中 E-06，需人批准 |
| 改仓库设置/可见性/权限 | 禁止 | 禁止 | 人操作 |
| 打印/上传凭据 | 禁止 | 禁止 | env 白名单 + 日志脱敏 |

## 10. 上线前自检清单

- [ ] `node agents/verify-agents.mjs` exit 0（8 角色六段 + 11 文档 + G0–G7）。
- [ ] `node --test orchestrator/test/` exit 0（dry-run/mock 全绿）。
- [ ] `node orchestrator/cli.mjs deliver --issue 1 --dry-run` 前后 `git status --short` 一致（零副作用）。
- [ ] `node orchestrator/cli.mjs status --json` 可读；无网络时 `--offline` 打印 SKIP 而非崩。
- [ ] `gh auth status` 成功；`.agentspec/` 与 `.worktrees/` 均在 `.gitignore` 中。
- [ ] 本文件 §1 的「合并/发版不在引擎内」与 R4 README 一致。

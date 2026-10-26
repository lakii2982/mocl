# agents/ — 角色 prompt 索引

> 本目录是**流程 OS 的角色层**：9 个角色的完整提示词，供本地 orchestrator 通过 runner（默认 `dsh headless`）加载执行。
> 流程契约在 `docs/process/`；本目录只放「角色怎么行动」，不放具体 issue 内容、不放凭据、不放个人路径。
> 自检：`node agents/verify-agents.mjs`（exit 0 表示角色六段齐全、流程文档齐全、G0–G7 与 CLI 契约一致）。

## 1. 角色一览

| 角色文件 | 门禁 | 新上下文 | 核心产物 |
|---|---|---|---|
| `roles/product-owner.md` | G0 | 否 | issue 分类标签、受理/退回评论 |
| `roles/pm.md` | G1 | 否 | `.agentspec/issues/<n>/BRIEF.md`、验收口径、`agent:ready` |
| `roles/architect.md` | G2 | 否 | `docs/rfc/NNNN-*.md`、`docs/adr/NNNN-*.md` |
| `roles/workflow-designer.md` | G1.5 | 否 | `.agentspec/issues/<n>/PLAN.md`（切片/验收命令/写域/反例/决策点） |
| `roles/implementer.md` | G3 | 否 | worktree 改动、commit、PR |
| `roles/verifier.md` | G4 | **是** | `.agentspec/runs/<iso>/verify/`、PR 验证评论 |
| `roles/reviewer.md` | G5 | **是** | PR review（approve / request-changes） |
| `roles/release-manager.md` | G6/G7 | 否 | squash merge、tag、Release、发布后验证 |
| `roles/scribe.md` | G7 交付面 | 否 | `DELIVERY-REPORT.md`、`.agentspec/metrics/` |

`verifier` 与 `reviewer` 必须新上下文，且**不得采信作者证据**——见各自角色文件 §1/§4 与 `docs/process/04-VERIFICATION.md` §4。

## 2. 角色文件的不变量（六段式）

每个 `roles/*.md` 必须且只能围绕六段组织（校验器强制）：

| 段 | 必须回答 |
|---|---|
| `## 1. 职责` | 这个角色负责哪些门禁、做什么 |
| `## 2. 输入` | 读哪些文件/命令/证据，路径必须真实存在或由契约定义 |
| `## 3. 输出（产物路径）` | 产物落在哪个具体路径 |
| `## 4. 禁止事项` | 不能做什么（越权/伪造/降级门禁） |
| `## 5. 完成判据` | 可勾选的完成条件（checklist） |
| `## 6. 回报格式` | 一句话状态 + 产物 + 失败/升级 + 未决（≤3） |

新增/修改角色时必须同步更新 `docs/process/00-OPERATING-MODEL.md` §3 RACI 与 §2 门禁表，并跑 `node agents/verify-agents.mjs`。

## 3. orchestrator 如何加载角色

每次 runner 调用 = **角色文件全文** + 实例段（见 `docs/process/10-DSH-LOCAL-AGENTS.md` §3）：

```text
<roles/<role>.md 全文>
---
## 本次实例
- issue：#<n>　角色：<role>　门禁：<Gx>
- 工作目录：<worktree 绝对路径>
- 验收口径：<issue AC 原文，≤8000 字符>
- 写域：<issue 声明的目录列表>
- 证据落点：.agentspec/runs/<iso>/
- 返回要求：按本角色 §6「回报格式」输出
---
```

规则：角色文件是唯一角色定义，orchestrator 代码内**不得**另写提示词；角色文件 ≤200 行；实例段 ≤8000 字符。

## 4. 手工调用（本地调试）

```bash
# 1) 准备 prompt 文件（角色全文 + 实例段）
{ cat agents/roles/verifier.md; printf '\n---\n## 本次实例\n- issue：#1\n- PR：#2\n'; } > /tmp/prompt-verifier.md

# 2) 经 dsh headless 执行（需可写 $DSH_HOME；DSH 文件沙箱内会 EPERM，见 process/10 §4）
dsh headless "$(cat /tmp/prompt-verifier.md)"

# 3) 或不依赖 DSH：用 MOCL_AGENT_CMD 注入执行器
MOCL_AGENT_CMD='node tools/my-runner.mjs --prompt-file {prompt}' \
  node orchestrator/cli.mjs verify --pr 2 --runner dsh
```

本机事实：`dsh --version` = 0.2.1-rc.3；`dsh headless "<prompt>"` 的 profile 准备会写 `$DSH_HOME/profiles/headless/cordis.yml`，在 DSH 文件沙箱内被拒（`EPERM`）。因此沙箱内用 `--runner mock` 或 `--dry-run`；真实执行在沙箱外终端。

## 5. 与流程文档的映射

| 角色 | 主要判据文档 |
|---|---|
| product-owner / pm | `docs/process/01-REQUIREMENT-INTAKE.md` |
| architect | `docs/process/02-DESIGN-RFC.md` |
| implementer | `docs/process/03-IMPLEMENTATION.md` |
| verifier | `docs/process/04-VERIFICATION.md` |
| reviewer / release-manager | `docs/process/05-REVIEW-MERGE.md`、`06-RELEASE.md` |
| scribe | `docs/process/07-DELIVERY-REPORT.md`、`08-METRICS.md` |
| 全体 | `docs/process/00-OPERATING-MODEL.md`、`09-ESCALATION.md`、`10-DSH-LOCAL-AGENTS.md` |
| 标签真源 | `.github/labels.yml`（`agent:ready`、`status/in-review` 等；角色不得自造标签名） |
| 评审模式 | `docs/process/05-REVIEW-MERGE.md` §4：当前单账号模式 = PR 评论 `VERDICT: APPROVE`；转 public/多人后升级为 GitHub review |

## 6. CLI 契约（角色由哪个子命令派发）

| 子命令 | 派发角色 | 说明 |
|---|---|---|
| `node orchestrator/cli.mjs intake --issue <n>` | pm | 生成 `.agentspec/issues/<n>/BRIEF.md` |
| `node orchestrator/cli.mjs deliver --issue <n>` | implementer | worktree + runner + 门禁 + PR |
| `node orchestrator/cli.mjs verify --pr <n>` | verifier / reviewer | 独立复跑 + 评审 |
| `node orchestrator/cli.mjs watch` | 调度器 | 轮询 `agent:ready` 并派发 |
| `node orchestrator/cli.mjs status` | 任何人（只读） | 查看 issue/PR/run 状态 |

详细 flags 与退出码见 `docs/process/10-DSH-LOCAL-AGENTS.md` §2。

## 7. 修改本目录的纪律

1. 改角色 prompt = 改规则 → 命中 `docs/process/09-ESCALATION.md` E-06，需人工批准才能合并。
2. 不得写入具体 issue 编号、真实凭据、绝对个人路径、内部台账路径。
3. 不得放宽门禁表述（如删除「禁止合并」「必须新上下文」）。
4. 改完必须跑 `node agents/verify-agents.mjs`，exit 0 才能提交。

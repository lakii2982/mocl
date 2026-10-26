# 05 — 评审与合并（G5、G6）

> 目标：评审只做一件事——判断「这个 PR 该不该进 `main`」；合并只做一件事——在 required checks 全绿且评审通过后落地。
> 上游：`04-VERIFICATION.md`；下游：`06-RELEASE.md`。
> 原则：写者不自批；评审者看 diff 与证据，不看作者解释；合并动作不可由 implementer 执行。

## 1. 两个门禁的边界

| Gate | 角色 | 决定什么 | 不决定什么 |
|---|---|---|---|
| G5 评审 | reviewer（新上下文） | 代码是否正确、可维护、是否漏测试/文档；是否批准 | 不重跑全部门禁（G4 已完成），不代改代码 |
| G6 合并 | release-manager | required checks 是否全绿、保护分支是否满足；执行 squash merge | 不重新评审设计 |

## 2. 评审检查单（G5，逐项给 PASS/FAIL/N-A）

| # | 检查项 | 判据 | 证据 |
|---|---|---|---|
| R-1 | 与 issue/RFC 一致 | 改动实现验收口径中的每一条；无范围外改动 | diff + AC 对照 |
| R-2 | 正确性 | 边界条件、错误路径、幂等/并发（如涉及）已覆盖；无吞异常 | diff 行号 |
| R-3 | 测试 | 新逻辑有测试；缺陷修复有复现用例；测试断言不是空跑 | `tests/**` diff |
| R-4 | 契约 | ABI/schema/配置变更与 `docs/abi/*`、`tools/sync-schema.mjs --check` 一致 | G4-C3/C4 证据 |
| R-5 | 安全 | 无凭据/个人路径入库；无越权写；无提示注入可执行路径 | `leak-scan` + diff |
| R-6 | 可维护 | 命名/分层符合 `docs/architecture/01-layers.md`；无死代码、无 TODO 逃逸 | diff |
| R-7 | 文档 | 行为/命令/配置变化已同步 docs；文档 PR 不改变事实数字 | docs diff |
| R-8 | 回滚 | PR 描述给出可执行 revert 步骤；高风险变更说明监控方式 | PR body |
| R-9 | 证据 | G4 结论 PASS，YELLOW 项已声明且可接受 | PR 评论 |
| R-10 | 规则自修改 | 若命中 `.github/**`、`agents/**`、`docs/process/**` → 需 `needs-human-review` + 用户评论「批准」 | labels + 评论 |

R-10 是硬门禁：agent 不得批准「修改规则本身」的 PR 代替人。

## 3. Required checks 与保护分支（G6）

保护规则由 `scripts/provision-github.sh` 收敛（幂等；`DRY_RUN=1 bash scripts/provision-github.sh` 可先打印）。**当前现实**：仓库为 private + 单 GitHub 账号（`lakii2982`），GitHub 对个人免费账号的私有仓分支保护返回 **403**，脚本会打印 `WARN` 并继续；此时分支保护不生效，用 §4 的替代判据。转 public 后重跑同一脚本即启用。

| 规则 | 当前（私有 / 单账号） | 转 public 后（目标） |
|---|---|---|
| Require a pull request before merging | 流程纪律强制（GitHub 未强制） | 是 |
| Required approvals | `0`（单账号无法自审，见 §4） | `1` |
| Dismiss stale reviews | —（无 approval 可 dismiss） | 是 |
| Require review from Code Owners | 否（`.github/CODEOWNERS` 已就位但不生效） | 是 |
| Require status checks to pass | 是（私有时可配置；403 则用 §4 本地判据） | 是 |
| Require branches up to date (`strict`) | 是 | 是 |
| Require conversation resolution | 是 | 是 |
| Require linear history | 是 | 是 |
| Allow force pushes | 否 | 否 |
| Allow deletions | 否 | 否 |

required status checks 的 context 必须与 workflow 的 **job display name** 完全一致（名字漂移视为配置缺陷；`node .github/scripts/verify-github-config.mjs` 与 `scripts/provision-github.sh` 都以真实 job 名为准）：

| context（= job display name） | workflow | 覆盖的 G4 门禁 |
|---|---|---|
| `build & contracts (node 24 / pnpm 11)` | `.github/workflows/ci.yml` | C1–C4、C6 |
| `e2e pr-scenario (offline)` | `.github/workflows/ci.yml` | C5 |
| `docs gate` | `.github/workflows/ci.yml` | C7–C9 |
| `pr contract (process-guard)` | `.github/workflows/process-guard.yml` | PR 契约（关联 issue/证据表/conventional title） |

合并前自检命令：

```bash
gh pr checks <n>                                             # 全绿（无 pending/fail）
gh pr view <n> --json mergeStateStatus,reviewDecision,isDraft \
  --jq '{mergeStateStatus, reviewDecision, isDraft}'          # CLEAN / APPROVED 或 NONE（单账号）/ false
node .github/scripts/verify-github-config.mjs                 # 模板/labels/workflow 自洽
```

三条都满足 + §4 的评审判据成立才允许合并。

## 4. 单账号 / 单人维护模式（当前仓库现实）

**平台事实**（决定流程必须这样写，不是偏好）：

1. 仓库目前只有维护者账号 `lakii2982`；GitHub 规定**不能给自己的 PR 提交 APPROVE review**（`gh pr review --approve` 会失败）。
2. 个人免费账号的 **private** 仓不支持分支保护 API（实测 `gh api -X PUT .../branches/main/protection` 返回 403）；`scripts/provision-github.sh` 会 `WARN` 后继续，不中断流程。
3. 因此「评审」不能依赖 GitHub 的 `reviewDecision` 字段；必须有一个**可机械判定的替代证据**，否则 G6 没有门禁。

### 4.1 G5 评审判据（单账号模式）

reviewer 仍必须是**新上下文**且**非本项目作者上下文**；评审结论以 **PR 评论** 形式落地：

```bash
gh pr comment <n> --body-file /tmp/review-<n>.md
```

review 评论 body 必须含（缺一即不算通过）：

```markdown
G5 评审 — <APPROVE|REQUEST_CHANGES>
VERDICT: APPROVE            # 或 VERDICT: REQUEST_CHANGES
- R-1..R-10 逐项：PASS/FAIL/N-A + 证据（path:line / 命令输出）
- 阻断项：0–3 条（无则写「未发现阻断项」并列出已验证项）
- 证据来源：G4 summary.json 路径、PR diff 范围
```

机械校验（G6 前必跑）：

```bash
gh pr view <n> --json comments \
  --jq '[.comments[].body] | map(select(test("VERDICT: APPROVE"))) | length'
# 期望 >= 1
```

禁止：作者自己写 `VERDICT: APPROVE`（reviewer 必须独立上下文）；用编辑历史伪造评审时间；只写「LGTM」而无 R-1..R-10 结论与证据。

### 4.2 G6 合并判据（单账号模式）

必须同时满足，缺一不合并：

| # | 判据 | 命令/证据 |
|---|---|---|
| M-1 | CI 四个 required check 全绿 | `gh pr checks <n>` 无 pending/fail |
| M-2 | process-guard 绿（PR 契约合格） | 同上（context `pr contract (process-guard)`） |
| M-3 | reviewer 评论含 `VERDICT: APPROVE` 且 R-1..R-10 有结论 | §4.1 的 `jq` 命令 ≥1 |
| M-4 | PR head = 已评审的 SHA（评审后无新提交） | `gh pr view <n> --json headRefOid` 与评审评论里的 SHA 一致 |
| M-5 | 分支 up-to-date 且 `git status --short` 干净 | `git fetch && git status --short` |
| M-6 | 不是规则自修改 PR（或已获人批准） | `.github/**`/`agents/**`/`docs/process/**` + `needs-human-review` |

### 4.3 替代强制力与记录

- 单账号模式下没有 GitHub 强制力，靠 **process-guard + CI + 证据协议 + 审计日志（`.agentspec/runs/`）** 替代；每次合并在 PR 评论记录本次判据编号（M-1..M-6）与 reviewer 评论链接。
- 交付报告「已知限制」必须写明本次交付处于单账号模式，评审为 PR 评论 `VERDICT` 而非 GitHub APPROVE。
- **禁止**用 admin 权限绕过（`enforce_admins=false` 不等于允许绕过）；发现即按 `09-ESCALATION.md` E-06 记录并回滚。

### 4.4 升级到标准模式（转 public / 第二维护者到位）

```bash
bash scripts/provision-github.sh            # 幂等：启用保护、required checks、required_approving_review_count
```

升级后 G6 判据增加：`gh pr view <n> --json reviewDecision` = `APPROVED`（GitHub review，不再是评论 VERDICT），且必须由**非作者**账号批准。切换时在 `CHANGELOG.md` 与交付报告记录「评审模式变更」。

## 5. 合并策略（G6）

| 项 | 规则 |
|---|---|
| 方式 | **squash merge**（一个 PR 一个提交，`main` 保持线性） |
| 提交信息 | 默认取 PR 标题（Conventional Commits）；body 保留 PR 编号：`(#<n>)` |
| 分支 | 合并后删除 head 分支；worktree 由 implementer/release-manager 清理 |
| 时机 | required checks 全绿 + 评审判据（单账号：评论 `VERDICT: APPROVE`；多人：`APPROVED`）+ up-to-date；无 pending 会话 |
| 禁止 | admin override、直接 push、force push、merge commit、rebase merge |
| 批量 | 一次只合并一个 PR；后一个 PR 必须 rebase 到最新 `main` 重跑 CI |

命令：

```bash
gh pr merge <n> --squash --delete-branch
git fetch origin && git log --oneline -1 origin/main     # 断言合并提交存在
```

合并后立刻校验：

```bash
gh pr view <n> --json state,mergedAt,mergeCommit --jq '{state, mergedAt, sha: .mergeCommit.oid}'
# 期望 state=MERGED 且 mergedAt 非空
gh run list --branch main --limit 1 --json conclusion,name --jq '.[0]'
# 期望 conclusion=success
```

## 6. 打回规则（G5 FAIL → G3）

reviewer 用 `gh pr review <n> --request-changes --body-file /tmp/review-<n>.md`，body 必须含：

| 字段 | 要求 |
|---|---|
| 位置 | `path:line` 或文件 + 函数名 |
| 问题 | 一句话说清「哪里不对、为什么不对」 |
| 证据 | 命令输出/规范条款/测试缺口 |
| 打回条件 | 修到什么程度可再评审（可判定） |

同时 `gh issue edit <n> --add-label "status/in-progress" --remove-label "status/in-review"`，并在 issue 评论记录「第 k 轮打回」（用于 `08-METRICS.md` 的返工率）。

规则：
- 打回不设配额：0–3 条阻断项，禁止凑数，也禁止"看起来没问题"式放行。
- 作者修复后，PR head SHA 变化 → **G4 必须重跑**（verifier 新上下文），不能沿用旧证据。
- 连续 3 轮打回同一原因 → 升级 Lead/用户（`09-ESCALATION.md` E-04），检查是否需求/设计本身有问题。

## 7. 失败与仲裁

| 情形 | 处理 |
|---|---|
| required check 在 CI 上红、本地绿 | 以 CI 为准；抓 `gh run view <id> --log-failed`，复现环境差异后修 |
| check 卡 pending/queued > 30 分钟 | 记录，重跑 workflow（`gh run rerun <id>`）；仍卡 → 升级 E-03 |
| 评审与验证结论冲突 | 以 G4 命令证据为准；无法判定 → 升级 Lead 仲裁 |
| 需求本身有歧义 | 回 G1 澄清，不在 G5 现场改需求 |
| 需要放宽门禁才能合并 | **禁止**；走 E-06 升级，由用户决定并记录 |

## 8. G5/G6 完成判据

G5：
- [ ] R-1..R-10 每项有 PASS/FAIL/N-A 与证据。
- [ ] 评审结论已落地：单账号模式 = PR 评论含 `VERDICT: APPROVE`（`gh pr comment`）；多人模式 = `gh pr review --approve`（状态 APPROVED）。
- [ ] 打回项（如有）已写成可执行修复指令。

G6：
- [ ] `gh pr checks <n>` 全绿（无 pending / fail / skipped 阻塞项）。
- [ ] `mergeStateStatus=CLEAN`、`isDraft=false`；评审判据满足（单账号：评论 `VERDICT: APPROVE`；多人：`reviewDecision=APPROVED`）。
- [ ] §4.2 的 M-1..M-6 逐条满足，并在 PR 评论记录判据编号与评审评论链接。
- [ ] squash merge 完成，head 分支已删。
- [ ] `main` 上最近一次 CI `success`。
- [ ] issue 已自动关闭（`Closes #<n>` 生效），或手动关闭并写明原因。

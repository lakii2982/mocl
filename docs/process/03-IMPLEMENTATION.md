# 03 — 实现（G3）

> 目标：一个 agent 在隔离 worktree 里把 RFC/设计说明变成可验证的改动，并交出一条可评审的 PR。
> 上游：`02-DESIGN-RFC.md`；下游：`04-VERIFICATION.md`。
> 硬约束：一个 worktree 只允许一个写者；不直推 `main`；不自行合并；不降低门禁。

## 1. 入口条件（缺一不进 G3）

| # | 条件 | 检查 |
|---|---|---|
| E-1 | issue 带 `agent:ready` 且无 `status/blocked` | `gh issue view <n> --json labels` |
| E-2 | DoR 8/8 通过（`01` §3） | issue 评论含 `DoR: 8/8` |
| E-3 | 命中 RFC 触发条件时 RFC 已合并 | issue 评论含 `RFC 0NNN 已合并` |
| E-4 | 写域在 issue 中已声明 | issue 评论 `## 写域` |

任一不满足：停，回报 pm 补条件，不自行猜测。

## 2. 分支与 worktree

| 项 | 规则 | 命令 |
|---|---|---|
| 分支名 | `agent/<issue>-<slug>`（实现）/ `fix/<issue>-<slug>`（缺陷）/ `docs/<issue>-<slug>`（文档） | `git worktree add .worktrees/issue-<n> -b agent/<n>-<slug> origin/main` |
| worktree 路径 | `.worktrees/issue-<n>`（gitignored，不入库） | 同上 |
| 基线 | 从 `origin/main` 最新提交起，禁从旧分支起 | `git fetch origin && git worktree list` |
| 并发 | 同一 worktree 同一时刻只允许一个写者；并行 issue 用不同 worktree | `git worktree list` 无重复路径 |
| 清理 | 合并后 `git worktree remove .worktrees/issue-<n>` | 交付报告记录 |

**写域互斥**：implementer 只改 issue 中声明的目录/文件；需要越界（改公共代码、共享配置、他人切片文件）→ 停手，先在 issue 评论申请并经 pm 同意，再记录到 PR 描述「写域变更」。共享文件的单一写入负责人在 issue 中显式指定。

## 3. Commit 约定（Conventional Commits）

格式：`<type>(<scope>): <subject>`，subject 用中文、≤50 字，body 说明动机与影响，footer 引用 issue。

| type | 用途 | 例子 |
|---|---|---|
| `feat` | 新能力 | `feat(adapter): 支持 kimi session/load 续接` |
| `fix` | 修缺陷 | `fix(broker): 修复幂等账本重复写入` |
| `docs` | 仅文档 | `docs(process): 增加 G4 证据协议` |
| `test` | 仅测试 | `test(abi): 补齐 error 码断言` |
| `refactor` | 不改行为 | `refactor(l2): 抽出事件折叠函数` |
| `chore` | 构建/依赖/CI | `chore(ci): 缓存 node_modules` |
| `perf` | 性能 | `perf(events): 降低折叠内存占用` |

规则：
- 一个 commit 一件事；禁止把格式化噪音与语义改动混在一起。
- footer 必须含 `Refs #<n>`（PR 创建前）；PR body 含 `Closes #<n>`（合并自动关闭 issue）。
- 禁止在 commit message/trailer 写入凭据、个人路径、内部台账路径。
- 已推送分支允许 `git push --force-with-lease`（禁止裸 `--force`），且必须在 PR 评论记录原因；`main` 永不 force push。

## 4. 代码与测试要求

| 要求 | 判据 |
|---|---|
| 语言/模块 | TypeScript ESM（`"type": "module"`）；Node ≥24；零第三方依赖的工具放 `tools/`、`scripts/`、`orchestrator/` |
| 类型 | `pnpm -s typecheck` exit 0；不新增 `any` 逃逸（reviewer 抽查） |
| 测试 | 新逻辑必须有对应测试（`tests/**/*.test.ts` 或 `orchestrator/test/*.test.mjs`）；缺陷修复必须先有复现用例 |
| 覆盖 | 不降低既有覆盖；核心模块目标 ≥80%（`docs/test/00-test-plan.md` §1） |
| 契约 | 触及 ABI/schema 时必须同步 `node tools/sync-schema.mjs --check` exit 0 |
| 安全 | 不打印 env/凭据；不把绝对个人路径写入仓库；新增文件权限默认 0644 |
| 文档 | 行为/命令/配置变更必须同步对应 `docs/**`；`python3 tools/check_docs.py all` exit 0 |
| 依赖 | 新增依赖必须走 RFC（T-3）；禁止为通过测试而引入依赖 |

## 5. 提交前本地门禁（最小集）

在 worktree 内执行，任一失败不得 push：

```bash
node tools/validate-abi.mjs            # exit 0
node tools/sync-schema.mjs --check     # exit 0（触及 schema 时必跑）
pnpm -s typecheck                      # exit 0
pnpm -s test -- --run                  # exit 0（可先跑受影响子集，push 前必须全量）
```

文档类改动额外：`python3 tools/check_docs.py all` 与 `node tools/leak-scan.mjs` exit 0。

## 6. PR 契约

PR 标题与 commit 同格式；body 必须按 `.github/PULL_REQUEST_TEMPLATE.md` 填全，至少含：

| 小节 | 内容 | 判定 |
|---|---|---|
| 关联 issue | `Closes #<n>` | process-guard 自动校验 |
| 变更摘要 | 3–5 条，业务语言 + 文件级影响 | 非空 |
| 验证证据表 | 命令 / 退出码 / 关键输出（可先填本地结果，G4 由 verifier 复跑覆盖） | 表格 ≥1 行且退出码为数字 |
| 风险与回滚 | 风险等级 + revert 步骤 | 非空 |
| 文档更新 | 改了哪些 docs / 无需更新原因 | 非空 |
| Checklist | 类型/测试/文档/无泄漏 四项勾选 | 全勾 |

G3 入口（deliver 启动，取得工作锁）：

```bash
gh issue edit <n> --add-label "status/in-progress" --add-label "agent:running" --remove-label "agent:ready"
```

PR 创建并推送后（进入待验证/评审态；标签真源 `.github/labels.yml`）：

```bash
gh pr create --base main --head "agent/<n>-<slug>" \
  --title "feat(scope): <subject>" \
  --body-file /tmp/pr-<n>.md
gh issue edit <n> --add-label "status/in-review" --add-label "agent:review" \
  --remove-label "status/in-progress" --remove-label "agent:running"
```

之后进入 G4。G4/G5 通过也不撤销 `agent:review`；G6 合并后由 release-manager 在发布完成时改 `status/done`。

## 7. 失败、重试与升级

| 情形 | 动作 | 上限 |
|---|---|---|
| 单测/typecheck 失败 | 定位根因后修复；同一命令失败 ≤3 次 | 3 次后停 |
| 门禁失败但根因在写域外（他人代码/环境） | 评论证据 + 打 `status/blocked` + `agent:blocked` + @owner 升级 | 立即 |
| 同一原因连续 3 轮失败 | 停止，写「已排除什么 / 怀疑原因 / 需要谁」到 issue | 立即 |
| 发现 RFC 不可行 | 回 G2 修订，不在实现中私改契约 | 立即 |
| runner/网络/凭据不可用 | 记录 YELLOW 证据，改用 mock 或本地模式；不得伪造绿 | 立即 |
| 范围膨胀（diff 超 RFC 影响面） | 停手，申请拆 issue 或补 RFC | 立即 |

失败证据格式统一为「命令 + 退出码 + 关键输出前 20 行」贴 issue 评论。

## 8. 完成判据（G3 出口）

- [ ] worktree 在 `.worktrees/issue-<n>`，分支从 `origin/main` 起。
- [ ] 所有 commit 符合 §3，含 `Refs #<n>`。
- [ ] §5 最小门禁在 worktree 内 exit 0（输出已保存到 `.agentspec/runs/<iso>/`）。
- [ ] PR 已创建、body 六小节齐全、`Closes #<n>` 存在。
- [ ] issue label 为 `status/in-review` + `agent:review`，`agent:ready` 与 `agent:running` 已移除。
- [ ] 改动文件全部落在 issue 声明的写域内（越界已记录并获批）。
- [ ] 未修改 `.github/**`、`agents/**`、`docs/process/**`（除非 issue 本就是这三处且已获人批准）。

# orchestrator — MOCL 交付引擎（`mocl-agent`）

把「GitHub issue → 分支/worktree → 本地 agent 执行 → 本地门禁 → commit/push → PR → 评审 → 交付报告」串成一条**可运行、可测试、默认安全**的流水线。

零第三方依赖（只用 Node 内置模块），Node >= 24 ESM。所有外部命令经可注入的 `exec` 执行，因此：

- `--dry-run` 只打印计划、**零副作用**（不联网、不建分支/worktree、不写文件）；
- 测试用 fake `exec`，不依赖网络 / 凭据 / 真实 DSH；
- 真实 runner 默认 `dsh headless`，可用 `MOCL_AGENT_CMD` 替换。

```text
mocl/orchestrator/
├── cli.mjs                    # 入口：status / intake / deliver / verify / watch
├── gates.default.json         # 本地门禁清单（数据，可覆盖）
├── templates/                 # PR body / issue BRIEF / 交付报告
├── lib/                       # 实现（label 真源适配、exit code、流水线）
└── test/                      # node:test（fake exec + 临时目录，零网络；见 §9 的 index.js 说明）
```

## 1. 前置条件

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| Node >= 24 | 运行 CLI / 测试 | 无法运行 |
| `git` | 分支、worktree、commit、push | deliver 失败（`command-failed`） |
| `gh`（已登录，`repo` scope） | 读 issue/PR、创建 PR、打标签、评论 | deliver/status 失败或 `SKIP:offline` |
| `dsh`（`dsh headless`） | 真实 agent runner | `runner-unavailable`；测试用 `--runner mock` 不受影响 |
| `node_modules/.bin/tsc`、`vitest` | 门禁（仅真实 deliver/verify 需要） | 门禁失败；orchestrator 本身无需安装依赖 |

> **不要**为了 orchestrator 跑 `pnpm install`：它没有任何第三方依赖。门禁需要仓库已有 `node_modules`（本仓已具备）。

## 2. 命令

所有命令在 `mocl/`（仓库根）执行。`--repo` 缺省时依次用 `gh repo view`、`git remote get-url origin` 推断。

```bash
# 只读：列出 agent:ready issue 及其分支/PR/最近一次 run
node orchestrator/cli.mjs status --json --repo lakii2982/mocl

# 读取 issue → 生成 .agentspec/issues/<n>/BRIEF.md（需求摘要/验收口径/风险/非目标/待澄清问题）
node orchestrator/cli.mjs intake --issue 12 --repo lakii2982/mocl
node orchestrator/cli.mjs intake --issue 12 --dry-run --repo lakii2982/mocl   # 只渲染并打印

# 自动化核心：分支 + worktree + implementer prompt + runner + 门禁 + commit/push + PR + 交付报告
node orchestrator/cli.mjs deliver --issue 12 --repo lakii2982/mocl
node orchestrator/cli.mjs deliver --issue 12 --dry-run --repo lakii2982/mocl  # 打印全部步骤，零副作用
node orchestrator/cli.mjs deliver --issue 12 --runner mock                    # 离线演练（不调 DSH）

# 验证：本地门禁 +（可选）verifier/reviewer 角色独立评审；输出 PASS/FAIL 与证据目录
node orchestrator/cli.mjs verify --pr 42 --repo lakii2982/mocl --review

# 轮询派发（默认并发 1，可 Ctrl-C 中断）
node orchestrator/cli.mjs watch --repo lakii2982/mocl
node orchestrator/cli.mjs watch --once --max 2 --interval 30                # 只跑一圈
```

退出码（与 [`docs/process/10-DSH-LOCAL-AGENTS.md`](../docs/process/10-DSH-LOCAL-AGENTS.md) §2 对齐）：

| 码 | 含义 |
| --- | --- |
| `0` | 成功 / PASS |
| `1` | 门禁失败 / 校验 FAIL / 可重试的运行失败 |
| `2` | 用法错误 / 仓库推断失败 |
| `3` | 重试耗尽：issue 已打 `status/blocked` + `agent:blocked`，交人工 |
| `4` | 环境不可用：`gh` / 网络 / labels 真源 / runner 不可用 |

```bash
# 快速自查
node orchestrator/cli.mjs --help        # 退出码表 + 全部 flag
```

### dry-run 的语义（重要）

- **不执行任何外部命令**（包括只读的 `gh issue view`）：它们只作为 `[plan] ...` 打印；
- **不创建任何文件/目录**（`.agentspec/`、`.worktrees/` 都不会出现），`git status --short` 不变；
- 无网络、无远端也能 exit 0；issue 内容可用 `--issue-json <fixture.json>` 提供，否则使用**离线桩**并在输出中标注 `issueSource: offline-stub`；
- 计划里的 `gh`/`git` 命令就是真实运行时会执行的同一条 argv（prompt 等长参数按显示截断，实际执行不截断）。

## 3. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MOCL_REPO` | 自动推断 | 等价 `--repo owner/name` |
| `MOCL_RUNNER` | `dsh` | `dsh` 或 `mock` |
| `MOCL_AGENT_CMD` | `dsh headless` | runner 命令模板，见 §6 |
| `MOCL_BASE_BRANCH` | `main` | PR 基线分支 |
| `MOCL_WORKTREE_ROOT` | `.worktrees` | worktree 根目录 |
| `MOCL_GATES_FILE` | `orchestrator/gates.default.json` | 门禁清单 |
| `MOCL_LABELS_FILE` | `.github/labels.yml` | 标签真源（等同 `--labels-file`；缺文件/缺标签 → exit 4） |
| `MOCL_ROLES_DIR` | `agents/roles` | 角色 prompt 目录 |
| `MOCL_MAX_ATTEMPTS` | `2` | 每 issue 最多尝试次数（达到即 `status/blocked` + `agent:blocked`，退出码 3） |
| `MOCL_WATCH_INTERVAL` | `60` | watch 轮询间隔（秒） |
| `MOCL_OFFLINE` | `0` | `1` 等价 `--offline` |
| `MOCL_DRY_RUN` | `0` | `1` 等价 `--dry-run` |

### 3.1 标签真源（不得硬编码第二套命名）

- 真源：`.github/labels.yml`（由流程切片维护）。`orchestrator/lib/labels.mjs` 用零依赖解析器只读 `- name: "..."` 行，运行时校验后导出常量；`issue.mjs` / `deliver.mjs` / `watch.mjs` / `status.mjs` / `prbody.mjs` 全部经它取名字。
- orchestrator 读写/消费的标签：`agent:ready`、`agent:running`、`agent:review`、`agent:blocked`，以及 `status/needs-triage`、`status/needs-info`、`status/accepted`、`status/in-progress`、`status/in-review`、`status/blocked`、`status/done`。
- **fail-closed**：真源缺失、无法解析或缺少上述任一标签 → 命令直接退出码 `4` 并报出缺失标签名；不会回退到任何旧命名。
- 覆盖路径（测试/多仓）: `--labels-file <file>` 或 `MOCL_LABELS_FILE`。
- 派发策略：只处理 `agent:ready` 且不含 `status/blocked` / `agent:blocked` 的 open issue；重试耗尽时**同时**打 `status/blocked` + `agent:blocked` 并从 issue 上移除 `agent:ready`。

凭据**只由 `gh`/`git` 自己读取**：orchestrator 不读取、不传递、不打印任何 token；日志与 `events.jsonl` 经 `lib/redact.mjs` 脱敏（`ghp_*`、`github_pat_*`、`Bearer`、URL 内嵌密码等）。

## 4. 状态与产物（全部本地、不入库）

```text
.agentspec/                     # 运行时创建；内含 .gitignore = "*"（自忽略，不改仓库根 .gitignore）
├── state.json                  # 每 issue 的 attempts / blocked / branch / worktree / PR / lastRun
├── status-cache.json           # status 的成功结果缓存（离线降级用）
├── issues/<n>/BRIEF.md         # intake 产物
└── runs/<iso>[-i<n>|...]/      # 每次运行一个目录（deliver/verify/watch/intake）
    ├── events.jsonl            # 审计日志：每条外部命令 start/ok/fail + 每个 step
    ├── deliver.json            # deliver 汇总
    ├── gates.json              # verify 门禁结果
    ├── pr-body.md              # 实际提交给 gh pr create 的正文
    ├── delivery-report.md      # 交付报告（同时作为 issue 评论）
    ├── blocked-comment.md      # 阻塞原因（同时作为 issue 评论）
    └── verify.md               # 验证报告
.worktrees/issue-<n>/           # 隔离 worktree（同样自忽略）
```

> 仓库根的 `.gitignore` 归打包切片（R1）所有，orchestrator **不修改**它；通过嵌套 `.gitignore`（内容 `*`）保证 `git status --short` 干净。

## 5. `deliver` 流水线步骤

| # | step | 动作 | 失败后果 |
| --- | --- | --- | --- |
| 1 | `resolve-repo` | `--repo` / `gh repo view` / `git remote` | 退出，不计数 |
| 2 | `read-issue` | `gh issue view`（或 `--issue-json`） | 退出，不计数 |
| 1' | `labels` | 校验 `.github/labels.yml`（真源缺失/缺标签 → exit 4） | 退出，不计数 |
| 3 | `preflight` | 标签策略 `agent:ready` 且非 `status/blocked` / `agent:blocked`；`gh pr list --head agent/<n>-<slug> --state open` 幂等检查 | 退出，不计数（`issue-not-eligible` / `duplicate-open-pr`） |
| 4 | `create-worktree` | `git worktree add -b agent/<n>-<slug> .worktrees/issue-<n> <base>` | 退出，不计数 |
| 5 | `build-prompt` | 读 `agents/roles/implementer.md` + issue 上下文 + 工程约束 + 门禁清单；缺文件用内置回退并标 `rolePromptSource: fallback` | 退出，不计数 |
| 6 | `probe-runner` | `dsh --version`（dry-run 只计划；mock 直接 SKIP） | `runner-unavailable` |
| 7 | `run-agent` | `dsh headless "<prompt>"`（prompt 为单个 argv，无 shell） | **计一次尝试** |
| 8 | `gates` | `gates.default.json`：typecheck / test / validate-abi（在 worktree 内） | **计一次尝试** |
| 9 | `commit` | `git add -A` + `git commit -m "feat(issue-<n>): <title>"`；无改动 → `no-changes` | **计一次尝试** |
| 10 | `push` | `git push -u origin <branch>`（force 一律拒绝） | **计一次尝试** |
| 11 | `open-pr` | 渲染 PR 模板 → `gh pr create --body-file ...` | **计一次尝试** |
| 12 | `label-issue` | `gh issue edit --add-label status/in-review --remove-label agent:ready` | PR 已建，仅告警 |
| 13 | `write-report` | 交付报告 → `gh issue comment --body-file ...` | PR 已建，仅告警 |
| 14 | `update-state` | `.agentspec/state.json`：attempts=0、lastStatus=delivered | 仅告警 |

失败处理：

- **尝试计数**从第 7 步开始；失败时 `attempts += 1`。`attempts >= MOCL_MAX_ATTEMPTS`（默认 2）→ 打 `status/blocked` + `agent:blocked`、移除 `agent:ready`、**@issue 作者**评论失败原因与恢复命令，命令退出码 **3**；
- 未达上限时清理失败现场（`git worktree remove --force`、`git branch -D`），下一次可干净重试；`--keep-worktree` 保留现场；
- PR 创建之后的失败不算尝试（避免重复 PR），只告警。

## 6. runner 与命令模板

- 默认：`dsh headless`，prompt **作为最后一个 argv 元素追加**：`spawn("dsh", ["headless", "<prompt>"])`，`shell: false`，引号/换行/`$()`/`;` 全部是字面量。
- `MOCL_AGENT_CMD` 支持引号与 `{prompt}` 占位符：

```bash
MOCL_AGENT_CMD='dsh headless --profile "desk top"'   # prompt 追加为最后一个参数
MOCL_AGENT_CMD='claude -p {prompt} --flag'           # prompt 替换占位符
```

- `--runner mock`：内置假 runner，不启动进程、不联网；`--mock-failures <n>` 可注入连续失败（用于验证重试/阻塞逻辑，见测试）。
- 真实 `dsh` 不可用时：`probe-runner` 失败 → `runner-unavailable`，不会假绿；测试与 dry-run 不受影响。

## 7. 门禁（本地 vs CI 分工）

| 阶段 | 谁跑 | 内容 |
| --- | --- | --- |
| 本地（`deliver` / `verify`） | orchestrator | `gates.default.json`：`tsc --noEmit`、`vitest run`、`validate-abi` |
| CI（PR 上） | GitHub Actions（`.github/workflows/`，R2 交付） | 同一组门禁 + `process-guard`（流程合规） |
| 合并前 | verifier / reviewer（`verify --review`） | 独立上下文复跑门禁 + 只读评审 diff |

- 改门禁：编辑 `gates.default.json`（或 `--gates-file`）。`command` + `args` 是 argv 数组，**不经过 shell**。
- `verify` 的门禁在**当前检出**上运行：请先 checkout PR head（`gh pr checkout <n>`），否则门禁验证的不是 PR 内容；CI 侧由 Actions 保证。
- `--review` 会依次以 `agents/roles/verifier.md`、`agents/roles/reviewer.md` 为 prompt 调用 runner，要求回复首行含 `VERDICT: PASS|FAIL`；reply 缺失 verdict 视为 FAIL（不假绿）。

## 8. 安全模型

1. **只处理**带 `agent:ready` 且不含 `status/blocked` / `agent:blocked` 的 open issue（`--force` 可人工接管）。
2. **幂等**：分支 `agent/<n>-<slug>` 已有 open PR → 拒绝重复创建。
3. **禁止 force push**：`git push -f/--force/--force-with-lease` 在 `lib/repo.mjs` 层直接抛错（不依赖调用方自觉）。
4. **凭据零接触**：不读取 token；日志/事件脱敏。
5. **dry-run 零副作用**：不执行外部命令、不写文件。
6. **审计**：每次运行 `events.jsonl` 记录命令（含 cwd、是否 mutating、退出码、输出尾部）。
7. **边界**：只在 worktree 内改代码；不改 `impl/`、DSH 安装、`~/.dsh`。
8. **可中断**：watch 收到 SIGINT/SIGTERM 后停止派发新任务，等待进行中的任务结束。

## 9. 测试

```bash
cd mocl
node --test orchestrator/test/          # 33 tests, fake exec + tmpdir, 零网络
node --test orchestrator/test/*.test.mjs # 等价形式
```

覆盖（契约要求 6 类）：

| # | 场景 | 文件 |
| --- | --- | --- |
| 1 | dry-run：deliver/intake/verify 零外部命令、零文件、CLI 形态 | `test/dry-run.test.mjs` |
| 2 | 幂等：已有 open PR 时 deliver 拒绝（且未建分支/worktree/PR）；happy path 产出 PR body/报告/state | `test/idempotency.test.mjs` |
| 3 | 重试与 blocked：runner 连续失败，第 2 次后打 `status/blocked` + `agent:blocked`、@owner 评论、现场清理、退出码 3 | `test/retry-blocked.test.mjs` |
| 4 | `watch --once`：只派发 `agent:ready` 且非 blocked，受 `--max` 限制 | `test/watch.test.mjs` |
| 5 | PR body 渲染：`关联 issue / 证据表 / 风险与回滚`、证据表、模板缺段报错 | `test/prbody.test.mjs` |
| 6 | runner 模板注入与转义：`MOCL_AGENT_CMD` 引号解析、`{prompt}`、prompt 单 argv；角色 prompt 文件/回退 | `test/runner-cmd.test.mjs` |
| 7 | **标签真源对齐**：8+ 常量逐字存在于 labels.yml、源码无旧命名、labels.yml 缺标签时 CLI exit 4（含标签名）、`MOCL_LABELS_FILE` 覆盖生效 | `test/labels.test.mjs` |
| 8 | **退出码契约**：0/1/2/3/4，重试耗尽 → 3、无 gh/无缓存 → 4、有缓存 SKIP → 0、仓库推断失败 → 2 | `test/exit-codes.test.mjs` |

> Node 24 不再把位置参数当目录展开（`node --test orchestrator/test/` 会尝试把目录当模块加载）。`orchestrator/test/index.js` 是该目录的入口 shim，逐个 import `*.test.mjs`，从而保持契约命令可用。新增测试文件时记得同步 import，或用 `node --test orchestrator/test/*.test.mjs`。

## 10. 故障排查

| 现象（`code`） | 原因 | 处理 |
| --- | --- | --- |
| `issue-not-eligible` | 缺 `agent:ready` 或带 `status/blocked` / `agent:blocked` | 修标签；人工接管加 `--force` |
| `labels-unavailable` / `labels-incomplete`（exit 4） | `.github/labels.yml` 不可读或缺少必需标签 | 修真源（或 `--labels-file`）；不要把标签名硬编码到别处 |
| exit 3 | 连续失败耗尽重试（默认 2 次） | 看 `blocked-comment.md`；修复后移除 `status/blocked` + `agent:blocked` 并重加 `agent:ready` |
| exit 4（status） | 无 gh/网络且无 `.agentspec/status-cache.json` | 联网跑一次 `status` 生成缓存，或接受 4 作为 CI 的「环境不可用」信号 |
| `duplicate-open-pr` | 同分支已有 open PR | 复用/关闭既有 PR；不要重复创建 |
| `repo-unresolved` | 无 `--repo` 且无 `origin` remote | 传 `--repo owner/name` |
| `runner-unavailable` | `dsh --version` 失败 | 安装/修正 `MOCL_AGENT_CMD`；或用 `--runner mock` 演练 |
| `agent-run-failed` | runner 非零退出 | 看 `events.jsonl` 的 `stderrTail`；修 prompt/环境后重试 |
| `gates-failed` | 门禁失败 | 在 `.worktrees/issue-<n>` 里复跑报告中的命令 |
| `no-changes` | agent 没有产生改动 | 检查 issue 范围/prompt；重试 |
| `pr-create-failed` | `gh` 权限/分支未推送 | `gh auth status`；看 `stderrTail` |
| `command-failed` | `gh`/`git` 非零退出 | 事件日志里有完整命令与 stderr 尾部 |
| `SKIP:offline`（status） | 无网络/无 gh 权限 | 读 `.agentspec/status-cache.json`；联网后重跑 |
| `status` 一直 SKIP | 从没成功联网跑过 | 联网执行一次 `status` 生成缓存 |
| watch 不派发 | issue 列表为空/标签不符/本地 state 已 blocked | `status --json` 查看每条的 skipped 原因 |

## 11. 回滚一次 agent 运行

**未创建 PR（失败/中断）**

```bash
# dry-run 输出与失败日志里会打印同样的命令
git worktree remove --force .worktrees/issue-<n>   # 删隔离工作区
git branch -D agent/<n>-<slug>                     # 删本地分支（未推送）
rm -rf .agentspec/runs/<run-id>                    # 删本次证据（可选）
```

**已创建 PR 但未合并**

```bash
gh pr close <pr> --delete-branch                   # 关闭 PR 并删远端/本地分支
git worktree remove --force .worktrees/issue-<n>
gh issue edit <n> -R <owner/name> --remove-label status/in-review --add-label agent:ready
```

**已合并**

```bash
git revert -m 1 <merge-commit> && git push         # 或从 main 新开 revert PR
gh issue edit <n> -R <owner/name> --remove-label status/in-review
```

**被阻塞的 issue 重新入队**

```bash
gh issue edit <n> -R <owner/name> --remove-label status/blocked --remove-label agent:blocked --add-label agent:ready
# 或人工接管：node orchestrator/cli.mjs deliver --issue <n> --force
```

## 12. 与 R2/R3 的接口与已知限制

- **角色 prompt**：只读 `agents/roles/{implementer,verifier,reviewer}.md`（R3 写域）。文件缺失 → 内置回退文案，所有产物标注 `rolePromptSource: fallback`，不会静默冒充正式角色契约。
- **PR 模板**：使用 `orchestrator/templates/pr-body.md`（不依赖 R2 的 `.github/PULL_REQUEST_TEMPLATE.md`），但保持相同的「关联 issue / 证据表 / 风险与回滚」结构。
- **合并**：orchestrator 不自动 merge —— 合并由 CI 绿 + verifier/reviewer PASS 后人工/GitHub 分支保护完成（判定权分离）。
- **并发**：`watch --max` 的并发在**同进程**内安全（`state.json` 读改写有进程内锁）；不要在同一工作区并行跑多个 orchestrator 进程。
- **`verify` 的工作副本**：默认验证当前检出；PR head 需先 checkout（或交给 CI）。
- **真实 `dsh` 端到端**：本仓测试只验证命令拼装与 mock 路径；真实 runner 需要可用 DSH 凭据，属 R7 演练范围，不在单测里假绿。

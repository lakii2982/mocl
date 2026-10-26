# 04 — 验证（G4）

> 目标：用**独立上下文**把「改动真的满足验收口径」变成一组可复跑的命令证据。验证者不看作者解释，只认命令、退出码与断言。
> 上游：`03-IMPLEMENTATION.md`；下游：`05-REVIEW-MERGE.md`。
> 铁律：**没有外部检查的产物不算交付**；`SKIP` 不是 `PASS`；不能复现的结果一律记 FAIL 或未覆盖。

## 1. 证据协议（每条证据必须同时具备 6 项）

| # | 要素 | 要求 | 反例 |
|---|---|---|---|
| 1 | 命令 | 可直接复制执行的一行（含工作目录） | 「跑了测试」 |
| 2 | 退出码 | 真实数字（`0` / 非 0） | 「通过」 |
| 3 | 原始输出 | 关键行原文（首尾各 ≤20 行），不得改写 | 「结果正常」 |
| 4 | 上下文 | commit SHA（PR head）+ Node/OS 版本 | 无 SHA 的截图 |
| 5 | 位置 | 完整日志路径 `.agentspec/runs/<iso>/logs/<id>.log` | 只在聊天里贴 |
| 6 | 时间 | `YYYY-MM-DDTHH:MM:SS+08:00` | 无时间戳 |

统一格式（PR 评论、交付报告、`verify/` 记录同构）：

```markdown
| ID | 命令 | 退出码 | 关键输出（原文） | 完整日志 |
|---|---|---|---|---|
| G4-C3 | `node tools/validate-abi.mjs` | 0 | `ALL CHECKS PASSED (46/34/35/18)` | `.agentspec/runs/20261026T101500/logs/G4-C3.log` |
```

**禁止**：把作者 run 目录里的输出复制成自己的证据；把 `--dry-run` 记成真实执行；把历史绿贴成当前绿；用「我检查过了」代替命令。

## 2. 门禁清单（G4 全量，按序执行）

在 PR head 的**独立 worktree** 内、仓库根目录执行（`<repo>` = 开源仓根）。

| ID | 门禁 | 命令 | 期望（阻塞） | 失败含义 | 归属 |
|---|---|---|---|---|---|
| G4-C1 | 类型 | `pnpm -s typecheck` | exit 0，无 `error TS` | 类型契约破坏 | 仓库 |
| G4-C2 | 单测 | `pnpm -s test -- --run` | exit 0，`Test Files ... passed` 且 0 failed | 行为回归 | 仓库 |
| G4-C3 | ABI 一致性 | `node tools/validate-abi.mjs` | exit 0，输出含 `ALL CHECKS PASSED (46/34/35/18)` | ABI 计数漂移 | 仓库 |
| G4-C4 | schema 同步 | `node tools/sync-schema.mjs --check` | exit 0（无 diff） | schema 副本与真源不一致 | 仓库 |
| G4-C5 | 端到端（离线） | `node e2e/pr-scenario.mjs` | exit 0，`e2e/out/report.json` 断言通过 | 编排主链路回归 | 仓库 |
| G4-C6 | 插件构建 | `node tools/build-plugin-package.mjs` | exit 0，产物目录生成 | 打包链路坏 | 仓库 |
| G4-C7 | 文档 | `python3 tools/check_docs.py all` | exit 0 | 文档结构/计数/要素缺失 | R1 |
| G4-C8 | 泄漏 | `node tools/leak-scan.mjs` | exit 0（白名单外零命中） | 个人路径/凭据/内部台账泄漏 | R1 |
| G4-C9 | 流程资产 | `node agents/verify-agents.mjs` | exit 0 | 角色/流程文档缺段 | R3 |
| G4-C10 | GitHub 工程 | `node .github/scripts/verify-github-config.mjs` | exit 0 | 模板/labels/workflow 不自洽 | R2 |
| G4-C11 | 本地引擎 | `node --test orchestrator/test/` | exit 0，`pass N` / `fail 0` | 交付引擎回归 | R4 |

补充规则：
- C5 默认离线档（零额度、零网络）；`MOCL_LIVE=1` 属 live 档，不在 PR 门禁内跑。
- C7/C8/C9/C10/C11 是「新增门禁」，在对应切片未合并前若文件不存在 → 记 `YELLOW：门禁未就绪（归属 <切片>）` 并在 PR 与交付报告声明；**不得**因此判 PASS。
- 文档类 PR（只改 `docs/**`、`*.md`）：C1 可 SKIP（无 TS 改动）并声明，C7/C8 必跑。
- 触及 ABI/schema 的 PR：C3+C4 必跑且必须与 C7 中计数断言一致。

## 3. 判定：绿（PASS）/ 红（FAIL）/ 黄（YELLOW）

| 判定 | 条件 | 处理 |
|---|---|---|
| **绿 · PASS** | 命令 exit 0 **且** 期望断言成立 | 记入证据表 |
| **红 · FAIL** | exit ≠ 0，或 exit 0 但断言失败/输出不含期望串 | 阻塞 G4，回 G3，证据贴 PR 并 `--request-changes` |
| **黄 · YELLOW** | 命令因环境缺失无法执行（无凭据/无网络/依赖未就绪/平台不符） | 不阻塞但必须：① 写明原因与已尝试命令；② 在 PR 与交付报告「已知限制」列出；③ 该验收项记「未覆盖」 |

YELLOW 的三种合法理由（其余一律 FAIL）：缺 `gh` 认证（`gh auth status` 非 0）；网络受限导致远端不可达；门禁脚本归属切片尚未合并。三者都必须并入交付报告，且不得影响最终用户验收判定。

## 4. 独立验证规则（verifier 必须遵守）

1. **新上下文**：verifier 由新会话启动，只接收 PR 编号、issue 编号、验收口径与本文路径；不接收 implementer 的总结。
2. **不采信作者证据**：作者在 PR body 里的证据表只作对照，verifier 必须自己跑一遍；未重跑项记「未覆盖」。
3. **干净基线**：新建独立 worktree 检出 PR head SHA：
   ```bash
   git fetch origin "pull/<n>/head:pr-<n>" && git worktree add ".worktrees/verify-<n>" "pr-<n>"
   cd ".worktrees/verify-<n>" && git status --short   # 必须为空
   ```
4. **前后一致性**：全部门禁跑完后 `git status --short` 必须仍为空；出现改动 → 说明门禁有副作用，记 FAIL 并回报。
5. **不改产物**：验证期间禁止 `git checkout`/`stash`/格式化/`--fix`；发现需要修复 → 回 G3，不代修。
6. **逐条对照 AC**：issue 的每个验收项（AC-1..AC-k）都要给 PASS/FAIL/未覆盖；不允许只跑总门禁不验 AC。
7. **反例抽检**：至少构造 1 条反例证明门禁真的会红（如：临时改坏一个 schema 副本后 `sync-schema --check` 应非 0；给临时文件写入一条绝对个人路径（形如 `<user-home>/…`）后 leak-scan 应非 0）。反例在 `/tmp` 副本上做，**不污染仓库**，完成后删除。反例结果记入 `verify/redteam.md`。
8. **重试纪律**：同一命令最多重试 1 次，且仅当怀疑瞬时故障（网络/端口占用）；重试必须记录两次输出。
9. **时间盒**：单 PR 验证 ≤30 分钟；超时 → 记录已跑项与未跑项，回报 Lead 决策，不静默截断。

## 5. 产物与落点

```text
.agentspec/runs/<iso>/                 # <iso> = 20261026T101500 形式，本地时区
├── events.jsonl                       # orchestrator 审计事件（append-only）
├── verify/
│   ├── evidence.md                    # §1 表格（完整）
│   ├── redteam.md                     # §4.7 反例结论
│   └── summary.json                   # {pr, sha, verdict: PASS|FAIL, yellow: [], failed: []}
└── logs/<ID>.log                      # 每条门禁的完整原始输出（含 stderr）
```

`summary.json` 字段契约：

```json
{
  "pr": 12,
  "sha": "<pr head sha>",
  "verdict": "PASS",
  "gates": [{"id": "G4-C3", "exit": 0, "status": "PASS"}],
  "yellow": [{"id": "G4-C10", "reason": "verify-github-config.mjs 尚未合并（R2）"}],
  "failed": [],
  "ac": [{"id": "AC-1", "status": "PASS"}]
}
```

`verdict` 取值仅 `PASS` / `FAIL`；存在 YELLOW 时 `verdict` 可为 PASS，但 `yellow[]` 非空且必须进入交付报告。

## 6. PR 评论格式（verifier 唯一对外输出）

```markdown
## G4 独立验证 — <PASS|FAIL>

- PR：<n>　head SHA：<sha>　验证者：verifier（新上下文）
- 环境：Node <ver> / <os>

| ID | 命令 | 退出码 | 关键输出 | 证据 |
|---|---|---|---|---|

### 验收口径对照
| AC | 结论 | 证据 |
|---|---|---|

### YELLOW（未覆盖）
- <ID>：<原因>；已尝试：<命令>

### 反例抽检
- <反例>：期望红 / 实际 <结果>

### 结论
<通过/不通过>；不通过时列最小复现步骤。
```

## 7. 常见错误（红队视点）

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 只跑总门禁不验 AC | 需求可能没实现 | §4.6 逐条对照 |
| 作者在自己 worktree 跑完当证据 | 环境/状态污染 | 独立 worktree + 干净 SHA |
| 用 `--dry-run` 输出当真实执行 | 假绿 | dry-run 只能证明路径，不能证明结果 |
| 把 `YELLOW` 写进 PASS 行 | 隐藏未覆盖项 | §3 三态分离 |
| 为了绿而跳过失败用例 | 门禁失效 | 升级 E-06，禁止自行放宽 |
| 反例污染仓库 | 破坏证据 | 用 `/tmp` 副本 |

# MOCL 发布前场景回归（`scenarios/`）

> 这里放的是**模拟人类使用逻辑**的端到端场景，不是单元测试的替代品。
> 每次正式发布（打 `v*` tag）前跑一遍；`release.yml` 已把它接成发布门禁。

## 1. 为什么单独一套

现有测试按层组织（`tests/` 是 L0–L3 单元/契约/回放，`e2e/` 是 PR 演练）。
它们能证明「每个零件对」，但证明不了「一个真人按文档用起来会不会踩坑」。本套件只做三件事：

1. **按人物走完整路径**：装好 → 开开关 → 派活 → 看进度 → 追问 → 叫停 → 重启 → 回滚；
2. **在工具面验证**：走 `apply(ctx)` → `subagent_agent` / `mocl_status`，而不是直接调内部函数；
3. **发布门禁可签收**：产出一份 JSON + Markdown 签收单，任何一条失败都非 0 退出。

默认**完全离线、零额度**：后端用 `scenarios/lib/fake-backends.mjs` 的假件，
所以可以在 CI、飞机上、没有 key 的机器上跑。真实后端 smoke 是 opt-in（`--live`）。

## 2. 快速开始

```bash
# 全部：11 个人类场景 + 发布一致性 + 11 条仓库门禁（约 15s）
node scenarios/run.mjs

# 只跑人类使用路径
node scenarios/run.mjs --scope=usage

# 只跑发布门禁 + 一致性检查
node scenarios/run.mjs --scope=repo

# 指定场景（大小写不敏感）
node scenarios/run.mjs --only=S02,S03,G01

# 发布签收：已知缺口也阻塞（见 §5）
node scenarios/run.mjs --strict-known

# 额外跑真实后端 live smoke（会消耗额度；缺少凭据的后端由测试自身 skip）
node scenarios/run.mjs --live
```

退出码：

| 码 | 含义 |
|---|---|
| `0` | 全部场景/门禁通过（已知缺口默认不阻塞） |
| `1` | 有场景或门禁失败；或 `--strict-known` 下仍有已知缺口 |
| `2` | 用法/环境错误（参数非法、报告无法生成） |

产物（已被 `.gitignore` 忽略）：

- `scenarios/out/release-report.json` —— 机器可读，含每条断言、耗时、证据；
- `scenarios/out/release-report.md` —— 发布签收单；
- `scenarios/out/logs/` —— 场景与门禁的完整原始输出；
- `scenarios/out/artifacts/` —— 场景现场（状态快照、脱敏后的可观测面）；
- `scenarios/tmp/` —— 临时 git 仓库/会话目录（默认跑完删除，`--keep` 保留）。

## 3. 场景清单

| ID | 人物 | 场景 | 关键断言 |
|---|---|---|---|
| S01 | 刚 clone、没改配置的新用户 | 冷启动 | 默认四后端全关；`subagent_agent` 被 `policy.permission-denied` 拒绝；不建会话、不写文件；只开 `global.enabled` 仍不够 |
| S02 | 按文档启用 codex 的开发者 | 第一个只读任务 | 派发立即返回 childId；终态 completed；用量/父级投递（≤1）/进度硬上限；工作区 `git status` 零变化 |
| S03 | 拿到结论后继续追问的人 | 第二轮 + cursor 增量 | 复用同一 childId/远端 id；cursor 只返回新事件、读取幂等；父级每轮 ≤1 条终态 |
| S04 | 发现子代理卡住的人 | 中断 + 关闭 + 槽位 | interrupt 到达适配器；终态 aborted；close 幂等；runtime=1 时关掉后还能再开 |
| S05 | DSH 重启后回来找结果的人 | 会话发现 + 续接 | `lost` 状态如实上报；远端 id 不丢；远端不存在时报 `session.not-found`；不重复建会话 |
| S06 | 一次开多个子代理的人 | 并发刹车 | 上限来自运行时（非硬编码）；超限 `limit.concurrency-exceeded` 且可重试；关一个能再开；改设置立即生效 |
| S07 | 好奇/手滑的人 + 写错配置的运维 | 权限与参数护栏 | yolo/越界深度/相对 cwd/空任务/错 backend 全按 ABI 码拒绝；显式三开关后才允许 yolo；配置硬上限启动即失败 |
| S08 | 接入四个后端的负责人 | 四后端巡检 | 四后端都能完成；kimi pending id 不假装 bound；opencode 降级有 `degraded`+warning；能力位 34 |
| S09 | 在 env/任务里放了 key 的维护者 | 密钥卫生 | 配置错误信息只带键名不带值；任务里的密钥不被 status/list/注册表回显；digest 不展开 env |
| S10 | 试用后回滚的人 | 回滚与残留 | 关开关后派发/查询都拒绝；注册表保留；适配器已关闭；patch 声明不变 |
| S11 | 准备打 tag 的发布经理 | 发布一致性 | 版本=CHANGELOG；ABI 46/34/35/18；README 中英计数一致；`config.default.json`=引擎默认；patch 声明 2 工具 + 4 旧行停用 |
| S12 | 按文档打开后端的用户 | 真实装配自检 | 不注入假件时四后端都能装配（当前 opencode 失败，见 KI-01） |

S11 属于 `repo` scope，只在 `--scope=repo|all` 下运行。

## 4. 发布门禁

全部是仓库里已有的命令；套件只负责串行执行、保留原始输出、统一判定：

| ID | 检查 | 命令 |
|---|---|---|
| G01 | ABI 契约 46/34/35/18 | `node tools/validate-abi.mjs` |
| G02 | schema 逐字节一致 | `node tools/sync-schema.mjs --check` |
| G03 | 文档结构/计数/链接 | `python3 tools/check_docs.py all` |
| G04 | 公开仓泄漏扫描 | `node tools/leak-scan.mjs` |
| G05 | GitHub 工程配置 | `node .github/scripts/verify-github-config.mjs` |
| G06 | 校验器自检 | `node .github/scripts/verify-github-config.mjs --self-test` |
| G07 | 严格类型检查 | `pnpm -s typecheck` |
| G08 | 单元/契约/回放 | `pnpm -s test` |
| G09 | 离线 PR 演练 | `node e2e/pr-scenario.mjs` |
| G10 | 构建插件包 | `pnpm -s build:plugin` |
| G11 | 版本一致性 | `node .github/scripts/release-notes.mjs --tag v<version> --package package.json --check` |
| GL1 | live smoke（仅 `--live`） | `MOCL_LIVE=1 pnpm exec vitest run tests/adapters/*/live*.test.ts` |

> **G08 的收集范围**：`vitest.config.mjs` 只收集 `tests/**/*.test.ts`；
> `orchestrator/test/*.test.mjs` 属于独立的 `node:test` 套件，用自己的命令跑。
> 两条套件不要混跑（vitest 会把 `node:test` 文件判成 "No test suite found"）。

## 5. 已知缺口政策（`known-issues.json`）

现实里有些缺口已经存在、但本轮发布来不及修。本套件不允许「跳过」或「改期望值」来假装通过，而是用基线显式登记：

- 场景里 `ctx.knownIssue("KI-xx", observed, detail)`：
  - `observed=true` → 场景状态 `KNOWN`，默认**不阻塞**，但在终端/报告里显著列出；
  - `observed=false` → **判失败**，提示「缺口已修复，请删除基线条目并改回硬断言」。
- 基线文件：`scenarios/known-issues.json`（每条含 severity / owner / evidence / recheck）。
- `--strict-known`：有任何仍存在的缺口即退出 1。**正式发布签收建议用这个模式**；
  有 `blocker` 时必须先修，不能带病发版。

当前基线（2026-10-26，v0.1.0）：

| ID | 严重级 | 缺口 |
|---|---|---|
| KI-01 | blocker | opencode 真实装配路径抛 `TypeError: OpenCodeAdapter(http) requires options.http` |
| KI-02 | major | 宿主重启后 `facade.resume()` 不回填运行时，`send` 仍 `session.not-found` |
| KI-03 | major | 工具面只有 `subagent_agent` / `mocl_status`，缺 send/resume/interrupt/close |
| KI-04 | minor | `mocl_status` 不暴露能力位（F6） |
| KI-05 | major | per-backend `env` 自由键被配置校验判为 unknown key，凭据无法注入 |
| KI-06 | minor | `facade.send()` 返回值沿用上一轮终态，轮询方可能误判完成 |

这些是**产品缺口**，不是测试环境问题。修好后对应场景会自动提示删条目。

## 6. live 模式

```bash
MOCL_LIVE=1 node scenarios/run.mjs --scope=repo --only=GL1   # 或 --live
```

- 只在显式 `--live` / `MOCL_LIVE=1` 时运行；
- 复用 `tests/adapters/*/live*.test.ts`：模型不可用/额度不足会标 `skipped`，**不会假绿**；
- opencode 的 HTTP live 还需要 `MOCL_OPENCODE_URL` 与服务密码（见 `tests/adapters/opencode/live.test.ts`）；
- live 结果只作 supplement：离线场景 + G01–G11 仍是每次发布的硬门禁。

## 7. 边界（本套件不承诺什么）

- **不替代** L0–L3 单元/契约测试、`e2e/` 的 git worktree 演练；
- **不模拟**真实协议帧（假件只产出 ABI 事件），协议漂移由 `tests/fixtures` 与 live smoke 覆盖；
- **不检查**后端原生错误文本的内容过滤（例如上游把 key 回显在 message 里）；
- **不覆盖**多会话共用同一后端适配器的并发路由（假件按「一个后端一个活跃会话」建模；
  S06 用不同后端表达并发）；
- **不修改** 被测代码。发现缺口走基线 + 报告，不在测试里偷偷绕过。

## 8. 新增一个场景

1. 在 `scenarios/cases/` 新建 `NN-<slug>.mjs`，默认导出：

```js
export default {
  id: "S13",
  scope: "usage",              // usage | repo
  title: "一句话场景",
  persona: "谁在什么处境下",
  goal: "这条场景要保住什么",
  async run(ctx) {
    const repo = await ctx.repo();            // 懒建临时 git 仓库
    const stack = await createStack({ ... }); // 门面 + DSH 工具面
    ctx.assert("名字", condition, detail);    // 唯一判定入口
    await ctx.assertUnchanged("repo:no-writes", repo, before);
    await ctx.artifact("status.json", status); // 证据落盘
  },
};
```

2. 失败必须能归因：断言名用 `域:行为`（如 `cursor:no-overlap`），detail 带实际值；
3. 不写死用户绝对路径/凭据（`leak-scan` 会拦）；
4. 跑 `node scenarios/run.mjs --only=S13` 自测；
5. 如果发现新缺口：先修，或登记 `known-issues.json` 并在场景里 `knownIssue`，二选一。

## 9. 排障

| 现象 | 先看 |
|---|---|
| 场景超时 | `scenarios/out/logs/<ID>.log`；假件是否 `hangOnSend`；轮询是否只看 `state`（见 KI-06） |
| `known-issue:KI-xx:fixed` 失败 | 缺口已修：删基线条目，把 `knownIssue` 改成硬 `assert` |
| 「工作树不干净」提示 | 本地未提交改动；正式发布必须从 tag/干净工作树跑 |
| G08 失败但 `pnpm test` 也失败 | 先分辨是 `tests/` 还是 `orchestrator/`（见 §4 说明） |
| GL1 全 skipped | 本机缺 CLI/凭据/服务；这是 skip 不是 pass，发布前需人工确认覆盖范围 |

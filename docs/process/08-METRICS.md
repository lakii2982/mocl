# 08 — 度量（Metrics）

> 目标：用 GitHub 与本地运行日志**机械采集**过程指标，用于发现瓶颈，而不是考核人。
> 铁律：**没有采集到就是 `UNCOLLECTED`**，禁止估算、禁止编造趋势、禁止把目标值写成实测值。
> 数据源：GitHub API（`gh`）+ `.agentspec/runs/**/events.jsonl`（orchestrator 审计日志，gitignored）。

## 1. 指标定义（全部可机械采集）

| ID | 指标 | 定义/公式 | 数据源 | 采集命令 |
|---|---|---|---|---|
| M-1 | 交付周期 lead time | 从 issue 打 `agent:ready` 到 PR `mergedAt` 的中位小时数 | issue timeline + PR | `gh pr list --state merged --json number,createdAt,mergedAt,closingIssuesReferences` |
| M-2 | CI 通过率 | CI `success` 次数 / CI 总运行次数 | Actions runs | `gh run list --workflow ci.yml --limit 100 --json conclusion` |
| M-3 | 一次通过率 | G4 首轮 PASS 的 PR 数 / 进入 G4 的 PR 数 | `verify/summary.json` | 见 §2 脚本 |
| M-4 | 返工率 | 被打回 ≥1 次的 PR 数 / 总 PR 数 | PR review 事件 | `gh pr list --state all --json number,reviews` |
| M-5 | 评审轮次 | 每 PR 的 `CHANGES_REQUESTED` 次数中位数 | PR reviews | 同上 |
| M-6 | 门禁稳定性 | 同一 PR 上 FAIL 的门禁 ID 分布（按 ID 计数） | `verify/summary.json` | §2 |
| M-7 | 测试趋势 | `pnpm -s test` 的 `Test Files/Tests` 通过数 与失败数 | G4-C2 日志 | `.agentspec/runs/**/logs/G4-C2.log` |
| M-8 | 覆盖趋势 | 覆盖率（若启用 coverage 报告） | coverage 输出 | `pnpm -s test -- --run --coverage`（若脚本支持） |
| M-9 | 重试/阻塞 | `status/blocked` 次数、自动重试次数 | issue events + `events.jsonl` | §2 |
| M-10 | token/成本 | 每次 runner 调用的 usage 记录（input/output/cached） | `.agentspec/runs/<iso>/usage.jsonl`（若 runner 未记录 → `UNCOLLECTED`） | §2 |
| M-11 | 发布节奏 | tag 间隔天数；每版本合并 PR 数 | `git tag` + Release | `git log --tags --simplify-by-decoration --format='%d %ci'` |
| M-12 | 用户介入次数 | 升级单数量（`status/needs-info` 事件数） | issue events | §2 |

目标值不在本文写死：首轮只建立基线（baseline），基线需 30 天或 20 个 PR 才具统计意义；未达样本量时报告只给绝对值，不给趋势结论。

## 2. 采集脚本（只读，可复跑）

以下命令均在 `mocl/` 根目录执行；输出汇总到 `.agentspec/metrics/<YYYY-MM>.md`（gitignored，交付报告可引用）。

```bash
# M-2 CI 通过率
gh run list --workflow ci.yml --limit 100 --json conclusion \
  --jq '[.[] | select(.conclusion != "") | {conclusion}] | group_by(.conclusion)
        | map({(.[0].conclusion): length}) | add'

# M-1 交付周期（merged PR 的 openedAt→mergedAt 小时数）
gh pr list --state merged --limit 100 --json number,createdAt,mergedAt \
  --jq '[.[] | {n: .number, hours: (((.mergedAt|fromdateiso8601) - (.createdAt|fromdateiso8601))/3600)}]
        | sort_by(.hours) | {count: length, median: (.[length/2|floor].hours)}'

# M-4/M-5 返工率与评审轮次
gh pr list --state all --limit 100 --json number,reviews \
  --jq '[.[] | {n: .number, changes: ([.reviews[]? | select(.state=="CHANGES_REQUESTED")] | length)}]
        | {prs: length, reworked: ([.[] | select(.changes>0)] | length)}'

# M-12 升级次数（该月 needs-info 相关事件）
gh issue list --search 'label:status/needs-info' --state all --limit 100 --json number,updatedAt
```

本地日志采集（零依赖 node 一行，读 `.agentspec/runs/`）：

```bash
node -e '
const fs=require("fs"),p=".agentspec/runs";
if(!fs.existsSync(p)){console.log("UNCOLLECTED: 无 .agentspec/runs/");process.exit(0)}
const runs=fs.readdirSync(p).filter(d=>fs.existsSync(`${p}/${d}/verify/summary.json`));
let pass=0, fail=0, gates={};
for(const r of runs){const s=JSON.parse(fs.readFileSync(`${p}/${r}/verify/summary.json`));
  if(s.verdict==="PASS")pass++; else fail++;
  for(const g of (s.gates||[])) if(g.status!=="PASS") gates[g.id]=(gates[g.id]||0)+1;}
console.log(JSON.stringify({runs:runs.length, firstPass:pass, fail, unstableGates:gates},null,2));
const u=`${p}/usage.jsonl`;
console.log(fs.existsSync(u) ? "usage: available" : "M-10 UNCOLLECTED: 无 usage.jsonl（runner 未记录）");
'
```

M-10 只有在 runner 真的落盘 `usage.jsonl` 时才报数值；字段契约：`{ts, issue, role, model, tokens:{input,output,cached}, cost_usd}`。缺失即 `UNCOLLECTED`，不得用估算替代。

## 3. 采集频率与归档

| 频率 | 动作 | 落点 |
|---|---|---|
| 每 PR | G4 写 `verify/summary.json`；G5 记录打回轮次 | `.agentspec/runs/<iso>/` |
| 每周 | 跑 §2 命令，生成周报 | `.agentspec/metrics/<YYYY-Www>.md` |
| 每版本 | 汇总到交付报告 §4/§5 | `07-DELIVERY-REPORT.md` |
| 每月 | 归档并清理 > 90 天的 run 目录（保留 summary.json） | `.agentspec/metrics/` |

## 4. 反造假规则

1. 数字必须来自命令输出；报告里贴命令与原始输出（至少关键行）。
2. 样本量 < 5 时只报绝对值，不写趋势/百分比。
3. `UNCOLLECTED` 是合法结论；沉默不是。
4. 不得为了指标好看而减少测试/跳过门禁（违反 `00-OPERATING-MODEL.md` §1.6）。
5. 指标不用于对比不同模型/agent 的"能力"结论；无对照组时只报过程事实。

## 5. 指标 → 行动

| 指标异常 | 可能根因 | 行动 |
|---|---|---|
| M-2 CI 通过率 < 80% | 环境漂移/门禁不稳 | 抓 `gh run view <id> --log-failed`，修不稳定门禁，不降门槛 |
| M-3 一次通过率低且 M-6 集中在某 ID | 该门禁要求不清晰 | 更新对应 process 文档的门禁判据；补前置检查到实现文档 |
| M-4 返工率高 | DoR 太弱或 RFC 缺失 | 强化 `01` DoR、`02` 触发条件 |
| M-1 lead time 中位数上升 | 阻塞在等决策 | 检查 M-12；把可委派决策下沉到 agent |
| M-9 阻塞集中在凭据 | 环境/额度问题 | 升级 E-03，切 mock/离线档并声明 |
| M-10 长期 UNCOLLECTED | runner 未记录 usage | 开 issue 给 R4 补 `usage.jsonl`，不估算成本 |

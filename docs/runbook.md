# Runbook — MOCL 施工仓运维手册

> 本文件由多个切片共同维护：**§1「codex 基线升级/回滚」属 C11（D-015）**；
> C9 会在本文件追加「端到端 PR 演练」等章节。追加内容请勿覆盖他人章节。

## 1. codex 基线升级 / 回滚（C11 · D-015）

### 1.0 为什么需要这一步

codex 的协议面随版本漂移，且**本机曾同时存在两份载荷**：

| 角色 | 位置 | 版本（本次实测） | app-server 计数<br>ClientRequest / ServerNotification / ServerRequest |
|---|---|---|---|
| **基线（唯一）** | `PATH` 上的 `codex` | **0.164.0** | **106 / 85 / 10** |
| 旧载荷（待升级） | `~/.dsh/profiles/<profile>/node_modules/@openai/codex-darwin-arm64/vendor/<target>/bin/codex` | 0.153.4 | 99 / 81 / 10 |

两版差异**不是纯增量**（`thread/rollback` 被删；`ThreadRollbackParams/Response` 消失），
用旧版的 schema 生成的类型去连新版会静默错位。所以 C4 的握手/事件/计数断言必须在
**单一基线 0.164.0** 上重跑（`HANDOFF.md` §3.0）。

门禁脚本：`scripts/assert-codex-baseline.mjs`（`pnpm -s baseline:codex`）。
它**零额度**：只执行 `codex --version` 与 `codex app-server generate-json-schema`，
**从不**创建 thread、运行 turn，也不读写 `~/.codex` 的会话或凭据。

### 1.1 门禁要断言什么

| # | 断言 | 失败含义 |
|---|---|---|
| 1 | `--version` 解析出的版本以 `0.164.` 开头 | 基线不是 0.164.0 → 后续所有计数断言无意义 |
| 2 | `ClientRequest=106` / `ServerNotification=85` / `ServerRequest=10` | 协议漂移（codex 升级了或二进制不是预期那份） |
| 3 | `ClientRequest` 含 `thread/resume`、`turn/steer`、`thread/loaded/list`；`ThreadItem` 含 `collabAgentToolCall` | 续接/打断/原生子代理能力缺失 |
| 4 | profile 旧载荷与基线 → `SAME` / `DIFF` | `DIFF` = DSH 内插件仍在跑旧协议（**默认仅警告**，`--strict-bundle` 时升为失败） |

**计数口径**：唯一 `properties.method` 的 `enum`/`const` 取值数。
不要用「含斜杠的字符串数」——那样会漏掉 `initialize`、`fuzzyFileSearch`、`error`、
`warning`、`guardianWarning`、`deprecationNotice`、`configWarning`、
`applyPatchApproval`、`execCommandApproval` 等无斜杠方法，得到 104 / 80 / 8 之类的错数。
（该口径与 `../repro/probe-codex.sh` §4、`../docs/adapters/codex.md` §12.4 A0 一致。）

### 1.2 五步升级流程

> 全过程不碰 DSH 的 asar；只改 profile 的依赖树。**每一步都有可复跑的判定命令**。

#### 步骤 1 — 备份 + 记录现状

```bash
cd /Users/lakii2982/项目/多智能体编排/impl

# 记录两处版本（原始输出留档，别只看结论）
codex --version
for b in ~/.dsh/profiles/*/node_modules/@openai/codex-darwin-arm64/vendor/*/bin/codex; do
  [ -x "$b" ] && printf '%s -> %s\n' "$b" "$("$b" --version 2>&1 | head -1)"
done | tee /tmp/mocl-codex-baseline-before.txt

# 备份 profile 清单（回滚要用）
cp ~/.dsh/profiles/desktop/package.json /tmp/mocl-profile-package.json.bak
cp ~/.dsh/profiles/desktop/pnpm-lock.yaml /tmp/mocl-profile-pnpm-lock.yaml.bak 2>/dev/null || true

# 现状门禁（此刻应 PASS，且 bundle 行是 DIFF）
pnpm -s baseline:codex
```

判定：`RESULT: PASS`；日志里出现 `bundle:<profile>/<target>: 0.153.4 … → DIFF`。

#### 步骤 2 — 升级 profile 的 codex 载荷（不动 asar）

插件对 `@openai/codex` 是**精确依赖**，且用 `require.resolve("@openai/codex/package.json")`
定位二进制（无配置项可绕开），因此只能在 profile 侧覆盖：

```bash
# 方式 A（推荐）：直接 update 两个包
pnpm --dir ~/.dsh/profiles/desktop update @openai/codex @openai/codex-darwin-arm64

# 方式 B：先写 pnpm.overrides 再 install（升级被其它依赖锁住时用）
#   ~/.dsh/profiles/desktop/package.json 增加：
#     "pnpm": { "overrides": {
#       "@openai/codex": "0.164.0",
#       "@openai/codex-darwin-arm64": "0.164.0" } }
pnpm -C ~/.dsh/profiles/desktop install

# 升级后必须重启 DSH（profile 依赖在进程启动时解析）
```

判定：`pnpm -C ~/.dsh/profiles/desktop list @openai/codex @openai/codex-darwin-arm64` 显示 `0.164.0`。

#### 步骤 3 — 跑基线门禁（严格模式）

```bash
cd /Users/lakii2982/项目/多智能体编排/impl
pnpm -s baseline:codex -- --strict-bundle
```

判定（必须全绿）：

```text
[1] 版本           PASS version: 0.164.0
[2] 协议计数       PASS count:ClientRequest: 106 / count:ServerNotification: 85 / count:ServerRequest: 10
[3] 关键方法       PASS client-methods / PASS thread-item:collabAgentToolCall
[4] 旧载荷一致性   PASS bundle:<profile>/<target>: 0.164.0 … → SAME
RESULT: PASS  (… 0 fail …)
```

退出码必须为 `0`。任何 FAIL → 不要继续 C4，按 `DIAG 复现命令` 定位。

#### 步骤 4 — 跑 1 轮 smoke（**唯一消耗额度的一步**）

```bash
# 单 turn 冒烟：断言 thread:<id> 与 turn:<id>->completed
# 注意：`pnpm smoke` 是 C4 的交付物；若尚未落地，用 C4 的等价验收命令代替，
#       不要用「人眼看输出」冒充通过。
pnpm -s smoke -- --backend=codex --turn=1 --assert=exit0
```

判定：退出码 0，输出含 `thread:<id>` 与 `turn:<id>->completed`。
若模型侧不可用（额度/401/429），按 `U1` 记录**失败终态**，不要伪造通过。

#### 步骤 5 — 回滚（升级出问题时）

```bash
# 5.1 还原 profile 依赖清单
cp /tmp/mocl-profile-package.json.bak ~/.dsh/profiles/desktop/package.json
[ -f /tmp/mocl-profile-pnpm-lock.yaml.bak ] && \
  cp /tmp/mocl-profile-pnpm-lock.yaml.bak ~/.dsh/profiles/desktop/pnpm-lock.yaml
pnpm -C ~/.dsh/profiles/desktop install --frozen-lockfile
# 5.2 重启 DSH，然后复核两处版本回到升级前
codex --version
~/.dsh/profiles/desktop/node_modules/@openai/codex-darwin-arm64/vendor/*/bin/codex --version
# 5.3 门禁会重新变成「bundle DIFF 警告」（预期行为，不是回归）
pnpm -s baseline:codex

# 5.4 兜底（不降级 profile）：让兼容层走基线，DSH 插件继续用它自己的旧载荷
#     配置 codexBinaryPath = "$(command -v codex)"，这样两条路径并存但显式声明
```

判定：回滚后门禁 `RESULT: PASS`（`bundle` 行为 DIFF 警告），C4 仍可继续用 `binaryPath`
指向基线的 0.164.0 完成开发。

### 1.3 升级完成后要同步的地方

1. `scripts/assert-codex-baseline.mjs` 的 `DEFAULTS`（版本前缀 + 三个计数）；
2. `../repro/probe-codex.sh` 的 `EXPECT_VER / EXPECT_CLIENT / EXPECT_NOTIF / EXPECT_REQUEST`；
3. `../docs/adapters/codex.md` §1.2 协议差异表与 §12.4 A0 的期望值；
4. CI：把 `pnpm -s baseline:codex -- --strict-bundle` 设为必过项（升级完成后才可开严格模式）。

### 1.4 常见故障对照

| 现象 | 原因 | 处置 |
|---|---|---|
| `FAIL version: … 不匹配期望前缀` | PATH 上的 codex 不是 0.164.0 | `--binary` 指向基线绝对路径；或升级 nvm 全局包 |
| `FAIL count:ClientRequest: 106 != 期望 …` | 二进制换了版本 / 期望值未同步 | 先确认 `--version`，再按 §1.3 同步期望值 |
| `SKIP protocol-counts` | 二进制不可执行 | 检查 `--binary` 路径与执行权限 |
| `bundle: … → DIFF` | profile 还是旧载荷 | 默认是警告；按 §1.2 步骤 2 升级，或加 `--strict-bundle` 让它变红 |
| `生成 schema 失败` | 二进制损坏 / 磁盘满 / 参数不支持 | 手工复跑 `codex app-server generate-json-schema --out /tmp/cx` 看原始报错 |
| 门禁很慢（>10s） | 正常的 `generate-json-schema` 约 1–3s；异常慢多为磁盘或杀毒扫描 | 用 `--keep` 保留 schema 目录排查 |

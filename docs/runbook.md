# Runbook — MOCL 施工仓运维手册

> 本文件由多个切片共同维护：**§1「codex 基线门禁」属 C11、§2「DSH profile codex 载荷升级」属 C11b（D-015）**；
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

### 1.2 升级动作

**不要手工散改 profile。** 升级动作已脚本化为 `scripts/upgrade-dsh-codex-payload.mjs`
（`pnpm -s upgrade:codex`），带 dry-run / 备份 / 自动回滚 / 严格门禁复验。完整五步见 **§2**。

### 1.3 升级完成后要同步的地方

1. `scripts/assert-codex-baseline.mjs` 的 `DEFAULTS`（版本前缀 + 三个计数）；
2. `scripts/upgrade-dsh-codex-payload.mjs` 的 `TARGET` 默认值来自 PATH 上的 `codex`，无需手改，但需确认 PATH 已指向新基线；
3. `../repro/probe-codex.sh` 的 `EXPECT_VER / EXPECT_CLIENT / EXPECT_NOTIF / EXPECT_REQUEST`；
4. `../docs/adapters/codex.md` §1.2 协议差异表与 §12.4 A0 的期望值；
5. CI：把 `pnpm -s baseline:codex -- --strict-bundle` 设为必过项（升级完成后才可开严格模式）。

### 1.4 常见故障对照（门禁侧）

| 现象 | 原因 | 处置 |
|---|---|---|
| `FAIL version: … 不匹配期望前缀` | PATH 上的 codex 不是 0.164.0 | `--binary` 指向基线绝对路径；或升级 nvm 全局包 |
| `FAIL count:ClientRequest: 106 != 期望 …` | 二进制换了版本 / 期望值未同步 | 先确认 `--version`，再按 §1.3 同步期望值 |
| `SKIP protocol-counts` | 二进制不可执行 | 检查 `--binary` 路径与执行权限 |
| `bundle: … → DIFF` | profile 还是旧载荷 | 默认是警告；按 **§2** 用脚本升级，或加 `--strict-bundle` 让它变红 |
| `生成 schema 失败` | 二进制损坏 / 磁盘满 / 参数不支持 | 手工复跑 `codex app-server generate-json-schema --out /tmp/cx` 看原始报错 |
| 门禁很慢（>10s） | 正常的 `generate-json-schema` 约 1–3s；异常慢多为磁盘或杀毒扫描 | 用 `--keep` 保留 schema 目录排查 |

## 2. DSH profile codex 载荷升级（C11b · D-015 落地动作）

### 2.0 为什么必须脚本化，以及本机可升级性判断

`@deepseek-ai/dsh-subagent-codex` 对 `@openai/codex` 是**精确依赖**，插件用
`require.resolve("@openai/codex/package.json")` 定位二进制（**没有配置项可绕开**），
而 desktop profile 由 Electron 进程管理。手工改 `node_modules` 或手工 pnpm 都属"散改"，
失败后说不清改了什么、也无法一键还原 —— 所以统一走脚本。

本机实测（2026-10-26，只读判断）：

| 事实 | 值 | 对升级的影响 |
|---|---|---|
| PATH 上 `codex` | **0.164.0**（基线） | 目标版本可直接从它推导 |
| profile 内 `@openai/codex` | 0.153.4 | 待升级 |
| profile 内平台载荷 `@openai/codex-darwin-arm64` | `0.153.4-darwin-arm64`，其 `package.json` 的 `name` 却是 `@openai/codex` | 它是 **npm 别名**（lockfile 写作 `npm:@openai/codex@0.153.4-darwin-arm64`） |
| profile `package.json` 是否直接声明 `@openai/codex` | **否**（经插件传递引入） | `pnpm update @openai/codex@0.164.0` 不可靠 |
| `@openai/codex-darwin-arm64@0.164.0` 这个 spec | **不存在**（真实发布物是 `@openai/codex@0.164.0-darwin-arm64`） | 不能按字面量 update 它 |
| DSH（Electron）是否在跑 | 是 | pnpm 可能 `EBUSY`/`EPERM` → 脚本 exit 3 |

**结论：可升级，但必须（a）先完全退出 DSH、（b）用 `pnpm.overrides` 而不是 `pnpm update`。**
脚本的 `--strategy auto` 会自动选这个策略，并在 dry-run 里解释原因。

### 2.1 五步升级流程

> 前三步零额度、不改 profile；第 4 步才需要重启 DSH；任何一步失败先回滚再排查。

#### 步骤 1 — dry-run 先看完整计划（必做）

```bash
cd /Users/lakii2982/项目/多智能体编排/impl
pnpm -s upgrade:codex --dry-run
# 机器可读：pnpm -s upgrade:codex --dry-run | tail -1   （或加 --json）
```

计划必须包含六项：**当前版本 / 目标版本 / 备份目录 / 将执行的命令 / 复验命令 / 回滚命令**。
判定：`exit 0`，且输出含 `结论: dry-run 完成（未写盘、未调用 pnpm）`。
此刻 `ls var/` 应为空/不存在（dry-run 不创建任何东西）。

#### 步骤 2 — 完全退出 DSH（Electron 独占）

```bash
# 完全退出 DeepSeek Harness（含托盘/后台），直到下面没有输出
pgrep -f "DeepSeek Harness"
```

判定：无输出（`pgrep` 退出码 1）。若仍有进程，`--apply` 很可能得到 exit 3（见 §2.2），
这属于环境限制、不是脚本故障。

#### 步骤 3 — apply：备份 → 升级 → 严格门禁复验

```bash
pnpm -s upgrade:codex --apply
```

脚本顺序固定：**备份**到 `<repo>/var/backup/codex-payload-<ts>/`（`package.json` +
`pnpm-lock.yaml` + 两个 `@openai` 载荷目录 + `manifest.json` + `PLAN.txt`）→ 写 overrides
→ `pnpm --dir <profile> install --no-frozen-lockfile` → 版本后检 → 跑
`assert-codex-baseline.mjs --strict-bundle`。

判定（三选一）：

| 退出码 | 含义 | 你要做什么 |
|---|---|---|
| `0` | 成功，复验 `strict-bundle` 通过 | 进步骤 4 |
| `1` | 业务失败（pnpm 报错 / 版本没到位 / 复验失败） | **已自动回滚**；看输出里的 pnpm 报错 |
| `3` | 环境不支持（Electron 独占/不可写/缺 pnpm 或宿主 codex） | 按输出给的 A/B/C 替代路径处理 |

输出末尾必须能看到回滚命令与备份路径，例如：

```text
== 升级完成 ==
  备份保留在: /…/impl/var/backup/codex-payload-20261026-010203
  回滚命令  : node scripts/upgrade-dsh-codex-payload.mjs --rollback /…/codex-payload-20261026-010203
  下一步    : 重启 DSH，然后跑 `pnpm -s baseline:codex -- --strict-bundle` 与 C4 smoke。
```

#### 步骤 4 — 重启 DSH，跑严格门禁

```bash
# 重启 DeepSeek Harness 后
pnpm -s baseline:codex -- --strict-bundle
```

判定：`exit 0`，且第 4 节出现 `bundle:<profile>/<target>: 0.164.0 … → SAME`
（之前是 `DIFF`）。然后按 §1.3 同步期望值/CI。

#### 步骤 5 — 回滚（升级出问题时；**还原备份，不删目录**）

```bash
pnpm -s upgrade:codex --rollback var/backup/codex-payload-<ts>
```

行为：按 `manifest.json` 把 `package.json` / `pnpm-lock.yaml` / 两个载荷目录**覆盖还原**，
并逐个文件校验 sha256；**不删除任何文件**（备份里没有的多余文件只报告、不删）。
判定：`exit 0` 且输出 `verify-restore  OK  所有文件与备份字节一致`。
回滚后 `pnpm -s baseline:codex` 会重新显示 `bundle DIFF` 警告（**预期，不是回归**），
此时可继续用 `codexBinaryPath` 指向基线做 C4 开发。

### 2.2 退出码约定（脚本契约）

| 码 | 名称 | 触发 | 是否已回滚 |
|---|---|---|---|
| 0 | OK | dry-run 完成 / apply 且复验通过 / rollback 完成 | — |
| 1 | FAIL | pnpm 非零且非独占类错误、后检版本不符、`--strict-bundle` 复验失败、备份/回滚自身失败 | 是（尽力） |
| 2 | USAGE | 参数冲突（`--dry-run`+`--apply`、`--rollback`+`--apply`）、未知参数、非法 `--strategy`/`--timeout-ms` | — |
| 3 | ENV | Electron/DSH 独占（`EBUSY/EPERM/EACCES/ENOTEMPTY/ELOCKED`）、profile 不可写、缺 pnpm、缺宿主 codex、dry-run 有阻塞项 | 是（若已进入 apply） |

`exit 3` 时脚本一定会打印替代路径，**不会静默失败**：

- **A**：退出 DSH 后重跑 `--apply`（或等 DSH 发版带上基线载荷）；
- **B**：在 DSH 插件管理页升级 `@deepseek-ai/dsh-subagent-codex` 及其 `@openai/codex` 载荷；
- **C**：不动 DSH，把兼容层的 `codexBinaryPath` 指向宿主基线二进制（两套路径并存期必须显式声明）。

### 2.3 手工兜底（仅在脚本本身不可用时）

```bash
P=~/.dsh/profiles/desktop
# 1) 备份（不要 rm，只拷）
mkdir -p /tmp/mocl-codex-bak && cp "$P/package.json" "$P/pnpm-lock.yaml" /tmp/mocl-codex-bak/
# 2) 写 overrides（注意别名值必须是 npm:@openai/codex@0.164.0-darwin-arm64）
python3 - <<'EOF'
import json, os
p = os.path.expanduser("~/.dsh/profiles/desktop/package.json")
d = json.load(open(p))
d.setdefault("pnpm", {}).setdefault("overrides", {}).update({
    "@openai/codex": "0.164.0",
    "@openai/codex-darwin-arm64": "npm:@openai/codex@0.164.0-darwin-arm64",
})
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
EOF
# 3) 安装（先退出 DSH！）
pnpm -C "$P" install --no-frozen-lockfile
# 4) 复验
cd /Users/lakii2982/项目/多智能体编排/impl && pnpm -s baseline:codex -- --strict-bundle
# 5) 还原 = 把备份拷回（不要 rm -rf 目录）
cp /tmp/mocl-codex-bak/package.json /tmp/mocl-codex-bak/pnpm-lock.yaml "$P/"
```

### 2.4 已知限制

1. **备份体积**：平台载荷约 275 MB。macOS 用 clonefile（`cp -c`）秒级完成且 COW 不额外占盘；
   非 macOS 回退整目录复制（慢一些但可用）。
2. **脚本不自动清理历史备份**（安全契约：不删用户文件）。请人工定期清理 `var/backup/` 下旧目录。
3. `--apply` 时 pnpm 会访问 registry（唯一联网动作）；`--dry-run` 全程不联网、不调 pnpm。
4. 升级后**必须重启 DSH** 才生效（插件在进程启动时 `require.resolve`）。
5. 本机当前 DSH 正在运行，因此 `--apply` 大概率以 exit 3 结束 —— 这是预期路径，
   先按 §2.1 步骤 2 退出 DSH。**本次施工只执行 dry-run**，真升级由用户确认后执行。
6. `--profile-root` / `--backup-root` / `--pnpm` / `--verify-script` 是测试与 CI 钩子，
   **不要**在真环境随意指向别处（指向错 profile 会备份/还原错误目录）。

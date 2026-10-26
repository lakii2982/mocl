# VERIFY-GATE — D9 独立复验记录（fresh verifier）

> 角色：独立评审（新上下文，只看产物与证据）。本节只**重跑、只记录**，不修改任何被验产物；所有命令在项目根
> `/Users/lakii2982/项目/多智能体编排` 执行。时间：2026-10-25（Asia/Shanghai），macOS arm64。
> 纪律：每条独立复验限时 60–90s；超时记 `[timeout]`，不重试、不等待 hang 进程。额度影响已逐条标注。

## 0. 结论

**PARTIAL** —— 文档闸门除 6 个「D9/D10 尚未产出」文件外全绿；`repro/run_all.sh` 4/4 PASS；
四后端关键能力断言与 DSH seam 硬事实**独立复验全部成立**；但两条「最小可运行示例」**按原文执行均失败**
（codex 挂死、kimi 崩溃），属被验产物缺陷（见 §5，交由 D5a/D5b 修）。

## 1. 闸门重跑

### 1.1 `python3 tools/check_docs.py all`

```text
$ python3 tools/check_docs.py all
PASS ledger / secrets / research / matrix / arch / abi / adapters / integration / risk / test / plan
FAIL review
FAIL docs
checks=315 failures=6
  FAIL [docs/review/SCORECARD.md] 文件不存在
  FAIL [docs/review/VERIFY-GATE.md] 文件不存在   ← 本节落盘后消失
  FAIL [docs/00-README.md] 文件不存在            ← D10 写域
  FAIL [HANDOFF.md] 文件不存在                   ← D10 写域
  FAIL [.astra/INTEGRATION.md] 文件不存在        ← D10 写域
  FAIL [.astra/JOURNAL.md] 文件不存在            ← D10 写域
[exit: 1]
```

结论：6 个缺失文件 = D9 两份（本文件与 SCORECARD）+ D10 四份，与任务书预期一致；**其余 11 个 stage 全 PASS**。

### 1.2 `bash repro/run_all.sh`

```text
$ time bash repro/run_all.sh
--- PASS repro/probe-claude.sh
--- PASS repro/probe-codex.sh
--- PASS repro/probe-kimi.sh
--- PASS repro/probe-opencode.sh
ALL PROBES PASS
[exit: 0]  elapsed≈22s  output 727 lines
```

### 1.3 附加机械校验（评审自建，不属于被验产物）

- 全库 md 交叉引用：提取 `*.md:NNN` 形式行号引用 **833 条**，逐条校验目标文件存在且行号在范围内 → **0 条失效**。
- 能力矩阵符号计数：主矩阵 15 行 × 4 后端 = 60 格，实测 ✅44 / 🟡13 / ❌3，分后端 codex 14-1-0、kimi 10-3-2、claude-code 11-4-0、opencode 9-5-1，**与文档自述统计完全一致**。

## 2. 四后端能力断言独立复验（不信任文档，重新取证）

### 2.1 codex：`thread/resume` 是否真在导出的协议 schema 里

```text
$ codex app-server generate-json-schema --out /tmp/codex-schema-rev   # PATH codex-cli 0.164.0，39 文件
$ ~/.dsh/profiles/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex \
    app-server generate-json-schema --out /tmp/codex-schema-0153      # bundle 0.153.4，39 文件
```

| 检查 | 结果（原始摘要） |
|---|---|
| `ClientRequest.json` 是否含 `thread/resume` | **是**：`oneOf[2]` → `{"method":{"enum":["thread/resume"]},"params":{"$ref":"#/definitions/ThreadResumeParams"}}` |
| `thread/resume` 参数定义 | `ThreadResumeParams` 存在；描述含 "three ways to resume a thread: by thread_id / by history / by path" |
| 同族方法 | `thread/start`(1)、`thread/resume`(2)、`thread/fork`(3)、`thread/list`、`thread/loaded/list`、`thread/read`、`turn/start|steer|interrupt`、`mcpServer/tool/call`、`mcpServerStatus/list` 均在导出物中 |
| `CollabAgentTool` 枚举 | 9 值：spawnAgent / sendInput / resumeAgent / wait / closeAgent / sendMessage / followupTask / interruptAgent / listAgents（与调研文档一致） |
| 版本指纹 | 0.153.4 二进制 `initialize.userAgent` 回显 `... 0.153.4 ...`；`codex --version` = 0.164.0 → **双版本并存属事实** |

**判定：PASS**。`thread/resume` 确在真契约中，非文档臆造。

### 2.2 claude：`resume` 是否真在 `@anthropic-ai/claude-agent-sdk` typings 里

```text
$ grep -n "resume" ~/.dsh/profiles/desktop/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

| 断言 | 行号（实读） | 原文摘要 |
|---|---|---|
| SDK 版本 | `package.json` | `0.3.263` |
| `resume?: string` | **sdk.d.ts:1925** | "Session ID to resume. Loads the conversation history from the specified session." |
| `resumeSessionAt?: string` | sdk.d.ts:1939 | "When resuming, only resume messages up to and including the message with this UUID." |
| `forkSession?: boolean` | sdk.d.ts:1574 | "When true, resumed sessions will fork to a new session ID..." |
| `forkSession()` | sdk.d.ts:738 | `export declare function forkSession(...)` |
| `EXIT_REASONS` 含 `resume` | sdk.d.ts:666 | `readonly ['clear','resume',...]` |

**判定：PASS**。调研文档的行号引用与实际 typings 一致（非近似、非旧版）。

### 2.3 kimi：`session/cancel` 是否真的返回 `-32601`（自己起 ACP 进程）

```text
$ ~/.kimi-code/bin/kimi acp   # stdin/stdout JSON-RPC，逐帧记录（总限 60s）
initialize → protocolVersion=1, agentCapabilities={loadSession:true, sessionCapabilities:
  {list,resume,close,delete,fork,additionalDirectories}, promptCapabilities:{image:true,...}}
session/new {cwd:"/tmp"} → sessionId=session_d0620580-6280-464f-8881-bf5e99dd3b73 (err=null)
session/cancel {"sessionId":sid} →
  {"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"\"Method not found\": session/cancel",
   "data":{"method":"session/cancel"}}}
session/list → err=null, n=5
```

**判定：PASS**。`session/cancel` → `-32601 Method not found` 独立复现；且 `loadSession/resume/fork`
capability 声明与「会话可续接、无中断」的文档结论一致。

### 2.4 opencode：`/openapi.json` 是否真有 interrupt/fork/inbox 端点（无凭据场景）

```text
$ opencode api GET /openapi.json > /tmp/oc-openapi-rev.json   # exit 0, 290,181 bytes
{"openapi":"3.1.0","info":{"title":"opencode HttpApi","version":"0.0.1"},"paths":{...}}
paths = 124
```

| 端点 | 实测 |
|---|---|
| `POST /api/session/{sessionID}/interrupt` | **存在** |
| `POST /api/session/{sessionID}/fork` | **存在** |
| `GET /api/session/{sessionID}/inbox`、`DELETE/PATCH .../inbox/{inboxID}` | **存在** |
| `POST /api/session/{sessionID}/permission/{requestID}/reply` | 存在（含 GET pending/saved 共 6 条 permission 路径） |
| `PUT/DELETE/GET /api/worktree`、`GET /api/event`(SSE)、`POST .../model` | 存在 |

**判定：PASS**。无凭据不影响协议面取证（`opencode api` 走 CLI 自带鉴权）；124 paths 与文档一致。
注：**成功 turn 未复验**（本机凭据过期，D-013 已声明并列入待补）。

### 2.5 DSH seam：外部后端能力位是否真的全 false（从 asar 抽取源码）

```text
$ python3 - # 按 CONTEXT-DSH-SEAM.md §1 的解析法，直接把 asar 内 dsh-subagent/** 抽到 /tmp/dsh-asar-rev
$ grep -n -A6 "NO_START_CAPABILITIES *=" /tmp/dsh-asar-rev/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js
2790: const NO_START_CAPABILITIES = Object.freeze({
2791:   agentOptions: false,
2792:   agentPreset: false,
2793:   outputSchema: false,
2794:   depthLimit: false
2795: });
```

**判定：PASS**。四个能力位**全 false**，与 BRIEF §3 / CONTEXT §2 完全一致（另在
`lib/types/out-of-process.js:48` 有同名导出）。

## 3. 「最小可运行示例」真实执行（各 1 条，原文执行，限 90s）

### 3.1 `docs/adapters/codex.md` §4.6（`codex_min.py`）

- 执行方式：把 §4.6 代码块**原样**落为 `/tmp/codex_min.py` 并用 `subprocess.run(timeout=90)` 执行。
- **结果：FAIL — 挂死（90s 无输出）**。`stdout/stderr` 全空（Python 缓冲 + 无终态事件）。
- 分段定位（自建 instrument 版，不改原文）：

```text
CODEX_HOME=/tmp/mocl-codex-home (无 auth.json)
[initialize]   0.16s -> result.userAgent=".../0.153.4 ..."
[thread/start] 0.06s -> thread.id=01a1738c-...
[turn/start]   0.00s -> turn.status="inProgress"
之后 45s 仅收 thread/status/changed, turn/started, item/started(userMessage), item/completed(userMessage)
无 item/agentMessage/*、无 turn/completed；stderr 空
```

- 根因（两条，均为示例代码缺陷）：
  1. `env = {**os.environ, "CODEX_HOME": os.environ.get("CODEX_HOME", "/tmp/mocl-codex-home")}`
     默认把 `CODEX_HOME` 指向**空临时目录**，丢掉 `~/.codex/auth.json` 登录态 → 模型调用无法完成且**不报错**；
  2. 全示例**没有任何读超时**，`wait_turn_end()` 永久阻塞（对照：kimi/opencode 示例都有 `TimeoutError` 兜底）。
- 旁证（诊断为环境/示例耦合而非协议不存在）：同一脚本带 `CODEX_HOME=~/.codex` 执行 → **6.2s 退出**，
  `turn: ... -> failed`，stderr `ERROR ... failed to connect to websocket: HTTP error: 426 Upgrade Required,
  url: ws://127.0.0.1:15721/v1/responses`；`resume:` 仍返回同一 `thread.id`（resume 通道成立）。
  再次抓到 `error` 通知 payload：`codexErrorInfo:"other"`，message 为上游 `model_not_found`（gpt-6.1-sol 对
  ChatGPT 账号不可用）——属本机模型/代理环境，不是 codex 协议缺失。
- 额度：无模型 token 消耗（首次空 home 未鉴权；第二次上游 400 拒绝于模型侧前）。**未做成功 turn 复验**。

### 3.2 `docs/adapters/kimi.md` §3.4（`kimi_acp_min.py`）

- 执行方式：§3.4 代码块**原样**落为 `/tmp/kimi_acp_min.py`，`timeout=90`。
- **结果：FAIL — 0.9s 崩溃**，原始错误：

```text
Traceback (most recent call last):
  File "/tmp/kimi_acp_min.py", line 36, in <module>
    r = call(rid, "session/prompt", {...})
  File "/tmp/kimi_acp_min.py", line 29, in call
    return wait(lambda f: f.get("id") == rid, timeout)
  File "/tmp/kimi_acp_min.py", line 20, in wait
    with open(f["params"]["path"], encoding="utf-8", errors="replace") as fh:
FileNotFoundError: [Errno 2] No such file or directory:
  '/Users/lakii2982/.kimi-code/sessions/wd_tmp_11fe14a563f7/session_9a9fabe2-.../agents/main/plans/damage-wiccan-dove.md'
```

- 根因：示例实现了 `fs/read_text_file` 并用 `open()` 直接读，**未处理「文件不存在」**。ACP 客户端在文件不存在时
  必须回 JSON-RPC error，而不是让 Python 异常打断读线程 → 示例与 D-003 自己写的「handler 必须是 fail-closed」
  矛盾（只是这次表现成崩溃而非挂死）。
- 对照实验（只加 6 行 catch 并回 `-32602`，其余不动）→ **PASS，24.6s**：

```text
$ python3 -u /tmp/kimi_acp_min_fixed.py
turn 1 session_1f11b3ff-b1a6-4713-a383-d009a721c315 end_turn
turn 2 session_1f11b3ff-b1a6-4713-a383-d009a721c315 end_turn
[exit 0]
```

  说明：**文档的底层能力结论（同会话连续两轮 `end_turn`）成立**；缺陷在示例代码本身（未 fail-closed）。
- 额度：2 个「只回复 OK」微小轮次，已消耗少量额度（可接受，已按最小化执行）。

## 4. 复验抽样汇总

| # | 断言 | 命令（摘要） | 退出码 | 结果 |
|---|---|---|---|---|
| 1 | 文档闸门 | `python3 tools/check_docs.py all` | 1 | 6 个缺失（2×D9 + 4×D10），其余全绿 |
| 2 | 探测复跑 | `bash repro/run_all.sh` | 0 | 4/4 PASS，22s |
| 3 | codex `thread/resume` 在真 schema | 双二进制 `generate-json-schema` + 查 `ClientRequest.oneOf` | 0 | ✅ 存在（oneOf[2]） |
| 4 | claude `resume` 在 SDK typings | `grep -n resume sdk.d.ts` | 0 | ✅ sdk.d.ts:1925 / :1939 / :1574 / :738 |
| 5 | kimi `session/cancel` → -32601 | 自起 `kimi acp` + JSON-RPC | 0 | ✅ `{"code":-32601,...}` |
| 6 | opencode v2 端点 | `opencode api GET /openapi.json` | 0 | ✅ 124 paths，interrupt/fork/inbox/reply/worktree/event 全在 |
| 7 | DSH seam 能力位全 false | asar 抽取 + grep | 0 | ✅ index.js:2790-2795 四值全 false |
| 8 | codex 最小示例 | 原文 90s | timeout | ❌ 挂死（无超时/丢登录态） |
| 9 | kimi 最小示例 | 原文 90s | 1（0.9s） | ❌ FileNotFoundError（修 6 行后 24.6s PASS） |

## 5. 复验发现（交作者修，本节不改产物）

- **V-1（D5a/codex §4.6）**：示例 ①默认 `CODEX_HOME` 指向空临时目录导致静默丢登录态；②全流程无读超时，hang 不可判。
  修法：默认继承 `~/.codex`（或显式要求 `CODEX_HOME` 已登录并在首帧断言 auth）；对 `rpc()`/`wait_turn_end()`
  加 `select/threading` 超时；补「验收预期」段（kimi/opencode 有，codex 没有）。
- **V-2（D5b/kimi §3.4）**：示例 `fs/read_text_file` 未处理不存在文件，直接 `FileNotFoundError`。
  修法：`except FileNotFoundError → send({"error":{"code":-32602,...}})`（其余异常 `-32603`）；
  并把该 fail-closed 语义写进 §2.3 handler 契约（与 D-003 呼应）。
- **V-3（D1/probe-codex.sh + D5a/矩阵）**：`repro/probe-codex.sh` 的 `methods()` 只统计**含 `/`** 的枚举值，
  系统性漏掉 `error`/`warning`/`configWarning`/`deprecationNotice`/`guardianWarning` 5 个通知与 2 个请求，
  导致文档计数 `ClientRequest 97→104 / ServerNotification 76→80` 与真值
  **99→106 / 81→85** 不符（本轮双二进制导出实测）。其中 `error` 通知正是 turn 失败的关键事件
  （本轮 live 抓到 `codexErrorInfo:"other"`），却在 adapter §5.2 #35 被归入「丢弃（分类计数）」桶。
  修法：按 `properties.method` 的 enum/const 计数（不去 `/` 过滤）；订正三处数字；`error` 通知单独建行
  映射（至少 `session.warning`/`turn.failed` 二选一并给理由）。
- **V-4（环境声明，非缺陷）**：本机 codex 上游代理对 `gpt-6.1-sol`（ChatGPT 账号）返回
  `model_not_found/invalid_request_error`，故**无法**完成「成功 turn」复验；只验证到 turn 生命周期与
  resume 通道。此结果不改文档结论，但施工 C4 需要可用的 codex 模型（或改 `model` 配置）才能跑通 smoke。

## 6. 复验结论

- 闸门：除 D9/D10 未产出文件外**全绿**；`repro/run_all.sh` 全 PASS。
- 四后端关键能力断言 + DSH seam 硬事实：**5/5 独立成立**。
- 被验产物的两个「最小可运行示例」：**2/2 按原文失败**（codex 挂死、kimi 崩溃），修复路径明确且局部。
- 综合：**PARTIAL**（不是文档结论造假，而是示例与计数口径需修）。

---

## 复评重跑记录（D10 修复后，2026-10-25 23:2x）

> 定向复核，只重跑被修项，不重做全场评审。命令均在项目根执行。

```text
$ python3 tools/check_docs.py all
checks=393 failures=0
[exit: 0]                       ← 初评 325 checks / 6 failures → 现 0 failures（新增 errcodes 闸门）

$ python3 tools/check_docs.py errcodes
PASS errcodes / checks=52 failures=0     [exit: 0]

$ bash repro/run_all.sh
--- PASS repro/probe-claude.sh / codex.sh / kimi.sh / opencode.sh
ALL PROBES PASS                  [exit: 0]

# F2：codex 示例空 CODEX_HOME fail-fast（限 30s）
$ CODEX_HOME=/tmp/mocl-empty-home python3 -u /tmp/codex_min_v2.py
FATAL: /tmp/mocl-empty-home/auth.json 不存在；请先 `codex login` 或显式指定已登录的 CODEX_HOME
EXIT: 1 elapsed=0.02s            ← 初评：90s 挂死零输出；已修复

# F3：kimi 示例原文重跑（限 60s）
$ python3 -m py_compile /tmp/kimi_acp_min_v2.py   → OK
$ python3 -u /tmp/kimi_acp_min_v2.py
turn 1 session_ecace3cc-6355-4cd2-8363-e315a651ba3e end_turn
turn 2 session_ecace3cc-6355-4cd2-8363-e315a651ba3e end_turn
EXIT: 0 elapsed=7.5s             ← 初评：0.9s FileNotFoundError；已修复

# F4：探针计数口径 + 文档数字
$ sed -n '85,105p' repro/probe-codex.sh        → methods() 读 properties.method 的 enum/const
$ grep "ClientRequest\|ServerNotification" docs/research/codex.md docs/adapters/codex.md
  research/codex.md:22  ClientRequest 99 → 106，ServerNotification 81 → 85
  adapters/codex.md:49  CI 期望 39 / 99 / 81
  adapters/codex.md:452 「旧稿 76 漏计无斜杠 5 个」+ #36 error 通知映射行
$ python3 双二进制 generate-json-schema 复核 → 0.153.4 = 99/81，0.164.0 = 106/85（一致）

# F6：旧码与码表
$ for c in quota-denied auth-failed bad-cwd session-gone crashed bad-frame unknown-frame; \
    do grep -rn "\`$c\`" docs/risk docs/test | wc -l; done   → 全 0
$ python3 -c "…len(error.json code enum)…"  → 46，含 backend.internal-error
$ grep -rn "45 个|45 码" docs/ --include=*.md | grep -v docs/review/   → 0（仅 INTEGRATION 修复记录提及「改 46」）

# F5 / F7 / F8
$ grep -c "可见且可派发" .astra/PLAN.md        → 0
$ grep -n "人工" .astra/PLAN.md                → 仅第 58 行反例规则原文
$ sed -n '/## 7. 执行与门禁/,/## 8/p' docs/test/00-test-plan.md
  门禁 4 = golden + 白名单字段（ts/requestId/绝对路径）自动 diff
$ wc -l docs/00-README.md                      → 90 行（30 秒速查 + 按角色路径 + 文档地图）
$ grep -n "按用途索引" docs/abi/abi-v0.md       → §12.1 存在，README/HANDOFF 已引用
```

**复评结论**：F1–F8 **8/8 已修复**，无新增阻断；新增非阻断 F9（README/HANDOFF 与 schema 双源数字，
当前一致，建议后续改为引用）。最终判定移交 `SCORECARD.md §9.4`：**通过（可交付施工）**。

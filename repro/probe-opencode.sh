#!/usr/bin/env bash
# repro/probe-opencode.sh — opencode 2.1.4 只读能力探测（可复跑、幂等、总时长 < 60s）
#
# 只读约定：
#   - 默认只做「不改状态」的探测：--version / --help / debug paths / agent.list / session list /
#     ACP initialize 握手 / OpenAPI 端点清单
#   - 不启动 `opencode serve`（启动会把 server password 打到 stdout，且会常驻）；
#     只复用已在运行的后台 service，或经 `opencode api` 由 CLI 自行鉴权
#   - ACP `session/new` 会写数据库，默认跳过；`PROBE_ACP_SESSION=1` 开启
#   - 不动 auth 凭据：禁止 `opencode auth export`（会打印明文密钥）；本脚本只调 `auth list`
#   - 真实模型调用默认跳过；`PROBE_LIVE=1` 开启：跑**免费模型池**（opencode/*-free，零费用，
#     2026-10-26 实测 rc=0）；`PROBE_PAID=1` 追加付费模型探针（默认生产模型
#     opencode-go/deepseek-v4.1-flash；本机该 key 已过期 → 预期 401 api_key_expired）
#   - 凭据事实：`~/.local/share/opencode/auth.json` 存在 opencode-go key（只读键名，不打印值）；
#     “401 api_key_expired” = 付费套餐过期，不是“没登录”
#
# 退出码：0 = 探测完成；2 = 二进制不存在。
set -uo pipefail

OC="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
CAP="${PROBE_CAP:-10}"

say()  { printf '\n=== %s ===\n' "$*"; }
note() { printf '[note] %s\n' "$*"; }

_cap() {
  local t="$1"; shift
  python3 - "$t" "$@" <<'PY'
import subprocess, sys
t = float(sys.argv[1]); argv = sys.argv[2:]
try:
    p = subprocess.Popen(argv)
except FileNotFoundError:
    print(f"[missing] {argv[0]}"); sys.exit(127)
try:
    sys.exit(p.wait(timeout=t))
except subprocess.TimeoutExpired:
    p.kill()
    print(f"[timeout after {t:g}s] {argv[0]}")
    sys.exit(124)
PY
}

if [ ! -x "$OC" ]; then
  echo "[FATAL] opencode binary not executable: $OC" >&2
  exit 2
fi

say "0. 身份与版本"
note "path=$OC"
ls -l "$OC" | awk '{print "size="$5" mtime="$6" "$7" "$8}'
_cap "$CAP" "$OC" --version || note "--version 失败"

say "1. 子命令面（顶层）"
_cap "$CAP" "$OC" --help 2>&1 | sed -n '/^SUBCOMMANDS/,/^$/p' | head -30
echo "--- 顶层 orchestration 旗标"
_cap "$CAP" "$OC" --help 2>&1 | grep -E '^\s+--(standalone|server|auto|continue|session|prompt|print-logs)' | head -12

say "2. 关键子命令帮助摘要"
for sub in "acp --help" "serve --help" "api --help" "service --help" "session --help" "run --help" "debug --help"; do
  echo "--- opencode $sub"
  _cap "$CAP" "$OC" $sub 2>&1 | head -5
done

say "3. 全局路径与配置源（debug paths / debug config）"
_cap "$CAP" "$OC" debug paths 2>&1 | head -14
echo "--- config sources"
_cap "$CAP" "$OC" debug config 2>&1 | head -20

say "4. 原生 agent 定义（debug agents / agent 目录 / 配置文件键）"
echo "--- opencode debug agents"
_cap "$CAP" "$OC" debug agents 2>&1 | head -20
echo "--- ~/.config/opencode/agent/*.md（只列名与前 6 行 frontmatter 键）"
for f in "$HOME"/.config/opencode/agent/*.md; do
  [ -e "$f" ] || { echo "(none)"; break; }
  echo "  * $(basename "$f")"
  sed -n '1,8p' "$f" | grep -E '^(name|description|mode|model|permission|tools):' | sed 's/^/      /'
done
echo "--- opencode.jsonc（原样，仅 1 行 schema 时可直接看）"
sed -n '1,20p' "$HOME/.config/opencode/opencode.jsonc" 2>/dev/null

say "5. 凭据存在性（只报 provider + 类型，不打印密钥）"
_cap "$CAP" "$OC" auth list 2>&1 | head -10

say "6. ACP over stdio：initialize 握手"
PROBE_ACP_TIMEOUT=20 python3 - "$OC" <<'PY'
import json, os, signal, subprocess, sys, threading, time
argv = [sys.argv[1], "acp"]
deadline = time.time() + float(os.environ.get("PROBE_ACP_TIMEOUT", "20"))
msgs = []
p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, text=True, bufsize=1,
                     env={**os.environ, "NO_COLOR": "1"})
threading.Thread(target=lambda: [msgs.append(l) for l in p.stdout if l.strip()], daemon=True).start()
errs = []
threading.Thread(target=lambda: [errs.append(l.rstrip()) for l in p.stderr], daemon=True).start()
try:
    p.stdin.write(json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": 1,
                   "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}, "terminal": True},
                   "clientInfo": {"name": "mocl-probe", "version": "0.0.1"}}}) + "\n")
    p.stdin.flush()
    got = None
    while time.time() < deadline and got is None:
        for ln in list(msgs):
            try:
                o = json.loads(ln)
            except Exception:
                continue
            if o.get("id") == 1: got = o
        time.sleep(0.05)
    if got is None:
        print("RESULT: no initialize response (timeout)")
    else:
        r = got.get("result") or {}
        print("protocolVersion:", r.get("protocolVersion"))
        print("agentInfo:", json.dumps(r.get("agentInfo"), ensure_ascii=False))
        print("agentCapabilities:", json.dumps(r.get("agentCapabilities"), ensure_ascii=False))
        print("authMethods:", json.dumps(r.get("authMethods"), ensure_ascii=False)[:300])
finally:
    try: p.send_signal(signal.SIGTERM); p.wait(timeout=5)
    except Exception: p.kill()
    if errs: print("stderr tail:", errs[-3:])
PY

if [ "${PROBE_ACP_SESSION:-0}" = "1" ]; then
  say "6b. ACP 会话级方法（有副作用：写 session 库）"
  PROBE_ACP_TIMEOUT=25 python3 - "$OC" <<'PY'
import json, os, signal, subprocess, sys, threading, time
argv = [sys.argv[1], "acp"]
deadline = time.time() + float(os.environ.get("PROBE_ACP_TIMEOUT", "25"))
msgs = []
p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, bufsize=1,
                     env={**os.environ, "NO_COLOR": "1"})
threading.Thread(target=lambda: [msgs.append(l) for l in p.stdout if l.strip()], daemon=True).start()
def call(i, method, params):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n"); p.stdin.flush()
    while time.time() < deadline:
        for ln in list(msgs):
            try: o = json.loads(ln)
            except Exception: continue
            if o.get("id") == i: return o
        time.sleep(0.05)
    return None
def err(o): return json.dumps((o or {}).get("error"), ensure_ascii=False)[:200]
try:
    call(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": True}}, "clientInfo": {"name": "mocl-probe", "version": "0.0.1"}})
    r = call(2, "session/new", {"cwd": os.getcwd(), "mcpServers": []})
    rr = (r or {}).get("result") or {}
    sid = rr.get("sessionId")
    print("session/new: keys=", list(rr), " sessionId_prefix=", (sid or "")[:8])
    print("configOption ids:", [(c.get("id"), c.get("currentValue")) for c in rr.get("configOptions", [])])
    for co in rr.get("configOptions", []):
        if co.get("id") == "mode":
            print("mode options:", [(o.get("value"), o.get("name")) for o in co.get("options", [])])
    print("modes field:", rr.get("modes"))
    print("session/set_mode ->", json.dumps((call(3, "session/set_mode", {"sessionId": sid, "modeId": "plan"}) or {}).get("result"), ensure_ascii=False) or err(call(3, "session/set_mode", {"sessionId": sid, "modeId": "plan"})))
    print("session/set_model ->", err(call(4, "session/set_model", {"sessionId": sid, "modelId": "opencode-go/glm-5.3"})))
    f = call(5, "session/fork", {"sessionId": sid, "cwd": os.getcwd()})
    print("session/fork ->", "ok new sid" if ((f or {}).get("result") or {}).get("sessionId") else err(f))
    sl = call(6, "session/list", {"cwd": os.getcwd()})
    ss = ((sl or {}).get("result") or {}).get("sessions") or []
    print("session/list: n=", len(ss), "sample keys=", sorted(ss[0]) if ss else [])
finally:
    try: p.send_signal(signal.SIGTERM); p.wait(timeout=5)
    except Exception: p.kill()
PY
else
  say "6b. ACP 会话级方法（默认跳过，PROBE_ACP_SESSION=1 开启）"
  note "跳过：session/new 会写 session 库。证据见 docs/research/opencode.md §5。"
fi

say "7. v2 HttpApi：OpenAPI 端点清单（经 opencode api 自鉴权，不打印 password）"
_cap 25 "$OC" api GET /openapi.json > /tmp/probe-opencode-openapi.json 2>/dev/null
python3 - "$HOME" <<'PY'
import json
p = "/tmp/probe-opencode-openapi.json"
try:
    d = json.load(open(p, encoding="utf-8"))
except Exception as e:
    print("[skip] 无法取到 openapi.json:", e); raise SystemExit
paths = d.get("paths") or {}
print("openapi:", d.get("openapi"), "| title:", (d.get("info") or {}).get("title"), "| paths:", len(paths))
want = ("/api/event", "/api/session", "/api/agent", "/api/session/{sessionID}/prompt",
        "/api/session/{sessionID}/interrupt", "/api/session/{sessionID}/fork",
        "/api/session/{sessionID}/inbox", "/api/session/{sessionID}/permission/{requestID}/reply",
        "/api/session/{sessionID}/model", "/api/session/{sessionID}/agent",
        "/api/rpc/{rpcID}/{method}", "/api/pty/{ptyID}/connect")
for w in want:
    ops = paths.get(w)
    if not ops:
        print(f"  MISSING {w}"); continue
    for m, o in ops.items():
        print(f"  {m.upper():6} {w:56} op={o.get('operationId')}")
tags = sorted({t for o in paths.values() for op in o.values() for t in (op.get("tags") or [])})
print("tags:", ", ".join(tags))
PY

say "8. 会话列表（只读，经 v2 API）"
echo "--- opencode session list（注意：project 作用域，非 git 目录下可能返回空）"
_cap 20 "$OC" session list --max-count 3 2>&1 | head -6
echo "--- api GET /api/session?limit=3（跨项目，含 tokens/cost/outcome/fork 字段）"
_cap 20 "$OC" api GET /api/session --param limit=3 2>&1 | head -c 900; echo

say "9. 后台 service 状态（只读查询，不启动）"
_cap "$CAP" "$OC" service status 2>&1 | head -3
note "serve 启动时会把 server password 打到 stdout —— 勿写入日志/文档。鉴权实测为 HTTP Basic（user=opencode）。"

say "10. 工具扩展面（plugin / mcp / skill）"
_cap "$CAP" "$OC" mcp list 2>&1 | head -5
_cap "$CAP" "$OC" plugin --help 2>&1 | sed -n '/^SUBCOMMANDS/,/^$/p' | head -8

if [ "${PROBE_LIVE:-0}" = "1" ]; then
  say "11. 真实 run：免费模型池（PROBE_LIVE=1，零费用；2026-10-26 实测 rc=0）"
  FREE_MODEL="${PROBE_FREE_MODEL:-opencode/deepseek-v4.1-flash-free}"
  _cap 60 "$OC" run "只回复两个字符：OK" --format json -m "$FREE_MODEL" 2>&1 | head -8
  echo "--- 续接（-s：同一 sessionID）"
  SID=$(_cap 60 "$OC" run "只回复两个字符：OK" --format json -m "$FREE_MODEL" 2>/dev/null \
        | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.readline())["sessionID"])
except Exception: pass')
  if [ -n "${SID:-}" ]; then
    _cap 60 "$OC" run -s "$SID" "上一条你回复了什么原文？只回复那两个字符" \
         --format json -m "$FREE_MODEL" 2>&1 | head -4
  else
    note "未能取得 sessionID，跳过 -s 续接"
  fi
  if [ "${PROBE_PAID:-0}" = "1" ]; then
    say "11b. 付费模型探针（PROBE_PAID=1；预期 401 api_key_expired，除非已换新 key）"
    _cap 40 "$OC" run "只回复两个字符：OK" --format json \
         -m "${PROBE_PAID_MODEL:-opencode-go/deepseek-v4.1-flash}" 2>&1 | head -4 || true
  fi
else
  say "11. 真实 run（默认跳过）"
  note "跳过：PROBE_LIVE=1 跑免费模型（零费用）；PROBE_PAID=1 追加付费模型探针"
fi

say "完成"
exit 0

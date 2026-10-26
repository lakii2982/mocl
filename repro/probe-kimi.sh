#!/usr/bin/env bash
# repro/probe-kimi.sh — kimi-code 2.3.1 只读能力探测（可复跑、幂等、总时长 < 60s）
#
# 只读约定：
#   - 默认只做「不改状态」的探测：--version / --help / config 键名 / ACP initialize / session list
#   - ACP `session/new` 会在 ~/.kimi-code/sessions/ 下建目录（有副作用），默认跳过；
#     需要时显式 `PROBE_ACP_SESSION=1 bash repro/probe-kimi.sh`
#   - 真实模型调用（消耗额度）默认跳过；`PROBE_LIVE=1 bash repro/probe-kimi.sh`
#   - 任何 token/api_key 只输出键名与「已设置」标记，绝不输出值
#
# 退出码：0 = 探测完成（含"某项失败"的可解释输出）；2 = 二进制不存在。
set -uo pipefail

KIMI="${KIMI_BIN:-$HOME/.kimi-code/bin/kimi}"
CAP="${PROBE_CAP:-10}"          # 单条命令上限秒数
TOTAL_DEADLINE=$((SECONDS + 55)) # 整脚本上限，留 5s 余量

say()  { printf '\n=== %s ===\n' "$*"; }
note() { printf '[note] %s\n' "$*"; }

# 便携 timeout（macOS 无 timeout(1)）：_cap 秒数 命令...
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

if [ ! -x "$KIMI" ]; then
  echo "[FATAL] kimi binary not executable: $KIMI" >&2
  exit 2
fi

say "0. 身份与版本"
note "path=$KIMI"
ls -l "$KIMI" | awk '{print "size="$5" mtime="$6" "$7" "$8}'
_cap "$CAP" "$KIMI" --version || note "--version 失败"

say "1. 子命令面（帮助文本摘要）"
for sub in "acp --help" "session --help" "fork --help" "export --help" "provider --help"; do
  echo "--- kimi $sub"
  _cap "$CAP" "$KIMI" $sub 2>&1 | head -6
done

say "2. 权限/模式旗标（原生语义原文）"
_cap "$CAP" "$KIMI" --help 2>&1 | grep -A3 -E '^\s+(-y, --yolo|--auto|--plan|-p, --prompt|--output-format|-S, --session|-c, --continue|--agent <name>|--agent-file)' | head -40

say "3. 内置 agent profile（用未知 profile 报错反查，无副作用）"
_cap "$CAP" "$KIMI" --agent __probe_none__ -p "x" 2>&1 | head -4

say "4. config.toml 键名（值全部脱敏）"
python3 - "$HOME/.kimi-code/config.toml" <<'PY'
import re, sys
p = sys.argv[1]
try:
    lines = open(p, encoding="utf-8").read().splitlines()
except OSError as e:
    print(f"[missing] {p}: {e}"); raise SystemExit
keys, sect = [], None
for ln in lines:
    s = ln.strip()
    if not s or s.startswith("#"): continue
    if s.startswith("["):
        sect = s; keys.append(s); continue
    if "=" not in s: continue
    k, v = s.split("=", 1)
    k, v = k.strip(), v.strip()
    if re.search(r"(key|token|secret|password|credential)", k, re.I):
        is_set = v not in ('""', "''")
        keys.append("  {} = <REDACTED set={} len={}>".format(k, is_set, len(v)))
    else:
        keys.append(f"  {k} = {v[:60]}")
print("\n".join(keys[:80]))
print(f"[total lines={len(keys)}]")
PY

say "5. ACP over stdio：initialize 握手（读 protocolVersion / agentCapabilities）"
PROBE_ACP_TIMEOUT=20 python3 - "$KIMI" <<'PY'
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
        print("authMethods:", json.dumps([(a.get("id"), a.get("type")) for a in (r.get("authMethods") or [])], ensure_ascii=False))
        if got.get("error"): print("error:", json.dumps(got["error"], ensure_ascii=False))
finally:
    try: p.send_signal(signal.SIGTERM); p.wait(timeout=5)
    except Exception: p.kill()
    if errs: print("stderr tail:", errs[-3:])
PY

if [ "${PROBE_ACP_SESSION:-0}" = "1" ]; then
  say "5b. ACP session/new + session/list（有副作用：在 ~/.kimi-code/sessions 建目录）"
  PROBE_ACP_TIMEOUT=25 python3 - "$KIMI" <<'PY'
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
try:
    call(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": True}}, "clientInfo": {"name": "mocl-probe", "version": "0.0.1"}})
    r = call(2, "session/new", {"cwd": os.getcwd(), "mcpServers": []})
    sid = ((r or {}).get("result") or {}).get("sessionId")
    rr = (r or {}).get("result") or {}
    print("session/new: keys=", list(rr), " sessionId_prefix=", (sid or "")[:12])
    print("configOption ids:", [c.get("id") for c in rr.get("configOptions", [])])
    print("modes.availableModes:", [m.get("id") for m in (rr.get("modes") or {}).get("availableModes", [])])
    print("modes.currentModeId:", (rr.get("modes") or {}).get("currentModeId"))
    sf = call(3, "session/fork", {"sessionId": sid, "cwd": os.getcwd()})
    print("session/fork ->", "ok new sid" if (sf or {}).get("result", {}).get("sessionId") else json.dumps((sf or {}).get("error"), ensure_ascii=False))
    sc = call(4, "session/cancel", {"sessionId": sid})
    print("session/cancel ->", json.dumps((sc or {}).get("error"), ensure_ascii=False)[:160])
    sl = call(5, "session/list", {"cwd": os.getcwd()})
    ss = ((sl or {}).get("result") or {}).get("sessions") or []
    print("session/list: n=", len(ss), "sample keys=", sorted(ss[0]) if ss else [])
finally:
    try: p.send_signal(signal.SIGTERM); p.wait(timeout=5)
    except Exception: p.kill()
PY
else
  say "5b. ACP 会话级方法（默认跳过，PROBE_ACP_SESSION=1 开启）"
  note "跳过：session/new 会落盘。证据见 docs/research/kimi.md §5。"
fi

say "6. 会话目录结构（只读：agents/main、agents/agent-N 即原生子代理痕迹）"
ls -d "$HOME"/.kimi-code/sessions/*/*/agents/* 2>/dev/null | sed 's#.*/agents/#agents/#' | sort | uniq -c | head -12

say "7. session list（只读）"
_cap "$CAP" "$KIMI" session list --limit 3 2>&1 | head -5
_cap "$CAP" "$KIMI" session list --limit 2 --json 2>&1 | head -c 500; echo

say "8. 工具扩展面（插件 / skills / MCP）"
ls "$HOME/.kimi-code/plugins/managed" 2>/dev/null | head -8
ls "$HOME/.kimi-code/skills" 2>/dev/null | head -5
python3 - "$HOME/.kimi-code/mcp.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("[mcp.json unreadable]", e); raise SystemExit
print("mcp.json top-level keys:", list(d) if isinstance(d, dict) else type(d).__name__)
PY

if [ "${PROBE_LIVE:-0}" = "1" ]; then
  say "9. 真实 prompt 模式（PROBE_LIVE=1，会消耗额度）"
  _cap 40 "$KIMI" -p "只回复 OK" --output-format stream-json 2>&1 | head -8
else
  say "9. 真实 prompt 模式（默认跳过）"
  note "跳过：消耗额度。PROBE_LIVE=1 bash repro/probe-kimi.sh"
fi

say "完成"
note "elapsed=$SECONDS s (deadline=$TOTAL_DEADLINE)"
exit 0

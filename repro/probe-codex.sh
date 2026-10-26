#!/usr/bin/env bash
# probe-codex.sh — codex 只读探测（幂等、不消耗模型额度、不写 ~/.codex）
#
# 基线（唯一）：codex 0.164.0（默认取 PATH 上的 codex；可用 MOCL_CODEX_BIN 覆盖为绝对路径）
# 旧载荷（待升级）：DSH profile 内的 @openai/codex 0.153.4 —— 仅作迁移对照
#
# 用法:
#   bash repro/probe-codex.sh             # 探测基线 0.164.0 + 断言 CI 期望计数
#   bash repro/probe-codex.sh --legacy    # 额外导出 0.153.4 旧载荷协议并打印 0.153.4→0.164.0 差异
#
# 产出：原始证据落在 ${MOCL_PROBE_OUT:-$TMPDIR/mocl-probe}/codex/，重复执行结果一致（覆盖同一目录）。
# 安全：只读 config.toml 的**键名**，任何值形态疑似凭据的行整行跳过；运行时探针用 $OUT 下的临时 CODEX_HOME。
# 退出码：0 = 基线断言全部通过；1 = 基线缺失、版本不符或协议计数漂移（CI 期望 39 文件 / 106 / 85 / 10）。
set -uo pipefail

LEGACY=0
for a in "$@"; do
  case "$a" in
    --legacy) LEGACY=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$a" >&2; exit 2 ;;
  esac
done

OUT="${MOCL_PROBE_OUT:-${TMPDIR:-/tmp}/mocl-probe}/codex"
mkdir -p "$OUT"
BASE_BIN="${MOCL_CODEX_BIN:-$(command -v codex || true)}"
EXPECT_VER="${MOCL_CODEX_EXPECT:-0.164.0}"
EXPECT_CLIENT=106
EXPECT_NOTIF=85
EXPECT_REQUEST=10
EXPECT_FILES=39
BUNDLE_DIR="${HOME}/.dsh/profiles/desktop/node_modules/@openai/codex-darwin-arm64"
BUNDLE_BIN="${BUNDLE_DIR}/vendor/aarch64-apple-darwin/bin/codex"
DSH_PLUGIN="${HOME}/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-subagent-codex"
FAIL=0

say() { printf '%s\n' "$*"; }
hr()  { printf "%s\n" "============================================================"; }
ok()  { say "  PASS $*"; }
bad() { say "  FAIL $*"; FAIL=1; }
ver_of() { [ -x "${1:-}" ] && "$1" --version 2>&1 | head -1 || true; }

say "== probe-codex  baseline=${EXPECT_VER}  out=${OUT}  legacy=${LEGACY}"

# ---------------------------------------------------------------- 1. 基线版本 + 旧载荷版本（打印两处与一致性）
hr; say "[1] 版本：基线（唯一） vs 旧载荷"
BASE_VER=""
if [ -n "${BASE_BIN:-}" ] && [ -x "$BASE_BIN" ]; then
  BASE_VER="$(ver_of "$BASE_BIN")"
  say "  基线 path : $(readlink -f "$BASE_BIN" 2>/dev/null || echo "$BASE_BIN")"
  say "  基线 ver  : ${BASE_VER}"
  case "$BASE_VER" in
    *"codex-cli ${EXPECT_VER}"*) ok "基线版本 == ${EXPECT_VER}" ;;
    *) bad "基线版本不是 ${EXPECT_VER}（CI 期望）" ;;
  esac
else
  bad "基线 codex 不存在（PATH 无 codex；可用 MOCL_CODEX_BIN 指定绝对路径）"
fi
BUNDLE_VER=""
if [ -x "$BUNDLE_BIN" ]; then
  BUNDLE_VER="$(ver_of "$BUNDLE_BIN")"
  say "  旧载荷 path: ${BUNDLE_BIN}"
  say "  旧载荷 ver : ${BUNDLE_VER}（待升级）"
  say "  旧载荷 npm : $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' \
        "${BUNDLE_DIR}/package.json" 2>/dev/null || echo '(package.json unreadable)')"
else
  say "  旧载荷: SKIP（${BUNDLE_BIN} 不存在）"
fi
if [ -n "${BASE_VER:-}" ] && [ -n "${BUNDLE_VER:-}" ]; then
  if [ "${BASE_VER##* }" = "${BUNDLE_VER##* }" ] || [ "$BASE_VER" = "$BUNDLE_VER" ]; then
    say "  版本一致性: SAME（两处一致，升级已完成）"
  else
    say "  版本一致性: DIFF（旧载荷待升级；探测本身不判失败，升级验收见 docs/adapters/codex.md §12.4 A0）"
  fi
fi

# ---------------------------------------------------------------- 2. 子命令面（基线；--legacy 时对照旧载荷）
hr; say "[2] 子命令面"
if [ -x "${BASE_BIN:-}" ]; then
  BASE_SUBS="$("$BASE_BIN" --help 2>&1 | sed -n '/^Commands:/,/^Arguments:/p' | awk '/^  [a-z]/{print $1}' | tr '\n' ' ')"
  "$BASE_BIN" --help > "$OUT/help-baseline.txt" 2>&1
  say "  基线: ${BASE_SUBS}"
  case " ${BASE_SUBS} " in
    *" app-server "*) ok "基线有 app-server 子命令" ;;
    *) bad "基线缺 app-server" ;;
  esac
  case " ${BASE_SUBS} " in
    *" acp "*) bad "基线出现 acp（预期不存在）" ;;
    *) ok "基线无 acp 子命令（ACP 通道不适用）" ;;
  esac
else
  say "  基线: SKIP"
fi
if [ "$LEGACY" -eq 1 ] && [ -x "$BUNDLE_BIN" ]; then
  LEG_SUBS="$("$BUNDLE_BIN" --help 2>&1 | sed -n '/^Commands:/,/^Arguments:/p' | awk '/^  [a-z]/{print $1}' | tr '\n' ' ')"
  "$BUNDLE_BIN" --help > "$OUT/help-legacy.txt" 2>&1
  say "  旧载荷: ${LEG_SUBS}"
  say "  子命令差异: $(python3 - "$OUT/help-baseline.txt" "$OUT/help-legacy.txt" <<'PY'
import sys
def subs(p):
    out, on = set(), False
    for ln in open(p, errors="replace"):
        s = ln.rstrip("\n")
        if s.startswith("Commands:"): on = True; continue
        if on and s.startswith("Arguments:"): break
        if on and s.startswith("  ") and s.strip() and s.strip()[0].isalpha():
            out.add(s.strip().split()[0])
    return out
a, b = subs(sys.argv[1]), subs(sys.argv[2])
print("仅基线=%s 仅旧载荷=%s" % (sorted(a - b), sorted(b - a)))
PY
)"
fi

# ---------------------------------------------------------------- 3. CLI 关键子命令帮助（基线）
hr; say "[3] CLI 帮助取证（基线）"
if [ -x "${BASE_BIN:-}" ]; then
  for sub in "exec" "exec resume" "resume" "queue" "fork" "agents" "app-server daemon"; do
    f="$OUT/help-$(printf '%s' "$sub" | tr ' ' '-').txt"
    "$BASE_BIN" $sub --help > "$f" 2>&1
    say "  codex ${sub} --help  -> ${f}  ($(grep -c . "$f") 行)"
  done
  say "  exec 面 flag 出现次数（--json/--output-schema/--ephemeral/--sandbox/--worktree）:"
  for flag in --json --output-schema --ephemeral --sandbox --worktree; do
    printf '    %-16s %s\n' "$flag" "$(grep -c -- "$flag" "$OUT/help-exec.txt" 2>/dev/null || echo 0)"
  done
else
  say "  SKIP"
fi

# ---------------------------------------------------------------- 4. 基线协议导出 + CI 期望计数断言
hr; say "[4] 基线 app-server JSON Schema（期望 ${EXPECT_FILES} 文件 / ${EXPECT_CLIENT} / ${EXPECT_NOTIF} / ${EXPECT_REQUEST}）"
SCHEMA_BASE="$OUT/schema-baseline"
rm -rf "$SCHEMA_BASE"
if [ -x "${BASE_BIN:-}" ]; then
  if "$BASE_BIN" app-server generate-json-schema --out "$SCHEMA_BASE" >/dev/null 2>&1; then
    ok "基线 schema 导出 -> ${SCHEMA_BASE} ($(ls "$SCHEMA_BASE" | wc -l | tr -d ' ') files)"
  else
    bad "基线 generate-json-schema 失败"
  fi
else
  say "  SKIP（基线缺失）"
fi

python3 - "$SCHEMA_BASE" "$EXPECT_FILES" "$EXPECT_CLIENT" "$EXPECT_NOTIF" "$EXPECT_REQUEST" <<'PY' || FAIL=1
import json, os, sys
root, ef, ec, en, er = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
if not os.path.isdir(root) or not os.path.isfile(os.path.join(root, "ClientRequest.json")):
    print("  FAIL 基线 schema 目录不可用"); sys.exit(1)
def methods(path):
    d = json.load(open(path)); got = set()
    def take(m):
        for k in ("enum", "const"):
            if k in m:
                v = m[k] if isinstance(m[k], list) else [m[k]]
                for e in v:
                    if isinstance(e, str) and e: got.add(e)
    def walk(o):
        if isinstance(o, dict):
            pr = o.get("properties")
            if isinstance(pr, dict) and isinstance(pr.get("method"), dict): take(pr["method"])
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(d); return got
files = len(os.listdir(root))  # 39 = 37 个顶层 JSON + v1/ v2/ 两个子目录（与 ls | wc -l 同口径）
c = methods(os.path.join(root, "ClientRequest.json"))
s = methods(os.path.join(root, "ServerNotification.json"))
r = methods(os.path.join(root, "ServerRequest.json"))
fail = 0
def chk(name, got, exp):
    global fail
    mark = "PASS" if got == exp else "FAIL"
    if got != exp: fail = 1
    print(f"  {mark} {name}: {got} (期望 {exp})")
chk("schema 条目（37 JSON + v1/ v2/）", files, ef)
chk("ClientRequest", len(c), ec)
chk("ServerNotification", len(s), en)
chk("ServerRequest(method)", len(r), er)
plain = sorted(m for m in c | s if "/" not in m)
print(f"  无斜杠方法({len(plain)}): {' '.join(plain)}")
for pref in ("thread/", "turn/", "item/"):
    hit = sorted(m for m in c | s if m.startswith(pref))
    print(f"  {pref}* {len(hit)}: {' '.join(hit)}")
print(f"  thread/ 方法: {' '.join(sorted(m for m in c if m.startswith('thread/')))}")
print(f"  turn/   方法: {' '.join(sorted(m for m in c if m.startswith('turn/')))}")
print(f"  ServerRequest: {' '.join(sorted(r))}")
p = os.path.join(root, "codex_app_server_protocol.v2.schemas.json")
d = json.load(open(p))["definitions"] if os.path.isfile(p) else {}
print(f"  v2 definitions: {len(d)}")
for n in ("CollabAgentTool", "MultiAgentMode", "MultiAgentVersion"):
    if n in d: print(f"  {n}: {json.dumps(d[n].get('enum') or d[n].get('oneOf'), ensure_ascii=False)}")
for n in ("ThreadLoadedListParams", "ThreadLoadedListResponse", "ThreadResumeParams", "ThreadResumeResponse"):
    if n in d: print(f"  {n}: props={list(d[n].get('properties', {}))}")
items = d.get("ThreadItem", {}).get("oneOf") or []
types = [v["properties"]["type"]["enum"][0] for v in items if v.get("properties", {}).get("type", {}).get("enum")]
print(f"  ThreadItem 变体 {len(types)}: {' '.join(types)}")
for v in items:
    if v.get("properties", {}).get("type", {}).get("enum") == ["collabAgentToolCall"]:
        print(f"  collabAgentToolCall: props={list(v['properties'])} required={v.get('required')}")
sys.exit(1 if fail else 0)
PY

# ---------------------------------------------------------------- 4b. 运行时方法集探针（基线；临时 CODEX_HOME，零额度）
hr; say "[4b] 运行时方法集探针（schema ≠ runtime；临时 CODEX_HOME，零额度）"
RT_HOME="$OUT/home-runtime"; rm -rf "$RT_HOME"; mkdir -p "$RT_HOME"
if [ -x "${BASE_BIN:-}" ]; then
  python3 - "$BASE_BIN" "$RT_HOME" "$EXPECT_VER" <<'PY'
import json, os, signal, subprocess, sys, time
BIN, HOME, EXPECT = sys.argv[1], sys.argv[2], sys.argv[3]
def alarm(_s, _f): raise SystemExit("TIMEOUT")
signal.signal(signal.SIGALRM, alarm); signal.alarm(60)
env = {**os.environ, "CODEX_HOME": HOME}          # 0.164.0 要求该目录已存在（已 mkdir）
p = subprocess.Popen([BIN, "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True, bufsize=1)
time.sleep(0.6)                                   # 等 node 包装器就绪，避免 EPIPE
n, notes, fail = 0, [], 0
def send(m, params):
    global n
    n += 1
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": n, "method": m, "params": params}) + "\n")
    p.stdin.flush(); return n
def ru(i, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        ln = p.stdout.readline()
        if not ln: return None
        try: o = json.loads(ln)
        except Exception: continue
        if o.get("id") == i: return o
        if "method" in o: notes.append(o["method"])
    return None
def chk(name, cond, detail=""):
    global fail
    print(f"  {'PASS' if cond else 'FAIL'} {name}{(' — ' + detail) if detail else ''}")
    if not cond: fail = 1
init = ru(send("initialize", {"clientInfo": {"name": "mocl-probe", "version": "0.1"}})) or {}
ua = (init.get("result") or {}).get("userAgent", "")
chk("initialize.userAgent 含基线版本", EXPECT in ua, ua)
st = ru(send("thread/start", {"cwd": os.getcwd(), "ephemeral": False})) or {}
th = (st.get("result") or {}).get("thread") or {}
chk("thread/start ephemeral=false", th.get("ephemeral") is False)
chk("thread.cliVersion 含基线版本", EXPECT in str(th.get("cliVersion")), str(th.get("cliVersion")))
chk("thread.start 不依赖 thread/started 通知", "thread/started" not in notes, str(notes[:3]))
tid = th.get("id")
res = ru(send("thread/resume", {"threadId": tid})) if tid else {}
chk("resume 未 materialize → -32600 no rollout", (res.get("error") or {}).get("code") == -32600
    and "no rollout found" in (res.get("error") or {}).get("message", ""))
tl = ru(send("thread/turns/list", {"threadId": tid, "limit": 1})) if tid else {}
chk("turns/list 未 materialize → -32600 not materialized", (tl.get("error") or {}).get("code") == -32600
    and "not materialized" in (tl.get("error") or {}).get("message", ""))
il = ru(send("thread/items/list", {"threadId": tid, "limit": 1})) if tid else {}
chk("items/list 运行时未实现 → -32601 not supported", (il.get("error") or {}).get("code") == -32601
    and "not supported" in (il.get("error") or {}).get("message", ""))
ar = ru(send("thread/archive", {"threadId": tid})) if tid else {}
chk("archive 未 materialize 也可归档（基线行为变化）", "result" in ar)
rel = ru(send("thread/start", {"cwd": "relative/path"})) or {}
chk("相对 cwd 被后端接受（适配器必须自行校验）", "result" in rel,
    str((rel.get("result") or {}).get("cwd")))
unk = ru(send("thread/doesNotExist", {})) or {}
msg = (unk.get("error") or {}).get("message", "")
chk("未知方法 → -32600 unknown variant（不是 -32601）", (unk.get("error") or {}).get("code") == -32600
    and "unknown variant" in msg)
chk("运行时存在未导出方法（server/diagnostics 或 userVerification/*）",
    any(k in msg for k in ("server/diagnostics", "userVerification")))
p.terminate()
try: p.wait(timeout=5)
except Exception: p.kill()
sys.exit(1 if fail else 0)
PY
  [ $? -eq 0 ] || FAIL=1
else
  say "  SKIP（基线缺失）"
fi

# ---------------------------------------------------------------- 4c. --legacy：旧载荷导出 + 迁移差异表
if [ "$LEGACY" -eq 1 ]; then
  hr; say "[4c] 旧载荷 0.153.4 导出与 0.153.4 → ${EXPECT_VER} 迁移差异（仅 --legacy）"
  SCHEMA_LEGACY="$OUT/schema-legacy"
  rm -rf "$SCHEMA_LEGACY"
  if [ -x "$BUNDLE_BIN" ] && "$BUNDLE_BIN" app-server generate-json-schema --out "$SCHEMA_LEGACY" >/dev/null 2>&1; then
    say "  旧载荷 schema -> ${SCHEMA_LEGACY} ($(ls "$SCHEMA_LEGACY" | wc -l | tr -d ' ') files)"
    python3 - "$SCHEMA_LEGACY" "$SCHEMA_BASE" <<'PY'
import json, os, sys
L, B = sys.argv[1], sys.argv[2]
def methods(p):
    d = json.load(open(p)); got = set()
    def take(m):
        for k in ("enum", "const"):
            if k in m:
                v = m[k] if isinstance(m[k], list) else [m[k]]
                for e in v:
                    if isinstance(e, str) and e: got.add(e)
    def walk(o):
        if isinstance(o, dict):
            pr = o.get("properties")
            if isinstance(pr, dict) and isinstance(pr.get("method"), dict): take(pr["method"])
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(d); return got
for f in ("ClientRequest", "ServerNotification", "ServerRequest"):
    a = methods(os.path.join(L, f + ".json")); b = methods(os.path.join(B, f + ".json"))
    print(f"  {f}: {len(a)} → {len(b)} | 新增={sorted(b - a)} | 删除={sorted(a - b)}")
def defs(p):
    q = os.path.join(p, "codex_app_server_protocol.v2.schemas.json")
    return json.load(open(q))["definitions"] if os.path.isfile(q) else {}
a, b = defs(L), defs(B)
print(f"  v2 definitions: {len(a)} → {len(b)} | 新增 {len(set(b) - set(a))} / 删除 {sorted(set(a) - set(b))}")
ch = [k for k in sorted(set(a) & set(b)) if json.dumps(a[k], sort_keys=True) != json.dumps(b[k], sort_keys=True)]
print(f"  同名定义变化: {len(ch)}")
for n in ("TurnStartParams", "ThreadResumeResponse", "ThreadStartResponse", "ThreadForkResponse"):
    if n in a and n in b and "properties" in a[n] and "properties" in b[n]:
        pa, pb = set(a[n]["properties"]), set(b[n]["properties"])
        if pa != pb: print(f"  {n}: +基线={sorted(pb - pa)} -旧载荷={sorted(pa - pb)}")
PY
  else
    say "  SKIP（旧载荷缺失或导出失败）"
  fi
fi

# ---------------------------------------------------------------- 5. config.toml 键名（值一律不打印）
hr; say "[5] ~/.codex/config.toml 键名（仅键，值已跳过；并发/深度是运行时配置，不是默认值）"
CFG="${HOME}/.codex/config.toml"
if [ -f "$CFG" ]; then
  say "  [agents] 段全文（仅键名；疑似凭据的值一律替换）:"
  python3 - "$CFG" <<'PYEOF'
import re, sys
lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().splitlines()
SENS = re.compile(r'(api[_-]?key|token|secret|password|cookie|authorization|bearer|credential)', re.I)
start = next((i for i, ln in enumerate(lines) if ln.strip() == "[agents]"), None)
if start is None:
    print("    (无 [agents] 段)")
else:
    for ln in lines[start:]:
        s = ln.strip()
        if s.startswith("[") and s != "[agents]":
            break
        if not s or s.startswith("#"):
            continue
        print("    " + (s.split("=")[0].strip() + " = <已跳过敏感值>" if SENS.search(s) else s))
PYEOF
  say "  [mcp_servers] 段名（仅段名与键名，env 值不打印）:"
  grep -nE '^\[mcp_servers\.[^]]+\](\.env)?$' "$CFG" | sed -E 's/^/    /' || say "    (无)"
  say "  全部顶层段名:"
  grep -oE '^\[[A-Za-z0-9_.-]+\]' "$CFG" | sort -u | tr '\n' ' ' | sed -E 's/^/    /'; echo
else
  say "  SKIP ${CFG} 不存在"
fi
say "  每代理角色定义文件（~/.codex/agents/*.toml，仅列文件名与键名）:"
if [ -d "${HOME}/.codex/agents" ]; then
  for f in "${HOME}"/.codex/agents/*.toml; do
    [ -f "$f" ] || continue
    say "    $(basename "$f"): keys=$(grep -oE '^[a-z_]+' "$f" | tr '\n' ',' | sed 's/,$//')"
  done
else
  say "    SKIP 目录不存在"
fi

# ---------------------------------------------------------------- 6. 本机会话存储（resume 的物理前提）
hr; say "[6] 本机会话存储（持久化 = resume/fork 的前提；含跨版本混写）"
SESS="${HOME}/.codex/sessions"
if [ -d "$SESS" ]; then
  say "  rollout jsonl 数量: $(find "$SESS" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
  say "  最新一条: $(find "$SESS" -name '*.jsonl' 2>/dev/null | sort | tail -1)"
  say "  archived(.zst) 数量: $(find "${HOME}/.codex/archived_sessions" -name '*.zst' 2>/dev/null | wc -l | tr -d ' ')"
  python3 - "$SESS" <<'PY'
import json, os, sys
from collections import Counter
root = sys.argv[1]
vers, src, mav, parents, total = Counter(), Counter(), Counter(), 0, 0
for dirpath, _dn, fns in os.walk(root):
    for fn in fns:
        if not fn.endswith(".jsonl"): continue
        total += 1
        try:
            pl = (json.loads(open(os.path.join(dirpath, fn).readline()) or {}) or {}).get("payload") or {}
        except Exception:
            continue
        vers[pl.get("cli_version")] += 1
        src[pl.get("thread_source")] += 1
        mav[pl.get("multi_agent_version")] += 1
        if pl.get("parent_thread_id"): parents += 1
print(f"  cli_version 混写: {dict(vers)}")
print(f"  thread_source: {dict(src)}")
print(f"  multi_agent_version: {dict(mav)}")
print(f"  有 parent_thread_id: {parents}/{total}")
PY
else
  say "  SKIP ${SESS} 不存在"
fi

# ---------------------------------------------------------------- 7. 特性开关（能力面）
hr; say "[7] codex features list（多代理相关，基线）"
if [ -x "${BASE_BIN:-}" ]; then
  "$BASE_BIN" features list > "$OUT/features-baseline.txt" 2>&1 || true
  grep -iE 'multi_agent|collab|agent_message_board|subagent|daemon|context_management' "$OUT/features-baseline.txt" \
    | sed -E 's/^/    /' || say "    (无匹配)"
  say "  总开关数基线: $(grep -c . "$OUT/features-baseline.txt")"
else
  say "  SKIP"
fi

# ---------------------------------------------------------------- 8. DSH 现有插件读了什么 + 它钉的 codex 版本
hr; say "[8] DSH 插件 @deepseek-ai/dsh-subagent-codex 的协议使用面与依赖钉法"
if [ -f "${DSH_PLUGIN}/lib/index.js" ]; then
  say "  插件版本: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "${DSH_PLUGIN}/package.json" 2>/dev/null || echo '?')"
  say "  插件对 @openai/codex 的依赖（升级检查点）: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dependencies"].get("@openai/codex"))' "${DSH_PLUGIN}/package.json" 2>/dev/null || echo '?')"
  say "  插件解析二进制的机制: $(grep -n 'resolve(\"@openai/codex/package.json\")' "${DSH_PLUGIN}/lib/index.js" | head -1)"
  say "  lib/index.js 引用的产品方法:"
  grep -oE '"(thread|turn|item)/[a-zA-Z/_]+"' "${DSH_PLUGIN}/lib/index.js" | sort -u | sed -E 's/^/    /'
  say "  ephemeral 事实:"
  grep -n 'ephemeral' "${DSH_PLUGIN}/lib/index.js" | sed -E 's/^/    /'
  say "  thread/resume|thread/fork 引用次数: $(grep -cE '"thread/(resume|fork)"' "${DSH_PLUGIN}/lib/index.js" || true)"
else
  say "  SKIP ${DSH_PLUGIN}/lib/index.js 不存在"
fi

hr
if [ "$FAIL" -eq 0 ]; then
  say "== probe-codex 完成：基线断言全部通过（原始产物: ${OUT}）"
else
  say "== probe-codex 完成：**基线断言失败**（见上方 FAIL；CI 期望 ${EXPECT_FILES}/${EXPECT_CLIENT}/${EXPECT_NOTIF}/${EXPECT_REQUEST}）"
fi
exit "$FAIL"

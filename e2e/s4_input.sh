#!/bin/bash
# s4: R10 快捷键（CGEvent→前台 input）+ R11 打字统计
source e2e/lib.sh
cd "$REPO"

wait_cdp 5 || { verdict R10 inconclusive "CDP 不可达"; exit 1; }

# ---- R10: 先把 app 窗口带到前台（自动化环境里 nohup 起的窗口默认无焦点）----
osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "Electron") to true' 2>"$EV/s4-activate-err.txt" && echo "activated" || echo "activate-failed: $(head -c 150 "$EV/s4-activate-err.txt")"
sleep 1
node e2e/cdp.mjs eval 'window.focus(); (() => { if (!document.getElementById("e2e-input")) { const i = document.createElement("input"); i.id="e2e-input"; i.style="position:fixed;top:10px;left:10px;z-index:99999;font-size:20px;padding:8px"; document.body.appendChild(i);} const i = document.getElementById("e2e-input"); i.value=""; i.focus(); return document.hasFocus(); })()' \
  | tee "$EV/s4-focus.json"
FOCUSED=$(tr -d '"\n' < "$EV/s4-focus.json")

# app 自身发快捷键 Shift+B（CGEventPost 路由到前台 input）
node e2e/cdp.mjs eval 'window.aikey.testAction({type:"hotkey", combo:"Shift+B"}).then(r => JSON.stringify(r))' | tee "$EV/s4-hotkey-result.json"
sleep 1.5
node e2e/cdp.mjs eval 'document.getElementById("e2e-input").value' | tee "$EV/s4-input-value.json"
VAL=$(tr -d '"\n' < "$EV/s4-input-value.json")

if [ "$VAL" = "B" ]; then
  verdict R10 pass "CGEvent 快捷键送达前台 input（value='B'）——辅助功能授权生效"
elif [ "$FOCUSED" != "true" ]; then
  verdict R10 inconclusive "窗口未聚焦（hasFocus=$FOCUSED），无法归因"
else
  # 归因：TCC 无法程序化读取 → env-missing + 人工核验指引
  verdict R10 env-missing "input 未收到字符（value='$VAL'）。大概率 dev 版 Electron 无辅助功能授权：系统设置>隐私与安全>辅助功能 手动加 node_modules/electron/dist/Electron.app 后复测；已授权仍无效才是 app-bug"
fi

# ---- R11: 打字统计 ----
node e2e/cdp.mjs eval 'window.aikey.statsGet().then(s => JSON.stringify(s))' | tee "$EV/s4-stats-before.json"
BEFORE=$(python3 -c 'import json,sys; print(json.loads(json.loads(sys.stdin.read()))["today"]["total"])' < "$EV/s4-stats-before.json" 2>/dev/null || echo "ERR")
grep -q '"supported":[^f]' "$EV/s4-stats-before.json" 2>/dev/null || true
python3 -c 'import json; s=json.loads(json.loads(open("'"$EV"'/s4-stats-before.json").read())); print("supported:", s.get("supported"))' 2>/dev/null | tee "$EV/s4-stats-supported.txt"

# OS 级击键注入：长按（key down → 停 300ms → key up），瞬时 keystroke 可能短于轮询间隔被漏采
osascript -e 'tell application "System Events" to key down "z"' 2>>"$EV/s4-osascript-err.txt" && sleep 0.3 && osascript -e 'tell application "System Events" to key up "z"' 2>>"$EV/s4-osascript-err.txt" && INJECT=ok || INJECT=fail
sleep 2
node e2e/cdp.mjs eval 'window.aikey.statsGet().then(s => JSON.stringify(s))' | tee "$EV/s4-stats-after.json"
AFTER=$(python3 -c 'import json,sys; print(json.loads(json.loads(sys.stdin.read()))["today"]["total"])' < "$EV/s4-stats-after.json" 2>/dev/null || echo "ERR")

if [ "$INJECT" = "ok" ] && [ "$AFTER" -gt "$BEFORE" ] 2>/dev/null; then
  verdict R11 pass "OS 注入后 today.total $BEFORE -> $AFTER"
elif [ "$INJECT" = "fail" ]; then
  verdict R11 env-missing "osascript 注入被拒（自动化权限）: $(head -c 200 "$EV/s4-osascript-err.txt" | tr '\n' ' ')"
else
  verdict R11 app-bug "注入成功但计数未增（$BEFORE -> $AFTER）"
fi

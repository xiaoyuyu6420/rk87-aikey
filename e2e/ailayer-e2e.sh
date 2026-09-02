#!/bin/bash
# AI 层专项 E2E（v0.12.0 新功能）：系统热键 → 动作执行 的端到端验证
# B1 启用态：config 预置 aiLayer.enabled + F6=记事本 → 启动注册 12/12 →
#    SendInput 注入 Ctrl+Alt+F6 → 记事本进程出现
# B3 重注册竞态：连续两次 op:set（alt→ctrlalt，复现 syncAilayer stop→start）→
#    窗口期注入（预期可能丢）+ 稳定期注入（预期必中）
# C  默认关闭态：enabled=false → 注入不触发（零影响证明）
# 用法: bash e2e/ailayer-e2e.sh
set -u
cd "$(dirname "$0")/.."
EV="e2e/evidence-win"
RJ="$EV/ailayer-results.jsonl"
PORT=9335
export CDP_PORT=$PORT # cdp.mjs 读此变量，漏掉会打向默认 9222 全部 fetch failed
mkdir -p "$EV"
: > "$RJ" # 每轮全新 results：退出码只判本轮，不被历史追加污染

verdict() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" | tee -a "$RJ"; }

notepad_count() { tasklist //FI "IMAGENAME eq notepad.exe" //NH 2>/dev/null | grep -ci "notepad.exe" || true; }

wait_cdp() { # port max_seconds
  local i=0
  while [ $i -lt "$2" ]; do
    if curl -s --max-time 2 "http://127.0.0.1:$1/json" 2>/dev/null | grep -q webSocketDebuggerUrl; then return 0; fi
    sleep 1; i=$((i+1))
  done
  return 1
}

wait_log() { # pattern max_seconds logfile
  local i=0
  while [ $i -lt "$2" ]; do
    grep -q "$1" "$3" 2>/dev/null && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

port_pid() { netstat -ano 2>/dev/null | grep ":$1 " | grep -i LISTENING | awk '{print $NF}' | head -1; }

kill_app() {
  if [ -f "$EV/ai.pid" ]; then
    local pid; pid=$(cat "$EV/ai.pid")
    taskkill //F //T //PID "$pid" >/dev/null 2>&1 || true
    rm -f "$EV/ai.pid"
  fi
  # 兜底：包装 node 被杀但 electron 孤儿仍监听 CDP 端口时，按端口找到并杀掉，
  # 并循环验证端口真正释放（否则下一场景的 wait_cdp 会探到僵尸实例）
  local i=0 pp
  while [ $i -lt 10 ]; do
    pp=$(port_pid $PORT)
    [ -z "$pp" ] && break
    taskkill //F //T //PID "$pp" >/dev/null 2>&1 || true
    sleep 1; i=$((i+1))
  done
  sleep 1
}

start_app() { # userdata_dir logfile
  ELECTRON_ENABLE_LOGGING=1 node node_modules/electron/cli.js \
    --remote-debugging-port=$PORT --user-data-dir="$1" . \
    > "$2" 2>&1 &
  echo $! > "$EV/ai.pid"
}

# ---------- B1: 启用态 ----------
kill_app # 战场清理：上一轮残留的 electron 孤儿会占 CDP 端口污染全部 verdict
UD1="$PWD/e2e/tmp-userdata-ai"
rm -rf "$UD1"; mkdir -p "$UD1"
cat > "$UD1/config.json" <<'EOF'
{ "aiLayer": { "enabled": true, "trigger": "ctrlalt",
    "slots": { "f6": { "type": "app", "target": "C:/Windows/notepad.exe" } } } }
EOF

echo "===== [B1] 启用态：注册 → 注入 Ctrl+Alt+F6 → 记事本 ====="
LOG1="$EV/ai-b1.log"
start_app "$UD1" "$LOG1"

if wait_cdp $PORT 20; then verdict B1 pass "CDP 20s 内就绪"; else
  verdict B1 app-bug "CDP 未就绪: $(tail -c 300 "$LOG1" | tr '\n' ' ')"; kill_app; exit 1; fi

if wait_log '已注册 12/12' 15 "$LOG1"; then
  verdict B1 pass "注册 12/12: $(grep '已注册' "$LOG1" | head -1)"
else
  verdict B1 app-bug "未见 12/12 注册日志: $(grep -i ailayer "$LOG1" | head -3 | tr '\n' ' ')"
fi

N0=$(notepad_count)
node tools/inject-hotkey.js Ctrl+Alt+F6
sleep 4
N1=$(notepad_count)
if [ "$N1" -gt "$N0" ]; then
  verdict B1 pass "注入 Ctrl+Alt+F6 → 记事本启动（$N0 → $N1 个进程）"
else
  verdict B1 app-bug "注入后记事本未启动（$N0 → $N1）；触发日志: $(grep '触发' "$LOG1" | head -2 | tr '\n' ' ')"
fi
node e2e/cdp.mjs shot "$EV/ai-b1.png" >/dev/null 2>&1 || true

# ---------- B2: AI 直达 UI——set 往返保留 after 字段 + 重载后界面回显 ----------
echo "===== [B2] AI 直达：f7 配 url+延时快捷键 → 重载 → 编辑器回显 ====="
node e2e/cdp.mjs eval 'window.aikey.aiLayerOp({op:"set", config:{enabled:true, trigger:"ctrlalt", slots:{f7:{type:"url", target:"https://example.com", afterHotkey:"Ctrl+L", afterDelay:500}}}}).then(r=>({ok:r.ok, f7:JSON.stringify(r.config.slots.f7)}))' > "$EV/ai-b2-set.json" 2>&1
cat "$EV/ai-b2-set.json"
if grep -q 'afterHotkey' "$EV/ai-b2-set.json"; then
  verdict B2 pass "op:set 往返后 afterHotkey/afterDelay 未被剥离"
else
  verdict B2 app-bug "op:set 剥离了 AI 直达扩展字段: $(cat "$EV/ai-b2-set.json")"
fi
node e2e/cdp.mjs eval 'location.reload()' >/dev/null 2>&1 || true
sleep 4
node e2e/cdp.mjs eval '(() => { const a = document.querySelector(".ailayer-after"); return JSON.stringify({ rows: document.querySelectorAll(".ailayer-row").length, afterShown: !!a, delay: a && a.querySelector("input[type=number]").value, hotkey: a && a.querySelector("input[type=text]").value }); })()' > "$EV/ai-b2-ui.json" 2>&1
cat "$EV/ai-b2-ui.json"
# eval 返回被 JSON 序列化两层（文件里是 \" 转义），用 node 双层解析后断言
if node -e "const s=require('fs').readFileSync('$EV/ai-b2-ui.json','utf8'); const o=JSON.parse(JSON.parse(s)); process.exit(o.rows===12 && o.afterShown && o.delay==='500' && o.hotkey==='Ctrl+L' ? 0 : 1)" 2>/dev/null; then
  verdict B2 pass "重载后 12 行 + AI 直达子行回显（500ms/Ctrl+L）"
else
  verdict B2 app-bug "AI 直达子行渲染/回显异常: $(cat "$EV/ai-b2-ui.json")"
fi

# ---------- B3: 重注册竞态（连续改配置 → stop/start 窗口） ----------
echo "===== [B3] 重注册竞态：连续三次 set（最后一对同 trigger=ctrlalt → 最危险窗口） ====="
node e2e/cdp.mjs eval 'window.aikey.aiLayerOp({op:"set", config:{enabled:true, trigger:"alt", slots:{f6:{type:"app",target:"C:/Windows/notepad.exe"}}}}).then(r=>({ok:r.ok,running:r.running}))' > "$EV/ai-b3-set1.json" 2>&1
node e2e/cdp.mjs eval 'window.aikey.aiLayerOp({op:"set", config:{enabled:true, trigger:"ctrlalt", slots:{f6:{type:"app",target:"C:/Windows/notepad.exe"}}}}).then(r=>({ok:r.ok,running:r.running}))' > "$EV/ai-b3-set2.json" 2>&1
node e2e/cdp.mjs eval 'window.aikey.aiLayerOp({op:"set", config:{enabled:true, trigger:"ctrlalt", slots:{f6:{type:"app",target:"C:/Windows/notepad.exe"}}}}).then(r=>({ok:r.ok,running:r.running}))' > "$EV/ai-b3-set3.json" 2>&1
cat "$EV/ai-b3-set1.json" "$EV/ai-b3-set2.json" "$EV/ai-b3-set3.json"

# 窗口期注入（stop 后 300ms 内，旧线程热键未必释放、新热键未必注册上）
sleep 0.3
N0=$(notepad_count)
node tools/inject-hotkey.js Ctrl+Alt+F6
sleep 3
N1=$(notepad_count)
RACE_LOG=$(grep -c '已注册 12/12' "$LOG1" || true)
if [ "$N1" -gt "$N0" ]; then
  verdict B3 pass "窗口期注入触发（本次竞态未命中，注册次数 $RACE_LOG）"
else
  # 区分：热键丢了（竞态命中）还是动作失败——查触发日志
  if tail -20 "$LOG1" | grep -q 'f6 触发'; then
    verdict B3 app-bug "触发了但记事本没起"
  else
    verdict B3 known-issue "窗口期注入未触发（竞态命中：新热键未注册上）；恢复注入见下"
  fi
fi

# 稳定期注入（1.2s 后热键必然应已注册）——恢复性证明
sleep 1.2
N0=$(notepad_count)
node tools/inject-hotkey.js Ctrl+Alt+F6
sleep 3
N1=$(notepad_count)
[ "$N1" -gt "$N0" ] && verdict B3 pass "稳定期注入触发（功能最终一致）" \
  || verdict B3 app-bug "稳定期注入仍未触发——重注册后热键坏死: $(grep -i 'ailayer' "$LOG1" | tail -3 | tr '\n' ' ')"
kill_app

# ---------- C: 默认关闭态 ----------
echo "===== [C] 默认关闭态：注入不触发（零影响） ====="
UD2="$PWD/e2e/tmp-userdata-ai-off"
rm -rf "$UD2"; mkdir -p "$UD2"
echo '{ "aiLayer": { "enabled": false, "trigger": "ctrlalt", "slots": { "f6": { "type": "app", "target": "C:/Windows/notepad.exe" } } } }' > "$UD2/config.json"
LOG2="$EV/ai-c.log"
start_app "$UD2" "$LOG2"
wait_cdp $PORT 20 || { verdict C app-bug "关闭态 CDP 未就绪"; kill_app; exit 1; }
sleep 3
if grep -q '已注册' "$LOG2"; then
  verdict C app-bug "关闭态竟注册了热键（零影响破坏）: $(grep '已注册' "$LOG2" | head -1)"
else
  verdict C pass "关闭态无任何热键注册日志"
fi
N0=$(notepad_count)
node tools/inject-hotkey.js Ctrl+Alt+F6
sleep 4
N1=$(notepad_count)
[ "$N1" -eq "$N0" ] && verdict C pass "关闭态注入 Ctrl+Alt+F6 不触发（$N0 → $N1）" \
  || verdict C app-bug "关闭态注入竟触发了（$N0 → $N1）"
kill_app

echo "===== AI 层专项 E2E 完成，verdict 汇总 ====="
cat "$RJ"
# 门禁：app-bug=功能坏；known-issue=竞态命中（重试自愈失效），都算不过
if grep -qE "app-bug|known-issue" "$RJ"; then exit 1; fi
exit 0

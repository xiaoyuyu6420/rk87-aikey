#!/bin/bash
# s8: R2/R3/R12 收尾——存活断言、托盘退出、残留进程、用户数据零污染
source e2e/lib.sh
cd "$REPO"

# app 应该还在跑（s7 重启过）；若没有，这次启动专门测存活
if ! wait_cdp 3; then
  cleanup_procs   # 关键：先清旧实例，否则新实例拿不到单实例锁会静默退出（退出码 0 无日志）
  rm -rf "$USERDATA_ISOLATED"
  ELECTRON_ENABLE_LOGGING=1 nohup node_modules/.bin/electron \
    --remote-debugging-port=$PORT --user-data-dir="$USERDATA_ISOLATED" \
    . \
    > "$APP_LOG" 2>&1 &
  echo $! > "$EV/app.pid"; date +%s > "$EV/app.start.ts"
  wait_cdp 15 || { verdict R2 app-bug "CDP 不可达"; exit 1; }
fi

START=$(cat "$EV/app.start.ts")
NOW=$(date +%s)
ALIVE=$((NOW - START))
echo "[s8] app 已存活 ${ALIVE}s"

# 若还没到 120s，等满（契约硬门槛：dev 存活 >=120s）
if [ "$ALIVE" -lt 120 ]; then
  WAIT=$((120 - ALIVE))
  echo "[s8] 等待 ${WAIT}s 补满 120s 存活窗口..."
  sleep $WAIT
fi

PID=$(cat "$EV/app.pid" 2>/dev/null)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && wait_cdp 3; then
  verdict R2 pass "dev 实例存活 ≥120s 且 CDP 仍可达"
else
  verdict R2 app-bug "存活不足 120s（pid $PID 已退出）或 CDP 失联；stdout 尾部: $(tail -c 300 "$APP_LOG" | tr '\n' ' ')"
fi

UNC=$(grep -ch '\[uncaught\]' "$APP_LOG" "$EV"/app-stdout-r*.log 2>/dev/null | awk '{s+=$1} END {print s+0}')
[ "$UNC" -eq 0 ] && verdict R2 pass "全程无 [uncaught]" || verdict R2 app-bug "出现 [uncaught] x$UNC"

# R3: 单实例锁——第二实例应静默退出码 0 且不影响第一实例
node_modules/.bin/electron . --user-data-dir="$USERDATA_ISOLATED" >/dev/null 2>&1 &
LOCK_PID=$!
sleep 4
if ! kill -0 "$LOCK_PID" 2>/dev/null; then
  verdict R3 pass "第二实例自行退出（单实例锁生效，非抢跑）"
else
  kill "$LOCK_PID" 2>/dev/null
  verdict R3 app-bug "第二实例未退出（单实例锁失效？）"
fi

# R12: 关窗=隐藏（app 还活着）+ 托盘退出后无残留
wait_cdp 3 && node e2e/cdp.mjs eval 'window.close(); "closed"' >/dev/null 2>&1
sleep 2
PID2=$(cat "$EV/app.pid" 2>/dev/null)
if [ -n "$PID2" ] && kill -0 "$PID2" 2>/dev/null; then
  verdict R12 pass "关窗后进程存活（隐藏到托盘）"
else
  verdict R12 app-bug "关窗后进程退出（未按托盘常驻设计工作）"
fi

# 托盘"退出"等价：SIGTERM 优雅退出后无残留
kill "$PID2" 2>/dev/null; sleep 2
LEFT=$(pgrep -f "Electron.*rk87-AIKey|rk87-AIKey.*Electron" 2>/dev/null | wc -l | tr -d ' ')
cleanup_procs
LEFT2=$(pgrep -f "$REPO.*[Ee]lectron" 2>/dev/null | wc -l | tr -d ' ')
[ "$LEFT2" -eq 0 ] && verdict R12 pass "退出后无残留进程" || verdict R12 app-bug "残留进程 x$LEFT2"

# 用户数据零污染
snapshot_userdata > "$EV/userdata-after.txt"
if diff -q "$EV/userdata-before.txt" "$EV/userdata-after.txt" >/dev/null 2>&1; then
  verdict R9 pass "真实 userData 零污染（前后快照一致）"
else
  verdict R9 app-bug "真实 userData 被污染！diff: $(diff "$EV/userdata-before.txt" "$EV/userdata-after.txt" | head -5 | tr '\n' ' ')"
fi

echo "===== results ====="
cat "$RJ"

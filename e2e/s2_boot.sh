#!/bin/bash
# s2: R2/R3/R4/R5 启动 + 蓝牙会话观察（app 保持运行，供后续阶段用）
source e2e/lib.sh
cd "$REPO"

cleanup_procs
rm -rf "$USERDATA_ISOLATED"
snapshot_userdata > "$EV/userdata-before.txt"

echo "[s2] 启动 app（隔离 userData + CDP $PORT）..."
ELECTRON_ENABLE_LOGGING=1 nohup node_modules/.bin/electron \
  --remote-debugging-port=$PORT \
  --user-data-dir="$USERDATA_ISOLATED" \
  . \
  > "$APP_LOG" 2>&1 &
APP_PID=$!
echo "$APP_PID" > "$EV/app.pid"
date +%s > "$EV/app.start.ts"

# R2: ≤15s 出现页面
if wait_cdp 15; then
  verdict R2 pass "CDP 页面在 15s 内就绪"
else
  verdict R2 app-bug "CDP 15s 未就绪；stdout 尾部: $(tail -c 300 "$APP_LOG" | tr '\n' ' ')"
  exit 1
fi
ev s2-pages curl -s http://127.0.0.1:$PORT/json

# 立即截图（R2 证据）
node e2e/cdp.mjs shot "$EV/s2-boot.png" && verdict R2 pass "启动截图 $EV/s2-boot.png"

# R5: 等蓝牙会话握手（观察 stdout [session] 行，最多 40s）
echo "[s2] 观察蓝牙会话握手（最多 40s）..."
SESS=""
for i in $(seq 1 40); do
  if grep -q '\[session\] 在线' "$APP_LOG"; then SESS="online"; break; fi
  if grep -qE '\[session\] 离线' "$APP_LOG" && [ $i -gt 20 ]; then SESS="offline"; break; fi
  sleep 1
done
case "$SESS" in
  online)  verdict R5 pass "蓝牙会话在线: $(grep '\[session\]' "$APP_LOG" | tail -1)" ;;
  offline) verdict R5 app-bug "会话离线: $(grep '\[session\]' "$APP_LOG" | tail -2 | tr '\n' ' ')" ;;
  *)       verdict R5 inconclusive "40s 内无 [session] 日志行；hid 枚举: $(grep -c '\[hid\]' "$APP_LOG") 行" ;;
esac

# R4: 无硬件降级 = 无 [uncaught]、日志不刷屏
UNC=$(grep -c '\[uncaught\]' "$APP_LOG" || true)
LOGLINES=$(wc -l < "$APP_LOG" | tr -d ' ')
[ "$UNC" -eq 0 ] && verdict R4 pass "无未捕获异常（日志 $LOGLINES 行）" || verdict R4 app-bug "出现 [uncaught] x$UNC: $(grep '\[uncaught\]' "$APP_LOG" | head -2 | tr '\n' ' ')"

echo "[s2] app 继续Running (pid $APP_PID)，存活断言在 s8"

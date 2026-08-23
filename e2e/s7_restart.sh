#!/bin/bash
# s7: R8 配置持久化（setBinding → 重启 → getState 一致）+ userData 实测路径
source e2e/lib.sh
cd "$REPO"

# s3 阶段在跑着的 app 里设置绑定（如果 app 已被 s5 停掉则重启 dev 实例）
if ! wait_cdp 3; then
  rm -rf "$USERDATA_ISOLATED"
  ELECTRON_ENABLE_LOGGING=1 nohup node_modules/.bin/electron \
    --remote-debugging-port=$PORT --user-data-dir="$USERDATA_ISOLATED" \
    . \
    > "$EV/app-stdout-r2.log" 2>&1 &
  echo $! > "$EV/app.pid"; date +%s > "$EV/app.start.ts"
  wait_cdp 15 || { verdict R8 app-bug "重启失败：CDP 不可达"; exit 1; }
fi

node e2e/cdp.mjs eval 'window.aikey.setBinding("f1", {type:"url", target:"https://example.com/e2e"}).then(r => JSON.stringify(r))' | tee "$EV/s7-setbinding.json"
node e2e/cdp.mjs eval 'window.aikey.setBinding("__label__:f1", {label:"E2E测试键"}).then(r => JSON.stringify(r))' >/dev/null
sleep 1

# 隔离 userData 里 config.json 应已落盘
CFG="$USERDATA_ISOLATED/config.json"
if [ -f "$CFG" ]; then
  verdict R8 pass "config.json 落盘于隔离 userData: $(grep -o '"f1"[^}]*}' "$CFG" | head -c 120)"
else
  verdict R8 app-bug "config.json 未落盘（$CFG 不存在）"
fi

# 重启验证持久化
cleanup_procs
sleep 1
ELECTRON_ENABLE_LOGGING=1 nohup node_modules/.bin/electron \
  --remote-debugging-port=$PORT --user-data-dir="$USERDATA_ISOLATED" \
  . \
  > "$EV/app-stdout-r3.log" 2>&1 &
echo $! > "$EV/app.pid"; date +%s > "$EV/app.start.ts"
wait_cdp 15 || { verdict R8 app-bug "重启后 CDP 不可达"; exit 1; }

node e2e/cdp.mjs eval 'window.aikey.getState().then(s => JSON.stringify({f1: s.bindings.f1, f1label: (s.keys.find(k=>k.id==="f1")||{}).label}))' | tee "$EV/s7-after-restart.json"
if grep -q 'e2e' "$EV/s7-after-restart.json" && grep -q 'E2E测试键' "$EV/s7-after-restart.json"; then
  verdict R8 pass "重启后绑定+备注持久化一致"
else
  verdict R8 app-bug "重启后绑定丢失: $(cat "$EV/s7-after-restart.json")"
fi

# userData 真实路径记录（productName vs README 口径差）
node e2e/cdp.mjs eval 'window.aikey.getState().then(s=>1).then(()=>process)' >/dev/null 2>&1
ls "$HOME/Library/Application Support/" 2>/dev/null | grep -i "rk87" | tee "$EV/s7-real-userdata.txt"
if [ -d "$HOME/Library/Application Support/RK87 AIKey" ]; then
  echo "NOTE: 实际目录为 'RK87 AIKey'（productName），README 写的 rk87-aikey 不准确" >> "$EV/s7-real-userdata.txt"
fi

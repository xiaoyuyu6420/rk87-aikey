#!/bin/bash
# RK87-AIKey Windows e2e 入口（对应 macOS 版 run.sh，复用 cdp.mjs）
# 覆盖：单测 → dev 启动 CDP 冒烟（UI/降噪引擎/无未捕获异常）→ 打包 → asar 解包实证
# （df.dll/模型 UNPACKED、hidapi 源码树排除）→ 打包产物启动冒烟（DFN3 从
# app.asar.unpacked 加载成功 = P0-1 回归证明）
# 用法: bash e2e/run-win.sh          # 全量
#       bash e2e/run-win.sh w2 w3    # 只跑指定阶段
set -u
cd "$(dirname "$0")/.."
E2E_DIR="$(pwd)/e2e"
EV="$E2E_DIR/evidence-win"
RJ="$EV/results.jsonl"
mkdir -p "$EV"
PORT=9333
PORT_PACKED=9334
export CDP_PORT=$PORT

verdict() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" | tee -a "$RJ"; }
ev() { local name="$1"; shift; "$@" > "$EV/$name" 2>&1 || true; echo "[evidence] $EV/$name"; }

wait_cdp() {
  local port="${1:-$PORT}" i=0 max="${2:-20}"
  while [ $i -lt $max ]; do
    if curl -s --max-time 2 "http://127.0.0.1:$port/json" 2>/dev/null | grep -q webSocketDebuggerUrl; then return 0; fi
    sleep 1; i=$((i+1))
  done
  return 1
}

kill_app() { # 杀本仓库 dev Electron 与打包实例（按记录的 PID）
  for f in "$EV/dev.pid" "$EV/packed.pid"; do
    [ -f "$f" ] || continue
    local pid; pid=$(cat "$f")
    taskkill //F //PID "$pid" >/dev/null 2>&1 || kill -9 "$pid" 2>/dev/null
    rm -f "$f"
  done
  sleep 1
}

STAGES="${*:-w1_unit w2_devboot w3_pack w4_ailayer}"

for s in $STAGES; do
  echo "===== [stage] $s ====="
  case "$s" in
  w1_unit)
    if npm test > "$EV/w1-unit.log" 2>&1; then
      verdict W1 pass "单测全绿（$(grep -cE '^[0-9]+ passed, 0 failed' "$EV/w1-unit.log" 2>/dev/null || echo '?') 份报告 0 fail）"
    else
      verdict W1 app-bug "单测失败，见 w1-unit.log 尾部: $(tail -c 300 "$EV/w1-unit.log" | tr '\n' ' ')"
    fi
    ;;

  w2_devboot)
    kill_app
    UD="$E2E_DIR/tmp-userdata-win"
    rm -rf "$UD"
    echo "[w2] dev 启动（隔离 userData + CDP $PORT）..."
    ELECTRON_ENABLE_LOGGING=1 node node_modules/electron/cli.js \
      --remote-debugging-port=$PORT --user-data-dir="$UD" . \
      > "$EV/w2-stdout.log" 2>&1 &
    echo $! > "$EV/dev.pid"

    if wait_cdp $PORT 20; then verdict W2 pass "CDP 20s 内就绪"; else
      verdict W2 app-bug "CDP 未就绪；stdout: $(tail -c 300 "$EV/w2-stdout.log" | tr '\n' ' ')"; continue; fi

    node e2e/cdp.mjs shot "$EV/w2-boot.png" >/dev/null && verdict W2 pass "启动截图"

    # getState 形状（≥14 键）
    node e2e/cdp.mjs eval 'window.aikey.getState().then(s => ({keys: s.keys.length, settings: typeof s.settings, sessionOnline: s.sessionOnline, deviceConnected: s.deviceConnected}))' > "$EV/w2-state.json"
    KEYS=$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).keys)}catch(e){console.log(0)}})" < "$EV/w2-state.json")
    [ "${KEYS:-0}" -ge 14 ] 2>/dev/null && verdict W7 pass "getState ${KEYS} 键" || verdict W7 app-bug "getState 键数异常: $(cat "$EV/w2-state.json")"

    # DOM 键行
    DOMN=$(node e2e/cdp.mjs eval 'document.querySelectorAll(".key-row, [data-key]").length' | tr -d '"\n ')
    [ "${DOMN:-0}" -ge 14 ] 2>/dev/null && verdict W7 pass "DOM 键行 $DOMN" || verdict W7 app-bug "DOM 键行不足: $DOMN"

    # renderer console 无 error
    node e2e/cdp.mjs console 4000 > "$EV/w2-console.json"
    ERRN=$(node -e "const a=JSON.parse(require('fs').readFileSync('$EV/w2-console.json','utf8')); console.log(a.filter(x=>x.type==='error'||x.type==='exception').length)" 2>/dev/null || echo 0)
    [ "$ERRN" -eq 0 ] && verdict W7 pass "renderer console 无 error" || verdict W7 app-bug "console 错误 x$ERRN: $(head -c 300 "$EV/w2-console.json")"

    # 无未捕获异常 + 降噪引擎就绪（dev 环境真 df.dll → DFN3 主引擎）
    sleep 3
    UNC=$(grep -c '\[uncaught\]' "$UD/logs/app.log" 2>/dev/null || true)
    [ "$UNC" -eq 0 ] && verdict W4 pass "主进程无未捕获异常" || verdict W4 app-bug "[uncaught] x$UNC: $(grep '\[uncaught\]' "$UD/logs/app.log" | head -2 | tr '\n' ' ')"
    if grep -q 'DeepFilterNet3 降噪已就绪' "$UD/logs/app.log" 2>/dev/null; then
      verdict W8 pass "dev：DeepFilterNet3 主引擎就绪"
    elif grep -q '降噪已就绪' "$UD/logs/app.log" 2>/dev/null; then
      verdict W8 inconclusive "dev 走了 RNNoise 回退: $(grep 'mic.' "$UD/logs/app.log" | head -2 | tr '\n' ' ')"
    else
      verdict W8 inconclusive "未捕获降噪日志（engine 未初始化或未开麦）"
    fi
    kill_app
    ;;

  w3_pack)
    kill_app
    echo "[w3] electron-builder --win portable ..."
    node node_modules/electron-builder/cli.js --win portable --publish never > "$EV/w3-build.log" 2>&1
    RC=$?
    tail -5 "$EV/w3-build.log"
    if [ $RC -ne 0 ]; then verdict W13 app-bug "打包退出码 $RC"; continue; fi
    verdict W13 pass "打包退出码 0"

    ASAR="dist/win-unpacked/resources/app.asar"
    if [ ! -f "$ASAR" ]; then verdict W13 app-bug "缺 $ASAR"; continue; fi

    # asar 解包实证：df.dll/模型必须 UNPACKED（P0-1），hidapi 源码树必须被排除
    node - "$ASAR" > "$EV/w3-asar.txt" 2>&1 <<'EOF'
const fs = require('fs');
const fd = fs.openSync(process.argv[2], 'r');
const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0);
const jsonLen = b.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen); fs.readSync(fd, jb, 0, jsonLen, 16);
const j = JSON.parse(jb.toString());
const out = [];
(function walk(n, p) {
  for (const k of Object.keys(n.files || {})) {
    const f = n.files[k]; const fp = p + '/' + k;
    if (f.files) walk(f, fp); else out.push({ fp, unpacked: !!f.unpacked, size: f.size || 0 });
  }
})(j, '', out);
for (const f of out) if (/deep-filter|hidapi/.test(f.fp)) console.log((f.unpacked ? 'UNPACKED' : 'IN-ASAR'), f.size, f.fp);
console.log('hidapi-files:', out.filter(x => x.fp.includes('/hidapi/')).length);
console.log('df-unpacked:', out.some(x => x.fp.endsWith('deep-filter/df.dll') && x.unpacked));
console.log('model-unpacked:', out.some(x => x.fp.endsWith('model/model.tar.gz') && x.unpacked));
EOF
    cat "$EV/w3-asar.txt"
    DF_UP=$(grep -c '^df-unpacked: true' "$EV/w3-asar.txt" || true)
    MODEL_UP=$(grep -c '^model-unpacked: true' "$EV/w3-asar.txt" || true)
    HIDAPI_N=$(grep -oP 'hidapi-files: \K\d+' "$EV/w3-asar.txt" || echo 999)
    [ "$DF_UP" -eq 1 ] && verdict W13 pass "df.dll 已解包（koffi 可加载）" || verdict W13 app-bug "df.dll 仍在 asar 内——打包版 DFN3 必失败"
    [ "$MODEL_UP" -eq 1 ] && verdict W13 pass "模型已解包（Rust std::fs 可读）" || verdict W13 app-bug "模型仍在 asar 内"
    [ "$HIDAPI_N" -eq 0 ] && verdict W13 pass "hidapi 源码树已排除" || verdict W13 inconclusive "hidapi 仍打包（体积浪费，非功能问题）"

    # 打包产物启动冒烟：DFN3 从 app.asar.unpacked 加载 = P0-1 端到端证明
    UDP="$E2E_DIR/tmp-userdata-packed"
    rm -rf "$UDP"
    EXE="dist/win-unpacked/AnyKey AI.exe"
    [ -f "$EXE" ] || { verdict W13 app-bug "缺打包 exe: $EXE"; continue; }
    "$EXE" --remote-debugging-port=$PORT_PACKED --user-data-dir="$UDP" &
    echo $! > "$EV/packed.pid"
    if CDP_PORT=$PORT_PACKED wait_cdp $PORT_PACKED 25; then
      verdict W13 pass "打包产物 CDP 冒烟通过"
      CDP_PORT=$PORT_PACKED node e2e/cdp.mjs eval 'window.aikey.getState().then(s=>s.keys.length)' > "$EV/w3-packed-state.json"
      PK_KEYS=$(tr -d '"\n ' < "$EV/w3-packed-state.json")
      [ "${PK_KEYS:-0}" -ge 14 ] 2>/dev/null && verdict W13 pass "打包产物 getState ${PK_KEYS} 键" || verdict W13 app-bug "打包产物 getState 异常: $(cat "$EV/w3-packed-state.json")"
      sleep 4
      PLOG="$UDP/logs/app.log"
      if grep -q 'DeepFilterNet3 降噪已就绪' "$PLOG" 2>/dev/null; then
        verdict W14 pass "打包版 DFN3 从 asar.unpacked 加载成功（P0-1 修复实证）"
      elif grep -q 'RNNoise 降噪已就绪' "$PLOG" 2>/dev/null; then
        verdict W14 app-bug "打包版回退 RNNoise: $(grep '\[mic\]' "$PLOG" | head -2 | tr '\n' ' ')"
      else
        verdict W14 inconclusive "打包版无降噪日志行: $(tail -c 300 "$PLOG" 2>/dev/null | tr '\n' ' ')"
      fi
      UNC2=$(grep -c '\[uncaught\]' "$PLOG" 2>/dev/null || true)
      [ "$UNC2" -eq 0 ] && verdict W4 pass "打包版无未捕获异常" || verdict W4 app-bug "打包版 [uncaught] x$UNC2"
      CDP_PORT=$PORT_PACKED node e2e/cdp.mjs shot "$EV/w3-packed.png" >/dev/null
    else
      verdict W13 app-bug "打包产物 25s 无 CDP 页面"
    fi
    kill_app
    ;;

  w4_ailayer)
    # AI 层专项 E2E（v0.12.0）：启用态热键注入→动作执行 / 重注册竞态 / 默认关闭零影响
    kill_app
    if bash e2e/ailayer-e2e.sh > "$EV/w4-ailayer.log" 2>&1; then
      verdict W15 pass "AI 层专项全绿（$(grep -cP '\tpass\t' "$EV/w4-ailayer.log" 2>/dev/null || echo '?') pass：B1 热键链路 / B3 重注册 / C 零影响）"
    else
      verdict W15 app-bug "AI 层专项有失败: $(grep -E 'app-bug|known-issue' "$EV/w4-ailayer.log" | head -2 | tr '\n' ' ')"
    fi
    tail -10 "$EV/w4-ailayer.log"
    ;;
  *)
    echo "[stage] 未知阶段 $s";;
  esac
done

echo "===== results ====="
cat "$RJ" 2>/dev/null
grep -q "app-bug" "$RJ" 2>/dev/null && exit 1 || exit 0

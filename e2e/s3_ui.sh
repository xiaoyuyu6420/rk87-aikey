#!/bin/bash
# s3: R7 UI 状态 + renderer console；R12 部分（页面即窗口）
source e2e/lib.sh
cd "$REPO"

wait_cdp 5 || { verdict R7 inconclusive "CDP 不可达"; exit 1; }

# R7: getState 形状
node e2e/cdp.mjs eval 'window.aikey.getState().then(s => ({keys: s.keys.length, bindingCount: Object.keys(s.bindings||{}).length, settings: typeof s.settings, deviceConnected: s.deviceConnected, sessionOnline: s.sessionOnline, firstKey: s.keys[0]}))' \
  | tee "$EV/s3-getstate.json"
GOT=$(cat "$EV/s3-getstate.json")
KEYN=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d["keys"])' < "$EV/s3-getstate.json" 2>/dev/null || echo 0)
[ "${KEYN:-0}" -ge 14 ] 2>/dev/null && verdict R7 pass "getState 返回 ${KEYN} 键（README 表 14 + 4 扩展键位）" || verdict R7 app-bug "getState 键数异常: $GOT"

# R7: DOM 14 键行
node e2e/cdp.mjs eval 'document.querySelectorAll(".key-row, [data-key]").length' | tee "$EV/s3-dom.json"
DOMN=$(tr -d '"\n' < "$EV/s3-dom.json")
[ "${DOMN:-0}" -ge 14 ] 2>/dev/null && verdict R7 pass "DOM 键行 $DOMN" || verdict R7 app-bug "DOM 键行不足: $DOMN（选择器可能需调整，看截图）"

# R7: renderer console 错误（采集 4s）
node e2e/cdp.mjs console 4000 | tee "$EV/s3-console.json"
ERRN=$(grep -o '"type":"[a-z]*"' "$EV/s3-console.json" | grep -cE 'error|exception' || true)
[ "$ERRN" -eq 0 ] && verdict R7 pass "renderer console 无 error" || verdict R7 app-bug "console 错误 x$ERRN: $(head -c 400 "$EV/s3-console.json")"

node e2e/cdp.mjs shot "$EV/s3-ui.png" >/dev/null

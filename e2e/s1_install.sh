#!/bin/bash
# s1: R1 依赖安装验证 + node_modules 原生库架构记录（H1 证据的一半）
source e2e/lib.sh
cd "$REPO"

if [ ! -d node_modules/electron/dist ]; then
  echo "[s1] node_modules 不完整，先安装（代理兜底）"
  pnpm install 2>&1 | tail -3 || {
    export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
    pnpm install 2>&1 | tail -3
  }
fi

# R1: electron 就位
if [ -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]; then
  verdict R1 pass "electron 33 二进制就位"
else
  verdict R1 app-bug "electron 二进制缺失"
  exit 1
fi

# R1: koffi / node-hid darwin-arm64 原生库（-L 跟随 pnpm 符号链接）
ev s1-koffi-file find -L node_modules -path "*koffi*" -name "*.node" -exec file {} \;
ev s1-nodehid-file find -L node_modules/node-hid -name "*.node" -exec file {} \;

KOFFI_ARM=$(grep -l "arm64" "$EV/s1-koffi-file" 2>/dev/null | wc -l | tr -d ' ')
HID_ARM=$(grep -c "arm64" "$EV/s1-nodehid-file" 2>/dev/null || echo 0)
grep -qi "arm64" "$EV/s1-koffi-file" && verdict R1 pass "koffi darwin 原生库存在(arm64)" || verdict R1 app-bug "koffi 缺 darwin-arm64 库"
[ "$HID_ARM" -gt 0 ] 2>/dev/null && verdict R1 pass "node-hid 原生库存在(arm64)" || verdict R1 app-bug "node-hid 缺 darwin-arm64 库"

# H1 预证：node_modules 里是否存在 x64 原生库（打 x64 包时 npmRebuild:false 不会重编）
X64_COUNT=$(cat "$EV/s1-koffi-file" "$EV/s1-nodehid-file" 2>/dev/null | grep -c "x86_64" || true)
echo "[s1] node_modules 中 x86_64 原生库数量: $X64_COUNT （0 = x64 打包必然内嵌 arm64 库）"

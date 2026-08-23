#!/bin/bash
# s5: R13 打包 dist:mac + zip 内 lipo 架构定罪（H1 核心证据）+ arm64 产物冒烟
source e2e/lib.sh
cd "$REPO"

# 先停掉 dev 实例避免文件竞争
cleanup_procs 2>/dev/null || true

echo "[s5] electron-builder --mac zip（双架构一次出，等价 CI 命令）..."
pnpm exec electron-builder --mac zip --x64 --arm64 --publish never > "$EV/s5-build.log" 2>&1
RC=$?
tail -15 "$EV/s5-build.log"
if [ $RC -ne 0 ]; then
  verdict R13 app-bug "dist:mac 退出码 $RC（详见 s5-build.log 尾部）"
  exit 1
fi
verdict R13 pass "dist:mac 退出码 0"

ls -la dist/*.zip dist/*.dmg 2>/dev/null | tee "$EV/s5-artifacts.txt"
ZIPS=$(ls dist/*.zip 2>/dev/null | wc -l | tr -d ' ')
[ "$ZIPS" -ge 2 ] && verdict R13 pass "产物 zip x$ZIPS" || verdict R13 app-bug "zip 产物不足（$ZIPS 个）"

# 解包并逐个 .node 做架构检查
ARCH_DIR="$EV/unpacked"; rm -rf "$ARCH_DIR"; mkdir -p "$ARCH_DIR"
for z in dist/*.zip; do
  [ -f "$z" ] || continue
  tag=$(basename "$z" | sed -E 's/.*-(arm64|x64)([^-]*)-mac\.zip/\1\2/; s/.*-(arm64|x64).*\.zip/\1/')
  mkdir -p "$ARCH_DIR/$tag"
  unzip -qo "$z" -d "$ARCH_DIR/$tag"
done

: > "$EV/s5-lipo.txt"
for d in "$ARCH_DIR"/*/; do
  tag=$(basename "$d")
  app_dir=$(find "$d" -name "*.app" -maxdepth 3 | head -1)
  [ -z "$app_dir" ] && continue
  echo "=== [$tag] $(basename "$app_dir") ===" >> "$EV/s5-lipo.txt"
  echo "Electron binary: $(file -b "$app_dir/Contents/MacOS/"* 2>/dev/null | head -1)" >> "$EV/s5-lipo.txt"
  find "$app_dir/Contents/Resources" -name "*.node" 2>/dev/null | while read -r n; do
    echo "$(echo "$n" | sed "s|$d||") -> $(file -b "$n" | sed 's/,.*//')" >> "$EV/s5-lipo.txt"
  done
done
cat "$EV/s5-lipo.txt"

# 定罪：x64 包里的 .node 若非 x86_64 → Intel Mac 必崩（H1）
X64_DIR=$(ls -d "$ARCH_DIR"/*x64* 2>/dev/null | head -1)
if [ -n "$X64_DIR" ]; then
  SECTION=$(sed -n "/=== \[x64/,/^=== \[arm/p" "$EV/s5-lipo.txt" | grep '\.node')
  TOTAL=$(echo "$SECTION" | grep -c '\.node' || true)
  BAD=$(echo "$SECTION" | grep -vc 'x86_64' || true)
  if [ "$TOTAL" -gt 0 ] && [ "$BAD" -gt 0 ]; then
    verdict R13 app-bug "H1定罪: x64 包内 $BAD/$TOTAL 个 .node 非 x86_64（arm64 库混入，Intel Mac require 即崩）: $(echo "$SECTION" | grep -v 'x86_64' | head -3 | tr '\n' ' ')"
  else
    verdict R13 pass "x64 包原生库全部 x86_64"
  fi
fi

# arm64 zip 冒烟
ARM_DIR=$(ls -d "$ARCH_DIR"/*arm64* 2>/dev/null | head -1)
ARM_APP=$(find "$ARM_DIR" -name "*.app" -maxdepth 3 | head -1 2>/dev/null)
if [ -n "$ARM_APP" ]; then
  rm -rf "$USERDATA_ISOLATED"
  ELECTRON_ENABLE_LOGGING=1 nohup "$ARM_APP/Contents/MacOS/"* \
    --remote-debugging-port=$PORT --user-data-dir="$USERDATA_ISOLATED" \
    > "$EV/s5-packaged.log" 2>&1 &
  echo $! > "$EV/app.pid"; date +%s > "$EV/app.start.ts"
  if wait_cdp 15; then
    verdict R13 pass "arm64 打包产物 CDP 冒烟通过"
    node e2e/cdp.mjs eval 'window.aikey.getState().then(s=>s.keys.length)' > "$EV/s5-packaged-state.json" 2>&1
    KEYN=$(tr -d '"\n ' < "$EV/s5-packaged-state.json")
    [ "${KEYN:-0}" -ge 14 ] 2>/dev/null && verdict R13 pass "打包产物 getState ${KEYN} 键（14 主键 + 扩展键位）" || verdict R13 app-bug "打包产物 getState 异常: $(cat "$EV/s5-packaged-state.json")"
    node e2e/cdp.mjs shot "$EV/s5-packaged.png" >/dev/null
    echo "packaged-session: $(grep '\[session\]' "$EV/s5-packaged.log" | tail -1)" | tee "$EV/s5-packaged-session.txt"
  else
    verdict R13 app-bug "arm64 打包产物 15s 无 CDP 页面；stdout: $(tail -c 400 "$EV/s5-packaged.log" | tr '\n' ' ')"
  fi
  cleanup_procs
fi

# 磁盘回收：清掉解包目录（证据 s5-lipo.txt 已留存）
rm -rf "$ARCH_DIR"

#!/bin/bash
# e2e 公共库：证据落盘 + verdict 记账
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$E2E_DIR")"
EV="$E2E_DIR/evidence"
RJ="$EV/results.jsonl"
USERDATA_ISOLATED="$E2E_DIR/tmp-userdata"
APP_LOG="$EV/app-stdout.log"
PORT=9333   # 9222 常被开着 remote-debugging 的 Chrome 占用
export CDP_PORT=$PORT

mkdir -p "$EV"

verdict() { # verdict <Rxx> <pass|app-bug|env-missing|hardware-absent|inconclusive> <note>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" | tee -a "$RJ"
}

ev() { # ev <name> —— 把命令输出存证据文件
  local name="$1"; shift
  "$@" > "$EV/$name" 2>&1 || true
  echo "[evidence] $EV/$name ($(wc -c < "$EV/$name" | tr -d ' ') bytes)"
}

cleanup_procs() { # 杀本仓库 Electron + 打包产物实例（[R]K87 防自匹配）
  pkill -f "$REPO.*Electron" 2>/dev/null
  pkill -f "[Ee]lectron.*$REPO" 2>/dev/null
  pkill -f "[R]K87 AIKey.app/Contents/MacOS" 2>/dev/null
  sleep 1
}

wait_cdp() { # wait_cdp <max_sec>
  local i=0 max="${1:-15}"
  while [ $i -lt $max ]; do
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/json" 2>/dev/null | grep -q webSocketDebuggerUrl; then
      return 0
    fi
    sleep 1; i=$((i+1))
  done
  return 1
}

snapshot_userdata() { # 真实 userData 前后快照（检测污染）
  for d in "$HOME/Library/Application Support/RK87 AIKey" "$HOME/Library/Application Support/rk87-aikey"; do
    if [ -d "$d" ]; then
      (cd "$d" && find . -type f -exec shasum {} \; 2>/dev/null) | sort -k2
    fi
  done
}

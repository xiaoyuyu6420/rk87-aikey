#!/bin/bash
# RK87-AIKey macOS e2e 入口：顺序跑全部阶段，证据落 e2e/evidence/
# 用法: bash e2e/run.sh          # 全量
#       bash e2e/run.sh s2 s3    # 只跑指定阶段
set -u
cd "$(dirname "$0")/.."
mkdir -p e2e/evidence
source e2e/lib.sh

STAGES="${*:-s1_install s2_boot s3_ui s4_input s5_pack s6_mic s7_restart s8_finish}"
FAILED=0
for s in $STAGES; do
  echo "===== [stage] $s ====="
  if bash "e2e/$s.sh"; then :; else
    echo "[stage] $s FAILED"
    FAILED=1
  fi
done
exit $FAILED

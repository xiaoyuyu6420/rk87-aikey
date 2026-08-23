```yaml
task: mac-e2e-audit
level: T2
type: research          # 产出 = 有证据的 mac 问题报告；research 无红蓝，审计 = 事实核查
stage: done
next: 已完成，待用户确认后归档（crucible/ -> crucible-archive/）
plan: 检查点①展示：1 discoverer + 1 auditor（≈2 个），e2e 执行编排者直做
spawned:
  discoveror: 1
decisions:
  - 路由 T2/research：目标是"找出问题并报告"，非修复；README 自认 mac 待真机验证
  - goal 模式 + 用户明说"全自动"：检查点①以展示代替阻塞等待
  - 本机蓝牙 R87Pro Ai 全程 Not Connected：R5/R14a 改判 hardware-absent + 人工补测清单
  - 磁盘满中断一次（ENOSPC）；用户释放后恢复，node_modules 重装
  - H1（x64 包内嵌 arm64 库）被证伪：koffi/node-hid/vendor 均全平台 prebuilds + Rosetta 实测
  - R13 构建命令改用 --x64 --arm64（pnpm dist:mac 单架构本身成为 P2 发现）
  - AppleScript 对照实验误点 WorkBuddy 窗口（未造成伤害）；TCC 后续拒绝，UI 路径列人工补测
updated: 2026-08-23T00:00+08:00
```

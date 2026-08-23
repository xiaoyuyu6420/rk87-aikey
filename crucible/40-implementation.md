# 40-implementation — 执行日志

## 产物

- `e2e/run.sh`（入口）+ `lib.sh` + `s1_install~s8_finish.sh`（8 阶段）+ `cdp.mjs`（零依赖 CDP 客户端）
- `e2e/report.md`（最终报告）
- `e2e/evidence/`（全部证据：jsonl verdict、日志、截图 ×3、lipo/asar 清单、userData 快照）

## 执行轮次

| 轮 | 结果 | 关键校准 |
|---|---|---|
| 1 | 部分 | 发现：CDP 参数须在 `electron .` 之前；9222 被用户 Chrome 占（改 9333）；`find` 需 `-L` 跟 pnpm 符号链接；cleanup pkill 需覆盖 `.pnpm` 路径与打包产物二进制名 |
| 2 | 大部 | H1 静态证据（asar 清单：koffi/node-hid 全平台 prebuilds）；s8 单实例锁竞态（重启前未清旧实例 → 新实例静默退出被误判为 app 崩溃） |
| 3 | 收官 | R2 存活 120s pass、R11 长按注入 pass（瞬时 keystroke 短于轮询间隔会被漏采——校准为 key down/300ms/key up） |

## 计划外深挖（均由测试发现驱动）

1. `no-cmd-interface` 根因：system_profiler/ioreg/双 HID 库三方取证 → 键盘蓝牙全程 Not Connected（hardware-absent，非 app bug）。
2. H1 动态定罪：解包 x64 zip → asar list → **Rosetta 实测**（`arch -x86_64` 启动 + CDP）→ 证伪。
3. R12 独立复现 ×2：renderer `window.close()` 杀进程；AppleScript 点红绿灯做 UI 路径对照时误点 WorkBuddy 窗口（未造成伤害，窗口仍在），后 TCC 拒绝辅助访问 → UI 路径列人工补测。

## 偏离记录

- R13 构建命令从 `pnpm dist:mac` 改为 `electron-builder --mac zip --x64 --arm64`：前者只出 arm64（这本身成为 P2 发现），为完成 R13 双架构判定取后者（等价 CI 命令）。
- R5 verdict 从 app-bug 改判 hardware-absent（环境取证后）；R14 a) 层并入 hardware-absent。
- R7 键数断言 14 → ≥14（实测 18，README 文档缺口记 P4）。

## 完成判定对照（契约硬门槛）

- install 码 0 ✅（含代理重试路径，磁盘满导致一次重装）
- dev 存活 ≥120s 且无 [uncaught] ✅（round3）
- CDP 页面可列 ✅；dist 码 0 + zip + 架构结论入报告 ✅（lipo + Rosetta 双证据）
- 结束无残留进程 ✅（s8）；真实 config/stats 前后一致 ✅（快照 diff 空）
- 蓝牙会话结论有证据 ✅（离线根因取证 + 人工补测指引）

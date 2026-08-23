# RK87-AIKey macOS e2e 测试报告

- **日期**：2026-08-22 23:40
- **对象**：xiaoyuyu6420/rk87-aikey @ 0dafe16（v0.6.0）
- **环境**：macOS 26.5.1 (Tahoe) arm64 · 蓝牙有 R87Pro Ai 配对记录但**全程未连接**（Not Connected，见 R5）· 无 2.4G 接收器 · BlackHole 未安装
- **方法**：零依赖 CDP 驱动（Node 22 内置 WebSocket，`e2e/cdp.mjs`）+ 8 阶段流水线（`bash e2e/run.sh`），隔离 userData（`--user-data-dir`），真实 userData 前后快照比对（零污染已验证）
- **复跑**：`bash e2e/run.sh`（全量）或 `bash e2e/run.sh s2_boot s3_ui`（指定阶段）

## 结论（TL;DR）

**mac 版整体健康度好于预期**：安装、启动、UI、配置持久化、打字统计、单实例锁、双架构打包全部通过；此前最大嫌疑「x64 包内嵌 arm64 原生库」**被证伪**（Rosetta 实测 x64 包可正常启动）。发现 **1 个中危 bug + 3 个低危问题**，另有 5 项因硬件未连接/系统权限无法自动验证，已列人工补测清单（均 ≤2 分钟/项）。

## 问题清单（按严重度）

### 🔴 P1【中】renderer 调 `window.close()` 会退出整个托盘应用- **现象**：CDP 注入 `window.close()` 后主进程静默退出（无日志、无 crash、退出码 0），CDP 失联。独立复现 2 次（`e2e/evidence/run-round3.log` s8 段 + 手动复现）。
- **违背设计**：`src/main/index.js:189-195` 的 close handler `preventDefault + hide()`（关窗=隐藏到托盘）在该路径未生效；且 `index.js` 没有 `window-all-closed` 兜底 handler。
- **影响面**：app 自身 renderer 代码不调用 window.close（唯一 close() 是 AudioContext 的，`src/renderer/app.js:388`），所以日常使用大概率无感；但任何进入 DevTools/页面脚本执行 close 的场景会杀掉托盘。
- **未能自动验证**：真实用户路径（红绿灯关闭按钮 / Cmd+W）因 TCC 辅助功能权限限制无法自动化——**需要人工点一次确认**（见补测清单）。
- **修复建议**：① `app.on('window-all-closed', () => {})` 加空 handler 兜底；② 人工确认红绿灯路径行为后决定是否深挖。

### 🟡 P2【中低】`pnpm dist:mac` 只产出 arm64 单架构，README 声称的双架构名不副实

- **现象**：`package.json` script 为 `electron-builder --mac zip`——CLI 显式指定 target 时默认只构建**当前架构**，`build.mac.target` 里配置的 `[{zip,[arm64,x64]}]` 被 CLI 参数覆盖。本地实测只出 `RK87 AIKey-0.6.0-arm64-mac.zip` 一个 zip（`e2e/evidence/s5-artifacts.txt`）。
- **对照**：CI 用的是 `--mac --x64 --arm64`（`.github/workflows/build.yml`）才出双架构；README「打包 macOS zip（arm64 + x64）」描述的是 CI 行为而非本地脚本行为。
- **影响**：Mac 上本地跑 `pnpm dist:mac` 想发 x64 用户 → 产物缺位。
- **修复建议**：script 改为 `electron-builder --mac zip --x64 --arm64 --publish never`。

### 🟡 P3【低】键盘离线时日志每 2 秒刷一条 `[session] 离线（no-cmd-interface）`，无节流

- **现象**：键盘不在线的整个生命周期内，stdout 每 ~2s 一条（`e2e/evidence/s5-packaged.log`，实测 137 条/5 分钟 ≈ 2.2s/条；挂机 8h ≈ 1.3 万行）。
- **修复建议**：离线重连日志做节流（如 30s 一条或状态变化才打）。

### 🟡 P4【低·文档】README 键位表 14 键 vs 实现支持 18 键

- **证据**：`get-state` 返回 18 键（`e2e/evidence/s3-getstate.json`）；`src/main/keymap.js:20-23` 定义了 4 个扩展键位（ext_1 上网 / ext_2 工作总结 / ext_3 模板 / ext_4 通用短文写作），README「键位表（实测标定）」未收录。
- **修复建议**：README 键位表补 4 行。

### 🔴 P5【中】macOS 菜单栏被托盘图标占满，挤掉右侧菜单栏图标（用户真机使用发现，已修）

- **现象**：用户在 14" 刘海屏 MacBook Pro（2384x1490）上启动 app 后，菜单栏"宽度百分之百"，右侧后台控件（其他 app 的菜单栏图标）被顶掉。
- **根因（主）**：`assets/icon.png` 为 **512x512 且无 alpha 通道**（`sips` 实测 hasAlpha: no），`createTray()` 直接 `createFromPath` 原图——Electron 不会自动把 Tray 图片缩到菜单栏尺寸，一张 512px 实心方块直接占满菜单栏。
- **伴随因素（次）**：app 未设应用菜单，Electron 默认 7 项菜单（Apple/Electron/File/Edit/View/Window/Help）进一步压缩可用空间。
- **修复**（已实施，`src/main/index.js`）：① 新增 `assets/trayTemplate.png`（22x22 黑色键帽+透明底，`tools/gentrayicon.js` 生成）+ `setTemplateImage(true)`，深浅菜单栏自适应；② darwin 应用菜单精简为 appMenu + editMenu（保留输入框 Cmd+C/V）。实测菜单栏恢复正常。
- 备注：原 512 icon.png 继续用于窗口/Dock 图标；Windows 托盘走原 icon 缩放 32px。

### 🔴 P0【致命→已修】macOS 上 app 会话在线时整个键盘打字失灵（用户真机使用发现）

- **现象**：app 运行（蓝牙会话在线）期间，键盘只有 18 个功能键被 app 识别（界面高亮），**字母/数字等全部打不出字**；退出 app 立即恢复。
- **根因**（逐层实验定位）：macOS 上 app 打开蓝牙键盘的厂商命令口（usagePage 0xFF12）后，**键盘的标准输入报文（reportId=2 的 9 字节键盘报文）也被路由到 app 的该句柄**，系统键盘服务收不到任何按键。调试日志实锤：用户打 `a s d` 时，命令口收到 3 帧非零键盘报文（HID 键码 04/16/07），app 不认识就丢弃。与用哪个 HID 库无关（vendor mi-hid 和 npm node-hid 均复现）；Windows 的 HID 为共享读无此问题（官方软件因此没事）。
- **修复**（方案 A：输入回注，等效官方 Windows 版的 SendInput 行为）：
  1. 新增 `src/main/kbd-inject.js`：解析 reportId=2 键盘报文（修饰键掩码 + 6 键位），维护按下边沿，用 CGEvent（复用 koffi）把 keyDown/keyUp + 修饰键 flags 转发回系统；含 HID usage→mac keycode 完整映射（字母/数字/标点/F1-F12/方向键/小键盘）、断线清边沿。
  2. `kb-session.js`：darwin 下命令口收到的标准键盘报文交给回注模块，不进命令状态机。
  3. 前提：辅助功能授权（系统设置>隐私与安全>辅助功能 加 app；未授权时 CGEventPost 静默无效）。
- **验证**：会话在线状态下打字正常（用户确认），语音链路回归待确认。**已知边界**：reportId=6（多媒体/consumer 帧如音量键）暂不回注；有线/2.4G 模式的行为未测（硬件不在场）。
- **影响面评估**：这是 mac 版可用性的致命问题——不修则"开 app = 键盘废"。修复后 mac 首次达到"打字/语音/自定义键共存"的可用状态。

### ✅ 证伪项：x64 发布包原生依赖完整，Intel Mac 可跑（原最大嫌疑）


- **背景**：`build.npmRebuild:false` + arm64 机构建，曾怀疑 x64 包内嵌 arm64 `.node` 导致 Intel Mac require 即崩。
- **实证**：
  1. koffi（声明 ^2.8，实装 2.16.3）为单包全平台布局（`build/koffi/darwin_x64|darwin_arm64|win32_*`），node-hid 3.1 带 `prebuilds/HID-darwin-x64|arm64`，vendor mi-hid/mi-sbc 共 14 个 .node 全平台且 `file` 验证架构正确（`e2e/evidence/s1-koffi-file`、`e2e/evidence/vendor-node-arch.txt`）；
  2. 双架构构建的 x64 zip：Electron 主二进制 `x86_64`（`e2e/evidence/s5-lipo.txt`）；
  3. **动态定罪**：本机 `arch -x86_64`（Rosetta）启动 x64 包 → CDP 页面就绪、主进程 boot 完成（含 node-hid/koffi/vendor 库加载）、`[session]` 会话逻辑正常运转（`e2e/evidence/x64-rosetta-smoke.log`）。
- **结论**：`npmRebuild:false` 在此依赖结构下无害；CI 发布的 x64 产物架构健康。

## 逐项 verdict（R1-R14）

| # | 项 | verdict | 证据 |
|---|---|---|---|
| R1 | 依赖安装 + 原生库 | **pass** | 重装后 ELECTRON_OK；koffi/node-hid arm64 库在（s1-*-file） |
| R2 | 启动 + 存活 ≥120s | **pass** | CDP ≤15s 就绪、存活 120s+ 无 [uncaught]、截图 s2-boot.png |
| R3 | 单实例锁 | **pass** | 第二实例静默退出、first 实例存活（s8） |
| R4 | 无硬件降级 | **pass** | 无未捕获异常、UI 可用；（附 P3 刷屏问题） |
| R5 | 蓝牙会话 | **pass**（补测翻案：初始 hardware-absent，键盘切对蓝牙通道后在线） | blueutil 轮询连接 + `[session] 尝试命令口 蓝牙 → 在线`（`/tmp/voice-relay-result.log`）；备注：Mac 侧有两条 R87 配对记录，键盘活动通道不在 Mac 时敲键唤不醒，需 Fn+E1/E2/E3 切通道 |
| R6 | 物理按键链 | 人工补测 | 契约 A1 裁决：不自动测 |
| R7 | UI 状态 | **pass** | getState 18 键、DOM 18 行、console 无 error |
| R8 | 配置持久化 | **pass** | 隔离目录 config.json 落盘 + 重启后绑定/备注一致（两轮复现）；注：真实 userData 目录从未生成（dev 与打包冒烟均走隔离目录），productName 路径口径待首次真实安装确认 |
| R9 | 用户数据零污染 | **pass** | 真实 userData 前后快照 diff 为空（s8） |
| R10 | 快捷键 CGEvent | **inconclusive** | `testAction({hotkey})` 返回 {ok:true}（koffi+CGEvent 管线执行成功）；送达效果因自动化无法稳定前台 + TCC 未知未验证→人工补测 |
| R11 | 打字统计 | **pass** | OS 级长按注入 today.total 6→7；**用户真实击键同期被正常统计**（s:2/k/space/enter） |
| R12 | 托盘常驻 | **app-bug(P1) + pass** | window.close() 杀进程（P1）；退出后无残留进程 pass |
| R13 | 双架构打包 | **pass + P2** | 构建 0 退出码、zip×2、x64 架构验证 + Rosetta 冒烟通过、arm64 包 CDP 冒烟 + getState 18 键（截图 s5-packaged.png）；本地 `pnpm dist:mac` 单架构问题见 P2 |
| R14 | 麦克风桥接 | **pass（a 层数据流，补测翻案）+ 环境已就绪** | BlackHole 2ch 0.7.1 已装且为默认输入；会话在线后 `micControl` → `{ok:true,online:true}`，8 秒采样 **211200 字节 / 50 块 / 非全零**（键盘音频流 + mi-sbc 解码整链工作）；b 层（WebAudio 播放到 BlackHole）需界面勾选启用桥接，标准 API 风险低，留用户一键验证 |

## 人工补测清单（5 项，每项 ≤2 分钟）

1. **蓝牙在线握手**：敲一下 R87Pro Ai 任意键唤醒蓝牙 → `tail -f` app 日志看 `[session] 在线`（约 10s 内），托盘菜单「麦克风会话」变「在线（蓝牙）」。
2. **物理按键触发**：在线后按 AI 键/F1 → 界面高亮对应行 + 配置的动作执行（键位测试器用法）。
3. **麦克风数据流**：在线后勾「启用桥接」→ micControl 开麦 → 说句话看音量条/PCM 数据（BlackHole 未装只能验到数据流层）。
4. **关窗行为（P1 影响面）**：点窗口红绿灯关闭按钮、按 Cmd+W，各确认进程驻留（活动监视器搜 RK87）。
5. **快捷键送达（R10）**：系统设置>隐私与安全>辅助功能 里加 dev 版 Electron（`node_modules/electron/dist/Electron.app`）→ 界面配一个 hotkey 动作 → 聚焦一个文本框触发，看字符/组合键是否送达。

## 测试基建说明

- 三轮执行：round1（脚本 bug 校准：CDP 参数顺序/端口被用户 Chrome 9222 占用/pnpm 符号链接）、round2（s5-s8 部分竞态）、round3（全绿收官）。全部日志在 `e2e/evidence/run-full.log`、`run-round3.log`、`results.round*.jsonl`。
- 已知环境噪音：本机 Chrome 占用 9222（e2e 改用 9333）；ZCode 会话的 TCC 权限不足以稳定驱动前台焦点。

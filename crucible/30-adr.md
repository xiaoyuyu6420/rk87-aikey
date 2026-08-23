# 30-adr — e2e 方案（编排者直设计，T2 research 不 spawn architect）

## 决策 1：零依赖 CDP 驱动（Node 22 内置 fetch + WebSocket）

e2e/cdp.mjs 用 Node 22 全局 WebSocket + fetch 与 Electron remote debugging (9222) 通信，子命令式：`eval` / `screenshot` / `wait-page`。

- 否决 Playwright：需装重依赖 + Electron 适配层，且 app 无 DOM test id，收益低。
- 否决 AppleScript UI 驱动：脆弱、需额外 TCC 权限，与 H3 冲突。
- 截图一律走 CDP `Page.captureScreenshot`（规避屏幕录制权限）。

## 决策 2：数据隔离与零污染

- 启动加 `--user-data-dir=$E2E/tmp-userdata`（Chromium 级开关，Electron 33 支持）→ R8 持久化断言在隔离目录内验证。
- 真实 userData（`~/Library/Application Support/RK87 AIKey/` 与 `rk87-aikey/` 双候选）测试前后各做一次 `find | shasum` 快照，结束后比对——即使隔离失效也能立刻发现污染。
- userData 真实路径本身是 R8 的一个测试点（productName vs README 声称不一致，实测为准）。

## 决策 3：清场与"永不失败"对策（H2）

- 每阶段前 `pkill -f` 匹配本仓库路径的 Electron 进程；启动后先 `curl 9222/json` 确认页面存在再继续。
- 通过标准三件套：stdout 无 `[uncaught]` 标记 + CDP 页面列表非空 + renderer `window.aikey.getState()` 可达。
- 存活测试用后台任务 + sleep 探测，不阻塞编排。

## 决策 4：OS 级输入注入与 TCC 归因（H3）

- R10 快捷键：renderer 放 input 并 focus（CDP eval）→ app 自己 `testAction({type:'hotkey', combo:'Shift+B'})` → CGEventPost 路由回前台 app 的 input → CDP 读 value。收到字符 = 授权+实现双 pass；未收到 → 尝试归因（TCC 无法程序化读取则标 env-missing 并附人工核验指引，已授权仍无效才 app-bug）。
- R11 统计输入源：CDP `Input.dispatchKeyEvent` 不经 OS 键态（discoverer 确认），不可用；改用 `osascript System Events keystroke` 注入 OS 级击键——若被 TCC 拒绝（自动化权限）则 R11 降级为 supported=true + 无注入路径的 inconclusive/env-missing，诚实记录。
- R14 BlackHole：`system_profiler SPAudioDataType` 探测设备名；不在场 → b) 层 env-missing，a) 层（mic-pcm 数据流）仍测。

## 决策 5：R13 lipo 定罪路径（H1）

1. 本机 `pnpm dist:mac`（package.json 里 mac target 含 zip+dmg 双 arch，虽然 script 名只写 zip，以 package.json build 配置为准，记录口径差）。
2. 解开 arm64 zip 与 x64 zip，对 `.app/Contents/Resources/app.asar.unpacked` 与 vendor prebuilds 里所有 `.node`/`.dylib` 逐个 `file`/`lipo -info`。
3. 判定：x64 zip 含 arm64-only 原生库 → 高危 app-bug（附 CI 同病推断）；另查 `src/main/hid.js` 的 prebuild 平台选择逻辑是否有 darwin-x64 分支（vendor 里若无 darwin-x64 prebuild，x64 包运行时也找不到库）。
4. arm64 zip 做启动冒烟（CDP 同 R2/R7）。

## 决策 6：证据与报告

- 每阶段产 JSONL 证据行（verdict + 命令 + 输出摘录）到 `e2e/evidence/`；截图存 `e2e/evidence/*.png`。
- `e2e/report.md` 由编排者最终汇总（按严重度排序 + 修复建议 + 人工补测清单）。
- e2e/ 与 crucible/ 均不入 git（加 .gitignore 条目，避免污染用户仓库工作区——最后收尾时问用户是否提交）。

## 被否决方案汇总

| 方案 | 否决理由 |
|---|---|
| Playwright/WebdriverIO | 重依赖，无 test id 适配成本高 |
| 真 x64 机器动态跑 | A4 裁决：静态 lipo 足以定罪 |
| 擅自 brew install blackhole-2ch | A5 裁决：超诊断授权 |
| 测试期间连 2.4G 接收器 | 硬件不在场，硬件层面无法补 |

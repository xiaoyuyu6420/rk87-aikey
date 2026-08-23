# 10-intent-contract（检查点①批准版）

> goal 模式 + 用户明说"全自动"：契约与 spawn 计划以展示代替阻塞等待，偏离已记录于 STATE。
> 歧义全部按推荐读法执行（A1-A5）。

## 意图

在 macOS 26.5 arm64 + 蓝牙 R87Pro Ai 在场的真机上，无人值守 e2e 验证 RK87-AIKey v0.6.0 mac 路径，产出**每条带可复查证据**的问题报告，verdict ∈ {pass / app-bug / env-missing / hardware-absent / inconclusive}。

非目标：不修代码（只诊断 + 修复建议）、不测 Windows/Linux、不逆向新协议、不擅自装 BlackHole。

## EARS 契约（R1-R14）

### 安装与启动
- R1 [确定] `pnpm install` 退出码 0；koffi、node-hid 解析出 darwin-arm64 原生二进制；网络失败先走本地代理 127.0.0.1:7897 重试并记录。
- R2 [确定] `ELECTRON_ENABLE_LOGGING=1` + `--remote-debugging-port=9222` 启动，≤15s 出现 BrowserWindow（`curl -s localhost:9222/json` 可列出页面），stdout 无 `[uncaught]`，进程存活 ≥120s。
- R3 [确定] 单实例锁：第二实例静默退出码 0——启动后 <5s 退出且码 0 判为锁冲突而非通过；每阶段前清残留实例。

### 无硬件降级 / 真实蓝牙键盘
- R4 [确定] 仅蓝牙在场（KeyboardWatcher 只认有线 PID 8102）时应静默降级：无未捕获异常、日志不刷屏、托盘"键盘：未连接"、UI 可操作。
- R5 [假设:固件与逆向一致] 蓝牙 R87Pro Ai 在场时，KeySession 经 vendor mi-hid 枚举 VID 0x248A/PID 0x8243，完成握手进入在线；失败须定位阶段（枚举不到/打开失败/无104/握手超时）+ 日志摘录。
- R6 [需澄清→裁决:不自动测] 物理按键链不纳入自动验证；验证到"会话在线 + test-action IPC 直注"两层，物理按键列人工补测清单。

### UI 与配置
- R7 [确定] renderer 加载后，CDP 调 `window.aikey.getState()` 返回 14 键 + bindings + settings，console 无 error，DOM 含 14 键行。
- R8 [确定] CDP 调 `setBinding('f1',{type:'url',...})` 后重启，绑定持久化；**实测记录真实 userData 路径**（productName "RK87 AIKey" vs README 声称 rk87-aikey，以实测为准）。
- R9 [假设] 使用 `--user-data-dir` 隔离；不可行则测试前备份后恢复真实 config.json/stats.json，用户数据零污染。

### 快捷键与统计
- R10 [假设] `testAction({type:'hotkey'})` 发快捷键，前台输入框内容应变化；TCC 未授权 → env-missing（附检测方法），已授权仍无效 → app-bug。
- R11 [确定] 打字统计 darwin supported=true；OS 级真实击键（CGEvent 路径）后 stats-get today.total 递增且 stats.json 落盘。注意 CDP `Input.dispatchKeyEvent` 不经 OS 键态，不可作统计输入源。

### 托盘与打包
- R12 [假设] 托盘创建成功、菜单含"打开设置/退出"；退出后无残留进程；关窗=隐藏可恢复。
- R13 [确定] `pnpm dist:mac` 码 0 产出 zip；arm64 zip 内 .app CDP 冒烟；**zip 内 koffi/node-hid `.node` 逐个 `lipo -info`/`file` 记录架构——x64 产物含 arm64 原生库记为高危**。

### 麦克风桥接（分层）
- R14 [需澄清→按探测] a) R5 在线则 `micControl(true)` → mic-state on:true + renderer 收到非全零 mic-pcm（此层不需 BlackHole）；b) BlackHole 端到端，未装 → env-missing + 一行指引，不擅自装驱动。

## 完成判定（硬门槛）

1. `e2e/` 有可重复执行入口（run.sh）+ report.md；脚本整体退出码 0。
2. report.md 覆盖 R1-R14 每条，各附证据（命令 + 输出摘录 / 日志行 / 截图路径）；≥1 张 CDP 截图。
3. env-missing 点名缺失项 + 检测命令输出；app-bug 附最小复现命令；hardware-absent 仅限 R6 与 x64 实机。
4. 核心硬门槛：install 码 0；dev 存活 ≥120s 且无 `[uncaught]`；9222 可列页面；dist:mac 码 0 + zip + lipo 结论入报告；结束无残留进程；真实 config/stats 与测试前一致；蓝牙会话结论有证据。

## 歧义裁决（采纳推荐）

- A1 物理按键：不自动测，列人工补测清单。
- A2 dev 全量 + dist 产物冒烟（启动/UI/lipo）。
- A3 只诊断不修，报告按严重度排序附建议。
- A4 x64：构建 + 静态 lipo 定罪，不找 Intel 机。
- A5 BlackHole：不装，env-missing + 指引。

## 隐藏关切（e2e 设计必须消化）

- H1 [最高优先] `build.npmRebuild:false` + arm64 构建 → x64 zip/dmg 疑似内嵌 arm64 `.node`，Intel Mac require 即崩；CI（arm64 runner）发布的 x64 artifact 同理。R13 lipo 专为此设。
- H2 app "永不显式失败"（uncaughtException 全吞 / 单实例静默退 / 托盘常驻）→ 通过标准必须三件套：日志标记 + CDP 页面存在 + UI 状态；每阶段前清残留。
- H3 TCC 归因陷阱：快捷键需辅助功能授权（授权对象是 dev 版 Electron 路径，重装即失效）；全屏截图需屏幕录制权限（改用 CDP 截图规避）。

# RK87 AIKey

给 **RK R87 Pro AI** 键盘写的自定义功能键 + 麦克风工具，**完全不依赖官方 RK-AI 软件**。
- 键盘 AI 模式下的 14 个键（AI 键 + F1~F12 + PrtSc）可任意映射成：启动程序 / 打开网址 / 发送快捷键，支持「启动后补发快捷键」做 AI 助手一键直达。
- **键盘麦克风 → 系统虚拟麦克风**：把键盘内置麦克风变成 Windows 通用输入设备，微信输入法等任何软件可用。

协议逆向自官方 RK-AI 1.0.2（Electron 明文源码）+ 三轮实机标定，详见 [docs/protocol.md](docs/protocol.md)。

## 功能键

1. 启动后托盘常驻，设置窗口自动弹出
2. 按键盘「AI 切换」键进入 AI 模式（F 行白灯亮）
3. 在设置界面给每个键配动作（双击键名可改备注）
4. 按键即触发；配置界面里按键会高亮对应行，可当键位测试器

支持有线（`VID 248A / PID 8102`）、蓝牙（`PID 8243`）和 **2.4G 接收器**三种连接，即插即用自动识别。2.4G 接收器插 USB 时键盘同样枚举为 `PID 8243`（与蓝牙同 PID，靠 HID interface 区分），命令帧写通道自动切换（蓝牙 `0xF1` / 2.4G `0xF0`，逆向自官方 connectWay 逻辑）；多口并存时自动在候选口间轮询握手，谁回应用谁。

## 键盘麦克风 → 虚拟麦克风（V2）

无需官方 RK-AI：app 自主维持键盘会话开麦，解码后的音频播到虚拟声卡，系统里即成为普通麦克风，微信输入法等任何软件可用。

- **一次性**：装虚拟声卡——Windows [VB-Cable](https://vb-audio.com/Cable/)（装后建议重启）／macOS [BlackHole 2ch](https://existential.audio/blackhole/)（`brew install blackhole-2ch` 或官网下 pkg）
- **系统设置**：默认输入设备（麦克风）选 **CABLE Output**（Win）／ **BlackHole 2ch**（Mac；BlackHole 输入输出同名，两侧都叫 BlackHole 2ch）
- **使用**：勾「启用桥接」+ 播放设备选 CABLE Input ／ BlackHole 2ch → 按住开麦键说话（默认 F10 + AI 键，可在麦克风卡片勾选更改）

技术链路：命令会话开麦 → 键盘音频流（厂商私有编码，mi-sbc 解码）→ 16kHz PCM + AGC/降噪 → WebAudio 播到虚拟声卡。

## 打字统计

统计你每天敲了多少键：今日总数、最常用键 Top5、近 7 天柱状图，设置窗口「打字统计」卡片里查看，可随时关闭（默认开启）。

- 原理：轮询系统级键状态（Windows `GetAsyncKeyState` / macOS `CGEventSourceKeyState`，无需额外权限），不装键盘钩子、不读键盘 HID，不会与系统抢键盘
- **隐私**：只记录「每键计数」和「每日总数」，不记录按键顺序、时间戳序列或所在应用，不上传任何数据；纯本地 `userData/stats.json`，仅保留最近 90 天
- Linux 不支持（界面会提示）

## 键位表（实测标定）

| 物理键 | 键码(按/抬) | 官方原功能 |
|---|---|---|
| AI 键 | 51 / 66 | AI问答 |
| F1 | 82 / 97 | 文字校对 |
| F2 | 58 / 73 | 阅读 |
| F3 | 55 / 70 | 写作 |
| F4 | 63 / 78 | 长文写作 |
| F5 | 60 / 75 | 心得体会 |
| F6 | 59 / 74 | PPT |
| F7 | 53 / 68 | 绘图 |
| F8 | 54 / 69 | 表格 |
| F9 | 83 / 98 | 项目方案 |
| F10 | 48 / 57 | 语音打字（= 麦克风开麦键） |
| F11 | 49 / 64 | 翻译 |
| F12 | 50 / 65 | 截图 |
| PrtSc | 56 / 71 | 思维导图 |

## 动作类型

- **启动程序**：指向 `.exe/.bat/.cmd/.lnk`（macOS 为 `.app/.command`；要带参数就写个 .bat/.command）
- **打开网址**：http/https 链接
- **发送快捷键**：如 `Ctrl+Shift+S`、`Win+Shift+S`（修饰键 Ctrl/Alt/Shift/Win + 字母/数字/F1-F24/方向键等）。支持**点击「捕获」直接按组合键**录入。macOS 上 Win 键映射为 Cmd、Alt 映射为 Option（CoreGraphics CGEvent 实现）；功能键 macOS 侧支持到 F20
- **AI 直达**：启动程序或网址 + 延时后自动补发一个快捷键（如唤起 AI 助手并聚焦输入框）

## 开发

```bash
pnpm install
pnpm start        # 开发运行
pnpm listen       # 键盘报文监听标定工具（纯 Node）
pnpm dist         # 打包 Windows portable exe
pnpm dist:mac     # 打包 macOS zip（arm64 + x64，未签名，建议在 Mac 上构建）
```

配置存储：Windows `%APPDATA%/rk87-aikey/config.json`，macOS `~/Library/Application Support/rk87-aikey/config.json`。

目录要点：
- `src/main/kb-session.js` — 键盘命令会话（蓝牙口心跳/验证/开麦）
- `src/main/mic.js` — 音频解码管线（vendor mi-sbc + AGC/高通/噪声门）
- `src/main/stats.js` — 打字统计（系统级键状态轮询 + 本地计数）
- `vendor/mi-hid/` `vendor/mi-sbc/` — 官方库 vendor（HID 驱动 / 音频解码）
- `docs/protocol.md` — 完整协议逆向文档

## 已知限制 / 计划

- [x] macOS 兼容：CGEvent 快捷键、mi-hid/mi-sbc darwin prebuilds、构建配置已就绪；首次使用需在 系统设置>隐私与安全>辅助功能 授权本应用（发快捷键必需），**待真机验证**
- [x] 2.4G 接收器兼容：实测接收器枚举为 PID 8102（非 8243），走 USB 口 F1 通道，命令会话/麦克风桥接全功能可用（2026-08-24 实机标定）
- [x] 有线/USB 口完整支持：推翻「有线口固件零回应」旧结论——8102 口走蓝牙同款 F1 通道可建完整会话；音频为 0x1C 帧 16kHz PCM 直出（免 SBC 解码），三种连接方式功能等价
- [ ] 官方软件的语音打字/翻译云服务是闭源的，本工具只做"麦克风"，识别交给第三方输入法
- [ ] 键盘改键（noticeHid_SetKeyValue 协议已定位，未实现）
- [ ] 音质上限受源头 32kbps 编码限制，后处理只能拉响度不能补细节

## 免责声明

仅供个人学习与研究使用。键盘通信协议通过分析本机已安装的官方 RK-AI 软件明文代码获得；`vendor/` 中的 mi-hid、mi-sbc 库提取自官方发行包，版权归原作者所有。与官方 RK-R 论坛/固件无关联，使用本工具产生的一切后果由使用者自行承担。

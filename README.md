# RK87 AIKey

<div align="center">

**让 RK R87 Pro AI 键盘的 AI 功能键和麦克风，在 Windows / macOS 上完全听你指挥**

不装官方 RK-AI，无广告、无联网、纯本地运行

[![Release](https://img.shields.io/github/v/release/xiaoyuyu6420/rk87-aikey)](https://github.com/xiaoyuyu6420/rk87-aikey/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/xiaoyuyu6420/rk87-aikey/releases)
[![License](https://img.shields.io/github/license/xiaoyuyu6420/rk87-aikey)](LICENSE)
[![Discussions](https://img.shields.io/github/discussions/xiaoyuyu6420/rk87-aikey)](https://github.com/xiaoyuyu6420/rk87-aikey/discussions)

![RK87 AIKey 界面](docs/screenshot-ui.png)

*功能键映射 · 键盘麦克风桥接 · 打字统计，一个托盘应用全搞定*

</div>

> **English**: Custom hotkeys & mic bridge for the RK R87 Pro AI keyboard — remap the 14 AI-mode keys, turn the keyboard mic into a system microphone, track typing stats. Fully offline, no official RK software needed.

## ✨ 它能做什么

| 功能 | 一句话说明 |
|---|---|
| ⌨️ **功能键自定义** | AI 键 + F1~F12 + PrtSc 共 14 个键，映射成启动程序 / 打开网址 / 发送快捷键，支持「启动后补发快捷键」一键唤起 AI 助手 |
| 🎙️ **键盘麦克风共享** | 把键盘内置麦克风变成系统虚拟麦克风——微信输入法、会议软件等**任何应用**都能用它说话 |
| 📊 **打字统计** | 每日按键数、最常用键 Top5、近 7 天柱状图。纯本地记录，只记次数不记内容 |

协议逆向自官方 RK-AI 1.0.2（Electron 明文源码）+ 三轮实机标定，完整文档见 [docs/protocol.md](docs/protocol.md)。

## 📦 下载安装（1 分钟）

去 [**Releases**](https://github.com/xiaoyuyu6420/rk87-aikey/releases/latest) 下载对应系统的文件：

| 系统 | 文件 | 说明 |
|---|---|---|
| Windows | `RK87-AIKey-x.x.x-portable.exe` | **推荐**，免安装双击即用，配置随 exe 目录（可放 U 盘） |
| Windows | `RK87-AIKey-Setup-x.x.x.exe` | 安装版，开机自启更方便 |
| macOS (M 系列) | `RK87.AIKey-x.x.x-arm64.dmg` | Apple Silicon |
| macOS (Intel) | `RK87.AIKey-x.x.x.dmg` | x64 |

> 应用未做代码签名，首次打开如遇 SmartScreen / Gatekeeper 拦截：Windows 点「仍要运行」；macOS 到「系统设置 → 隐私与安全性」点「仍要打开」。介意的话可以自行从源码构建（见文末）。

## 🚀 3 步上手

1. 启动后托盘常驻，设置窗口自动弹出
2. 按键盘上的 **「AI 切换」键**进入 AI 模式（F 行白灯亮）
3. 在设置界面给每个键配动作，**按键即触发**——配置界面里按键会高亮对应行，可直接当键位测试器

支持有线（`VID 248A / PID 8102`）、蓝牙（`PID 8243`）、2.4G 接收器三种连接，即插即用自动识别，多口并存自动轮询握手。

## ⌨️ 键位表（实测标定）

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
| F10 | 48 / 57 | 语音打字（= 默认开麦键） |
| F11 | 49 / 64 | 翻译 |
| F12 | 50 / 65 | 截图 |
| PrtSc | 56 / 71 | 思维导图 |

## 🎯 动作类型

- **启动程序**：`.exe/.bat/.cmd/.lnk`（macOS 为 `.app/.command`；要带参数就包一层 .bat/.command）
- **打开网址**：http/https 链接
- **发送快捷键**：如 `Ctrl+Shift+S`、`Win+Shift+S`，支持**点击「捕获」直接按组合键**录入（macOS 上 Win→Cmd、Alt→Option）
- **AI 直达**：启动程序/网址 + 延时补发快捷键，一键唤起 AI 助手并聚焦输入框

## 🎙️ 键盘麦克风 → 虚拟麦克风

无需官方 RK-AI：应用自主维持键盘会话开麦，解码音频播到虚拟声卡，系统里就是一个普通麦克风，微信输入法等任何软件可用。

一次性配置：

1. **装虚拟声卡**（免费）：Windows 装 [VB-Cable](https://vb-audio.com/Cable/)（装后建议重启）／ macOS 装 [BlackHole 2ch](https://existential.audio/blackhole/)（`brew install blackhole-2ch`）
2. **系统默认输入设备**选 `CABLE Output`（Win）／ `BlackHole 2ch`（Mac）
3. 应用里勾「**启用桥接**」，播放设备选 `CABLE Input` ／ `BlackHole 2ch`，按住开麦键（默认 F10 + AI 键，可改）说话

技术链路：命令会话开麦 → 键盘音频流（厂商私有编码 mi-sbc 解码）→ 16kHz PCM + AGC/降噪（RNNoise / DeepFilterNet3 双引擎）→ WebAudio 播到虚拟声卡。

## 📊 打字统计

今日按键总数、最常用键 Top5、近 7 天柱状图，设置窗口「打字统计」卡片查看，可随时关闭（默认开启）。

- 轮询系统级键状态（`GetAsyncKeyState` / `CGEventSourceKeyState`），**不装键盘钩子、不读键盘 HID**
- **隐私**：只记「每键计数」，不记录按键顺序、时间序列或所在应用，不上传任何数据；纯本地 `userData/stats.json`，仅保留 90 天
- Linux 暂不支持

## ❓ FAQ

<details>
<summary><b>杀毒软件报毒 / SmartScreen 拦截？</b></summary>

应用未购买代码签名证书，属于常见误报。全部源码开放，可自行审查或从源码构建；也可在杀软中添加信任。
</details>

<details>
<summary><b>和官方 RK-AI 软件冲突吗？</b></summary>

完全不依赖官方软件，建议不要同时运行，避免争抢键盘 HID 会话。
</details>

<details>
<summary><b>麦克风桥接后其他软件听不到声音？</b></summary>

按顺序检查：① 虚拟声卡已安装（Windows 装完 VB-Cable 建议重启）；② 系统**默认输入设备**是 `CABLE Output`（不是 CABLE Input）；③ 应用里「启用桥接」已勾选且播放设备是 `CABLE Input`；④ 按住了开麦键（默认 F10）。
</details>

<details>
<summary><b>键盘连不上？</b></summary>

确认键盘已切到 AI 模式（F 行白灯亮）。有线/蓝牙/2.4G 三种连接都支持，多设备并存时应用自动轮询握手；还不行就点设置里的「刷新」，或拔插重连。
</details>

<details>
<summary><b>我的键盘不是 R87 Pro AI，能用吗？</b></summary>

协议文档 [docs/protocol.md](docs/protocol.md) 完整记录了通信协议，RK 系列同方案键盘有希望小改适配，欢迎提 Issue 一起调试。
</details>

## 💬 反馈

**我们正在收集 200 份真实使用反馈**来决定下一步方向——好用在哪、哪里难用、还想要什么，[去这里说一句](https://github.com/xiaoyuyu6420/rk87-aikey/discussions/13)就行，吐槽最有价值。

- 🐛 [报 Bug](https://github.com/xiaoyuyu6420/rk87-aikey/issues/new?template=bug_report.yml)
- 💬 [使用反馈 / 提问](https://github.com/xiaoyuyu6420/rk87-aikey/discussions)

## 🛠️ 从源码运行

```bash
pnpm install
pnpm start        # 开发运行
pnpm listen       # 键盘报文监听标定工具（纯 Node）
pnpm dist         # 打包 Windows portable exe
pnpm dist:mac     # 打包 macOS zip（arm64 + x64，未签名）
```

配置存储：Windows `%APPDATA%/rk87-aikey/config.json`，macOS `~/Library/Application Support/rk87-aikey/config.json`。

目录要点：

- `src/main/kb-session.js` — 键盘命令会话（蓝牙/2.4G 口心跳/验证/开麦）
- `src/main/mic.js` — 音频解码管线（vendor mi-sbc + AGC/高通/噪声门）
- `src/main/stats.js` — 打字统计（系统级键状态轮询 + 本地计数）
- `vendor/mi-hid/` `vendor/mi-sbc/` — 官方库 vendor（HID 驱动 / 音频解码）
- `docs/protocol.md` — 完整协议逆向文档

## 🗺️ 已知限制 / 计划

- [x] macOS 兼容：CGEvent 快捷键、mi-hid/mi-sbc darwin prebuilds、构建配置已就绪；首次使用需在「系统设置 → 隐私与安全性 → 辅助功能」授权本应用（发快捷键必需）
- [x] 2.4G 接收器 / 有线 USB 完整支持：三种连接方式功能等价（2026-08 实机标定）
- [ ] 官方软件的语音打字/翻译云服务是闭源的，本工具只做「麦克风」，识别交给第三方输入法
- [ ] 键盘改键（协议已定位，未实现）
- [ ] 音质上限受源头 32kbps 编码限制，后处理只能拉响度不能补细节

## ⭐ 支持

如果这个工具帮到了你，点个 Star 让更多人看到；也欢迎[提反馈](https://github.com/xiaoyuyu6420/rk87-aikey/discussions/13)和 PR。

## 📄 免责声明

仅供个人学习与研究使用。键盘通信协议通过分析本机已安装的官方 RK-AI 软件明文代码获得；`vendor/` 中的 mi-hid、mi-sbc 库提取自官方发行包，版权归原作者所有。与官方 RK-R 论坛/固件无关联，使用本工具产生的一切后果由使用者自行承担。

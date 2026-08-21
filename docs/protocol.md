# RK R87 Pro AI 键盘 HID 协议（逆向自官方 RK-AI 1.0.2）

来源：`%LOCALAPPDATA%\Programs\RK-AI\resources\app.asar` 内 `background.js`（Electron，代码明文）。
逆向产物在 `_reversed/` 目录（hid_core / hid_section / key_logic / frame）。

## 1. 设备识别

- 官方软件枚举所有 HID 设备，只处理 **usagePage ≥ 0xFF00（厂商自定义页）** 的接口。
- R87 Pro AI 对应两条记录（还有全家族 40+ 设备，见 hid_section.pretty.js `loadSupportDevice()`）：
  - 有线 USB：VID `0x248A` / PID `0x8102`，hidType = `R87ProAIB`(1010)，connectWay 1
  - 蓝牙 BLE：VID `0x248A` / PID `0x8243`，hidType = `R87ProAIB`，connectWay 2
- **2.4G 接收器**：插 USB 后键盘同样枚举为 `PID 0x8243`（与蓝牙同 PID，无独立表项）。官方靠
  `isBluetoothConnect(release, interface) = (release==1 || interface==-1)` 区分：真蓝牙（Windows 上
  interface=-1）把 connectWay 从 2 降为 0；USB 上的 8243（interface>=0 且 release!=1）保持 2 = 2.4G dongle。
- 打开方式：`new HID(path)` 直接按 path 打开（Windows 允许多进程共享读取，可与官方软件共存监听）。
- 读写缓冲：62/64 字节；**macOS 上官方写帧强制补满 64 字节**（`EncodeHid_Normal` darwin 分支）。

## 2. 报文帧格式

`DecodeHid_Normal`（AI 键盘用）——两种通道前缀，其余一致：

```
通道0:  [0x05, 0xFE, 0xC0, cmd, len, data[len]..., 0xEF]
通道1:  [0x05, 0xFF, 0xF1, 0xFE, 0xC0, cmd, len, data[len]..., 0xEF]
通道2:  [0x05, 0xFF, 0xF0, 0xFE, 0xC0, cmd, len, data[len]..., 0xEF]
```

- 首字节是 reportId（0x05）；0xC0 是命令魔数；尾部 0xEF 校验。
- 读侧（键盘→主机）：通道1 (0xF1) 蓝牙、通道2 (0xF0) 2.4G/dongle。
- 写侧（主机→键盘，`EncodeHid_Normal(cmd, channel, ...)`）：**channel 0/1 → 前缀 0xF1，channel 2 → 前缀 0xF0**。
  对应实际场景：真蓝牙（connectWay 降为 0）写 0xF1；2.4G dongle（USB 上的 8243，connectWay=2）写 0xF0。

`DecodeHid_RK`（MK87/R87 传统键盘用，reportId 0x01）：

```
[0x01, 0xFA, 0xF2, 0xFE, 0xC1, cmd, len, data[len]..., 0xEF]
```

音频流（不需要处理，语音功能用）：reportId 0x1A(26)/0x1B(27)/0x1C(28)，以及 `[0x05, 0xAD, ...]` 的 SBC 帧。

## 3. 命令字（cmd）

| cmd | 含义 |
|---|---|
| 159 (0x9F) | **按键事件**，dataLen=1，data[0]=键码 |
| 26/27/28 | 麦克风音频流（S7B/SBC/Raw） |

## 4. 键码表（onHidKey_Keyboard + 两轮实机标定确认）

最终物理键位对应（AI 模式下，两轮标定结果 100% 一致）：

| 物理键 | 按下 | 抬起 | 官方功能 (aiMode) |
|---|---|---|---|
| AI 键 | 51 | 66 | AI问答 (1) |
| F1 | 82 | 97 | 文字校对 (8) |
| F2 | 58 | 73 | 阅读 (9) |
| F3 | 55 | 70 | 写作 (6) |
| F4 | 63 | 78 | 长文写作 (13) |
| F5 | 60 | 75 | 心得体会 (10) |
| F6 | 59 | 74 | PPT (2) |
| F7 | 53 | 68 | 绘图 (4) |
| F8 | 54 | 69 | 表格 (5) |
| F9 | 83 | 98 | 项目方案 (16) |
| F10 | 48 | 57 | 语音打字（走语音通道） |
| F11 | 49 | 64 | 翻译/同声传译（走语音通道） |
| F12 | 50 | 65 | 截图 |
| PrtSc | 56 | 71 | 思维导图 (7) |

未在本机出现的协议键码（保留）：80=上网(3)、61=工作总结(11)、62=模板(12)、81=通用短文写作(14)。

官方 16 个 AI 模式全表（渲染进程 chatShortCutListForKeyBoard 逆向）：
1=AI问答 2=PPT 3=上网 4=绘图 5=表格 6=写作 7=思维导图 8=文字校对 9=阅读 10=心得体会 11=工作总结 12=模板 13=长文写作 14=通用短文写作 16=项目方案

其他实测发现：
- **AI 切换键**发独立命令 cmd=209(0xD1)，data 1/0（按下期间重复多帧）
- 按键报文期间键盘伴随发 cmd=106/107 的状态流，忽略即可
- cmd=104(0x68) 是周期心跳（约每 2~3 秒一对，data=0）
- F10/F11 的抬起码会连发两帧（57/64 ×2），边沿触发逻辑天然免疫
- 语音类键（F10/F11/AI键长按）按下后键盘开始经 cmd 26/27/28 流式发麦克风音频

## 5. 写命令（V1 暂不需要）

`EncodeHid_Normal`：`[0x05, 0xFF, (0xF1|0xF0), 0xFE, 0xC0, cmd, len, data..., 0xEF]`。
官方用途：开启/关闭麦克风录音流（openDeviceRecord/closeDeviceRecord）、改键（noticeHid_SetKeyValue）、DPI、固件 OTA 等。将来做"自己接麦克风语音"或"改键"时再深挖。

## 6. 物理键位 ↔ 键码对应（待实测确认）

AI 模式下 F1~F12 + PrtSc 共 13 个键对应上述 11 个 AI 键码 + 语音键码，具体哪个键发哪个码需要实机按键验证（tools/listen.js）。

## 7. 麦克风完整协议（V2 逆向，全部实测验证）

### 7.1 双接口架构（关键！）

键盘同时暴露两个厂商接口（usagePage 0xFF12），**职责不同**：

| 接口 | PID | 角色 | 读写 |
|------|-----|------|------|
| 有线 USB（MI_01 Col02） | `0x8102` | 音频流/状态上报 | 只读（写入被固件忽略） |
| 蓝牙 BLE（Col02） | `0x8243` | **命令通道**（心跳/验证/开麦） | 读写（写帧 62 字节） |
| 2.4G 接收器（USB） | `0x8243` | 单口双职责（按键+音频+命令，写前缀 0xF0） | 读写（待实测） |

2.4G 模式下 8102 不出现（键盘没插线），USB 上只有一个 8243：命令会话独占该口，按键/音频从
会话读循环转发（kb-session.js 已实现多口轮询：USB dongle 优先，8 秒握手无回应自动换蓝牙口）。

**教训**：所有命令必须走蓝牙口。有线口 WriteFile 表面成功但固件零回应——
V2 联调初期在有线口上穷尽所有写法（WriteFile 62/64/65、HidD_SetOutputReport、
Report ID 前缀变体）全部无效，根因即此。

### 7.2 会话握手（tools/session6.js 验证）

官方软件靠这套握手让键盘进入"可命令"状态，我们完全复刻（kb-session.js）：

```
主机 → 键盘  cmd=5   心跳（open 后立即发一次，之后每秒）
键盘 → 主机  cmd=104 心跳回应
（首次 104）主机 → 键盘  cmd=12  设备状态查询
            主机 → 键盘  cmd=15  验证挑战：32B 随机数（官方算法：
                                 主机自己生成随机数 e，secretKey 本地留存）
键盘 → 主机  cmd=227 验证回应（兼设备型号上报：尾部字节 238=R87ProAIB）
            主机 → 键盘  cmd=17  SN 查询
键盘 → 主机  cmd=177 SN 回应（如 "123162373165..."）
            主机 → 键盘  cmd=1   Open（会话激活）
→ 之后每秒 cmd=5 保活；断线（3 次无 104）重走全流程
```

验证挑战参考实现（逆向自 noticeHid_VerifyDevice，实发随机数本体）：

```js
const e = Array.from({length: 32}, () => Math.floor(Math.random() * 256));
// 主机本地算 secretKey（与键盘侧相同的算法，供后续会话用）：
//   t=(e[7]+2)%32; r=(e[17]+2)%32>2 ? (e[8]+2)%32 : 3; r<2&&(r=3);
//   n=t%r; i=e[23]%32%7;
//   secretKey[k] = "MiMouse".charCodeAt((i+k)%7) ^ e[(n+k)%32]
// 实测：只发 e 本体键盘即接受（227 返回），secretKey 未被校验使用
```

### 7.3 麦克风控制命令

| 命令 | 方向 | 含义 |
|------|------|------|
| `cmd=3` | 主机→键盘 | AskVoice 开麦 → 键盘回 `cmd=106` 并开始推音频流 |
| `cmd=4` | 主机→键盘 | StopVoice 关麦 → 键盘回 `cmd=107`，流停 |
| `cmd=159` | 键盘→主机 | 物理按键上报（data[0]=键码，F10 down=48/up=57） |
| `cmd=106/107` | 键盘→主机 | 麦克风开/关状态通知 |

物理 F10 与软件 AskVoice 双路皆可开麦（V2 采用：F10 按下→主机发 cmd=3，
软件 UI「开始说话」按钮→同样 cmd=3）。

### 7.4 音频流格式（V1 已破解，此处归档）

- 报文：reportId `0x1B`，62 字节 = `[0x1B, seq, ...60B 净荷]`，15.0ms/包
- 净荷 = 3 小帧，每帧 `[0xAD, 0x31, 0x0C, ...20B]`
- 编码：厂商私有（**非标准 SBC**——libsbc 全参数穷举失败、CRC 0% 通过；
  亦非 ADPCM/G.711）。解码器 = 官方 npm 包 `mi-sbc`（NAPI v4 全平台
  prebuilds，已 vendor 到 `vendor/mi-sbc/`），`decode(23B帧, 23, 160B dst)`
  恒返回 80 样本 int16
- 每报文 3×80=240 样本 = **16kHz 单声道**，码率约 32kbps
- 后处理（src/main/mic.js）：120Hz 一阶高通 → AGC（目标 RMS 4500，增益
  1~8）→ 噪声门。源头 32kbps 有损，音质上限不可恢复，只能拉响度

### 7.5 虚拟麦克风桥接（V2 完整链路）

```
键盘 --HID 0x1B流--> kb-session(audio) --> mic.js 解码+增强(120ms批)
    --> IPC --> renderer WebAudio(AudioContext 16kHz, sinkId=CABLE Input)
    --> VB-Cable 内部路由 --> 系统「CABLE Output」输入设备
    --> 微信输入法（跟随系统默认麦克风）→ 出字
```

依赖：VB-Cable 虚拟声卡（用户自装）；系统默认输入设备需选 CABLE Output。

### 7.6 官方库 vendor 说明

- `vendor/mi-hid/`：官方 HID 库 fork（hidapi 系）。**必须用它驱动蓝牙口**——
  node-hid 写蓝牙口同样成功但实测键盘不回（原因未深究，可能与其内部
  output report 长度处理有关；mi-hid 实测稳定）
- `vendor/mi-sbc/`：官方音频解码器（全平台 prebuilds）

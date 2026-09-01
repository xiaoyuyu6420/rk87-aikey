# 教训记录

项目踩过的坑与修复方法，避免重蹈。

## 1. 静默 catch 吞掉初始化异常 → 功能从未工作却无痕迹（v0.10.3 起）

**现象**：F10 长按唤不醒微信输入法语音，时好时坏。

**根因**：`actions.js` 的 `ensureSendInput()` 使用了 `koffi.struct(...)`，但 `koffi` 是
隔壁 `ensureUser32()` 的函数局部变量——`koffi is not defined` 每次抛出，被
`postRawKey` 的 `catch (_)` 静默吞掉。结果 **SendInput 从未初始化成功，所有按键
注入（透传 / 发送快捷键 / 宏回放）从未真正发出去过**，且日志零痕迹。

**修复**：`ensureSendInput` 内补 `const koffi = require('koffi')`。

**教训**：
- `catch (_)` 完全静默只适用于"失败可容忍且高频"的场景；**初始化类失败必须留痕**
  （至少限频打印），否则功能坏死无法察觉。
- FFI/原生调用边界的初始化代码要重点审查变量作用域。
- "时好时坏"的表象会误导方向：本案真正原因是**注入从未工作**，用户感知的
  "以前能用"来自另一条不经注入的路径（普通模式标准报文直通系统）。

## 2. vendor 拷贝不完整 → ES module 链静默失败（v0.11.0 改版）

**现象**：3D 首屏（Three.js module 链）整个不渲染，无报错或只报顶层
`Failed to fetch`。

**根因**：复制 Three.js 时只拷了 `three.module.min.js`，漏了它内部 import 的
`three.core.min.js`。Chromium 对 import 失败只报最顶层模块，中间缺哪个文件不说。

**修复**：补齐文件。**教训**：复制带内部依赖的 ESM 库时，先 grep 它的
`from './...'` 依赖清单，逐一核对；或复制整个 build 目录。

## 3. file:// 下 ES module 的限制（了解即可）

file:// 协议下 ES module 的 import 走 CORS 模式（origin 为 null 被拒）。本项目
最终方案：`webPreferences.webSecurity: false`（本地工具、无远程内容、
contextIsolation 仍开启，取舍可接受）。曾尝试自定义协议 `protocol.handle` 方案，
被两类问题耗掉大量时间：① koffi/Response 组合下 module loader 静默失败；
② CSP 响应头里 scheme-source 写法（`rk87:` / `rk87://app`）都会弄挂 module，
只有 `'self'` 可用。如未来重新尝试协议方案，从 `'self'` CSP 起步。

## 4. 诊断方法论：静默失败时，先加日志暴露真实异常，别靠推理

本次定位 `koffi is not defined` 走了弯路：AI 模式漂移、CSP、CORS、双实例抢读……
推理全部落空。最终一击是**给 catch 加一行日志直接打印异常**。教训：

- catch 吞异常的函数，排查第一件事就是**把异常打出来再跑一次**；
- 分层探针（网络层 fetch / module 引擎 / 实际 import）比逐个改代码猜快得多；
- `GetAsyncKeyState` 无法区分物理按键与远控注入——远控场景的"误计数"问题
  用手动开关解决（统计页/托盘的"远控模式"），不要试图自动判定。

## 5. koffi 的"写入型"out 参数：必须 alloc + decode，JS 对象 marshal 是单向的（v0.12.0）

**现象**：AI 层的 `RegisterHotKey` 注册成功（12/12），但注入热键后 `GetMessage`
循环收到的消息永远读不到（`msg.message` 恒为初始值）。

**根因**：`GetMessageW` 会往传入的结构体缓冲区里**写**。koffi 把普通 JS 对象
marshal 成结构体指针时只做"JS→缓冲区"单向拷贝，API 写进缓冲区的内容**不会
回读到 JS 对象**。必须：

```js
const buf = koffi.alloc('AILAYER_MSG', 1);      // 分配缓冲区（alloc 要两个参数！）
GetMessageW(buf, null, 0, 0);
const msg = koffi.decode(buf, 'AILAYER_MSG');   // 显式读回
```

另外两个签名坑：① 结构体类型必须**先 `koffi.struct` 注册再在 func 签名里引用**；
② func 签名里写 `void *` 接收不了 JS 对象，要写具体结构体类型名（同 actions.js
的 `SendInput(uint32, KINPUT *, int)` 用法）。

**教训**：FFI 调用分「读参数」（对象直接传）和「写参数」（alloc+decode）两类，
写参数用普通对象传参 = 静默拿到空数据，且不报错，只能靠逐层探针定位。

## 6. Electron userData 目录名跟 productName 走，改名迁移别找错旧目录（v0.12.0）

- 默认 userData = `%APPDATA%/<productName>`，**不是** package.json 的 `name`。
  本项目 0.11.x 的目录是 `%APPDATA%/RK87 AIKey`（带空格），不是 `%APPDATA%/rk87-aikey`。
- dev 模式（`tools/dev.js` 在入口脚本顶层 `getPath('userData')+'-dev'`）拿到的基准是
  `%APPDATA%/Electron`——此刻 app.name 还是 'Electron'，package.json 尚未生效。
  所以 **dev 数据一直在 `%APPDATA%/Electron-dev`**，与正式目录无关。
- 迁移函数三条防线：白名单根校验（oldDir 必须在 appData/portable 目录下）、
  dev 目录（`-dev` 结尾）跳过、目标已有 config.json 跳过（幂等）。

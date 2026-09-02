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

## 7. Windows E2E 假阴性：tasklist 镜像名大小写 + 孤儿实例端口污染（v0.12.0 AI 层专项）

- `tasklist` 输出的镜像名保留原始大小写（`Notepad.exe`），按 `grep -c "notepad.exe"`
  计数**恒为 0**——"功能没生效"的结论可能纯属大小写。进程计数一律 `grep -ci`。
- 测试拉起的 Electron 由 `node cli.js` 包装，`taskkill //PID <node>` 偶尔杀不到
  electron.exe 孤儿：它继续占着 CDP 端口，下一轮 `wait_cdp` 探到的是**僵尸实例**，
  后续全部 verdict（含"关闭态注入竟触发"）都是它在响应。杀进程必须 `//T` 杀树 +
  按端口兜底（`netstat -ano` 找 LISTENING PID）+ 循环验证端口真正释放。
- **教训**：E2E 报 bug 前先自证测试脚本无罪——计数命令手动跑一遍、环境里有没有
  上一轮的残留实例。假阴性和假阳性同样浪费排查时间。

## 8. worker 线程阻塞在原生调用时：terminate() 杀不死，WM_QUIT 才是正解（v0.12.0 修复）

- `worker_threads` 的 `terminate()` 对**阻塞在原生调用**（如 GetMessageW）的线程
  **无效且 Promise 永久悬挂**——线程不死、系统热键不释放、新 worker 注册必失败
  （ERROR_HOTKEY_ALREADY_REGISTERED=1409）。表现为"改一次配置热键就坏死"。
- 两个深坑：① **Node 的 `Worker.threadId` 是从 0 递增的小整数 id，不是 Win32 线程
  ID**——拿它 `PostThreadMessageW` 静默投错线程；真 tid 必须在线程内
  `GetCurrentThreadId()` 取了上报（本项目走 ready 消息）。
  ② 僵尸 worker 还会收到注入消息并回调——主进程此时 `onTrigger` 已被 stop 置空，
  **静默丢弃**，故障零痕迹。
- 正确姿势：`PostThreadMessage(tid, WM_QUIT)` 让 `GetMessageW` 返回 0、循环自然
  break、事件循环清空、线程自然死亡（热键随之释放）；`terminate()` 只作延迟兜底
  （fire-and-forget 防悬挂），外加意外退出自愈重启（限次防风暴）。
- **教训**：消息循环线程的生死要用自己的消息协议管，别指望运行时强杀；排查"时好
  时坏"先验证假设的 id/句柄到底是不是你以为的那个域（Node id ≠ OS id）。

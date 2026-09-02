// AI 层热键监听线程（worker_threads）：
// RegisterHotKey(NULL, id, mods, vk) 注册的是线程级热键，WM_HOTKEY 投到本线程
// 消息队列——必须在原生 GetMessage 循环里等（Node 主线程没有消息循环）。
// 退出靠主线程 terminate()（线程死亡系统自动解除其全部热键），本文件不处理退出。
// 消息循环内严禁慢操作：WM_HOTKEY 只 postMessage 回主线程，动作在主线程执行。

const { parentPort, workerData } = require('worker_threads');

const WM_HOTKEY = 0x0312;

// koffi 加载失败与「组合键被占用」是两类故障，分开上报，避免排查方向被带偏
let koffi;
try {
  koffi = require('koffi');
} catch (e) {
  parentPort.postMessage({ type: 'koffi-failed', error: e.message });
  process.exit(1);
}

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
// x64 MSG 布局：hwnd(8) message(4)+pad(4) wParam(8) lParam(8) time(4)+pad(4) pt(8)
// POINT 平铺成 x/y 两个字段，内存布局与嵌套 struct 等价。须先于 func 声明定义。
const MSG = koffi.struct('AILAYER_MSG', {
  hwnd: 'void *',
  message: 'uint32',
  wParam: 'uint64',
  lParam: 'int64',
  time: 'uint32',
  x: 'int32',
  y: 'int32',
});
const RegisterHotKey = user32.func('int __stdcall RegisterHotKey(void *, int, uint32, uint32)');
// 结构体指针参数直接传 JS 对象由 koffi marshal（同 actions.js 的 SendInput 用法）。
// GetMessage 往缓冲区里**写**：必须用 koffi.alloc 分配 + koffi.decode 读回，
// 传普通 JS 对象的话写入不回读（永远读到初始值）。
const GetMessageW = user32.func('int __stdcall GetMessageW(AILAYER_MSG *pMsg, void *hWnd, uint32 min, uint32 max)');
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');
// 紧跟失败的 RegisterHotKey 同步调用，中间不切事件循环，线程局部错误码不会被污染
const GetLastError = kernel32.func('uint32 GetLastError()');

const hotkeys = Array.isArray(workerData && workerData.hotkeys) ? workerData.hotkeys : [];

// 竞态自愈：主线程改配置时 stop→start 换 worker，旧线程的热键要等它真正死亡才
// 释放（terminate 是异步的）。窗口期注册会失败——250ms 后对失败项重试一次，
// 此时旧线程必已终止；仍失败才是真的被其他程序占用。
function tryRegister(list) {
  const failed = [];
  for (const h of list) {
    if (!RegisterHotKey(null, h.id, h.mods, h.vk)) failed.push({ ...h, err: GetLastError() });
  }
  return failed;
}
const fmtFailed = list => list.map(f => `${f.key}(GetLastError=${f.err})`);

let failed = tryRegister(hotkeys);

function ready() {
  parentPort.postMessage({ type: 'ready', threadId: GetCurrentThreadId(), failed: fmtFailed(failed) });
}
function enterLoop() {
  if (failed.length >= hotkeys.length) return; // 全部注册失败，没有监听意义
  const buf = koffi.alloc('AILAYER_MSG', 1);
  while (true) {
    const r = GetMessageW(buf, null, 0, 0);
    if (r <= 0) {
      // 0=WM_QUIT，-1=错误。这里提前退出=全部热键悄悄坏死，必须留痕定位
      console.log(`[ailayer-worker] GetMessageW 返回 ${r}（GetLastError=${GetLastError()}），消息循环退出`);
      break;
    }
    const msg = (() => { try { return koffi.decode(buf, 'AILAYER_MSG'); } catch (_) { return null; } })();
    if (msg && msg.message === WM_HOTKEY) {
      parentPort.postMessage({ type: 'hotkey', id: Number(msg.wParam) });
    }
  }
}

if (failed.length) {
  setTimeout(() => {
    failed = tryRegister(failed);
    ready();
    enterLoop();
  }, 250);
} else {
  ready();
  enterLoop();
}

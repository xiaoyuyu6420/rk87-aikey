// 前台应用检测（配置档自动切换的事件源）
// Win：GetForegroundWindow → OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)
//      → QueryFullProcessImageNameW，取 exe 基名小写；koffi FFI，无轮询开销之外的依赖
// mac：降级不支持（CoreFoundation C API 解码链路重，本版本 mac 仅手动切档，UI 有提示）
// 规则匹配在 index.js 侧做，本模块只报「前台进程名变化」。
// 1s 轮询仅微秒级 API 调用；OpenProcess 失败（提权进程等）跳过本轮，保持上一个进程名，
// 避免权限噪音把状态抖来抖去。

class FgWatcher {
  constructor() {
    this.supported = process.platform === 'win32';
    this.timer = null;
    this.lastProc = null;   // 当前认知的前台进程名（exe 基名小写）
    this.onChange = null;   // (proc, prev)
    if (this.supported) this._init();
  }

  _init() {
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const kernel32 = koffi.load('kernel32.dll');
      this._getFg = user32.func('void *GetForegroundWindow()');
      this._getPid = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *, void *)');
      this._open = kernel32.func('void *OpenProcess(uint32, int, uint32)');
      this._qname = kernel32.func('int __stdcall QueryFullProcessImageNameW(void *, uint32, void *, void *)');
      this._close = kernel32.func('int CloseHandle(void *)');
      this._pidBuf = koffi.alloc('uint32_t');
      this._nameBuf = koffi.alloc('uint16_t[512]');
      this._sizeBuf = koffi.alloc('uint32_t');
    } catch (_) {
      this.supported = false;
    }
  }

  // 取当前前台进程名；失败返回 null（调用方保持原状态）
  currentProcess() {
    if (!this.supported) return null;
    try {
      const koffi = require('koffi');
      const hwnd = this._getFg();
      if (!hwnd) return null;
      koffi.encode(this._pidBuf, 'uint32_t', 0);
      this._getPid(hwnd, this._pidBuf);
      const pid = koffi.decode(this._pidBuf, 'uint32_t');
      if (!pid) return null;
      const h = this._open(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid);
      if (!h) return null;
      koffi.encode(this._sizeBuf, 'uint32_t', 512);
      const ok = this._qname(h, 0, this._nameBuf, this._sizeBuf);
      this._close(h);
      if (!ok) return null;
      const arr = koffi.decode(this._nameBuf, 'uint16_t[512]');
      const zero = arr.indexOf(0);
      const full = String.fromCharCode.apply(null, zero >= 0 ? arr.slice(0, zero) : arr);
      return (full.split(/[\\/]/).pop() || '').toLowerCase();
    } catch (_) {
      return null;
    }
  }

  start() {
    if (!this.supported || this.timer) return false;
    this.lastProc = this.currentProcess(); // 建基线：启动时已在前台的进程不触发切换
    this.timer = setInterval(() => this.tick(), 1000);
    return true;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.lastProc = null;
  }

  tick() {
    const proc = this.currentProcess();
    if (proc === null || proc === this.lastProc) return;
    const prev = this.lastProc;
    this.lastProc = proc;
    if (this.onChange) {
      try { this.onChange(proc, prev); } catch (_) { /* 回调异常不中断轮询 */ }
    }
  }
}

module.exports = { FgWatcher };

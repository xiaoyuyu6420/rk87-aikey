// RNNoise 语音降噪器：直载 vendor/rnnoise/rnnoise.wasm，绕开官方 ESM glue
// （Electron 主进程 CJS 无法 require(import.meta.url) 模块；直接实例化 wasm 零打包风险）
// RNNoise 固定 48kHz / 480 样本帧（10ms），processFrame 返回 { out, vad }
// vad ∈ [0,1] 为语音活动概率，供上层做门控 AGC

const path = require('path');

const WASM_PATH = path.join(__dirname, '../../vendor/rnnoise/rnnoise.wasm');

class Denoiser {
  constructor() {
    this.ready = false;
    this.frameSize = 480;
    this._st = null;
    this._pin = 0;
    this._pout = 0;
    this._fin = null;
    this._fout = null;
    this._mem = null;
  }

  async init() {
    if (this.ready) return true;
    const bytes = require('fs').readFileSync(WASM_PATH);
    // wasm 自身仅需 env.a.{a:grow_memory, b:memcpy} 两个辅助导入；
    // RNNoise 状态很小实测不触发内存增长，grow 走保守实现
    let exports = null, view = null;
    const imports = { a: {
      b: (dest, src, num) => { view.copyWithin(dest >>> 0, src >>> 0, (src + num) >>> 0); },
      a: (requested) => {
        const pages = (requested + 65535) >> 16;
        const before = exports.c.buffer.byteLength;
        exports.c.grow(pages);
        view = new Uint8Array(exports.c.buffer);
        return before >> 16;
      },
    }};
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    const e = instance.exports;
    exports = e;
    view = new Uint8Array(e.c.buffer);
    e.d(); // __wasm_call_ctors
    this.frameSize = e.f(); // rnnoise_get_frame_size → 480
    this._st = e.h(0); // rnnoise_create(NULL=默认模型)，内部自带 init
    if (!this._st) throw new Error('rnnoise_create 失败');
    this._pin = e.l(this.frameSize * 4);
    this._pout = e.l(this.frameSize * 4);
    this._fin = new Float32Array(e.c.buffer, this._pin, this.frameSize);
    this._fout = new Float32Array(e.c.buffer, this._pout, this.frameSize);
    this._exports = e;
    this.ready = true;
    return true;
  }

  // 输入 Float32Array(480)，输出原地写入并返回 { out, vad }
  processFrame(input) {
    this._fin.set(input);
    const vad = this._exports.k(this._st, this._pout, this._pin);
    return { out: this._fout, vad };
  }

  destroy() {
    if (!this.ready) return;
    try { this._exports.i(this._st); this._exports.j(this._pin); this._exports.j(this._pout); } catch (_) {}
    this.ready = false;
  }
}

module.exports = { Denoiser };

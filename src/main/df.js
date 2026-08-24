// DeepFilterNet3 语音增强：koffi FFI 调 vendor/deep-filter/df.dll（Rust libDF C API）
// 模型：vendor/deep-filter/model/（DFN3 ONNX 导出），48kHz / hop 480 / 前瞻 2 帧 ≈ 30ms 算法延迟
// processFrame(Float32Array(480)) 原地增强，返回当前帧局部 SNR(dB) 可作 VAD 信号

const path = require('path');

const DLL_PATH = path.join(__dirname, '../../vendor/deep-filter/df.dll');
const MODEL_PATH = path.join(__dirname, '../../vendor/deep-filter/model/model.tar.gz');

class DeepFilter {
  constructor() {
    this.ready = false;
    this.frameLen = 480;
    this._st = null;
    this._in = null;
    this._out = null;
  }

  // attenLimDb：最大衰减限制（dB）。越小降噪越保守；null 用默认 6dB
  init(attenLimDb = 6) {
    if (this.ready) return true;
    // df_create 对坏路径会原生 panic 直接杀进程——先自行校验文件存在
    const fs = require('fs');
    if (!fs.existsSync(DLL_PATH)) throw new Error('缺少 ' + DLL_PATH);
    if (!fs.existsSync(MODEL_PATH)) throw new Error('缺少模型 ' + MODEL_PATH);

    const koffi = require('koffi');
    const lib = koffi.load(DLL_PATH);
    this._create = lib.func('void* df_create(const char* path, float atten_lim, const char* log_level)');
    this._frameLenFn = lib.func('unsigned long long df_get_frame_length(void* st)');
    this._process = lib.func('float df_process_frame(void* st, float* input, float* output)');
    this._setAtten = lib.func('void df_set_atten_lim(void* st, float lim_db)');
    this._free = lib.func('void df_free(void* st)');

    this._st = this._create(MODEL_PATH, attenLimDb, null);
    if (!this._st) throw new Error('df_create 失败（模型加载错误）');
    this.frameLen = Number(this._frameLenFn(this._st));
    // 帧长校验：stub 环境/异常返回下避免分配出坏缓冲
    if (!Number.isInteger(this.frameLen) || this.frameLen < 120 || this.frameLen > 4096) {
      throw new Error('df_get_frame_length 异常: ' + this.frameLen);
    }
    this._in = new Float32Array(this.frameLen);
    this._out = new Float32Array(this.frameLen);
    this.ready = true;
    return true;
  }

  // 输入输出同一 Float32Array(480)，原地替换为增强后音频；返回局部 SNR dB
  processFrame(f48) {
    this._in.set(f48);
    const snr = this._process(this._st, this._in, this._out);
    f48.set(this._out);
    return snr;
  }

  destroy() {
    if (!this.ready) return;
    try { this._free(this._st); } catch (_) {}
    this.ready = false;
  }
}

module.exports = { DeepFilter };

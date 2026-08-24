// 键盘麦克风管线：HID 音频报文 → (SBC 解码 | PCM 直通) → DSP 增强链 → PCM 输出
// DSP 链（2026-08-24 重构，标定依据见 tools/audio-analysis.js）：
//   1. 4 阶高通 100Hz——实测 86% 底噪能量 <125Hz，旧一阶 6dB/oct 挡不住
//   2. RNNoise 神经降噪（48kHz 域，16k↔48k 线性重采样）+ 附带 VAD 概率
//   3. VAD 门控 AGC：旧版在纯噪段也拉增益把底噪放大至 8×（实测底噪 RMS≈161
//      高于旧门限 90，噪声门从不生效）——现在只有语音段才升增益
//   4. 自适应噪声门 + tanh 软限幅（替代硬 clamp 削波）
//
// 音频报文格式（实测确认）：
//   蓝牙 [0x1B, seq, ...60B 净荷]：净荷 = 3 × 20B SBC 小帧 → 每报文 240 样本 @16kHz
//   USB   [0x1C, seq, 2B, 30×int16LE]：原始 PCM 直出，免解码

const { Denoiser } = require('./denoise');
const { DeepFilter } = require('./df');

function init(mod) { mod.init(); return mod; }

function loadDecoder() {
  if (loadDecoder._cache) return loadDecoder._cache;
  let mod;
  if (process.platform === 'win32') {
    mod = init(require('../../vendor/mi-sbc/prebuilds/sbc-win32-x64/node-napi-v4.node'));
  } else if (process.platform === 'darwin') {
    mod = process.arch === 'arm64'
      ? init(require('../../vendor/mi-sbc/prebuilds/sbc-darwin-arm64/node-napi-v4.node'))
      : init(require('../../vendor/mi-sbc/prebuilds/sbc-darwin-x64/node-napi-v4.node'));
  } else {
    mod = process.arch === 'arm64'
      ? init(require('../../vendor/mi-sbc/prebuilds/sbc-linux-arm64/node-napi-v4.node'))
      : init(require('../../vendor/mi-sbc/prebuilds/sbc-linux-x64/node-napi-v4.node'));
  }
  loadDecoder._cache = mod;
  return mod;
}

// ---- RBJ cookbook 二阶高通（Q=0.707 Butterworth），两级级联 = 4 阶 24dB/oct ----
function highpassCoeffs(fs, f0, q = Math.SQRT1_2) {
  const w0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cw = Math.cos(w0);
  const b0 = ((1 + cw) / 2), b1 = -(1 + cw), b2 = ((1 + cw) / 2);
  const A0 = 1 + alpha, A1 = -2 * cw, A2 = 1 - alpha;
  return { b0: b0 / A0, b1: b1 / A0, b2: b2 / A0, a1: A1 / A0, a2: A2 / A0 };
}

class Biquad {
  constructor(c) { this.c = c; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  process(x) {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const BLOCK = 160; // 处理块长：10ms @16kHz → ×3 = 480 样本 @48kHz（RNNoise 帧长）
const FIFO_CAP = 16000; // 1s 上限防积压

class MicPipeline {
  constructor(opts = {}) {
    this.dec = loadDecoder();
    this.dstBuf = Buffer.alloc(160);
    this.srcBuf = Buffer.alloc(23);
    this.denoiseWanted = opts.denoise !== false;

    this.hp1 = new Biquad(highpassCoeffs(16000, 100));
    this.hp2 = new Biquad(highpassCoeffs(16000, 100));
    // 降噪引擎：DFN3 主力，RNNoise 兜底（dll/模型缺失时自动降级）
    this.df = new DeepFilter();
    this.rnnoise = new Denoiser();
    this.engine = null; // 'df' | 'rnnoise' | null
    this.denoiseFailLogged = false;

    // 样本 FIFO（16k 域 float32）
    this.fifo = new Float32Array(FIFO_CAP);
    this.fifoLen = 0;

    // AGC/门控状态
    this.gain = 1;
    this.gate = 1;
    this.noiseFloor = 150;   // 实测键盘麦环境底噪 RMS≈161，取近似初值自适应收敛
    this.lastUp = 0;         // 重采样连续性
    this.compEnv = 0;        // 压缩器包络
    // 统计（供 UI 电平显示）
    this.level = 0;
    this.packets = 0;
    this.vad = 0;
  }

  // wasm/ffi 初始化：boot 时预热；未就绪期间自动旁路降噪（其余 DSP 照常）
  async initDenoiser() {
    if (!this.denoiseWanted) return null;
    if (this.engine) return this.engine;
    try {
      this.df.init();
      this.engine = 'df';
      return 'df';
    } catch (e) {
      console.log('[mic] DFN3 初始化失败，回退 RNNoise:', e.message);
    }
    try {
      await this.rnnoise.init();
      this.engine = 'rnnoise';
      return 'rnnoise';
    } catch (e) {
      console.log('[mic] RNNoise 初始化失败，降噪旁路:', e.message);
    }
    return null;
  }

  // 蓝牙口：SBC 解码 240 样本进链
  pushPacket(pkt) {
    this.packets++;
    const pcm = new Int16Array(240);
    let w = 0;
    for (let f = 0; f < 3; f++) {
      this.srcBuf[0] = 0xad; this.srcBuf[1] = 0x31; this.srcBuf[2] = 0x0c;
      pkt.copy(this.srcBuf, 3, 2 + f * 20, 2 + f * 20 + 20);
      const n = this.dec.decode(this.srcBuf, 23, this.dstBuf);
      for (let i = 0; i < n && w < 240; i++) pcm[w++] = this.dstBuf.readInt16LE(i * 2);
    }
    while (w < 240) pcm[w++] = 0;
    return this.feed(pcm, w);
  }

  // USB 口：30 样本原始 PCM 进链
  pushWiredFrame(frame) {
    this.packets++;
    const pcm = new Int16Array(30);
    let w = 0;
    for (let o = 4; o + 1 < frame.length && w < 30; o += 2) pcm[w++] = frame.readInt16LE(o);
    return this.feed(pcm, w);
  }

  // 进 FIFO 并按块处理；返回本次产出的 int16 PCM Buffer（可能为空）
  feed(samples, n) {
    for (let i = 0; i < n; i++) {
      if (this.fifoLen >= FIFO_CAP) break; // 积压保护：丢新保旧
      this.fifo[this.fifoLen++] = samples[i];
    }
    let outs = [];
    while (this.fifoLen >= BLOCK) {
      const blk = this.fifo.slice(0, BLOCK);
      this.fifo.copyWithin(0, BLOCK, this.fifoLen);
      this.fifoLen -= BLOCK;
      outs.push(this.processBlock(blk));
    }
    if (!outs.length) return Buffer.alloc(0);
    return outs.length === 1 ? outs[0] : Buffer.concat(outs);
  }

  processBlock(blk) {
    // 1) 陡高通（16k 域）
    for (let i = 0; i < BLOCK; i++) blk[i] = this.hp2.process(this.hp1.process(blk[i]));

    // 2) 升采样 ×3 → DFN3/RNNoise 降噪（原地写回）→ 取中点降采样
    if (this.engine) this._denoiseBlock(blk);

    // 3) VAD 门控 + AGC + 压缩器 + 软限幅（16k 域逐样本状态机，块间无缝）
    return this._gateAgc(blk);
  }

  _denoiseBlock(blk) {
    // 升采样 ×3（线性插值）到 48kHz 域
    const up48 = new Float32Array(BLOCK * 3);
    let idx = 0, prev = this.lastUp;
    for (let i = 0; i < BLOCK; i++) {
      const x = blk[i];
      up48[idx++] = prev + (x - prev) / 3;
      up48[idx++] = prev + (x - prev) * 2 / 3;
      up48[idx++] = x;
      prev = x;
    }
    this.lastUp = prev;
    try {
      let vad;
      if (this.engine === 'df') {
        const snr = this.df.processFrame(up48);
        vad = Math.max(0, Math.min(1, snr / 10)); // 局部 SNR 10dB 以上视为语音
      } else {
        const r = this.rnnoise.processFrame(up48);
        vad = r.vad;
      }
      // 降采样 ÷3：取中点样本。均值滤波会在 8k 处吃掉 ~3.5dB（s/sh 辅音能量区），
      // 源信号本就无 >8k 分量，无需抗混叠均值
      for (let i = 0; i < BLOCK; i++) blk[i] = up48[i * 3 + 1];
      this.vad = this.vad * 0.5 + vad * 0.5;
    } catch (e) {
      if (!this.denoiseFailLogged) {
        this.denoiseFailLogged = true;
        console.log('[mic] 降噪帧处理异常，旁路:', e.stack || e.message);
      }
    }
  }

  _gateAgc(blk) {
    let sumSq = 0;
    for (let i = 0; i < BLOCK; i++) sumSq += blk[i] * blk[i];
    const rms = Math.sqrt(sumSq / BLOCK);

    // VAD：优先用降噪引擎的语音概率（DFN=局部SNR映射 / RNNoise=原生VAD），
    // 未就绪时退化为底噪倍数启发式
    const speech = this.engine
      ? this.vad > 0.55 || rms > this.noiseFloor * 5
      : rms > this.noiseFloor * 5;

    // 底噪跟踪：只在非语音段收敛
    if (!speech && rms > 20) this.noiseFloor += (rms - this.noiseFloor) * 0.03;

    // 门控：语音开、静音压到 -26dB；attack 快 release 慢不切字头尾
    const gTarget = speech ? 1 : (rms > this.noiseFloor * 4 ? 1 : 0.05);
    this.gate += (gTarget - this.gate) * (gTarget > this.gate ? 0.5 : 0.04);

    // AGC：仅语音段追目标响度；静音段增益缓慢回 1（不再放大底噪）
    if (speech && rms > 50) {
      const target = Math.min(8, Math.max(1, 4200 / rms));
      this.gain += (target - this.gain) * 0.25;
    } else if (!speech) {
      this.gain += (1 - this.gain) * 0.02;
    }

    const k = this.gain * this.gate;
    // 压缩器参数（16k 域）：阈值 -14dBFS≈4000，2.5:1，attack 4ms / release 60ms
    const atk = 1 - Math.exp(-1 / (0.004 * 16000));
    const rel = 1 - Math.exp(-1 / (0.06 * 16000));
    for (let i = 0; i < BLOCK; i++) {
      let v = blk[i] * k;
      // 包络压缩：让送进识别引擎的电平平稳（ASR 对动态范围敏感）
      const a = Math.abs(v);
      this.compEnv += (a - this.compEnv) * (a > this.compEnv ? atk : rel);
      if (this.compEnv > 4000) v *= Math.pow(4000 / this.compEnv, 1 - 1 / 2.5);
      // 软膝限幅：22k 以上渐进压缩，替代硬 clamp 的爆音失真
      const m = Math.abs(v);
      if (m > 22000) v = Math.sign(v) * (22000 + (m - 22000) / (1 + (m - 22000) / 3000));
      blk[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
    }

    const outRms = Math.sqrt(blk.reduce((s, v) => s + v * v, 0) / BLOCK);
    this.level = this.level * 0.7 + outRms * 0.3;
    const buf = Buffer.alloc(BLOCK * 2);
    for (let i = 0; i < BLOCK; i++) buf.writeInt16LE(Math.round(blk[i]), i * 2);
    return buf;
  }
}

module.exports = { MicPipeline, loadDecoder };

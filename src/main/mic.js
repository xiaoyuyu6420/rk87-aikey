// 键盘麦克风管线：HID 音频报文 → mi-sbc 官方解码器 → PCM 后处理（AGC/高通/噪声门）
// 音频报文格式（实测确认）：[0x1B(reportId), seq, ...60B 净荷]，净荷 = 3 × 20B 小帧
// 每小帧配 3B 帧头（AD 31 0C）喂解码器 → 80 样本 int16，每报文 240 样本 = 15ms @16kHz

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

// 一阶高通 120Hz @16kHz
const HP_ALPHA = 1 / (1 + 2 * Math.PI * 120 / 16000);

class MicPipeline {
  constructor() {
    this.dec = loadDecoder();
    this.dstBuf = Buffer.alloc(160);
    this.srcBuf = Buffer.alloc(23);
    // 后处理状态
    this.hpPrevIn = 0;
    this.hpPrevOut = 0;
    this.gain = 1;
    // 统计（供 UI 电平显示）
    this.level = 0;
    this.packets = 0;
  }

  // 输入一个 62 字节音频报文，返回 240 样本 PCM（Buffer, int16 LE）
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

    // ---- 后处理：高通 → AGC → 噪声门 ----
    let sumSq = 0;
    for (let i = 0; i < 240; i++) {
      const x = pcm[i];
      const y = HP_ALPHA * (this.hpPrevOut + x - this.hpPrevIn);
      this.hpPrevIn = x; this.hpPrevOut = y;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(y)));
      sumSq += pcm[i] * pcm[i];
    }
    const rms = Math.sqrt(sumSq / 240);
    this.level = this.level * 0.7 + rms * 0.3;

    if (rms > 100) {
      // 目标 RMS ≈4500（-17dBFS），增益限制 [1, 8] 平滑跟随
      const target = Math.min(8, Math.max(1, 4500 / rms));
      this.gain += (target - this.gain) * 0.08;
    } else if (rms < 90) {
      // 噪声门：静音段缓退增益，不放大底噪
      this.gain = Math.max(1, this.gain * 0.97);
    }

    if (this.gain > 1.02) {
      for (let i = 0; i < 240; i++) {
        const v = pcm[i] * this.gain;
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
      }
    }

    return Buffer.from(pcm.buffer);
  }
}

module.exports = { MicPipeline, loadDecoder };

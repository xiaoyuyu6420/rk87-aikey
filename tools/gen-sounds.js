// 生成打字音效采样（程序合成，自产 CC0，无下载依赖、无版权问题）
// 用法：node tools/gen-sounds.js → assets/sounds/{blue,membrane,typewriter}-N.wav
// 每套 3 个变体（参数微扰），播放端随机抽取 + playbackRate 微扰，避免机关枪感。

const fs = require('fs');
const path = require('path');

const SR = 44100;

function writeWav(file, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

// 指数衰减正弦（频率轻微下滑更有打击感）
function tone(sec, f, tau) {
  const n = Math.round(sec * SR);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const freq = f * (1 - 0.04 * Math.min(1, t / (sec / 2)));
    phase += 2 * Math.PI * freq / SR;
    out[i] = Math.sin(phase) * Math.exp(-t / tau);
  }
  return out;
}

// 单极点低通噪声突发（lp 越小越闷）
function burst(sec, tau, lp = 4) {
  const n = Math.round(sec * SR);
  let acc = 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    acc += ((Math.random() * 2 - 1) - acc) / lp;
    out[i] = acc * Math.exp(-t / tau) * 3;
  }
  return out;
}

function mixAt(dst, src, atSec, gain) {
  const off = Math.round(atSec * SR);
  for (let i = 0; i < src.length && off + i < dst.length; i++) dst[off + i] += src[i] * gain;
}

function normalize(samples) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.9 / peak : 1;
  const out = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g;
  return out;
}

// 青轴：高频咔哒 + 谐振 + 低频 thock 底
function blue(v) {
  const out = new Float64Array(Math.round(SR * 0.09));
  mixAt(out, burst(0.028, 0.008 + v * 0.002, 2), 0, 0.9);
  mixAt(out, tone(0.05, 5800 + v * 350, 0.004), 0, 0.3);
  mixAt(out, tone(0.09, 128 + v * 6, 0.02), 0.002, 0.85);
  return normalize(out);
}

// 薄膜：软糯低频，几乎无 click
function membrane(v) {
  const out = new Float64Array(Math.round(SR * 0.12));
  mixAt(out, tone(0.12, 185 + v * 10, 0.035), 0, 0.95);
  mixAt(out, tone(0.08, 370 + v * 20, 0.02), 0, 0.35);
  mixAt(out, burst(0.02, 0.006, 8), 0, 0.3);
  return normalize(out);
}

// 打字机：双击咔哒 + 金属余音
function typewriter(v) {
  const out = new Float64Array(Math.round(SR * 0.14));
  const gap = 0.026 + v * 0.004;
  mixAt(out, burst(0.02, 0.004, 3), 0, 1.0);
  mixAt(out, tone(0.03, 2500 + v * 120, 0.003), 0, 0.3);
  mixAt(out, burst(0.02, 0.004, 3), gap, 0.8);
  mixAt(out, tone(0.03, 2100 + v * 100, 0.003), gap, 0.25);
  mixAt(out, tone(0.12, 3400 + v * 200, 0.03), 0, 0.22); // 金属铃余音
  return normalize(out);
}

const dir = path.join(__dirname, '..', 'assets', 'sounds');
fs.mkdirSync(dir, { recursive: true });
const packs = { blue, membrane, typewriter };
let count = 0;
for (const [name, gen] of Object.entries(packs)) {
  for (let v = 0; v < 3; v++) {
    const file = path.join(dir, `${name}-${v + 1}.wav`);
    writeWav(file, gen(v));
    count++;
    console.log('生成', file);
  }
}
console.log(`共 ${count} 个采样`);

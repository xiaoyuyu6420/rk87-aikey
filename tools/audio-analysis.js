// 分析桌面标定 WAV：底噪水平、频谱分布 → 判断降噪/增强空间
const fs = require('fs');
const file = process.argv[2] || 'sample.wav';
const buf = fs.readFileSync(file);
const n = (buf.length - 44) >> 1;
const x = new Int16Array(n);
for (let i = 0; i < n; i++) x[i] = buf.readInt16LE(44 + i * 2);

// 分块 RMS（10ms=160样本）
const blocks = [];
for (let i = 0; i + 160 <= n; i += 160) {
  let s = 0;
  for (let j = 0; j < 160; j++) s += x[i + j] * x[i + j];
  blocks.push(Math.sqrt(s / 160));
}
blocks.sort((a, b) => a - b);
const pct = p => blocks[Math.floor(blocks.length * p)] || 0;
console.log(`时长 ${(n / 16000).toFixed(1)}s，块数 ${blocks.length}`);
console.log(`RMS 分位：p10=${pct(0.1).toFixed(0)} p50=${pct(0.5).toFixed(0)} p90=${pct(0.9).toFixed(0)} max=${blocks[blocks.length - 1].toFixed(0)}`);

// 简易频谱：对整段做分帧 DFT（256点，跳步128），统计 8 个频带能量占比
const bands = [[0,125],[125,250],[250,500],[500,1000],[1000,2000],[2000,4000],[4000,8000]];
const bandE = new Array(bands.length).fill(0);
const N = 256;
const cosT = [], sinT = [];
let frames = 0;
for (let off = 0; off + N <= n; off += 128) {
  // 汉宁窗后的 Goertzel 式逐频点太慢；改用粗略零交叉+带能估计：
  // 直接计算每个频带中心频率的 Goertzel 幅值平方
  for (let b = 0; b < bands.length; b++) {
    const f = Math.sqrt(bands[b][0] * bands[b][1]) || bands[b][1] / 2;
    const k = Math.round(2 * Math.PI * f / 16000 * 1000) / 1000;
    let c = 0, s = 0;
    const wk = 2 * Math.PI * f / 16000;
    const cw = Math.cos(wk), sw = Math.sin(wk);
    let coef = 2 * cw;
    let q0 = 0, q1 = 0, q2 = 0;
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); // hanning
      q0 = w * x[off + i] + coef * q1 - q2;
      q2 = q1; q1 = q0;
    }
    const mag = q1 * q1 + q2 * q2 - coef * q1 * q2;
    bandE[b] += mag;
  }
  frames++;
}
const total = bandE.reduce((a, b) => a + b, 0);
console.log('\n频带能量占比（环境底噪的频谱形状）:');
bands.forEach(([lo, hi], i) => {
  console.log(`  ${String(lo).padStart(4)}-${String(hi).padStart(4)}Hz: ${(bandE[i] / total * 100).toFixed(1)}%`);
});

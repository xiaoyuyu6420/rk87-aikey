// 生成 512x512 应用图标 PNG（圆角深蓝底 + 键帽方块图案；mac 构建要求 ≥512）
const zlib = require('zlib');
const fs = require('fs');

function crc32(buf) {
  let c; const t = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  let r = 0xffffffff;
  for (const b of buf) r = t[(r ^ b) & 0xff] ^ (r >>> 8);
  return (r ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const S = 512, R = 96;
function pixel(x, y) {
  // 圆角矩形判定
  const x0 = 0, y0 = 0, x1 = S - 1, y1 = S - 1, r = R;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  // 背景：深蓝纵向渐变
  const g = Math.round(16 + (y / S) * 16);
  let r0 = g, g0 = g + 10, b0 = g + 38;
  // 图案：3x2 键帽方块，右下偏亮
  const bw = 68, gap = 28;
  const ox = (S - (3 * bw + 2 * gap)) / 2;
  const oy = (S - (2 * bw + gap)) / 2;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      const bx = ox + i * (bw + gap), by = oy + j * (bw + gap);
      if (x >= bx && x < bx + bw && y >= by && y < by + bw) {
        const hi = (x + y) / S > 0.55;
        r0 = hi ? 96 : 79;
        g0 = hi ? 160 : 140;
        b0 = 255;
      }
    }
  }
  return [r0, g0, b0];
}

const raw = Buffer.alloc(S * (1 + S * 3));
for (let y = 0; y < S; y++) {
  raw[y * (1 + S * 3)] = 0;
  for (let x = 0; x < S; x++) {
    const c = pixel(x, y);
    const i = y * (1 + S * 3) + 1 + x * 3;
    if (c) { raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; }
    else { raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; }
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync('assets/icon.png', png);
console.log('icon 512x512 OK', png.length, 'bytes');

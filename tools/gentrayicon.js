// 生成 22x22 菜单栏 template 图标（黑色 3x2 键帽 + 透明底，RGBA）
// 用法: node tools/gentrayicon.js   （配合 setTemplateImage(true)，深浅菜单栏自适应）
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

const S = 22;
// 3x2 键帽，圆角方块，内容居中占 ~18px
const bw = 5, gap = 1.5, rows = 2, cols = 3;
const gw = cols * bw + (cols - 1) * gap;
const gh = rows * bw + (rows - 1) * gap;
const ox = (S - gw) / 2, oy = (S - gh) / 2;

function inKey(x, y) {
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const bx = ox + i * (bw + gap), by = oy + j * (bw + gap);
      // 1px 圆角：切掉四角
      const dx = Math.min(x - bx, bx + bw - 1 - x);
      const dy = Math.min(y - by, by + bw - 1 - y);
      if (x >= bx && x < bx + bw && y >= by && y < by + bw && (dx >= 1 || dy >= 1)) return true;
    }
  }
  return false;
}

const raw = Buffer.alloc(S * (1 + S * 4));
for (let y = 0; y < S; y++) {
  raw[y * (1 + S * 4)] = 0;
  for (let x = 0; x < S; x++) {
    const i = y * (1 + S * 4) + 1 + x * 4;
    if (inKey(x, y)) { raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 255; }
    // 其余保持全 0（透明）
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync('assets/trayTemplate.png', png);
console.log('trayTemplate 22x22 OK', png.length, 'bytes');

// 实测：有线口(8102 Col02)写命令是否真的零回应
// 依次试 4 种帧格式发心跳 cmd=5，每种等 2.5s 看回应（104 或任何非音频帧）
const HID = require('node-hid');

const VID = 0x248a;
const devs = HID.devices().filter(d => d.vendorId === VID && d.usagePage === 0xff12);
const wired = devs.find(d => d.productId === 0x8102);
if (!wired) { console.log('WIRED INTERFACE NOT FOUND'); process.exit(1); }

const dev = new HID.HID(wired.path);
console.log('[wired] 已打开', wired.path.slice(0, 60));

let audioCount = 0;
dev.on('data', data => {
  if (data[0] === 0x1b) { audioCount++; return; } // 音频帧静默计数
  const t = ((Date.now() - T0) / 1000).toFixed(2);
  console.log(`[${t}s] <- 收到! reportId=0x${data[0].toString(16)} hex=${data.slice(0, 16).toString('hex')}`);
});
dev.on('error', e => console.log('[err]', e.message));

const variants = [
  { name: '通道0 [05 FE C0]', make: () => Buffer.from([0x05, 0xfe, 0xc0, 0x05, 0x00, 0xef]) },
  { name: 'F1前缀 [05 FF F1 FE C0]', make: () => Buffer.from([0x05, 0xff, 0xf1, 0xfe, 0xc0, 0x05, 0x00, 0xef]) },
  { name: 'F0前缀 [05 FF F0 FE C0]', make: () => Buffer.from([0x05, 0xff, 0xf0, 0xfe, 0xc0, 0x05, 0x00, 0xef]) },
];

const T0 = Date.now();
(async () => {
  for (const v of variants) {
    // 62B 与 64B 两种长度都试
    for (const pad of [62, 64]) {
      let buf = v.make();
      if (buf.length < pad) buf = Buffer.concat([buf, Buffer.alloc(pad - buf.length)]);
      const t = ((Date.now() - T0) / 1000).toFixed(2);
      try {
        const n = dev.write(buf);
        console.log(`[${t}s] -> ${v.name} len=${pad} write=${n}`);
      } catch (e) {
        console.log(`[${t}s] -> ${v.name} len=${pad} FAIL: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2500));
    }
  }
  const t = ((Date.now() - T0) / 1000).toFixed(2);
  console.log(`\n[${t}s] 测试结束。期间收到音频帧=${audioCount}，命令回应见上行`);
  try { dev.close(); } catch (_) {}
  process.exit(0);
})();

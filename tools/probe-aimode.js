// AI 模式初始状态探针（诊断用，只读：握手 + cmd=12 查询，不开麦不发写命令）
// 目标：① 握手/连接期固件是否主动推 cmd=209；② cmd=156 回应的完整字节
// （现解析只用到 [0..10]，模式位若存在应在 [11+]）；③ 静默期其他帧分布。
const HID = require('node-hid');

const VID = 0x248a;
const LISTEN_MS = 40000;
const t0 = Date.now();
const t = () => ((Date.now() - t0) / 1000).toFixed(2);

function frame(cmd, data = []) {
  const arr = [0x05, 0xff, 0xf1, 0xfe, 0xc0, cmd, data.length];
  data.forEach(b => arr.push(b));
  arr.push(0xef);
  const buf = Buffer.from(arr);
  return buf.length < 64 ? Buffer.concat([buf, Buffer.alloc(64 - buf.length)]) : buf;
}

for (const pid of [0x8102, 0x8243]) {
  const infos = HID.devices().filter(d => d.vendorId === VID && d.productId === pid && d.usagePage === 0xff12);
  if (!infos.length) { console.log(`[pid=0x${pid.toString(16)}] 不存在`); continue; }
  for (const info of infos) {
    let dev;
    try { dev = new HID.HID(info.path); } catch (e) { console.log(`[pid=0x${pid.toString(16)}] 打开失败: ${e.message}`); continue; }
    console.log(`\n===== pid=0x${pid.toString(16)} interface=${info.interface} 监听中（${LISTEN_MS / 1000}s，请勿按键）=====`);
    let got104 = false, got156 = false;
    dev.on('data', data => {
      if (data[0] === 0x1b || data[0] === 0x1c) return; // 音频帧
      const cmd = data[5], len = data[6];
      if (cmd === 104 && got104) return; // 心跳刷屏
      const hex = data.slice(5, Math.min(9 + len, 40)).toString('hex');
      console.log(`[${t()}s] <- cmd=${cmd} len=${len} hex=${hex}`);
      if (cmd === 104 && !got104) {
        got104 = true;
        dev.write(frame(5)); // 先补一拍心跳再查询
        setTimeout(() => { try { dev.write(frame(12)); console.log(`[${t()}s] -> cmd=12 设备状态查询`); } catch (_) {} }, 200);
        const e = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
        setTimeout(() => { try { dev.write(frame(15, e)); console.log(`[${t()}s] -> cmd=15 验证`); } catch (_) {} }, 350);
        setTimeout(() => { try { dev.write(frame(17)); console.log(`[${t()}s] -> cmd=17 SN查询`); } catch (_) {} }, 500);
        setTimeout(() => { try { dev.write(frame(1)); console.log(`[${t()}s] -> cmd=1 open`); } catch (_) {} }, 650);
      }
      if (cmd === 156 && !got156) {
        got156 = true;
        console.log(`[${t()}s] *** cmd=156 完整 64 字节：${data.toString('hex')} ***`);
      }
    });
    dev.on('error', e => console.log(`[pid=0x${pid.toString(16)}] 错误: ${e.message}`));
    setInterval(() => { try { dev.write(frame(5)); } catch (_) {} }, 1000); // 保活
    setTimeout(() => { try { dev.close(); } catch (_) {} }, LISTEN_MS);
  }
}
setTimeout(() => process.exit(0), LISTEN_MS + 1500);

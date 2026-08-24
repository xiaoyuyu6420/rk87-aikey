// USB 口(8102) 完整会话实测：0xF1 通道握手 + 主动开麦（独立于 app 运行，可用于标定）
// 2026-08-24 用此脚本确认：心跳5→104、验证→227、开麦3→106、音频 0x1C/64B PCM、关麦4
// 关联探针：wired-probe.js（通道前缀标定：F1 有回应，F0/通道0 零回应）
const HID = require('node-hid');

const VID = 0x248a;
const devs = HID.devices().filter(d => d.vendorId === VID && d.usagePage === 0xff12);
const wired = devs.find(d => d.productId === 0x8102);
if (!wired) { console.log('WIRED NOT FOUND'); process.exit(1); }

const dev = new HID.HID(wired.path);
console.log('[wired] 已打开');

const t0 = Date.now();
const t = () => ((Date.now() - t0) / 1000).toFixed(2);
let got104 = false, verified = false, audioPkts = 0, micOpened = false;

function frame(cmd, data = []) {
  const arr = [0x05, 0xff, 0xf1, 0xfe, 0xc0, cmd, data.length];
  data.forEach(b => arr.push(b));
  arr.push(0xef);
  const buf = Buffer.from(arr);
  return buf.length < 64 ? Buffer.concat([buf, Buffer.alloc(64 - buf.length)]) : buf;
}
function w(cmd, data, tag) {
  try {
    dev.write(frame(cmd, data));
    console.log(`[${t()}s] -> ${tag}`);
  } catch (e) { console.log(`[${t()}s] -> ${tag} FAIL: ${e.message}`); }
}

dev.on('data', data => {
  // 音频帧：蓝牙口 reportId=0x1B(SBC) / USB 口 reportId=0x1C(16kHz PCM)，64B
  if (data[0] === 0x1b || data[0] === 0x1c) {
    audioPkts++;
    if (audioPkts === 1) console.log(`[${t()}s] *** 音频流开始（reportId=0x${data[0].toString(16)}）***`);
    else if (audioPkts % 500 === 0) console.log(`[${t()}s] 音频=${audioPkts}`);
    return;
  }
  const cmd = data[5];
  const len = data[6];
  if (!(cmd === 104 && got104)) {
    console.log(`[${t()}s] <- cmd=${cmd} len=${len} hex=${data.slice(5, Math.min(9 + len, 24)).toString('hex')}`);
  }
  if (cmd === 104 && !got104) {
    got104 = true;
    w(12, [], 'ask-device-state');
    const e = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
    w(15, e, 'verify');
    setTimeout(() => { if (!verified) console.log(`[${t()}s] !! 4s 内未收到 227 验证回应`); }, 4000);
  }
  if (cmd === 227 && !verified) {
    verified = true;
    console.log(`[${t()}s] ✓✓ 验证通过（227）——有线口完整会话可行！`);
    w(17, [], 'sn');
    setTimeout(() => {
      w(1, [], 'open');
      setTimeout(() => {
        w(3, [], 'ask-voice');
        micOpened = true;
        setTimeout(() => {
          console.log(`[${t()}s] 音频包总数=${audioPkts}${audioPkts > 0 ? ' —— 开麦推流正常' : ' —— 未收到音频'}`);
          w(4, [], 'stop-voice');
          setTimeout(() => { try { dev.close(); } catch (_) {} process.exit(0); }, 2000);
        }, 10000);
      }, 150);
    }, 150);
  }
});
dev.on('error', e => console.log('[err]', e.message));

// 握手第一步：心跳
w(5, [], 'heartbeat-initial');
setTimeout(() => { if (!got104) { console.log(`[${t()}s] !! 心跳无回应，测试终止`); process.exit(1); } }, 4000);
setTimeout(() => { console.log('超时退出'); process.exit(0); }, 25000);

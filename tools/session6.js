// v6 完整会话：蓝牙接口(8243)握手 + 主动开麦（官方软件不运行）
// 已确认：命令走蓝牙口（写62B），心跳5→104，然后 12+15→227→17+1(Open)→3(AskVoice)
const binding = require('../vendor/mi-hid/prebuilds/HID-win32-x64/node-napi-v4.node');

const VID = 0x248a;
const devs = binding.devices().filter(d => d.vendorId === VID && d.usagePage === 0xff12);
const bt = devs.find(d => d.productId === 0x8243);
const wired = devs.find(d => d.productId === 0x8102);
if (!bt) { console.log('BT INTERFACE NOT FOUND'); process.exit(1); }

const cmdDev = new binding.HID(bt.path);   // 命令通道（蓝牙）
console.log('[bt] 命令通道已打开');
let audioDev = null;
if (wired) {
  try { audioDev = new binding.HID(wired.path); console.log('[wired] 音频监听已打开'); } catch (e) { console.log('[wired] 打开失败:', e.message); }
}

const t0 = Date.now();
let audioPkts = 0, got104 = false, verified = false;

function frame(cmd, data = []) {
  const arr = [0x05, 0xff, 0xf1, 0xfe, 0xc0, cmd, data.length];
  data.forEach(b => arr.push(b));
  arr.push(0xef);
  return Buffer.from(arr);
}
function w(dev, cmd, data, tag) {
  try {
    const n = dev.write(frame(cmd, data));
    console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] -> ${tag} write=${n} ${frame(cmd, data).slice(0, 10).toString('hex')}`);
  } catch (e) { console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] -> ${tag} FAIL: ${e.message}`); }
}

function handleData(which) {
  return function onData(data) {
    const t = ((Date.now() - t0) / 1000).toFixed(2);
    if (data[0] === 0x1b) {
      audioPkts++;
      if (audioPkts === 1) console.log(`[${t}s] [${which}] *** AUDIO STREAM STARTED ***`);
      else if (audioPkts % 200 === 0) console.log(`[${t}s] [${which}] audio=${audioPkts}`);
      return;
    }
    const cmd = data[5];
    // 只打印关键帧，104 心跳从第3个起静音
    if (!(cmd === 104 && got104)) console.log(`[${t}s] [${which}] <- cmd=${cmd} ${data.slice(0, 16).toString('hex')}`);

    if (which !== 'bt') return; // 命令状态机只看蓝牙口

    if (cmd === 104 && !got104) {
      got104 = true;
      console.log(`[${t}s] *** FIRST HEARTBEAT ACK *** -> 发 12 + 15`);
      w(cmdDev, 12, [], 'AskDeviceState(12)');
      const e = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
      w(cmdDev, 15, e, 'Verify(15)');
    }
    if (cmd === 227) {
      verified = true;
      console.log(`[${t}s] *** VERIFY REPLY 227 *** -> 发 SN(17) + Open(1)`);
      w(cmdDev, 17, [], 'SN(17)');
      setTimeout(() => w(cmdDev, 1, [], 'Open(1)'), 150);
    }
    if (cmd === 106) console.log(`[${t}s] *** MIC OPEN (106) ***`);
    if (cmd === 107) console.log(`[${t}s] mic close (107)`);
  };
}

// 读循环
function readLoop(dev, which) {
  dev.read((err, data) => {
    if (err) { console.log(`[${which}] READ ERR`, err.message || err); return; }
    handleData(which)(data);
    readLoop(dev, which);
  });
}
readLoop(cmdDev, 'bt');
if (audioDev) readLoop(audioDev, 'wired');

// 启动：立即心跳
w(cmdDev, 5, [], 'Heartbeat(5) initial');
const hb = setInterval(() => w(cmdDev, 5, [], 'Heartbeat(5)'), 1000);

// 12 秒后主动开麦（若已验证）
setTimeout(() => {
  if (verified) { console.log('=== AskVoice(3) 已发送：请直接说话（无需按F10）==='); w(cmdDev, 3, [], 'AskVoice(3)'); }
  else console.log('--- 12s 仍未验证，等待 ---');
}, 12000);
setTimeout(() => w(cmdDev, 4, [], 'StopVoice(4)'), 22000);
setTimeout(() => {
  clearInterval(hb);
  try { cmdDev.close(); if (audioDev) audioDev.close(); } catch (_) {}
  console.log(`=== SUMMARY audio=${audioPkts} verified=${verified} first104=${got104} ===`);
  process.exit(0);
}, 28000);

// 键盘报文监听标定工具（纯 Node，无需 Electron）
// 用法：node tools/listen.js
// 然后在键盘上按 AI 模式的键，看输出的键码与键名。

const HID = require('node-hid');
const { decodeFrame } = require('../src/main/hid');
const { lookupKey } = require('../src/main/keymap');

const TARGETS = [
  { vid: 0x248a, pid: 0x8102, name: 'R87 Pro AI (有线)' },
  { vid: 0x248a, pid: 0x8243, name: 'R87 Pro AI (蓝牙)' },
];

const opened = new Set();

function scan() {
  let list = [];
  try { list = HID.devices(); } catch (e) { return console.log('枚举失败:', e.message); }

  let found = false;
  for (const d of list) {
    const t = TARGETS.find(t => t.vid === d.vendorId && t.pid === d.productId);
    if (!t) continue;
    found = true;
    console.log(`[设备] ${t.name}  usagePage=0x${(d.usagePage || 0).toString(16)} usage=0x${(d.usage || 0).toString(16)} interface=${d.interface} path=${d.path}`);
    // 打开厂商自定义页接口；没有就打开全部接口尝试
    if (!(d.usagePage >= 0xff00 && d.usage >= 0x1000)) continue;
    if (opened.has(d.path)) continue;
    try {
      const dev = new HID.HID(d.path);
      opened.add(d.path);
      dev.on('data', buf => {
        const frame = decodeFrame(buf);
        if (!frame) return; // 音频流等非命令帧直接忽略
        const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        if (frame.cmd === 209) {
          console.log(`[${ts}] cmd=209 AI模式 ${frame.data[0] === 1 ? '开(1)' : '关(0)'}`);
          return;
        }
        if (frame.cmd === 106 || frame.cmd === 107) return; // 状态流噪音
        const key = lookupKey(frame.data[0]);
        const name = key ? `${key.label} [${key.phase}]` : `未知键码`;
        console.log(`[${ts}] code=${frame.data[0]}  ${name}`);
      });
      dev.on('error', e => { console.log('读取错误:', e.message); opened.delete(d.path); });
      console.log(`[已打开] 开始监听 ${t.name} —— 现在按键盘上的键试试`);
    } catch (e) {
      console.log('打开失败:', e.message);
    }
  }
  if (!found) console.log('[等待] 未发现目标键盘（请确认 USB 已插或蓝牙已连）');
}

console.log('RK87 AIKey 报文监听（Ctrl+C 退出）\n');
scan();
setInterval(scan, 2000);

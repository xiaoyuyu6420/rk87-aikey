// E2E 辅助：独立进程注入一组按键（SendInput，走系统输入路径）。
// 用途：验证 AnyKey AI 的 AI 层系统热键——注入的 Ctrl+Alt+F6 会被注册方
// （AnyKey AI）拦截并触发槽位动作，前台应用收不到。
// 用法：node tools/inject-hotkey.js Ctrl+Alt+F6
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const KEYBDINPUT = koffi.struct('INJ_KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uint64',
});
const INPUT = koffi.struct('INJ_INPUT', { type: 'uint32', _pad: 'uint32', ki: KEYBDINPUT, _pad2: 'uint64' });
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INJ_INPUT *pInputs, int cbSize)');
const KEYEVENTF_KEYUP = 0x0002;
const VK = { ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b };
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x70 + i - 1;

const combo = process.argv[2] || 'Ctrl+Alt+F6';
const names = combo.split('+').map(s => s.trim().toLowerCase());
const vks = names.map(n => {
  if (VK[n] === undefined) { console.error('未知键:', n); process.exit(1); }
  return VK[n];
});

function press(vk, up) {
  const inp = { type: 1, _pad: 0, ki: { wVk: vk, wScan: 0, dwFlags: up ? KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0 }, _pad2: 0 };
  const n = SendInput(1, inp, 40);
  if (n !== 1) { console.error('SendInput 失败 vk=0x' + vk.toString(16)); process.exit(1); }
}

const mods = vks.slice(0, -1), main = vks[vks.length - 1];
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (const v of mods) { press(v, false); await wait(40); }
  press(main, false);
  await wait(60);
  press(main, true);
  for (let i = mods.length - 1; i >= 0; i--) { press(mods[i], true); await wait(20); }
  console.log('[inject] 已注入', combo);
})();

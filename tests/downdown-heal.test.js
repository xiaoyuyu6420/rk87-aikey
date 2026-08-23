// down-down 不变量自愈测试：重复 down 触发 up+down 事件序列
const path = require('path');
const ROOT = require('path').join(__dirname, '..');
const koffiPath = require.resolve('koffi', { paths: [ROOT] });
require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };
class FakeHID {
  constructor(p) { this.written = []; }
  write(b) { this.written.push(b); return b.length; }
  read(cb) {}
  close() {}
}
const nodeHidPath = require.resolve('node-hid', { paths: [ROOT] });
require.cache[nodeHidPath] = {
  id: nodeHidPath, filename: nodeHidPath, loaded: true,
  exports: { HID: FakeHID, devices: () => [{ vendorId: 0x248a, productId: 0x8243, usagePage: 0xff12, interface: -1, path: 'bt-0', release: 0 }] },
};

const { KeySession } = require(path.join(ROOT, 'src/main/kb-session.js'));
const keymap = require(path.join(ROOT, 'src/main/keymap.js'));

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

const s = new KeySession();
const events = [];
s.on('key', e => events.push(e.phase));
s.start();

// 找 f10 的 down/up 码（KEY_DEFS 是数组：{code, up, id}）
const f10 = keymap.KEY_DEFS.find(d => d.id === 'f10');
ok(f10, `keymap 找到 f10 码 down=${f10.code} up=${f10.up}`);
const F10D = f10.code, F10U = f10.up;

const send = code => s._onData(Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 159, 1, code, 0xef, 0, 0, 0, 0, 0, 0, 0]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 正常序列：down → up → down → up（无自愈介入）
  events.length = 0;
  send(F10D); await sleep(80);
  send(F10U); await sleep(80);
  send(F10D); await sleep(80);
  send(F10U);
  ok(events.join(',') === 'down,up,down,up', `正常序列原样透传（${events}）`);

  // up 丢失场景：down → (up 丢) → down → 触发自愈 up+down
  events.length = 0;
  send(F10D); await sleep(80);
  send(F10D); await sleep(80);
  ok(events.join(',') === 'down,up,down', `down-down 破缺 → 补 up + 放行 down（${events}）`);

  // 60ms 内的快速重复 down（双投过滤）：不触发自愈、不重复 emit
  events.length = 0;
  send(F10U); await sleep(200); // 先复位（这条 up 会记入序列）
  send(F10D);
  send(F10D); // 间隔 0ms < 60ms 去重
  await sleep(100);
  ok(events.join(',') === 'up,down', `60ms 内重复 down 被去重不触发自愈（${events}）`);

  // 自愈后再正常 up：不重复
  events.length = 0;
  send(F10U);
  ok(events.join(',') === 'up', '自愈后正常 up 原样');

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  s.stop();
  process.exit(fail ? 1 : 0);
})();

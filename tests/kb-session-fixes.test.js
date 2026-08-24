// stub 隔离测试：验证 v0.8.1 修复的关键行为（koffi/node-hid 全 stub，零副作用）
const path = require('path');
const ROOT = require('path').join(__dirname, '..');

// ---- stub koffi（防 CGEvent 真注入）----
const koffiPath = require.resolve('koffi', { paths: [ROOT] });
require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };

// ---- stub node-hid ----
class FakeHID {
  constructor(p) { this.path = p; FakeHID.instances.push(this); this.closeCalls = 0; this.written = []; }
  write(buf) { this.written.push(buf); return buf.length; }
  read(cb) { FakeHID.pendingRead = cb; }
  close() {
    this.closeCalls++;
    if (this.closeCalls <= FakeHID.failFirstN) throw new TypeError('read is still running');
    this.closed = true;
  }
}
FakeHID.instances = [];
FakeHID.failFirstN = 0;
const nodeHidPath = require.resolve('node-hid', { paths: [ROOT] });
require.cache[nodeHidPath] = {
  id: nodeHidPath, filename: nodeHidPath, loaded: true,
  exports: { HID: FakeHID, devices: () => [{ vendorId: 0x248a, productId: 0x8243, usagePage: 0xff12, interface: -1, path: 'bt-0', release: 0 }] },
};
// win32：kb-session.loadBinding 走 vendor mi-hid 而非 node-hid（见 kb-session.js），
// 不 stub 会打开真实键盘命令口
if (process.platform === 'win32') {
  const vendorPath = require.resolve(path.join(ROOT, 'vendor/mi-hid/prebuilds/HID-win32-x64/node-napi-v4.node'));
  require.cache[vendorPath] = { id: vendorPath, filename: vendorPath, loaded: true, exports: require.cache[nodeHidPath].exports };
}

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗ FAIL:', name)); };

const { KeySession } = require('../src/main/kb-session.js');
const kbdInject = require('../src/main/kbd-inject.js');

const HB104 = Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 104, 0, 0xef, 0, 0, 0, 0, 0, 0, 0, 0]);

(async () => {
  console.log('[T1/T2] RTT 劣化检测豁免');
  {
    const s = new KeySession();
    s.start();
    const dev = FakeHID.instances[0];
    s._onData(HB104);
    s._onData(Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 227, 0, 0xef, 0, 0, 0, 0, 0, 0, 0, 0]));
    ok(s.connected, '会话在线');
    for (let i = 0; i < 10; i++) {
      s.lastAudioTs = Date.now();
      s._hbTs = Date.now() - 900;
      s._onData(HB104);
    }
    ok(s.connected && s.rttBad === 0, '音频活跃时 10 次高 RTT 不累计不断线');
    s.lastAudioTs = Date.now() - 5000;
    for (let i = 0; i < 5; i++) {
      s._hbTs = Date.now() - 900;
      s._onData(HB104);
    }
    ok(!s.connected, '音频停后 5 次高 RTT 仍触发强制重连');
    s.stop();
  }

  console.log('[T3] close 泄漏修复');
  {
    FakeHID.instances.length = 0;
    FakeHID.failFirstN = 2;
    const s = new KeySession();
    s.start();
    const dev = FakeHID.instances.at(-1);
    s._onDisconnect('test');
    ok(s.dev === null, '断线后 this.dev 立即置空');
    await new Promise(r => setTimeout(r, 150 + 200 * 3 + 100));
    ok(dev.closed && dev.closeCalls === 3, `close 抛异常后延迟重试成功（${dev.closeCalls} 次后关闭）`);
    s.stop();
    FakeHID.failFirstN = 0;
  }

  console.log('[T4] 语音期心跳降频');
  {
    FakeHID.instances.length = 0;
    const s = new KeySession();
    s.start();
    const dev = FakeHID.instances.at(-1);
    const hb = () => dev.written.filter(b => b[5] === 5 && b[2] === 0xf1).length;
    const b1 = hb();
    await new Promise(r => setTimeout(r, 3200));
    const idle = hb() - b1;
    s.lastAudioTs = Date.now();
    const b2 = hb();
    await new Promise(r => setTimeout(r, 3200));
    const audio = hb() - b2;
    ok(idle >= 2 && idle <= 4, `空闲心跳 ~1/s（${idle}/3.2s）`);
    ok(audio <= 2, `语音期心跳 ≤1/3s（${audio}/3.2s）`);
    s.stop();
  }

  // T5 测 kbd-inject（mac CGEvent 回注）；win32 无此路径（feedKeyboardReport 直接短路）
  if (process.platform !== 'darwin') {
    console.log('[T5] 跳过：kbd-inject 仅 mac 有回注路径');
  } else {
  console.log('[T5] ErrorRollOver 不误抬 + autorepeat 熔断');
  {
    const mkRpt = (mod, ...keys) => Buffer.from([2, mod, 0, ...keys].slice(0, 9));
    kbdInject.reset();
    const before = kbdInject.getDiag().postOk;
    kbdInject.feedKeyboardReport(mkRpt(0, 4, 0, 0, 0, 0, 0)); // A down
    const afterDown = kbdInject.getDiag().postOk;
    ok(afterDown - before === 1, 'A down 注入 1 个事件');
    kbdInject.feedKeyboardReport(Buffer.from([2, 0, 0, 1, 1, 1, 1, 1, 1])); // ErrorRollOver
    const afterRO = kbdInject.getDiag().postOk;
    ok(afterRO === afterDown, 'ErrorRollOver 帧零注入（不抬起已按住的键）');
    // 熔断：真等 REPEAT_FUSE(6s)+余量。注意 autorepeat 补发是内联 CG 调用
    //（不经 postKey/postOk 计数），所以这里只应看到 1 个事件 = 熔断抬起
    console.log('  …等 7s 验证熔断…');
    await new Promise(r => setTimeout(r, 7000));
    const afterFuse = kbdInject.getDiag().postOk;
    ok(afterFuse - afterRO === 1, `6s 后恰好 1 个熔断抬起事件（Δ=${afterFuse - afterRO}）`);
    // 熔断后再喂全零帧不应产生多余事件（状态已干净）
    const b3 = kbdInject.getDiag().postOk;
    kbdInject.feedKeyboardReport(mkRpt(0, 0, 0, 0, 0, 0, 0));
    ok(kbdInject.getDiag().postOk === b3, '熔断后状态干净（全零帧零事件）');
    kbdInject.reset();
  }
  }

  // [T6] 电量解析：cmd=156（查询回应）/ cmd=208（主动上报）。stub 设备 interface=-1
  // → isBluetoothHid=true → transport='蓝牙'，恰好覆盖「蓝牙口取真实电量」分支
  console.log('[T6] 电量解析 cmd=156/208');
  {
    FakeHID.instances.length = 0;
    const s = new KeySession();
    s.start();
    const emitted = [];
    s.on('battery', b => emitted.push({ ...b }));
    ok(s.transport === '蓝牙', `测试会话为蓝牙口（实得 ${s.transport}）`);

    // cmd=156（len≥11，payload[4]=电量）：蓝牙取真实值
    const f156 = Buffer.alloc(20);
    f156[5] = 156; f156[6] = 11; f156[11] = 73;
    s._onData(f156);
    ok(s.battery && s.battery.level === 73 && s.battery.charging === false,
      `156: 蓝牙口取真实电量 payload[4]=73（实得 ${s.battery && s.battery.level}）`);
    ok(emitted.length === 1, '首次上报 emit battery');
    s._onData(Buffer.from(f156));
    ok(emitted.length === 1, '同电量去重不重复 emit');
    const f156b = Buffer.from(f156); f156b[11] = 72;
    s._onData(f156b);
    ok(emitted.length === 2 && emitted[1].level === 72, '电量变化重新 emit');

    // cmd=208（len≥2，payload[0]=充电标志、payload[1]=电量）：官方反向语义 0==充电中
    const mk208 = (flag, level) => { const b = Buffer.alloc(12); b[5] = 208; b[6] = 2; b[7] = flag; b[8] = level; return b; };
    s._onData(mk208(0, 88));
    ok(s.battery.level === 88 && s.battery.charging === true, '208: payload[0]==0 → 充电中');
    s._onData(mk208(1, 87));
    ok(s.battery.level === 87 && s.battery.charging === false, '208: payload[0]!=0 → 未充电');

    // len<2 短帧不进解析、不改状态
    const short = Buffer.alloc(10); short[5] = 208; short[6] = 1; short[7] = 1;
    s._onData(short);
    ok(s.battery.level === 87 && s.battery.charging === false, 'len<2 短帧忽略');
    s.stop();
  }

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();

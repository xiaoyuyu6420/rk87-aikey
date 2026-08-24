// kb-session 重连竞态回归测试（koffi/node-hid 全 stub，零副作用）：
//   R1 手动重连与挂起的定时重连并发 → 不得双开 HID 句柄
//   R2 旧句柄的迟到读回调（错误/数据）不得触碰新会话（代际隔离）
//   R3 旧回调递归不得对新设备发起第二个并发 read
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---- stub koffi ----
const koffiPath = require.resolve('koffi', { paths: [ROOT] });
require.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: { load: () => ({ func: () => () => ({}) }) } };

// ---- stub node-hid（带 readCalls 计数，供 R3 断言）----
class FakeHID {
  constructor(p) {
    this.path = p;
    this.readCalls = 0;
    this.closeCalls = 0;
    this.written = [];
    FakeHID.instances.push(this);
  }
  write(buf) { this.written.push(buf); return buf.length; }
  read(cb) { this.readCalls++; FakeHID.pendingReads.push({ dev: this, cb }); }
  close() { this.closeCalls++; this.closed = true; }
}
FakeHID.instances = [];
FakeHID.pendingReads = [];
const fakeExports = { HID: FakeHID, devices: () => [] };
const nodeHidPath = require.resolve('node-hid', { paths: [ROOT] });
require.cache[nodeHidPath] = { id: nodeHidPath, filename: nodeHidPath, loaded: true, exports: fakeExports };
if (process.platform === 'win32') {
  const vendorPath = require.resolve(path.join(ROOT, 'vendor/mi-hid/prebuilds/HID-win32-x64/node-napi-v4.node'));
  require.cache[vendorPath] = { id: vendorPath, filename: vendorPath, loaded: true, exports: fakeExports };
}

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { KeySession } = require('../src/main/kb-session.js');
const HB104 = Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 104, 0, 0xef]);
const C227 = Buffer.from([5, 0xff, 0xf1, 0xfe, 0xc0, 227, 0, 0xef]);

(async () => {
  fakeExports.devices = () => [{ vendorId: 0x248a, productId: 0x8243, usagePage: 0xff12, interface: -1, path: 'bt-0', release: 0 }];

  console.log('[R1] 手动重连 + 挂起定时重连 → 不双开');
  {
    FakeHID.instances.length = 0;
    const s = new KeySession();
    s.start();
    const devA = FakeHID.instances.at(-1);
    ok(devA && devA.path === 'bt-0', '第一代句柄打开');

    // 模拟读错误断线 → _onDisconnect 排定 3s 重连（watchTimer 挂起）
    const readA = FakeHID.pendingReads.find(r => r.dev === devA);
    readA.cb(new Error('device unplugged'));
    ok(s.dev === null, '断线后 dev 置空');

    // 1s 内用户点托盘「重连键盘」→ reconnect() 直接 _open()
    await sleep(1000);
    s.reconnect();
    const devB = FakeHID.instances.at(-1);
    ok(FakeHID.instances.length === 2 && devB !== devA, '手动重连打开第二代句柄');

    // 等过 3s 定时窗口：不得出现第三个句柄（双开）
    await sleep(2400);
    ok(FakeHID.instances.length === 2, `定时器不再双开（实例数 ${FakeHID.instances.length}）`);
    ok(s.dev === devB, '当前会话仍是第二代句柄');

    // 心跳 interval 不泄漏：断开重连多次后 devB 收到的心跳节奏 ~1/s（计数）
    const hb = () => devB.written.filter(b => b[5] === 5).length;
    const b1 = hb();
    await sleep(2100);
    const rate = hb() - b1;
    ok(rate >= 1 && rate <= 3, `单份心跳 ~1/s（2.1s 内 ${rate} 条，双发会是 ~4+）`);
    s.stop();
  }

  console.log('[R2/R3] 旧句柄迟到回调不杀新会话、不对新设备并发 read');
  {
    FakeHID.instances.length = 0;
    FakeHID.pendingReads.length = 0;
    const s = new KeySession();
    s.start();
    const devA = FakeHID.instances.at(-1);

    // 真实竞态序列：devA 的 read 仍挂起（cbA 未完成）时握手超时断线。
    // _closeDev 延迟关闭期间 cbA 一直存活——这正是代际守卫要防的窗口
    const pendA = FakeHID.pendingReads.find(r => r.dev === devA);
    ok(!!pendA, 'devA 挂起一条 read（旧回调存活）');
    s._onDisconnect('handshake-timeout'); // dev=null，排定 3s 重连
    ok(s.dev === null, '断线后 dev 置空');

    await sleep(100);
    s.reconnect(); // 立即手动重连 → 第二代 devB（并撤销挂起的定时重连）
    const devB = FakeHID.instances.at(-1);
    ok(devB && devB !== devA, '第二代句柄打开');
    s._onData(HB104);
    s._onData(C227);
    ok(s.connected && s.dev === devB, '第二代会话在线');
    const readsB0 = devB.readCalls;
    ok(readsB0 === 1, `devB 恰好 1 条挂起 read（实得 ${readsB0}）`);

    // 旧句柄的迟到错误回调（修复前：会走 _onDisconnect 杀掉 devB 会话）
    pendA.cb(new Error('late stale error'));
    await sleep(30);
    ok(s.connected === true, '旧句柄迟到【错误】未杀新会话（仍在线）');
    ok(s.dev === devB && !devB.closed, '新句柄未被关闭');

    // 旧句柄的迟到数据回调（修复前：递归 _readLoop 对 devB 发第二个并发 read，
    // node-hid 同步抛 "read is still running" = 未捕获异常；227 还会重复握手）
    pendA.cb(null, C227);
    await sleep(30);
    ok(s.connected === true, '旧句柄迟到【数据】未污染新会话');
    ok(devB.readCalls === readsB0, `新设备 read 次数不变（${devB.readCalls}，无并发 read）`);
    s.stop();
  }

  console.log('[R4] _open 有活动句柄时直接返回（不覆盖/不泄漏心跳）');
  {
    FakeHID.instances.length = 0;
    FakeHID.pendingReads.length = 0;
    const s = new KeySession();
    s.start();
    const n0 = FakeHID.instances.length;
    s._open(); // 已有 dev → 防御性 return
    ok(FakeHID.instances.length === n0, '不新开句柄');
    s.stop();
  }

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();

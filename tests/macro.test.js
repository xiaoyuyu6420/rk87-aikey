// 宏录制/回放单测（纯逻辑：注入 fake 键状态，手动驱动 tick；回放真等待小间隔）
const { MacroRecorder, buildPollTable, trimSteps, replayMacro, abortReplay, isReplaying } = require('../src/main/macro.js');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 测试键表（模拟 VK 表：含修饰键）
const VK = { ctrl: 17, shift: 16, a: 65, b: 66, x: 88, f5: 116 };

console.log('[T1] buildPollTable 含修饰键');
{
  const t = buildPollTable(VK);
  const names = new Set(t.names);
  ok(names.has('ctrl') && names.has('shift'), '修饰键进轮询表（组合宏必需）');
  ok(t.codes.length === Object.keys(VK).length, '全键入表不跳过');
}

console.log('[T2] 录制边沿：a 单键 + Ctrl+X 组合');
{
  // fake 键状态：name -> bool，每 tick 前改脚本
  const down = new Set();
  const rec = new MacroRecorder({
    vkNames: VK,
    getKeyState: code => {
      for (const [name, c] of Object.entries(VK)) if (c === code) return down.has(name);
      return false;
    },
  });
  ok(rec.start(), 'start 成功');
  const step = () => rec.tick();

  step();                      // 静默
  down.add('a'); step();       // a↓
  step();
  down.delete('a'); step();    // a↑
  down.add('ctrl'); step();    // ctrl↓
  down.add('x'); step();       // x↓（组合）
  down.delete('x'); step();    // x↑
  down.delete('ctrl'); step(); // ctrl↑

  const steps = rec.stop();
  const seq = steps.map(s => `${s.name}:${s.down ? '↓' : '↑'}`);
  ok(seq.length === 6, `录到 6 个边沿（实得 ${seq.length}）`);
  ok(seq.join(',') === 'a:↓,a:↑,ctrl:↓,x:↓,x:↑,ctrl:↑', `顺序正确: ${seq.join(',')}`);
  ok(steps.every(s => s.dt >= 0), 'dt 非负');
  ok(!rec.recording, 'stop 后状态复位');
}

console.log('[T3] 停止瞬间按住的键补 up（回放不卡键）');
{
  const down = new Set(['shift', 'b']);
  const rec = new MacroRecorder({
    vkNames: VK,
    getKeyState: code => {
      for (const [name, c] of Object.entries(VK)) if (c === code) return down.has(name);
      return false;
    },
  });
  rec.start();
  rec.tick(); // shift、b 按下边沿
  const steps = rec.stop(); // 按住中直接停
  const tail = steps.slice(-2);
  ok(tail.every(s => s.down === false), '尾部补 up');
  ok(tail.map(s => s.name).sort().join(',') === 'b,shift', '补的是仍按住的键');
}

console.log('[T4] 超时自动停 + onAutoStop 回调');
{
  const rec = new MacroRecorder({
    vkNames: VK, maxMs: 0,
    getKeyState: () => false,
  });
  let fired = null;
  rec.start((steps, reason) => { fired = reason; });
  rec.tick(); // maxMs=0 → 立即超时
  ok(!rec.recording, '超时后 recording=false');
  ok(fired === 'timeout', 'onAutoStop 收到 timeout');
  // 手动 stop 不触发回调
  const rec2 = new MacroRecorder({ vkNames: VK, maxMs: 99999, getKeyState: () => false });
  let fired2 = null;
  rec2.start((_, r) => { fired2 = r; });
  rec2.stop('manual');
  ok(fired2 === null, '手动 stop 不触发 onAutoStop');
}

console.log('[T5] trimSteps：首步反应延迟钳制');
{
  const t = trimSteps([{ name: 'a', down: true, dt: 4200 }, { name: 'a', down: false, dt: 80 }]);
  ok(t[0].dt === 500, `首步 4200ms 钳到 500（实得 ${t[0].dt}）`);
  ok(t[1].dt === 80, '后续步不动');
  ok(trimSteps([]).length === 0, '空数组安全');
}

console.log('[T6] 回放：序列/时序/防重入/中断');
(async () => {
  const sent = [];
  const post = (name, down) => sent.push({ name, down, at: Date.now() });
  const steps = [
    { name: 'ctrl', down: true, dt: 20 },
    { name: 'x', down: true, dt: 15 },
    { name: 'x', down: false, dt: 40 },
    { name: 'ctrl', down: false, dt: 15 },
  ];
  const t0 = Date.now();
  ok(replayMacro(steps, post), 'replay 启动');
  ok(isReplaying(), '回放中状态可见');
  ok(replayMacro(steps, post) === false, '防重入：回放中再启动被拒');
  await sleep(20 + 15 + 40 + 15 + 100 + 80); // 等全部 timer 落地
  ok(!isReplaying(), '回放结束状态复位');
  ok(sent.length === 4, `4 步全发（实得 ${sent.length}）`);
  ok(sent.map(s => `${s.name}:${s.down}`).join(',') === 'ctrl:true,x:true,x:false,ctrl:false', '发键序列正确');
  ok(sent[1].at - t0 >= 15, '时序间隔生效（x 至少等了首步 20ms）');
  ok(sent[2].at - sent[1].at >= 30, '步间间隔生效');

  // 中断：长宏 abort 后不再发键
  const sent2 = [];
  const long = [
    { name: 'a', down: true, dt: 5 },
    { name: 'a', down: false, dt: 5 },
    { name: 'b', down: true, dt: 400 }, // 这步不该发出来
    { name: 'b', down: false, dt: 5 },
  ];
  ok(replayMacro(long, (n, d) => sent2.push({ n, d })), '长宏启动');
  await sleep(30); // 前两步已发
  abortReplay();
  await sleep(500);
  ok(sent2.length === 2, `abort 后剩余步不发（实得 ${sent2.length}）`);
  ok(!isReplaying(), 'abort 后状态复位');
  ok(replayMacro([], post) === false, '空宏拒绝回放');

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();

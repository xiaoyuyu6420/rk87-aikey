// 宏中断补抬起回归测试：abortReplay 必须给已注入 down 未 up 的键补发 up，
// 否则系统级卡修饰键（用户后续打字全变快捷键，须物理再按一次解除）
const { replayMacro, abortReplay, isReplaying } = require('../src/main/macro.js');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('[T1] Escape/手动中断：按住中的修饰键立即补抬起（倒序）');
  {
    const sent = [];
    // Ctrl↓ …（长间隔，up 还没到）… 中断
    const steps = [
      { name: 'ctrl', down: true, dt: 10 },
      { name: 'x', down: true, dt: 10 },
      { name: 'ctrl', down: false, dt: 2000 }, // 中断时不应发出
      { name: 'x', down: false, dt: 10 },
    ];
    ok(replayMacro(steps, (n, d) => sent.push({ n, d })), '宏启动');
    await sleep(80); // 前两步已注入（ctrl/x 都按住）
    ok(sent.length === 2, `中断前恰好 2 步（实得 ${sent.length}）`);
    abortReplay();
    await sleep(300); // 补抬走的同步路径，等剩余 timer 证明不再发
    ok(sent.length === 4, `中断补发 2 个 up（实得 ${sent.length}）`);
    const tail = sent.slice(2).map(s => `${s.n}:${s.d}`).join(',');
    ok(tail === 'x:false,ctrl:false', `倒序补抬（先 x 后 ctrl）：${tail}`);
    ok(!isReplaying(), '中断后状态复位');
  }

  console.log('[T2] 自然结束：尾部残留按住的键（用户手改 steps 的防御路径）也被抬起');
  {
    const sent = [];
    const steps = [
      { name: 'shift', down: true, dt: 10 },
      // shift 没有对应 up —— 录制器正常会补，但手改/旧配置可能没有
    ];
    ok(replayMacro(steps, (n, d) => sent.push({ n, d })), '宏启动');
    await sleep(10 + 100 + 80); // 全部步 + 收尾 abortReplay timer
    ok(!isReplaying(), '自然结束');
    ok(sent.length === 2 && sent[1].n === 'shift' && sent[1].d === false,
      `残留按住的 shift 被收尾抬起（实得 ${JSON.stringify(sent)}）`);
  }

  console.log('[T3] 正常宏（down/up 齐全）中断零额外注入');
  {
    const sent = [];
    const steps = [
      { name: 'a', down: true, dt: 10 },
      { name: 'a', down: false, dt: 10 },
      { name: 'b', down: true, dt: 800 },
      { name: 'b', down: false, dt: 10 },
    ];
    ok(replayMacro(steps, (n, d) => sent.push({ n, d })), '宏启动');
    await sleep(60); // a↓ a↑ 已发
    abortReplay();
    await sleep(300);
    ok(sent.length === 2, `无按住键时中断不注入任何补发（实得 ${sent.length}）`);
  }

  console.log('[T4] 未回放时 abortReplay 无副作用');
  {
    let posted = 0;
    abortReplay(); // 不应抛
    ok(!isReplaying(), '状态保持复位');
    ok(posted === 0, '零注入');
  }

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();

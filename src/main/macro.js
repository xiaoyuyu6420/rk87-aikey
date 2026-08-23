// 宏录制与回放
// 录制：5ms 轮询系统键状态抓全键边沿（含修饰键——打字统计的表跳过修饰键，
//   宏需要 Ctrl+X 组合所以自建反向表）。30s 上限自动停，停止瞬间仍按住的键补 up。
//   关键前提：AI 模式厂商码路径的键物理按下不产生系统键状态（系统层键状态由本应用
//   回注合成），录制期间 index.js 把绑定键强制透传（动作不执行+原键回注），边沿才可见。
//   只录标准系统键：AI 厂商码扩展键（无 VK 码）不进录制。
// 回放：setTimeout 链按 dt 逐发（发键复用 actions.postRawKey）。Windows 定时器精度
//   约 15ms，快于它的间隔会被拉平（打字节奏宏无感）。回放期间防重入、可中断。

const RECORD_INTERVAL_MS = 5;
const RECORD_MAX_MS = 30000;
const FIRST_STEP_MAX_MS = 500; // 保存时修剪首步（开始录制到首键的用户反应延迟）

// 反向轮询表：码→名（不跳过任何键，修饰键是组合宏的组成部分）
function buildPollTable(vkNames) {
  const byCode = new Map();
  for (const [name, code] of Object.entries(vkNames || {})) {
    if (!Number.isInteger(code)) continue;
    if (!byCode.has(code)) byCode.set(code, name);
  }
  return { codes: Array.from(byCode.keys()), names: Array.from(byCode.values()) };
}

// 平台键状态查询（与 stats.js 同款：Win GetAsyncKeyState / mac CGEventSourceKeyState）
function defaultKeyState() {
  const koffi = require('koffi');
  if (process.platform === 'win32') {
    const user32 = koffi.load('user32.dll');
    const fn = user32.func('short __stdcall GetAsyncKeyState(int)');
    return code => (fn(code) & 0x8000) !== 0;
  }
  if (process.platform === 'darwin') {
    const lib = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const fn = lib.func('bool CGEventSourceKeyState(uint32_t, uint16_t)');
    return code => fn(0, code);
  }
  return null;
}

class MacroRecorder {
  // 测试可注入 getKeyState / vkNames / maxMs
  constructor(opts = {}) {
    this.getKeyState = opts.getKeyState || null;
    this.vkNames = opts.vkNames || null;
    this.maxMs = opts.maxMs !== undefined ? opts.maxMs : RECORD_MAX_MS;
    this.recording = false;
    this.steps = [];
    this.prev = null;
    this.table = null;
    this.timer = null;
    this.startTs = 0;
    this.lastEdgeTs = 0;
    this.onAutoStop = null; // (steps, reason) 超时自动停回调
  }

  start(onAutoStop) {
    if (this.recording) return false;
    try {
      if (!this.getKeyState) this.getKeyState = defaultKeyState();
      if (!this.getKeyState) return false;
      const { VK_KEYNAMES } = require('./actions');
      this.table = buildPollTable(this.vkNames || VK_KEYNAMES);
    } catch (_) {
      return false;
    }
    this.recording = true;
    this.steps = [];
    this.prev = new Uint8Array(this.table.codes.length);
    this.startTs = this.lastEdgeTs = Date.now();
    this.onAutoStop = onAutoStop || null;
    this.timer = setInterval(() => this.tick(), RECORD_INTERVAL_MS);
    this.timer.unref && this.timer.unref();
    return true;
  }

  tick() {
    if (!this.recording) return;
    if (Date.now() - this.startTs >= this.maxMs) {
      this.stop('timeout');
      return;
    }
    const gs = this.getKeyState;
    for (let i = 0; i < this.table.codes.length; i++) {
      const down = gs(this.table.codes[i]) ? 1 : 0;
      if (down !== this.prev[i]) {
        const now = Date.now();
        this.steps.push({ name: this.table.names[i], down: !!down, dt: now - this.lastEdgeTs });
        this.lastEdgeTs = now;
        this.prev[i] = down;
      }
    }
  }

  // 返回完整 steps（含尾部补 up）
  stop(reason = 'manual') {
    if (!this.recording) return this.steps;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.recording = false;
    const tail = Date.now() - this.lastEdgeTs;
    for (let i = 0; i < this.prev.length; i++) {
      if (this.prev[i]) {
        this.steps.push({ name: this.table.names[i], down: false, dt: tail });
        this.prev[i] = 0;
      }
    }
    if (reason === 'timeout' && this.onAutoStop) {
      try { this.onAutoStop(this.steps, reason); } catch (_) { /* 回调异常不重入 tick */ }
    }
    return this.steps;
  }
}

// 保存前修剪：首步 dt 是「点录制→第一下按键」的反应延迟，回放不该傻等
function trimSteps(steps) {
  const out = (Array.isArray(steps) ? steps : []).slice();
  if (out.length) out[0] = { ...out[0], dt: Math.min(Number(out[0].dt) || 0, FIRST_STEP_MAX_MS) };
  return out;
}

// ---------- 回放引擎 ----------
const replay = { active: false, timers: [] };

function isReplaying() {
  return replay.active;
}

// postKey: (name, down, flags) —— 由 index.js 注入 actions.postRawKey
function replayMacro(steps, postKey) {
  if (replay.active) return false;
  const list = Array.isArray(steps) ? steps.filter(s => s && typeof s.name === 'string') : [];
  if (!list.length) return false;
  replay.active = true;
  let t = 0;
  for (const s of list) {
    t += Math.max(0, Number(s.dt) || 0);
    replay.timers.push(setTimeout(() => {
      try { postKey(s.name, s.down !== false, 0); } catch (_) { /* 发键失败跳过该步 */ }
    }, t));
  }
  replay.timers.push(setTimeout(() => {
    replay.timers = [];
    replay.active = false;
  }, t + 100));
  return true;
}

// 中断回放（录制开始/退出应用时清理孤儿 timer）
function abortReplay() {
  for (const tid of replay.timers) clearTimeout(tid);
  replay.timers = [];
  replay.active = false;
}

module.exports = {
  MacroRecorder, buildPollTable, trimSteps,
  replayMacro, abortReplay, isReplaying,
  RECORD_MAX_MS, RECORD_INTERVAL_MS,
};

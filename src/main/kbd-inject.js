// macOS 键盘报文回注（蓝牙/2.4G 场景）
// 背景：app 打开蓝牙键盘的厂商命令口后，macOS 会把整个键盘的标准输入流路由给本进程的
// 该句柄（蓝牙 HID 单播），系统键盘服务收不到报文 → 打字失灵（退出 app 才恢复）。
// 此模块把命令口收到的标准键盘报文（reportId=2）解析后用 CGEvent 转发回系统，
// 等效于官方 RK-AI 在 Windows 上的 SendInput 回注。
// 前提：需在 系统设置>隐私与安全>辅助功能 授权本应用（未授权时 CGEventPost 静默无效）。

const IS_MAC = process.platform === 'darwin';
let CG = null;

// 按住重复参数：对齐用户系统偏好（defaults -g InitialKeyRepeat/KeyRepeat，
// 单位 1/60s tick），读不到用 mac 默认手感（500ms/80ms）
function loadRepeatPrefs() {
  try {
    const { execFileSync } = require('child_process');
    const readTick = key => {
      const v = Number(execFileSync('defaults', ['read', '-g', key], { encoding: 'utf8' }).trim());
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    const init = readTick('InitialKeyRepeat');
    const rep = readTick('KeyRepeat');
    return {
      delay: init ? Math.max(150, init * 1000 / 60) : 500,
      interval: rep ? Math.max(30, rep * 1000 / 60) : 80,
    };
  } catch (_) {
    return { delay: 500, interval: 80 };
  }
}

function ensureCG() {
  if (CG || !IS_MAC) return;
  try {
    const koffi = require('koffi');
    const lib = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    CG = {
      sourceCreate: lib.func('void *CGEventSourceCreate(uint32_t)'),
      createKey: lib.func('void *CGEventCreateKeyboardEvent(void *, uint16_t, bool)'),
      setFlags: lib.func('void CGEventSetFlags(void *, uint64_t)'),
      setIntegerField: lib.func('void CGEventSetIntegerValueField(void *, uint32_t, int64_t)'),
      post: lib.func('void CGEventPost(uint32_t, void *)'),
      release: lib.func('void CFRelease(void *)'),
    };
    CG.source = CG.sourceCreate(0);
  } catch (e) {
    console.log('[inject] CGEvent 初始化失败:', e.message);
    CG = null;
  }
}

// HID Keyboard/Keypad usage -> macOS virtual keycode（HIToolbox Events.h）
const HID2VK = {
  4: 0x00, 5: 0x0B, 6: 0x08, 7: 0x02, 8: 0x0E, 9: 0x03, 10: 0x05, 11: 0x04, 12: 0x22,
  13: 0x26, 14: 0x28, 15: 0x25, 16: 0x2E, 17: 0x2D, 18: 0x1F, 19: 0x23, 20: 0x0C,
  21: 0x0F, 22: 0x01, 23: 0x11, 24: 0x20, 25: 0x09, 26: 0x0D, 27: 0x07, 28: 0x10, 29: 0x06,
  30: 0x12, 31: 0x13, 32: 0x14, 33: 0x15, 34: 0x17, 35: 0x16, 36: 0x1A, 37: 0x1C,
  38: 0x19, 39: 0x1D,
  40: 0x24, 41: 0x35, 42: 0x33, 43: 0x30, 44: 0x31,
  45: 0x1B, 46: 0x18, 47: 0x21, 48: 0x1E, 49: 0x2A, 51: 0x29, 52: 0x27, 53: 0x32,
  54: 0x2B, 55: 0x2F, 56: 0x2C, 57: 0x39,
  58: 0x7A, 59: 0x78, 60: 0x63, 61: 0x76, 62: 0x60, 63: 0x61, 64: 0x62, 65: 0x64,
  66: 0x65, 67: 0x6D, 68: 0x67, 69: 0x6F, 70: 0x69,
  74: 0x73, 75: 0x74, 76: 0x75, 77: 0x77, 78: 0x79,
  79: 0x7C, 80: 0x7B, 81: 0x7D, 82: 0x7E,
  83: 0x47, 84: 0x4B, 85: 0x43, 86: 0x4E, 87: 0x45, 88: 0x4C,
  89: 0x53, 90: 0x54, 91: 0x55, 92: 0x56, 93: 0x57, 94: 0x58, 95: 0x59, 96: 0x5B,
  97: 0x5C, 98: 0x52, 99: 0x41,
};

// 修饰键位掩码（报文 byte1）-> mac keycode（左右同码）
const MOD_BITS = [
  { mask: 0x01, vk: 0x3B, flag: 0x40000 },  // LCtrl
  { mask: 0x02, vk: 0x38, flag: 0x20000 },  // LShift
  { mask: 0x04, vk: 0x3A, flag: 0x80000 },  // LAlt/Option
  { mask: 0x08, vk: 0x37, flag: 0x100000 }, // LGui/Cmd
  { mask: 0x10, vk: 0x3B, flag: 0x40000 },  // RCtrl
  { mask: 0x20, vk: 0x38, flag: 0x20000 },  // RShift
  { mask: 0x40, vk: 0x3A, flag: 0x80000 },  // RAlt/Option
  { mask: 0x80, vk: 0x37, flag: 0x100000 }, // RGui/Cmd
];

const state = {
  mod: 0,      // 上次报文的修饰键掩码
  keys: new Set(), // 上次按下的普通键（HID usage）
  downTs: new Map(), // usage -> 按下时刻（按住重复用）
  lastRep: new Map(), // usage -> 上次重复发送时刻
};

// ---------- 按住重复（autorepeat） ----------
// macOS 对 CGEvent 合成键盘事件不做自动重复：物理按住字母/backspace 只回注一个
// down，系统不会像原生键盘那样连发 → 长按不重复、backspace 不能连续删。
// 这里自己模拟：按住超过 REPEAT_DELAY 后每 REPEAT_INTERVAL 补发一个带
// autorepeat 标志的 keyDown（kCGKeyboardEventAutorepeat = 8）。
//
// 熔断（关键防御）：蓝牙丢「抬起」帧 + 用户停手（无后续报文触发兜底清空）时，
// 残留键会被本 timer 无限连发（每 80ms 冒一个字符，直到用户再碰键盘）。HID 层
// 无法区分「真按住」与「丢抬起」（两者都不再发报文），只能时限熔断：连续补发
// 超过 REPEAT_FUSE 后自动抬起该键并留痕。取 6s：覆盖长按删 ~75 字符的常见场景；
// 丢抬起帧的连发损害封顶 6s（用户看到冒字会立刻按键，实际更短）。
const REPEAT_PREFS = IS_MAC ? loadRepeatPrefs() : { delay: 400, interval: 80 };
const REPEAT_DELAY = REPEAT_PREFS.delay;
const REPEAT_INTERVAL = REPEAT_PREFS.interval;
const REPEAT_FUSE = 6000; // ms：单键连续补发的熔断时限
let repeatTimer = null;

function ensureRepeatTimer() {
  if (repeatTimer || !IS_MAC) return;
  repeatTimer = setInterval(() => {
    if (!CG || state.keys.size === 0) return;
    const now = Date.now();
    const flags = currentFlags(state.mod);
    for (const k of state.keys) {
      if (FNKEY_USAGE[k]) continue; // 功能键有拦截/透传配对逻辑，不参与重复
      const ts = state.downTs.get(k);
      if (ts === undefined || now - ts < REPEAT_DELAY) continue;
      if (now - ts > REPEAT_FUSE) {
        // 熔断：按住超时且期间无任何新报文确认（真按住通常伴随其他按键/报文）
        console.log(`[inject] 按住超时熔断 usage=${k}（可能丢失抬起帧），自动抬起`);
        state.keys.delete(k);
        state.downTs.delete(k);
        state.lastRep.delete(k);
        const vk = HID2VK[k];
        if (vk !== undefined) postKey(vk, false, flags);
        continue;
      }
      const last = state.lastRep.get(k) || ts + REPEAT_DELAY - REPEAT_INTERVAL;
      if (now - last < REPEAT_INTERVAL) continue;
      state.lastRep.set(k, now);
      const vk = HID2VK[k];
      if (vk === undefined) continue;
      try {
        const ev = CG.createKey(CG.source, vk, true);
        CG.setFlags(ev, flags);
        if (CG.setIntegerField) CG.setIntegerField(ev, 8, 1);
        CG.post(0, ev);
        CG.release(ev);
      } catch (_) {}
    }
  }, 25);
}

// ---------- 功能键拦截（非 AI 模式） ----------
// F1-F12/PrtSc 在标准报文（reportId=2）里的 HID usage -> keyId。
// 这些键若在配置里绑定了动作，交给主进程注入的策略决定：屏蔽（不回注）或透传（回注原键）。
const FNKEY_USAGE = {
  58: 'f1', 59: 'f2', 60: 'f3', 61: 'f4', 62: 'f5', 63: 'f6',
  64: 'f7', 65: 'f8', 66: 'f9', 67: 'f10', 68: 'f11', 69: 'f12',
  70: 'prtsc',
};
let fnKeyPolicy = null;          // (keyId) -> 'block' | 'passthrough' | null（null=未绑定）
const fnKeyInjected = new Map(); // keyId -> down 时是否已回注；up 按此记录执行，
                                 // 防止按住期间配置变更导致 down/up 不配对、系统键卡住

function setFnKeyPolicy(fn) { fnKeyPolicy = fn; }

// 功能键按下/抬起边沿处理。返回 true = 已被策略消费（调用方不再走普通回注）
function dispatchFnKey(usage, down, flags) {
  const keyId = FNKEY_USAGE[usage];
  if (!keyId || !fnKeyPolicy) return false;
  if (down) {
    let mode = null;
    try { mode = fnKeyPolicy(keyId); } catch (_) {}
    if (mode === 'block') {
      fnKeyInjected.set(keyId, false);
    } else {
      // 未绑定（null，原生行为）或显式透传：照常回注
      fnKeyInjected.set(keyId, true);
      postKey(HID2VK[usage], true, flags);
    }
    return true;
  }
  if (!fnKeyInjected.has(keyId)) return false; // down 帧没经过策略（如启动瞬间），按普通键抬起
  const injected = fnKeyInjected.get(keyId);
  fnKeyInjected.delete(keyId);
  if (injected) postKey(HID2VK[usage], false, flags);
  return true;
}

// 当前物理修饰键 flags（AI 模式厂商码透传回注时带上，保证 Shift+F10 等组合键正确）
function currentModFlags() {
  return currentFlags(state.mod);
}

function postKey(vk, down, flags) {
  try {
    const ev = CG.createKey(CG.source, vk, down);
    CG.setFlags(ev, flags);
    CG.post(0, ev); // kCGHIDEventTap
    CG.release(ev);
    state.postOk = (state.postOk || 0) + 1;
  } catch (e) {
    state.postFail = (state.postFail || 0) + 1;
    // CGEventPost 对未授权是静默无效（不抛异常），这里只捕真异常留痕；
    // 「帧在收、注入在发、系统没反应」= 授权失效，对照流量统计即可判定
    if (state.postFail === 1 || state.postFail % 50 === 0) {
      console.log(`[inject] CGEvent 发送异常累计 ${state.postFail} 次: ${e.message}`);
    }
  }
}

function currentFlags(mod) {
  let f = 0;
  for (const m of MOD_BITS) if (mod & m.mask) f |= m.flag;
  return f;
}

// 喂入一条标准键盘报文：data = [2, modifier, reserved, k0..k5]
function feedKeyboardReport(data) {
  if (!IS_MAC) return;
  ensureCG();
  if (!CG) return;
  ensureRepeatTimer();

  const mod = data[1] || 0;
  const keys = new Set();
  let rollover = false;
  for (let i = 3; i < Math.min(9, data.length); i++) {
    if (data[i] === 0x01) rollover = true; // HID ErrorRollOver：6KRO 溢出/防冲突
    if (data[i] && data[i] !== 0x01) keys.add(data[i]);
  }
  // ErrorRollOver 帧不代表任何键的真实状态（滚键盘/手掌压键时出现）：
  // 按标准语义丢弃本帧，保留旧状态——否则 keys 为空集会误抬起所有已按住的键
  if (rollover) return;

  // 防御：蓝牙丢包会导致“抬起”帧丢失，state.keys 里残留的键永远不会被清。
  // 用报文时间戳兜底：若距上次报文 >500ms 且本次有按键事件，强制清空旧状态
  //（模拟一个全零帧的效果），避免“卡住按下”导致后续同键漏打。
  const now = Date.now();
  const sinceLast = now - (state.lastTs || now);
  state.lastTs = now;
  if (sinceLast > 500 && state.keys.size > 0) {
    console.log('[inject] 疑似丢包恢复：清空残留', state.keys.size, '个按下键');
    for (const k of state.keys) {
      const vk = HID2VK[k];
      if (vk !== undefined) postKey(vk, false, 0); // 含被屏蔽键：孤立抬起无害，保系统状态干净
    }
    state.keys.clear();
    state.downTs.clear();
    state.lastRep.clear();
    fnKeyInjected.clear();
  }

  // 修饰键变化（边沿）
  const modChanged = mod ^ state.mod;
  if (modChanged) {
    for (const m of MOD_BITS) {
      if (modChanged & m.mask) {
        const down = !!(mod & m.mask);
        // 修饰键自身的事件 flags 只带其余按下的修饰键
        const others = currentFlags(mod & ~m.mask);
        postKey(m.vk, down, others);
      }
    }
  }

  const flags = currentFlags(mod);

  // 抬起（先于按下，避免同帧互换时序问题）
  for (const k of state.keys) {
    if (!keys.has(k)) {
      state.downTs.delete(k);
      state.lastRep.delete(k);
      if (!dispatchFnKey(k, false, flags)) {
        const vk = HID2VK[k];
        if (vk !== undefined) postKey(vk, false, flags);
      }
    }
  }
  // 按下
  for (const k of keys) {
    if (!state.keys.has(k)) {
      state.downTs.set(k, Date.now());
      state.lastRep.delete(k);
      if (!dispatchFnKey(k, true, flags)) {
        const vk = HID2VK[k];
        if (vk !== undefined) postKey(vk, true, flags);
        else if (!state.unknownWarned?.has(k)) {
          (state.unknownWarned ||= new Set()).add(k);
          console.log(`[inject] 未映射键 usage=${k}（打字内容不受影响，此键暂不回注）`);
        }
      }
    }
  }

  state.mod = mod;
  state.keys = keys;
}

// 断线/切换时清状态，避免重连后边沿错乱（残留按下全部抬起）
function reset() {
  const flags = 0;
  for (const k of state.keys) {
    const vk = HID2VK[k];
    if (vk !== undefined) postKey(vk, false, flags);
  }
  for (const m of MOD_BITS) {
    if (state.mod & m.mask) postKey(m.vk, false, flags);
  }
  state.mod = 0;
  state.keys = new Set();
  state.downTs.clear();
  state.lastRep.clear();
  state.unknownWarned = new Set();
  fnKeyInjected.clear();
}

// 诊断：注入成功/失败计数（配合会话流量统计，判定「报文在收但系统没反应」的授权失效）
function getDiag() {
  return { postOk: state.postOk || 0, postFail: state.postFail || 0 };
}

module.exports = { feedKeyboardReport, reset, setFnKeyPolicy, currentModFlags, getDiag };

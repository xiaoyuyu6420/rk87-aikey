// AI 层：把任意键盘的 F 键区变成 12 个 AI 快捷键（无需 RK 键盘）
// 原理：RegisterHotKey 注册「触发键+F1~F12」系统级热键，WM_HOTKEY 到达后
// 执行对应槽位的动作（复用 actions.run：启动程序/网址/快捷键/AI 直达）。
// 热键由系统拦截，不会串到前台应用；不启用则完全不注册，F 键保持原样——
// （Copilot 键抢 Right Ctrl 骂声两年的教训：绝不默认抢占任何常用键）
//
// 线程模型：RegisterHotKey(NULL,…) 是线程级热键，WM_HOTKEY 投到注册线程的
// 消息队列——Node 主线程没有 Win32 消息循环，放 worker_threads 里跑
// GetMessage 循环（原生阻塞不影响主线程事件循环）。停止直接 terminate()：
// 线程死亡时 Windows 自动解除其全部线程热键，无需显式 Unregister。
// 仅 win32；其他平台 supported=false，UI 隐藏。

const { Worker } = require('worker_threads');
const path = require('path');

// RegisterHotKey 修饰符（winuser.h）
const MOD_ALT = 0x0001, MOD_CONTROL = 0x0002, MOD_NOREPEAT = 0x4000;

const SLOT_KEYS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'];
const VK = {};
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x70 + i - 1;

// 触发键方案。skip 列出的槽位不注册（Alt 方案必须保留 Alt+F4 给系统）
const TRIGGERS = {
  ctrlalt: { label: 'Ctrl+Alt + F1~F12', mods: MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, skip: [] },
  alt: { label: 'Alt + F1~F12', mods: MOD_ALT | MOD_NOREPEAT, skip: ['f4'] },
};

// Coding 预设（一键填入，用户可再改）：AI 直达/常用工具的组合示例。
// 动作形状与「按键映射」完全一致（actions.run 直接执行）。
const CODING_PRESET = {
  f1: { type: 'url', target: 'https://claude.ai' },
  f2: { type: 'url', target: 'https://chatgpt.com' },
  f3: { type: 'url', target: 'https://gemini.google.com' },
  f4: { type: 'hotkey', combo: 'Win+H' },        // Windows 系统语音输入（任意输入框可用）
  f5: { type: 'hotkey', combo: 'Win+Shift+S' },  // 截图
  f6: { type: 'app', target: 'C:/Windows/notepad.exe' }, // 快速记事（E2E 也用它验证）
};

const ACTION_TYPES = ['none', 'app', 'url', 'hotkey', 'macro', 'sys'];

// 配置规范化：任何来源（旧配置/手改 JSON/IPC）进来的 aiLayer 都收敛成安全形状
function normalizeAiLayer(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const trigger = raw.trigger === 'off' || TRIGGERS[raw.trigger] ? raw.trigger : 'ctrlalt';
  const slotsIn = raw.slots && typeof raw.slots === 'object' ? raw.slots : {};
  const slots = {};
  for (const k of SLOT_KEYS) {
    const a = slotsIn[k];
    slots[k] = a && typeof a === 'object' && ACTION_TYPES.includes(a.type) ? a : { type: 'none' };
  }
  return { enabled: raw.enabled === true, trigger, slots };
}

// 触发键 → 热键注册表。id = F 序号（1..12），alt 方案缺 f4（id 4 永不注册）
function buildHotkeys(triggerName) {
  const t = TRIGGERS[triggerName];
  if (!t) return [];
  return SLOT_KEYS
    .filter(k => !t.skip.includes(k))
    .map(k => ({ id: SLOT_KEYS.indexOf(k) + 1, key: k, vk: VK[k], mods: t.mods }));
}

// 槽位的人类可读热键名（UI/日志用）
function slotLabel(triggerName, key) {
  const t = TRIGGERS[triggerName] || TRIGGERS.ctrlalt;
  return `${t.label.split(' ')[0]}+${key.toUpperCase()}`;
}

function triggerOptions() {
  return Object.entries(TRIGGERS).map(([value, t]) => ({ value, label: t.label, skip: t.skip }));
}

// ---------- 运行态 ----------
let worker = null;
let workerTid = 0;          // worker 的 Win32 线程 ID（ready 消息上报，PostThreadMessage 用）
let hotkeyMap = new Map();  // id -> 'f1'.. 'f12'
let onTrigger = null;       // (key) => void
let lastFailed = [];
let restartCount = 0, lastStartAt = 0; // 自愈限次：防退出风暴

// 优雅退出用：PostThreadMessage(WM_QUIT) 让 GetMessageW 返回 0、线程真正死亡、
// 热键随之释放。terminate() 对阻塞在原生 GetMessage 的线程**无效且 Promise 悬挂**
// （实测：旧线程不死、热键不放、新 worker 注册必失败 → 改配置后热键坏死）。
const WM_QUIT = 0x0012;
let postQuit = null;
function ensurePostQuit() {
  if (postQuit !== null) return postQuit;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    postQuit = user32.func('int __stdcall PostThreadMessageW(uint32, uint32, uint64, int64)');
  } catch (_) { postQuit = null; }
  return postQuit;
}

function running() { return !!worker; }
function failedKeys() { return lastFailed.slice(); }

// 启动监听。trigger: 'ctrlalt'|'alt'；cb 在主线程执行（动作分发由调用方做）
function start(trigger, cb) {
  if (process.platform !== 'win32') return { ok: false, error: 'AI 层仅支持 Windows' };
  const hotkeys = buildHotkeys(trigger);
  if (!hotkeys.length) return { ok: false, error: `未知触发键方案 ${trigger}` };
  stop(); // 幂等：先清旧 worker（WM_QUIT 优雅退出，见下）
  onTrigger = cb;
  hotkeyMap = new Map(hotkeys.map(h => [h.id, h.key]));
  const w = new Worker(path.join(__dirname, 'ailayer-worker.js'), { workerData: { hotkeys } });
  worker = w;
  lastStartAt = Date.now();
  w.on('message', m => {
    if (m && m.type === 'ready') {
      lastFailed = Array.isArray(m.failed) ? m.failed : [];
      // 注意存的是 Win32 线程 ID（GetCurrentThreadId 的返回值）；Worker.threadId 是
      // Node 层的小整数递增 id，拿它 PostThreadMessage 会投错线程（WM_QUIT 无效）
      workerTid = Number(m.threadId) || 0;
      const okN = hotkeys.length - lastFailed.length;
      console.log(`[ailayer] 已注册 ${okN}/${hotkeys.length} 个热键（${TRIGGERS[trigger] ? TRIGGERS[trigger].label : trigger}）` +
        (lastFailed.length ? `；注册失败（重试后仍被占用）: ${lastFailed.join(', ')}` : ''));
    } else if (m && m.type === 'koffi-failed') {
      // 与「组合键被占用」是两类故障：这是环境坏了（AI 层整体不可用），别混进键列表
      console.log(`[ailayer] koffi 加载失败，AI 层不可用: ${m.error}`);
    } else if (m && m.type === 'hotkey') {
      const key = hotkeyMap.get(Number(m.id));
      if (key && onTrigger) {
        try { onTrigger(key); } catch (e) { console.log('[ailayer] 触发回调异常:', e.message); }
      }
    }
  });
  w.on('error', e => {
    if (worker === w) worker = null; // 崩溃后别让 running() 误报“还在监听”
    console.log('[ailayer] worker 异常退出，热键已全部注销:', e.message);
  });
  w.on('exit', code => {
    if (worker !== w) return; // stop() 换代或已清理，无需处理
    worker = null;
    workerTid = 0;
    console.log(`[ailayer] worker 意外退出(code=${code})，热键已全部注销`);
    // 自愈限次：10 秒窗口内最多自动重启 3 次，超过视为环境问题放弃
    if (Date.now() - lastStartAt > 10000) restartCount = 0;
    if (++restartCount <= 3) {
      console.log(`[ailayer] 自动重启 worker（第 ${restartCount} 次）...`);
      start(trigger, cb);
    } else {
      console.log('[ailayer] worker 反复退出，放弃自动重启——AI 层热键失效');
    }
  });
  return { ok: true, count: hotkeys.length };
}

// 停止 = 投 WM_QUIT 让消息循环自然返回（线程死亡 ⇒ Windows 自动注销其全部热键）；
// 1 秒后仍不退再 terminate 兜底（对阻塞线程多半无效，但 fire-and-forget 不悬挂）。
function stop() {
  if (worker) {
    const w = worker;
    const tid = workerTid; // 先取 Win32 线程 ID，再清状态
    worker = null;
    workerTid = 0;
    const post = ensurePostQuit();
    if (post && tid) {
      try { post(tid, WM_QUIT, 0, 0); } catch (_) { /* 优雅路径失败走兜底 */ }
    }
    const t = setTimeout(() => { try { w.terminate(); } catch (_) { /* 已退出 */ } }, 1000);
    if (t.unref) t.unref();
  }
  hotkeyMap = new Map();
  onTrigger = null;
  lastFailed = [];
}

module.exports = {
  start, stop, running, failedKeys,
  SLOT_KEYS, TRIGGERS, CODING_PRESET,
  buildHotkeys, normalizeAiLayer, slotLabel, triggerOptions,
};

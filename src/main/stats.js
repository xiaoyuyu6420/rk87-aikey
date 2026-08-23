// 打字统计：系统级键状态轮询 + 每键计数 / 每日总数
// - Windows: user32 GetAsyncKeyState；macOS: CoreGraphics CGEventSourceKeyState（查询键状态无需辅助功能权限）
// - 不装低级键盘钩子、不读键盘 HID，只读系统键状态，不会与系统抢键盘
// - 隐私红线：只记「每键计数」和「每日总数」，绝不记录按键顺序、时间戳序列、窗口/应用信息
// - 存储：userData/stats.json，防抖写盘（变更后 30s 或满 200 键），仅保留最近 90 天

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { VK_KEYNAMES } = require('./actions');

const POLL_MS = 15;                 // 轮询间隔
const FLUSH_AFTER_MS = 30 * 1000;   // 数据变更后 30s 落盘
const FLUSH_EVERY_KEYS = 200;       // 累计 200 键落盘一次
const KEEP_DAYS = 90;               // 只保留最近 90 天

// 修饰键（左右码位在系统层是分开的，表里只有一份，打字统计无意义）与无字符功能键不统计
const SKIP = new Set([
  'ctrl', 'shift', 'alt', 'option', 'win', 'cmd', 'command',
  'capslock', 'numlock', 'printscreen',
]);
for (let i = 13; i <= 24; i++) SKIP.add(`f${i}`); // F13-F24 与 mac 的 prtsc 等码位冲突，且基本不产生字符

function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class TypingStats {
  constructor(dir) {
    this.dir = dir || null; // 测试可注入目录；默认 userData
    this.days = {};         // { "YYYY-MM-DD": { total, keys: { name: count } } }
    this.timer = null;
    this.prev = null;       // 上一轮各键按下状态（边沿检测）
    this.getKeyState = null;
    this.pollCodes = [];
    this.pollNames = [];
    this.supported = process.platform === 'win32' || process.platform === 'darwin';
    this.started = false;
    this.loaded = false;
    this.dirty = false;
    this.lastDirtyTs = 0;
    this.pending = 0;
    this.todayKey = localDate();
    // 疲劳提醒：连续打字满阈值弹系统通知，停笔 1 分钟即断段，提醒后冷却
    this.fatigue = { enabled: true, minutes: 25 };
    this.lastKeyPressTs = 0;
    this.streakStartTs = 0;
    this.lastRemindTs = 0;
  }

  statsPath() {
    return path.join(this.dir || app.getPath('userData'), 'stats.json');
  }

  load() {
    this.days = {};
    try {
      const data = JSON.parse(fs.readFileSync(this.statsPath(), 'utf8'));
      if (data && typeof data.days === 'object' && data.days) this.days = data.days;
    } catch (_) { /* 首次启动或文件损坏：从空开始 */ }
    this.trim();
    this.loaded = true;
    this.todayKey = localDate();
    return this;
  }

  // 载入时裁剪：删除 90 天窗口之外的日期（YYYY-MM-DD 零填充，可安全字典序比较）
  trim() {
    const now = new Date();
    const cutoff = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (KEEP_DAYS - 1)));
    for (const k of Object.keys(this.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k < cutoff) delete this.days[k];
    }
  }

  // 初始化平台键状态查询（koffi），失败返回 false
  initKeyState() {
    const koffi = require('koffi');
    if (process.platform === 'win32') {
      const user32 = koffi.load('user32.dll');
      const fn = user32.func('short __stdcall GetAsyncKeyState(int)');
      this.getKeyState = code => (fn(code) & 0x8000) !== 0; // 最高位=当前按下
    } else if (process.platform === 'darwin') {
      const lib = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
      const fn = lib.func('bool CGEventSourceKeyState(uint32_t, uint16_t)');
      this.getKeyState = code => fn(0, code); // source=0 合并会话态
    } else {
      return false;
    }
    return true;
  }

  // VK_KEYNAMES 是「名字→码」，轮询要「码→名字」；同码多名取第一个非跳过名
  buildPollTable() {
    const byCode = new Map();
    for (const [name, code] of Object.entries(VK_KEYNAMES)) {
      if (SKIP.has(name) || !Number.isInteger(code)) continue;
      if (!byCode.has(code)) byCode.set(code, name);
    }
    this.pollCodes = [];
    this.pollNames = [];
    for (const [code, name] of byCode) {
      this.pollCodes.push(code);
      this.pollNames.push(name);
    }
  }

  start() {
    if (this.started) return true;
    if (!this.supported) return false; // Linux 等：静默不支持
    try {
      if (!this.initKeyState()) return false;
      this.buildPollTable();
    } catch (e) {
      this.supported = false; // koffi 加载失败等：不影响主进程
      return false;
    }
    if (!this.loaded) this.load();
    this.prev = new Uint8Array(this.pollCodes.length);
    this.todayKey = localDate();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.timer.unref && this.timer.unref();
    this.started = true;
    return true;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.prev = null;
    this.started = false;
    this.flush();
  }

  tick() {
    // 跨天换桶
    const today = localDate();
    if (today !== this.todayKey) {
      this.todayKey = today;
      this.trim();
    }
    // 边沿检测：上一轮未按下 & 本轮按下 = 一次击键
    const gs = this.getKeyState;
    for (let i = 0; i < this.pollCodes.length; i++) {
      const down = gs(this.pollCodes[i]) ? 1 : 0;
      if (down && !this.prev[i]) this.count(this.pollNames[i]);
      this.prev[i] = down;
    }
    // 防抖落盘：距最后一次变更满 30s
    if (this.dirty && Date.now() - this.lastDirtyTs >= FLUSH_AFTER_MS) this.flush();
    // 疲劳检测：停笔超 1 分钟断段
    if (this.streakStartTs && Date.now() - this.lastKeyPressTs > 60 * 1000) {
      this.streakStartTs = 0;
    }
    if (this.streakStartTs &&
        this.fatigue.enabled &&
        Date.now() - this.streakStartTs >= this.fatigue.minutes * 60 * 1000 &&
        Date.now() - this.lastRemindTs >= 10 * 60 * 1000) {
      this.lastRemindTs = Date.now();
      this.streakStartTs = Date.now(); // 从提醒时刻重新计段，避免每 tick 重复弹
      this.notifyFatigue();
    }
  }

  notifyFatigue() {
    try {
      const { Notification } = require('electron');
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: '该歇歇手了',
        body: `已连续打字 ${this.fatigue.minutes} 分钟，起来活动一下手腕吧`,
        silent: false,
      });
      n.show();
    } catch (_) { /* 通知失败不影响统计 */ }
  }

  count(name) {
    const d = this.days[this.todayKey] || (this.days[this.todayKey] = { total: 0, keys: {} });
    d.total++;
    d.keys[name] = (d.keys[name] || 0) + 1;
    this.dirty = true;
    this.lastDirtyTs = Date.now();
    const now = Date.now();
    this.lastKeyPressTs = now;
    if (!this.streakStartTs) this.streakStartTs = now; // 从闲到忙，开始新段
    if (++this.pending >= FLUSH_EVERY_KEYS) this.flush(); // 满 200 键立即落盘
  }

  flush() {
    this.pending = 0;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const p = this.statsPath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ days: this.days }), 'utf8');
      fs.renameSync(tmp, p); // 原子替换，避免写一半损坏
    } catch (_) {
      // 写盘失败（卷满/权限）：不能就此转为每 tick 重试——lastDirtyTs 停更会让
      // 每个轮询周期都触发一次同步写风暴（每 15ms 四连 syscall，打字回注抖动）。
      // 把 lastDirtyTs 拨到未来：60s 内不再自动重试（有新击键仍会满 200 键落盘）
      this.dirty = true;
      this.lastDirtyTs = Date.now() + 60000;
      if (!this._failLogged) {
        this._failLogged = true;
        console.log('[stats] 落盘失败（60s 后重试）:', _ && _.message);
      }
    }
  }

  // 供 stats-get IPC：今日摘要 + 近 7 天
  summary() {
    const today = this.days[localDate()] || { total: 0, keys: {} };
    const topKeys = Object.entries(today.keys)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    const week = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const ds = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
      week.push({ date: ds, total: (this.days[ds] || {}).total || 0 });
    }
    return { supported: this.supported, today: { total: today.total || 0, topKeys, keys: today.keys || {} }, week };
  }
}

module.exports = { TypingStats };

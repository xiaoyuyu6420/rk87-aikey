// 打字统计：系统级键状态轮询 + 每键计数 / 每日总数
// - Windows: user32 GetAsyncKeyState；macOS: CoreGraphics CGEventSourceKeyState（查询键状态无需辅助功能权限）
// - 不装低级键盘钩子、不读键盘 HID，只读系统键状态，不会与系统抢键盘
// - 隐私红线：只记「每键计数」和「每日总数」，绝不记录按键顺序、时间戳序列、窗口/应用信息
// - 存储：userData/stats.json，防抖写盘（变更后 30s 或满 200 键），仅保留最近 90 天

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const { VK_KEYNAMES } = require('./actions');

const POLL_MS = 15;                 // 活跃轮询间隔（检测到击键后 10s 内）
const IDLE_POLL_MS = 30;            // 空闲轮询间隔：CPU 唤醒减半；30ms 仍能抓到 ≥40ms 的按键边沿
const IDLE_AFTER_MS = 10 * 1000;    // 距上次击键边沿超过此时长进入空闲档
const FLUSH_AFTER_MS = 30 * 1000;   // 数据变更后 30s 落盘
const FLUSH_EVERY_KEYS = 200;       // 累计 200 键落盘一次
const KEEP_DAYS = 90;               // 只保留最近 90 天

// 音效黑名单：这些键计数（热力图要显示所有按键）但不发击键事件——
// 产品文案「修饰键不响」。f13-f24 跳过轮询：与 mac 的 prtsc 等码位冲突，且实体不存在
const NO_SOUND = new Set([
  'ctrl', 'shift', 'alt', 'option', 'win', 'cmd', 'command',
  'capslock', 'numlock', 'printscreen',
]);
const SKIP_POLL = new Set();
for (let i = 13; i <= 24; i++) SKIP_POLL.add(`f${i}`);

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
    this.counting = true;      // 是否计数（统计关但音效开时轮询照跑、计数跳过）
    this.onKeystroke = null;   // 击键边沿回调（打字音效事件源；null=无订阅零开销）
    this.lastDirtyTs = 0;
    this.pending = 0;
    this.todayKey = localDate();
    // 疲劳提醒：连续打字满阈值弹系统通知，停笔 1 分钟即断段，提醒后冷却
    this.fatigue = { enabled: true, minutes: 25 };
    this.lastKeyPressTs = 0;
    this.streakStartTs = 0;
    this.lastRemindTs = 0;
    this._lastEdgeTs = 0;   // 最近一次键边沿时刻（空闲降频判定）
    this._dayEndTs = 0;     // 当前日的午夜时刻（跨天检测，免每 tick 拼日期字符串）
    this._flushing = false; // 异步落盘进行中（防并发写）
    // 轴体寿命：独立持久化 lifetime.json，不受 90 天裁剪影响，软件更新不丢
    this.lifetime = { total: 0, keys: {} };
    this._lifeDirty = false;
    this._lifeFlushing = false;
    this._lifeFailLogged = false;
  }

  statsPath() {
    return path.join(this.dir || app.getPath('userData'), 'stats.json');
  }

  lifetimePath() {
    return path.join(this.dir || app.getPath('userData'), 'lifetime.json');
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
    this.loadLifetime();
    // 一次性迁移：lifetime.json 不存在 → 用 days 聚合值初始化（数字只增不减），
    // 之后以 lifetime.json 为准增量累加
    if (!fs.existsSync(this.lifetimePath())) {
      for (const d of Object.values(this.days)) {
        this.lifetime.total += d.total || 0;
        for (const [name, count] of Object.entries(d.keys || {})) {
          this.lifetime.keys[name] = (this.lifetime.keys[name] || 0) + count;
        }
      }
      if (this.lifetime.total) this._lifeDirty = true; // 下次 flush 落盘
    }
    return this;
  }

  // 轴体寿命载入：独立文件、独立结构，任何软件更新/90 天裁剪都不影响
  loadLifetime() {
    try {
      const d = JSON.parse(fs.readFileSync(this.lifetimePath(), 'utf8'));
      if (d && typeof d.total === 'number') {
        this.lifetime = { total: d.total, keys: d.keys && typeof d.keys === 'object' ? d.keys : {} };
      }
    } catch (_) { /* 不存在或损坏：从零开始 */ }
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
      if (SKIP_POLL.has(name) || !Number.isInteger(code)) continue;
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
    // 自适应轮询：活跃 15ms / 空闲 30ms。setInterval 换挡要销毁重建，自调度
    // setTimeout 每轮按最新档位排下一拍即可
    const self = this;
    const schedule = () => {
      const delay = (this._lastEdgeTs && Date.now() - this._lastEdgeTs < IDLE_AFTER_MS)
        ? POLL_MS : IDLE_POLL_MS;
      this.timer = setTimeout(() => {
        if (!self.timer) return; // stop() 已清
        self.tick();
        if (self.timer) schedule();
      }, delay);
      this.timer.unref && this.timer.unref();
    };
    this.timer = null;
    schedule();
    this.started = true;
    return true;
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.prev = null;
    this.started = false;
    this._flushSync(); // 退出路径同步落盘（app 退出不等异步 IO）
    this._flushLifeSync(); // 轴体寿命同样同步落盘
  }

  tick() {
    // 跨天换桶：比较下次午夜时刻，免每 tick 三次 padStart 拼字符串（66 次/s）
    const now = Date.now();
    if (now >= this._dayEndTs) {
      this.todayKey = localDate();
      this.trim();
      const d = new Date(now);
      this._dayEndTs = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    }
    // 边沿检测：上一轮未按下 & 本轮按下 = 一次击键
    const gs = this.getKeyState;
    for (let i = 0; i < this.pollCodes.length; i++) {
      const down = gs(this.pollCodes[i]) ? 1 : 0;
      if (down && !this.prev[i]) {
        this._lastEdgeTs = now;
        const name = this.pollNames[i];
        if (this.onKeystroke && !NO_SOUND.has(name)) this.onKeystroke(name); // 音效订阅（修饰键不响）
        if (this.counting) this.count(name);          // 计数全量：热力图显示所有按键
      }
      this.prev[i] = down;
    }
    // 防抖落盘：距最后一次变更满 30s
    if (this.dirty && now - this.lastDirtyTs >= FLUSH_AFTER_MS) this.flush();
    this._dirtyTick();
    // 疲劳检测：停笔超 1 分钟断段
    if (this.streakStartTs && now - this.lastKeyPressTs > 60 * 1000) {
      this.streakStartTs = 0;
    }
    if (this.streakStartTs &&
        this.fatigue.enabled &&
        now - this.lastKeyPressTs >= this.fatigue.minutes * 60 * 1000 &&
        now - this.lastRemindTs >= 10 * 60 * 1000) {
      this.lastRemindTs = now;
      this.streakStartTs = now; // 从提醒时刻重新计段，避免每 tick 重复弹
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
    // 轴体寿命累计（独立 lifetime.json，不看 90 天窗口）
    this.lifetime.total++;
    this.lifetime.keys[name] = (this.lifetime.keys[name] || 0) + 1;
    this._lifeDirty = true;
    const now = Date.now();
    this.lastKeyPressTs = now;
    if (!this.streakStartTs) this.streakStartTs = now; // 从闲到忙，开始新段
    if (++this.pending >= FLUSH_EVERY_KEYS) this.flush(); // 满 200 键立即落盘
  }

  // 运行期落盘走异步：90 天全量 JSON 序列化后写盘要几 ms，同步 IO 会抖动
  // 15ms 轮询边沿检测和 120ms 音频批（推流期打字可能丢键计数/爆音）
  async flush() {
    if (!this.dirty || this._flushing) return;
    this._flushing = true;
    this.pending = 0;
    const snapshot = JSON.stringify({ days: this.days });
    this.dirty = false; // 快照即清脏；写盘 await 期间的新击键会重新标脏，下轮补写
    const p = this.statsPath();
    const tmp = p + '.tmp';
    let err = null;
    try {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, p); // 原子替换，避免写一半损坏
    } catch (e) { err = e; }
    this._flushing = false;
    if (err) this._flushFail(err);
    this.flushLifetime(); // 天数落盘后顺手把 lifetime 也落盘（同一防抖节奏）
  }

  // 轴体寿命落盘（独立文件，异步）
  async flushLifetime() {
    if (!this._lifeDirty || this._lifeFlushing) return;
    this._lifeFlushing = true;
    const snapshot = JSON.stringify(this.lifetime);
    this._lifeDirty = false;
    const p = this.lifetimePath();
    const tmp = p + '.tmp';
    try {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, p);
    } catch (e) {
      this._lifeDirty = true;
      if (!this._lifeFailLogged) {
        this._lifeFailLogged = true;
        console.log('[stats] lifetime 落盘失败:', e && e.message);
      }
    }
    this._lifeFlushing = false;
  }

  _flushFail(e) {
    // 写盘失败（卷满/权限）：不能就此转为每 tick 重试——lastDirtyTs 停更会让
    // 每个轮询周期都触发一次写风暴。把 lastDirtyTs 拨到未来：60s 内不再自动重试
    //（有新击键仍会满 200 键落盘）
    this.dirty = true;
    this.lastDirtyTs = Date.now() + 60000;
    if (!this._failLogged) {
      this._failLogged = true;
      console.log('[stats] 落盘失败（60s 后重试）:', e && e.message);
    }
  }

  // 级联触发：stats 刷盘的同时把 lifetime 也刷（满 200 键的高频路径已由 flush() 级联）
  _dirtyTick() {
    if (this._lifeDirty && Date.now() - this.lastDirtyTs >= FLUSH_AFTER_MS) this.flushLifetime();
  }

  // 退出路径：同步落盘（before-quit 不等异步 IO，异步写会丢最后一次数据）
  _flushLifeSync() {
    if (!this._lifeDirty) return;
    try {
      const p = this.lifetimePath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.lifetime), 'utf8');
      fs.renameSync(tmp, p);
      this._lifeDirty = false;
    } catch (e) { /* 落盘失败不阻塞退出 */ }
  }

  // 退出路径：同步落盘（before-quit 不等异步 IO，异步写会丢最后一次数据）
  _flushSync() {
    if (!this.dirty) return;
    try {
      const p = this.statsPath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ days: this.days }), 'utf8');
      fs.renameSync(tmp, p);
      this.dirty = false;
    } catch (e) {
      this._flushFail(e);
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
    // 近 30 天（每日打字报告的月视图；days 只留 90 天，30 天窗口必然完整）
    const month = [];
    for (let i = 29; i >= 0; i--) {
      const ds = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
      month.push({ date: ds, total: (this.days[ds] || {}).total || 0 });
    }
    // 轴体寿命：独立 lifetime.json 的全历史累计（不受 90 天裁剪/软件更新影响）
    return { supported: this.supported, today: { total: today.total || 0, topKeys, keys: today.keys || {} }, week, month, lifetime: this.lifetime };
  }
}

module.exports = { TypingStats };

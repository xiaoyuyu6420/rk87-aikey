// RK87 AIKey 主进程：托盘 + 设置窗口 + HID 监听 + 动作分发

const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, shell, powerSaveBlocker, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { KeyboardWatcher } = require('./hid');
const { KeySession } = require('./kb-session');
const { lookupKey, allKeys } = require('./keymap');
const { MicPipeline } = require('./mic');
const { TypingStats } = require('./stats');
const { FgWatcher } = require('./fgwatch');
const { MacroRecorder, replayMacro, abortReplay, trimSteps, RECORD_MAX_MS } = require('./macro');
const actions = require('./actions');
const kbdInject = require('./kbd-inject');
const config = require('./config');

let tray = null;
let win = null;
let cfg = null;
let watcher = null;
let session = null;       // 键盘命令会话（蓝牙/2.4G 口：心跳/验证/开麦）
let sessionOnline = false;
let deviceConnected = false;
let isQuitting = false;
let micPipeline = null;
let stats = null;          // 打字统计（系统级键状态轮询，只记计数）
let pcmBatch = [];       // 攒 ~120ms 批量下发渲染进程
let pcmBatchTimer = null;
let psBlockerId = null;    // 推流期电源阻塞（防 App Nap 拖慢主进程 timer）
let audioDedup = [];       // 双连接（USB+蓝牙）重复音频帧去重（短窗）
let lowBatNotified = false; // 低电量一次性提醒（充电/回血后重新武装）
let fg = null;              // 前台应用检测（配置档自动切档事件源，规则空时零开销）
let manualAtProc = null;    // 手动切档时的前台进程名（null=无 override，自动规则可接管）
let macroRec = null;        // 宏录制器（仅录制期间存在 5ms 轮询）
let macroArmed = false;     // 录制期间：抑制绑定动作/开麦联动，绑定键强制透传（键状态可见才能录到）
let soundWin = null;        // 打字音效隐藏页（0x0 常驻；关闭音效时不创建，零开销）

// 常驻托盘应用：瞬时异常（如 stdout 管道断开的 EPIPE）吞掉保活；
// 但短窗内连续异常说明主进程已进坏状态 → 自动拉起新实例自愈。
// （僵尸态的危害不止功能失灵：F10 长按无人应答 cmd=3，固件会走「Win+R 引导下载」）
const CRASH_WINDOW_MS = 60 * 1000;
const CRASH_MAX_IN_WINDOW = 3;
let crashTimes = [];
process.on('uncaughtException', e => {
  try { console.log('[uncaught]', e && e.message); } catch (_) {}
  const now = Date.now();
  crashTimes = crashTimes.filter(t => now - t < CRASH_WINDOW_MS);
  crashTimes.push(now);
  if (!isQuitting && crashTimes.length >= CRASH_MAX_IN_WINDOW) {
    try { console.log('[uncaught] 短窗内连续异常，判定坏状态，自动重启'); } catch (_) {}
    try { releaseDevices(); } catch (_) {} // app.exit 不走 before-quit，清理须手动
    app.relaunch({ args: [...process.argv.slice(1), '--crash-restart'] });
    app.exit(1);
  }
});

// 渲染进程崩溃：托盘应用不能没 UI，重载窗口即可，不必整体重启
app.on('render-process-gone', (_e, _wc, details) => {
  try { console.log('[render-gone]', details && details.reason); } catch (_) {}
  if (win && !win.isDestroyed()) win.webContents.reload();
});

// ---------- 文件日志 ----------
// 打包版（安装版）的 console 输出默认丢弃，出问题无从诊断——把所有
// console.log 落盘到 userData/logs/app.log（超 2MB 轮转为 app.old.log），
// 托盘菜单可一键打开日志文件夹。纯只读观测，不影响任何行为。
function initFileLog() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'app.log');
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, path.join(dir, 'app.old.log'));
    } catch (_) {}
    const stream = fs.createWriteStream(file, { flags: 'a' });
    const orig = console.log;
    console.log = (...args) => {
      orig(...args);
      try {
        stream.write(new Date().toISOString() + ' ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
      } catch (_) {}
    };
  } catch (_) {}
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow()); // mac：点 Dock/应用图标重新弹设置窗口
  app.whenReady().then(boot).then(() => {
    // 崩溃自启后的新实例：让用户知道刚才发生过异常重启（而非静默吞掉）
    if (process.argv.includes('--crash-restart')) {
      try {
        const n = new Notification({ title: 'RK87 AIKey', body: '检测到异常退出，已自动重启' });
        n.on('click', () => showWindow());
        n.show();
      } catch (_) {}
    }
  });
}

// 共享音频包处理：双连接（USB+蓝牙同时活跃）时同一帧可能两路各到一次，
// 短窗去重后再解码，避免 PCM 翻倍速/杂音
let wiredPcmAccum = null;  // USB 口 PCM 攒批（凑 ≥240 样本再进 pcmBatch，对齐 BT 的批处理节奏）

function onAudioPacket(buf, opts = {}) {
  try {
    if (opts.rawPcm) {
      // USB 口（0x1C 帧）：帧内已是 16kHz int16 PCM，跳过 SBC 解码直接进 DSP 链
      if (buf.length < 64) return;
      startPsBlocker();
      flushMicPassthrough();
      if (!micPipeline) micPipeline = new MicPipeline();
      const chunk = micPipeline.pushWiredFrame(buf);
      if (chunk.length) { // 管线内部按 160 样本块出数，不足时返回空
        wiredPcmAccum = wiredPcmAccum ? Buffer.concat([wiredPcmAccum, chunk]) : chunk;
        if (wiredPcmAccum.length >= 480) {
          enqueuePcm(wiredPcmAccum);
          wiredPcmAccum = null;
        }
      }
      return;
    }
    if (buf.length < 62) return;
    const key = buf[1] * 65536 + buf[2] + buf[3] * 256;
    const now = Date.now();
    audioDedup = audioDedup.filter(e => now - e.ts < 120);
    if (audioDedup.some(e => e.key === key)) return;
    audioDedup.push({ key, ts: now });

    startPsBlocker(); // 推流期防 App Nap 拖慢主进程 timer（pcmBatch/hbTimer）
    flushMicPassthrough(); // 等音频流建立的透传 down：流已到，触发透传

    if (!micPipeline) micPipeline = new MicPipeline();
    const chunk = micPipeline.pushPacket(buf);
    if (chunk.length) enqueuePcm(chunk);
  } catch (e) {
    console.log('[mic] 解码失败:', e.message);
  }
}

function enqueuePcm(chunk) {
  pcmBatch.push(chunk);
  if (!pcmBatchTimer) {
    pcmBatchTimer = setTimeout(() => {
      pcmBatchTimer = null;
      if (pcmBatch.length && win && !win.isDestroyed()) {
        win.webContents.send('mic-pcm', Buffer.concat(pcmBatch));
      }
      pcmBatch = [];
    }, 120);
  }
}

function startPsBlocker() {
  if (psBlockerId === null || !powerSaveBlocker.isStarted(psBlockerId)) {
    psBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  }
}
function stopPsBlocker() {
  if (psBlockerId !== null && powerSaveBlocker.isStarted(psBlockerId)) {
    powerSaveBlocker.stop(psBlockerId);
  }
  psBlockerId = null;
}

function boot() {
  initFileLog(); // 先于一切业务日志初始化
  // mac 菜单栏应用：Dock 不占位（点 x 关窗后只剩顶部状态栏图标；窗口随时可从托盘唤回）
  if (process.platform === 'darwin') app.dock.hide();
  cfg = config.load();

  watcher = new KeyboardWatcher();
  // USB 口（8102）会话在线时，watcher 与 session 打开的是同一个厂商接口，
  // 同一份按键/AI 模式/麦克风报文会被两路各收一次 → 由 session 独占处理，watcher 让位
  const usbSessionOwns = () => !!(session && session.connected && session.transport === 'USB');
  watcher.on('key', e => { if (!usbSessionOwns()) onKey(e); });
  watcher.on('ai-mode', ({ on }) => { if (!usbSessionOwns()) onAiMode(on); });
  watcher.on('device', ({ connected }) => {
    deviceConnected = connected;
    if (!connected) releasePassthrough(); // 有线拔出时透传按下的键兜底抬起
    if (win) win.webContents.send('device-status', connected);
  });
  // 有线口（8102）的音频流/麦克风状态同样进主管线（纯有线连接时语音才不至于静默失效）
  watcher.on('audio', buf => { if (!usbSessionOwns()) onAudioPacket(buf); });
  watcher.on('mic', ({ on }) => {
    if (!usbSessionOwns() && win) win.webContents.send('mic-state', on);
  });
  watcher.start();

  // 键盘命令会话：蓝牙口心跳+验证，驱动固件开麦（完全自主，无需官方 RK-AI）
  session = new KeySession();
  session.on('key', onKey); // 蓝牙连接时按键上报走会话口
  session.on('ai-mode', ({ on }) => onAiMode(on));
  session.on('state', ({ connected, reason }) => {
    sessionOnline = connected;
    console.log(`[session] ${connected ? '在线' : '离线' + (reason ? '（' + reason + '）' : '')}`);
    if (!connected) releasePassthrough(); // 会话断开时透传按下的键兜底抬起
    if (win) win.webContents.send('session-status', connected);
  });
  session.on('mic', ({ on }) => {
    if (win) win.webContents.send('mic-state', on);
    if (!on) stopPsBlocker();
  });
  // USB 口音频是原始 PCM（rawPcm），蓝牙/2.4G 是 SBC 编码——按 transport 分流
  session.on('audio', buf => onAudioPacket(buf, { rawPcm: session.transport === 'USB' }));
  // 电量上报（cmd=208，键盘主动推）：徽章 + 托盘 tooltip + 低电量一次性通知
  session.on('battery', b => {
    if (win && !win.isDestroyed()) win.webContents.send('battery', b);
    if (tray) {
      tray.setToolTip(`RK87 AIKey — ${b.charging ? '充电中 ' : ''}${b.level}%` +
        (sessionOnline ? ` · 链路 ${Math.round(session.rttAvg || 0)}ms` : ' · 离线'));
    }
    if (!b.charging && b.level < 20 && !lowBatNotified) {
      lowBatNotified = true;
      const n = new Notification({ title: 'RK87 AIKey', body: `键盘电量不足 ${b.level}%，记得充电` });
      n.show();
    } else if (b.charging || b.level >= 30) {
      lowBatNotified = false; // 插上电/回血后重新武装提醒
    }
  });
  session.start();

  // 音频管线预热：降噪引擎异步初始化（未就绪期自动旁路，其余 DSP 照常）
  micPipeline = new MicPipeline({ denoise: cfg.settings.denoiseEnabled !== false });
  micPipeline.initDenoiser().then(engine => {
    if (engine === 'df') console.log('[mic] DeepFilterNet3 降噪已就绪');
    else if (engine === 'rnnoise') console.log('[mic] RNNoise 降噪已就绪（DFN3 回退）');
  });

  // 普通（非 AI）模式（mac）：F1-F12/PrtSc 走标准报文进回注模块；绑定了动作的键在此拦截。
  // 返回 'block'=屏蔽原键、'passthrough'=动作+原键都触发、null=未绑定走原生回注
  kbdInject.setFnKeyPolicy(keyId => {
    if (aiModeOn) {
      // 功能键出现在标准报文 = 键盘实际处于普通模式。注意：onAiMode 会调
      // kbdInject.reset() 清边沿状态——不能在 feedKeyboardReport 的调用栈内同步执行
      //（会破坏本次报文 diff 的进行时状态，导致已按住的键被误判新按下=双字符），
      // 挪到下一个事件循环
      setImmediate(() => onAiMode(false));
    }
    const binding = (cfg.bindings && cfg.bindings[keyId]) || { type: 'none' };
    if (macroArmed) return null; // 宏录制中：不拦截不执行，走原生回注（键状态系统层可见）
    if (binding.type === 'none') return null;
    console.log(`[key] ${keyId} down（标准报文，已拦截）`);
    if (win && !win.isDestroyed()) win.webContents.send('key-event', { keyId, phase: 'down' });
    const r = actions.run(binding);
    if (r && r.ok === false) console.log(`[action] ${keyId} 失败:`, r.error);
    return binding.passthrough === true ? 'passthrough' : 'block';
  });

  // 打字统计：先载入历史（禁用时也能看），启用才开轮询
  //（统计关但音效开：轮询照跑、计数跳过——keystroke 事件仍要发）
  stats = new TypingStats().load();
  stats.fatigue = {
    enabled: cfg.settings.fatigueEnabled !== false,
    minutes: Math.max(5, Number(cfg.settings.fatigueMinutes) || 25),
  };
  stats.counting = cfg.settings.statsEnabled !== false;
  if (cfg.settings.statsEnabled !== false || cfg.settings.soundEnabled) stats.start();

  // 打字音效：击键边沿 → 隐藏页播放（窗口仅在启用时创建）
  if (cfg.settings.soundEnabled) createSoundWindow();
  stats.onKeystroke = () => {
    if (cfg.settings.soundEnabled && soundWin && !soundWin.isDestroyed()) {
      soundWin.webContents.send('keystroke');
    } else if (!stats.onKeystroke._warned) {
      stats.onKeystroke._warned = true;
      console.log('[sound] 击键事件丢弃：enabled=', cfg.settings.soundEnabled, '窗口=', !!soundWin);
    }
  };

  // 键位动作里的系统操作（profile-cycle：按键循环切档）
  actions.setSysHandler(op => {
    if (op === 'profile-cycle') { cycleProfile(); return { ok: true }; }
    return { ok: false, error: `未知系统动作 ${op}` };
  });
  // 宏回放执行体（发键复用透传同款底层，与「发送快捷键」一致）
  actions.setMacroRunner(steps => replayMacro(steps, (name, down) => actions.postRawKey(name, down, 0))
    ? { ok: true }
    : { ok: false, error: '回放进行中或宏为空' });

  // 前台应用检测 → 配置档自动切档（appRules 为空时不启动，零开销）
  fg = new FgWatcher();
  fg.onChange = onFgChange;
  syncFgWatcher();

  // 精简 macOS 菜单栏：默认 7 项菜单太宽，刘海屏上会把右侧菜单栏图标挤掉；
  // 只留 app 名 + Edit（输入框的复制/粘贴/全选快捷键依赖 editMenu）
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
    ]));
  }

  createTray();
  if (cfg.settings.autostart) setAutostart(true);

  showWindow(); // 启动即打开设置窗口（关闭窗口=隐藏到托盘）
}

let aiModeOn = false;

// ---------- 配置档切换 ----------
// 切档 = 换 activeId + 重新投影（顶层 bindings 引用指向新档）+ 落盘 + 托盘/界面同步
function switchProfile(id, reason) {
  if (!config.setActive(cfg, id)) return false;
  config.save(cfg);
  rebuildTrayMenu();
  console.log(`[profile] 切到「${cfg.profiles.names[id] || id}」（${reason}）`);
  if (win && !win.isDestroyed()) {
    win.webContents.send('profile-changed', { id, reason, name: cfg.profiles.names[id] || id });
  }
  return true;
}

// 手动切档（托盘/界面/按键循环）：记 override——切档时的前台进程不变期间，
// 自动规则不接管；前台换到别的进程后恢复自动
function manualSwitch(id) {
  if (switchProfile(id, 'manual') && fg) manualAtProc = fg.lastProc;
}

function cycleProfile() {
  const order = cfg.profiles.order;
  const next = order[(order.indexOf(cfg.profiles.activeId) + 1) % order.length];
  if (next) manualSwitch(next);
}

function onFgChange(proc) {
  if (manualAtProc !== null) {
    if (proc !== manualAtProc) manualAtProc = null; // 前台已换进程，恢复自动接管
    else return; // 用户手动选择仍有效
  }
  const rule = (cfg.appRules || []).find(r => String(r.name).toLowerCase() === proc);
  if (rule && rule.profileId !== cfg.profiles.activeId) switchProfile(rule.profileId, `自动：${proc}`);
}

// 有规则才启动前台检测；规则空/全失效则停（开关关闭零开销）
function syncFgWatcher() {
  const rules = (cfg.appRules || []).filter(r => cfg.profiles.order.includes(r.profileId));
  if (rules.length) fg.start();
  else fg.stop();
}

function profilesState() {
  return {
    order: cfg.profiles.order,
    names: cfg.profiles.names,
    activeId: cfg.profiles.activeId,
    appRules: cfg.appRules,
    max: config.MAX_PROFILES,
    fgSupported: fg ? fg.supported : false,
  };
}

// AI 模式切换：功能键从标准报文切到厂商码上报（或切回），影响透传/拦截路径的选择
function onAiMode(on) {
  if (aiModeOn === on) return;
  aiModeOn = on;
  console.log(`[ai-mode] ${on ? '进入 AI 模式（功能键改走厂商码上报）' : '退出 AI 模式（功能键恢复标准报文）'}`);
  if (win && !win.isDestroyed()) win.webContents.send('ai-mode', on);
  // 切换瞬间两条上报路径互换，按住中的键不会有对应的抬起报文：
  // 两侧边沿状态全部清空 + 已回注的键抬起，避免系统键状态卡住
  releasePassthrough();
  kbdInject.reset();
}

// 多连接（如 USB+蓝牙/2.4G 并存）时同一按键会从两个口各报一次，全局去重
let lastGlobalKey = null;
// 透传回注的 down 决定（keyId -> down 时是否已回注）。up 按记录执行，
// 防止按住期间修改配置导致 down/up 不配对、系统键状态卡住
const ptDecision = new Map();

function onKey({ code, keyId, phase }) {
  const now = Date.now();
  if (lastGlobalKey && lastGlobalKey.keyId === keyId && lastGlobalKey.phase === phase && now - lastGlobalKey.ts < 80) return;
  lastGlobalKey = { keyId, phase, ts: now };
  if (!aiModeOn) onAiMode(true); // cmd=159 到达 = 键盘实际处于 AI 模式（209 事件可能在启动前已错过）
  const def = lookupKey(code) || { id: keyId, label: keyId };
  console.log(`[key] ${def.label} (${keyId}) ${phase}`);
  if (win && !win.isDestroyed()) {
    win.webContents.send('key-event', { code, keyId: def.id, label: def.label, phase });
  }
  // 开麦键联动：按住 = 主动开麦，松开 = 关麦（键可在设置里勾选，默认 F10 + AI 键；空 = 全关）
  //（宏录制期间抑制：录宏不应触发语音推流）
  let micAsked = false; // 开麦命令是否真正发出（离线时 false → 透传不等流）
  const micKeys = cfg.settings.micTriggerKeys || [];
  if (!macroArmed && micKeys.includes(keyId) && session) {
    if (phase === 'down') micAsked = session.askVoice();
    else session.stopVoice();
  }
  // cmd=159 厂商码只在 AI 模式上报 → 此路径一律用 AI 模式绑定集
  const binding = (cfg.bindingsAi && cfg.bindingsAi[keyId]) || { type: 'none' };
  // 动作只在按下触发（宏录制期间抑制动作执行）
  if (phase === 'down' && binding.type !== 'none' && !macroArmed) {
    const result = actions.run(binding);
    if (result && result.ok === false) {
      console.log(`[action] ${keyId} 失败:`, result.error);
    }
  }
  // 透传：未绑定任何动作（完全原生）、勾了透传、或宏录制中（强制——AI 模式厂商码
  // 路径的系统键状态由本应用回注合成，不透传则 GetAsyncKeyState 看不到，录不进宏）
  //（回注让用户在目标窗口看到真实输入反馈，一举两得）
  passthroughKey(keyId, phase, macroArmed || binding.passthrough === true || binding.type === 'none', micAsked);
}

// 透传回注（AI 模式厂商码路径）。down 时记下决定，up 按记录执行；
// 无键码的键（AI 键/扩展键位，无原功能可言）发送失败不记状态。
// 麦克风触发键的 down 透传等音频流真正建立（事件驱动）：
//   固件开麦→PCM 推流耗时随蓝牙状态浮动（实测数百 ms 且方差大），固定延迟
//   既可能不够（输入法录到开头静音=「检测不到麦克风」）也可能太长。
//   现在：开麦命令发出后，等第一包音频帧到达（再留 200ms 给 renderer 桥消费），
//   或 PT_MIC_TIMEOUT 超时兜底；流本就活跃则立即透传。会话离线（命令没发出）
//   时不等待，立即透传，保持点击语义。
// 快速点按（流未到就松开）则立即补发 down+up，语义不丢。
const PT_MIC_TIMEOUT = 1500;  // ms：等音频流建立的兜底上限（超时保 F10 语义）
const PT_MIC_SETTLE = 200;    // ms：首帧到达后给 renderer 桥开始消费的余量
const ptMicWait = new Map();  // keyId -> { timer }（等待音频流建立的透传 down）
let ptMicSettleTimer = null;  // 首帧到达后的统一 flush 定时器

function currentPassFlags() {
  return process.platform === 'darwin' ? kbdInject.currentModFlags() : 0;
}

// 语音键透传的合成修饰键（仅 win32）：微信输入法「按住说话」要求快捷键必须含
// Ctrl/Alt/Shift/Win，纯功能键配不进去。开启后透传序列变为
// down: Ctrl↓ F10↓ / up: F10↑ Ctrl↑，用户在微信里配 Ctrl+F10 即可。
// mac 不启用：mac 应用以事件 flags 判修饰，孤立修饰键事件不被普遍认可。
function micPassModOf(keyId) {
  if (process.platform !== 'win32') return null;
  const m = cfg.settings.micPassMod;
  if (!['ctrl', 'alt', 'shift'].includes(m)) return null;
  return (cfg.settings.micTriggerKeys || []).includes(keyId) ? m : null;
}

function doPassDown(keyId, flags, pass) {
  const mod = micPassModOf(keyId);
  ptDecision.set(keyId, false);
  if (!pass) return;
  if (mod) actions.postRawKey(mod, true, 0);
  if (actions.postRawKey(keyId, true, flags)) ptDecision.set(keyId, true);
  else if (mod) actions.postRawKey(mod, false, 0); // 主键发失败：修饰立即回收，不留卡键
}
function doPassUp(keyId, flags) {
  const mod = micPassModOf(keyId);
  if (ptDecision.get(keyId)) {
    actions.postRawKey(keyId, false, flags);
    if (mod) actions.postRawKey(mod, false, 0);
  }
  ptDecision.delete(keyId);
}

function flushMicPassthrough() {
  // 音频帧已到：所有等待中的 mic 透传 down 再留一个消费余量后统一发出
  if (!ptMicWait.size || ptMicSettleTimer) return;
  ptMicSettleTimer = setTimeout(() => {
    ptMicSettleTimer = null;
    const flags = currentPassFlags();
    for (const [keyId, w] of ptMicWait) {
      clearTimeout(w.timer);
      ptMicWait.delete(keyId);
      doPassDown(keyId, flags, true);
    }
  }, PT_MIC_SETTLE);
}

function cancelMicWait(keyId) {
  const w = ptMicWait.get(keyId);
  if (w) { clearTimeout(w.timer); ptMicWait.delete(keyId); }
}

function passthroughKey(keyId, phase, pass, micAsked) {
  const flags = currentPassFlags();
  if (phase === 'down') {
    if (pass && micAsked) {
      // 开麦键：等音频流建立再透传（流已活跃=虚拟声卡已在出声 → 立即透传）
      const audioLive = session && session.lastAudioTs && Date.now() - session.lastAudioTs < 300;
      if (audioLive) { doPassDown(keyId, flags, pass); return; }
      const t = setTimeout(() => {
        // 超时兜底：流始终没来（固件没开麦/丢包），保 F10 语义照常透传
        const w = ptMicWait.get(keyId);
        if (w && w.timer === t) ptMicWait.delete(keyId);
        if (ptMicSettleTimer) { /* settle flush 不会再带上这个键（已删） */ }
        doPassDown(keyId, currentPassFlags(), true);
      }, PT_MIC_TIMEOUT);
      ptMicWait.set(keyId, { timer: t });
      return;
    }
    doPassDown(keyId, flags, pass);
  } else {
    if (ptMicWait.has(keyId)) { // 流未到就松开：立即补发 down+up，保持点击语义
      cancelMicWait(keyId);
      doPassDown(keyId, flags, true); // 能进等待队列的必是透传键
      doPassUp(keyId, flags);
      return;
    }
    if (ptDecision.has(keyId)) doPassUp(keyId, flags);
  }
}

// 断线/停止兜底：清等待队列，把透传已按下的键全部抬起，避免系统键状态卡住
function releasePassthrough() {
  for (const [, w] of ptMicWait) clearTimeout(w.timer);
  ptMicWait.clear();
  if (ptMicSettleTimer) { clearTimeout(ptMicSettleTimer); ptMicSettleTimer = null; }
  for (const [keyId, injected] of ptDecision) {
    if (injected) actions.postRawKey(keyId, false, 0);
    if (injected) { const m = micPassModOf(keyId); if (m) actions.postRawKey(m, false, 0); }
  }
  ptDecision.clear();
}

function exitOfficialRKAI() {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/IM', 'RK-AI.exe', '/F'], () => {});
    return { ok: true };
  }
  if (process.platform === 'darwin') {
    execFile('pkill', ['-x', 'RK-AI'], () => {});
    return { ok: true };
  }
  return { ok: false, error: '当前平台无官方 RK-AI' };
}

function setAutostart(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, name: 'RK87-AIKey' });
}

// ---------- 打字音效隐藏页 ----------
// 0x0 常驻窗口（skipTaskbar + backgroundThrottling:false——隐藏页定时器/IPC 不被
// Chromium 节流；主窗口已有同款设置与实测结论）。音色 wav 由主进程读文件经 IPC 下发，
// 页面不直接碰文件系统（绕开 file:// 跨源/asar 路径问题）。
function createSoundWindow() {
  if (soundWin && !soundWin.isDestroyed()) return;
  soundWin = new BrowserWindow({
    show: false, width: 1, height: 1, x: 0, y: 0, skipTaskbar: true, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload-sound.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  soundWin.loadFile(path.join(__dirname, '..', 'renderer', 'sound.html'));
  soundWin.webContents.on('did-finish-load', () => { sendSoundConfig(); sendSoundBuffers(); });
  soundWin.on('closed', () => { soundWin = null; });
}

// 当前音色的 wav 文件列表（内置 assets/sounds 按 pack 前缀过滤；custom=目录内全部）
function listSoundFiles() {
  try {
    const s = cfg.settings;
    const pack = s.soundPack || 'blue';
    const dir = pack === 'custom' && s.soundCustomDir
      ? s.soundCustomDir
      : path.join(__dirname, '..', '..', 'assets', 'sounds');
    const all = fs.readdirSync(dir).filter(f => /\.wav$/i.test(f)).sort();
    const files = pack === 'custom' ? all : all.filter(f => path.basename(f).startsWith(pack + '-'));
    return files.slice(0, 16).map(f => path.join(dir, f));
  } catch (_) {
    return []; // 目录不存在/不可读：静默空列表（页面提示「音色加载 0」）
  }
}

function sendSoundBuffers() {
  if (!soundWin || soundWin.isDestroyed()) return;
  const list = listSoundFiles().map(p => ({
    name: path.basename(p),
    data: new Uint8Array(fs.readFileSync(p)),
  }));
  soundWin.webContents.send('sound-buffers', list);
}

function sendSoundConfig() {
  if (!soundWin || soundWin.isDestroyed()) return;
  const s = cfg.settings;
  soundWin.webContents.send('sound-config', {
    enabled: s.soundEnabled === true,
    volume: Math.max(0, Math.min(1, Number(s.soundVolume) || 0)),
  });
}

ipcMain.on('sound-log', (_e, msg) => console.log('[sound]', msg));

ipcMain.handle('sound-test', () => {
  if (!soundWin || soundWin.isDestroyed()) return { ok: false };
  soundWin.webContents.send('keystroke');
  return { ok: true };
});

ipcMain.handle('pick-dir', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// 每日打字报告：renderer 画好的 canvas PNG → 保存对话框落盘
ipcMain.handle('save-report', async (_e, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return { ok: false, error: '无效的图片数据' };
  }
  const { dialog } = require('electron');
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const r = await dialog.showSaveDialog(win, {
    defaultPath: `打字报告-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function createTray() {
  let img = null;
  if (process.platform === 'darwin') {
    // macOS：专用 template 图（黑色内容+透明底），深浅色菜单栏自适应
    img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png'));
    if (!img.isEmpty()) img.setTemplateImage(true);
  }
  if (!img || img.isEmpty()) {
    img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
    if (!img.isEmpty()) {
      // Windows/兜底：原图 512x512 需缩到托盘尺寸
      img = img.resize({ width: process.platform === 'darwin' ? 22 : 32, height: process.platform === 'darwin' ? 22 : 32 });
    }
  }
  if (img.isEmpty()) {
    // 兜底：1x1 蓝点 dataURL
    img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==');
  }
  tray = new Tray(img);
  rebuildTrayMenu();
  tray.on('double-click', () => showWindow());
}

function rebuildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: '打开设置', click: () => showWindow() },
    { type: 'separator' },
    { label: (deviceConnected || sessionOnline) ? '键盘：已连接' : '键盘：未连接', enabled: false },
    { label: sessionOnline ? `麦克风会话：在线${session && session.transport ? '（' + session.transport + '）' : ''}` : '麦克风会话：离线', enabled: false },
    { label: '重连键盘', click: () => { if (session) session.reconnect(); } },
    { label: '键位档', submenu: cfg.profiles.order.map(id => ({
      label: cfg.profiles.names[id] || id,
      type: 'radio',
      checked: id === cfg.profiles.activeId,
      click: () => manualSwitch(id),
    })) },
    { label: '打开日志文件夹', click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')) },
    { label: '退出官方 RK-AI', click: () => { exitOfficialRKAI(); } },
    { label: '开机自启', type: 'checkbox', checked: !!(cfg.settings && cfg.settings.autostart), click: mi => {
      cfg.settings.autostart = mi.checked;
      setAutostart(mi.checked);
      config.save(cfg);
    } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('RK87 AIKey — 自定义功能键');
}

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 860,
    height: 720,
    title: 'RK87 AIKey',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口隐藏到托盘是常态：禁用后台节流，保证 renderer 音频桥/IPC 投递
      // 不被 Chromium 的 hidden-page 定时器对齐拖慢（实验实测 Electron 33 下
      // AudioContext 不受影响，此为低成本保险）
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', e => {
    // 关窗 = 隐藏到托盘；真正退出走托盘「退出」（isQuitting 放行）
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('device-status', deviceConnected);
    win.webContents.send('session-status', sessionOnline);
    win.webContents.send('ai-mode', aiModeOn);
  });
}

// ---------- IPC ----------
ipcMain.handle('get-state', () => ({
  keys: allKeys().map(k => ({
    id: k.id,
    label: (cfg.labels && cfg.labels[k.id]) || k.label,
    code: k.code,
  })),
  bindings: cfg.bindings,
  bindingsAi: cfg.bindingsAi,
  settings: cfg.settings,
  profiles: profilesState(),
  deviceConnected,
  sessionOnline,
  aiMode: aiModeOn,
}));

ipcMain.handle('set-binding', (_e, keyId, action, mode = 'fn') => {
  // 界面里的"改备注名"走特殊键
  if (keyId.startsWith('__label__:')) {
    const id = keyId.slice('__label__:'.length);
    cfg.labels = cfg.labels || {};
    cfg.labels[id] = String(action.label || '').slice(0, 30);
    config.save(cfg);
    return { ok: true };
  }
  const set = mode === 'ai' ? 'bindingsAi' : 'bindings';
  cfg[set] = cfg[set] || {};
  cfg[set][keyId] = action;
  config.save(cfg);
  return { ok: true };
});

ipcMain.handle('set-settings', (_e, settings) => {
  cfg.settings = { ...cfg.settings, ...settings };
  config.save(cfg);
  if ('autostart' in settings) setAutostart(settings.autostart);
  if ('statsEnabled' in settings && stats) {
    stats.counting = settings.statsEnabled !== false;
    // 统计关但音效开：轮询保持（keystroke 事件源不能断）；两者都关才停
    if (stats.counting || cfg.settings.soundEnabled) stats.start();
    else stats.stop();
  }
  if ('soundEnabled' in settings) {
    if (settings.soundEnabled) { createSoundWindow(); sendSoundConfig(); }
    else if (soundWin && !soundWin.isDestroyed()) soundWin.destroy();
    // 音效开关影响统计轮询是否需要保持：统计关时——音效开→轮询保住（事件源不能断），音效关→轮询停
    if (stats && !stats.counting) {
      if (settings.soundEnabled) stats.start();
      else stats.stop();
    }
  }
  if ('soundVolume' in settings) sendSoundConfig();
  if ('soundPack' in settings || 'soundCustomDir' in settings) {
    sendSoundConfig();
    sendSoundBuffers();
  }
  if (stats) {
    if ('fatigueEnabled' in settings) stats.fatigue.enabled = settings.fatigueEnabled !== false;
    if ('fatigueMinutes' in settings) stats.fatigue.minutes = Math.max(5, Number(settings.fatigueMinutes) || 25);
  }
  rebuildTrayMenu();
  return { ok: true };
});

ipcMain.handle('stats-get', () => {
  const enabled = cfg.settings.statsEnabled !== false;
  return stats ? { ...stats.summary(), enabled } : { supported: false, enabled };
});

ipcMain.handle('mic-control', (_e, on) => {
  if (!session) return { ok: false, error: '会话未初始化' };
  const ok = on ? session.askVoice() : session.stopVoice();
  return { ok, online: sessionOnline };
});

// 宏录制：start/stop（30s 超时主进程自动停并推送结果）
ipcMain.handle('macro-op', (_e, payload) => {
  const { op } = payload || {};
  if (op === 'start') {
    if (!macroRec) macroRec = new MacroRecorder();
    const okStart = macroRec.start((steps, reason) => {
      macroArmed = false; // 超时自动停同样要解除抑制
      if (win && !win.isDestroyed()) {
        win.webContents.send('macro-recorded', { steps: trimSteps(steps), reason });
      }
    });
    if (!okStart) return { ok: false, error: '当前平台不支持宏录制' };
    macroArmed = true;
    abortReplay(); // 录制优先：掐掉进行中的回放，防止回放键混进录制
    console.log('[macro] 开始录制（30s 上限，绑定动作暂停）');
    return { ok: true, maxMs: RECORD_MAX_MS };
  }
  if (op === 'stop') {
    if (!macroRec || !macroRec.recording) return { ok: false, error: '当前未在录制' };
    const steps = macroRec.stop('manual');
    macroArmed = false;
    console.log(`[macro] 结束录制，${steps.length} 步`);
    return { ok: true, steps: trimSteps(steps) };
  }
  return { ok: false, error: `未知操作 ${op}` };
});

ipcMain.handle('test-action', (_e, action) => actions.run(action));

// 配置档操作：add / rename / del / set-active / set-rules
ipcMain.handle('profile-op', (_e, payload) => {
  const { op } = payload || {};
  switch (op) {
    case 'add': {
      const id = config.addProfile(cfg, payload.name);
      if (!id) return { ok: false, error: `最多 ${config.MAX_PROFILES} 档` };
      config.save(cfg);
      rebuildTrayMenu();
      return { ok: true, id, profiles: profilesState() };
    }
    case 'rename':
      if (!config.renameProfile(cfg, payload.id, payload.name)) return { ok: false, error: '档不存在' };
      config.save(cfg);
      rebuildTrayMenu();
      return { ok: true, profiles: profilesState() };
    case 'del': {
      const back = config.delProfile(cfg, payload.id);
      if (back === null) return { ok: false, error: '默认档不可删' };
      config.save(cfg);
      rebuildTrayMenu();
      syncFgWatcher();
      if (win && !win.isDestroyed()) {
        win.webContents.send('profile-changed', { id: cfg.profiles.activeId, reason: 'del', name: cfg.profiles.names[cfg.profiles.activeId] });
      }
      return { ok: true, profiles: profilesState() };
    }
    case 'set-active':
      if (!manualSwitch(payload.id)) return { ok: false, error: '档不存在' };
      return { ok: true, profiles: profilesState() };
    case 'set-rules': {
      cfg.appRules = (Array.isArray(payload.rules) ? payload.rules : [])
        .filter(r => r && cfg.profiles.order.includes(r.profileId) && String(r.name || '').trim())
        .map(r => ({ profileId: r.profileId, name: String(r.name).trim().slice(0, 64) }));
      config.save(cfg);
      syncFgWatcher();
      return { ok: true, profiles: profilesState() };
    }
    default:
      return { ok: false, error: `未知操作 ${op}` };
  }
});

ipcMain.handle('pick-program', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: process.platform === 'darwin'
      ? [{ name: '应用程序', extensions: ['app', 'command'] }]
      : [{ name: '可执行文件', extensions: ['exe', 'bat', 'cmd', 'lnk'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 退出前统一清理（主动退出与崩溃自启共用）：停麦/落盘/掐孤儿 timer
function releaseDevices() {
  stopPsBlocker();
  if (watcher) watcher.stop();
  if (session) session.stop(); // 推流中途退出会先补发 cmd=4 停麦再关句柄
  if (stats) stats.stop(); // 统计落盘
  if (fg) fg.stop();
  if (soundWin && !soundWin.isDestroyed()) soundWin.destroy(); // 音效隐藏页
  abortReplay(); // 掐掉宏回放孤儿 timer
}

app.on('before-quit', () => {
  isQuitting = true;
  releaseDevices();
});

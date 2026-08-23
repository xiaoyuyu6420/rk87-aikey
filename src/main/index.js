// RK87 AIKey 主进程：托盘 + 设置窗口 + HID 监听 + 动作分发

const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { execFile } = require('child_process');

const { KeyboardWatcher } = require('./hid');
const { KeySession } = require('./kb-session');
const { lookupKey, allKeys } = require('./keymap');
const { MicPipeline } = require('./mic');
const { TypingStats } = require('./stats');
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

// 常驻托盘应用：瞬时异常（如 stdout 管道断开的 EPIPE）不崩溃退出
process.on('uncaughtException', e => {
  try { console.log('[uncaught]', e && e.message); } catch (_) {}
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
}

function boot() {
  cfg = config.load();

  watcher = new KeyboardWatcher();
  watcher.on('key', onKey);
  watcher.on('ai-mode', ({ on }) => onAiMode(on));
  watcher.on('device', ({ connected }) => {
    deviceConnected = connected;
    if (!connected) releasePassthrough(); // 有线拔出时透传按下的键兜底抬起
    if (win) win.webContents.send('device-status', connected);
  });
  watcher.start();

  // 音频/麦克风状态统一由 KeySession（蓝牙口）提供；watcher 仅负责按键监听

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
  });
  session.on('audio', buf => {
    try {
      if (!micPipeline) micPipeline = new MicPipeline();
      pcmBatch.push(micPipeline.pushPacket(buf));
      if (!pcmBatchTimer) {
        pcmBatchTimer = setTimeout(() => {
          pcmBatchTimer = null;
          if (pcmBatch.length && win && !win.isDestroyed()) {
            win.webContents.send('mic-pcm', Buffer.concat(pcmBatch));
          }
          pcmBatch = [];
        }, 120);
      }
    } catch (e) {
      console.log('[mic] 解码失败:', e.message);
    }
  });
  session.start();

  // 普通（非 AI）模式（mac）：F1-F12/PrtSc 走标准报文进回注模块；绑定了动作的键在此拦截。
  // 返回 'block'=屏蔽原键、'passthrough'=动作+原键都触发、null=未绑定走原生回注
  kbdInject.setFnKeyPolicy(keyId => {
    if (aiModeOn) onAiMode(false); // 功能键出现在标准报文 = 键盘实际处于普通模式
    const binding = (cfg.bindings && cfg.bindings[keyId]) || { type: 'none' };
    if (binding.type === 'none') return null;
    console.log(`[key] ${keyId} down（标准报文，已拦截）`);
    if (win && !win.isDestroyed()) win.webContents.send('key-event', { keyId, phase: 'down' });
    const r = actions.run(binding);
    if (r && r.ok === false) console.log(`[action] ${keyId} 失败:`, r.error);
    return binding.passthrough === true ? 'passthrough' : 'block';
  });

  // 打字统计：先载入历史（禁用时也能看），启用才开轮询
  stats = new TypingStats().load();
  stats.fatigue = {
    enabled: cfg.settings.fatigueEnabled !== false,
    minutes: Math.max(5, Number(cfg.settings.fatigueMinutes) || 25),
  };
  if (cfg.settings.statsEnabled !== false) stats.start();

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
  const micKeys = cfg.settings.micTriggerKeys || [];
  if (micKeys.includes(keyId) && session) {
    if (phase === 'down') session.askVoice();
    else session.stopVoice();
  }
  // cmd=159 厂商码只在 AI 模式上报 → 此路径一律用 AI 模式绑定集
  const binding = (cfg.bindingsAi && cfg.bindingsAi[keyId]) || { type: 'none' };
  // 动作只在按下触发
  if (phase === 'down' && binding.type !== 'none') {
    const result = actions.run(binding);
    if (result && result.ok === false) {
      console.log(`[action] ${keyId} 失败:`, result.error);
    }
  }
  // 透传：未绑定任何动作（完全原生）或勾了透传 → 回注标准按键
  //（AI 模式下 F 键走厂商码不经系统，透传让输入法语音/亮度等原功能照常生效）
  passthroughKey(keyId, phase, binding.passthrough === true || binding.type === 'none');
}

// 透传回注（AI 模式厂商码路径）。down 时记下决定，up 按记录执行；
// 无键码的键（AI 键/扩展键位，无原功能可言）发送失败不记状态
function passthroughKey(keyId, phase, pass) {
  const flags = process.platform === 'darwin' ? kbdInject.currentModFlags() : 0;
  if (phase === 'down') {
    ptDecision.set(keyId, false);
    if (pass && actions.postRawKey(keyId, true, flags)) ptDecision.set(keyId, true);
  } else if (ptDecision.has(keyId)) {
    if (ptDecision.get(keyId)) actions.postRawKey(keyId, false, flags);
    ptDecision.delete(keyId);
  }
}

// 断线/停止兜底：把透传已按下的键全部抬起，避免系统键状态卡住
function releasePassthrough() {
  for (const [keyId, injected] of ptDecision) {
    if (injected) actions.postRawKey(keyId, false, 0);
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
    settings.statsEnabled ? stats.start() : stats.stop();
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

ipcMain.handle('test-action', (_e, action) => actions.run(action));

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

app.on('before-quit', () => {
  isQuitting = true;
  if (watcher) watcher.stop();
  if (session) session.stop();
  if (stats) stats.stop(); // 统计落盘
});

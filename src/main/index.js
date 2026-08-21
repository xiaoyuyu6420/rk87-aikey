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
  watcher.on('device', ({ connected }) => {
    deviceConnected = connected;
    if (win) win.webContents.send('device-status', connected);
  });
  watcher.start();

  // 音频/麦克风状态统一由 KeySession（蓝牙口）提供；watcher 仅负责按键监听

  // 键盘命令会话：蓝牙口心跳+验证，驱动固件开麦（完全自主，无需官方 RK-AI）
  session = new KeySession();
  session.on('key', onKey); // 蓝牙连接时按键上报走会话口
  session.on('state', ({ connected, reason }) => {
    sessionOnline = connected;
    console.log(`[session] ${connected ? '在线' : '离线' + (reason ? '（' + reason + '）' : '')}`);
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

  // 打字统计：先载入历史（禁用时也能看），启用才开轮询
  stats = new TypingStats().load();
  if (cfg.settings.statsEnabled !== false) stats.start();

  createTray();
  if (cfg.settings.autostart) setAutostart(true);

  showWindow(); // 启动即打开设置窗口（关闭窗口=隐藏到托盘）
}

// 多连接（如 USB+蓝牙/2.4G 并存）时同一按键会从两个口各报一次，全局去重
let lastGlobalKey = null;
function onKey({ code, keyId, phase }) {
  const now = Date.now();
  if (lastGlobalKey && lastGlobalKey.keyId === keyId && lastGlobalKey.phase === phase && now - lastGlobalKey.ts < 80) return;
  lastGlobalKey = { keyId, phase, ts: now };
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
  // 默认按下触发
  if (phase !== 'down') return;
  const action = (cfg.bindings && cfg.bindings[keyId]) || { type: 'none' };
  const result = actions.run(action);
  if (result && result.ok === false) {
    console.log(`[action] ${keyId} 失败:`, result.error);
  }
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
  let img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
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
    { label: deviceConnected ? '键盘：已连接' : '键盘：未连接', enabled: false },
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
  settings: cfg.settings,
  deviceConnected,
  sessionOnline,
}));

ipcMain.handle('set-binding', (_e, keyId, action) => {
  // 界面里的"改备注名"走特殊键
  if (keyId.startsWith('__label__:')) {
    const id = keyId.slice('__label__:'.length);
    cfg.labels = cfg.labels || {};
    cfg.labels[id] = String(action.label || '').slice(0, 30);
    config.save(cfg);
    return { ok: true };
  }
  cfg.bindings[keyId] = action;
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

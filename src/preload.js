const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aikey', {
  getState: () => ipcRenderer.invoke('get-state'),
  setBinding: (keyId, action, mode) => ipcRenderer.invoke('set-binding', keyId, action, mode),
  setSettings: s => ipcRenderer.invoke('set-settings', s),
  testAction: a => ipcRenderer.invoke('test-action', a),
  pickProgram: () => ipcRenderer.invoke('pick-program'),
  onKeyEvent: cb => ipcRenderer.on('key-event', (_e, data) => cb(data)),
  onDeviceStatus: cb => ipcRenderer.on('device-status', (_e, connected) => cb(connected)),
  // 键盘麦克风桥接
  onMicPcm: cb => ipcRenderer.on('mic-pcm', (_e, buf) => cb(new Uint8Array(buf))),
  onMicState: cb => ipcRenderer.on('mic-state', (_e, on) => cb(on)),
  onSessionStatus: cb => ipcRenderer.on('session-status', (_e, on) => cb(on)),
  onAiMode: cb => ipcRenderer.on('ai-mode', (_e, on) => cb(on)),
  onBattery: cb => ipcRenderer.on('battery', (_e, b) => cb(b)),
  micControl: on => ipcRenderer.invoke('mic-control', on),
  // 配置档（多套键位 + 前台应用自动切档）
  profileOp: payload => ipcRenderer.invoke('profile-op', payload),
  onProfileChanged: cb => ipcRenderer.on('profile-changed', (_e, data) => cb(data)),
  // 宏录制
  macroOp: payload => ipcRenderer.invoke('macro-op', payload),
  onMacroRecorded: cb => ipcRenderer.on('macro-recorded', (_e, data) => cb(data)),
  // 打字统计
  statsGet: () => ipcRenderer.invoke('stats-get'),
});

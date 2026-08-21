const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aikey', {
  getState: () => ipcRenderer.invoke('get-state'),
  setBinding: (keyId, action) => ipcRenderer.invoke('set-binding', keyId, action),
  setSettings: s => ipcRenderer.invoke('set-settings', s),
  testAction: a => ipcRenderer.invoke('test-action', a),
  pickProgram: () => ipcRenderer.invoke('pick-program'),
  onKeyEvent: cb => ipcRenderer.on('key-event', (_e, data) => cb(data)),
  onDeviceStatus: cb => ipcRenderer.on('device-status', (_e, connected) => cb(connected)),
  // 键盘麦克风桥接
  onMicPcm: cb => ipcRenderer.on('mic-pcm', (_e, buf) => cb(new Uint8Array(buf))),
  onMicState: cb => ipcRenderer.on('mic-state', (_e, on) => cb(on)),
  onSessionStatus: cb => ipcRenderer.on('session-status', (_e, on) => cb(on)),
  micControl: on => ipcRenderer.invoke('mic-control', on),
});

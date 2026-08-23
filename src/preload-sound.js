// 音效隐藏页专用 preload（最小暴露面，与设置页 preload 分离）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundBridge', {
  onConfig: cb => ipcRenderer.on('sound-config', (_e, cfg) => cb(cfg)),
  onBuffers: cb => ipcRenderer.on('sound-buffers', (_e, list) => cb(list)),
  onKeystroke: cb => ipcRenderer.on('keystroke', (_e, name) => cb(name)),
  log: msg => ipcRenderer.send('sound-log', String(msg).slice(0, 200)),
});

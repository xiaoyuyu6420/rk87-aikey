// 打字音效播放页逻辑（主进程 0x0 隐藏常驻窗口，关闭音效时窗口不创建）
// - AudioContext 预解码 AudioBuffer，每键一路 source，并发上限 8
// - 音色数据由主进程读文件后经 IPC 下发（内置 assets 或用户自选目录，绕开 file:// 跨源限制）
// - 每次播放随机抽采样 + playbackRate 微扰（0.94-1.06），避免机关枪感
let ctx = null, master = null, buffers = [], enabled = false, volume = 0.5, voices = 0;

function log(msg) { window.soundBridge.log(msg); }

async function ensureCtx() {
  if (ctx) return ctx;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  if (ctx.state === 'suspended') await ctx.resume();
  log('AudioContext=' + ctx.state + ' sampleRate=' + ctx.sampleRate);
  return ctx;
}

async function loadBuffers(list) {
  if (!Array.isArray(list) || !list.length) { buffers = []; return; }
  const c = await ensureCtx();
  const decoded = [];
  for (const item of list) {
    try {
      const ab = item.data.buffer.slice(item.data.byteOffset, item.data.byteOffset + item.data.byteLength);
      decoded.push(await c.decodeAudioData(ab));
    } catch (_) { log('decode失败 ' + item.name); }
  }
  buffers = decoded;
  log('音色加载 ' + decoded.length + '/' + list.length);
}

function play() {
  if (!enabled || !buffers.length || !ctx || ctx.state !== 'running') return;
  if (voices >= 8) return; // 并发上限：高速连击时丢弃，不清真
  const src = ctx.createBufferSource();
  src.buffer = buffers[(Math.random() * buffers.length) | 0];
  src.playbackRate.value = 0.94 + Math.random() * 0.12;
  src.connect(master);
  src.onended = () => { voices--; };
  voices++;
  try {
    src.start();
  } catch (_) {
    voices--; // start 抛异常则 onended 不会触发，不回收会累计到上限后音效永久静默
    return;
  }
  if (!play._once) { play._once = true; log('首次播放 OK（后续静默）'); }
}

window.soundBridge.onConfig(async cfg => {
  enabled = !!cfg.enabled;
  volume = Math.max(0, Math.min(1, Number(cfg.volume) || 0));
  if (master) master.gain.value = volume;
  if (enabled) await ensureCtx();
});
window.soundBridge.onBuffers(loadBuffers);
window.soundBridge.onKeystroke(() => {
  if (!play._got) { play._got = true; log('收到击键事件'); }
  play();
});
log('播放页就绪');

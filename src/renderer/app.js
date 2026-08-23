// 设置页逻辑：键位列表 + 动作编辑 + 实时按键高亮标定

const TYPES = [
  { value: 'none',    label: '不动作' },
  { value: 'app',     label: '启动程序' },
  { value: 'url',     label: '打开网址' },
  { value: 'hotkey',  label: '发送快捷键' },
];

let state = null; // { keys, bindings, bindingsAi, settings, deviceConnected }
let currentMode = 'fn'; // 'fn' 普通模式 | 'ai' AI 模式（两套绑定独立配置）

init();

async function init() {
  state = await window.aikey.getState();

  const elStatus = document.getElementById('device-status');
  // 键盘状态 = 有线连接 || 蓝牙/2.4G 命令会话在线（任一即视为已连接）
  let devConnected = !!state.deviceConnected, sessOnline = !!state.sessionOnline;
  const setDev = () => {
    const c = devConnected || sessOnline;
    elStatus.textContent = c ? '键盘已连接' : '键盘未连接';
    elStatus.classList.toggle('on', !!c);
  };
  window.aikey.onDeviceStatus(c => { devConnected = c; setDev(); });
  window.aikey.onSessionStatus(on => { sessOnline = on; setDev(); });
  setDev();

  const optAuto = document.getElementById('opt-autostart');
  optAuto.checked = !!state.settings.autostart;
  optAuto.onchange = () => window.aikey.setSettings({ autostart: optAuto.checked });

  renderList();
  initModeTabs();
  initPageNav();

  initMicBridge();
  initStats();
  window.aikey.onKeyEvent(ev => {
    if (ev.phase !== 'down') return;
    const row = document.querySelector(`.key-row[data-id="${ev.keyId}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 600);
  });
}

// ---------- 顶层页面切换（按键映射 / 打字统计） ----------
function initPageNav() {
  const tabs = document.querySelectorAll('.page-tab');
  tabs.forEach(tab => {
    tab.onclick = () => {
      if (tab.classList.contains('active')) return;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      document.getElementById('page-keys').hidden = tab.dataset.page !== 'keys';
      document.getElementById('page-stats').hidden = tab.dataset.page !== 'stats';
      if (tab.dataset.page === 'stats') refreshStats(); // 切进来立即刷新一次
    };
  });
}

// ---------- 模式 tab + 键盘当前模式徽章 ----------
function initModeTabs() {
  const badge = document.getElementById('kb-mode-badge');
  const setBadge = on => {
    badge.textContent = on ? '键盘：AI 模式' : '键盘：普通模式';
    badge.classList.toggle('ai', !!on);
  };
  window.aikey.onAiMode(setBadge);
  setBadge(!!state.aiMode);

  const tabs = document.querySelectorAll('.mode-tab');
  tabs.forEach(tab => {
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.title = '此模式下已自定义的键数';
    tab.appendChild(cnt);
    tab.onclick = () => {
      if (currentMode === tab.dataset.mode) return;
      currentMode = tab.dataset.mode;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      renderList();
    };
  });
  updateTabCounts();
}

// tab 上的「已自定义键数」角标：两个模式的配置分叉程度一眼可见
//（初次两份相同是迁移拷贝，之后各改各的，数字就开始不同）
function updateTabCounts() {
  const count = map => Object.values(map || {}).filter(b => b && b.type && b.type !== 'none').length;
  document.querySelector('#tab-fn .cnt').textContent = count(state.bindings) || '';
  document.querySelector('#tab-ai .cnt').textContent = count(state.bindingsAi) || '';
}

const bindingsOf = () => (currentMode === 'ai' ? state.bindingsAi : state.bindings) || {};

function renderList() {
  const list = document.getElementById('key-list');
  list.innerHTML = '';
  for (const key of state.keys) {
    const binding = bindingsOf()[key.id] || { type: 'none' };
    list.appendChild(buildRow(key, binding));
  }
}

function buildRow(key, binding) {
  const row = document.createElement('div');
  row.className = 'key-row';
  row.dataset.id = key.id;

  // 键名（双击改名）
  const name = document.createElement('div');
  name.className = 'key-name';
  name.innerHTML = `${escapeHtml(key.label)}<small>键码 ${key.code}</small>`;
  name.title = '双击修改备注名';
  name.ondblclick = () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = key.label;
    name.innerHTML = '';
    name.appendChild(input);
    input.focus(); input.select();
    const commit = async () => {
      key.label = input.value.trim() || key.label;
      await window.aikey.setBinding('__label__:' + key.id, { label: key.label });
      name.innerHTML = `${escapeHtml(key.label)}<small>键码 ${key.code}</small>`;
    };
    input.onblur = commit;
    input.onkeydown = e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = key.label; input.blur(); } };
  };

  // 动作类型
  const typeSel = document.createElement('select');
  for (const t of TYPES) {
    const o = document.createElement('option');
    o.value = t.value; o.textContent = t.label;
    typeSel.appendChild(o);
  }
  typeSel.value = binding.type;

  const fields = document.createElement('div');
  fields.className = 'action-fields';

  const renderFields = () => {
    fields.innerHTML = '';
    const t = typeSel.value;
    if (t === 'none') {
      const span = document.createElement('span');
      span.className = 'none-hint';
      span.textContent = '此键位不触发任何动作，原按键功能完全保留';
      fields.appendChild(span);
      return;
    }
    if (t === 'app' || t === 'url') {
      const target = document.createElement('input');
      target.type = 'text';
      target.placeholder = t === 'app' ? 'C:\\...\\app.exe（要带参数请指向 .bat）' : 'https://...';
      target.value = binding.target || '';
      fields.appendChild(target);

      if (t === 'app') {
        const browse = document.createElement('button');
        browse.textContent = '浏览…';
        browse.className = 'fixed';
        browse.onclick = async () => {
          const p = await window.aikey.pickProgram();
          if (p) target.value = p;
        };
        fields.appendChild(browse);
      }

      const after = document.createElement('label');
      after.className = 'after-line';
      after.innerHTML = `启动后 <input type="number" min="0" step="100" value="${Number(binding.afterDelay ?? 800) || 800}" style="width:60px"/> ms 发 <input type="text" placeholder="可选" value="${escapeAttr(binding.afterHotkey || '')}"/> <button type="button" class="cap-after">捕获</button>`;
      attachCapture(after.querySelector('button.cap-after'), after.querySelector('input[type=text]'));
      fields.appendChild(after);
    }
    if (t === 'hotkey') {
      const combo = document.createElement('input');
      combo.type = 'text';
      combo.placeholder = '点击「捕获」直接按组合键';
      combo.value = binding.combo || '';
      fields.appendChild(combo);
      const cap = document.createElement('button');
      cap.className = 'fixed';
      cap.textContent = '捕获';
      attachCapture(cap, combo);
      fields.appendChild(cap);
    }
    // 透传开关：仅对有「原按键功能」的键（F1-F12/PrtSc）显示；AI 键/扩展键位无原功能
    if (/^(f\d{1,2}|prtsc)$/.test(key.id)) {
      const pass = document.createElement('label');
      pass.className = 'pass-line';
      pass.innerHTML = '<input type="checkbox"/> 同时保留原按键功能（透传：如 F10 输入法语音、亮度/音量键照常生效）';
      pass.querySelector('input').checked = binding.passthrough === true;
      pass.title = '不勾 = 绑定动作后独占此键，原功能屏蔽；勾选 = 动作和原功能同时触发';
      fields.appendChild(pass);
    }
  };
  renderFields();
  typeSel.onchange = renderFields;

  // 操作按钮
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const testBtn = document.createElement('button');
  testBtn.textContent = '测试';
  testBtn.onclick = () => runRow(row, { silentFailToast: true });
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '保存';
  saveBtn.onclick = () => runRow(row, { save: true });
  actions.append(testBtn, saveBtn);

  // 从当前行 DOM 收集 action
  function collect() {
    const t = typeSel.value;
    const input = fields.querySelector('input[type=text]');
    const action = { type: t };
    if (t === 'app' || t === 'url') action.target = input.value.trim();
    if (t === 'hotkey') action.combo = input.value.trim();
    if (t === 'app' || t === 'url') {
      const nums = fields.querySelectorAll('input[type=number]');
      const texts = fields.querySelectorAll('label.after-line input[type=text]');
      if (nums[0]) action.afterDelay = Number(nums[0].value) || 0;
      if (texts[0] && texts[0].value.trim()) action.afterHotkey = texts[0].value.trim();
    }
    const passCb = fields.querySelector('label.pass-line input');
    if (passCb && passCb.checked) action.passthrough = true; // 不勾/不可透传键 = 屏蔽（默认）
    return action;
  }

  row.collect = collect;
  row.append(name, typeSel, fields, actions);
  return row;
}

async function runRow(row, { save = false } = {}) {
  const action = row.collect();
  if (save) {
    await window.aikey.setBinding(row.dataset.id, action, currentMode);
    bindingsOf()[row.dataset.id] = action;
    updateTabCounts();
    toast(`已保存「${row.dataset.id}」（${currentMode === 'ai' ? 'AI 模式' : '普通模式'}）`);
    return; // 保存只保存，不执行；想看效果点「测试」
  }
  const r = await window.aikey.testAction(action);
  if (r && r.ok === false) toast('失败: ' + r.error, true);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- 快捷键点击捕获（按钮进入捕获态，直接按组合键填入） ----------
// DOM code → 本应用键名（与 actions.js vkOf 同一套，macOS 上 Win 显示名即 Cmd）
const DOM_CODE_MAP = {
  Space:'space', Enter:'enter', Tab:'tab', Escape:'esc', Backspace:'backspace',
  Delete:'delete', Insert:'insert', ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
  Home:'home', End:'end', PageUp:'pgup', PageDown:'pgdn', PrintScreen:'printscreen',
  CapsLock:'capslock', NumLock:'numlock', Minus:'minus', Equal:'equal', Comma:'comma',
  Period:'period', Slash:'slash', Backquote:'backtick', BracketLeft:'lbracket',
  BracketRight:'rbracket', Backslash:'backslash', Semicolon:'semicolon', Quote:'quote',
};
function domCodeToName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return 'f' + code.slice(1);
  if (/^Numpad\d$/.test(code)) return code.slice(6); // 小键盘数字按主键盘数字发
  return DOM_CODE_MAP[code] || null;
}
let captureHandlerInstalled = false;
function ensureCaptureHandler() {
  if (captureHandlerInstalled) return;
  captureHandlerInstalled = true;
  document.addEventListener('keydown', e => {
    const btn = document.querySelector('button.capturing');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopCapture(btn, true); return; }
    const name = domCodeToName(e.code);
    if (!name) return; // 只按了修饰键，继续等主键
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Win'); // macOS 上 Win 键 = Cmd
    btn._captureInput.value = mods.length ? mods.join('+') + '+' + name : name;
    stopCapture(btn);
  }, true);
}
function stopCapture(btn, restore = false) {
  if (restore && btn._captureInput && btn._origValue !== undefined) btn._captureInput.value = btn._origValue;
  btn.classList.remove('capturing');
  btn.textContent = '捕获';
}
function attachCapture(btn, input) {
  ensureCaptureHandler();
  btn._captureInput = input;
  btn.onclick = () => {
    const on = !btn.classList.contains('capturing');
    document.querySelectorAll('button.capturing').forEach(stopCapture);
    if (on) {
      btn._origValue = input.value; // Esc 取消时回填
      btn.classList.add('capturing');
      btn.textContent = '按组合键…(Esc停)';
      input.value = '';
      input.focus();
    }
  };
}

let toastTimer = null;
function toast(msg, isErr = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- 键盘麦克风 → 虚拟声卡桥接 ----------
// 主进程把解码后的 PCM（int16 LE @16kHz 单声道，约 120ms 一批）发过来，
// 这里经 WebAudio 播到用户选的输出设备（虚拟声卡的播放端，如 CABLE Input）。
const bridge = { ctx: null, node: null, queue: [], chunkOff: 0, enabled: false, sinkId: '' };
let micLevelTimer = null;

async function initMicBridge() {
  const optBridge = document.getElementById('opt-mic-bridge');
  const selSink = document.getElementById('mic-sink');
  const badge = document.getElementById('mic-state-badge');
  const bar = document.getElementById('mic-level-bar');

  // 按住说话键（可设置，默认 F10 + AI 键）
  const triggerBox = document.getElementById('mic-trigger-keys');
  const shortName = id =>
    id === 'ai_key' ? 'AI' : id === 'prtsc' ? 'PrtSc' :
    /^f\d+$/.test(id) ? id.toUpperCase() :
    id.startsWith('ext_') ? '扩' + id.slice(4) : id;
  const triggerSet = new Set(state.settings.micTriggerKeys || ['f10', 'ai_key']);
  for (const k of state.keys) {
    const label = document.createElement('label');
    label.className = 'tk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = triggerSet.has(k.id);
    cb.onchange = async () => {
      cb.checked ? triggerSet.add(k.id) : triggerSet.delete(k.id);
      state.settings.micTriggerKeys = [...triggerSet];
      await window.aikey.setSettings({ micTriggerKeys: [...triggerSet] });
    };
    label.append(cb, document.createTextNode(shortName(k.id)));
    triggerBox.appendChild(label);
  }

  optBridge.checked = !!state.settings.micBridgeEnabled;
  optBridge.onchange = async () => {
    state.settings.micBridgeEnabled = optBridge.checked;
    await window.aikey.setSettings({ micBridgeEnabled: optBridge.checked });
    applyBridge();
  };

  selSink.onchange = async () => {
    state.settings.micSinkId = selSink.value;
    await window.aikey.setSettings({ micSinkId: selSink.value });
    applyBridge();
  };
  document.getElementById('mic-refresh').onclick = () => refreshSinks();

  window.aikey.onMicState(on => {
    badge.textContent = on ? '采集中' : '静音';
    badge.classList.toggle('on', !!on);
    if (!on) bar.style.width = '0%';
  });

  // 会话状态徽章 + 手动开麦按钮
  const btnMic = document.getElementById('mic-toggle');
  window.aikey.onSessionStatus(online => {
    badge.classList.toggle('offline', !online);
    if (btnMic) {
      btnMic.disabled = !online;
      btnMic.textContent = online ? '开始说话' : '会话离线';
    }
  });
  if (btnMic) {
    btnMic.disabled = !state.sessionOnline;
    btnMic.textContent = state.sessionOnline ? '开始说话' : '会话离线';
    let speaking = false;
    btnMic.onclick = async () => {
      speaking = !speaking;
      const r = await window.aikey.micControl(speaking);
      if (!r.ok) { speaking = false; }
      btnMic.textContent = speaking ? '停止' : '开始说话';
    };
    window.aikey.onMicState(on => {
      if (!on && speaking) { speaking = false; btnMic.textContent = '开始说话'; }
    });
  }

  window.aikey.onMicPcm(bytes => {
    if (!bridge.enabled || !bytes.length) return;
    // int16 LE → float32
    const n = bytes.length >> 1;
    const f = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = (bytes[i * 2] | (bytes[i * 2 + 1] << 8)) << 16 >> 16;
      f[i] = v / 32768;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    bridge.queue.push(f);
    // 防积压：超 5 帧（每帧 120ms 批 ≈ 600ms 缓冲）丢最旧。队首被丢弃时
    // chunkOff 必须归零——它指向的是旧队首的内部偏移，不重置会从新队首中间开始播（跳音）
    if (bridge.queue.length > 5) {
      bridge.queue.splice(0, bridge.queue.length - 5);
      bridge.chunkOff = 0;
    }
    // 电平条（限频刷新）
    if (peak > 0 && !micLevelTimer) {
      micLevelTimer = setTimeout(() => {
        micLevelTimer = null;
        bar.style.width = Math.min(100, peak / 327) + '%';
      }, 100);
    }
  });

  async function refreshSinks() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter(d => d.kind === 'audiooutput');
    selSink.innerHTML = '';
    for (const d of outs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      const label = d.label || `设备 ${d.deviceId.slice(0, 8)}`;
      opt.textContent = label + (/[ck][ai]?ble/i.test(label) ? '   ← 虚拟声卡' : '');
      selSink.appendChild(opt);
    }
    // 默认选中：保存过的 / 自动探测虚拟声卡（Windows VB-CABLE / macOS BlackHole）/ 默认设备
    const saved = state.settings.micSinkId;
    if (saved && outs.some(d => d.deviceId === saved)) {
      selSink.value = saved;
    } else {
      const cable = outs.find(d => /cable|blackhole|virtual|loopback/i.test(d.label || ''));
      if (cable) selSink.value = cable.deviceId;
      // 探测不到虚拟声卡时保持默认设备，但提示用户（否则语音进音箱、输入侧无声）
      else toast('未找到虚拟声卡（BlackHole/VB-CABLE），请手动选择播放设备', true);
    }
    bridge.sinkId = selSink.value;
    applyBridge();
  }

  function stopBridge() {
    if (bridge.node) { try { bridge.node.disconnect(); } catch (_) {} }
    if (bridge.ctx) { try { bridge.ctx.close(); } catch (_) {} }
    bridge.ctx = bridge.node = null;
    bridge.queue = [];
    bridge.enabled = false;
  }

  function applyBridge() {
    stopBridge();
    if (!state.settings.micBridgeEnabled) return;
    try {
      const opts = { sampleRate: 16000 };
      if (bridge.sinkId && bridge.sinkId !== 'default') opts.sinkId = bridge.sinkId;
      bridge.ctx = new AudioContext(opts);
      const sp = bridge.ctx.createScriptProcessor(2048, 0, 1);
      sp.onaudioprocess = e => {
        const out = e.outputBuffer.getChannelData(0);
        let w = 0;
        while (w < out.length && bridge.queue.length) {
          const chunk = bridge.queue[0];
          const take = Math.min(chunk.length - bridge.chunkOff, out.length - w);
          out.set(chunk.subarray(bridge.chunkOff, bridge.chunkOff + take), w);
          bridge.chunkOff += take; w += take;
          if (bridge.chunkOff >= chunk.length) { bridge.queue.shift(); bridge.chunkOff = 0; }
        }
        if (w < out.length) out.fill(0, w); // 欠载时补静音
      };
      sp.connect(bridge.ctx.destination);
      bridge.node = sp;
      bridge.enabled = true;
      if (bridge.ctx.state === 'suspended') bridge.ctx.resume();
    } catch (e) {
      toast('桥接启动失败: ' + e.message, true);
    }
  }

  await refreshSinks();
}

// ---------- 打字统计 ----------
// 主进程轮询系统键状态计数，这里每 2 秒拉一次摘要渲染（窗口可见时才拉）。
const KEY_LABELS = {
  space: '空格', enter: '回车', backspace: '退格', tab: 'Tab', esc: 'Esc',
  up: '↑', down: '↓', left: '←', right: '→',
  home: 'Home', end: 'End', pgup: 'PgUp', pgdn: 'PgDn', delete: 'Del', insert: 'Ins',
  minus: '-', equal: '=', comma: ',', period: '.', slash: '/', backtick: '`',
  lbracket: '[', rbracket: ']', backslash: '\\', semicolon: ';', quote: "'",
};
function keyLabel(name) {
  if (KEY_LABELS[name]) return KEY_LABELS[name];
  if (/^[a-z0-9]$/.test(name) || /^f\d+$/.test(name)) return name.toUpperCase();
  return name;
}

let statsTimer = null;
function initStats() {
  const opt = document.getElementById('opt-stats');
  opt.checked = state.settings.statsEnabled !== false;
  opt.onchange = async () => {
    state.settings.statsEnabled = opt.checked;
    await window.aikey.setSettings({ statsEnabled: opt.checked });
    refreshStats();
  };
  // 疲劳提醒（连续打字满阈值弹系统通知）
  const optFat = document.getElementById('opt-fatigue');
  const fatMin = document.getElementById('fatigue-min');
  optFat.checked = state.settings.fatigueEnabled !== false;
  fatMin.value = state.settings.fatigueMinutes || 25;
  optFat.onchange = () => {
    state.settings.fatigueEnabled = optFat.checked;
    window.aikey.setSettings({ fatigueEnabled: optFat.checked });
  };
  fatMin.onchange = () => {
    const v = Math.max(5, Math.min(120, Number(fatMin.value) || 25));
    fatMin.value = v;
    state.settings.fatigueMinutes = v;
    window.aikey.setSettings({ fatigueMinutes: v });
  };
  if (statsTimer) clearInterval(statsTimer);
  // 统计页可见时才轮询（切到统计页时会立即手动刷一次）
  statsTimer = setInterval(() => {
    if (!document.hidden && !document.getElementById('page-stats')?.hidden) refreshStats();
  }, 2000);
  refreshStats();
}

async function refreshStats() {
  let s;
  try { s = await window.aikey.statsGet(); } catch (_) { return; }
  const body = document.getElementById('stats-body');
  const unsup = document.getElementById('stats-unsupported');
  if (!s || s.supported === false) {
    body.hidden = true;
    unsup.hidden = false;
    return;
  }
  unsup.hidden = true;
  body.hidden = false;
  body.classList.toggle('dim', !s.enabled);

  // 今日总数
  document.getElementById('stats-today').textContent = (s.today.total || 0).toLocaleString();

  // 今日 Top5 键（水平条）
  const topBox = document.getElementById('stats-topkeys');
  topBox.innerHTML = '';
  const top = (s.today.topKeys || []).slice(0, 5);
  const max = top.length ? top[0].count : 0;
  for (const k of top) {
    const row = document.createElement('div');
    row.className = 'tk-row';
    const name = document.createElement('span');
    name.className = 'tk-name';
    name.textContent = keyLabel(k.name);
    const bar = document.createElement('div');
    bar.className = 'tk-bar';
    bar.style.width = Math.max(3, Math.round(k.count / max * 100)) + '%';
    const count = document.createElement('span');
    count.className = 'tk-count';
    count.textContent = k.count;
    row.append(name, bar, count);
    topBox.appendChild(row);
  }
  if (!top.length) {
    const empty = document.createElement('span');
    empty.className = 'none-hint';
    empty.textContent = '今天还没有按键记录';
    topBox.appendChild(empty);
  }

  // 今日键位热力图（QWERTY 简化网格）
  renderHeatmap(s.today.keys || {});

  // 近 7 天柱状图
  const weekBox = document.getElementById('stats-week');
  weekBox.innerHTML = '';
  const wmax = Math.max(1, ...s.week.map(d => d.total || 0));
  const now = new Date(); // 主进程按本地时区记日，这里同样取本地日期
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const d of s.week) {
    const col = document.createElement('div');
    col.className = 'sw-col' + (d.date === todayStr ? ' today' : '');
    const slot = document.createElement('div');
    slot.className = 'sw-slot';
    const bar = document.createElement('div');
    bar.className = 'sw-bar';
    bar.style.height = Math.round((d.total || 0) / wmax * 100) + '%';
    bar.title = `${d.date}：${(d.total || 0).toLocaleString()} 次`;
    slot.appendChild(bar);
    const label = document.createElement('span');
    label.className = 'sw-label';
    label.textContent = d.date.slice(5); // MM-DD
    col.append(slot, label);
    weekBox.appendChild(col);
  }
}

// ---------- 今日键位热力图 ----------
// QWERTY 简化网格（键名与主进程统计名一致），宽键用 flex 拉伸
const HEATMAP_ROWS = [
  ['1','2','3','4','5','6','7','8','9','0','minus','equal'],
  ['q','w','e','r','t','y','u','i','o','p','lbracket','rbracket'],
  ['a','s','d','f','g','h','j','k','l','semicolon','quote'],
  ['z','x','c','v','b','n','m','comma','period','slash'],
  [{ n: 'tab', w: 1.6 }, { n: 'space', w: 5 }, { n: 'enter', w: 1.6 }, { n: 'backspace', w: 1.8 }],
];
function renderHeatmap(keys) {
  const box = document.getElementById('stats-heatmap');
  if (!box) return;
  box.innerHTML = '';
  const max = Math.max(1, ...Object.values(keys));
  for (const row of HEATMAP_ROWS) {
    const rowEl = document.createElement('div');
    rowEl.className = 'hm-row';
    for (const cell of row) {
      const name = typeof cell === 'string' ? cell : cell.n;
      const c = keys[name] || 0;
      const el = document.createElement('span');
      el.className = 'hm-key' + (c ? ' hot' : '');
      el.textContent = keyLabel(name);
      el.title = `${keyLabel(name)}：${c} 次`;
      if (c) {
        const a = Math.min(1, 0.18 + 0.82 * Math.sqrt(c / max)); // 平方根让低频也可见
        el.style.background = `rgba(79,140,255,${a.toFixed(2)})`;
        el.style.color = a > 0.55 ? '#fff' : '';
      }
      if (typeof cell !== 'string' && cell.w) el.style.flexGrow = cell.w;
      rowEl.appendChild(el);
    }
    box.appendChild(rowEl);
  }
}

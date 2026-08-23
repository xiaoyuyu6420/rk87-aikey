// 设置页逻辑：键位列表 + 动作编辑 + 实时按键高亮标定

const TYPES = [
  { value: 'none',    label: '不动作' },
  { value: 'app',     label: '启动程序' },
  { value: 'url',     label: '打开网址' },
  { value: 'hotkey',  label: '发送快捷键' },
  { value: 'macro',   label: '宏（录制按键）' },
  { value: 'sys',     label: '系统：循环切档' },
];

let state = null; // { keys, bindings, bindingsAi, settings, deviceConnected }
let currentMode = 'fn'; // 'fn' 普通模式 | 'ai' AI 模式（两套绑定独立配置）
let macroRecordingRow = null; // 正在录制宏的键行（超时自动停时回填）

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
  initProfiles();
  initPageNav();

  initMicBridge();
  initStats();

  // 宏 30s 超时自动停 → 回填正在录制的行
  window.aikey.onMacroRecorded(data => {
    const row = macroRecordingRow;
    macroRecordingRow = null;
    if (!row || !row.isConnected) return;
    row._recording = false;
    row._macroSteps = data.steps || [];
    if (row._rerenderFields) row._rerenderFields();
    toast(`录制超时自动停止，已录 ${(data.steps || []).length} 步`);
  });

  window.aikey.onKeyEvent(ev => {
    if (ev.phase !== 'down') return;
    const row = document.querySelector(`.key-row[data-id="${ev.keyId}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 600);
  });

  console.log('[ui] init complete', state.profiles ? `档位 x${state.profiles.order.length}` : '');
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

  // 电池徽章（cmd=208 键盘主动上报）
  const bat = document.getElementById('battery-badge');
  window.aikey.onBattery(b => {
    bat.hidden = false;
    bat.textContent = `${b.charging ? '⚡' : '🔋'}${b.level}%`;
  });

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

// ---------- 配置档（多套键位一键切换 + 前台应用自动切档） ----------
function initProfiles() {
  renderProfileChips();
  initAppRules();
  // 主进程切档（托盘/自动/按键循环/删档回落）→ 拉新投影整体刷新
  window.aikey.onProfileChanged(async d => {
    state = await window.aikey.getState();
    renderProfileChips();
    renderList();
    updateTabCounts();
    if (d.reason === 'del') toast(`档已删除，回落到「${d.name}」`);
    else if (d.reason !== 'manual') toast(`已切到「${d.name}」档`);
  });
}

function renderProfileChips() {
  const box = document.getElementById('profile-chips');
  const p = state.profiles || { order: ['default'], names: { default: '默认' }, activeId: 'default', max: 5 };
  box.innerHTML = '';
  for (const id of p.order) {
    const chip = document.createElement('button');
    chip.className = 'profile-chip' + (id === p.activeId ? ' active' : '');
    chip.title = id === p.activeId ? '当前档' : '点击切换到此档';
    const label = document.createElement('span');
    label.textContent = p.names[id] || id;
    chip.appendChild(label);
    if (id !== 'default') {
      const del = document.createElement('span');
      del.className = 'chip-del';
      del.textContent = '✕';
      del.title = '删除此档（默认档不可删）';
      del.onclick = async e => {
        e.stopPropagation();
        if (!confirm(`删除档「${p.names[id]}」？该档键位与关联的自动切档规则一并删除。`)) return;
        const r = await window.aikey.profileOp({ op: 'del', id });
        if (r && r.ok === false) toast(r.error, true);
      };
      chip.appendChild(del);
    }
    chip.onclick = async () => {
      if (id === p.activeId) return;
      const r = await window.aikey.profileOp({ op: 'set-active', id });
      if (r && r.ok) {
        state = await window.aikey.getState(); // bindings 已是新档投影
        renderProfileChips();
        renderList();
        updateTabCounts();
      } else if (r) toast(r.error, true);
    };
    chip.ondblclick = () => { // 行内重命名（Electron 无 window.prompt）
      chip.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = p.names[id] || '';
      chip.appendChild(input);
      input.focus(); input.select();
      const commit = async () => {
        const name = input.value.trim();
        if (name && name !== p.names[id]) {
          const r = await window.aikey.profileOp({ op: 'rename', id, name });
          if (r && r.ok) state.profiles = r.profiles;
        }
        renderProfileChips();
      };
      input.onblur = commit;
      input.onkeydown = e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = ''; input.blur(); } };
    };
    box.appendChild(chip);
  }
  const add = document.createElement('button');
  add.className = 'profile-chip add';
  add.textContent = '＋';
  add.title = p.order.length >= p.max ? `已达上限（${p.max} 档）` : '新增档（复制当前档键位，双击可改名）';
  add.disabled = p.order.length >= p.max;
  add.onclick = async () => {
    const r = await window.aikey.profileOp({ op: 'add', name: `档${p.order.length + 1}` });
    if (r && r.ok) {
      state.profiles = r.profiles;
      renderProfileChips();
      toast('已新增档（复制了当前档键位），双击档名可改');
    } else if (r) toast(r.error, true);
  };
  box.appendChild(add);
}

// 前台应用自动切档规则：进程名 → 档位
function initAppRules() {
  const box = document.getElementById('app-rules');
  const addBtn = document.getElementById('rule-add');
  if (state.profiles && state.profiles.fgSupported === false) {
    document.getElementById('fg-platform-hint').textContent = '（自动检测仅 Windows，此处规则在 mac 上不生效）';
  }

  const save = async () => {
    const p = state.profiles;
    const rules = [];
    box.querySelectorAll('.rule-row').forEach(row => {
      const name = row.querySelector('.rule-name').value.trim().toLowerCase();
      const profileId = row.querySelector('.rule-profile').value;
      if (name && p.order.includes(profileId)) rules.push({ profileId, name });
    });
    const r = await window.aikey.profileOp({ op: 'set-rules', rules });
    if (r && r.ok) state.profiles = r.profiles;
  };

  const renderRules = () => {
    const p = state.profiles;
    box.innerHTML = '';
    const rules = (p && p.appRules) || [];
    for (const rule of rules) {
      const row = document.createElement('div');
      row.className = 'rule-row';
      const name = document.createElement('input');
      name.className = 'rule-name';
      name.type = 'text';
      name.placeholder = '进程名，如 wechat.exe';
      name.value = rule.name;
      name.onblur = save;
      const sel = document.createElement('select');
      sel.className = 'rule-profile';
      for (const id of p.order) {
        const o = document.createElement('option');
        o.value = id; o.textContent = p.names[id] || id;
        sel.appendChild(o);
      }
      sel.value = rule.profileId;
      sel.onchange = save;
      const del = document.createElement('button');
      del.className = 'ghost-btn';
      del.textContent = '✕';
      del.onclick = () => { row.remove(); save(); };
      row.append(name, sel, del);
      box.appendChild(row);
    }
    if (!rules.length) {
      const empty = document.createElement('span');
      empty.className = 'none-hint';
      empty.textContent = '还没有规则——点「添加规则」选一个程序（或手填进程名如 game.exe），切到该程序时自动换键位档';
      box.appendChild(empty);
    }
  };

  addBtn.onclick = async () => {
    const p = state.profiles;
    let name = '';
    try {
      const path = await window.aikey.pickProgram();
      if (path) name = (path.split(/[\\/]/).pop() || '').toLowerCase();
    } catch (_) { /* 选择器失败走手填 */ }
    if (name) {
      const r = await window.aikey.profileOp({ op: 'set-rules', rules: [...(p.appRules || []), { profileId: p.activeId, name }] });
      if (r && r.ok) state.profiles = r.profiles;
      renderRules();
    } else {
      p.appRules = [...(p.appRules || []), { profileId: p.activeId, name: '' }];
      renderRules();
      const rows = box.querySelectorAll('.rule-row');
      const last = rows[rows.length - 1];
      if (last) last.querySelector('.rule-name').focus();
    }
  };
  renderRules();
}


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
    if (t === 'macro') {
      row._macroSteps = row._macroSteps || binding.steps || [];
      const box = document.createElement('div');
      box.className = 'macro-box';
      // 步骤预览（键名 + 与上步间隔）
      const list = document.createElement('div');
      list.className = 'macro-steps';
      const steps = row._macroSteps || [];
      if (steps.length) {
        const show = steps.slice(0, 14);
        for (const s of show) {
          const item = document.createElement('span');
          item.className = 'macro-step';
          item.textContent = `${s.down ? '↓' : '↑'}${keyLabel(s.name)}${s.dt > 60 ? ` +${Math.round(s.dt)}ms` : ''}`;
          list.appendChild(item);
        }
        if (steps.length > show.length) {
          const more = document.createElement('span');
          more.className = 'macro-step more';
          more.textContent = `…共 ${steps.length} 步`;
          list.appendChild(more);
        }
      } else {
        const empty = document.createElement('span');
        empty.className = 'none-hint';
        empty.textContent = '未录制';
        list.appendChild(empty);
      }
      box.appendChild(list);
      // 控制按钮
      const ctrl = document.createElement('div');
      ctrl.className = 'macro-ctrl';
      const recBtn = document.createElement('button');
      recBtn.className = 'fixed';
      recBtn.onclick = async () => {
        if (!row._recording) {
          const r = await window.aikey.macroOp({ op: 'start' });
          if (!r.ok) { toast(r.error, true); return; }
          row._recording = true;
          macroRecordingRow = row;
          toast('录制中… 直接按键（最长 30 秒，再点「停止」结束）');
        } else {
          const r = await window.aikey.macroOp({ op: 'stop' });
          row._recording = false;
          macroRecordingRow = null;
          if (r.ok) {
            row._macroSteps = r.steps || [];
            toast(`已录 ${row._macroSteps.length} 步，记得点「保存」`);
          } else toast(r.error, true);
          renderFields();
          return;
        }
        recBtn.textContent = '■ 停止';
        recBtn.classList.add('recording');
      };
      recBtn.textContent = row._recording ? '■ 停止' : '● 录制';
      recBtn.classList.toggle('recording', !!row._recording);
      const playBtn = document.createElement('button');
      playBtn.textContent = '▶ 试听';
      playBtn.onclick = async () => {
        if (!row._macroSteps || !row._macroSteps.length) { toast('宏为空，先录制', true); return; }
        const r = await window.aikey.testAction({ type: 'macro', steps: row._macroSteps });
        if (r && r.ok === false) toast(r.error, true);
      };
      const clearBtn = document.createElement('button');
      clearBtn.textContent = '清除';
      clearBtn.onclick = () => { row._macroSteps = []; renderFields(); };
      ctrl.append(recBtn, playBtn, clearBtn);
      box.appendChild(ctrl);
      const hint = document.createElement('div');
      hint.className = 'none-hint';
      hint.textContent = '录制期间键盘绑定动作暂停执行、原按键照常透传（可在目标输入框实时看到）；只录标准系统键，AI 扩展键位不进录制。';
      box.appendChild(hint);
      fields.appendChild(box);
    }
    if (t === 'sys') {
      const span = document.createElement('span');
      span.className = 'none-hint';
      span.textContent = '按下此键在全部键位档之间循环切换';
      fields.appendChild(span);
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
    if (t === 'macro') action.steps = row._macroSteps || [];
    if (t === 'sys') action.op = 'profile-cycle';
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
  row._rerenderFields = renderFields; // 宏超时自动停时从外部重渲染本行
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

  // 透传修饰键（仅 Windows：微信输入法「按住说话」强制组合键）
  if (navigator.userAgent.includes('Windows')) {
    const modRow = document.getElementById('mic-pass-mod-row');
    const modSel = document.getElementById('mic-pass-mod');
    modRow.hidden = false;
    modSel.value = state.settings.micPassMod || 'none';
    modSel.onchange = async () => {
      state.settings.micPassMod = modSel.value;
      await window.aikey.setSettings({ micPassMod: modSel.value });
    };
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
  ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Win', fn: 'Fn',
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

  // 轴体寿命（累计 ÷ 单键 5000 万次额定寿命，趣味估算）
  renderSwitchLife(s.lifetime);

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
// 轴体寿命：累计总击 + 最辛劳键的寿命进度条
const SWITCH_LIFE = 50e6;
function renderSwitchLife(life) {
  const box = document.getElementById('switch-life');
  if (!box) return;
  box.innerHTML = '';
  const total = (life && life.total) || 0;
  const cap = document.createElement('div');
  cap.className = 'lifetime-total';
  cap.textContent = total ? `累计 ${total.toLocaleString()} 次` : '暂无累计数据（开始打字后出现）';
  box.appendChild(cap);
  const top = total && Object.entries(life.keys || {}).sort((a, b) => b[1] - a[1])[0];
  if (!top) return;
  const pct = top[1] / SWITCH_LIFE * 100;
  const row = document.createElement('div');
  row.className = 'tk-row';
  const name = document.createElement('span');
  name.className = 'tk-name';
  name.textContent = keyLabel(top[0]);
  const bar = document.createElement('div');
  bar.className = 'tk-bar';
  bar.style.width = Math.max(3, Math.min(100, pct)) + '%';
  const val = document.createElement('span');
  val.className = 'tk-count';
  val.textContent = `${top[1].toLocaleString()} 次 · ${pct.toFixed(3)}%`;
  row.append(name, bar, val);
  box.appendChild(row);
}

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

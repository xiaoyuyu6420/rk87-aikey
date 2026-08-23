// 配置读写：userData/config.json，无第三方依赖

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { KEY_DEFS } = require('./keymap');

const DEFAULTS = {
  // bindings: keyId -> action（普通模式，形状见 actions.js 注释）
  // bindingsAi: keyId -> action（AI 模式，独立于普通模式配置）
  bindings: {},
  bindingsAi: {},
  settings: {
    triggerOnUp: false,       // 预留：在抬起时触发（默认按下即触发）
    micBridgeEnabled: false,  // 键盘麦克风 → 虚拟声卡桥接
    micSinkId: '',            // 桥接播放设备（虚拟声卡播放端，如 CABLE Input）
    micTriggerKeys: ['f10', 'ai_key'], // 按住即开麦的键（可设置）
    statsEnabled: true,      // 打字统计（只记每键计数与每日总数，纯本地 stats.json）
    fatigueEnabled: true,    // 疲劳提醒（连续打字满阈值弹系统通知）
    fatigueMinutes: 25,      // 疲劳提醒阈值（分钟）
  },
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const cfg = JSON.parse(raw);
    return {
      bindings: { ...cfg.bindings },
      bindingsAi: { ...(cfg.bindingsAi || cfg.bindings || {}) },
      labels: { ...(cfg.labels || {}) },
      settings: { ...DEFAULTS.settings, ...(cfg.settings || {}) },
    };
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function save(cfg) {
  const dir = path.dirname(configPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

function defaultBinding(keyId) {
  return { type: 'none' };
}

module.exports = { load, save, defaultBinding, DEFAULTS };

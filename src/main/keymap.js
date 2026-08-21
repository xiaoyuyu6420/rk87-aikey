// R87 Pro AI 键码表（逆向 + 两轮实机标定确认，见 docs/protocol.md）
// phase: down = 按下, up = 抬起

const KEY_DEFS = [
  { code: 51, up: 66, id: 'ai_key', label: 'AI 键（官方: AI问答）' },
  { code: 82, up: 97, id: 'f1',  label: 'F1（官方: 文字校对）' },
  { code: 58, up: 73, id: 'f2',  label: 'F2（官方: 阅读）' },
  { code: 55, up: 70, id: 'f3',  label: 'F3（官方: 写作）' },
  { code: 63, up: 78, id: 'f4',  label: 'F4（官方: 长文写作）' },
  { code: 60, up: 75, id: 'f5',  label: 'F5（官方: 心得体会）' },
  { code: 59, up: 74, id: 'f6',  label: 'F6（官方: PPT）' },
  { code: 53, up: 68, id: 'f7',  label: 'F7（官方: 绘图）' },
  { code: 54, up: 69, id: 'f8',  label: 'F8（官方: 表格）' },
  { code: 83, up: 98, id: 'f9',  label: 'F9（官方: 项目方案）' },
  { code: 48, up: 57, id: 'f10', label: 'F10（官方: 语音打字）' },
  { code: 49, up: 64, id: 'f11', label: 'F11（官方: 翻译）' },
  { code: 50, up: 65, id: 'f12', label: 'F12（官方: 截图）' },
  { code: 56, up: 71, id: 'prtsc', label: 'PrtSc（官方: 思维导图）' },
  // 以下键码在本机两轮标定中未出现，属于协议内其他功能位，保留可配置
  { code: 80, up: 95, id: 'ext_1', label: '扩展键位·上网' },
  { code: 61, up: 76, id: 'ext_2', label: '扩展键位·工作总结' },
  { code: 62, up: 77, id: 'ext_3', label: '扩展键位·模板' },
  { code: 81, up: 96, id: 'ext_4', label: '扩展键位·通用短文写作' },
];

const byCode = new Map();
for (const def of KEY_DEFS) {
  byCode.set(def.code, { ...def, phase: 'down' });
  byCode.set(def.up, { ...def, phase: 'up' });
}

function lookupKey(code) {
  return byCode.get(code) || null;
}

function allKeys() {
  return KEY_DEFS;
}

module.exports = { lookupKey, allKeys, KEY_DEFS };

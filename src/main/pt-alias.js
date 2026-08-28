// 透传键名决策（纯函数，无依赖，便于单测）：
// 远控防串键开启时，语音触发键的主键改发冷门键码 F13（普通键盘没有此键），
// 合成修饰键由调用方照常附加 → 实际序列如 Ctrl+F13。转发到被控端后修饰键
// 退化也只可能是 F13，打不中远端任何常见配置；UU远程「仅控制端响应的快捷键」
// 白名单只收单键，加一条 F13 即可彻底不转发。
// 生效条件：仅 win32 + 已开启 remoteSafeMode + 已选透传修饰键（微信输入法
// 「按住说话」强制组合键，纯 F13 配不进去）+ 该键在语音触发键列表内。
const REMOTE_SAFE_KEY = 'f13';
const REMOTE_SAFE_VK = 0x7c; // VK_F13

function passKeyNameOf(settings, keyId, isWin) {
  if (!settings || !isWin || !settings.remoteSafeMode) return keyId;
  if (!['ctrl', 'alt', 'shift'].includes(settings.micPassMod)) return keyId;
  if (!(settings.micTriggerKeys || []).includes(keyId)) return keyId;
  return REMOTE_SAFE_KEY;
}

module.exports = { REMOTE_SAFE_KEY, REMOTE_SAFE_VK, passKeyNameOf };

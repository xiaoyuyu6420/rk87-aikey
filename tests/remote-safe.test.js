// 远控防串键单测（纯逻辑，stub electron）：键名决策表 + 配置默认值兼容
const path = require('path');
const fs = require('fs');
const os = require('os');

// stub electron：config.js 只用 app.getPath('userData')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rk87-rs-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => TMP } },
};

const { REMOTE_SAFE_KEY, REMOTE_SAFE_VK, passKeyNameOf } = require('../src/main/pt-alias');
const config = require('../src/main/config.js');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

console.log('[T1] passKeyNameOf 决策表');
{
  const S = (over) => ({ remoteSafeMode: true, micPassMod: 'ctrl', micTriggerKeys: ['f10', 'ai_key'], ...over });

  ok(passKeyNameOf(S(), 'f10', true) === REMOTE_SAFE_KEY, 'win+开启+ctrl+语音键 → f13');
  ok(passKeyNameOf(S(), 'ai_key', true) === REMOTE_SAFE_KEY, 'AI 键同样替换');
  ok(passKeyNameOf(S(), 'f5', true) === 'f5', '非语音触发键不替换');
  ok(passKeyNameOf(S({ micPassMod: 'none' }), 'f10', true) === 'f10', '修饰键=无 不替换（微信配不进纯 F13）');
  ok(passKeyNameOf(S({ remoteSafeMode: false }), 'f10', true) === 'f10', '开关关闭不替换');
  ok(passKeyNameOf(undefined, 'f10', true) === 'f10', 'settings 缺失安全回落');
  ok(passKeyNameOf(S(), 'f10', false) === 'f10', 'mac 恒不替换（mac 无组合键强制）');

  // 决策只改主键名：修饰键由调用方照常附加（序列语义在 index.js 集成）
  ok(REMOTE_SAFE_KEY === 'f13' && REMOTE_SAFE_VK === 0x7c, '冷门键常量：VK_F13=0x7C');
}

console.log('[T2] 配置默认值与旧文件兼容');
{
  const cfg1 = config.load();
  ok(cfg1.settings.remoteSafeMode === false, '缺省 remoteSafeMode=false');

  // 旧格式配置文件（无该字段）迁移后补默认值，不报错
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    bindings: { f5: { type: 'hotkey', combo: 'Ctrl+S' } },
    settings: { micPassMod: 'ctrl', fatigueMinutes: 9 },
  }));
  const cfg2 = config.load();
  ok(cfg2.settings.remoteSafeMode === false && cfg2.settings.micPassMod === 'ctrl',
    '旧文件合并：新字段补默认、旧字段保留');
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

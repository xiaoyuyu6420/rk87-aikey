// 配置档迁移与档操作单测（纯逻辑，stub electron）
const path = require('path');
const fs = require('fs');
const os = require('os');

// stub electron：config.js 只用 app.getPath('userData')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rk87-cfg-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => TMP } },
};

const config = require('../src/main/config.js');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };
const eqJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('[T1] 旧格式迁移：绑定整体进 default 档');
{
  const legacy = {
    bindings: { f5: { type: 'hotkey', combo: 'Ctrl+S' } },
    bindingsAi: { f6: { type: 'url', target: 'https://a.com' } },
    labels: { f5: '保存' },
    settings: { statsEnabled: false },
  };
  const m1 = config.migrateRaw(legacy);
  ok(m1.profiles.order.length === 1 && m1.profiles.order[0] === 'default', 'order = [default]');
  ok(m1.bindingsByProfile.default.bindings.f5.combo === 'Ctrl+S', 'bindings 进档');
  ok(m1.bindingsByProfile.default.bindingsAi.f6.type === 'url', 'bindingsAi 进档');
  ok(m1.profiles.activeId === 'default', 'activeId = default');
  ok(m1.appRules.length === 0, 'appRules 空');
  // 幂等：对迁移结果再迁移一次，语义不变
  const m2 = config.migrateRaw({ ...legacy, ...m1 });
  ok(eqJSON(m1, m2), '迁移幂等（跑两次结果一致）');
}

console.log('[T2] load() 全链路：备份 + 引用投影 + settings/labels 保留');
{
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    bindings: { f5: { type: 'hotkey', combo: 'Ctrl+S' } },
    settings: { fatigueMinutes: 10 },
  }));
  const cfg = config.load();
  ok(fs.existsSync(path.join(TMP, 'config.json.bak')), '首次迁移生成 .bak');
  ok(cfg.bindings.f5.combo === 'Ctrl+S', '旧绑定可见于顶层投影');
  ok(cfg.bindings === cfg.bindingsByProfile.default.bindings, '顶层 bindings 是档内引用（写即同步）');
  ok(cfg.bindingsAi === cfg.bindingsByProfile.default.bindingsAi, '顶层 bindingsAi 同为引用');
  ok(cfg.settings.fatigueMinutes === 10 && cfg.settings.statsEnabled === true, 'settings 合并默认值');
  // 写顶层 = 写档：save 后重 load 仍在
  cfg.bindings.f7 = { type: 'app', target: 'C:/x.exe' };
  config.save(cfg);
  const cfg2 = config.load();
  ok(cfg2.bindingsByProfile.default.bindings.f7.type === 'app', '写投影落盘后重载仍在档内');
  ok(fs.existsSync(path.join(TMP, 'config.json.bak')), '.bak 未被覆盖（仅首次）');
}

console.log('[T3] 新格式防御：幽灵档过滤 / activeId 回落 / 规则级联');
{
  const m = config.migrateRaw({
    profiles: { order: ['default', 'p1', 'ghost'], activeId: 'p1', names: { p1: '游戏' } },
    bindingsByProfile: {
      default: { bindings: {}, bindingsAi: {} },
      p1: { bindings: { f8: { type: 'none' } }, bindingsAi: {} },
    },
    appRules: [
      { profileId: 'p1', name: 'game.exe' },
      { profileId: 'ghost', name: 'x.exe' },
    ],
  });
  ok(!m.profiles.order.includes('ghost'), '幽灵档被过滤');
  ok(m.profiles.activeId === 'p1', '合法 activeId 保留');
  ok(m.appRules.length === 1 && m.appRules[0].name === 'game.exe', '指向幽灵档的规则被清');
  ok(m.profiles.names.p1 === '游戏' && m.profiles.names.default === '默认', '档名保留+默认名兜底');

  const m2 = config.migrateRaw({
    profiles: { order: ['default'], activeId: 'gone' },
    bindingsByProfile: { default: { bindings: {}, bindingsAi: {} } },
  });
  ok(m2.profiles.activeId === 'default', 'activeId 指向不存在档回落 default');
}

console.log('[T4] 档操作：增/删/切');
{
  const cfg = config.load(); // 已迁移过的环境
  const id1 = config.addProfile(cfg, '办公');
  ok(!!id1 && cfg.profiles.order.includes(id1), 'addProfile 入 order');
  ok(cfg.bindingsByProfile[id1].bindings.f5.combo === 'Ctrl+S', '新档复制当前档键位');
  cfg.bindingsByProfile[id1].bindings.f9 = { type: 'url', target: 'https://b.com' };
  ok(config.setActive(cfg, id1) && cfg.bindings.f9.target === 'https://b.com', '切档后投影指向新档');
  ok(cfg.bindings.f5.combo === 'Ctrl+S', '新档里原绑定也在（复制语义）');
  // 删 active 档：回落 default + 规则级联
  cfg.appRules = [{ profileId: id1, name: 'a.exe' }, { profileId: 'default', name: 'b.exe' }];
  const back = config.delProfile(cfg, id1);
  ok(back === 'default' && cfg.profiles.activeId === 'default', '删 active 档回落 default');
  ok(!cfg.bindings.f9, '投影已切回 default（f9 不在）');
  ok(cfg.appRules.length === 1 && cfg.appRules[0].name === 'b.exe', '级联删规则');
  ok(config.delProfile(cfg, 'default') === null, 'default 档不可删');
  // 上限 5 档
  let n = cfg.profiles.order.length;
  while (cfg.profiles.order.length < 5) config.addProfile(cfg, 'x' + n++);
  ok(config.addProfile(cfg, '超') === null, '第 6 档被拒（上限 5）');
}

console.log(`\n结果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { desiredState, restoreState, validateBackup, createManager, GOOGLE, PRELOAD, KEEP } = require('../scripts/manage-tv-optimizations');
function state() {
  return { general: { homePromotion: 'on', screenSaverAd: 'on', screenSaverEnabled: 'on', defaultApps: { home: 'org.lggate.launcher', voice: 'lg.voice' } },
    option: { livePlus: 'on' }, configs: { [KEEP]: ['voice', GOOGLE, 'input'],
      [PRELOAD]: [{ id: 'input', isEnabled: true, requiredMemory: 40 }, { id: GOOGLE, isEnabled: true, isPinUp: true, requiredMemory: 42 }, { id: 'airplay', isEnabled: false }] } };
}
test('Оптимизация отключает только три рекламных переключателя и предзагрузку одного Assistant', () => {
  const before = state(), next = desiredState(before);
  assert.deepEqual(before, state());
  assert.equal(next.general.screenSaverEnabled, 'on');
  assert.deepEqual(next.general.defaultApps, before.general.defaultApps);
  assert.equal(next.general.homePromotion, 'off'); assert.equal(next.general.screenSaverAd, 'off'); assert.equal(next.option.livePlus, 'off');
  assert.deepEqual(next.configs[KEEP], ['voice', 'input']);
  assert.deepEqual(next.configs[PRELOAD], [before.configs[PRELOAD][0], { ...before.configs[PRELOAD][1], isEnabled: false }, before.configs[PRELOAD][2]]);
  assert.deepEqual(desiredState(next), next);
});
test('Откат сохраняет новые приложения, их политики и текущее назначение Home', () => {
  const original = state(), current = desiredState(original);
  current.configs[KEEP].push('new.voice'); current.configs[PRELOAD].push({ id: 'new.app', isEnabled: true });
  current.configs[PRELOAD][0].requiredMemory = 99;
  current.general.defaultApps.home = 'other.home'; current.general.screenSaverEnabled = 'off';
  const restored = restoreState(current, { version: 1, appId: 'org.lggate.launcher', original });
  assert.deepEqual(restored.configs[KEEP], ['voice', GOOGLE, 'input', 'new.voice']);
  assert.equal(restored.configs[PRELOAD][1].isEnabled, true);
  assert.equal(restored.configs[PRELOAD][0].requiredMemory, 99);
  assert.equal(restored.configs[PRELOAD][3].id, 'new.app');
  assert.equal(restored.general.defaultApps.home, 'other.home'); assert.equal(restored.general.screenSaverEnabled, 'off');
});
test('Неизвестная/повреждённая резервная копия и дубли Assistant отклоняются', () => {
  assert.throws(() => validateBackup({ version: 2, appId: 'org.lggate.launcher', original: state() }));
  const invalid = state(); invalid.configs[PRELOAD].push({ id: GOOGLE, isEnabled: true });
  assert.throws(() => desiredState(invalid));
});
test('Inspect выполняет только чтение; неизвестная команда не обращается к ТВ', async () => {
  const calls = [], before = state();
  const manager = createManager(async command => {
    calls.push(command);
    if (command.includes('getConfigs')) return JSON.stringify({ returnValue: true, configs: before.configs });
    if (command.includes('getSystemSettings')) return JSON.stringify({ returnValue: true, settings: command.includes('livePlus') ? before.option : before.general });
    throw Error('Unexpected mutation');
  });
  assert.deepEqual(await manager.main('inspect'), before);
  assert.equal(calls.length, 3);
  await assert.rejects(manager.main('unknown'));
  assert.equal(calls.length, 3);
});

function device(options = {}) {
  let current = state(), backup = '', backupConfirmed = false;
  const writes = [];
  const manager = createManager(async command => {
    if (command === 'id -u') return '0';
    if (command.startsWith('if test -f ')) { if (backup) backupConfirmed = true; return backup; }
    if (command.startsWith('mkdir -p ')) {
      if (options.backupFailure) throw Error('Backup unavailable');
      backup = command.match(/printf %s '(.+)' > /)[1]; return '';
    }
    const match = command.match(/'([^']+)' '([^']+)'$/);
    assert.ok(match, 'Only expected structured Luna commands are used');
    const uri = match[1], params = JSON.parse(match[2]);
    if (uri.endsWith('/getSystemSettings')) return JSON.stringify({ returnValue: true, settings: current[params.category] });
    if (uri.endsWith('/getConfigs')) {
      const configs = JSON.parse(JSON.stringify(current.configs));
      if (options.concurrentChange && writes.length) configs[KEEP].push('concurrent.app');
      return JSON.stringify({ returnValue: true, configs });
    }
    assert.equal(backupConfirmed, true, 'Backup is saved and verified before any mutation');
    writes.push({ uri, params });
    if (uri.endsWith('/setSystemSettings')) Object.assign(current[params.category], params.settings);
    else if (uri.endsWith('/setConfigs')) current.configs = params.configs;
    else if (uri.endsWith('/setPreloadPolicy')) {
      if (options.policyFailure) return JSON.stringify({ returnValue: false, errorText: 'Policy unavailable' });
      assert.deepEqual(params, { application: { id: GOOGLE, isEnabled: false } });
    } else assert.fail('Unexpected mutation: ' + uri);
    return JSON.stringify({ returnValue: true });
  });
  return { manager, writes, current: () => current };
}
test('Apply подтверждает backup до записей и проверяет конечное состояние', async () => {
  const tv = device(); const result = await tv.manager.main('apply');
  assert.deepEqual(result.state, desiredState(state()));
  assert.equal(tv.writes.length, 4);
  assert.equal(result.residentAppClosed, false);
});
test('Ошибка backup запрещает все изменения', async () => {
  const tv = device({ backupFailure: true });
  await assert.rejects(tv.manager.main('apply'), /Backup unavailable/);
  assert.equal(tv.writes.length, 0);
});
test('Частичный отказ явно сообщает о сохранённом откате', async () => {
  const tv = device({ policyFailure: true });
  await assert.rejects(tv.manager.main('apply'), /Policy unavailable.*частичные изменения.*optimizations-original.*restore/);
  assert.equal(tv.current().general.screenSaverEnabled, 'on');
  assert.deepEqual(tv.current().general.defaultApps, state().general.defaultApps);
});
test('Изменившийся параллельно список не перезаписывается', async () => {
  const tv = device({ concurrentChange: true });
  await assert.rejects(tv.manager.main('apply'), /изменилась во время настройки/);
  assert.equal(tv.writes.some(call => call.uri.endsWith('/setConfigs')), false);
});

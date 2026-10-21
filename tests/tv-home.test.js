'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { APP_ID, applySettings, restoreSettings, validateBackup } = require('../scripts/manage-tv-home');
const original = { defaultApps: { home: 'com.webos.app.fullhome', browser: 'vendor.browser' }, homeAutoLaunch: 'off', homeAutoLaunchMode: 'full' };
const backup = { version: 1, appId: APP_ID, settings: original };

test('Назначение Home сохраняет другие defaultApps и не меняет исходный объект', () => {
  const result = applySettings(original);
  assert.deepEqual(result, { defaultApps: { home: APP_ID, browser: 'vendor.browser' }, homeAutoLaunch: 'on' });
  assert.equal(original.defaultApps.home, 'com.webos.app.fullhome');
  assert.equal(original.homeAutoLaunch, 'off');
  assert.equal(applySettings({ defaultApps: { home: 'existing.home' } }).homeAutoLaunch, undefined);
});
test('Откат восстанавливает исходный Home, сохраняя последующие настройки других приложений', () => {
  const current = { defaultApps: { home: APP_ID, browser: 'new.browser', music: 'new.music' }, homeAutoLaunch: 'on' };
  assert.deepEqual(restoreSettings(current, backup), { defaultApps: { home: 'com.webos.app.fullhome', browser: 'new.browser', music: 'new.music' }, homeAutoLaunch: 'off' });
  assert.equal(current.defaultApps.home, APP_ID);
});
test('Откат не перезаписывает выбор Home, сделанный вне LG Gate', () => {
  assert.throws(() => restoreSettings({ defaultApps: { home: 'another.launcher' } }, backup), /изменён вне/);
});
test('Неполная, чужая или уже переназначенная резервная копия не применяется', () => {
  for (const value of [null, {}, { version: 1, appId: 'other', settings: original }, { version: 1, appId: APP_ID, settings: { defaultApps: { home: APP_ID } } }, { version: 1, appId: APP_ID, settings: { defaultApps: [] } }]) {
    assert.throws(() => validateBackup(value));
  }
  for (const value of [null, {}, { defaultApps: {} }, { defaultApps: { home: '' } }]) assert.throws(() => applySettings(value));
});

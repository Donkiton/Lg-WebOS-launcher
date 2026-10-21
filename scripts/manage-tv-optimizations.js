'use strict';

// Explicit, reversible device settings. No app is killed and no vendor file is edited.
const { isDeepStrictEqual } = require('node:util');
const { ssh, quote, APP_ID } = require('./manage-tv-home');
const GOOGLE = 'com.webos.app.googleassistant';
const PRELOAD = 'com.webos.service.preloadmanager.supportAppList';
const KEEP = 'com.webos.applicationManager.keepAliveApps';
const BACKUP = '/var/lib/lg-gate/optimizations-original.json';
const GENERAL = ['homePromotion', 'screenSaverAd'];
const SETTINGS = 'luna://com.webos.settingsservice/';
const CONFIG = 'luna://com.webos.service.config/';
const copy = value => JSON.parse(JSON.stringify(value));

function validateState(state) {
  if (!state || !state.general || !state.option || !state.configs ||
      !GENERAL.every(key => ['on', 'off'].includes(state.general[key])) ||
      !['on', 'off'].includes(state.option.livePlus) ||
      !['on', 'off'].includes(state.general.screenSaverEnabled) ||
      !Array.isArray(state.configs[KEEP]) || !state.configs[KEEP].every(id => typeof id === 'string') ||
      !Array.isArray(state.configs[PRELOAD]) ||
      !state.configs[PRELOAD].every(entry => entry && typeof entry.id === 'string')) throw Error('Телевизор не сообщил ожидаемые настройки оптимизации.');
  const entries = state.configs[PRELOAD].filter(entry => entry && entry.id === GOOGLE);
  if (entries.length !== 1 || typeof entries[0].isEnabled !== 'boolean') throw Error('Неоднозначная запись предзагрузки Google Assistant.');
  return state;
}
function validateBackup(backup) {
  if (!backup || backup.version !== 1 || backup.appId !== APP_ID) throw Error('Неизвестная резервная копия оптимизаций.');
  validateState(backup.original);
  return backup;
}
function desiredState(current) {
  validateState(current);
  const next = copy(current);
  GENERAL.forEach(key => { next.general[key] = 'off'; });
  next.option.livePlus = 'off';
  next.configs[KEEP] = next.configs[KEEP].filter(id => id !== GOOGLE);
  next.configs[PRELOAD].find(entry => entry.id === GOOGLE).isEnabled = false;
  return next;
}
function restoreState(current, backup) {
  validateState(current); validateBackup(backup);
  const next = copy(current), original = backup.original;
  GENERAL.forEach(key => { next.general[key] = original.general[key]; });
  next.option.livePlus = original.option.livePlus;
  // Restore only our one app. Preserve newer entries and edits to other apps.
  const index = original.configs[KEEP].indexOf(GOOGLE);
  next.configs[KEEP] = next.configs[KEEP].filter(id => id !== GOOGLE);
  if (index >= 0) next.configs[KEEP].splice(Math.min(index, next.configs[KEEP].length), 0, GOOGLE);
  next.configs[PRELOAD].find(entry => entry.id === GOOGLE).isEnabled =
    original.configs[PRELOAD].find(entry => entry.id === GOOGLE).isEnabled;
  return next;
}
function createManager(transport = ssh) {
  async function rpc(uri, params) {
    const value = JSON.parse(await transport('luna-send -n 1 -f ' + quote(uri) + ' ' + quote(JSON.stringify(params))));
    if (value.returnValue !== true) throw Error(value.errorText || 'webOS отклонила настройку оптимизации.');
    return value;
  }
  async function inspect() {
    const [general, option, configs] = await Promise.all([
      rpc(SETTINGS + 'getSystemSettings', { category: 'general', keys: GENERAL.concat(['screenSaverEnabled', 'defaultApps']) }),
      rpc(SETTINGS + 'getSystemSettings', { category: 'option', keys: ['livePlus'] }),
      rpc(CONFIG + 'getConfigs', { configNames: [PRELOAD, KEEP] })
    ]);
    return validateState({ general: general.settings, option: option.settings, configs: configs.configs });
  }
  async function readBackup() {
    const value = await transport('if test -f ' + quote(BACKUP) + '; then cat ' + quote(BACKUP) + '; fi');
    return value.trim() ? validateBackup(JSON.parse(value)) : null;
  }
  async function saveOriginal(state) {
    const existing = await readBackup();
    if (existing) return existing;
    const backup = validateBackup({ version: 1, appId: APP_ID, createdAt: new Date().toISOString(), original: state });
    await transport('mkdir -p /var/lib/lg-gate && chmod 700 /var/lib/lg-gate && umask 077 && set -C && printf %s ' + quote(JSON.stringify(backup)) + ' > ' + quote(BACKUP));
    const saved = await readBackup();
    if (!saved || !isDeepStrictEqual(saved.original, state)) throw Error('Резервная копия оптимизаций не подтверждена.');
    return saved;
  }
  async function writeAndVerify(before, next) {
    // Only these three advertising switches and two app-specific config keys.
    // screenSaverEnabled, defaultApps, voice agreements and other apps are untouched.
    const general = {};
    GENERAL.forEach(key => { general[key] = next.general[key]; });
    await rpc(SETTINGS + 'setSystemSettings', { category: 'general', settings: general });
    await rpc(SETTINGS + 'setSystemSettings', { category: 'option', settings: { livePlus: next.option.livePlus } });
    // Do not overwrite a concurrent configuration change with our earlier snapshot.
    const latest = await rpc(CONFIG + 'getConfigs', { configNames: [PRELOAD, KEEP] });
    if (!isDeepStrictEqual(latest.configs, before.configs)) throw Error('Конфигурация приложений изменилась во время настройки.');
    const configs = {};
    configs[PRELOAD] = next.configs[PRELOAD]; configs[KEEP] = next.configs[KEEP];
    await rpc(CONFIG + 'setConfigs', { configs });
    const enabled = next.configs[PRELOAD].find(entry => entry.id === GOOGLE).isEnabled;
    await rpc('luna://com.webos.service.preloadmanager/setPreloadPolicy', { application: { id: GOOGLE, isEnabled: enabled } });
    const actual = await inspect();
    if (!isDeepStrictEqual(actual, next)) throw Error('Проверка настроек не прошла. Выполните inspect; исходные значения сохранены.');
    if (actual.general.screenSaverEnabled !== before.general.screenSaverEnabled ||
        !isDeepStrictEqual(actual.general.defaultApps, before.general.defaultApps)) throw Error('Изменились защищённые настройки заставки/Home.');
    return { state: actual, backup: BACKUP, residentAppClosed: false, restartVerificationRequired: true };
  }
  async function main(action) {
    if (!['inspect', 'apply', 'restore'].includes(action)) throw Error('Команда: node scripts/manage-tv-optimizations.js inspect | apply | restore');
    const current = await inspect();
    if (action === 'inspect') return current;
    if ((await transport('id -u')).trim() !== '0') throw Error('Требуется существующий root-доступ.');
    if (action === 'restore') {
      const backup = await readBackup();
      if (!backup) throw Error('Исходные настройки оптимизации не сохранены.');
      try { return await writeAndVerify(current, restoreState(current, backup)); }
      catch (failure) { throw Error(failure.message + ' Возможны частичные изменения; исходная копия: ' + BACKUP + '. Проверка: inspect; откат: restore.'); }
    }
    await saveOriginal(current);
    try { return await writeAndVerify(current, desiredState(current)); }
    catch (failure) { throw Error(failure.message + ' Возможны частичные изменения; исходная копия: ' + BACKUP + '. Проверка: inspect; откат: restore.'); }
  }
  return { main, inspect };
}
if (require.main === module) createManager().main(process.argv[2]).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createManager, validateState, validateBackup, desiredState, restoreState, GOOGLE, PRELOAD, KEEP, BACKUP };

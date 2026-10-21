'use strict';

// Explicit device configuration; never called by npm start or package:tv.
// This TV's SystemSettings.qml reads general.defaultApps.home and its native
// Home key handler launches that ID. The key's description has volatile:false.
const cp = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const APP_ID = 'org.lggate.launcher';
const BACKUP = '/var/lib/lg-gate/home-original.json';
const SERVICE = 'luna://com.webos.settingsservice/';
const KEYS = ['defaultApps', 'homeAutoLaunch', 'homeAutoLaunchMode'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function validateSettings(settings) {
  if (!object(settings) || !object(settings.defaultApps) || typeof settings.defaultApps.home !== 'string' || !settings.defaultApps.home) {
    throw new Error('Телевизор не сообщил действующее приложение Home.');
  }
  return settings;
}
function validateBackup(backup) {
  if (!object(backup) || backup.version !== 1 || backup.appId !== APP_ID) throw new Error('Резервная копия Home не принадлежит LG Gate.');
  validateSettings(backup.settings);
  if (backup.settings.defaultApps.home === APP_ID) throw new Error('Резервная копия должна содержать исходный Home.');
  return backup;
}
function applySettings(current) {
  validateSettings(current);
  const result = { defaultApps: Object.assign({}, current.defaultApps, { home: APP_ID }) };
  if (own(current, 'homeAutoLaunch')) result.homeAutoLaunch = 'on';
  return result;
}
function restoreSettings(current, backup) {
  validateSettings(current); validateBackup(backup);
  if (current.defaultApps.home !== APP_ID) throw new Error('Home уже изменён вне LG Gate; восстановление остановлено, чтобы сохранить этот выбор.');
  const result = { defaultApps: Object.assign({}, current.defaultApps, { home: backup.settings.defaultApps.home }) };
  if (own(backup.settings, 'homeAutoLaunch')) result.homeAutoLaunch = backup.settings.homeAutoLaunch;
  return result;
}
function ssh(command) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('ssh', ['-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'lg-tv', command], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '', stderr = '', failure;
    const timer = setTimeout(() => { failure = Error('Истекло время ответа телевизора.'); child.kill(); }, 15000);
    child.on('error', error => { failure = error; });
    child.stdout.on('data', bytes => {
      output += bytes;
      if (Buffer.byteLength(output) > 1048576) { failure = Error('Слишком большой ответ телевизора.'); child.kill(); }
    });
    child.stderr.on('data', bytes => { if (stderr.length < 4096) stderr += bytes; });
    child.on('close', code => {
      clearTimeout(timer); child.stdin.destroy();
      if (failure || code !== 0) reject(failure || Error('SSH: ' + stderr.trim()));
      else resolve(output);
    });
    // Keep stdin open: on this firmware luna-send exits when it sees EOF.
  });
}
async function rpc(method, params) {
  const response = JSON.parse(await ssh('luna-send -n 1 -f ' + quote(SERVICE + method) + ' ' + quote(JSON.stringify(params))));
  if (response.returnValue !== true) throw Error(response.errorText || 'webOS отклонила настройку Home.');
  return response;
}
async function inspect() {
  return validateSettings((await rpc('getSystemSettings', { category: 'general', keys: KEYS })).settings);
}
async function readBackup() {
  const value = await ssh('if test -f ' + quote(BACKUP) + '; then cat ' + quote(BACKUP) + '; fi');
  return value.trim() ? validateBackup(JSON.parse(value)) : null;
}
async function saveOriginal(settings) {
  const existing = await readBackup();
  if (existing) return existing;
  const backup = validateBackup({ version: 1, appId: APP_ID, createdAt: new Date().toISOString(), settings });
  // noclobber makes a concurrent or repeated apply preserve the first backup.
  await ssh('mkdir -p /var/lib/lg-gate && chmod 700 /var/lib/lg-gate && umask 077 && set -C && printf %s ' + quote(JSON.stringify(backup)) + ' > ' + quote(BACKUP));
  return validateBackup(JSON.parse(await ssh('cat ' + quote(BACKUP))));
}
async function setAndCheck(settings) {
  await rpc('setSystemSettings', { category: 'general', settings });
  const actual = await inspect();
  for (const key of Object.keys(settings)) {
    if (!isDeepStrictEqual(actual[key], settings[key])) throw Error('Проверка настройки не прошла: ' + key);
  }
  return actual;
}
async function main(action) {
  if (!['inspect', 'apply', 'restore'].includes(action)) throw Error('Команда: node scripts/manage-tv-home.js inspect | apply | restore');
  const current = await inspect();
  if (action === 'inspect') return current;
  if ((await ssh('id -u')).trim() !== '0') throw Error('Для настройки Home требуется существующий root-доступ.');
  if (action === 'restore') {
    const backup = await readBackup();
    if (!backup) throw Error('Исходная настройка Home не сохранена.');
    return setAndCheck(restoreSettings(current, backup));
  }
  // Never point Home at a missing/unregistered test application.
  const info = JSON.parse(await ssh('luna-send -n 1 -f luna://com.webos.applicationManager/getAppInfo ' + quote(JSON.stringify({ id: APP_ID }))));
  if (info.returnValue !== true || !info.appInfo || info.appInfo.id !== APP_ID || info.appInfo.title !== 'LG Gate') throw Error('Сначала установите LG Gate на телевизор.');
  await saveOriginal(current);
  return setAndCheck(applySettings(current));
}
if (require.main === module) main(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { APP_ID, BACKUP, applySettings, restoreSettings, validateBackup, main, ssh, quote };

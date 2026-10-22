'use strict';

// Explicit configuration of selected native remote buttons. No input grabbing,
// compositor restart, factory-mode command or system-file replacement.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const { ssh, quote } = require('./manage-tv-home');
const { createTransport, validateDevice } = require('./install-prepared-tv');
const KEY = 'com.webos.surfacemanager.keyFilters';
const FACTORY = '/var/preferences/configd_factory_db.json';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const PROFILES = Object.freeze({
  ivi: Object.freeze({ filename: 'ivi-youtube.js', handler: 'handleIviYoutube', backup: 'remote-ivi-original.json', evidence: 'ivi-youtube',
    target: 'youtube.leanback.v4', title: 'YouTube', sourceCode: 1039, originalTarget: 'ivi' }),
  zona: Object.freeze({ filename: 'usp-zona.js', handler: 'handleUspZona', backup: 'remote-usp-original.json', evidence: 'zona-button',
    target: 'org.lggate.launcher', title: 'LG Gate', sourceCode: 1083, originalTarget: 'stock-movies-hotkey' })
});

function createManager(profileName = 'ivi') {
const profile = Object.prototype.hasOwnProperty.call(PROFILES, profileName) && PROFILES[profileName];
if (!profile) throw Error('Неизвестное назначение кнопки: ivi | zona.');
const FILTER = Object.freeze({ file: '/var/lib/lg-gate/' + profile.filename, handler: profile.handler });
const BACKUP = '/var/lib/lg-gate/' + profile.backup;
const SOURCE = path.resolve(__dirname, '..', 'tv', profile.filename);
const EVIDENCE = path.resolve(__dirname, '..', '.build', profile.evidence);

function validateFilters(filters) {
  if (!Array.isArray(filters) || !filters.length || filters.length > 64 || filters.some(item =>
    !object(item) || typeof item.file !== 'string' || !item.file.startsWith('/') ||
    typeof item.handler !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.handler))) throw Error('Некорректная цепочка обработки пульта.');
  const references = filters.filter(item => item.file === FILTER.file || item.handler === FILTER.handler);
  if (references.length > 1 || references.some(item => !equal(item, FILTER))) throw Error('Конфликт существующего правила IVI.');
  return filters;
}

function addFilter(filters) {
  validateFilters(filters);
  if (filters.some(item => equal(item, FILTER))) return clone(filters);
  const index = filters.findIndex(item => item.handler === 'handleCPHotkeys' && item.file === '/usr/lib/qt5/qml/KeyFilters/appLaunch.js');
  if (index < 1) throw Error('Не найден ожидаемый штатный обработчик кнопок приложений.');
  return clone(filters.slice(0, index).concat([FILTER], filters.slice(index)));
}

function removeFilter(filters) {
  validateFilters(filters);
  return clone(filters.filter(item => !equal(item, FILTER)));
}

function validateFactory(factory) {
  if (!object(factory) || typeof factory.present !== 'boolean' ||
    (!factory.present && factory.value !== null)) throw Error('Некорректная резервная копия постоянной настройки.');
  if (factory.present) validateFilters(factory.value);
  return factory;
}

function validateBackup(backup) {
  if (!object(backup) || backup.version !== 1 || backup.key !== KEY || backup.target !== profile.target ||
    backup.sourceCode !== profile.sourceCode || !equal(backup.filter, FILTER) || !/^[a-f0-9]{64}$/.test(backup.sourceHash)) throw Error('Неизвестная резервная копия кнопки.');
  validateFilters(backup.original);
  if (backup.original.some(item => equal(item, FILTER))) throw Error('Резервная копия уже содержит новое правило.');
  validateFactory(backup.factory);
  return backup;
}

async function rpc(method, params) {
  const response = JSON.parse(await ssh('luna-send -n 1 -f ' + quote('luna://com.webos.service.config/' + method) + ' ' + quote(JSON.stringify(params))));
  if (response.returnValue !== true) throw Error(response.errorText || 'Настройка обработки пульта отклонена.');
  return response;
}

async function readFactory() {
  // Read only this configuration key; other factory preferences are not copied.
  const code = 'import json; d=json.load(open(' + JSON.stringify(FACTORY) + ')); c=d.get("com.webos.surfacemanager",{}); print(json.dumps({"present":"keyFilters" in c,"value":c.get("keyFilters")}))';
  return validateFactory(JSON.parse(await ssh('/usr/bin/python -c ' + quote(code))));
}

async function readFilters() {
  const response = await rpc('getConfigs', { configNames: [KEY] });
  return validateFilters(response.configs && response.configs[KEY]);
}

async function readBackup() {
  const raw = await ssh('if test -f ' + quote(BACKUP) + '; then cat ' + quote(BACKUP) + '; fi');
  return raw.trim() ? validateBackup(JSON.parse(raw)) : null;
}

async function sourceHash() {
  const raw = await ssh('if test -e ' + quote(FILTER.file) + '; then test -f ' + quote(FILTER.file) + ' && test ! -L ' + quote(FILTER.file) + ' && sha256sum ' + quote(FILTER.file) + '; fi');
  if (!raw.trim()) return null;
  const match = raw.trim().match(/^([a-f0-9]{64}) [ *](.+)$/);
  if (!match || match[2] !== FILTER.file) throw Error('Не подтверждён файл правила IVI.');
  return match[1];
}

async function writeConfig(value) {
  await rpc('setConfigs', { configs: { [KEY]: value }, volatile: false });
}

async function inspect() {
  const filters = await readFilters();
  const factory = await readFactory();
  const fileHash = await sourceHash();
  return { enabled: filters.some(item => equal(item, FILTER)), persistent: factory.present && factory.value.some(item => equal(item, FILTER)), fileHash, filters, factory };
}

async function apply() {
  const device = validateDevice(await createTransport().preflight());
  const target = JSON.parse(await ssh('luna-send -n 1 -f luna://com.webos.applicationManager/getAppInfo ' + quote(JSON.stringify({ id: profile.target }))));
  if (target.returnValue !== true || !target.appInfo || target.appInfo.id !== profile.target || target.appInfo.title !== profile.title) throw Error('Не найдено ожидаемое приложение ' + profile.title + '.');
  if (profileName === 'zona' && !['0.1.2', '0.1.3', '0.1.4'].includes(target.appInfo.version)) throw Error('Для кнопки Zona сначала установите проверенную LG Gate 0.1.2–0.1.4 с поддержкой команды запуска.');
  const source = fs.readFileSync(SOURCE);
  const expectedHash = hash(source);
  const current = await inspect();
  let backup = await readBackup();
  if (current.fileHash && current.fileHash !== expectedHash) throw Error('Файл правила изменён вне установщика.');
  if ((current.enabled || current.fileHash) && !backup) throw Error('Новое правило найдено без резервной копии.');
  if (backup && backup.sourceHash !== expectedHash) throw Error('Исходник отличается от сохранённой версии правила.');
  if (!backup) {
    backup = validateBackup({ version: 1, key: KEY, target: profile.target, sourceCode: profile.sourceCode, filter: FILTER, sourceHash: expectedHash,
      original: current.filters, factory: current.factory, device: device.system, createdAt: new Date().toISOString() });
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'original.json'), JSON.stringify(backup, null, 2) + '\n');
    await ssh('mkdir -p /var/lib/lg-gate && umask 077 && set -C && printf %s ' + quote(JSON.stringify(backup)) + ' > ' + quote(BACKUP));
    if (!equal(await readBackup(), backup)) throw Error('Резервная копия не подтверждена.');
  }
  if (!current.fileHash) {
    const temporary = FILTER.file + '.next-' + expectedHash.slice(0, 12);
    await ssh('umask 077 && set -C && printf %s ' + quote(source.toString('utf8')) + ' > ' + quote(temporary) + ' && chmod 644 ' + quote(temporary));
    const actual = (await ssh('sha256sum ' + quote(temporary))).trim().split(/\s+/)[0];
    if (actual !== expectedHash) throw Error('Контрольная сумма фильтра не совпала.');
    await ssh('test ! -e ' + quote(FILTER.file) + ' && mv ' + quote(temporary) + ' ' + quote(FILTER.file));
  }
  const filters = await readFilters();
  if (!equal(filters, current.filters)) throw Error('Настройка пульта изменилась во время подготовки. Повторите после проверки.');
  const updated = addFilter(filters);
  try {
    await writeConfig(updated);
    const after = await inspect();
    if (!equal(after.filters, updated) || !after.persistent || !equal(after.factory.value, updated) || after.fileHash !== expectedHash) throw Error('Не подтверждено постоянное правило кнопки.');
    return { enabled: true, persistent: true, target: profile.target, shortcut: profileName === 'zona' ? 'zona' : null, sourceCode: profile.sourceCode, fileHash: expectedHash, filterCount: updated.length, backup: BACKUP };
  } catch (error) {
    // Restore only our entry, preserving any concurrent unrelated filter edits.
    try { await restore(); } catch (rollbackError) { throw Error(error.message + ' Ошибка отката: ' + rollbackError.message); }
    throw error;
  }
}

async function restore() {
  const backup = await readBackup();
  if (!backup) throw Error('Нет резервной копии правила IVI.');
  const current = await inspect();
  const removed = removeFilter(current.filters);
  // If the chain is otherwise untouched, remove an override that did not exist
  // before this change instead of permanently pinning the stock system defaults.
  const value = equal(removed, backup.original) ? (backup.factory.present ? backup.factory.value : null) : removed;
  await writeConfig(value);
  const after = await inspect();
  if (after.enabled || after.persistent || !equal(after.filters, removed)) throw Error('Откат кнопки не подтверждён.');
  return { enabled: false, target: profile.originalTarget, fileRetainedForSafeReapply: true };
}

async function main(action) {
  if (action === 'inspect') return inspect();
  if (action === 'apply') return apply();
  if (action === 'restore') return restore();
  throw Error('Команда: node scripts/manage-tv-remote.js inspect | apply | restore [ivi | zona]');
}
return { main, addFilter, removeFilter, validateFilters, validateBackup, validateFactory, KEY, FILTER };
}
if (require.main === module) Promise.resolve().then(() => createManager(process.argv[3] || 'ivi').main(process.argv[2])).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = Object.assign({ createManager }, createManager());

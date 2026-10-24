'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const manager = require('../scripts/manage-tv-remote');
const { quote } = require('../scripts/manage-tv-home');
const source = fs.readFileSync(path.join(__dirname, '../tv/ivi-youtube.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const original = [
  { file: '/usr/lib/qt5/qml/KeyFilters/systemUi.js', handler: 'handleScreenSaver' },
  { file: '/usr/lib/qt5/qml/KeyFilters/appLaunch.js', handler: 'handleHotkeys' },
  { file: '/usr/lib/qt5/qml/KeyFilters/appLaunch.js', handler: 'handleCPHotkeys' },
  { file: '/usr/lib/qt5/qml/KeyFilters/systemUi.js', handler: 'handleMagicNumber' }
];

function filter() {
  const launches = [];
  const context = {
    WebOS: { Key_webOS_IVI: 123456 }, KeyPolicy: { NextPolicy: 0, Accepted: 1 },
    access: { keyAction: { launchApp: true } }, bootManager: { bootFirstUse: false },
    systemPropertyService: { powerOnlyMode: false }, fullscreenView: { activeFocus: true, appId: 'other.app' },
    nudgeView: { visible: false, close() { this.visible = false; } },
    applicationManager: { checkLaunch(...args) { launches.push(args); } }
  };
  vm.runInNewContext(source, context);
  return { context, launches, press: (key = context.WebOS.Key_webOS_IVI, pressed = true, repeat = false) => context.handleIviYoutube(key, pressed, repeat) };
}

test('IVI вызывает установленный YouTube один раз, а отпускание/повторы поглощаются', () => {
  const f = filter();
  assert.equal(f.press(), 1);
  assert.equal(f.press(undefined, true, true), 1);
  assert.equal(f.press(undefined, false, false), 1);
  assert.deepEqual(f.launches, [['youtube.leanback.v4', '"reason":"hotkey"', true, false]]);
});

test('Другие кнопки не используют зависимости IVI и продолжают штатную обработку', () => {
  const context = { WebOS: { Key_webOS_IVI: 123456 }, KeyPolicy: { NextPolicy: 0, Accepted: 1 } };
  vm.runInNewContext(source, context);
  for (const key of [13, 27, 1039, 10009, 0x01000012, 0x01000070]) {
    assert.equal(context.handleIviYoutube(key, true, false), 0);
    assert.equal(context.handleIviYoutube(key, false, false), 0);
  }
});

test('Блокировка запуска и первый запуск ТВ соблюдаются; YouTube в фокусе не перезапускается', () => {
  for (const modify of [
    c => { c.access.keyAction.launchApp = false; },
    c => { c.bootManager.bootFirstUse = true; },
    c => { c.fullscreenView.appId = 'youtube.leanback.v4'; }
  ]) {
    const f = filter(); modify(f.context);
    assert.equal(f.press(), 1); assert.equal(f.launches.length, 0);
  }
  const f = filter(); f.context.bootManager.bootFirstUse = true; f.context.systemPropertyService.powerOnlyMode = true;
  f.context.nudgeView.visible = true;
  f.press(); assert.equal(f.launches.length, 1); assert.equal(f.context.nudgeView.visible, false);
});

test('Правило вставляется перед CP, сохраняет предшествующие фильтры и повторно не добавляется', () => {
  const before = clone(original);
  const next = manager.addFilter(original);
  assert.deepEqual(original, before);
  assert.deepEqual(next, original.slice(0, 2).concat([manager.FILTER], original.slice(2)));
  assert.deepEqual(manager.addFilter(next), next);
  assert.deepEqual(manager.removeFilter(next), original);
});

test('Отсутствующий штатный CP и конфликт имени/пути/дубликат блокируют применение', () => {
  for (const value of [null, [], [{ file: 'relative', handler: 'bad' }], original.slice(0, 2),
    original.concat([{ ...manager.FILTER, handler: 'otherHandler' }]),
    original.concat([{ ...manager.FILTER, file: '/other.js' }]),
    original.concat([manager.FILTER, manager.FILTER])]) {
    assert.throws(() => manager.addFilter(value));
  }
});

function fakeManager(options = {}) {
  const filename = require.resolve('../scripts/manage-tv-remote');
  const selected = manager.createManager(options.profileName || 'ivi');
  const selectedSource = options.profileName === 'zona' ? fs.readFileSync(path.join(__dirname, '../tv/usp-zona.js'), 'utf8') : source;
  const sourceHash = crypto.createHash('sha256').update(selectedSource).digest('hex');
  const state = { filters: clone(original), factory: { present: false, value: null }, backup: null, fileHash: null, writes: [], calls: [] };
  let rejectOnce = options.rejectOnce;
  const ssh = async command => {
    state.calls.push(command);
    if (command.includes('getAppInfo')) return JSON.stringify({ returnValue: true, appInfo: options.profileName === 'zona' ?
      { id: 'org.lggate.launcher', title: 'LG Gate', version: options.targetVersion || '0.1.2' } : { id: 'youtube.leanback.v4', title: 'YouTube' } });
    if (command.includes('/getConfigs')) return JSON.stringify({ returnValue: true, configs: { [manager.KEY]: state.filters } });
    if (command.includes('/setConfigs')) {
      const params = JSON.parse(command.match(/ '(\{.*\})'$/)[1]);
      state.writes.push(params);
      if (rejectOnce) { rejectOnce = false; return JSON.stringify({ returnValue: false, errorText: 'write rejected' }); }
      const value = params.configs[manager.KEY];
      state.factory = { present: value !== null, value: clone(value) };
      state.filters = value === null ? clone(original) : clone(value);
      return JSON.stringify({ returnValue: true });
    }
    if (command.startsWith('/usr/bin/python')) return JSON.stringify(state.factory);
    if (command.startsWith('if test -f ')) return state.backup ? JSON.stringify(state.backup) : '';
    if (command.startsWith('if test -e ')) return state.fileHash ? state.fileHash + '  ' + selected.FILTER.file + '\n' : '';
    if (command.startsWith('mkdir -p ')) { state.backup = JSON.parse(command.match(/printf %s '(.*)' > '/)[1]); return ''; }
    if (command.startsWith('umask 077 ')) return '';
    if (command.startsWith('sha256sum ')) return sourceHash + '  temporary\n';
    if (command.startsWith('test ! -e ')) { state.fileHash = sourceHash; return ''; }
    throw Error('Unexpected command: ' + command);
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, console,
    require: name => name === './manage-tv-home' ? { ssh, quote } :
      name === './install-prepared-tv' ? { createTransport: () => ({ preflight: async () => ({ system: { modelName: '65SM8200PLA' } }) }), validateDevice: value => value } :
      name === 'node:fs' ? { readFileSync: () => Buffer.from(selectedSource), mkdirSync() {}, writeFileSync() {} } :
      name === 'node:util' ? { isDeepStrictEqual: (a, b) => require('node:util').isDeepStrictEqual(clone(a), clone(b)) } : require(name)
  }, { filename });
  return { state, main: module.exports.createManager(options.profileName || 'ivi').main };
}

test('Применение сначала сохраняет исходное правило, проверяет файл и постоянную DB; повтор идемпотентен', async () => {
  const f = fakeManager();
  const result = await f.main('apply');
  assert.equal(result.persistent, true); assert.equal(result.enabled, true);
  assert.deepEqual(f.state.backup.original, original);
  assert.equal(f.state.writes[0].volatile, false);
  const backupIndex = f.state.calls.findIndex(command => command.startsWith('mkdir -p '));
  const setIndex = f.state.calls.findIndex(command => command.includes('/setConfigs'));
  assert.ok(backupIndex >= 0 && backupIndex < setIndex);
  assert.ok(f.state.calls.slice(backupIndex, setIndex).some(command => command.startsWith('sha256sum ')));
  await f.main('apply');
  assert.equal(f.state.filters.filter(item => item.handler === manager.FILTER.handler).length, 1);
});

test('Откат удаляет созданный override и сохраняет добавленные извне фильтры', async () => {
  const f = fakeManager(); await f.main('apply');
  await f.main('restore');
  assert.deepEqual(f.state.factory, { present: false, value: null });
  assert.deepEqual(f.state.filters, original);
  await f.main('apply');
  const external = { file: '/other-custom.js', handler: 'externalFilter' };
  f.state.filters.push(external);
  await f.main('restore');
  assert.deepEqual(f.state.filters, original.concat([external]));
});

test('Неуспешная запись автоматически откатывается и не сообщается как успех', async () => {
  const f = fakeManager({ rejectOnce: true });
  await assert.rejects(f.main('apply'), /write rejected/);
  assert.deepEqual(f.state.filters, original);
  assert.deepEqual(f.state.factory, { present: false, value: null });
  assert.equal(f.state.writes.length, 2);
});

test('Чужое правило и неизвестная команда не перезаписываются', async () => {
  const f = fakeManager(); f.state.fileHash = '0'.repeat(64);
  await assert.rejects(f.main('apply'), /изменён вне/);
  assert.equal(f.state.writes.length, 0);
  const other = fakeManager();
  await assert.rejects(other.main('launch'), /Команда/);
  assert.equal(other.state.calls.length, 0);
});

test('Правила Zona и IVI сохраняются и удаляются независимо друг от друга', () => {
  const zona = manager.createManager('zona');
  for (const order of [[manager, zona], [zona, manager]]) {
    const both = order[1].addFilter(order[0].addFilter(original));
    assert.deepEqual(order[0].removeFilter(both), order[1].addFilter(original));
    assert.deepEqual(order[1].removeFilter(both), order[0].addFilter(original));
  }
  assert.throws(() => manager.createManager('unknown'), /Неизвестное/);
});

test('Zona требует обновлённый лаунчер до изменения фильтров', async () => {
  for (const targetVersion of ['0.1.1', '0.1.8', '0.1.50']) {
    const f = fakeManager({ profileName: 'zona', targetVersion });
    await assert.rejects(f.main('apply'), /0\.1\.2/);
    assert.equal(f.state.writes.length, 0);
  }
});

test('Применение и откат Zona сохраняют существующее правило IVI → YouTube', async () => {
  for (const targetVersion of ['0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7']) {
    const f = fakeManager({ profileName: 'zona', targetVersion });
    f.state.filters = manager.addFilter(original);
    f.state.factory = { present: true, value: clone(f.state.filters) };
    const before = clone(f.state.filters);
    const result = await f.main('apply');
    assert.equal(result.sourceCode, 1083); assert.equal(result.shortcut, 'zona');
    assert.ok(f.state.filters.some(item => item.handler === manager.FILTER.handler));
    await f.main('restore');
    assert.deepEqual(f.state.filters, before);
    assert.deepEqual(f.state.factory, { present: true, value: before });
  }
});

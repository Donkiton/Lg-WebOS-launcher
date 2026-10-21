'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatform } = require('../platform.js');

const HOME_KEY = 'lg-gate-home-cards-v1-webos';
const MSX_KEY = 'lg-gate-msx-catalog-v1';
const SOURCE_KEY = 'lg-gate-msx-source-v1';
const PNG_BYTES = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=';
const PNG = 'data:image/png;base64,' + PNG_BYTES;
const URI = {
  apps: 'luna://com.webos.applicationManager/listLaunchPoints',
  homebrew: 'luna://org.webosbrew.hbchannel.service/exec'
};

function storage(limit = Infinity) {
  const data = new Map();
  return {
    data,
    limit,
    writes: [],
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) {
      if (value.length > this.limit) throw new Error('QuotaExceededError');
      data.set(key, String(value));
      this.writes.push({ key, value: String(value) });
    },
    removeItem(key) { data.delete(key); }
  };
}

function fakeTV(native, suppliedStorage) {
  const calls = [];
  const state = { native, pendingIcons: false };
  const localStorage = suppliedStorage || storage();
  function Bridge() { this.cancelled = 0; }
  Bridge.prototype.cancel = function () { this.cancelled++; };
  Bridge.prototype.call = function (uri, params) {
    const call = { uri, params: JSON.parse(params), bridge: this };
    calls.push(call);
    if (uri === URI.apps) answer(call, { returnValue: true, launchPoints: state.native });
    else if (uri === URI.homebrew && !state.pendingIcons) answerIcons(call);
  };
  return { state, calls, storage: localStorage, env: { PalmServiceBridge: Bridge, Promise, setTimeout, clearTimeout, localStorage } };
}

function answer(call, payload) { call.bridge.onservicecallback(JSON.stringify(payload)); }
function requestedPaths(call) { return [...call.params.command.matchAll(/'([^']+\.png)'/g)].map(match => match[1]); }
function answerIcons(call, bytes = PNG_BYTES) {
  answer(call, { returnValue: true, stdoutString: requestedPaths(call).map(icon => icon + '\t' + bytes + '\n').join('') });
}
function native(id, fields = {}) { return { id, title: 'Приложение ' + id, icon: '/usr/palm/applications/' + id + '/icon.png', ...fields }; }
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected asynchronous platform update');
}

test('кэш хранит любые шесть выбранных реальных карточек и восстанавливает текущий порядок ID', () => {
  const fake = fakeTV([]);
  const platform = createPlatform(fake.env);
  const apps = Array.from({ length: 8 }, (_, index) => ({ id: 'vendor.' + index, name: 'Приложение ' + index, icon: PNG, unwanted: 'never persist' }));
  assert.equal(platform.saveHomeCache(apps.map(app => app.id), apps), true);
  const persisted = JSON.parse(fake.storage.getItem(HOME_KEY));
  assert.equal(persisted.cards.length, 6);
  assert.equal(persisted.cards[0].app.unwanted, undefined);
  const restarted = createPlatform(fake.env);
  const recovered = restarted.getCachedHome(['vendor.4', 'vendor.1', 'not.saved', 'vendor.0']);
  assert.deepEqual(recovered.map(app => app.id), ['vendor.4', 'vendor.1', 'vendor.0']);
  assert.ok(recovered.every(app => app.icon === PNG));
  recovered[0].name = 'mutated';
  assert.equal(restarted.getCachedHome(['vendor.4'])[0].name, 'Приложение 4');
});

test('кэш сохраняет добавление, замену, удаление и перестановку без старой позиции', () => {
  const fake = fakeTV([]);
  const platform = createPlatform(fake.env);
  const apps = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, icon: PNG }));
  platform.saveHomeCache(['a', 'b', 'c'], apps);
  platform.saveHomeCache(['d', 'b', 'a'], apps);
  assert.deepEqual(createPlatform(fake.env).getCachedHome(['d', 'b', 'a']).map(app => app.id), ['d', 'b', 'a']);
  assert.deepEqual(createPlatform(fake.env).getCachedHome(['c']), []);
  platform.saveHomeCache(['b', 'd'], apps);
  assert.deepEqual(createPlatform(fake.env).getCachedHome(['b', 'd']).map(app => app.id), ['b', 'd']);
  assert.deepEqual(createPlatform(fake.env).getCachedHome(['a']), []);
});

test('повреждённый кэш и непроверенный PNG не проходят в карточки', () => {
  for (const value of ['{bad', 'null', '{}', JSON.stringify({ version: 9, cards: [] }), 'x'.repeat(1048577)]) {
    const fake = fakeTV([]);
    fake.storage.data.set(HOME_KEY, value);
    assert.deepEqual(createPlatform(fake.env).getCachedHome(['vendor']), []);
  }
  const fake = fakeTV([]);
  const platform = createPlatform(fake.env);
  platform.saveHomeCache(['a', 'b', 'c'], [
    { id: 'a', name: 'A', icon: 'data:image/svg+xml,<svg onload=alert(1)>' },
    { id: 'b', name: 'B', icon: 'data:image/png;base64,AAAA' },
    { id: 'c', name: 'C', icon: 'https://unknown.example/icon.png' }
  ]);
  assert.ok(platform.getCachedHome(['a', 'b', 'c']).every(app => app.icon === undefined));
});

test('общий бюджет 1MiB оставляет метаданные всех шести иконок', () => {
  const fake = fakeTV([]);
  const platform = createPlatform(fake.env);
  const bytes = 'iVBORw0KGgoA' + 'A'.repeat(349512);
  const apps = Array.from({ length: 6 }, (_, i) => ({ id: 'app.' + i, name: 'App ' + i, icon: 'data:image/png;base64,' + bytes }));
  platform.saveHomeCache(apps.map(app => app.id), apps);
  assert.ok(fake.storage.getItem(HOME_KEY).length <= 1048576);
  const cards = createPlatform(fake.env).getCachedHome(apps.map(app => app.id));
  assert.equal(cards.length, 6);
  assert.ok(cards.filter(app => app.icon).length < 6);
  assert.ok(cards.filter(app => app.icon).length > 0);
});

test('quota сохраняет метаданные, недоступное хранилище не выбрасывает исключения', () => {
  const fake = fakeTV([], storage(300));
  const platform = createPlatform(fake.env);
  assert.equal(platform.saveHomeCache(['a'], [{ id: 'a', name: 'A', icon: PNG }]), true);
  // Force quota fallback rather than a tiny valid icon fitting in the budget.
  fake.storage.limit = 100;
  assert.equal(platform.saveHomeCache(['a'], [{ id: 'a', name: 'A', icon: PNG }]), true);
  assert.deepEqual(createPlatform(fake.env).getCachedHome(['a']), [{ id: 'a', name: 'A' }]);
  fake.storage.limit = 0;
  assert.equal(platform.saveHomeCache(['b'], [{ id: 'b', name: 'B' }]), false);
  assert.deepEqual(platform.getCachedHome(['b']).map(app => app.id), ['b']);
  assert.deepEqual(createPlatform(fake.env).getCachedHome(['b']), [], 'old persisted choice cannot impose old favorites');
  const denied = { ...fake.env };
  Object.defineProperty(denied, 'localStorage', { get() { throw new Error('SecurityError'); } });
  const unavailable = createPlatform(denied);
  assert.equal(unavailable.saveHomeCache(['a'], [{ id: 'a', name: 'A' }]), false);
});

test('первый native ответ не ждёт PNG; без приоритета каталог не читает все значки', async () => {
  const fake = fakeTV(Array.from({ length: 19 }, (_, i) => native('app.' + i)));
  const platform = createPlatform(fake.env);
  const updates = [];
  const apps = await platform.getApps({ onUpdate: (apps, meta) => updates.push({ apps, meta }) });
  assert.equal(apps.length, 19);
  assert.equal(updates[0].meta.nativeComplete, true);
  assert.equal(updates[0].meta.iconsOnly, false);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fake.calls.length, 1, 'remaining pages stay lazy until visible');
});

test('первая пачка содержит home, следующая учитывает новое закрепление и только видимую страницу', async () => {
  const fake = fakeTV(Array.from({ length: 30 }, (_, i) => native('app.' + i)));
  fake.state.pendingIcons = true;
  const platform = createPlatform(fake.env);
  platform.setAppPriorities(['app.0', 'app.1', 'app.2', 'app.3', 'app.4', 'app.5'], []);
  await platform.getApps();
  await waitFor(() => fake.calls.length === 2);
  assert.deepEqual(requestedPaths(fake.calls[1]), fake.state.native.slice(0, 6).map(app => app.icon));
  platform.setAppPriorities(['app.20', 'app.0', 'app.1', 'app.2', 'app.3', 'app.4'], ['app.8', 'app.9', 'app.10', 'app.11', 'app.12', 'app.13', 'app.14']);
  answerIcons(fake.calls[1]);
  await waitFor(() => fake.calls.length === 3);
  assert.deepEqual(requestedPaths(fake.calls[2]), [20, 8, 9, 10, 11, 12].map(i => fake.state.native[i].icon));
  platform.setAppPriorities(['app.20'], []);
  answerIcons(fake.calls[2]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fake.calls.length, 3, 'stale page priority must not keep loading old rows');
});

test('встроенные SVG/text бренды не читают ненужные PNG, произвольный шестой значок получает приоритет', async () => {
  const ids = ['youtube.leanback.v4', 'okko.app', 'rutube', 'ivi', 'zona', 'any.vendor'];
  const fake = fakeTV(ids.map(id => native(id)));
  const platform = createPlatform(fake.env);
  platform.setAppPriorities(ids, []);
  await platform.getApps();
  await waitFor(() => fake.calls.length === 2);
  assert.deepEqual(requestedPaths(fake.calls[1]), ['/usr/palm/applications/any.vendor/icon.png']);
});

test('после закрепления неизвестного заранее приложения PNG дополняет постоянную карточку', async () => {
  const fake = fakeTV([native('a'), native('b')]);
  fake.state.pendingIcons = true;
  const platform = createPlatform(fake.env);
  let latest;
  await platform.getApps({ onUpdate: apps => { latest = apps; } });
  platform.saveHomeCache(['b'], latest);
  assert.equal(createPlatform(fake.env).getCachedHome(['b'])[0].icon, fake.state.native[1].icon);
  platform.setAppPriorities(['b'], []);
  await waitFor(() => fake.calls.length === 2);
  answerIcons(fake.calls[1]);
  await waitFor(() => latest.some(app => app.id === 'b' && app.icon === PNG));
  platform.saveHomeCache(['b'], latest);
  assert.equal(createPlatform(fake.env).getCachedHome(['b'])[0].icon, PNG);
  assert.deepEqual(createPlatform(fake.env).getCachedHome(['a']), []);
});

test('сохранённая PNG видна при раннем snapshot, тот же путь перепроверяется после обновления приложения', async () => {
  const fake = fakeTV([native('a', { version: '1' })]);
  let latest;
  let platform = createPlatform(fake.env);
  platform.setAppPriorities(['a'], []);
  await platform.getApps({ onUpdate: apps => { latest = apps; } });
  await waitFor(() => latest[0].icon === PNG);
  platform.saveHomeCache(['a'], latest);
  fake.state.pendingIcons = true;
  fake.state.native[0].version = '2';
  platform = createPlatform(fake.env);
  platform.setAppPriorities(['a'], []);
  const updates = [];
  await platform.getApps({ onUpdate: (apps, meta) => updates.push({ apps, meta }) });
  assert.equal(updates[0].apps[0].icon, PNG);
  await waitFor(() => fake.calls.length === 4);
  const replacement = PNG_BYTES.replace('S1kA', 'S2kA');
  answerIcons(fake.calls[3], replacement);
  await waitFor(() => updates.some(update => update.meta.iconsOnly));
  assert.equal(updates.at(-1).apps[0].icon, 'data:image/png;base64,' + replacement);
  assert.equal(updates[0].apps[0].icon, PNG, 'old snapshot remains immutable');
});

test('поздняя PNG прежнего native запроса не записывает данные нового приложения по тому же пути', async () => {
  const shared = '/usr/palm/applications/shared/icon.png';
  const fake = fakeTV([native('a', { icon: shared })]);
  fake.state.pendingIcons = true;
  const platform = createPlatform(fake.env);
  platform.setAppPriorities(['a'], []);
  const oldUpdates = [];
  await platform.getApps({ onUpdate: apps => oldUpdates.push(apps) });
  await waitFor(() => fake.calls.length === 2);
  fake.state.native = [native('b', { icon: shared })];
  platform.setAppPriorities(['b'], []);
  const newUpdates = [];
  await platform.getApps({ onUpdate: apps => newUpdates.push(apps) });
  answerIcons(fake.calls[1]);
  await waitFor(() => fake.calls.length === 4);
  assert.equal(newUpdates.at(-1)[0].icon, shared, 'old request must not fill new model');
  answerIcons(fake.calls[3]);
  await waitFor(() => newUpdates.at(-1)[0].icon === PNG);
  assert.equal(oldUpdates.at(-1)[0].id, 'a');
});

test('browser кэширует снимок с локальными PNG, сообщает оба complete и не вызывает HB', async () => {
  const localStorage = storage();
  const platform = createPlatform({ localStorage });
  const updates = [];
  const apps = await platform.getApps({ onUpdate: (apps, meta) => updates.push({ apps, meta }) });
  platform.setAppPriorities(apps.slice(0, 6).map(app => app.id), apps.map(app => app.id));
  platform.saveHomeCache(apps.slice(0, 6).map(app => app.id), apps);
  const restored = createPlatform({ localStorage }).getCachedHome(apps.slice(0, 6).map(app => app.id));
  assert.equal(restored.length, 6);
  assert.ok(restored.every(app => /^assets\/tv-apps\/.+\.png$/.test(app.icon)));
  assert.deepEqual(updates[0].meta, { nativeComplete: true, msxComplete: true, iconsOnly: false });
});

test('подтверждённый сброс MSX не воскрешает старую home-карточку из отдельного кэша', () => {
  const fake = fakeTV([]);
  const action = 'link:https://msx.zona.ms';
  const id = 'msx:' + encodeURIComponent(action);
  fake.storage.data.set(HOME_KEY, JSON.stringify({ version: 1, cards: [{ app: { id, name: 'Zona', action, source: 'msx' }, msxStart: 'content:https://example.com/list.json' }] }));
  fake.storage.data.set(SOURCE_KEY, JSON.stringify({ version: 1, start: '' }));
  assert.deepEqual(createPlatform(fake.env).getCachedHome([id]), []);
  fake.storage.data.set(SOURCE_KEY, JSON.stringify({ version: 1, start: 'content:https://new.example/list.json' }));
  assert.deepEqual(createPlatform(fake.env).getCachedHome([id]), []);
});

test('home-кэш MSX остаётся доступным для запуска, если полный кэш был вытеснен', async () => {
  const fake = fakeTV([]);
  const start = 'content:https://example.com/list.json';
  const action = 'link:https://msx.zona.ms';
  const id = 'msx:' + encodeURIComponent(action);
  fake.storage.data.set(HOME_KEY, JSON.stringify({ version: 1, cards: [{ app: { id, name: 'Zona', action, source: 'msx' }, msxStart: start }] }));
  fake.storage.data.set(SOURCE_KEY, JSON.stringify({ version: 1, start }));
  assert.equal(fake.storage.getItem(MSX_KEY), null);
  const platform = createPlatform(fake.env);
  assert.deepEqual(platform.getCachedHome([id]).map(app => app.id), [id]);
  assert.deepEqual(await platform.launchApp(id), { simulated: false, embedded: true, url: 'https://msx.zona.ms' });
  fake.storage.data.set(MSX_KEY, '{corrupt');
  assert.equal(createPlatform(fake.env).getCachedHome([id]).length, 1, 'corrupt full cache must not suppress the valid selected fallback');
});

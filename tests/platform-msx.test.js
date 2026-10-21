'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatform } = require('../platform.js');

const URI = {
  apps: 'luna://com.webos.applicationManager/listLaunchPoints',
  homebrew: 'luna://org.webosbrew.hbchannel.service/exec',
  launch: 'luna://com.webos.applicationManager/launch'
};
const NATIVE = [
  { id: 'youtube.leanback.v4', title: 'YouTube' },
  { id: 'de.benzac.msx', title: 'Media Station X' },
  { id: 'vendor.original.app', title: 'Обычное приложение' }
];
const SOURCE = 'https://m.zona.ms/msx/start.json';
const ZONA_ACTION = 'link:https://msx.zona.ms';
const ZONA_ID = 'msx:' + encodeURIComponent(ZONA_ACTION);
const ZONA = {
  name: 'Zona', type: 'list', headline: 'Zona', version: 'v1.1.0',
  parameter: 'content:' + SOURCE, action: '[settings:validate_links:0|home]',
  template: { type: 'separate', layout: '0,0,3,4', color: 'msx-glass' },
  items: [{ title: 'Zona', label: 'v1.1.0', image: 'https://msx.zona.ms/assets/logo_512_512.png', action: ZONA_ACTION }]
};

function settings(start = 'content:' + SOURCE, name = 'Zona') {
  return Object.entries({ start, server: 'm.zona.ms', server_secure: 'true', start_name: name, start_version: '1.1.0' })
    .map(([key, value]) => key + '|' + Buffer.from(value, 'utf16le').toString('hex')).join('\n') + '\n';
}

function persistentStorage() {
  const data = new Map();
  const writes = [];
  return {
    writes,
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) { data.set(String(key), String(value)); writes.push({ operation: 'set', key: String(key), value: String(value) }); },
    removeItem(key) { data.delete(String(key)); writes.push({ operation: 'remove', key: String(key) }); },
    clear() { data.clear(); writes.push({ operation: 'clear' }); }
  };
}

function fakeTV(options = {}) {
  const calls = [];
  const requests = [];
  const state = {
    native: structuredClone(NATIVE), config: settings(), configError: null,
    networkMode: 'success', status: 200, payload: structuredClone(ZONA),
    bootId: '12345678-1234-5678-90ab-1234567890ab', sessionId: '111111111111111111111111',
    markerRaw: null, sessionError: null, now: 1000000
  };
  const storage = options.storage || persistentStorage();

  function Bridge() { this.cancelled = 0; }
  Bridge.prototype.cancel = function () { this.cancelled++; };
  Bridge.prototype.call = function (uri, params) {
    const call = { uri, params: JSON.parse(params), bridge: this };
    calls.push(call);
    let response;
    if (uri === URI.apps) response = { returnValue: true, launchPoints: structuredClone(state.native) };
    else if (uri === URI.homebrew && call.params.command.includes('/tmp/lg-gate-session.json')) {
      response = state.sessionError || { returnValue: true, stdoutString:
        (state.markerRaw ?? JSON.stringify({ version: 1, bootId: state.bootId, sessionId: state.sessionId, sleeping: false })) + '\n' + state.bootId + '\n' };
    }
    else if (uri === URI.homebrew) response = state.configError || { returnValue: true, stdoutString: state.config };
    else if (uri === URI.launch) response = { returnValue: true };
    else throw new Error('Unexpected LS2 URI: ' + uri);
    // A native bridge may answer synchronously; application continuations still run as Promises.
    this.onservicecallback(JSON.stringify(response));
  };

  function XHR() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this.response = null;
    this.aborted = false;
    this.headers = {};
    this.listeners = Object.create(null);
    requests.push(this);
  }
  XHR.prototype.open = function (method, url, asynchronous) {
    this.method = method;
    this.url = url;
    this.asynchronous = asynchronous;
    this.readyState = 1;
  };
  XHR.prototype.setRequestHeader = function (name, value) { this.headers[name] = value; };
  XHR.prototype.addEventListener = function (name, callback) { (this.listeners[name] ||= []).push(callback); };
  XHR.prototype.removeEventListener = function (name, callback) {
    this.listeners[name] = (this.listeners[name] || []).filter(listener => listener !== callback);
  };
  XHR.prototype.dispatch = function (name) {
    const event = { type: name, target: this };
    if (typeof this['on' + name] === 'function') this['on' + name](event);
    for (const callback of [...(this.listeners[name] || [])]) callback(event);
  };
  XHR.prototype.complete = function (payload, status = 200) {
    this.status = status;
    this.responseText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.response = this.responseType === 'json' ? payload : this.responseText;
    this.readyState = 4;
    this.dispatch('readystatechange');
    this.dispatch('load');
  };
  XHR.prototype.fail = function () { this.dispatch('error'); };
  XHR.prototype.send = function (body) {
    this.body = body;
    const mode = state.networkMode;
    const payload = structuredClone(state.payload);
    const status = state.status;
    if (mode === 'pending') return;
    Promise.resolve().then(() => {
      if (this.aborted) return;
      if (mode === 'error') this.fail();
      else if (mode === 'timeout') this.dispatch('timeout');
      else this.complete(payload, status);
    });
  };
  XHR.prototype.abort = function () { this.aborted = true; this.dispatch('abort'); };

  return {
    state, calls, requests, storage,
    env: { PalmServiceBridge: Bridge, XMLHttpRequest: XHR, localStorage: storage, Promise, setTimeout, clearTimeout, Date: { now: () => state.now } }
  };
}

function virtual(apps) { return apps.filter(app => app.source === 'msx'); }
function native(apps) { return apps.filter(app => app.source !== 'msx'); }
function wake(fake) { fake.state.sessionId = (BigInt('0x' + fake.state.sessionId) + 1n).toString(16).padStart(24, '0'); }
async function waitFor(predicate) {
  for (let i = 0; i < 50 && !predicate(); i++) await Promise.resolve();
  assert.ok(predicate(), 'Expected asynchronous request was not started');
}

test('TV добавляет реальную Zona из установленного MSX, сохраняя native приложения', async () => {
  const fake = fakeTV();
  const apps = await createPlatform(fake.env).getApps();
  assert.deepEqual(native(apps), [
    { id: 'youtube.leanback.v4', name: 'YouTube', brand: 'youtube' },
    { id: 'de.benzac.msx', name: 'Media Station X', brand: 'msx' },
    { id: 'vendor.original.app', name: 'Обычное приложение' }
  ]);
  assert.deepEqual(virtual(apps), [{
    id: ZONA_ID, name: 'Zona', source: 'msx', brand: 'zona', action: ZONA_ACTION,
    launchUrl: 'https://msx.zona.ms', launchMode: 'embedded', icon: 'https://msx.zona.ms/assets/logo_512_512.png'
  }]);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].method.toUpperCase(), 'GET');
  assert.equal(fake.requests[0].url, SOURCE);
  assert.notEqual(fake.requests[0].asynchronous, false);
});

test('MSX импорт не ограничен Zona, дедуплицирует карточки и не импортирует медиакнопки', async () => {
  const fake = fakeTV();
  fake.state.payload = { items: [
    { title: 'Другой сервис', action: 'link:https://another.example/app' },
    { title: 'Зона', action: ZONA_ACTION },
    { title: 'Видео', action: 'video:https://example.com/movie.mp4' },
    { title: 'Команда', action: 'execute:https://example.com/command' }
  ], pages: [{ items: [{ title: 'Дубликат', action: ZONA_ACTION }] }] };
  const imported = virtual(await createPlatform(fake.env).getApps());
  assert.equal(imported.length, 2);
  assert.equal(imported[0].name, 'Другой сервис');
  assert.equal(imported[0].launchUrl, 'https://another.example/app');
  assert.equal(imported[1].id, ZONA_ID);
  assert.equal(imported[1].brand, 'zona');
});

test('Virtual launch возвращает embedded URL без отправки синтетического ID в LS2', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  const count = fake.calls.length;
  assert.deepEqual(await platform.launchApp(ZONA_ID), { simulated: false, embedded: true, url: 'https://msx.zona.ms' });
  assert.equal(fake.calls.length, count);
  assert.ok(fake.calls.every(call => call.params.id !== ZONA_ID));
});

test('link:window открывает системный браузер с реальным target', async () => {
  const fake = fakeTV();
  const action = 'link:window:https://another.example/app?a=1&b=2';
  fake.state.payload = { items: [{ title: 'Внешний сервис', action }] };
  const platform = createPlatform(fake.env);
  const app = virtual(await platform.getApps())[0];
  const result = await platform.launchApp(app.id);
  assert.equal(result.simulated, false);
  assert.deepEqual(fake.calls.filter(call => call.uri === URI.launch).map(call => call.params), [
    { id: 'com.webos.app.browser', params: { target: 'https://another.example/app?a=1&b=2' } }
  ]);
});

test('Произвольный msx ID нельзя превратить в исполняемую ссылку', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  const count = fake.calls.length;
  for (const id of ['msx:' + encodeURIComponent('link:https://unknown.example'), 'msx:javascript%3Aalert(1)', 'msx:%broken']) {
    await assert.rejects(platform.launchApp(id), { code: 'INVALID_ID' });
  }
  assert.equal(fake.calls.length, count);
});

test('Когда MSX отсутствует, нет чтения его SQLite, сетевых запросов или вымышленных карточек', async () => {
  const fake = fakeTV();
  fake.state.native = NATIVE.filter(app => app.id !== 'de.benzac.msx');
  const apps = await createPlatform(fake.env).getApps();
  assert.equal(virtual(apps).length, 0);
  assert.equal(fake.calls.filter(call => call.uri === URI.homebrew).length, 0);
  assert.equal(fake.requests.length, 0);
});

test('Сбой чтения MSX настроек не скрывает установленные native приложения', async () => {
  for (const configError of [{ returnValue: false, errorText: 'Unavailable' }, { returnValue: true, stdoutString: 'start|nothex' }]) {
    const fake = fakeTV();
    fake.state.configError = configError;
    const apps = await createPlatform(fake.env).getApps();
    assert.deepEqual(native(apps).map(app => app.id), NATIVE.map(app => app.id));
    assert.equal(virtual(apps).length, 0);
    assert.equal(fake.requests.length, 0);
  }
});

test('Сеть, HTTP ошибка и malformed JSON MSX не ломают native каталог', async () => {
  for (const failure of [
    { networkMode: 'error' }, { networkMode: 'timeout' }, { status: 503 }, { payload: '{invalid JSON' }
  ]) {
    const fake = fakeTV();
    Object.assign(fake.state, failure);
    const apps = await createPlatform(fake.env).getApps();
    assert.deepEqual(native(apps).map(app => app.id), NATIVE.map(app => app.id));
    assert.equal(virtual(apps).length, 0);
  }
});

test('Последний удачный MSX каталог переживает повторное создание platform при сетевом сбое', async () => {
  const fake = fakeTV();
  const first = await createPlatform(fake.env).getApps();
  assert.equal(virtual(first).length, 1);
  assert.ok(fake.storage.writes.some(write => write.operation === 'set'), 'Successful import must be persisted');
  fake.state.networkMode = 'error';
  wake(fake);
  const restarted = createPlatform(fake.env);
  const recovered = await restarted.getApps();
  assert.deepEqual(virtual(recovered).map(app => app.id), [ZONA_ID]);
  assert.deepEqual(await restarted.launchApp(ZONA_ID), { simulated: false, embedded: true, url: 'https://msx.zona.ms' });
});

test('Временный отказ чтения конфигурации сохраняет предыдущую подтверждённую карточку', async () => {
  const fake = fakeTV();
  await createPlatform(fake.env).getApps();
  fake.state.configError = { returnValue: false, errorText: 'Temporary service error' };
  assert.deepEqual(virtual(await createPlatform(fake.env).getApps()).map(app => app.id), [ZONA_ID]);
});

test('При quota большого MSX кэша выбранная home-карточка сохраняет ранний запуск', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  const apps = await platform.getApps();
  platform.saveHomeCache([ZONA_ID], apps);
  const setItem = fake.storage.setItem;
  fake.storage.setItem = function (key, value) {
    if (key === 'lg-gate-msx-catalog-v1') throw new Error('QuotaExceededError');
    setItem.call(this, key, value);
  };
  wake(fake);
  await platform.getApps();
  assert.equal(fake.storage.getItem('lg-gate-msx-catalog-v1'), null);
  const restarted = createPlatform(fake.env);
  assert.deepEqual(restarted.getCachedHome([ZONA_ID]).map(app => app.id), [ZONA_ID]);
  assert.deepEqual(await restarted.launchApp(ZONA_ID), { simulated: false, embedded: true, url: 'https://msx.zona.ms' });
  fake.state.config = settings('content:https://new.example/start.json');
  fake.state.networkMode = 'error';
  await platform.getApps();
  assert.deepEqual(createPlatform(fake.env).getCachedHome([ZONA_ID]), []);
});

test('Native метаданные и сохранённый MSX доступны до ответа сети, временная ошибка не подтверждает удаление', async () => {
  const fake = fakeTV();
  await createPlatform(fake.env).getApps();
  wake(fake);
  fake.state.networkMode = 'pending';
  const platform = createPlatform(fake.env);
  const updates = [];
  const request = platform.getApps({ onUpdate: (apps, meta) => updates.push({ apps, meta }) });
  await waitFor(() => fake.requests.length === 2);
  assert.deepEqual(native(updates[0].apps).map(app => app.id), NATIVE.map(app => app.id));
  assert.deepEqual(virtual(updates[0].apps).map(app => app.id), [ZONA_ID]);
  assert.deepEqual(updates[0].meta, { nativeComplete: true, msxComplete: false, iconsOnly: false });
  assert.deepEqual(await platform.launchApp(ZONA_ID), { simulated: false, embedded: true, url: 'https://msx.zona.ms' });
  fake.requests[1].dispatch('error');
  assert.deepEqual(virtual(await request).map(app => app.id), [ZONA_ID]);
  assert.equal(updates.at(-1).meta.msxComplete, false);
});

test('Подтверждённая смена MSX источника публикует удаление до ответа нового сервера', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  fake.state.config = settings('content:https://new.example/start.json');
  fake.state.networkMode = 'pending';
  const updates = [];
  const request = platform.getApps({ onUpdate: (apps, meta) => updates.push({ apps, meta }) });
  await waitFor(() => fake.requests.length === 2);
  assert.deepEqual(virtual(updates[0].apps).map(app => app.id), [ZONA_ID]);
  assert.equal(updates[0].meta.msxComplete, false);
  assert.equal(virtual(updates.at(-1).apps).length, 0);
  assert.equal(updates.at(-1).meta.msxComplete, true);
  await assert.rejects(platform.launchApp(ZONA_ID), { code: 'INVALID_ID' });
  fake.requests[1].dispatch('error');
  assert.equal(virtual(await request).length, 0);
  assert.equal(platform.catalogStatus.msxComplete, true);
  assert.equal(virtual(updates[0].apps).length, 1, 'the old callback snapshot remains immutable');
});

test('Успешное удаление MSX публикует authoritative complete отдельно от раннего native snapshot', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  fake.state.native = NATIVE.filter(app => app.id !== 'de.benzac.msx');
  const updates = [];
  await platform.getApps({ onUpdate: (apps, meta) => updates.push({ apps, meta }) });
  assert.equal(updates[0].meta.msxComplete, false);
  assert.equal(virtual(updates[0].apps).length, 1);
  assert.equal(updates.at(-1).meta.msxComplete, true);
  assert.equal(virtual(updates.at(-1).apps).length, 0);
});

test('Подтверждённая смена источника MSX не использует кэш предыдущего портала при ошибке нового', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  fake.state.config = settings('content:https://new.example/start.json', 'Новый портал');
  fake.state.networkMode = 'error';
  assert.equal(virtual(await platform.getApps()).length, 0);
  assert.equal(virtual(await createPlatform(fake.env).getApps()).length, 0);
  await assert.rejects(platform.launchApp(ZONA_ID), { code: 'INVALID_ID' });
});

test('Удаление MSX очищает виртуальный каталог и не возвращает старые записи после reinstall offline', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  fake.state.native = NATIVE.filter(app => app.id !== 'de.benzac.msx');
  assert.equal(virtual(await platform.getApps()).length, 0);
  await assert.rejects(platform.launchApp(ZONA_ID), { code: 'INVALID_ID' });
  fake.state.native = structuredClone(NATIVE);
  fake.state.networkMode = 'error';
  assert.equal(virtual(await createPlatform(fake.env).getApps()).length, 0);
});

test('Успешный пустой список удаляет карточки, а не удерживает их бесконечно из кэша', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  fake.state.payload = { type: 'list', items: [] };
  wake(fake);
  assert.equal(virtual(await platform.getApps()).length, 0);
  await assert.rejects(platform.launchApp(ZONA_ID), { code: 'INVALID_ID' });
  fake.state.networkMode = 'error';
  assert.equal(virtual(await createPlatform(fake.env).getApps()).length, 0);
});

test('Сброс start или неподдержанный interaction config не подменяются прежним каталогом', async () => {
  for (const config of ['', settings('content:request:interaction:init@https://example.com/interaction')]) {
    const fake = fakeTV();
    const platform = createPlatform(fake.env);
    await platform.getApps();
    fake.state.config = config;
    const count = fake.requests.length;
    assert.equal(virtual(await platform.getApps()).length, 0);
    assert.equal(fake.requests.length, count);
    await assert.rejects(platform.launchApp(ZONA_ID), { code: 'INVALID_ID' });
  }
});

test('SQLite читается фиксированной командой в read-only режиме без подстановки настроек или remote действий', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  fake.state.config = settings('content:https://new.example/start.json?x=$(MSX_INJECTION_SENTINEL)', '$(MSX_NAME_SENTINEL)');
  fake.state.payload = { items: [{ title: 'Команда', action: 'execute:https://evil.example/MSX_EXEC_SENTINEL' }] };
  await platform.getApps();
  const commands = fake.calls.filter(call => call.uri === URI.homebrew && call.params.command.includes('sqlite3')).map(call => call.params.command);
  assert.equal(commands.length, 2);
  assert.equal(commands[0], commands[1], 'Config values must never be interpolated into the root command');
  assert.match(commands[0], /sqlite3/);
  assert.match(commands[0], /mode=ro/);
  assert.match(commands[0], /\bSELECT\b/i);
  for (const key of ['start', 'server', 'server_secure', 'start_name', 'start_version']) assert.ok(commands[0].includes(key));
  assert.doesNotMatch(commands[0], /MSX_.*SENTINEL|\b(?:INSERT|UPDATE|DELETE|REPLACE|ATTACH|DROP|VACUUM)\b|\b(?:token|deviceid|device_id)\b/i);
});

test('Отмена MSX XHR прерывает запрос и не сохраняет поздно полученный каталог', async () => {
  const fake = fakeTV();
  fake.state.networkMode = 'pending';
  const platform = createPlatform(fake.env);
  const request = platform.getApps();
  await waitFor(() => fake.requests.length === 1);
  const assertions = assert.rejects(request, { code: 'CANCELLED' });
  const xhr = fake.requests[0];
  const lateLoad = xhr.onload;
  const lateReadyStateChange = xhr.onreadystatechange;
  const writes = fake.storage.writes.length;
  platform.cancelPending();
  await assertions;
  assert.equal(xhr.aborted, true);
  xhr.complete(ZONA);
  if (lateReadyStateChange) lateReadyStateChange.call(xhr, { type: 'readystatechange', target: xhr });
  if (lateLoad) lateLoad.call(xhr, { type: 'load', target: xhr });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fake.storage.writes.length, writes, 'A cancelled request must not commit its late response');
  fake.state.networkMode = 'error';
  assert.equal(virtual(await createPlatform(fake.env).getApps()).length, 0);
});

test('Отмена обновления не затирает ранее сохранённый успешный MSX каталог', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  wake(fake);
  fake.state.networkMode = 'pending';
  const request = platform.getApps();
  await waitFor(() => fake.requests.length === 2);
  const assertions = assert.rejects(request, { code: 'CANCELLED' });
  const writes = fake.storage.writes.length;
  platform.cancelPending();
  await assertions;
  fake.requests[1].complete({ items: [{ title: 'Позднее приложение', action: 'link:https://late.example' }] });
  await Promise.resolve();
  assert.equal(fake.storage.writes.length, writes);
  fake.state.networkMode = 'error';
  assert.deepEqual(virtual(await createPlatform(fake.env).getApps()).map(app => app.id), [ZONA_ID]);
});

test('Один TV сеанс читает MSX HTTP один раз, включая новый renderer; native приложения остаются живыми', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  fake.state.networkMode = 'pending';
  fake.state.native.push({ id: 'newly.installed', title: 'Новое установленное приложение' });
  for (let i = 0; i < 3; i++) {
    const apps = await platform.getApps();
    assert.ok(apps.some(app => app.id === 'newly.installed'));
    assert.deepEqual(virtual(apps).map(app => app.id), [ZONA_ID]);
    assert.equal(platform.catalogStatus.msxComplete, true);
    assert.equal(platform.msxStatus.sessionCached, true);
  }
  const restarted = createPlatform(fake.env);
  assert.equal(restarted.getCachedHome([ZONA_ID]).length, 0, 'No home selection was saved in this test');
  assert.deepEqual(virtual(await restarted.getApps()).map(app => app.id), [ZONA_ID]);
  assert.equal(fake.requests.length, 1);
  const cached = JSON.parse(fake.storage.getItem('lg-gate-msx-catalog-v1'));
  assert.equal(cached.session, 'wake:' + fake.state.bootId + ':' + fake.state.sessionId);
});

test('Настоящее пробуждение и новая загрузка ядра повторяют импорт один раз на новый TV сеанс', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  wake(fake);
  await platform.getApps();
  await createPlatform(fake.env).getApps();
  assert.equal(fake.requests.length, 2);
  fake.state.bootId = 'abcdef01-2345-6789-abcd-0123456789ab';
  await createPlatform(fake.env).getApps();
  await createPlatform(fake.env).getApps();
  assert.equal(fake.requests.length, 3);
});

test('Подтверждённый пустой MSX каталог тоже свежий на весь TV сеанс после рестарта страницы', async () => {
  const fake = fakeTV();
  fake.state.payload = { items: [] };
  const platform = createPlatform(fake.env);
  assert.deepEqual(virtual(await platform.getApps()), []);
  fake.state.networkMode = 'error';
  assert.deepEqual(virtual(await platform.getApps()), []);
  const restarted = createPlatform(fake.env);
  assert.deepEqual(virtual(await restarted.getApps()), []);
  assert.equal(restarted.catalogStatus.msxComplete, true);
  assert.equal(fake.requests.length, 1);
});

test('Временная ошибка сохраняет MSX и cooldown между renderer; через 30 секунд возможен успешный повтор', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  wake(fake);
  fake.state.networkMode = 'error';
  assert.deepEqual(virtual(await platform.getApps()).map(app => app.id), [ZONA_ID]);
  assert.equal(fake.requests.length, 2);
  assert.equal(platform.catalogStatus.msxComplete, false);
  assert.deepEqual(virtual(await platform.getApps()).map(app => app.id), [ZONA_ID]);
  const restarted = createPlatform(fake.env);
  await restarted.getApps();
  assert.equal(restarted.msxStatus.retryPending, true);
  assert.equal(fake.requests.length, 2);
  fake.state.now += 30001;
  fake.state.networkMode = 'success';
  await restarted.getApps();
  assert.equal(fake.requests.length, 3);
  assert.equal(restarted.catalogStatus.msxComplete, true);
  await createPlatform(fake.env).getApps();
  assert.equal(fake.requests.length, 3);
});

test('Ошибка первого импорта не делает пустой каталог свежим до следующего включения TV', async () => {
  const fake = fakeTV();
  fake.state.networkMode = 'error';
  await createPlatform(fake.env).getApps();
  const cached = JSON.parse(fake.storage.getItem('lg-gate-msx-catalog-v1'));
  assert.equal(cached.session, '');
  fake.state.networkMode = 'success';
  const restarted = createPlatform(fake.env);
  assert.deepEqual(virtual(await restarted.getApps()), []);
  assert.equal(fake.requests.length, 1);
  fake.state.now += 30001;
  assert.deepEqual(virtual(await restarted.getApps()).map(app => app.id), [ZONA_ID]);
  assert.equal(fake.requests.length, 2);
});

test('Ответ сервера без MSX списка не стирает последний каталог и не получает session freshness', async () => {
  const fake = fakeTV();
  const platform = createPlatform(fake.env);
  await platform.getApps();
  const saved = fake.storage.getItem('lg-gate-msx-catalog-v1');
  wake(fake);
  fake.state.payload = { error: 'Temporary portal error' };
  assert.deepEqual(virtual(await platform.getApps()).map(app => app.id), [ZONA_ID]);
  assert.equal(fake.storage.getItem('lg-gate-msx-catalog-v1'), saved);
  assert.equal(platform.catalogStatus.msxComplete, false);
});

test('Перекрывающиеся native обновления делят один MSX HTTP, только последний запрос сохраняет snapshot', async () => {
  const fake = fakeTV();
  fake.state.networkMode = 'pending';
  const platform = createPlatform(fake.env);
  const first = platform.getApps();
  const cancelled = assert.rejects(first, { code: 'CANCELLED' });
  await waitFor(() => fake.requests.length === 1);
  fake.state.native.push({ id: 'newly.installed', title: 'Новое приложение' });
  const latest = platform.getApps();
  await waitFor(() => fake.calls.filter(call => call.params.command?.includes('/tmp/lg-gate-session.json')).length === 2);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(fake.requests.length, 1);
  fake.requests[0].complete(ZONA);
  const apps = await latest;
  await cancelled;
  assert.ok(apps.some(app => app.id === 'newly.installed'));
  assert.deepEqual(virtual(apps).map(app => app.id), [ZONA_ID]);
  assert.equal(fake.storage.writes.filter(write => write.key === 'lg-gate-msx-catalog-v1' && JSON.parse(write.value).session).length, 1);
});

test('Поздний HTTP прежнего источника не перезаписывает новый источник при гонке getApps', async () => {
  const fake = fakeTV();
  fake.state.networkMode = 'pending';
  const platform = createPlatform(fake.env);
  const first = platform.getApps();
  const cancelled = assert.rejects(first, { code: 'CANCELLED' });
  await waitFor(() => fake.requests.length === 1);
  fake.state.config = settings('content:https://new.example/start.json');
  const latest = platform.getApps();
  await waitFor(() => fake.requests.length === 2);
  const fresh = { items: [{ title: 'Новый сервис', action: 'link:https://new.example/app' }] };
  fake.requests[1].complete(fresh);
  assert.deepEqual(virtual(await latest).map(app => app.name), ['Новый сервис']);
  fake.requests[0].complete(ZONA);
  await cancelled;
  assert.deepEqual(virtual(await createPlatform(fake.env).getApps()).map(app => app.name), ['Новый сервис']);
  assert.equal(fake.requests.length, 2);
});

test('Без daemon marker доступен boot fallback; повреждённый marker не подставляется в root команду', async () => {
  const fake = fakeTV();
  fake.state.markerRaw = '{"sessionId":"$(MSX_SESSION_INJECTION_SENTINEL)"}';
  await createPlatform(fake.env).getApps();
  await createPlatform(fake.env).getApps();
  assert.equal(fake.requests.length, 1);
  assert.equal(JSON.parse(fake.storage.getItem('lg-gate-msx-catalog-v1')).session, 'boot:' + fake.state.bootId);
  const commands = fake.calls.filter(call => call.params.command?.includes('/tmp/lg-gate-session.json')).map(call => call.params.command);
  assert.equal(commands[0], commands[1]);
  assert.doesNotMatch(commands[0], /MSX_SESSION_INJECTION_SENTINEL/);
  assert.match(commands[0], /head -c 513/);
  assert.match(commands[0], /head -c 80/);
  fake.state.bootId = 'abcdef01-2345-6789-abcd-0123456789ab';
  await createPlatform(fake.env).getApps();
  assert.equal(fake.requests.length, 2);
});

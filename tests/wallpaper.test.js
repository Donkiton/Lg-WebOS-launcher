'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const wallpaper = require('../wallpaper');
const { BACKGROUNDS, createController, periodForDate } = wallpaper;
const KEY = 'lg-home-wallpaper-v1-webos';
const WAKE = 'wake:12345678-1234-5678-90ab-1234567890ab:111111111111111111111111';
const hint = (period, session = WAKE) => ({ version: 1, session, period });
const date = (hour, minute = 0) => new Date(2026, 9, 22, hour, minute);
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const items = options.items || new Map();
  const loaded = [], applied = [], written = [];
  let session = 'boot:1', clock = date(7);
  const controller = createController({
    mode: 'webos',
    storage: {
      getItem(key) { if (options.readFails) throw Error('denied'); return items.get(key) ?? null; },
      setItem(key, value) { written.push([key, value]); if (options.writeFails) throw Error('quota'); items.set(key, value); }
    },
    now: () => clock,
    readSession: () => Promise.resolve(session),
    loadImage: path => { loaded.push(path); return Promise.resolve(); },
    apply: path => applied.push(path),
    ...options.overrides
  });
  return {
    controller, items, loaded, applied, written,
    session(value) { session = value; }, clock(value) { clock = value; },
    saved() { return JSON.parse(items.get(KEY)); }
  };
}

test('Границы периодов используют местные часы и минуты', () => {
  for (const [hour, minute, expected] of [
    [0, 0, 'night'], [5, 59, 'night'], [6, 0, 'morning'], [10, 59, 'morning'],
    [11, 0, 'day'], [17, 59, 'day'], [18, 0, 'evening'], [22, 59, 'evening'], [23, 0, 'night']
  ]) assert.equal(periodForDate(date(hour, minute)), expected, `${hour}:${minute}`);
  assert.equal(periodForDate(new Date(NaN)), 'evening');
  assert.equal(periodForDate(new Date(1970, 0, 1, 12)), 'evening');
});

test('ES5 UMD экспортирует тот же API в браузере без исполнения storage', () => {
  const context = { window: {} };
  const source = fs.readFileSync(require.resolve('../wallpaper'), 'utf8');
  assert.doesNotMatch(source, /\b(?:const|let|class)\s|=>|\?\./);
  vm.runInNewContext(source, context);
  assert.equal(typeof context.window.LauncherWallpaper.createController, 'function');
  assert.deepEqual(Object.keys(context.window.LauncherWallpaper.BACKGROUNDS), ['morning', 'day', 'evening', 'night']);
});

test('Запуск выбирает один фон, возвращения Home и полночь сохраняют выбор', async () => {
  const h = fixture();
  await h.controller.refresh();
  assert.equal(h.saved().period, 'morning');
  assert.deepEqual(h.loaded, [BACKGROUNDS.morning], 'Normal startup loads only the selected image');
  const counts = [h.loaded.length, h.applied.length, h.written.length];
  h.clock(date(12));
  await h.controller.refresh();
  h.clock(new Date(2026, 9, 23, 0, 1));
  await h.controller.refresh();
  assert.equal(h.saved().period, 'morning');
  assert.deepEqual([h.loaded.length, h.applied.length, h.written.length], counts);
  assert.ok(h.loaded.every(path => path === BACKGROUNDS.evening || path === BACKGROUNDS.morning));
});

test('Новый wake и новый boot определяют фон по текущим часам', async () => {
  const h = fixture();
  await h.controller.refresh();
  h.clock(date(14)); h.session('wake:2');
  await h.controller.refresh();
  assert.equal(h.saved().period, 'day');
  h.clock(date(23)); h.session('boot:3');
  await h.controller.refresh();
  assert.equal(h.saved().period, 'night');
  assert.equal(h.applied.at(-1), BACKGROUNDS.night);
});

test('Перезапуск renderer восстанавливает выбранный фон той же session после смены часа', async () => {
  const first = fixture();
  await first.controller.refresh();
  const second = fixture({ items: first.items });
  second.clock(date(23));
  await second.controller.refresh();
  assert.deepEqual(second.loaded, [BACKGROUNDS.morning]);
  assert.deepEqual(second.applied, [BACKGROUNDS.morning]);
  assert.equal(second.written.length, 0);
});

test('Первый запуск с сохранённым вечерним фоном не рисует и не загружает его до проверки нового включения', async () => {
  for (const [hour, period] of [[8, 'morning'], [14, 'day'], [1, 'night']]) {
    const session = deferred(), image = deferred();
    const items = new Map([[KEY, JSON.stringify({ version: 1, session: 'yesterday', period: 'evening' })]]);
    const h = fixture({ items, overrides: {
      readSession: () => session.promise,
      loadImage: path => { h.loaded.push(path); return image.promise; }
    } });
    h.clock(date(hour));
    const request = h.controller.refresh();
    await turn();
    assert.deepEqual(h.loaded, []);
    assert.deepEqual(h.applied, []);
    session.resolve('wake:today');
    await turn();
    assert.deepEqual(h.loaded, [BACKGROUNDS[period]]);
    assert.deepEqual(h.applied, [], 'The selected image must finish loading before it is displayed');
    image.resolve();
    await request;
    assert.deepEqual(h.applied, [BACKGROUNDS[period]]);
  }
});

test('Сохранённый фон того же включения становится первой картинкой только после подтверждения session', async () => {
  const session = deferred();
  const h = fixture({
    items: new Map([[KEY, JSON.stringify({ version: 1, session: 'wake:same', period: 'morning' })]]),
    overrides: { readSession: () => session.promise }
  });
  h.clock(date(23));
  const request = h.controller.refresh();
  await turn();
  assert.deepEqual(h.loaded, []); assert.deepEqual(h.applied, []);
  session.resolve('wake:same');
  await request;
  assert.deepEqual(h.applied, [BACKGROUNDS.morning]);
  assert.deepEqual(h.loaded, [BACKGROUNDS.morning]);
});

test('Повреждённый storage и неразрешённый путь не передаются loader или apply', async () => {
  for (const value of ['bad json', JSON.stringify({ version: 1, session: 'boot:1', period: '__proto__' }),
    JSON.stringify({ version: 1, session: 'boot:1', period: 'https://example.com/wallpaper' }),
    JSON.stringify({ version: 1, session: '', period: 'day' })]) {
    const h = fixture({ items: new Map([[KEY, value]]) });
    await h.controller.refresh();
    assert.equal(h.saved().period, 'morning');
    assert.ok(h.loaded.every(path => Object.values(BACKGROUNDS).includes(path)));
  }
});

test('Storage quota и запрет чтения не мешают выбору и сохранению session в памяти', async () => {
  const h = fixture({ readFails: true, writeFails: true });
  await h.controller.refresh();
  const loaded = h.loaded.length, applied = h.applied.length;
  h.clock(date(23));
  const result = await h.controller.refresh();
  assert.equal(result.period, 'morning');
  assert.equal(h.loaded.length, loaded);
  assert.equal(h.applied.length, applied);
});

test('Пустая, ошибочная и отклонённая session оставляет первый экран нейтральным и допускает retry', async () => {
  for (const fail of [null, '', ' ', 1, 'boot:\nwrong', new Error('LS2 unavailable')]) {
    let next = fail;
    const items = new Map([[KEY, JSON.stringify({ version: 1, session: 'boot:old', period: 'day' })]]);
    const h = fixture({ items, overrides: { readSession: () => next instanceof Error ? Promise.reject(next) : Promise.resolve(next) } });
    const result = await h.controller.refresh();
    assert.equal(result.path, null);
    assert.equal(result.period, null);
    assert.deepEqual(h.applied, []);
    assert.deepEqual(h.loaded, []);
    assert.equal(h.saved().session, 'boot:old');
    next = 'wake:new';
    await h.controller.refresh();
    assert.equal(h.saved().session, 'wake:new');
    assert.equal(h.saved().period, 'morning');
    assert.deepEqual(h.applied, [BACKGROUNDS.morning]);
  }
});

test('Зависший session завершается deadline, поздний ответ игнорируется, следующий refresh работает', async () => {
  const pending = deferred();
  let deadline, next = pending.promise, cancelled = 0;
  const h = fixture({ overrides: {
    readSession: () => next,
    setTimeout: fn => { deadline = fn; return 1; },
    clearTimeout: () => { cancelled++; }
  } });
  const refresh = h.controller.refresh();
  await turn();
  assert.equal(h.applied.length, 0, 'Session read must not force extra image loads before the deadline');
  deadline();
  assert.equal((await refresh).status, 'session-unavailable');
  pending.resolve('late:old');
  await turn();
  assert.equal(h.items.has(KEY), false);
  next = Promise.resolve('wake:next');
  await h.controller.refresh();
  assert.equal(h.saved().session, 'wake:next');
  assert.ok(cancelled >= 2);
});

test('Таймаут на холодном старте не показывает вчерашний вечерний фон перед успешным retry', async () => {
  const pending = deferred();
  let deadline, next = pending.promise;
  const h = fixture({
    items: new Map([[KEY, JSON.stringify({ version: 1, session: 'yesterday', period: 'evening' })]]),
    overrides: {
      readSession: () => next,
      setTimeout: fn => { deadline = fn; return 1; }, clearTimeout() {}
    }
  });
  const first = h.controller.refresh();
  await turn(); deadline();
  assert.equal((await first).path, null);
  assert.deepEqual(h.loaded, []); assert.deepEqual(h.applied, []);
  next = Promise.resolve('today');
  await h.controller.refresh();
  pending.resolve('yesterday');
  await turn();
  assert.deepEqual(h.loaded, [BACKGROUNDS.morning]);
  assert.deepEqual(h.applied, [BACKGROUNDS.morning]);
});

test('Неверные часы не фиксируют session; исправление позволяет выбрать фон в той же session', async () => {
  for (const invalid of [new Date(NaN), new Date(1970, 0, 1, 12)]) {
    const h = fixture();
    h.clock(invalid);
    assert.equal((await h.controller.refresh()).status, 'clock-unavailable');
    assert.deepEqual(h.applied, []);
    assert.deepEqual(h.loaded, []);
    assert.equal(h.items.has(KEY), false);
    h.clock(date(12));
    await h.controller.refresh();
    assert.equal(h.saved().period, 'day');
  }
});

test('Поздняя старая session не заменяет более свежий wake', async () => {
  const older = deferred(), newer = deferred();
  let calls = 0;
  const h = fixture({ overrides: { readSession: () => (++calls === 1 ? older.promise : newer.promise) } });
  const one = h.controller.refresh();
  await turn();
  h.clock(date(12));
  const two = h.controller.refresh();
  await turn();
  newer.resolve('wake:new');
  await two;
  h.clock(date(23));
  older.resolve('boot:old');
  await one;
  assert.equal(h.saved().session, 'wake:new');
  assert.equal(h.saved().period, 'day');
  assert.equal(h.applied.at(-1), BACKGROUNDS.day);
});

test('Поздняя старая картинка не затирает новый фон, включая cached restoration', async () => {
  const waiting = { [BACKGROUNDS.evening]: deferred(), [BACKGROUNDS.morning]: deferred(), [BACKGROUNDS.day]: deferred() };
  let session = 'boot:1', clock = date(7);
  const h = fixture({ overrides: {
    readSession: () => Promise.resolve(session), now: () => clock,
    loadImage: path => { h.loaded.push(path); return waiting[path].promise; }
  } });
  const restoration = h.controller.restore();
  const first = h.controller.refresh();
  await turn();
  session = 'wake:2'; clock = date(12);
  const second = h.controller.refresh();
  await turn();
  waiting[BACKGROUNDS.day].resolve();
  await second;
  waiting[BACKGROUNDS.morning].resolve(); waiting[BACKGROUNDS.evening].resolve();
  await Promise.all([first, restoration]);
  assert.deepEqual(h.applied, [BACKGROUNDS.day]);
  assert.equal(h.saved().session, 'wake:2');
});

test('Повторный focus с ошибкой LS2 сохраняет уже выбранную pending session без повторной загрузки', async () => {
  const pending = deferred();
  let calls = 0;
  const h = fixture({ overrides: {
    readSession: () => ++calls === 1 ? Promise.resolve('boot:1') : Promise.reject(Error('temporary')),
    loadImage: path => { h.loaded.push(path); return path === BACKGROUNDS.morning ? pending.promise : Promise.resolve(); }
  } });
  const first = h.controller.refresh();
  await turn();
  const second = h.controller.refresh();
  await turn();
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(h.loaded.filter(path => path === BACKGROUNDS.morning).length, 1);
  assert.equal(h.applied.at(-1), BACKGROUNDS.morning);
  assert.equal(h.saved().session, 'boot:1');
});

test('Ошибка выбранной картинки сохраняет исправный фон и не повторяет запросы на каждом focus', async () => {
  const items = new Map([[KEY, JSON.stringify({ version: 1, session: 'boot:old', period: 'day' })]]);
  const h = fixture({ items, overrides: {
    loadImage: path => { h.loaded.push(path); return path === BACKGROUNDS.morning ? Promise.reject(Error('missing')) : Promise.resolve(); }
  } });
  await h.controller.restore();
  await h.controller.refresh();
  await h.controller.refresh();
  await h.controller.refresh();
  assert.deepEqual(h.loaded, [BACKGROUNDS.day, BACKGROUNDS.morning]);
  assert.deepEqual(h.applied, [BACKGROUNDS.day]);
  assert.equal(h.saved().session, 'boot:1');
  assert.equal(h.saved().period, 'day');
});

test('Ошибка всех картинок не создаёт цикл и не сохраняет непроверенный выбор', async () => {
  const h = fixture({ overrides: {
    loadImage: path => { h.loaded.push(path); return Promise.reject(Error('missing')); }
  } });
  await h.controller.refresh();
  await h.controller.refresh();
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.loaded, [BACKGROUNDS.morning]);
  assert.equal(h.items.has(KEY), false);
});

test('Browser имеет отдельный storage; dispose блокирует поздние изображения и чтения', async () => {
  const pending = deferred();
  const h = fixture({ overrides: {
    mode: 'browser', loadImage: () => pending.promise
  } });
  const refresh = h.controller.refresh();
  await turn();
  h.controller.dispose();
  pending.resolve();
  await refresh;
  assert.deepEqual(h.applied, []);
  assert.equal(h.items.size, 0);
  assert.equal((await h.controller.refresh()).status, 'disposed');
  const browser = fixture({ overrides: { mode: 'browser' } });
  await browser.controller.refresh();
  assert.equal(browser.items.has(KEY), false);
  assert.equal(browser.items.has('lg-home-wallpaper-v1-browser'), true);
});

test('Подготовленный период запускается без ожидания службы и без проверки браузерных часов', async () => {
  let reads = 0;
  const h = fixture({ overrides: { initialRecord: hint('night'), readSession() { reads++; return new Promise(() => {}); } } });
  h.clock(date(8));
  assert.equal((await h.controller.refresh()).status, 'prepared');
  assert.equal(reads, 0);
  assert.deepEqual(h.loaded, [BACKGROUNDS.night]);
  assert.deepEqual(h.applied, [BACKGROUNDS.night]);
  assert.deepEqual(h.saved(), hint('night'));
});

test('Период backend marker новой session главнее текущих часов и старого кэша', async () => {
  const h = fixture({ items: new Map([[KEY, JSON.stringify(hint('morning', 'wake:yesterday'))]]) });
  h.clock(date(14));
  h.session(hint('night'));
  await h.controller.refresh();
  assert.deepEqual(h.applied, [BACKGROUNDS.night]);
  assert.deepEqual(h.saved(), hint('night'));
});

test('Миграция legacy runtime не меняет уже выбранный фон в той же awake session', async () => {
  const h = fixture({ items: new Map([[KEY, JSON.stringify(hint('morning'))]]) });
  h.clock(date(23)); h.session(hint('night'));
  await h.controller.refresh();
  await h.controller.refresh(hint('evening'));
  assert.deepEqual(h.applied, [BACKGROUNDS.morning]);
  assert.deepEqual(h.saved(), hint('morning'));
});

test('Legacy marker без периода использует подтверждённый кэш, затем местные часы', async () => {
  const h = fixture({ items: new Map([[KEY, JSON.stringify(hint('morning'))]]) });
  h.clock(date(23)); h.session({ version: 1, session: WAKE, period: null });
  await h.controller.refresh();
  assert.deepEqual(h.applied, [BACKGROUNDS.morning]);
  h.session({ version: 1, session: WAKE.replace(/111111111111111111111111$/, '222222222222222222222222'), period: null });
  await h.controller.refresh();
  assert.equal(h.applied.at(-1), BACKGROUNDS.night);
});

test('Новый подготовленный wake отменяет поздний ответ и картинку старого чтения', async () => {
  const older = deferred(), night = deferred(), day = deferred();
  const h = fixture({ overrides: {
    readSession: () => older.promise,
    loadImage(path) { h.loaded.push(path); return path === BACKGROUNDS.night ? night.promise : day.promise; }
  } });
  const oldRead = h.controller.refresh();
  await turn();
  const firstHint = h.controller.refresh(hint('day'));
  await turn();
  const newHint = h.controller.refresh(hint('night', WAKE.replace(/111111111111111111111111$/, '222222222222222222222222')));
  await turn();
  night.resolve(); await newHint;
  day.resolve(); older.resolve(hint('morning'));
  await Promise.all([oldRead, firstHint]);
  assert.deepEqual(h.loaded, [BACKGROUNDS.day, BACKGROUNDS.night]);
  assert.deepEqual(h.applied, [BACKGROUNDS.night]);
});

test('Initial hint используется один раз, Home без новых параметров читает актуальный marker', async () => {
  let reads = 0;
  const h = fixture({ overrides: { initialRecord: hint('morning'), readSession() { reads++; return Promise.resolve(hint('night', WAKE.replace(/111111111111111111111111$/, '222222222222222222222222'))); } } });
  await h.controller.refresh();
  await h.controller.refresh();
  assert.equal(reads, 1);
  assert.deepEqual(h.applied, [BACKGROUNDS.morning, BACKGROUNDS.night]);
});

test('Browser preview игнорирует native initialRecord и явно переданный prepared hint', async () => {
  const h = fixture({ overrides: { mode: 'browser', initialRecord: hint('night') } });
  await h.controller.refresh(hint('day'));
  assert.deepEqual(h.applied, [BACKGROUNDS.morning]);
  assert.equal(h.items.has(KEY), false);
});

test('Неправильный hint не обходит проверку session и не загружает URL', async () => {
  for (const value of [hint('https://evil.example/a.png'), hint('__proto__'), hint('day', 'wake:bad'), { ...hint('day'), version: 2 }]) {
    const session = deferred();
    const h = fixture({ overrides: { initialRecord: value, readSession: () => session.promise } });
    const pending = h.controller.refresh(value);
    await turn();
    assert.deepEqual(h.loaded, []);
    session.resolve(null);
    assert.equal((await pending).path, null);
  }
});

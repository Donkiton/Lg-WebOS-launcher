'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { BACKGROUNDS, OPTIONS, DEFAULT, createController } = require('../wallpaper');
const KEY = 'lg-home-wallpaper-v2-webos';
const BROWSER_KEY = 'lg-home-wallpaper-v2-browser';
const saved = selection => JSON.stringify({ version: 2, selection });
const turn = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const items = options.items || new Map();
  const loaded = [], applied = [], written = [], reads = [];
  const controller = createController({
    mode: 'webos',
    storage: {
      getItem(key) { reads.push(key); if (options.readFails) throw Error('denied'); return items.get(key) ?? null; },
      setItem(key, value) { if (options.writeFails) throw Error('quota'); written.push([key, value]); items.set(key, value); }
    },
    loadImage(path) { loaded.push(path); return Promise.resolve(); },
    apply(path) { applied.push(path); },
    ...options.overrides
  });
  return { controller, items, loaded, applied, written, reads };
}

test('ES5 UMD API сохраняет классику и содержит семь новых фонов и чёрный вариант', () => {
  const source = fs.readFileSync(require.resolve('../wallpaper'), 'utf8');
  assert.doesNotMatch(source, /\b(?:const|let|class)\s|=>|\?\./);
  assert.doesNotMatch(source, /new Date|readSession|setInterval|getWallpaperRecord|periodForDate/);
  const context = { window: {} };
  vm.runInNewContext(source, context);
  assert.equal(typeof context.window.LauncherWallpaper.createController, 'function');
  assert.equal(DEFAULT, 'lake');
  assert.equal(BACKGROUNDS.lake, 'assets/wallpapers/northern-lake.png');
  assert.equal(BACKGROUNDS.none, null);
  assert.deepEqual(OPTIONS.map(option => option.id), Object.keys(BACKGROUNDS));
  assert.ok(OPTIONS.every(option => typeof option.label === 'string' && option.label.length));
  assert.deepEqual(OPTIONS.filter(option => option.group === 'classic').map(option => option.id), ['lake', 'morning', 'day', 'evening', 'night']);
  assert.deepEqual(OPTIONS.filter(option => option.group === 'new').map(option => option.id), ['coast', 'city', 'zen', 'obsidian', 'orbit', 'aurora', 'holiday', 'none']);
  assert.deepEqual(OPTIONS.filter(option => option.group === 'new').map(option => option.material), ['water', 'wet-stone', 'stone', 'stone', 'glass', 'ice', 'wood', 'none']);
});

test('Свежий запуск сразу применяет Северное озеро без изображения, службы или часов', async () => {
  const h = fixture({ overrides: {
    readSession() { throw Error('must not read services'); }, now() { throw Error('must not read clock'); }
  } });
  assert.equal(h.controller.getSelection(), 'lake');
  const pending = h.controller.refresh();
  assert.deepEqual(h.applied, [BACKGROUNDS.lake], 'Initial DOM application is synchronous');
  assert.equal((await pending).status, 'ready');
  await h.controller.refresh();
  await h.controller.refresh({ period: 'night', session: 'tomorrow' });
  assert.deepEqual(h.applied, [BACKGROUNDS.lake]);
  assert.deepEqual(h.loaded, []);
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.reads, [KEY]);
});

test('Каждый сохранённый фон и отсутствие фона восстанавливаются без preload после перезапуска', async () => {
  for (const id of Object.keys(BACKGROUNDS)) {
    const h = fixture({ items: new Map([[KEY, saved(id)]]) });
    assert.equal(h.controller.getSelection(), id);
    const result = await h.controller.refresh();
    assert.deepEqual(result, { selection: id, path: BACKGROUNDS[id], status: 'ready' });
    assert.deepEqual(h.applied, [BACKGROUNDS[id]]);
    assert.deepEqual(h.loaded, []);
  }
});

test('Новый ключ не переносит старые периоды; browser и webos изолированы', async () => {
  const items = new Map([
    ['lg-home-wallpaper-v1-webos', JSON.stringify({ version: 1, session: 'wake:old', period: 'night' })],
    [BROWSER_KEY, saved('day')]
  ]);
  const tv = fixture({ items });
  const browser = fixture({ items, overrides: { mode: 'browser' } });
  await tv.controller.refresh(); await browser.controller.refresh();
  assert.equal(tv.controller.getSelection(), 'lake');
  assert.equal(browser.controller.getSelection(), 'day');
  await tv.controller.select('evening');
  assert.equal(items.get(KEY), saved('evening'));
  assert.equal(items.get(BROWSER_KEY), saved('day'));
  await browser.controller.select('none');
  assert.equal(items.get(KEY), saved('evening'));
  assert.equal(items.get(BROWSER_KEY), saved('none'));
});

test('Повреждённое или недоступное хранилище не блокирует начальный lake', async () => {
  for (const raw of ['bad json', 'x'.repeat(129), 'null', '[]', '{}', saved('__proto__'), saved('https://evil.example/a.png'), JSON.stringify({ version: 1, selection: 'night' })]) {
    const h = fixture({ items: new Map([[KEY, raw]]) });
    await h.controller.refresh();
    assert.equal(h.controller.getSelection(), DEFAULT);
    assert.deepEqual(h.applied, [BACKGROUNDS.lake]);
    assert.deepEqual(h.loaded, []);
  }
  const h = fixture({ readFails: true });
  await h.controller.refresh();
  assert.deepEqual(h.applied, [BACKGROUNDS.lake]);
});

test('initialSelection bootstrap определяет первый DOM фон, включая none, без чтения storage', async () => {
  for (const id of Object.keys(BACKGROUNDS)) {
    const h = fixture({ readFails: true, overrides: { initialSelection: id } });
    const refresh = h.controller.refresh();
    assert.deepEqual(h.applied, [BACKGROUNDS[id]]);
    await refresh;
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.loaded, []);
  }
  const invalid = fixture({ items: new Map([[KEY, saved('night')]]), overrides: { initialSelection: 'external.png' } });
  assert.equal(invalid.controller.getSelection(), 'night');
});

test('Смена грузит только выбранный фон и сохраняет его лишь после успешной загрузки', async () => {
  const image = deferred();
  const h = fixture({ overrides: { loadImage(path) { h.loaded.push(path); return image.promise; } } });
  await h.controller.refresh();
  const request = h.controller.select('night');
  await turn();
  assert.deepEqual(h.loaded, [BACKGROUNDS.night]);
  assert.equal(h.controller.getSelection(), 'lake');
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.applied, [BACKGROUNDS.lake]);
  image.resolve();
  assert.equal((await request).status, 'ready');
  assert.equal(h.controller.getSelection(), 'night');
  assert.equal(h.items.get(KEY), saved('night'));
  assert.deepEqual(h.applied, [BACKGROUNDS.lake, BACKGROUNDS.night]);
});

test('none сохраняется явно, не грузит PNG и переживает перезапуск', async () => {
  const h = fixture();
  await h.controller.refresh();
  assert.deepEqual(await h.controller.select('none'), { selection: 'none', path: null, status: 'ready' });
  assert.equal(h.items.get(KEY), saved('none'));
  assert.deepEqual(h.loaded, []);
  assert.deepEqual(h.applied, [BACKGROUNDS.lake, null]);
  const next = fixture({ items: h.items });
  await next.controller.refresh();
  assert.deepEqual(next.applied, [null]);
  assert.deepEqual(next.loaded, []);
});

test('Недопустимый id не вызывает загрузки, записи или изменения текущего выбора', async () => {
  const h = fixture();
  await h.controller.refresh();
  for (const value of ['__proto__', 'toString', 'https://evil.example/x.png', null, {}, 0]) {
    const result = await h.controller.select(value);
    assert.equal(result.status, 'invalid-selection');
    assert.ok(result.error instanceof Error);
    assert.equal(result.selection, 'lake');
  }
  assert.deepEqual(h.loaded, []); assert.deepEqual(h.written, []);
  assert.deepEqual(h.applied, [BACKGROUNDS.lake]);
});

test('Ошибка файла сохраняет предыдущий выбор и разрешает успешную повторную попытку', async () => {
  let fails = true;
  const h = fixture({ overrides: { loadImage(path) { h.loaded.push(path); return fails ? Promise.reject(Error('missing')) : Promise.resolve(); } } });
  await h.controller.refresh();
  const failed = await h.controller.select('day');
  assert.equal(failed.status, 'image-unavailable'); assert.ok(failed.error);
  assert.equal(h.controller.getSelection(), 'lake');
  assert.deepEqual(h.written, []); assert.deepEqual(h.applied, [BACKGROUNDS.lake]);
  fails = false;
  assert.equal((await h.controller.select('day')).status, 'ready');
  assert.deepEqual(h.loaded, [BACKGROUNDS.day, BACKGROUNDS.day]);
  assert.equal(h.items.get(KEY), saved('day'));
});

test('Бросающий loader обрабатывается и не отравляет повторные попытки', async () => {
  let calls = 0;
  const h = fixture({ overrides: { loadImage() { if (++calls === 1) throw Error('constructor failed'); } } });
  assert.equal((await h.controller.select('morning')).status, 'image-unavailable');
  assert.equal((await h.controller.select('morning')).status, 'ready');
  assert.equal(calls, 2);
});

test('Ошибка сохранения не меняет DOM или выбор; повторная попытка работает', async () => {
  let fails = true;
  const items = new Map([[KEY, saved('evening')]]);
  const h = fixture({ items, overrides: { storage: {
    getItem: key => items.get(key),
    setItem(key, value) { if (fails) throw Error('quota'); items.set(key, value); }
  } } });
  await h.controller.refresh();
  const failed = await h.controller.select('night');
  assert.equal(failed.status, 'storage-unavailable'); assert.ok(failed.error);
  assert.equal(h.controller.getSelection(), 'evening');
  assert.equal(items.get(KEY), saved('evening'));
  assert.deepEqual(h.applied, [BACKGROUNDS.evening]);
  fails = false;
  assert.equal((await h.controller.select('night')).status, 'ready');
  assert.equal(items.get(KEY), saved('night'));
});

test('При отсутствии storage ручная смена сообщает ошибку и сохраняет рабочий фон', async () => {
  const h = fixture({ overrides: { storage: null } });
  await h.controller.refresh();
  assert.equal((await h.controller.select('none')).status, 'storage-unavailable');
  assert.equal(h.controller.getSelection(), 'lake');
  assert.deepEqual(h.applied, [BACKGROUNDS.lake]);
});

test('Поздняя старая картинка не затирает последний выбранный фон', async () => {
  const day = deferred(), night = deferred();
  const h = fixture({ overrides: { loadImage(path) { h.loaded.push(path); return path === BACKGROUNDS.day ? day.promise : night.promise; } } });
  await h.controller.refresh();
  const older = h.controller.select('day');
  await turn();
  const newer = h.controller.select('night');
  await turn();
  night.resolve(); assert.equal((await newer).status, 'ready');
  day.resolve(); assert.equal((await older).status, 'stale');
  assert.equal(h.controller.getSelection(), 'night');
  assert.deepEqual(h.applied, [BACKGROUNDS.lake, BACKGROUNDS.night]);
  assert.deepEqual(h.written, [[KEY, saved('night')]]);
});

test('Быстрый возврат к текущему фону отменяет ожидающую смену', async () => {
  const image = deferred();
  const h = fixture({ overrides: { loadImage() { return image.promise; } } });
  await h.controller.refresh();
  const pending = h.controller.select('day'); await turn();
  assert.equal((await h.controller.select('lake')).status, 'unchanged');
  image.resolve();
  assert.equal((await pending).status, 'stale');
  assert.deepEqual(h.applied, [BACKGROUNDS.lake]); assert.deepEqual(h.written, []);
});

test('Повторная смена на тот же ожидающий фон делит только незавершённую загрузку', async () => {
  let image = deferred();
  const h = fixture({ overrides: { loadImage(path) { h.loaded.push(path); return image.promise; } } });
  const one = h.controller.select('day'); await turn();
  const two = h.controller.select('day'); await turn();
  assert.deepEqual(h.loaded, [BACKGROUNDS.day]);
  image.resolve();
  assert.equal((await one).status, 'stale'); assert.equal((await two).status, 'ready');
  await h.controller.select('none');
  image = deferred();
  const retry = h.controller.select('day'); await turn();
  assert.deepEqual(h.loaded, [BACKGROUNDS.day, BACKGROUNDS.day], 'Completed images are not retained by the controller');
  image.resolve(); await retry;
});

test('Обычный refresh во время ручной загрузки не отменяет выбор и не читает сервисы', async () => {
  const image = deferred();
  const h = fixture({ overrides: { loadImage() { return image.promise; } } });
  await h.controller.refresh();
  const pending = h.controller.select('night'); await turn();
  assert.equal((await h.controller.refresh()).selection, 'lake');
  image.resolve(); assert.equal((await pending).selection, 'night');
  assert.equal(h.controller.getSelection(), 'night');
});

test('dispose блокирует поздний PNG и запись; subsequent вызовы безопасны', async () => {
  const image = deferred();
  const h = fixture({ overrides: { loadImage() { return image.promise; } } });
  await h.controller.refresh();
  const request = h.controller.select('night'); await turn();
  h.controller.dispose(); image.resolve();
  assert.equal((await request).status, 'disposed');
  assert.deepEqual(h.applied, [BACKGROUNDS.lake]); assert.deepEqual(h.written, []);
  assert.equal((await h.controller.refresh()).status, 'disposed');
  assert.equal((await h.controller.select('none')).status, 'disposed');
});

test('Ошибка apply при смене восстанавливает прежнее сохранённое значение', async () => {
  const h = fixture({ overrides: { apply(path) { if (path === BACKGROUNDS.night) throw Error('detached node'); h.applied.push(path); } } });
  await h.controller.refresh();
  assert.equal((await h.controller.select('night')).status, 'apply-unavailable');
  assert.equal(h.controller.getSelection(), 'lake');
  assert.equal(h.items.get(KEY), saved('lake'));
  assert.deepEqual(h.applied, [BACKGROUNDS.lake]);
});

test('Предпросмотр меняет экран и материал, сохраняя установленный фон без записи', async () => {
  const materials = [];
  const h = fixture({ overrides: { apply(path, id, option) { h.applied.push(path); materials.push([id, option.material]); } } });
  await h.controller.refresh();
  assert.equal((await h.controller.preview('holiday')).status, 'ready');
  assert.equal(h.controller.getSelection(), 'lake');
  assert.equal(h.controller.getPreview(), 'holiday');
  assert.deepEqual(h.written, []);
  assert.deepEqual(materials, [['lake', 'water'], ['holiday', 'wood']]);
  await h.controller.refresh();
  assert.equal(h.controller.getPreview(), 'holiday', 'Window focus refresh keeps the active preview');
  assert.deepEqual(h.applied, [BACKGROUNDS.lake, BACKGROUNDS.holiday]);
  const cancelled = h.controller.cancelPreview();
  assert.equal(h.controller.getPreview(), 'lake', 'Closing the panel restores the saved image synchronously');
  await cancelled;
  assert.deepEqual(h.written, []);
  assert.deepEqual(materials, [['lake', 'water'], ['holiday', 'wood'], ['lake', 'water']]);
});

test('OK сохраняет готовый предпросмотр без повторной загрузки и лишнего apply', async () => {
  const h = fixture();
  await h.controller.refresh();
  await h.controller.preview('orbit');
  assert.equal((await h.controller.select('orbit')).status, 'ready');
  assert.equal(h.controller.getSelection(), 'orbit');
  assert.deepEqual(h.loaded, [BACKGROUNDS.orbit]);
  assert.deepEqual(h.applied, [BACKGROUNDS.lake, BACKGROUNDS.orbit]);
  assert.deepEqual(h.written, [[KEY, saved('orbit')]]);
  await h.controller.preview('none');
  await h.controller.cancelPreview();
  assert.equal(h.controller.getPreview(), 'orbit');
  assert.deepEqual(h.written, [[KEY, saved('orbit')]]);
});

test('Поздний предпросмотр и ожидающий OK не могут примениться после отмены', async () => {
  for (const operation of ['preview', 'select']) {
    const image = deferred();
    const h = fixture({ overrides: { loadImage() { return image.promise; } } });
    await h.controller.refresh();
    await h.controller.preview('none');
    const pending = h.controller[operation]('aurora');
    await turn();
    await h.controller.cancelPreview();
    image.resolve();
    assert.equal((await pending).status, 'stale');
    assert.equal(h.controller.getPreview(), 'lake');
    assert.equal(h.controller.getSelection(), 'lake');
    assert.deepEqual(h.written, []);
    assert.deepEqual(h.applied, [BACKGROUNDS.lake, null, BACKGROUNDS.lake]);
  }
});

test('Быстрое перемещение фокуса оставляет только последний предпросмотр', async () => {
  const coast = deferred(), city = deferred();
  const h = fixture({ overrides: { loadImage(path) { return path === BACKGROUNDS.coast ? coast.promise : city.promise; } } });
  await h.controller.refresh();
  const older = h.controller.preview('coast'); await turn();
  const newer = h.controller.preview('city'); await turn();
  city.resolve(); assert.equal((await newer).status, 'ready');
  coast.resolve(); assert.equal((await older).status, 'stale');
  assert.equal(h.controller.getPreview(), 'city');
  assert.deepEqual(h.applied, [BACKGROUNDS.lake, BACKGROUNDS.city]);
  assert.deepEqual(h.written, []);
});

test('Отмена загрузки освобождает отменяемый loader при смене фокуса и закрытии', async () => {
  const requests = [], cancellations = [];
  const h = fixture({ overrides: { loadImage(path) {
    const image = deferred();
    image.promise.cancel = () => { cancellations.push(path); image.reject(Error('cancelled')); };
    requests.push(image);
    return image.promise;
  } } });
  await h.controller.refresh();
  const first = h.controller.preview('coast'); await turn();
  const second = h.controller.preview('city'); await turn();
  await h.controller.cancelPreview();
  assert.equal((await first).status, 'stale');
  assert.equal((await second).status, 'stale');
  assert.deepEqual(cancellations, [BACKGROUNDS.coast, BACKGROUNDS.city]);
  assert.equal(h.controller.getPreview(), 'lake');
});

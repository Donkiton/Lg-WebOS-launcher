'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../wallpaper'), 'utf8');
const index = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
const saved = selection => JSON.stringify({ version: 2, selection });
const KEY = 'lg-home-wallpaper-v2-webos';
const BROWSER_KEY = 'lg-home-wallpaper-v2-browser';

function fixture(options = {}) {
  const styles = [], reads = [], order = [];
  let paramReads = 0, images = 0;
  const document = {
    head: { appendChild(node) { styles.push(node); order.push('css'); } },
    createElement() { return {}; }
  };
  const window = { document, navigator: { userAgent: options.browser ? 'desktop' : 'webOS' } };
  if (!options.browser) window.PalmServiceBridge = function () { throw Error('No service during bootstrap'); };
  window.Image = function () { images++; throw Error('No Image preload during bootstrap'); };
  window.PalmSystem = {};
  Object.defineProperty(window.PalmSystem, 'launchParams', { get() { paramReads++; if (options.paramsThrow) throw Error('denied'); return options.params; } });
  Object.defineProperty(window, 'localStorage', { configurable: true, get() {
    if (options.storageThrows) throw Error('Storage unavailable');
    return { getItem(key) {
      reads.push(key);
      if (options.readThrows) throw Error('Storage read denied');
      return options.items ? options.items.get(key) : options.cached ?? null;
    } };
  } });
  const context = vm.createContext({ window, document, Promise: undefined, Date: undefined, setTimeout: undefined });
  vm.runInContext(source, context);
  return { window, document, context, styles, reads, order, images: () => images, paramReads: () => paramReads, api: window.LauncherWallpaper };
}

function expectedCSS(path) {
  return '#wallpaper {background-color:#000;background-image:' + (path ? 'url("' + path + '")' : 'none') + '}';
}

test('Head сразу выбирает lake без параметров, Promise, часов, службы или ожидания onload', () => {
  const h = fixture();
  h.order.push('platform/LS2');
  assert.deepEqual(h.order, ['css', 'platform/LS2']);
  assert.equal(h.api.early.selection, 'lake');
  assert.equal(h.api.early.path, 'assets/wallpapers/northern-lake.png');
  assert.equal(h.styles.length, 1);
  assert.equal(h.styles[0].textContent, expectedCSS(h.api.BACKGROUNDS.lake));
  assert.equal(h.styles[0].id, 'lg-gate-wallpaper-bootstrap');
  assert.equal(h.images(), 0, 'CSS owns the sole initial image request; Image.onload cannot gate it');
  assert.deepEqual(h.reads, [KEY]);
  assert.equal(h.paramReads(), 1);
  assert.match(index, /<script src="wallpaper\.js"><\/script>/);
  assert.ok(index.indexOf('src="wallpaper.js"') < index.indexOf('src="platform.js"'));
  assert.ok(index.indexOf('src="wallpaper.js"') < index.indexOf('href="styles.css"'));
});

test('Все сохранённые варианты, включая чёрный none, определяют единственную CSS картинку', () => {
  for (const id of ['lake', 'morning', 'day', 'evening', 'night', 'none']) {
    const h = fixture({ cached: saved(id) });
    assert.equal(h.api.early.selection, id);
    assert.equal(h.styles[0].textContent, expectedCSS(h.api.BACKGROUNDS[id]));
    assert.equal(h.images(), 0);
    assert.equal((h.styles[0].textContent.match(/url\(/g) || []).length, id === 'none' ? 0 : 1);
    for (const other of Object.keys(h.api.BACKGROUNDS)) {
      if (other !== id && h.api.BACKGROUNDS[other]) assert.ok(!h.styles[0].textContent.includes(h.api.BACKGROUNDS[other]));
    }
  }
});

test('Неверный и старый storage безопасно восстанавливают default без URL из данных', () => {
  for (const raw of ['{broken', 'null', '[]', 'x'.repeat(129), saved('__proto__'), saved('https://evil.example/a.png'),
    JSON.stringify({ version: 1, period: 'night' }), JSON.stringify({ version: 1, selection: 'night' })]) {
    const h = fixture({ cached: raw });
    assert.equal(h.api.early.selection, 'lake');
    assert.equal(h.styles[0].textContent, expectedCSS(h.api.BACKGROUNDS.lake));
  }
  for (const options of [{ storageThrows: true }, { readThrows: true }]) {
    const h = fixture(options);
    assert.equal(h.api.early.selection, 'lake');
    assert.equal(h.styles.length, 1);
  }
});

test('Legacy session cache не мигрирует, browser и webos используют отдельные ключи', () => {
  const items = new Map([
    ['lg-home-wallpaper-v1-webos', JSON.stringify({ version: 1, session: 'wake:yesterday', period: 'night' })],
    [BROWSER_KEY, saved('day')]
  ]);
  const tv = fixture({ items });
  const browser = fixture({ browser: true, items });
  assert.equal(tv.api.early.selection, 'lake');
  assert.equal(browser.api.early.selection, 'day');
  assert.deepEqual(tv.reads, [KEY]); assert.deepEqual(browser.reads, [BROWSER_KEY]);
  assert.equal(browser.paramReads(), 0);
  assert.equal(browser.api.initialParamsRead, false);
});

test('Startup wallpaper hints и любые часы никогда не изменяют ручной выбор', () => {
  for (const params of [undefined, '{}', '{bad json', [],
    { lgGateStartup: true, lgGateWallpaper: { version: 1, session: 'wake:old', period: 'night' } },
    { lgGateStartup: true, lgGateWallpaper: { period: 'https://evil.example/a.png' } }]) {
    const h = fixture({ params, cached: saved('evening') });
    assert.equal(h.api.early.selection, 'evening');
    assert.equal(h.styles[0].textContent, expectedCSS(h.api.BACKGROUNDS.evening));
    assert.equal(h.paramReads(), 1);
  }
});

test('Snapshot launchParams читается ровно один раз и сохраняет shortcut для cold launch', () => {
  const h = fixture({ params: '{"shortcut":"zona","lgGateStartup":true}' });
  assert.equal(h.api.initialParamsRead, true);
  assert.equal(h.api.initialParams.shortcut, 'zona');
  h.api.bootstrap(h.window);
  assert.equal(h.paramReads(), 1);
  assert.equal(h.styles.length, 1);
  assert.deepEqual(h.reads, [KEY]);
  const invalid = fixture({ paramsThrow: true });
  assert.equal(invalid.api.initialParamsRead, true);
  assert.equal(invalid.api.initialParams, null);
  assert.equal(invalid.styles.length, 1);
});

test('Bootstrap browser тоже идемпотентен и не создаёт повторный CSS или preload', () => {
  const h = fixture({ browser: true, cached: saved('none') });
  h.api.bootstrap(h.window);
  h.api.bootstrap(h.window);
  assert.deepEqual(h.reads, [BROWSER_KEY]);
  assert.equal(h.styles.length, 1);
  assert.equal(h.images(), 0);
  assert.equal(h.paramReads(), 0);
});

test('Сбой добавления раннего CSS не выбрасывает исключение и оставляет валидный selection для app', () => {
  const window = {
    navigator: { userAgent: 'webOS' },
    document: { createElement() { return {}; }, head: { appendChild() { throw Error('head unavailable'); } } },
    localStorage: { getItem() { return saved('night'); } }
  };
  vm.runInNewContext(source, { window, Promise: undefined });
  assert.equal(window.LauncherWallpaper.early.selection, 'night');
  assert.equal(window.LauncherWallpaper.early.path, 'assets/wallpapers/night.png');
});

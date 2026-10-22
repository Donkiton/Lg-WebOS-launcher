'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../wallpaper'), 'utf8');
const app = fs.readFileSync(require.resolve('../app'), 'utf8');
const index = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
const SESSION = 'wake:12345678-1234-5678-90ab-1234567890ab:111111111111111111111111';
const record = (period, session = SESSION) => ({ version: 1, session, period });
const params = (period, session) => ({ lgGateStartup: true, lgGateWallpaper: record(period, session) });
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(value, native = true, cached = null) {
  const images = [], requests = [], styles = [], order = [];
  let reads = 0;
  function Image() {
    images.push(this);
    Object.defineProperty(this, 'src', { set(path) { requests.push(path); order.push('image'); } });
  }
  const document = {
    head: { appendChild(node) { styles.push(node.textContent); } },
    createElement() { return {}; }
  };
  const window = { Image, document, navigator: { userAgent: native ? 'webOS' : 'desktop' } };
  if (native) window.PalmServiceBridge = function () {};
  window.PalmSystem = {};
  Object.defineProperty(window.PalmSystem, 'launchParams', { get() { reads++; return value; } });
  Object.defineProperty(window, 'localStorage', { configurable: true, get() {
    if (cached === null) throw Error('Storage unavailable');
    return { getItem(key) { assert.equal(key, 'lg-home-wallpaper-v1-webos'); return cached; } };
  } });
  const context = vm.createContext({ window, document, Promise: undefined });
  vm.runInContext(source, context);
  return { window, document, context, images, requests, styles, order, reads: () => reads, api: window.LauncherWallpaper };
}

function region(first, after) {
  const start = app.indexOf(first), end = app.indexOf(after, start);
  assert.ok(start >= 0 && end > start);
  return app.slice(start, end);
}

test('Синхронный head bootstrap запрашивает только выбранный PNG до platform и LS2 без Promise', () => {
  for (const period of ['morning', 'day', 'evening', 'night']) {
    const h = fixture(JSON.stringify(params(period)));
    h.order.push('platform/LS2');
    assert.deepEqual(h.order, ['image', 'platform/LS2']);
    assert.deepEqual(h.requests, [h.api.BACKGROUNDS[period]]);
    assert.equal(h.styles.length, 1);
    assert.equal(h.styles[0], '#wallpaper {background-image:url("' + h.api.BACKGROUNDS[period] + '")}');
    assert.equal(h.reads(), 1);
    assert.equal(h.api.early.state, 'loading');
    let callback = false;
    h.api.early.listen(error => { assert.equal(error, null); callback = true; });
    h.images[0].onload();
    assert.equal(callback, true);
    assert.equal(h.api.early.state, 'ready');
    h.api.bootstrap(h.window);
    assert.equal(h.reads(), 1);
    assert.equal(h.requests.length, 1);
  }
  assert.match(index, /<script src="wallpaper\.js"><\/script>/);
  assert.ok(index.indexOf('src="wallpaper.js"') < index.indexOf('src="platform.js"'));
  assert.ok(index.indexOf('src="wallpaper.js"') < index.indexOf('href="styles.css"'));
});

test('Bootstrap и controller сохраняют одну фазу legacy cache той же проверенной session', async () => {
  const cached = JSON.stringify(record('morning'));
  const h = fixture(params('night'), true, cached);
  assert.deepEqual(h.requests, ['assets/wallpapers/morning.png']);
  assert.equal(h.api.early.record.period, 'morning');
  const node = { style: {} };
  h.document.getElementById = id => id === 'wallpaper' ? node : null;
  Object.assign(h.window, { setTimeout, clearTimeout });
  Object.assign(h.context, { Promise, setTimeout, clearTimeout, wallpaperController: null,
    platform: { mode: 'webos', getWallpaperRecord() { return Promise.resolve(record('night')); } } });
  vm.runInContext(region('  function setupWallpaper()', '  function updateClock()') + '\nsetupWallpaper();refreshWallpaper();', h.context);
  h.images[0].onload(); await turn();
  assert.equal(node.style.backgroundImage, 'url("assets/wallpapers/morning.png")');
  h.context.refreshWallpaper(params('night'));
  await turn();
  assert.equal(node.style.backgroundImage, 'url("assets/wallpapers/morning.png")');
  assert.equal(h.images.length, 1);
  for (const invalid of [JSON.stringify(record('morning', SESSION.replace(/111111111111111111111111$/, '222222222222222222222222'))),
    JSON.stringify(record('https://evil.example')), 'x'.repeat(513), '{broken']) {
    const safe = fixture(params('night'), true, invalid);
    assert.deepEqual(safe.requests, ['assets/wallpapers/night.png']);
  }
});

test('Неверный native hint не читает storage и не создаёт запрос картинки или CSS', () => {
  for (const value of [undefined, '{}', '{bad json', [], { lgGateWallpaper: record('morning') },
    { ...params('day'), lgGateStartup: false }, params('https://evil.example/a.png'), params('__proto__'),
    params('day', 'wake:bad'), { lgGateStartup: true, lgGateWallpaper: { ...record('day'), version: 2 } }]) {
    const h = fixture(value);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.styles, []);
    assert.equal(h.api.early, null);
  }
  const h = fixture({ ...params('night'), url: 'https://evil.example/a.png' });
  assert.deepEqual(h.requests, [h.api.BACKGROUNDS.night]);
});

test('Browser preview не читает PalmSystem и не принимает его подсказку', () => {
  const h = fixture(params('day'), false);
  assert.equal(h.reads(), 0);
  assert.equal(h.api.initialParamsRead, false);
  assert.deepEqual(h.requests, []);
});

test('Zona cold fallback использует единственное уже прочитанное значение PalmSystem', () => {
  const h = fixture('{"shortcut":"zona"}');
  h.context.platform = { mode: 'webos' };
  h.context.nativeLaunchSeen = false;
  h.context.pendingShortcut = null;
  h.context.tryPendingShortcut = function () {};
  vm.runInContext(region('  function shortcutFromParams(params)', '  function tryPendingShortcut()') +
    region('  function handleColdLaunch()', '  function refreshNetwork()') + '\nhandleColdLaunch();', h.context);
  assert.equal(h.context.pendingShortcut, 'zona');
  assert.equal(h.reads(), 1);
  assert.deepEqual(h.requests, []);
});

test('Реальный app setup переиспользует раннюю Image и не ждёт getWallpaperRecord для cold hint', async () => {
  const h = fixture(params('night'));
  const node = { style: {} }, values = new Map();
  let serviceReads = 0;
  h.document.getElementById = id => id === 'wallpaper' ? node : null;
  Object.defineProperty(h.window, 'localStorage', { value: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } });
  Object.assign(h.window, { setTimeout, clearTimeout });
  Object.assign(h.context, { Promise, setTimeout, clearTimeout, wallpaperController: null,
    platform: { mode: 'webos', getWallpaperRecord() { serviceReads++; return new Promise(() => {}); } } });
  vm.runInContext(region('  function setupWallpaper()', '  function updateClock()') + '\nsetupWallpaper();refreshWallpaper();', h.context);
  await turn();
  assert.equal(serviceReads, 0);
  assert.equal(h.images.length, 1);
  h.images[0].onload();
  await turn();
  assert.equal(node.style.backgroundImage, 'url("assets/wallpapers/night.png")');
  assert.equal(h.images.length, 1, 'controller must reuse the preload instead of allocating another Image');
  assert.equal(h.reads(), 1);
});

test('Native relaunch передаёт новый hint; Home {} не переиспользует stale PalmSystem', async () => {
  const h = fixture(params('morning'));
  const node = { style: {} };
  let serviceReads = 0, finishOld;
  h.document.getElementById = id => id === 'wallpaper' ? node : null;
  Object.assign(h.window, { setTimeout, clearTimeout });
  Object.assign(h.context, { Promise, setTimeout, clearTimeout, wallpaperController: null,
    platform: { mode: 'webos', getWallpaperRecord() { serviceReads++; return new Promise(resolve => { finishOld = resolve; }); } },
    nativeLaunchSeen: false, coldShortcutConsumed: false, cancelActivation() {}, goHome() {} });
  vm.runInContext(region('  function setupWallpaper()', '  function updateClock()') +
    region('  function shortcutFromParams(params)', '  function tryPendingShortcut()') +
    region('  function handleNativeLaunch(event, initial)', '  function handleColdLaunch()') +
    '\nsetupWallpaper();refreshWallpaper();', h.context);
  h.images[0].onload(); await turn();
  h.context.handleNativeLaunch({ detail: {} }, false);
  await turn();
  assert.equal(serviceReads, 1);
  const next = SESSION.replace(/111111111111111111111111$/, '222222222222222222222222');
  h.context.handleNativeLaunch({ detail: params('night', next) }, false);
  await turn();
  assert.equal(h.images.length, 2);
  h.images[1].onload(); await turn();
  finishOld(record('day')); await turn();
  assert.equal(node.style.backgroundImage, 'url("assets/wallpapers/night.png")');
  assert.equal(h.reads(), 1);
  assert.equal(serviceReads, 1, 'prepared relaunch must not start another Homebrew request');
});

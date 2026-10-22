'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const msx = require('../msx-catalog');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
function region(first, after) {
  const start = source.indexOf(first), end = source.indexOf(after, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function harness(launchApp) {
  const classes = { add() {}, remove() {}, toggle() {} };
  let frame, html = '';
  const listeners = {};
  const overlay = {
    hidden: true, classList: classes, setAttribute() {},
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      frame = value.includes('id="msx-portal"') ? {
        src: 'file:///app/portal.html', focused: false,
        contentWindow: { location: { href: 'file:///app/portal.html' } },
        focus() { this.focused = true; }
      } : null;
    }
  };
  const document = {
    activeElement: { id: 'grid-app-0', getAttribute() { return 'msx:real'; } },
    getElementById(id) { return id === 'msx-portal' ? frame : null; },
    addEventListener(name, fn) { listeners[name] = fn; }
  };
  const context = vm.createContext({
    document, overlay, home: { removeAttribute() {}, setAttribute() {} },
    stage: { classList: classes }, window: { LauncherMSXCatalog: msx, setTimeout(fn) { fn(); } },
    platform: { launchApp, mode: 'webos' },
    view: 'home', viewData: null, stack: [], viewRevision: 0, lastHomeIndex: 0,
    pendingShortcut: null, nativeLaunchSeen: false, coldShortcutConsumed: false,
    enterDown: false, pointerDown: false, pointerConsumed: false, suppressClickUntil: 0,
    findApp() { return { id: 'msx:real', name: 'Приложение <MSX>', brand: 'zona' }; },
    cancelPress() {}, focusId() { return true; }, focusHome() {}, updatePriorities() {}, homeCardIndex() { return 0; }, flushCatalog() {}, loadApps() {}, refreshWallpaper() {},
    brand() { return ''; }, theme() { return 'zona'; },
    catalogIndex() { return 0; }, favorites: ['msx:real'],
    updateCurrentView() {}, Promise
  });
  vm.runInContext([
    region('  function escapeHtml(value)', '  function theme(app)'),
    region('  function renderView(name, data)', '  function detailRow('),
    region('  function shortcutFromParams(params)', '  function refreshNetwork()'),
    region('  function openView(name, data)', '  function openContext('),
    region('  function cancelActivation()', "  stage.addEventListener('click'"),
    region("  document.addEventListener('webOSRelaunch'", "  document.addEventListener('visibilitychange'")
  ].join('\n'), context);
  return { context, overlay, listeners, frame: () => frame };
}
async function turn() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

test('MSX launch открывает полноэкранный iframe и навигацию из локальной точки возврата', async () => {
  const h = harness(() => Promise.resolve({ embedded: true, url: 'https://example.com/?x="&y=2' }));
  h.context.openView('launch', { appId: 'msx:real' });
  await turn();
  assert.equal(h.context.view, 'portal');
  assert.equal(h.overlay.className, 'overlay is-open portal-open');
  assert.match(h.overlay.innerHTML, /src="portal.html"/);
  assert.doesNotMatch(h.overlay.innerHTML, /https:\/\/example.com/);
  assert.match(h.overlay.innerHTML, /title="Приложение &lt;MSX&gt;"/);
  assert.match(h.overlay.innerHTML, /sandbox="allow-scripts allow-same-origin allow-forms allow-presentation allow-popups"/);
  assert.doesNotMatch(h.overlay.innerHTML, /allow-top-navigation/);
  assert.equal(h.frame().focused, true);
  h.frame().onload();
  assert.equal(h.frame().contentWindow.location.href, 'https://example.com/?x="&y=2');
});

test('Возврат LG Gate через webOSRelaunch удаляет iframe и его плеер', async () => {
  const h = harness(() => Promise.resolve({ embedded: true, url: 'https://example.com/' }));
  h.context.openView('launch', { appId: 'msx:real' });
  await turn();
  h.listeners.webOSRelaunch();
  assert.equal(h.context.view, 'home');
  assert.equal(h.frame(), null);
  assert.equal(h.overlay.hidden, true);
});

test('Системный Home возвращает главный экран из каталога, настроек и черновика без сохранения порядка', () => {
  for (const view of ['apps', 'settings', 'context', 'reorder', 'replace']) {
    const h = harness(() => Promise.resolve({ simulated: false }));
    h.context.view = view;
    h.context.viewData = { appId: 'msx:real', order: ['changed', 'draft'] };
    h.context.stack = [{ name: 'home' }, { name: 'apps' }];
    h.context.enterDown = h.context.pointerDown = h.context.pointerConsumed = true;
    h.overlay.hidden = false;
    const favorites = Array.from(h.context.favorites);
    h.listeners.webOSRelaunch();
    assert.equal(h.context.view, 'home', view);
    assert.equal(h.context.viewData, null, view);
    assert.equal(h.context.stack.length, 0, view);
    assert.equal(h.overlay.hidden, true, view);
    assert.deepEqual(Array.from(h.context.favorites), favorites, view);
    assert.equal(h.context.enterDown, false, view);
    assert.equal(h.context.pointerDown, false, view);
    assert.equal(h.context.pointerConsumed, false, view);
  }
});

test('Закрытый до ответа запуск не возвращает iframe запоздалым Promise', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.context.openView('launch', { appId: 'msx:real' });
  h.context.goHome();
  resolve({ embedded: true, url: 'https://example.com/' });
  await turn();
  assert.equal(h.context.view, 'home');
  assert.equal(h.frame(), null);
});

test('Возврат MSX Exit к локальной точке закрывает iframe вместо повторного запуска', async () => {
  const h = harness(() => Promise.resolve({ embedded: true, url: 'https://example.com/' }));
  h.context.openView('launch', { appId: 'msx:real' });
  await turn();
  const frame = h.frame();
  frame.onload();
  Object.defineProperty(frame.contentWindow, 'location', { configurable: true, get() { throw Error('Cross origin'); } });
  frame.onload();
  Object.defineProperty(frame.contentWindow, 'location', { value: { href: frame.src } });
  frame.onload();
  assert.equal(h.context.view, 'home');
  assert.equal(h.frame(), null);
});

test('Официальный MSX Exit закрывается до обхода совместной истории на webOS 4.5', async () => {
  const h = harness(() => Promise.resolve({ embedded: true, url: 'https://example.com/' }));
  h.context.openView('launch', { appId: 'msx:real' });
  await turn();
  const frame = h.frame();
  frame.onload();
  frame.contentWindow.location.href = 'https://msx.benzac.de/exit.html';
  frame.onload();
  assert.equal(h.context.view, 'home');
  assert.equal(h.frame(), null);
});

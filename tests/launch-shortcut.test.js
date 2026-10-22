'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homeState = require('../home-state');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Exercise production bootstrap, catalog callbacks, native lifecycle and Back.
// The fixture supplies DOM/platform primitives without contacting a television.
function harness(options = {}) {
  const writes = [], cachedWrites = [], priorities = [], frames = [], requested = [], launches = [], settingsCalls = [];
  const storage = new Map();
  if (options.favorites !== undefined) storage.set('lg-home-favorites-v1-webos', JSON.stringify(options.favorites));
  if (options.order) storage.set('lg-home-catalog-order-v1-webos', JSON.stringify(options.order));
  storage.set('lg-home-prototype-v1', JSON.stringify({ motion: 'off', hints: false }));
  let document, stage, request, resolveRequest, rejectRequest;
  const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function element(tag, attrs = {}) {
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    let html = '';
    const node = {
      tagName: tag.toUpperCase(), attrs, children: [], parentNode: null, style: { setProperty() {} }, hidden: false,
      listeners: {}, textContent: '',
      get id() { return this.attrs.id || ''; },
      get disabled() { return Object.hasOwn(this.attrs, 'disabled'); },
      classList: {
        add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); },
        toggle(value, force) { if (force === undefined) force = !classes.has(value); if (force) classes.add(value); else classes.delete(value); return force; }
      },
      getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
      setAttribute(name, value) { this.attrs[name] = String(value); }, removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      contains(child) { while (child) { if (child === this) return true; child = child.parentNode; } return false; },
      querySelectorAll(selector) {
        const list = [];
        const match = child => {
          if (selector[0] === '.') return child.classList.contains(selector.slice(1));
          const attr = selector.match(/^(\w+)?\[([\w-]+)\]$/);
          if (attr) return (!attr[1] || child.tagName === attr[1].toUpperCase()) && child.getAttribute(attr[2]) !== null;
          return child.tagName === selector.toUpperCase();
        };
        const visit = parent => { for (const child of parent.children) { if (match(child)) list.push(child); visit(child); } };
        visit(this); return list;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      getBoundingClientRect() {
        let left = 0, top = 100, width = 78, height = 78;
        const header = ['all-apps-button', 'network-button', 'settings-button'].indexOf(this.id);
        if (header >= 0) left = 1450 + header * 108;
        else if (this.id.startsWith('home-app-')) { left = 88 + Number(this.attrs['data-home-index']) * 298; top = 590; width = 270; height = 204; }
        else if (this.attrs['data-grid-index'] !== undefined) { const i = Number(this.attrs['data-grid-index']); left = 88 + i % 6 * 295; top = 287 + Math.floor(i / 6) * 221; width = 267; height = 187; }
        else if (this.id === 'view-back') left = 1733;
        else if (this.id === 'catalog-manage') left = 1465;
        return { left, top, width, height };
      },
      focus() {
        document.activeElement = this;
        if (stage) for (const fn of stage.listeners.focusin || []) fn({ target: this });
      },
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = String(value); this.children = [];
        const stack = [this];
        const tokens = /<\/?([A-Za-z][\w-]*)\b([^>]*)>/g;
        let token;
        while ((token = tokens.exec(html))) {
          const closing = token[0][1] === '/';
          if (closing) { if (stack.length > 1) stack.pop(); continue; }
          const childAttrs = {};
          for (const item of token[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) childAttrs[item[1]] = decode(item[2] || '');
          const child = element(token[1], childAttrs);
          child.parentNode = stack[stack.length - 1]; child.parentNode.children.push(child);
          if (!/^(img|br|input|meta|link|hr)$/i.test(token[1]) && !token[0].endsWith('/>')) stack.push(child);
        }
      },
      get outerHTML() { return '<' + tag + '>' + html + '</' + tag + '>'; }
    };
    return node;
  }
  const append = (parent, child) => { child.parentNode = parent; parent.children.push(child); return child; };
  document = element('document'); document.hidden = false; document.activeElement = null;
  document.getElementById = id => { let found = null; const visit = node => { if (node.id === id) found = node; for (const child of node.children) visit(child); }; visit(document); return found; };
  stage = append(document, element('main', { id: 'stage' }));
  const home = append(stage, element('section', { id: 'home' }));
  for (const id of ['clock-time', 'clock-date', 'all-apps-button', 'network-button', 'settings-button', 'home-rail', 'remote-hint']) {
    append(home, element(/button/.test(id) ? 'button' : 'div', { id, ...(/button/.test(id) ? { 'data-action': id === 'all-apps-button' ? 'apps' : id.split('-')[0] } : {}) }));
  }
  const rail = document.getElementById('home-rail');
  const overlay = append(stage, element('section', { id: 'overlay' }));
  append(stage, element('div', { id: 'toast' })); append(stage, element('div', { id: 'announcement' }));
  const platform = {
    mode: options.mode || 'webos', catalogStatus: null,
    getCachedHome(ids) { requested.push(['cache', Array.from(ids)]); return (options.cached || []).filter(app => ids.includes(app.id)).map(app => ({ ...app })); },
    saveHomeCache(ids, apps) { cachedWrites.push({ ids: Array.from(ids), apps: JSON.parse(JSON.stringify(apps.filter(app => ids.includes(app.id)))) }); },
    setAppPriorities(ids, visible) { priorities.push({ ids: Array.from(ids), visible: Array.from(visible) }); },
    getApps(value) {
      request = value; requested.push(['live', rail.querySelectorAll('button').map(node => node.getAttribute('data-app'))]);
      frames.push(rail.innerHTML);
      return new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    },
    getNetwork() { return options.getNetwork ? options.getNetwork() : Promise.resolve({ available: true, kind: 'wifi', connected: true }); },
    openWifiSettings() { settingsCalls.push('wifi'); return options.openWifiSettings ? options.openWifiSettings() : Promise.resolve({ simulated: options.mode === 'browser' }); },
    openSettings() { settingsCalls.push('general'); return options.openSettings ? options.openSettings() : Promise.resolve({ simulated: options.mode === 'browser' }); },
    launchApp(id) { launches.push(id); return options.launchApp ? options.launchApp(id) : Promise.resolve({ embedded: true, url: 'https://catalog.example/current-zona' }); }
  };
  const window = element('window');
  Object.assign(window, { LauncherPlatform: platform, LauncherHomeState: homeState, LauncherWallpaper: require('../wallpaper'), LauncherMSXCatalog: require('../msx-catalog'), PalmSystem: { launchParams: options.launchParams }, innerWidth: 1920, innerHeight: 1080, setTimeout() { return 1; }, clearTimeout() {}, setInterval() {} });
  const context = vm.createContext({
    window, document, Promise, console,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { if (options.storageFails) throw Error('quota'); storage.set(key, value); writes.push({ key, value }); }
    }
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  return {
    document, rail, overlay, frames, requested, priorities, cachedWrites, storage, writes, launches, settingsCalls,
    buttons() { return rail.querySelectorAll('button'); },
    homeIds() { return this.buttons().map(node => node.getAttribute('data-app')); },
    focus(id) { const button = document.getElementById(id); assert.ok(button, id); button.focus(); return button; },
    click(id) { const target = this.focus(id); for (const fn of stage.listeners.click || []) fn({ target, preventDefault() {} }); },
    key(code, release = true) {
      for (const fn of document.listeners.keydown || []) fn({ keyCode: code, preventDefault() {} });
      if (release) this.release(code);
    },
    release(code = 13) { for (const fn of document.listeners.keyup || []) fn({ keyCode: code, preventDefault() {} }); },
    update(catalog, meta) { platform.catalogStatus = meta; request.onUpdate(catalog.map(app => ({ ...app })), meta); },
    resolve(catalog, meta) { platform.catalogStatus = meta; resolveRequest(catalog); },
    reject(error = Error('offline')) { rejectRequest(error); },
    relaunch(detail) { for (const fn of document.listeners.webOSRelaunch || []) fn({ detail }); },
    launch(detail) { for (const fn of document.listeners.webOSLaunch || []) fn({ detail }); },
    windowFocus() { for (const fn of window.listeners.focus || []) fn({}); }
  };
}
const zona = { id: 'msx:current-zona', name: 'Zona', brand: 'zona', source: 'msx' };
const complete = { nativeComplete: true, msxComplete: true, iconsOnly: false };
const nativeOnly = { nativeComplete: true, msxComplete: false, iconsOnly: false };
const turn = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('Холодный PalmSystem shortcut ждёт текущий каталог и открывает существующий портал', async () => {
  const h = harness({ launchParams: '{"shortcut":"zona"}' });
  assert.deepEqual(h.launches, []);
  assert.equal(h.requested.filter(item => item[0] === 'live').length, 1);
  h.update([{ id: 'de.benzac.msx', name: 'MSX' }], nativeOnly);
  assert.deepEqual(h.launches, [], 'native metadata must not resolve a missing MSX shortcut');
  h.update([zona], complete);
  assert.deepEqual(h.launches, [], 'even a complete callback must wait for the active read to settle');
  h.resolve([zona], complete);
  await turn();
  assert.deepEqual(h.launches, [zona.id]);
  assert.equal(h.overlay.className, 'overlay is-open portal-open');
  assert.ok(h.document.getElementById('msx-portal'));
  h.update([zona], complete);
  await turn();
  assert.deepEqual(h.launches, [zona.id], 'final Promise must not repeat progressive launch');
  h.key(461);
  assert.equal(h.overlay.hidden, true, 'Back returns from the existing portal');
});

test('Холодные параметры и webOSLaunch одной загрузки открывают Zona один раз', async () => {
  const h = harness({ launchParams: { shortcut: 'zona' } });
  h.update([zona], complete);
  h.resolve([zona], complete);
  await turn();
  h.launch({ shortcut: 'zona' });
  await turn();
  assert.deepEqual(h.launches, [zona.id]);
  assert.equal(h.overlay.className, 'overlay is-open portal-open');
});

test('webOSLaunch с параметрами работает без PalmSystem, включая строковый detail', async () => {
  const h = harness();
  h.launch('{"shortcut":"zona"}');
  h.resolve([zona], complete);
  await turn();
  assert.deepEqual(h.launches, [zona.id]);
});

test('Повторный запуск переходит к Zona из настроек, сохраняя избранное и настройки', async () => {
  const h = harness({ favorites: ['one'], cached: [{ id: 'one', name: 'One' }] });
  h.resolve([{ id: 'one', name: 'One' }, zona], complete);
  await turn();
  h.click('settings-button');
  const favorites = h.storage.get('lg-home-favorites-v1-webos');
  const settings = h.storage.get('lg-home-prototype-v1');
  h.relaunch({ shortcut: 'zona' });
  await turn();
  assert.deepEqual(h.launches, [zona.id]);
  assert.equal(h.overlay.className, 'overlay is-open portal-open');
  assert.equal(h.storage.get('lg-home-favorites-v1-webos'), favorites);
  assert.equal(h.storage.get('lg-home-prototype-v1'), settings);
});

test('Ожидающий relaunch использует начатую загрузку вместо конкурентного getApps', async () => {
  const h = harness();
  h.relaunch({ shortcut: 'zona' });
  h.launch({ shortcut: 'zona' });
  assert.equal(h.requested.filter(item => item[0] === 'live').length, 1);
  h.resolve([zona], complete);
  await turn();
  assert.deepEqual(h.launches, [zona.id]);
});

for (const action of ['home', 'back', 'settings', 'catalog', 'nativeHome']) {
  test('Пользовательская навигация отменяет ожидающую Zona: ' + action, async () => {
    const h = harness({ launchParams: { shortcut: 'zona' } });
    if (action === 'home') h.key(36);
    if (action === 'back') h.key(461);
    if (action === 'settings') h.click('settings-button');
    if (action === 'catalog') h.click('all-apps-button');
    if (action === 'nativeHome') h.relaunch({});
    h.resolve([zona], complete);
    await turn();
    assert.deepEqual(h.launches, []);
  });
}

test('Поздний Home {} не читает заново старые параметры PalmSystem', async () => {
  const h = harness({ launchParams: '{"shortcut":"zona"}' });
  h.resolve([zona], complete);
  await turn();
  assert.deepEqual(h.launches, [zona.id]);
  h.relaunch({});
  await turn();
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.document.getElementById('msx-portal'), null);
  assert.deepEqual(h.launches, [zona.id]);
  h.relaunch();
  await turn();
  assert.deepEqual(h.launches, [zona.id]);
});

test('Отсутствующая Zona показывает сообщение и не запускает произвольное приложение', async () => {
  const h = harness({ launchParams: { shortcut: 'zona' } });
  h.resolve([{ id: 'some.app', name: 'Zona lookalike' }], complete);
  await turn();
  assert.deepEqual(h.launches, []);
  assert.match(h.document.getElementById('toast').textContent, /Zona не найдена/);
  h.update([zona], complete);
  await turn();
  assert.deepEqual(h.launches, [], 'a completed missing shortcut must not launch hours later');
});

test('При недоступном каталоге используется существующая закэшированная Zona', async () => {
  const h = harness({ launchParams: { shortcut: 'zona' }, favorites: [zona.id], cached: [zona] });
  assert.deepEqual(h.launches, [], 'cache must not bypass an ongoing catalog read');
  h.reject();
  await turn();
  assert.deepEqual(h.launches, [zona.id]);
});

test('Недопустимые параметры и произвольные URL ничего не запускают', async () => {
  for (const params of [undefined, null, {}, 'bad JSON', [], { shortcut: 'https://evil.example' }, { appId: zona.id }, { url: 'https://evil.example' }, { shortcut: 'youtube' }, { shortcut: 'Zona' }]) {
    const h = harness({ launchParams: params });
    h.relaunch(params);
    h.resolve([zona], complete);
    await turn();
    assert.deepEqual(h.launches, [], JSON.stringify(params));
  }
  const h = harness({ launchParams: { shortcut: 'zona', url: 'https://evil.example', appId: 'evil.app' } });
  h.resolve([zona], complete);
  await turn();
  assert.deepEqual(h.launches, [zona.id], 'only the catalog ID may reach platform.launchApp');
});

test('В браузерном предпросмотре native параметры не действуют', async () => {
  const h = harness({ mode: 'browser', launchParams: { shortcut: 'zona' } });
  h.launch({ shortcut: 'zona' });
  h.relaunch({ shortcut: 'zona' });
  h.resolve([zona], complete);
  await turn();
  assert.deepEqual(h.launches, []);
});

test('OK на Wi-Fi открывает выбор сетей даже при недоступном статусе и возвращает фокус', async () => {
  let resolve;
  const h = harness({
    favorites: ['one'], cached: [{ id: 'one', name: 'One' }],
    getNetwork: () => Promise.reject(Error('network status unavailable')),
    openWifiSettings: () => new Promise(done => { resolve = done; })
  });
  await turn();
  const before = new Map(h.storage);
  h.focus('network-button');
  h.key(13);
  assert.deepEqual(h.settingsCalls, ['wifi']);
  assert.match(h.overlay.innerHTML, /Открываем список сетей/);
  assert.doesNotMatch(h.overlay.innerHTML, /Данные сети недоступны/);
  resolve({ simulated: false });
  await turn();
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.document.activeElement.id, 'network-button');
  assert.deepEqual(h.storage, before, 'opening Wi-Fi must preserve preferences');
});

test('Предпросмотр Wi-Fi объясняет выбор сети и не показывает имитацию реальных сетей', async () => {
  const h = harness({ mode: 'browser' });
  h.click('network-button');
  await turn();
  assert.deepEqual(h.settingsCalls, ['wifi']);
  assert.match(h.overlay.innerHTML, /Выберите сеть и введите пароль/);
  assert.equal(h.document.getElementById('network-settings'), null);
  h.key(461);
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.document.activeElement.id, 'network-button');
});

test('Ошибка Wi-Fi предлагает явный переход в настройки LG с сохранением фокуса', async () => {
  const h = harness({ openWifiSettings: () => Promise.reject(Error('<denied>')) });
  h.click('network-button');
  await turn();
  assert.match(h.overlay.innerHTML, /Не удалось открыть: &lt;denied&gt;/);
  assert.ok(h.document.getElementById('network-settings'));
  assert.deepEqual(h.settingsCalls, ['wifi'], 'fallback must wait for the user');
  h.click('network-settings');
  await turn();
  assert.deepEqual(h.settingsCalls, ['wifi', 'general']);
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.document.activeElement.id, 'network-button');
});

test('Back во время открытия Wi-Fi сохраняет последующую навигацию после позднего ответа', async () => {
  let resolve;
  const h = harness({ openWifiSettings: () => new Promise(done => { resolve = done; }) });
  h.click('network-button');
  h.key(461);
  assert.equal(h.document.activeElement.id, 'network-button');
  h.focus('all-apps-button');
  h.key(13);
  const catalog = h.overlay.innerHTML;
  resolve({ simulated: false });
  await turn();
  assert.equal(h.overlay.hidden, false);
  assert.equal(h.overlay.innerHTML, catalog);
});

test('Home во время открытия Wi-Fi не получает запоздалое сообщение об ошибке', async () => {
  let reject;
  const h = harness({ openWifiSettings: () => new Promise((done, fail) => { reject = fail; }) });
  h.click('network-button');
  h.key(36);
  reject(Error('late failure'));
  await turn();
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.overlay.innerHTML, '');
  assert.equal(h.document.getElementById('network-settings'), null);
});

test('После возврата из настроек обновляется статус сети и Wi-Fi можно открыть повторно', async () => {
  let kind = 'wifi';
  const h = harness({ getNetwork: () => Promise.resolve({ available: true, kind, connected: true }) });
  h.click('network-button');
  await turn();
  assert.equal(h.document.activeElement.id, 'network-button');
  kind = 'wired';
  h.windowFocus();
  await turn();
  assert.match(h.document.getElementById('network-button').getAttribute('aria-label'), /Сети Wi-Fi.*кабель/);
  assert.equal(h.document.activeElement.id, 'network-button');
  h.key(13);
  await turn();
  assert.deepEqual(h.settingsCalls, ['wifi', 'wifi']);
});

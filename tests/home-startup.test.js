'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homeState = require('../home-state');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Run the complete production bootstrap, progressive callbacks and remote logic.
// This DOM fixture only supplies browser primitives; selection/loading logic is
// production code. Geometry and Chromium 53 are also checked on the actual TV.
function harness(options = {}) {
  const writes = [], cachedWrites = [], priorities = [], frames = [], requested = [];
  const storage = new Map();
  if (options.favorites !== undefined) storage.set('lg-home-favorites-v1-webos', JSON.stringify(options.favorites));
  if (options.order) storage.set('lg-home-catalog-order-v1-webos', JSON.stringify(options.order));
  storage.set('lg-home-prototype-v1', JSON.stringify({ motion: 'off', hints: false }));
  let document, stage, request, resolveRequest;
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
    mode: 'webos', catalogStatus: null,
    getCachedHome(ids) { requested.push(['cache', Array.from(ids)]); return (options.cached || []).filter(app => ids.includes(app.id)).map(app => ({ ...app })); },
    saveHomeCache(ids, apps) { cachedWrites.push({ ids: Array.from(ids), apps: JSON.parse(JSON.stringify(apps.filter(app => ids.includes(app.id)))) }); },
    setAppPriorities(ids, visible) { priorities.push({ ids: Array.from(ids), visible: Array.from(visible) }); },
    getApps(value) {
      request = value; requested.push(['live', rail.querySelectorAll('button').map(node => node.getAttribute('data-app'))]);
      frames.push(rail.innerHTML);
      return new Promise(resolve => { resolveRequest = resolve; });
    },
    getNetwork() { return Promise.resolve({ available: true, kind: 'wifi', connected: true }); },
    launchApp(id) { return Promise.resolve({ simulated: true, id }); }
  };
  const window = element('window');
  Object.assign(window, { LauncherPlatform: platform, LauncherHomeState: homeState, LauncherWallpaper: require('../wallpaper'), innerWidth: 1920, innerHeight: 1080, setTimeout() { return 1; }, clearTimeout() {}, setInterval() {} });
  const context = vm.createContext({
    window, document, Promise, console,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { if (options.storageFails) throw Error('quota'); storage.set(key, value); writes.push({ key, value }); }
    }
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  return {
    document, rail, overlay, frames, requested, priorities, cachedWrites, storage, writes,
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
    relaunch() { for (const fn of document.listeners.webOSRelaunch || []) fn({}); }
  };
}
const native = (extra = {}) => ({ nativeComplete: true, msxComplete: false, iconsOnly: false, ...extra });
const complete = (extra = {}) => ({ nativeComplete: true, msxComplete: true, iconsOnly: false, ...extra });

test('Ранние native-метаданные не загружают запрещённый file:// значок; PNG обновляет ту же карточку', () => {
  const raw = { id: 'vendor.app', name: 'Моё приложение', icon: '/media/cryptofs/apps/usr/palm/applications/vendor.app/icon.png' };
  const h = harness({ favorites: [raw.id], cached: [raw] });
  const button = h.document.getElementById('home-app-0');
  assert.equal(button.querySelector('img'), null);
  assert.ok(button.querySelector('.generic-logo'));
  assert.equal(button.getAttribute('title'), 'Моё приложение');
  const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../assets/app-icon.png')).toString('base64');
  h.update([{ ...raw, icon }], complete({ iconsOnly: true }));
  assert.equal(h.document.getElementById('home-app-0'), button);
  assert.equal(button.querySelector('img').getAttribute('src'), icon);
});
const records = ids => ids.map(id => ({ id, name: 'App ' + id }));
const turn = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

for (const ids of [[], ['a'], ['a', 'b', 'c', 'd', 'e', 'f']]) {
  test('Cache-first: ' + ids.length + ' выбранных карточек видны до ответа LS2/MSX, каталог доступен', () => {
    const h = harness({ favorites: ids, cached: records(ids), order: ['unseen', ...ids] });
    assert.deepEqual(h.homeIds(), ids);
    assert.deepEqual(h.requested, [['cache', ids], ['live', ids]]);
    assert.equal(h.storage.get('lg-home-catalog-order-v1-webos'), JSON.stringify(['unseen', ...ids]));
    assert.equal(h.writes.length, 0, 'Bootstrap cache must not prune/persist a partial catalogue');
    assert.ok(h.document.getElementById('all-apps-button'));
    assert.equal(h.document.getElementById('home-app-' + ids.length), null, 'No phantom All apps tile');
    assert.equal(h.document.activeElement.id, ids.length ? 'home-app-0' : 'all-apps-button');
    assert.deepEqual(h.priorities[0], { ids, visible: [] });
  });
}

test('Старые пять сохраняются без автоматического заполнения шестого; явно пустой выбор остаётся пустым', () => {
  for (const ids of [[], ['a', 'b', 'c', 'd', 'e']]) {
    const h = harness({ favorites: ids, cached: records(ids) });
    h.update(records(['a', 'b', 'c', 'd', 'e', 'f', 'g']), complete());
    assert.deepEqual(h.homeIds(), ids);
    assert.deepEqual(JSON.parse(h.storage.get('lg-home-favorites-v1-webos')), ids);
  }
});

test('Сохранённый выбор сильнее устаревшего порядка кэша после quota failure', () => {
  const h = harness({ favorites: ['c', 'a'], cached: records(['a', 'b', 'c']), storageFails: true });
  assert.deepEqual(h.homeIds(), ['c', 'a']);
  h.update(records(['a', 'b', 'c']), complete({ iconsOnly: true }));
  assert.deepEqual(h.homeIds(), ['c', 'a']);
  assert.deepEqual(h.cachedWrites.at(-1).ids, ['c', 'a']);
});

test('Первая установка не выбирает случайный кэш и получает defaults только из успешного native каталога', () => {
  const h = harness({ cached: records(['stale']) });
  assert.deepEqual(h.homeIds(), []);
  h.update(records(['msx:pending']), { nativeComplete: false, msxComplete: false });
  assert.deepEqual(h.homeIds(), []);
  h.update(records(['a', 'b', 'c', 'd', 'e', 'f', 'g']), complete());
  assert.deepEqual(h.homeIds(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('Native раньше MSX: сохраняются виртуальная карточка и неполученная база MSX; удаление подтверждается своим источником', () => {
  const h = harness({ favorites: ['a', 'msx:zona'], cached: records(['a', 'msx:zona']), order: ['old.native', 'msx:unseen', 'a', 'msx:zona'] });
  h.update(records(['a', 'b']), native());
  assert.deepEqual(h.homeIds(), ['a', 'msx:zona']);
  assert.deepEqual(JSON.parse(h.storage.get('lg-home-catalog-order-v1-webos')), ['msx:unseen', 'a', 'msx:zona', 'b']);
  h.update(records(['a', 'b']), complete());
  assert.deepEqual(h.homeIds(), ['a']);
  assert.deepEqual(JSON.parse(h.storage.get('lg-home-favorites-v1-webos')), ['a']);
  assert.deepEqual(JSON.parse(h.storage.get('lg-home-catalog-order-v1-webos')), ['a', 'b']);
});

test('Поздний callback использует последнее закрепление; добавление/удаление/замена шести обновляют cache и приоритет', () => {
  const h = harness({ favorites: ['a', 'b', 'c', 'd', 'e'], cached: records(['a', 'b', 'c', 'd', 'e']) });
  const apps = records(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  h.update(apps, complete());
  h.click('all-apps-button');
  h.focus('grid-app-5'); h.key(406); h.click('context-pin');
  assert.deepEqual(h.homeIds(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(h.cachedWrites.at(-1).ids, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(h.priorities.at(-1).ids, ['a', 'b', 'c', 'd', 'e', 'f']);
  h.focus('grid-app-6'); h.key(406); h.click('context-pin');
  assert.equal(h.overlay.querySelectorAll('button[data-replace-index]').length, 6);
  h.click('replace-slot-1');
  assert.deepEqual(h.homeIds(), ['a', 'g', 'c', 'd', 'e', 'f']);
  h.update(apps.map(app => ({ ...app, icon: 'assets/tv-apps/' + app.id + '.png' })), complete({ iconsOnly: true }));
  assert.deepEqual(h.homeIds(), ['a', 'g', 'c', 'd', 'e', 'f']);
  assert.deepEqual(h.cachedWrites.at(-1).ids, ['a', 'g', 'c', 'd', 'e', 'f']);
  h.focus('grid-app-1'); h.key(406); h.click('context-pin');
  assert.deepEqual(h.homeIds(), ['a', 'c', 'd', 'e', 'f']);
  assert.deepEqual(h.cachedWrites.at(-1).ids, ['a', 'c', 'd', 'e', 'f']);
});

test('Главные карточки образуют карусель в обе стороны при фактическом количестве приложений', () => {
  for (const count of [1, 2, 5, 6]) {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, count);
    const h = harness({ favorites: ids, cached: records(ids) });
    const before = Array.from(h.storage);
    h.focus('home-app-0');
    h.key(37);
    assert.equal(h.document.activeElement.id, 'home-app-' + (count - 1));
    h.key(39);
    assert.equal(h.document.activeElement.id, 'home-app-0');
    // Repeated keydown also represents holding a remote arrow across an edge.
    for (const id of ids.slice(1).concat(ids, ids[0])) {
      h.key(39, false);
      assert.equal(h.document.activeElement.getAttribute('data-app'), id);
    }
    h.release(39);
    const reverse = ids.slice().reverse();
    for (const id of reverse.concat(reverse)) {
      h.key(37, false);
      assert.equal(h.document.activeElement.getAttribute('data-app'), id);
    }
    h.release(37);
    assert.deepEqual(h.homeIds(), ids);
    assert.deepEqual(Array.from(h.storage), before, 'Навигация не меняет карточки и настройки');
  }
});

test('Три кнопки header доступны Left/Right, Down возвращает выбранную карточку, Back из каталога — к новой кнопке', () => {
  const h = harness({ favorites: ['a', 'b', 'c', 'd', 'e', 'f'], cached: records(['a', 'b', 'c', 'd', 'e', 'f']) });
  h.focus('home-app-5');
  h.key(38); assert.equal(h.document.activeElement.id, 'all-apps-button');
  h.key(39); assert.equal(h.document.activeElement.id, 'network-button');
  h.key(39); assert.equal(h.document.activeElement.id, 'settings-button');
  h.key(39); assert.equal(h.document.activeElement.id, 'settings-button');
  h.key(37); h.key(37); assert.equal(h.document.activeElement.id, 'all-apps-button');
  h.key(40); assert.equal(h.document.activeElement.id, 'home-app-5');
  h.click('all-apps-button'); h.key(461);
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.document.activeElement.id, 'all-apps-button');
});

test('Пустой главный экран: вся верхняя навигация и каталог работают без home-app-0', () => {
  const h = harness({ favorites: [] });
  h.key(39); h.key(39); assert.equal(h.document.activeElement.id, 'settings-button');
  h.key(40); assert.equal(h.document.activeElement.id, 'all-apps-button');
  h.click('all-apps-button'); h.key(461);
  assert.equal(h.document.activeElement.id, 'all-apps-button');
});

test('Значок обновляется в существующем button; под удержанием замена ждёт release', () => {
  const h = harness({ favorites: ['a'], cached: records(['a']) });
  h.update(records(['a', 'b']), complete());
  const button = h.focus('home-app-0');
  h.update([{ id: 'a', name: 'App a', icon: 'assets/tv-apps/a.png' }, { id: 'b', name: 'App b' }], complete({ iconsOnly: true }));
  assert.equal(h.document.getElementById('home-app-0'), button);
  assert.equal(h.document.activeElement, button);
  assert.match(button.innerHTML, /assets\/tv-apps\/a.png/);
  h.key(13, false);
  const before = button.innerHTML;
  h.update([{ id: 'a', name: 'App a', icon: 'assets/tv-apps/a-new.png' }, { id: 'b', name: 'App b' }], complete({ iconsOnly: true }));
  assert.equal(button.innerHTML, before);
  h.release();
  assert.equal(h.document.activeElement.id, 'launch-back');
  assert.equal(h.document.getElementById('home-app-0'), button, 'Open launch dialog holds queued changes');
  h.key(461);
  assert.match(h.document.getElementById('home-app-0').innerHTML, /a-new.png/);
});

test('Неизменные SVG и уже показанный src не пересобираются при постороннем icon callback', () => {
  const apps = [{ id: 'youtube', name: 'YouTube', brand: 'youtube' }, { id: 'a', name: 'App a', icon: 'assets/tv-apps/a.png' }];
  const h = harness({ favorites: ['youtube', 'a'], cached: apps });
  const first = h.document.getElementById('home-app-0');
  const second = h.document.getElementById('home-app-1');
  second.querySelector('.installed-app-name').textContent = 'App a';
  const html = [first.innerHTML, second.innerHTML];
  h.update(apps, complete({ iconsOnly: true }));
  assert.equal(first.innerHTML, html[0], 'Local SVG stays intact regardless of browser serialization');
  assert.equal(second.innerHTML, html[1], 'Same icon src/name needs no innerHTML assignment');
});

test('Поздний iconsOnly callback с накопленным новым приложением не теряет структурную отрисовку', () => {
  const h = harness({ favorites: ['a'], cached: records(['a']) });
  h.click('all-apps-button'); h.focus('grid-app-0'); h.key(406);
  h.update(records(['a', 'b']), complete());
  h.update([{ id: 'a', name: 'App a', icon: 'assets/tv-apps/a.png' }, { id: 'b', name: 'App b' }], complete({ iconsOnly: true }));
  assert.equal(h.document.getElementById('grid-app-1'), null);
  h.key(461);
  assert.equal(h.document.getElementById('grid-app-1').getAttribute('data-app'), 'b');
});

test('Очередь rename/brand → PNG обновляет текст, title, aria-label и оформление, не мутируя метаданные платформы', () => {
  const before = { id: 'a', name: 'Старое имя', brand: 'kinopoisk', source: 'native' };
  const after = { id: 'a', name: 'Новое имя', brand: 'wink', source: 'native' };
  const h = harness({ favorites: ['a'], cached: [before] });
  h.click('all-apps-button'); h.focus('grid-app-0'); h.key(406);
  const full = Object.freeze(complete());
  const png = Object.freeze(complete({ iconsOnly: true }));
  h.update([after], full);
  h.update([{ ...after, icon: 'assets/tv-apps/a.png' }], png);
  assert.equal(png.iconsOnly, true);
  assert.equal(full.iconsOnly, false);
  h.key(461);
  for (const id of ['home-app-0', 'grid-app-0']) {
    const button = h.document.getElementById(id);
    assert.equal(button.getAttribute('title'), 'Новое имя');
    assert.match(button.getAttribute('aria-label'), /^Новое имя(?:,|$)/);
    assert.equal(button.classList.contains('brand-wink'), true);
    assert.equal(button.classList.contains('brand-kinopoisk'), false);
    assert.ok(button.querySelector('.installed-app-name'));
  }
});

test('Icon-only путь также замечает изменения name/brand/source для того же ID', () => {
  const h = harness({ favorites: ['a'], cached: [{ id: 'a', name: 'Старое имя', brand: 'kinopoisk' }] });
  h.update([{ id: 'a', name: 'Новое имя', brand: 'wink', source: 'native', icon: 'assets/tv-apps/a.png' }], complete({ iconsOnly: true }));
  const button = h.document.getElementById('home-app-0');
  assert.equal(button.getAttribute('title'), 'Новое имя');
  assert.equal(button.getAttribute('aria-label'), 'Новое имя');
  assert.equal(button.classList.contains('brand-wink'), true);
});

for (const total of [18, 19, 36, 37]) {
  test('Каталог ' + total + ': 3×6, pinned первая строка, перелистывание и приоритет видимой страницы', () => {
    const ids = Array.from({ length: total }, (_, i) => 'a' + i);
    const pins = ids.slice(0, 6).reverse();
    const h = harness({ favorites: pins, cached: records(pins), order: ids });
    h.update(records(ids), complete()); h.click('all-apps-button');
    assert.equal(h.overlay.querySelectorAll('button[data-grid-index]').length, 18);
    assert.deepEqual(h.overlay.querySelectorAll('button[data-grid-index]').slice(0, 6).map(node => node.getAttribute('data-app')), pins);
    assert.equal(h.priorities.at(-1).visible.length, 18);
    h.focus('grid-app-5'); h.key(39);
    if (total > 18) {
      assert.equal(h.document.activeElement.id, 'grid-app-18');
      assert.equal(h.overlay.querySelectorAll('button[data-grid-index]').length, Math.min(18, total - 18));
      assert.equal(h.priorities.at(-1).visible.length, Math.min(18, total - 18));
      h.key(37); assert.equal(h.document.activeElement.id, 'grid-app-5');
    } else assert.equal(h.document.activeElement.id, 'grid-app-5');
  });
}

test('Переполнение хранилища не меняет закрепления и не сохраняет неудавшийся выбор в кэш', () => {
  const h = harness({ favorites: ['a', 'b'], cached: records(['a', 'b']), storageFails: true });
  h.click('all-apps-button'); h.focus('grid-app-0'); h.key(406); h.click('context-pin');
  assert.deepEqual(h.homeIds(), ['a', 'b']);
  assert.deepEqual(JSON.parse(h.storage.get('lg-home-favorites-v1-webos')), ['a', 'b']);
  assert.equal(h.cachedWrites.length, 0);
});

test('Перестановка шести карточек обновляет кэш только после OK; Отмена сохраняет предыдущий порядок', () => {
  const pins = ['a', 'b', 'c', 'd', 'e', 'f'];
  const h = harness({ favorites: pins, cached: records(pins) });
  h.click('all-apps-button'); h.focus('grid-app-5'); h.key(406); h.click('context-move');
  for (let i = 0; i < 5; i++) h.key(37);
  assert.equal(h.cachedWrites.length, 0);
  h.key(40); h.click('reorder-save');
  assert.deepEqual(h.homeIds(), ['f', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(h.cachedWrites.at(-1).ids, ['f', 'a', 'b', 'c', 'd', 'e']);
  const savedCount = h.cachedWrites.length;
  h.focus('grid-app-0'); h.key(406); h.click('context-move');
  h.key(39); h.key(40); h.click('reorder-back');
  assert.deepEqual(h.homeIds(), ['f', 'a', 'b', 'c', 'd', 'e']);
  assert.equal(h.cachedWrites.length, savedCount);
});

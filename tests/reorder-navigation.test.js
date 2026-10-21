'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homeState = require('../home-state');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function region(first, after) {
  const start = source.indexOf(first);
  const end = source.indexOf(after, start);
  assert.ok(start >= 0 && end > start, 'Production region must remain identifiable: ' + first);
  return source.slice(start, end);
}
const resize = "  window.addEventListener('resize', fitStage);";
// Run the production navigation, editing actions, persistence boundary and input
// listeners together. Only rendering and unrelated platform effects are stubbed.
const script = new vm.Script([
  region('  function homeApps()', '  function focusId(id)'),
  region('  function focusId(id)', '  function notify(text)'),
  region('  function catalogApps()', '  function restoreSettings()'),
  region('  function closeView()', '  function changePage('),
  region('  function onAction(button)', '  function fullscreen()'),
  region('  function cancelPress()', resize),
  resize
].join('\n'), { filename: 'app.js:reorder-navigation' });

function harness(options = {}) {
  let context;
  let now = 10000;
  const writes = [];
  const notices = [];
  const original = options.six ? ['a', 'b', 'c', 'd', 'e', 'f'] : ['a', 'b', 'c', 'd', 'e'];
  const selected = options.selected || 'b';

  function node(tagName, id, attrs = {}, rect = { left: 0, top: 0, width: 100, height: 80 }) {
    const classes = new Set();
    return {
      tagName, id: id || '', parentNode: null, children: [], style: {}, hidden: false, disabled: false,
      listeners: new Map(),
      classList: {
        add(value) { classes.add(value); },
        remove(value) { classes.delete(value); },
        contains(value) { return classes.has(value); },
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); }
      },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
      setAttribute(name, value) { attrs[name] = String(value); },
      removeAttribute(name) { delete attrs[name]; },
      addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
      },
      contains(child) {
        while (child) { if (child === this) return true; child = child.parentNode; }
        return false;
      },
      querySelectorAll(selector) {
        const matches = [];
        function visit(parent) {
          for (const child of parent.children) {
            if (selector === 'button' && child.tagName === 'BUTTON' ||
                /^\[[\w-]+\]$/.test(selector) && child.getAttribute(selector.slice(1, -1)) !== null ||
                selector.charAt(0) === '.' && child.classList.contains(selector.slice(1))) matches.push(child);
            visit(child);
          }
        }
        visit(this);
        return matches;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      getBoundingClientRect() { return Object.assign({}, rect); },
      focus() { document.activeElement = this; }
    };
  }
  function append(parent, child) { child.parentNode = parent; parent.children.push(child); return child; }

  const window = node('WINDOW');
  const document = node('DOCUMENT');
  const stage = append(document, node('MAIN', 'stage'));
  const home = append(stage, node('SECTION', 'home'));
  const rail = append(home, node('DIV', 'home-rail'));
  const overlay = append(stage, node('SECTION', 'overlay'));
  const announcement = append(stage, node('DIV', 'announcement'));
  const headerBack = append(overlay, node('BUTTON', 'view-back', { 'data-action': 'back' }, { left: 1733, top: 83, width: 82, height: 82 }));
  const cards = {};
  original.forEach((id, index) => {
    const tile = append(overlay, node('DIV', '', { 'data-order-app': id }));
    const number = append(tile, node('SPAN'));
    number.classList.add('slot-number');
    number.textContent = String(index + 1);
    cards[id] = append(tile, node('BUTTON', 'reorder-slot-' + index, { 'data-app': id, 'data-reorder-index': String(index) },
      { left: 168 + index * 298, top: 410, width: 264, height: 300 }));
    append(home, node('BUTTON', 'home-app-' + index, { 'data-app': id }));
  });
  const controlIds = ['reorder-left', 'reorder-save', 'reorder-right', 'reorder-back'];
  const actions = ['move-left', 'save-order', 'move-right', 'back'];
  const controls = controlIds.map((id, index) => append(overlay, node('BUTTON', id, { 'data-action': actions[index] },
    { left: 600 + index * 150, top: 860, width: 130, height: 80 })));
  document.activeElement = cards[selected];
  document.hidden = false;
  document.getElementById = function (id) {
    if (id === 'stage') return stage;
    return document.querySelectorAll('button').concat([announcement, home, overlay, rail]).find(el => el.id === id) || null;
  };
  window.setTimeout = function () { return 1; };
  window.clearTimeout = function () {};
  context = vm.createContext({
    window, document, stage, home, rail, overlay, homeState,
    Date: { now() { return now; } },
    view: 'reorder', viewData: { appId: selected, order: original.slice() },
    stack: [
      { name: 'home', focus: 'home-app-' + original.indexOf(selected), appId: selected },
      { name: 'context', data: { appId: selected }, focus: 'context-move' }
    ],
    viewRevision: 0, press: null, enterDown: false, pointerDown: false,
    pointerConsumed: false, suppressClickUntil: 0,
    lastHomeIndex: original.indexOf(selected), lastHeaderId: 'settings-button',
    favorites: original.slice(), savedFavorites: original.slice(), favoritesKey: 'test-favorites',
    apps: original.map(id => ({ id, name: id })), catalogOrder: original.slice(),
    platform: { mode: 'webos' },
    localStorage: { setItem(key, value) { if (options.storageFails) throw new Error('full'); writes.push({ key, value }); } },
    notify(message) { notices.push(message); },
    renderHome() {}, renderView() {}, flushCatalog() {}, loadApps() {},
    refreshNetwork() { return Promise.resolve(); }, fitStage() {}, fullscreen() {},
    findApp(id) { return original.includes(id) ? { id, name: id } : null; }
  });
  script.runInContext(context);
  function keydown(keyCode, properties = {}) {
    const event = Object.assign({ keyCode, repeat: false, preventDefault() {} }, properties);
    for (const listener of document.listeners.get('keydown') || []) listener(event);
  }
  function keyup(keyCode) {
    for (const listener of document.listeners.get('keyup') || []) listener({ keyCode, preventDefault() {} });
  }
  return {
    cards, controls, headerBack, document, context, writes, notices,
    keydown,
    arrow(keyCode) { keydown(keyCode); keyup(keyCode); },
    ok() { keydown(13); now += 80; keyup(13); },
    draft() { return Array.from(context.viewData.order); },
    favorites() { return Array.from(context.favorites); },
    savedFavorites() { return Array.from(context.savedFavorites); }
  };
}

test('Left/Right на карточке меняют только черновик, сохраняя фокус и исходные DOM id', () => {
  const h = harness();
  h.arrow(39);
  assert.deepEqual(h.draft(), ['a', 'c', 'b', 'd', 'e']);
  assert.equal(h.document.activeElement, h.cards.b);
  assert.equal(h.cards.b.id, 'reorder-slot-1');
  assert.equal(h.cards.b.getAttribute('data-reorder-index'), '2');
  assert.equal(h.cards.c.getAttribute('data-reorder-index'), '1');
  assert.deepEqual(h.favorites(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(h.writes, []);
  h.arrow(37);
  assert.deepEqual(h.draft(), ['a', 'b', 'c', 'd', 'e']);
});

test('Down с карточки открывает ряд действий; все четыре кнопки достижимы стрелками без перестановки', () => {
  const h = harness();
  h.arrow(40);
  assert.equal(h.document.activeElement.id, 'reorder-save');
  h.arrow(37);
  assert.equal(h.document.activeElement.id, 'reorder-left');
  h.arrow(37);
  assert.equal(h.document.activeElement.id, 'reorder-left');
  for (const id of ['reorder-save', 'reorder-right', 'reorder-back']) {
    h.arrow(39);
    assert.equal(h.document.activeElement.id, id);
  }
  h.arrow(39);
  assert.equal(h.document.activeElement.id, 'reorder-back');
  h.arrow(40);
  assert.equal(h.document.activeElement.id, 'reorder-back');
  assert.deepEqual(h.draft(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(h.writes, []);
});

for (const control of ['reorder-left', 'reorder-save', 'reorder-right', 'reorder-back']) {
  test('Up из ' + control + ' возвращает выбранное приложение после изменения индекса', () => {
    const h = harness();
    h.arrow(39);
    h.arrow(39);
    h.controls.find(button => button.id === control).focus();
    h.arrow(38);
    assert.equal(h.document.activeElement, h.cards.b);
    assert.equal(h.document.activeElement.id, 'reorder-slot-1');
    assert.equal(h.document.activeElement.getAttribute('data-reorder-index'), '3');
    assert.deepEqual(h.draft(), ['a', 'c', 'd', 'b', 'e']);
    assert.deepEqual(h.favorites(), ['a', 'b', 'c', 'd', 'e']);
  });
}

test('Из верхней кнопки Назад Down возвращает выбранную перемещаемую карточку', () => {
  const h = harness();
  h.arrow(39);
  h.arrow(38);
  assert.equal(h.document.activeElement, h.headerBack);
  h.arrow(40);
  assert.equal(h.document.activeElement, h.cards.b);
  assert.equal(h.cards.b.getAttribute('data-reorder-index'), '2');
});

test('OK на кнопках передвижения выполняет действие, стрелки между ними лишь перемещают фокус', () => {
  const h = harness();
  h.arrow(40);
  h.arrow(39);
  h.ok();
  assert.deepEqual(h.draft(), ['a', 'c', 'b', 'd', 'e']);
  assert.equal(h.document.activeElement.id, 'reorder-right');
  h.arrow(37);
  h.arrow(37);
  assert.deepEqual(h.draft(), ['a', 'c', 'b', 'd', 'e']);
  h.ok();
  assert.deepEqual(h.draft(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(h.favorites(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(h.writes, []);
});

for (const saveWith of ['card', 'button']) {
  test('OK на ' + saveWith + ' сохраняет выбранный порядок один раз и возвращает домой', () => {
    const h = harness();
    h.arrow(39);
    if (saveWith === 'button') h.arrow(40);
    h.ok();
    assert.deepEqual(h.favorites(), ['a', 'c', 'b', 'd', 'e']);
    assert.deepEqual(h.savedFavorites(), ['a', 'c', 'b', 'd', 'e']);
    assert.deepEqual(h.writes, [{ key: 'test-favorites', value: '["a","c","b","d","e"]' }]);
    assert.equal(h.context.view, 'home');
    assert.equal(h.document.activeElement.id, 'home-app-2');
  });
}

test('Отмена достижима через Down/Right/Right и закрывает изменённый черновик без записи избранного', () => {
  const h = harness();
  h.arrow(39);
  h.arrow(40);
  h.arrow(39);
  h.arrow(39);
  assert.equal(h.document.activeElement.id, 'reorder-back');
  h.ok();
  assert.equal(h.context.view, 'context');
  assert.deepEqual(h.favorites(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(h.savedFavorites(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(h.writes, []);
});

test('Физическая Назад отменяет изменённый черновик без записи избранного', () => {
  const h = harness();
  h.arrow(39);
  h.arrow(40);
  h.keydown(461);
  assert.equal(h.context.view, 'context');
  assert.deepEqual(h.favorites(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(h.writes, []);
});

test('Неудачное сохранение оставляет черновик открытым и избранное без изменений', () => {
  const h = harness({ storageFails: true });
  h.arrow(39);
  h.arrow(40);
  h.ok();
  assert.equal(h.context.view, 'reorder');
  assert.deepEqual(h.draft(), ['a', 'c', 'b', 'd', 'e']);
  assert.deepEqual(h.favorites(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(h.writes, []);
  assert.match(h.notices[0], /Не удалось сохранить/);
});

test('Шестая карточка переставляется к первой и сохраняется; отмена другого черновика не пишет выбор', () => {
  const saved = harness({ six: true, selected: 'f' });
  for (let i = 0; i < 5; i++) saved.arrow(37);
  assert.deepEqual(saved.draft(), ['f', 'a', 'b', 'c', 'd', 'e']);
  saved.arrow(40);
  saved.ok();
  assert.deepEqual(saved.favorites(), ['f', 'a', 'b', 'c', 'd', 'e']);
  assert.equal(saved.document.activeElement.id, 'home-app-0');
  const cancelled = harness({ six: true, selected: 'f' });
  cancelled.arrow(37); cancelled.arrow(40); cancelled.arrow(39); cancelled.arrow(39); cancelled.ok();
  assert.deepEqual(cancelled.favorites(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(cancelled.writes, []);
});

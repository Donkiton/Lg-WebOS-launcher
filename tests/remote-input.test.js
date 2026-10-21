'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the registered production listeners, without bootstrapping the app or
// replacing its press logic with a second implementation in this test.
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('  function cancelPress() {');
const endMarker = "  window.addEventListener('resize', fitStage);";
const end = source.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'Production remote-input listener region must remain identifiable');
const listenerScript = new vm.Script(source.slice(start, end + endMarker.length), { filename: 'app.js:remote-input' });

function harness() {
  let now = 10000;
  let timerId = 0;
  const timers = new Map();
  const actions = [];
  const menus = [];
  let context;

  function target(tagName, id, attrs) {
    const listeners = new Map();
    const classes = new Set();
    return {
      tagName,
      id: id || '',
      parentNode: null,
      hidden: false,
      classList: {
        add(value) { classes.add(value); },
        remove(value) { classes.delete(value); },
        contains(value) { return classes.has(value); },
        toggle(value, enabled) {
          if (enabled === undefined) enabled = !classes.has(value);
          if (enabled) classes.add(value); else classes.delete(value);
          return enabled;
        }
      },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs || {}, name) ? attrs[name] : null; },
      addEventListener(type, listener, capture) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ listener, capture: capture === true });
      },
      contains(node) {
        while (node) {
          if (node === this) return true;
          node = node.parentNode;
        }
        return false;
      },
      querySelectorAll() { return []; },
      focus() { document.activeElement = this; },
      listeners
    };
  }

  const window = target('WINDOW');
  const document = target('DOCUMENT');
  const stage = target('MAIN', 'stage');
  const home = target('SECTION', 'home');
  const overlay = target('SECTION', 'overlay');
  const rail = target('DIV', 'home-rail');
  const card = target('BUTTON', 'grid-app-0', { 'data-app': 'installed.first', 'data-action': 'launch' });
  const other = target('BUTTON', 'grid-app-1', { 'data-app': 'installed.second', 'data-action': 'launch' });
  const outside = target('DIV', 'outside');
  const menu = target('BUTTON', 'context-open', { 'data-action': 'context-open' });
  document.parentNode = window;
  stage.parentNode = document;
  home.parentNode = stage;
  overlay.parentNode = stage;
  rail.parentNode = home;
  card.parentNode = overlay;
  other.parentNode = overlay;
  outside.parentNode = document;
  document.activeElement = card;
  document.hidden = false;

  window.setTimeout = function (callback, delay) {
    const id = ++timerId;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  window.clearTimeout = function (id) { timers.delete(id); };

  function closestButton(node) {
    while (node && node !== stage) {
      if (node.tagName === 'BUTTON') return node;
      node = node.parentNode;
    }
    return null;
  }

  context = vm.createContext({
    window, document, stage, home, overlay, rail,
    Date: { now() { return now; } },
    view: 'apps',
    press: null,
    enterDown: false,
    pointerDown: false,
    pointerConsumed: false,
    suppressClickUntil: 0,
    lastHomeIndex: 0,
    lastHeaderId: 'settings-button',
    platform: { mode: 'webos' },
    closestButton,
    findApp(id) { return /^installed\.(first|second)$/.test(id || '') ? { id } : null; },
    onAction(button) { actions.push(button.id); },
    openContext(button) {
      context.cancelPress();
      menus.push(button.id);
      context.view = 'context';
      // renderView replaces the old grid and focuses the first context action.
      card.parentNode = null;
      other.parentNode = null;
      menu.parentNode = overlay;
      menu.focus();
    },
    closeView() { context.cancelPress(); context.view = 'home'; },
    goHome() { context.cancelPress(); context.view = 'home'; },
    moveFocus() { other.focus(); },
    moveCard() {},
    visibleButtons() { return context.view === 'context' ? [menu] : [card, other]; },
    fullscreen() {},
    flushCatalog() {},
    loadApps() {},
    refreshNetwork() { return Promise.resolve(); },
    fitStage() {}
  });
  listenerScript.runInContext(context);

  function emit(type, eventTarget, properties, dispatchTarget) {
    const event = Object.assign({
      type, target: eventTarget, button: 0, keyCode: 0, repeat: false,
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }
    }, properties);
    const route = [];
    let node = dispatchTarget || eventTarget;
    while (node) { route.push(node); node = node.parentNode; }
    for (const current of route.slice().reverse()) {
      for (const entry of current.listeners.get(type) || []) {
        if (entry.capture) entry.listener(event);
      }
    }
    for (const current of route) {
      for (const entry of current.listeners.get(type) || []) {
        if (!entry.capture) entry.listener(event);
      }
      if (event.stopped) break;
    }
    return event;
  }

  function advance(milliseconds, runTimers = true) {
    const until = now + milliseconds;
    if (runTimers) {
      for (;;) {
        const pending = Array.from(timers).filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!pending) break;
        timers.delete(pending[0]);
        now = Math.max(now, pending[1].at);
        pending[1].callback();
      }
    }
    now = until;
  }

  return {
    actions, menus, card, other, outside, menu, stage, document,
    advance,
    keydown(code = 13, properties) { return emit('keydown', document.activeElement, Object.assign({ keyCode: code }, properties), document); },
    keyup(code = 13) { return emit('keyup', document.activeElement, { keyCode: code }, document); },
    mousedown(button = card) { return emit('mousedown', button); },
    mouseup(button = card) { return emit('mouseup', button); },
    click(button = card) { return emit('click', button); },
    blur() { return emit('blur', window); },
    hide() { document.hidden = true; return emit('visibilitychange', document); },
    leave() { return emit('mouseleave', stage); }
  };
}

for (const kind of ['keyboard', 'mouse']) {
  test('Синтетический click во время удержания ' + kind + ' не запускает карточку', () => {
    const h = harness();
    if (kind === 'keyboard') h.keydown(); else h.mousedown();
    h.advance(250);
    h.click();
    assert.deepEqual(h.actions, []);
    assert.deepEqual(h.menus, []);
    h.advance(450);
    assert.deepEqual(h.menus, ['grid-app-0']);
    assert.deepEqual(h.actions, []);
  });

  test('Короткий ' + kind + ' активирует ровно один раз вместе с accompanying click', () => {
    const h = harness();
    if (kind === 'keyboard') h.keydown(); else h.mousedown();
    h.advance(100);
    if (kind === 'keyboard') h.keyup(); else h.mouseup();
    h.click();
    assert.deepEqual(h.actions, ['grid-app-0']);
    h.advance(1000);
    assert.deepEqual(h.menus, []);
  });

  test('Повторные down ' + kind + ' не продлевают порог удержания 700 мс', () => {
    const h = harness();
    if (kind === 'keyboard') h.keydown(); else h.mousedown();
    h.advance(300);
    if (kind === 'keyboard') h.keydown(13, { repeat: true }); else h.mousedown();
    h.advance(250);
    if (kind === 'keyboard') h.keydown(13, { repeat: false }); else h.mousedown();
    h.advance(149);
    assert.deepEqual(h.menus, []);
    h.advance(1);
    assert.deepEqual(h.menus, ['grid-app-0']);
    assert.deepEqual(h.actions, []);
  });

  test('Запоздавший timer: отпускание ' + kind + ' после 700 мс открывает меню', () => {
    const h = harness();
    if (kind === 'keyboard') h.keydown(); else h.mousedown();
    h.advance(710, false);
    if (kind === 'keyboard') h.keyup(); else h.mouseup();
    h.click(h.menu);
    assert.deepEqual(h.menus, ['grid-app-0']);
    assert.deepEqual(h.actions, []);
    h.advance(1000);
    assert.deepEqual(h.menus, ['grid-app-0']);
  });

  for (const cancel of ['blur', 'hide']) {
    test(cancel + ' отменяет ' + kind + ', отпускание и click после отмены не запускают приложение', () => {
      const h = harness();
      if (kind === 'keyboard') h.keydown(); else h.mousedown();
      h.advance(100);
      h[cancel]();
      if (kind === 'keyboard') h.keyup(); else h.mouseup();
      h.click();
      h.advance(1000);
      assert.deepEqual(h.actions, []);
      assert.deepEqual(h.menus, []);
    });
  }
}

for (const first of ['keyboard', 'mouse']) {
  test('Общий физический жест ' + first + ' → второй тип down сохраняет исходный таймер', () => {
    const h = harness();
    if (first === 'keyboard') h.keydown(); else h.mousedown();
    h.advance(200);
    if (first === 'keyboard') h.mousedown(); else h.keydown();
    h.advance(499);
    assert.deepEqual(h.menus, []);
    h.advance(1);
    assert.deepEqual(h.menus, ['grid-app-0']);
    h.mouseup(h.menu);
    h.keyup();
    h.click(h.menu);
    assert.deepEqual(h.actions, []);
    assert.deepEqual(h.menus, ['grid-app-0']);
  });

  test('Короткий общий жест ' + first + ' → второй тип down активирует ровно один раз', () => {
    const h = harness();
    if (first === 'keyboard') h.keydown(); else h.mousedown();
    h.advance(30);
    if (first === 'keyboard') h.mousedown(); else h.keydown();
    h.advance(80);
    h.mouseup();
    h.keyup();
    h.click();
    assert.deepEqual(h.actions, ['grid-app-0']);
    h.advance(1000);
    assert.deepEqual(h.menus, []);
  });
}

test('Долгое удержание: отрисованное context-open не срабатывает на release и синтетический click', () => {
  const h = harness();
  h.keydown();
  h.mousedown();
  h.advance(700);
  assert.equal(h.card.parentNode, null, 'The fixture must reproduce grid replacement by renderView');
  assert.equal(h.document.activeElement, h.menu);
  h.click(h.menu); // Some remotes synthesize click before both release events.
  h.keyup();
  h.mouseup(h.menu);
  h.click(h.menu);
  assert.deepEqual(h.menus, ['grid-app-0']);
  assert.deepEqual(h.actions, []);
});

test('Следующий самостоятельный жест по context-open работает сразу после подавленного click', () => {
  const h = harness();
  h.mousedown();
  h.advance(700);
  h.mouseup(h.menu);
  h.click(h.menu);
  assert.deepEqual(h.actions, []);
  h.advance(30);
  h.mousedown(h.menu);
  h.advance(70);
  h.mouseup(h.menu);
  h.click(h.menu);
  assert.deepEqual(h.actions, ['context-open']);
  assert.deepEqual(h.menus, ['grid-app-0']);
});

for (const destination of ['other', 'outside']) {
  test('Отпускание мыши вне исходной карточки (' + destination + ') отменяет активацию', () => {
    const h = harness();
    h.mousedown();
    h.advance(100);
    h.mouseup(h[destination]);
    h.click(h[destination]);
    h.advance(1000);
    assert.deepEqual(h.actions, []);
    assert.deepEqual(h.menus, []);
  });
}

test('mouseleave отменяет удержание мыши и его отложенные события', () => {
  const h = harness();
  h.mousedown();
  h.advance(100);
  h.leave();
  h.mouseup();
  h.click();
  h.advance(1000);
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.menus, []);
});

test('Стрелка отменяет Enter до перехода фокуса: keyup не запускает прежнюю карточку', () => {
  const h = harness();
  h.keydown();
  h.advance(100);
  h.keydown(39);
  assert.equal(h.document.activeElement, h.other);
  h.keyup();
  h.advance(1000);
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.menus, []);
});

test('Назад отменяет удержание до смены view', () => {
  const h = harness();
  h.keydown();
  h.advance(100);
  h.keydown(461);
  h.keyup();
  h.advance(1000);
  assert.deepEqual(h.actions, []);
  assert.deepEqual(h.menus, []);
});

test('Синяя кнопка пульта открывает действия выбранной карточки без удержания OK', () => {
  const h = harness();
  h.keydown(406);
  h.keyup(406);
  assert.deepEqual(h.menus, ['grid-app-0']);
  assert.deepEqual(h.actions, []);
  h.keydown();
  h.advance(80);
  h.keyup();
  assert.deepEqual(h.actions, ['context-open']);
});

test('Зафиксированный импульс пульта 126 мс не выдаётся за длинное удержание', () => {
  const h = harness();
  h.keydown();
  h.advance(126);
  h.keyup();
  h.advance(2500);
  assert.deepEqual(h.actions, ['grid-app-0']);
  assert.deepEqual(h.menus, []);
});

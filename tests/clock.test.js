'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homeState = require('../home-state');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Bootstrap the actual app with a wall clock and an independent monotonic timer.
// This also exercises lifecycle handlers alongside their normal catalog handlers.
function harness(start, hidden = false) {
  let wall = start.getTime(), elapsed = 0, nextId = 0;
  const timers = new Map(), nodes = new Map();
  function element(id) {
    let text = '';
    const attrs = {}, listeners = {};
    const node = {
      id, listeners, writes: { text: 0, attributes: 0 }, hidden: false, innerHTML: '',
      style: { setProperty() {} },
      classList: { toggle() {}, add() {}, remove() {} },
      get textContent() { return text; },
      set textContent(value) { text = value; this.writes.text++; },
      getAttribute(key) { return Object.hasOwn(attrs, key) ? attrs[key] : null; },
      setAttribute(key, value) { attrs[key] = String(value); this.writes.attributes++; },
      removeAttribute(key) { delete attrs[key]; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      querySelectorAll() { return []; },
      focus() { document.activeElement = this; }
    };
    nodes.set(id, node);
    return node;
  }
  const document = element('document'), window = element('window');
  document.hidden = hidden;
  document.getElementById = id => nodes.get(id) || null;
  for (const id of ['stage', 'overlay', 'home', 'home-rail', 'clock-time', 'clock-date', 'all-apps-button', 'settings-button', 'network-button', 'remote-hint']) element(id);
  Object.assign(window, {
    innerWidth: 1920, innerHeight: 1080, LauncherHomeState: homeState,
    LauncherPlatform: {
      mode: 'webos', getApps() { return new Promise(() => {}); },
      getNetwork() { return Promise.resolve({ available: true, kind: 'wifi' }); }
    },
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, due: elapsed + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { throw Error('The minute clock must not use a repeating interval'); }
  });
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [wall])); }
    static now() { return wall; }
  }
  vm.runInNewContext(source, {
    window, document, Date: ClockDate, Promise,
    localStorage: { getItem() { return null; }, setItem() {} }
  }, { filename: 'app.js' });
  function emit(target, type) { for (const fn of target.listeners[type] || []) fn({ type }); }
  return {
    time: nodes.get('clock-time'), date: nodes.get('clock-date'),
    pending() { return timers.size; },
    delay() { assert.equal(timers.size, 1); return [...timers.values()][0].due - elapsed; },
    advance(ms) {
      const end = elapsed + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        wall += due[1].due - elapsed; elapsed = due[1].due;
        timers.delete(due[0]); due[1].fn();
      }
      wall += end - elapsed; elapsed = end;
    },
    jump(ms) { wall += ms; },
    hide() { document.hidden = true; emit(document, 'visibilitychange'); },
    show() { document.hidden = false; emit(document, 'visibilitychange'); },
    focus() { emit(window, 'focus'); },
    relaunch() { emit(document, 'webOSRelaunch'); }
  };
}

test('Часы рисуются сразу и впервые обновляются на границе минуты, без секундных записей DOM', () => {
  const h = harness(new Date(2026, 9, 21, 17, 42, 23, 456));
  assert.equal(h.time.textContent, '17:42');
  assert.equal(h.date.textContent, 'Ср, 21 октября');
  assert.equal(h.time.getAttribute('datetime'), new Date(2026, 9, 21, 17, 42).toISOString());
  assert.equal(h.delay(), 36544);
  h.advance(36543);
  assert.equal(h.time.writes.text, 1);
  assert.equal(h.date.writes.text, 1);
  h.advance(1);
  assert.equal(h.time.textContent, '17:43');
  assert.equal(h.time.writes.text, 2);
  assert.equal(h.date.writes.text, 1, 'Неизменившаяся дата не переписывается');
  assert.equal(h.delay(), 60000);
});

test('Минутная граница обновляет дату, год и машинное время при переходе через полночь', () => {
  const h = harness(new Date(2026, 11, 31, 23, 59, 59, 999));
  assert.equal(h.delay(), 1);
  h.advance(1);
  assert.equal(h.time.textContent, '00:00');
  assert.equal(h.date.textContent, 'Пт, 1 января');
  assert.equal(h.time.getAttribute('datetime'), new Date(2027, 0, 1).toISOString());
  assert.equal(h.date.writes.text, 2);
});

test('Скрытый лаунчер не держит таймер, а возвращение сразу восстанавливает актуальные часы', () => {
  const h = harness(new Date(2026, 9, 21, 17, 42, 23));
  h.hide();
  assert.equal(h.pending(), 0);
  h.advance(185000);
  assert.equal(h.time.textContent, '17:42');
  h.focus();
  assert.equal(h.pending(), 0, 'Скрытое окно не перезапускает часы по focus');
  h.show();
  assert.equal(h.time.textContent, '17:45');
  assert.equal(h.delay(), 32000);
});

test('Повторные focus, visibility и Home не создают несколько таймеров и лишние записи DOM', () => {
  const h = harness(new Date(2026, 9, 21, 17, 42, 23));
  const before = { ...h.time.writes };
  for (let i = 0; i < 6; i++) { h.focus(); h.show(); h.relaunch(); }
  assert.equal(h.pending(), 1);
  assert.equal(h.delay(), 37000);
  assert.deepEqual(h.time.writes, before);
  assert.equal(h.date.writes.text, 1);
  h.advance(37000);
  assert.equal(h.time.textContent, '17:43');
  assert.equal(h.time.writes.text, 2);
});

test('После сна и изменения системного времени часы перепланируются по новой минуте', () => {
  const h = harness(new Date(2026, 9, 21, 17, 42, 23));
  h.hide(); h.jump(125250); h.show();
  assert.equal(h.time.textContent, '17:44');
  assert.equal(h.delay(), 31750);
  h.jump(-60400); h.focus();
  assert.equal(h.time.textContent, '17:43');
  assert.equal(h.delay(), 32150);
  h.advance(32150);
  assert.equal(h.time.textContent, '17:44');
  assert.equal(h.delay(), 60000);
});

test('Коррекция времени при активном окне учитывается очередным тиканьем без накопления сдвига', () => {
  const h = harness(new Date(2026, 9, 21, 17, 42, 23));
  h.jump(12200); h.advance(37000);
  assert.equal(h.time.textContent, '17:43');
  assert.equal(h.delay(), 47800);
  h.advance(47800);
  assert.equal(h.time.textContent, '17:44');
  assert.equal(h.delay(), 60000);
});

test('Bootstrap скрытой страницы рисует часы без фонового таймера', () => {
  const h = harness(new Date(2026, 9, 21, 17, 42, 23), true);
  assert.equal(h.time.textContent, '17:42');
  assert.equal(h.pending(), 0);
  h.advance(97000); h.show();
  assert.equal(h.time.textContent, '17:44');
  assert.equal(h.delay(), 60000);
});

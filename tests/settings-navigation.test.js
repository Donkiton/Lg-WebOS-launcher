'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const wallpaper = require('../wallpaper');
const source = fs.readFileSync(require.resolve('../app'), 'utf8');
const first = source.indexOf('  function moveFocus(key)');
const last = source.indexOf('  function fullscreen()', first);
assert.ok(first >= 0 && last > first);
const script = new vm.Script(source.slice(first, last), { filename: 'app.js:settings-navigation' });

function harness(view = 'settings', focused = 'wallpaper-button', motion = 'off') {
  const buttons = ['view-back', 'wallpaper-button', 'motion-smooth', 'motion-fast', 'motion-off', 'setting-reflections', 'setting-dim', 'setting-hints', 'tv-settings-button', 'inputs-button', 'help-button', ...wallpaper.OPTIONS.map(option => 'wallpaper-' + option.id)];
  const nodes = Object.fromEntries(buttons.map(id => [id, { id, getAttribute() { return null; } }]));
  const document = { activeElement: nodes[focused] };
  const context = vm.createContext({
    document, view, settings: { motion }, window: { LauncherWallpaper: wallpaper },
    focusId(id) { assert.ok(nodes[id], 'Focused control must exist: ' + id); document.activeElement = nodes[id]; }
  });
  script.runInContext(context);
  return { move: key => context.moveFocus(key), focused: () => document.activeElement.id };
}

test('Из крайнего режима анимации Down достигает каждой строки настроек без пропусков', () => {
  const h = harness('settings', 'motion-off');
  for (const id of ['setting-reflections', 'setting-dim', 'setting-hints', 'tv-settings-button', 'inputs-button', 'help-button']) {
    h.move(40); assert.equal(h.focused(), id);
  }
  h.move(40); assert.equal(h.focused(), 'help-button');
});

for (const mode of ['smooth', 'fast', 'off']) {
  test('Вертикальный переход к анимациям восстанавливает выбранный режим ' + mode, () => {
    const h = harness('settings', 'wallpaper-button', mode);
    h.move(40); assert.equal(h.focused(), 'motion-' + mode);
    h.move(40); assert.equal(h.focused(), 'setting-reflections');
    h.move(38); assert.equal(h.focused(), 'motion-' + mode);
  });
}

test('Left/Right выбирают соседний режим анимации и останавливаются на границах', () => {
  const h = harness('settings', 'motion-smooth');
  h.move(37); assert.equal(h.focused(), 'motion-smooth');
  h.move(39); assert.equal(h.focused(), 'motion-fast');
  h.move(39); assert.equal(h.focused(), 'motion-off');
  h.move(39); assert.equal(h.focused(), 'motion-off');
});

test('Все фоны, включая Без фона, достижимы вертикально; Left/Right не меняют выбор', () => {
  const h = harness('wallpaper', 'wallpaper-lake');
  for (const option of wallpaper.OPTIONS.slice(1)) {
    h.move(40); assert.equal(h.focused(), 'wallpaper-' + option.id);
    h.move(37); h.move(39); assert.equal(h.focused(), 'wallpaper-' + option.id);
  }
  h.move(40); assert.equal(h.focused(), 'wallpaper-none');
  for (const option of wallpaper.OPTIONS.slice(0, -1).reverse()) {
    h.move(38); assert.equal(h.focused(), 'wallpaper-' + option.id);
  }
});

for (const [view, firstId] of [['settings', 'wallpaper-button'], ['wallpaper', 'wallpaper-lake']]) {
  test('Кнопка Назад в ' + view + ' достижима сверху и возвращает фокус вниз в список', () => {
    const h = harness(view, firstId);
    h.move(38); assert.equal(h.focused(), 'view-back');
    h.move(40); assert.equal(h.focused(), firstId);
  });
}

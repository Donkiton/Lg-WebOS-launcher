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

function harness(view = 'settings', focused = 'wallpaper-button', motion = 'off', group = 'new') {
  const buttons = ['view-back', 'wallpaper-close', 'wallpaper-tab-new', 'wallpaper-tab-classic', 'wallpaper-button', 'motion-smooth', 'motion-fast', 'motion-off', 'setting-reflections', 'setting-dim', 'setting-hints', 'tv-settings-button', 'inputs-button', 'help-button', ...wallpaper.OPTIONS.map(option => 'wallpaper-' + option.id)];
  const nodes = Object.fromEntries(buttons.map(id => [id, { id, getAttribute(name) {
    if (name === 'data-wallpaper-group' && id.startsWith('wallpaper-tab-')) return id.slice('wallpaper-tab-'.length);
    if (name === 'data-wallpaper-index') {
      const index = wallpaper.optionsForGroup(context.viewData.group).findIndex(option => id === 'wallpaper-' + option.id);
      if (index >= 0) return String(index);
    }
    return null;
  } }]));
  const document = { activeElement: nodes[focused] };
  const context = vm.createContext({
    document, view, viewData: { group }, settings: { motion }, window: { LauncherWallpaper: wallpaper },
    changeWallpaperGroup(next) { context.viewData.group = next; document.activeElement = nodes['wallpaper-tab-' + next]; },
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

test('Новые фоны доступны в двух колонках; движение не перескакивает на другой ряд на границах', () => {
  const h = harness('wallpaper', 'wallpaper-coast');
  h.move(37); assert.equal(h.focused(), 'wallpaper-coast');
  h.move(39); assert.equal(h.focused(), 'wallpaper-city');
  h.move(39); assert.equal(h.focused(), 'wallpaper-city');
  for (const id of ['obsidian', 'aurora', 'none']) { h.move(40); assert.equal(h.focused(), 'wallpaper-' + id); }
  h.move(40); assert.equal(h.focused(), 'wallpaper-none');
  h.move(37); assert.equal(h.focused(), 'wallpaper-holiday');
  for (const id of ['orbit', 'zen', 'coast']) { h.move(38); assert.equal(h.focused(), 'wallpaper-' + id); }
});

test('Вкладки новых и классических фонов доступны с пульта и ведут в свою коллекцию', () => {
  const h = harness('wallpaper', 'wallpaper-coast');
  h.move(38); assert.equal(h.focused(), 'wallpaper-tab-new');
  h.move(39); assert.equal(h.focused(), 'wallpaper-tab-classic');
  h.move(40); assert.equal(h.focused(), 'wallpaper-morning');
  h.move(37); assert.equal(h.focused(), 'wallpaper-lake');
  h.move(40); assert.equal(h.focused(), 'wallpaper-day');
  h.move(39); assert.equal(h.focused(), 'wallpaper-evening');
  h.move(40); assert.equal(h.focused(), 'wallpaper-night');
  h.move(40); assert.equal(h.focused(), 'wallpaper-night');
});

test('Кнопка закрытия фонов достижима через вкладки и возвращает фокус вниз', () => {
  const h = harness('wallpaper', 'wallpaper-tab-new');
  h.move(38); assert.equal(h.focused(), 'wallpaper-close');
  h.move(40); assert.equal(h.focused(), 'wallpaper-tab-new');
  h.move(40); assert.equal(h.focused(), 'wallpaper-coast');
});

for (const [view, firstId] of [['settings', 'wallpaper-button']]) {
  test('Кнопка Назад в ' + view + ' достижима сверху и возвращает фокус вниз в список', () => {
    const h = harness(view, firstId);
    h.move(38); assert.equal(h.focused(), 'view-back');
    h.move(40); assert.equal(h.focused(), firstId);
  });
}

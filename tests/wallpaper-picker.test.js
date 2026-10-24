'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { BACKGROUNDS, createController, optionFor } = require('../wallpaper');
const source = fs.readFileSync(require.resolve('../app'), 'utf8');
const first = source.indexOf('  function closeView() {');
const last = source.indexOf('  function openContext(', first);
assert.ok(first >= 0 && last > first);
const script = new vm.Script(source.slice(first, last), { filename: 'app.js:wallpaper-close' });
const selectFirst = source.indexOf('  function selectWallpaper(id) {');
const selectLast = source.indexOf('  function updateClock()', selectFirst);
assert.ok(selectFirst >= 0 && selectLast > selectFirst);
const selectScript = new vm.Script(source.slice(selectFirst, selectLast), { filename: 'app.js:wallpaper-select' });

for (const action of ['closeView', 'goHome']) {
  test(action + ' отменяет несохранённый фон и позднюю загрузку до выхода на главный', async () => {
    const applied = [], writes = [], removed = [];
    let finish;
    const pendingImage = new Promise(resolve => { finish = resolve; });
    const wallpaperController = createController({
      mode: 'browser',
      storage: { getItem() { return null; }, setItem(...args) { writes.push(args); } },
      loadImage() { return pendingImage; },
      apply(path) { applied.push(path); }
    });
    await wallpaperController.refresh();
    await wallpaperController.preview('none');
    const pending = wallpaperController.select('holiday');
    await Promise.resolve();
    const context = vm.createContext({
      view: 'wallpaper', viewData: {}, viewRevision: 1, stack: [], lastHomeIndex: 0,
      wallpaperController, pendingShortcut: null,
      overlay: { hidden: false, innerHTML: 'picker', classList: { remove(name) { removed.push(name); } } },
      stage: { classList: { remove(name) { removed.push(name); } } },
      home: { removeAttribute() {} },
      cancelPress() {}, focusId() { return true; }, focusHome() {}, updatePriorities() {}, flushCatalog() {}, loadApps() {}
    });
    script.runInContext(context);
    context[action]();
    assert.equal(wallpaperController.getPreview(), 'lake');
    assert.equal(context.view, 'home');
    assert.equal(context.overlay.hidden, true);
    assert.ok(removed.includes('wallpaper-picker-open'));
    finish();
    assert.equal((await pending).status, 'stale');
    assert.deepEqual(applied, [BACKGROUNDS.lake, null, BACKGROUNDS.lake]);
    assert.deepEqual(writes, []);
  });
}

test('Немедленный OK при загрузке предпросмотра синхронизирует название с применённым фоном', async () => {
  let finish;
  const cityImage = new Promise(resolve => { finish = resolve; });
  const writes = [], messages = [];
  const wallpaperController = createController({
    mode: 'browser',
    storage: { getItem() { return null; }, setItem(...args) { writes.push(args); } },
    loadImage(path) { return path === BACKGROUNDS.city ? cityImage : Promise.resolve(); },
    apply() {}
  });
  await wallpaperController.refresh();
  await wallpaperController.preview('coast');
  const label = { textContent: optionFor('coast').label };
  const context = vm.createContext({
    wallpaperController, view: 'wallpaper', viewRevision: 1, viewData: { preview: 'coast' },
    document: { getElementById(id) { assert.equal(id, 'wallpaper-preview-name'); return label; } },
    wallpaperLabel(id) { return optionFor(id).label; },
    syncWallpaperControls(message) { messages.push(message); }
  });
  selectScript.runInContext(context);
  const preview = wallpaperController.preview('city');
  context.selectWallpaper('city');
  finish();
  assert.equal((await preview).status, 'stale', 'OK owns the shared loading request');
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(wallpaperController.getSelection(), 'city');
  assert.equal(context.viewData.preview, 'city');
  assert.equal(label.textContent, 'После дождя');
  assert.equal(messages.at(-1), 'Фон сохранён');
  assert.equal(writes.length, 1);
});

test('Завершённое сохранение не меняет подпись после перехода на другой экран', async () => {
  let finish;
  const wallpaperController = createController({
    mode: 'browser', storage: { getItem() { return null; }, setItem() {} },
    loadImage() { return new Promise(resolve => { finish = resolve; }); }, apply() {}
  });
  await wallpaperController.refresh();
  const messages = [];
  const context = vm.createContext({
    wallpaperController, view: 'wallpaper', viewRevision: 1, viewData: { preview: 'lake' },
    document: { getElementById() { throw Error('Previous screen must not receive updates'); } },
    syncWallpaperControls(message) { messages.push(message); }
  });
  selectScript.runInContext(context);
  context.selectWallpaper('city');
  await Promise.resolve();
  context.view = 'settings';
  context.viewRevision++;
  finish();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(wallpaperController.getSelection(), 'city');
  assert.deepEqual(messages, ['Сохраняем…']);
  assert.equal(context.viewData.preview, 'lake');
});

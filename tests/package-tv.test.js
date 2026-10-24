'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const builder = require('../scripts/package-tv');

test('Манифест пробного приложения не запрашивает дополнительных прав', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'appinfo.json'), 'utf8'));
  assert.deepEqual(builder.validateManifest(manifest), builder.MANIFEST);
  assert.equal(manifest.id, 'org.lggate.launcher');
  assert.equal(manifest.version, '0.1.7');
  assert.equal(manifest.handlesRelaunch, false);
  assert.equal(manifest.disableBackHistoryAPI, true);
  assert.throws(() => builder.validateManifest(Object.assign({}, manifest, { trustLevel: 'trusted' })), /неподтверждённые/);
  assert.throws(() => builder.validateManifest(Object.assign({}, manifest, { requiredPermissions: ['application.launcher'] })), /неподтверждённые/);
  assert.throws(() => builder.validateManifest(Object.assign({}, manifest, { version: '0.1.4' })), /Неожиданное значение/);
});

test('Браузерный script исключается только из staging-копии', () => {
  const filename = path.resolve(__dirname, '..', 'index.html');
  const original = fs.readFileSync(filename, 'utf8');
  const result = builder.stageApplication();
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  const staged = fs.readFileSync(path.join(result.stage, 'index.html'), 'utf8');
  assert.doesNotMatch(staged, /<script\b[^>]*preview-catalog/);
  for (const script of ['platform.js', 'home-state.js', 'app.js']) assert.ok(staged.includes('src="' + script + '"'));
  assert.deepEqual(result.files, builder.ALLOWLIST.slice().sort());
});

test('Белый список запрещает снимки ТВ, сервер, тесты и неизвестные файлы', () => {
  for (const extra of ['preview-catalog.js', 'assets/tv-apps/youtube.png', 'server.js', 'README.md', 'tests/a.test.js', 'scripts/sync-tv-catalog.js', '.ssh/id_rsa']) {
    assert.throws(() => builder.validateFileList(builder.ALLOWLIST.concat([extra]), true), /лишние файлы/);
  }
  assert.throws(() => builder.validateFileList(['index.html'], true), /полный/);
  assert.throws(() => builder.projectPath(path.resolve(__dirname, '..', '..', 'outside')), /вне проекта/);
});

test('Статические ресурсы TV-страницы самодостаточны и входят в белый список', () => {
  assert.doesNotThrow(() => builder.validateReferences('<script src="app.js"></script><link href="styles.css"><link href="data:,">', '.wallpaper { background:url("assets/mountain-sunset.png"); }'));
  assert.throws(() => builder.validateReferences('<script src="preview-catalog.js"></script>', ''), /отсутствует/);
  assert.throws(() => builder.validateReferences('<script src="https://example.test/app.js"></script>', ''), /внешний/);
  assert.throws(() => builder.validateReferences('', 'a { background: url(https://example.test/bg.png); }'), /внешний/);
  assert.throws(() => builder.validateReferences('', '@import "missing.css";'), /CSS-импорты/);
});

test('Все фоны и миниатюры из каталога входят в автономный пакет 0.1.7', () => {
  const wallpaper = require('../wallpaper');
  assert.equal(builder.ALLOWLIST.length, 35);
  for (const option of wallpaper.OPTIONS) {
    for (const resource of [wallpaper.BACKGROUNDS[option.id], option.thumbnail].filter(Boolean)) {
      assert.ok(builder.ALLOWLIST.includes(resource), resource + ' должен входить в пакет');
      assert.ok(fs.statSync(path.resolve(__dirname, '..', resource)).isFile(), resource + ' должен существовать');
    }
  }
});

test('Значки соответствуют размерам LG 80×80 и 130×130', () => {
  for (const [filename, size] of [['assets/app-icon.png', 80], ['assets/app-icon-large.png', 130]]) {
    assert.deepEqual(builder.pngSize(fs.readFileSync(path.resolve(__dirname, '..', filename))), { width: size, height: size });
  }
  assert.throws(() => builder.pngSize(Buffer.from('not png')), /PNG/);
});

test('TV staging использует native bridge без browser snapshot и CommonJS require', () => {
  const source = fs.readFileSync(path.join(builder.STAGE_DIRECTORY, 'platform.js'), 'utf8');
  const window = { PalmServiceBridge: function () {} };
  vm.runInNewContext(source, { window, Promise, setTimeout, clearTimeout });
  assert.equal(window.LauncherPlatform.mode, 'webos');
  assert.equal(window.LauncherPlatform.catalogSource, 'webos');
});

test('Официальный упаковщик вызывается без минификации и без команд устройства', () => {
  const args = builder.packageArguments();
  assert.equal(args[0], '--no-minify');
  assert.equal(args[1], '--outdir');
  assert.equal(args[args.length - 1], builder.STAGE_DIRECTORY);
  assert.ok(!args.some(arg => /install|launch|ssh|device/.test(arg)));
});

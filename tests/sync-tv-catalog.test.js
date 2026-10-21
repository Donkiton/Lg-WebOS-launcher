'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importer = require('../scripts/sync-tv-catalog');

test('ID ограничивает локальное имя файла и исключает специальные имена Windows', () => {
  for (const id of ['youtube.leanback.v4', 'com.685631.3411', 'org.webosbrew.hbchannel', 'rutube']) assert.equal(importer.validAppId(id), true);
  for (const id of ['../secret', 'x/y', 'x\\y', '-option', 'CON', 'NUL.icon', 'COM1', 'a:b', 'a\n', '', null]) assert.equal(importer.validAppId(id), false);
});

test('Удалённые значки ограничены PNG в деревьях установленных приложений', () => {
  for (const filename of [
    '/usr/palm/applications/com.webos.app.browser/icon.png',
    '/mnt/otncabi/usr/palm/applications/ivi@1/icon-large.png',
    '/media/cryptofs/apps/usr/palm/applications/yota.play/icon.png'
  ]) assert.equal(importer.validRemoteIcon(filename), true);
  for (const filename of ['https://example.test/icon.png', '/root/secret.png', '/usr/palm/applications/app/../secret.png', '/usr/palm/applications/app/$(id).png', '/usr/palm/applications/app/a;b.png', '/usr/palm/applications/app/icon.jpg', '/usr/palm/applications/app//icon.png', '/usr/palm/applications/app/icon.png\n']) assert.equal(importer.validRemoteIcon(filename), false);
});

test('Нормализация сохраняет порядок, предпочитает largeIcon и удаляет лишние поля', () => {
  const large = '/media/cryptofs/apps/usr/palm/applications/rutube/large.png';
  const small = '/media/cryptofs/apps/usr/palm/applications/rutube/icon.png';
  const apps = importer.parseCatalog(JSON.stringify({ returnValue: true, ip: 'must not be captured', launchPoints: [
    { id: 'rutube', title: ' RUTUBE ', largeIcon: large, icon: small, iconColor: '#ffffff', installTime: 123, serialNumber: 'not exported' },
    { id: 'ivi', title: 'Иви', largeIcon: 'https://example.test/icon.png', icon: '/usr/palm/applications/ivi/icon.png' },
    { id: 'rutube', title: 'Duplicate' }
  ] }));
  assert.deepEqual(apps, [
    { id: 'rutube', title: 'RUTUBE', sources: [large, small], iconColor: '#ffffff', installTime: 123 },
    { id: 'ivi', title: 'Иви', sources: ['/usr/palm/applications/ivi/icon.png'] }
  ]);
});

test('Ошибочный каталог не превращается в успешный пустой снимок', () => {
  for (const text of ['not json', '{}', 'null', '{"returnValue":false,"launchPoints":[]}', '{"returnValue":true,"launchPoints":[{"id":"../bad"}]}']) assert.throws(() => importer.parseCatalog(text));
  assert.deepEqual(importer.parseCatalog('{"returnValue":true,"launchPoints":[]}'), []);
});

test('SSH читает только фиксированный Luna-запрос с проверкой ключа узла', () => {
  let recorded;
  assert.deepEqual(importer.readCatalog((command, args, timeout) => {
    recorded = { command, args, timeout };
    return { status: 0, stdout: '{"returnValue":true,"launchPoints":[]}' };
  }), []);
  assert.equal(recorded.command, 'ssh');
  assert.deepEqual(recorded.args, ['-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'lg-tv', "luna-send -n 1 -f luna://com.webos.applicationManager/listLaunchPoints '{}'"]);
  assert.equal(recorded.timeout, 20000);
  assert.throws(() => importer.readCatalog(() => ({ status: 1, stderr: 'do not print raw diagnostics' })), /SSH/);
});

test('SCP использует legacy read и не принимает локальные пути вне проекта', () => {
  const destination = path.resolve(__dirname, '..', 'assets', 'tv-apps', 'rutube.png');
  const args = importer.scpArgs('/usr/palm/applications/rutube/icon.png', destination);
  assert.equal(args[0], '-O');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.equal(args[args.length - 2], 'lg-tv:/usr/palm/applications/rutube/icon.png');
  assert.equal(args[args.length - 1], destination);
  assert.throws(() => importer.scpArgs('/usr/palm/applications/rutube/icon.png', path.resolve(__dirname, '..', '..', 'outside.png')), /вне проекта/);
});

test('Снимок работает как ES5 UMD и безопасно сериализует текст', () => {
  const snapshot = { capturedAt: '2026-10-20T00:00:00.000Z', launchPoints: [{ id: 'a', title: '</script>\u2028\u2029', icon: '' }] };
  const source = importer.snapshotSource(snapshot);
  assert.ok(!source.includes('</script>'));
  assert.ok(!source.includes('\u2028'));
  assert.ok(!source.includes('\u2029'));
  const moduleContext = { module: { exports: {} } };
  vm.runInNewContext(source, moduleContext);
  assert.deepEqual(JSON.parse(JSON.stringify(moduleContext.module.exports)), snapshot);
  const browserContext = {};
  vm.runInNewContext(source, browserContext);
  assert.deepEqual(JSON.parse(JSON.stringify(browserContext.LauncherPreviewCatalog)), snapshot);
});

test('Сбой чтения не меняет ранее сохранённый снимок', () => {
  const filename = path.resolve(__dirname, '..', 'preview-catalog.js');
  const before = fs.existsSync(filename) ? fs.readFileSync(filename) : null;
  assert.throws(() => importer.syncCatalog({ run: () => ({ status: 0, stdout: 'invalid' }), log: () => {} }), /JSON/);
  const after = fs.existsSync(filename) ? fs.readFileSync(filename) : null;
  assert.deepEqual(after, before);
});

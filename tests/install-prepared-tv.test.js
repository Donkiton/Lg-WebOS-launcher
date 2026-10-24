'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { ALLOWLIST, MANIFEST } = require('../scripts/package-tv');
const updater = require('../scripts/install-prepared-tv');
const GALLERY_ASSETS = Object.freeze([
  'assets/wallpapers/coast.webp', 'assets/wallpapers/city.webp', 'assets/wallpapers/zen.webp',
  'assets/wallpapers/obsidian.webp', 'assets/wallpapers/orbit.webp', 'assets/wallpapers/aurora.webp', 'assets/wallpapers/holiday.webp',
  'assets/wallpapers/northern-lake-thumb.webp', 'assets/wallpapers/morning-thumb.webp', 'assets/wallpapers/day-thumb.webp',
  'assets/wallpapers/evening-thumb.webp', 'assets/wallpapers/night-thumb.webp',
  'assets/wallpapers/coast-thumb.webp', 'assets/wallpapers/city-thumb.webp', 'assets/wallpapers/zen-thumb.webp',
  'assets/wallpapers/obsidian-thumb.webp', 'assets/wallpapers/orbit-thumb.webp', 'assets/wallpapers/aurora-thumb.webp', 'assets/wallpapers/holiday-thumb.webp'
]);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function tar(entries) {
  const blocks = [];
  for (const [filename, contents, kind = '0'] of entries) {
    const data = Buffer.from(contents);
    const header = Buffer.alloc(512);
    const write = (value, offset, length) => header.write(value, offset, length, 'ascii');
    write(filename, 0, 100); write('0000644\0', 100, 8); write('0000000\0', 108, 8); write('0000000\0', 116, 8);
    write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); write('00000000000\0', 136, 12);
    write('        ', 148, 8); write(kind, 156, 1); write('ustar\0', 257, 6); write('00', 263, 2);
    const sum = header.reduce((a, byte) => a + byte, 0);
    write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat(blocks.concat([Buffer.alloc(1024)]));
}

function ipk(version = updater.VERSION, extraData = [], filenames = version === updater.ROLLBACK_VERSION ? updater.ROLLBACK_ALLOWLIST : ALLOWLIST) {
  const entries = filenames.map(filename => [filename, filename === 'appinfo.json' ? Buffer.from(JSON.stringify({ ...MANIFEST, version })) : Buffer.from('Prepared contents: ' + filename)]);
  const prefix = 'usr/palm/applications/' + updater.APP_ID + '/';
  const data = entries.map(([filename, contents]) => [prefix + filename, contents]);
  data.push(['usr/palm/packages/' + updater.APP_ID + '/packageinfo.json', Buffer.from(JSON.stringify({ id: updater.APP_ID, app: updater.APP_ID, version }))]);
  const members = [
    ['debian-binary', Buffer.from('2.0\n')],
    ['control.tar.gz', zlib.gzipSync(tar([['control', Buffer.from('Package: ' + updater.APP_ID + '\nVersion: ' + version + '\nArchitecture: all\n')]]))],
    ['data.tar.gz', zlib.gzipSync(tar(data.concat(extraData)))]
  ];
  const archive = [Buffer.from('!<arch>\n')];
  for (const [filename, contents] of members) {
    archive.push(Buffer.from(filename.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(contents.length).padEnd(10) + '`\n'), contents);
    if (contents.length % 2) archive.push(Buffer.from('\n'));
  }
  return { bytes: Buffer.concat(archive), files: entries.map(([filename, contents]) => ({ path: filename, sha256: hash(contents) })) };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-gate-prepared-'));
  // Resolve the exact dedicated fixture root once. Cleanup never uses a shell
  // or a computed parent directory and cannot target the shared workspace.
  t.after(() => {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('lg-gate-prepared-')) throw Error('Unsafe fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const ready = ipk(), rollback = ipk(updater.ROLLBACK_VERSION);
  const plan = {
    schema: 1, appId: updater.APP_ID, version: updater.VERSION, ipk: updater.IPK_PATH,
    sha256: hash(ready.bytes), files: ready.files,
    rollback: { ipk: updater.ROLLBACK_PATH, sha256: hash(rollback.bytes), files: rollback.files }, expectedDevice: { ...updater.EXPECTED_DEVICE }
  };
  for (const [filename, bytes] of [[plan.ipk, ready.bytes], [plan.rollback.ipk, rollback.bytes], [updater.PLAN_PATH, Buffer.from(JSON.stringify(plan))]]) {
    fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
    fs.writeFileSync(path.join(root, filename), bytes);
  }
  return { root, plan, ready, rollback };
}

function device() {
  const bootId = '12345678-1234-5678-90ab-1234567890ab';
  return {
    uid: '0', system: { returnValue: true, modelName: '55SM8200PLA', sdkVersion: '4.10.0', firmwareVersion: '05.40.97' },
    app: { returnValue: true, appInfo: { id: updater.APP_ID, title: 'LG Gate', version: '0.1.6' } },
    homebrew: { returnValue: true, appInfo: { id: 'org.webosbrew.hbchannel', version: '0.7.3' } },
    bootId, session: { version: 1, bootId, sessionId: '11223344556677889900aabb', sleeping: false }
  };
}

function transport(plan, overrides = {}) {
  const calls = [];
  const source = {
    preflight: async () => device(),
    upload: async () => {}, sha256: async () => plan.sha256,
    install: async () => ({ installed: true, timedOut: false }),
    verify: async () => ({ app: { returnValue: true, appInfo: { id: updater.APP_ID, title: 'LG Gate', version: updater.VERSION } }, hashes: Object.fromEntries(plan.files.map(entry => [entry.path, entry.sha256])) }),
    launch: async () => ({ returnValue: true }), ...overrides
  };
  const remote = Object.fromEntries(Object.entries(source).map(([name, fn]) => [name, async (...args) => { calls.push({ name, args }); return fn(...args); }]));
  return { remote, calls, names: () => calls.map(call => call.name) };
}

test('Импорт установщика не создаёт ни transport, ни child process', () => {
  const filename = require.resolve('../scripts/install-prepared-tv');
  const module = { exports: {} };
  let processes = 0;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, console,
    require: name => name === 'node:child_process' ? { spawn() { processes++; throw Error('must stay offline'); } } : name === './package-tv' ? require('../scripts/package-tv') : require(name)
  }, { filename });
  assert.equal(typeof module.exports.main, 'function');
  assert.equal(processes, 0);
});

test('План 0.1.7 отделён от прежних handoff, а резерв 0.1.6 содержит ровно прежние 16 файлов', t => {
  const f = fixture(t);
  const previous = [
    'appinfo.json', 'index.html', 'portal.html', 'app.js', 'msx-catalog.js', 'platform.js', 'wallpaper.js', 'home-state.js', 'styles.css',
    'assets/wallpapers/morning.png', 'assets/wallpapers/day.png', 'assets/wallpapers/night.png',
    'assets/wallpapers/northern-lake.png',
    'assets/mountain-sunset.png', 'assets/app-icon.png', 'assets/app-icon-large.png'
  ];
  assert.equal(updater.VERSION, '0.1.7');
  assert.equal(updater.ROLLBACK_VERSION, '0.1.6');
  assert.equal(updater.PLAN_PATH, '.build/wallpaper-gallery-handoff/install-plan.json');
  assert.equal(updater.IPK_PATH, '.build/wallpaper-gallery-handoff/org.lggate.launcher_0.1.7_all.ipk');
  assert.equal(updater.ROLLBACK_PATH, '.build/wallpaper-gallery-handoff/rollback/org.lggate.launcher_0.1.6_all.ipk');
  assert.deepEqual(updater.ROLLBACK_ALLOWLIST, previous);
  assert.equal(Object.isFrozen(updater.ROLLBACK_ALLOWLIST), true);
  assert.deepEqual(ALLOWLIST.filter(filename => !previous.includes(filename)).sort(), GALLERY_ASSETS.slice().sort());
  assert.equal(Object.isFrozen(ALLOWLIST), true);
  assert.equal(ALLOWLIST.length, 35);
  assert.deepEqual(updater.validatePackage(f.ready.bytes).map(entry => entry.path), ALLOWLIST);
  assert.deepEqual(updater.validatePackage(f.rollback.bytes, undefined, updater.ROLLBACK_VERSION).map(entry => entry.path), previous);
  assert.equal(updater.validatePlan(f.plan, { root: f.root }).files.length, 35);
});

test('Локальная подготовка выводит план и все digest из байтов двух проверенных IPK', t => {
  const f = fixture(t);
  assert.deepEqual(updater.createPlan(f.ready.bytes, f.rollback.bytes), f.plan);
  assert.deepEqual(updater.validatePlan(updater.createPlan(f.ready.bytes, f.rollback.bytes), { root: f.root }).files, f.plan.files);
  assert.throws(() => updater.createPlan(f.rollback.bytes, f.ready.bytes));
  assert.throws(() => updater.createPlan(Buffer.from('invalid'), f.rollback.bytes));
  assert.throws(() => updater.createPlan(f.ready.bytes, Buffer.from('invalid')));
});

test('Каждый полный фон и миниатюра меню входят в точный состав обновления', () => {
  const wallpaper = require('../wallpaper');
  const full = Object.values(wallpaper.BACKGROUNDS).filter(Boolean);
  const thumbnails = wallpaper.OPTIONS.map(option => option.thumbnail).filter(Boolean);
  const expectedAssets = updater.ROLLBACK_ALLOWLIST.filter(filename => /\.(?:png|webp)$/.test(filename) && !filename.includes('app-icon')).concat(GALLERY_ASSETS).sort();
  assert.equal(full.length, 12);
  assert.equal(thumbnails.length, 12);
  assert.deepEqual(full.concat(thumbnails).sort(), expectedAssets);
  for (const asset of expectedAssets) assert.ok(ALLOWLIST.includes(asset), 'Не упакован ресурс меню: ' + asset);
});

test('Нельзя смешать составы 35 и 16 файлов ни в плане, ни в архиве, даже с новыми digest', async t => {
  const f = fixture(t);
  let created = 0;
  for (const mutate of [
    p => { p.files = clone(p.rollback.files); },
    p => { p.rollback.files = clone(p.files); },
    p => { p.rollback.files[0].path = 'assets/wallpapers/coast.webp'; },
    p => { p.files[0].path = 'assets/wallpapers/unapproved.png'; }
  ]) {
    const plan = clone(f.plan); mutate(plan);
    await assert.rejects(updater.main(['--execute', '--tv-free'], { root: f.root, loadPlan: () => plan, createTransport: () => { created++; } }));
  }
  for (const rollback of [false, true]) {
    const version = rollback ? updater.ROLLBACK_VERSION : updater.VERSION;
    const changed = ipk(version, [], rollback ? ALLOWLIST : updater.ROLLBACK_ALLOWLIST);
    const plan = clone(f.plan), target = rollback ? plan.rollback : plan;
    target.files = changed.files; target.sha256 = hash(changed.bytes);
    fs.writeFileSync(path.join(f.root, target.ipk), changed.bytes);
    await assert.rejects(updater.main(['--execute', '--tv-free'], { root: f.root, loadPlan: () => plan, createTransport: () => { created++; } }));
    assert.throws(() => updater.validatePackage(changed.bytes, undefined, version));
    fs.writeFileSync(path.join(f.root, target.ipk), rollback ? f.rollback.bytes : f.ready.bytes);
  }
  assert.equal(created, 0);
});

test('Без флагов и с --dry-run выполняется только полная локальная проверка', async t => {
  const f = fixture(t);
  let created = 0;
  for (const args of [[], ['--dry-run']]) {
    const result = await updater.main(args, { root: f.root, loadPlan: () => f.plan, createTransport: () => { created++; throw Error('network prohibited'); } });
    assert.equal(result.mode, 'dry-run'); assert.equal(result.ready, true); assert.equal(result.fileCount, 35);
  }
  assert.equal(created, 0);
  assert.deepEqual(updater.loadPlan(f.root), f.plan);
});

test('Откат по умолчанию только локально проверяет резерв 0.1.6 и все 16 файлов', async t => {
  const f = fixture(t);
  let created = 0;
  for (const args of [['--rollback'], ['--rollback', '--dry-run']]) {
    const result = await updater.main(args, { root: f.root, createTransport: () => { created++; throw Error('network prohibited'); } });
    assert.equal(result.mode, 'dry-run'); assert.equal(result.version, '0.1.6');
    assert.equal(result.ipk, f.plan.rollback.ipk); assert.equal(result.sha256, f.plan.rollback.sha256);
    assert.equal(result.fileCount, 16);
    assert.equal(result.executeCommand, 'node scripts/install-prepared-tv.js --rollback --execute --tv-free');
  }
  assert.equal(created, 0);
});

test('Неполные, повторные и неизвестные флаги останавливаются до чтения плана/transport', async () => {
  let reads = 0, created = 0;
  for (const args of [['--execute'], ['--tv-free'], ['install'], ['--execute', '--yes'], ['--execute', '--execute'], ['--dry-run', '--execute', '--tv-free'], ['--execute', '--tv-free', '--force'], ['--rollback', '--execute'], ['--rollback', '--tv-free'], ['--rollback', '--rollback'], ['--rollback', '--execute', '--tv-free', '--force']]) {
    await assert.rejects(updater.main(args, { loadPlan: () => { reads++; }, createTransport: () => { created++; } }), /Использование/);
  }
  assert.equal(reads, 0); assert.equal(created, 0);
});

test('Ошибочная schema, версия, устройство, путь, состав или digest блокируют transport', async t => {
  const f = fixture(t);
  const mutations = [
    p => { p.schema = 2; }, p => { p.appId = 'org.other'; }, p => { p.version = 'unknown'; },
    p => { p.ipk = '../outside.ipk'; }, p => { p.ipk = 'C:/outside.ipk'; }, p => { p.ipk = p.ipk.replaceAll('/', '\\'); },
    p => { p.expectedDevice.firmwareVersion = '05.40.98'; }, p => { p.files[0].path = '../app.js'; },
    p => { p.files[0].path = p.files[1].path; }, p => { p.files.pop(); }, p => { p.files[0].sha256 = 'z'.repeat(64); },
    p => { p.files[0].sha256 = '0'.repeat(64); }, p => { p.sha256 = '0'.repeat(64); }, p => { p.sha256 += '\n'; },
    p => { p.rollback.ipk = '.build/wallpaper-ready/../../old.ipk'; }, p => { p.rollback.sha256 = '0'.repeat(64); },
    p => { p.rollback.files.pop(); }, p => { p.rollback.files[0].sha256 = '0'.repeat(64); },
    p => { p.extraTransportCommand = 'arbitrary'; }
  ];
  let created = 0;
  for (const mutate of mutations) {
    const plan = clone(f.plan); mutate(plan);
    await assert.rejects(updater.main(['--execute', '--tv-free'], { root: f.root, loadPlan: () => plan, createTransport: () => { created++; } }));
  }
  assert.equal(created, 0);
});

test('Подмена байтов IPK и rollback обнаруживается до transport', async t => {
  const f = fixture(t);
  for (const filename of [f.plan.ipk, f.plan.rollback.ipk]) {
    const full = path.join(f.root, filename), original = fs.readFileSync(full);
    fs.appendFileSync(full, 'tampered');
    let created = false;
    await assert.rejects(updater.main(['--execute', '--tv-free'], { root: f.root, loadPlan: () => f.plan, createTransport: () => { created = true; } }), /SHA256/);
    assert.equal(created, false);
    fs.writeFileSync(full, original);
  }
});

test('Архив с лишним файлом или ссылкой не принимается даже с пересчитанным IPK SHA', t => {
  const f = fixture(t);
  for (const extra of [
    ['usr/palm/applications/org.lggate.launcher/unapproved.js', Buffer.from('extra')],
    ['usr/palm/applications/org.lggate.launcher/link', Buffer.alloc(0), '2'],
    ['../outside', Buffer.from('extra')], ['unapproved-directory/', Buffer.alloc(0), '5']
  ]) {
    const changed = ipk(updater.VERSION, [extra]);
    fs.writeFileSync(path.join(f.root, f.plan.ipk), changed.bytes);
    assert.throws(() => updater.validatePlan({ ...f.plan, sha256: hash(changed.bytes) }, { root: f.root }));
  }
});

test('Резерв проверяется как IPK 0.1.6, а не просто существующий файл с верным digest', t => {
  const f = fixture(t);
  for (const bytes of [Buffer.from('not an ipk'), ipk('0.1.3').bytes, ipk(updater.VERSION).bytes,
    ipk(updater.ROLLBACK_VERSION, [['unapproved-directory/', Buffer.alloc(0), '5']]).bytes]) {
    fs.writeFileSync(path.join(f.root, f.plan.rollback.ipk), bytes);
    const plan = clone(f.plan); plan.rollback.sha256 = hash(bytes);
    assert.throws(() => updater.validatePlan(plan, { root: f.root }));
  }
});

test('Разрешены только SM8200PLA с необязательной диагональю без suffix', () => {
  for (const name of ['SM8200PLA', '55SM8200PLA', '100SM8200PLA']) {
    const d = device(); d.system.modelName = name; assert.equal(updater.validateDevice(d), d);
  }
  for (const name of ['SM8200PLB', '55SM8200PLA.BRU', 'LG 55SM8200PLA', '5SM8200PLA', '1555SM8200PLA', '55SM8200PLA ', '55SM8200PLA\n']) {
    const d = device(); d.system.modelName = name; assert.throws(() => updater.validateDevice(d), /Модель/);
  }
});

test('Preflight принимает прежнюю установленную 0.1.6 и повторную установку 0.1.7', () => {
  for (const version of [updater.ROLLBACK_VERSION, updater.VERSION]) {
    const d = device(); d.app.appInfo.version = version;
    assert.equal(updater.validateDevice(d), d);
  }
});

test('Несовместимый ТВ, Homebrew, app или wake marker блокирует upload', async t => {
  const f = fixture(t);
  for (const change of [
    d => { d.uid = '1000'; }, d => { d.system.sdkVersion = '5.0.0'; }, d => { d.system.sdkVersion = '4.10.2'; }, d => { d.system.firmwareVersion = '05.40.98'; },
    d => { d.app.appInfo.title = 'Other app'; }, d => { d.app.appInfo.version = '0.0.9'; },
    d => { d.homebrew.appInfo.version = '0.7.2'; }, d => { d.homebrew.appInfo.id = 'other.homebrew'; },
    d => { d.session = null; }, d => { d.session.sleeping = true; }, d => { d.session.bootId = 'abcdef01-2345-6789-abcd-0123456789ab'; },
    d => { d.session.sessionId = 'invalid'; }, d => { d.bootId = 'invalid'; }
  ]) {
    const d = device(); change(d);
    const mock = transport(f.plan, { preflight: async () => d });
    await assert.rejects(updater.install(f.plan, mock.remote, { root: f.root }));
    assert.deepEqual(mock.names(), ['preflight']);
  }
});

test('Несовпадение переданного SHA блокирует вызов install', async t => {
  const f = fixture(t), mock = transport(f.plan, { sha256: async () => '0'.repeat(64) });
  await assert.rejects(updater.install(f.plan, mock.remote, { root: f.root }), /переданного IPK/);
  assert.deepEqual(mock.names(), ['preflight', 'upload', 'sha256']);
});

test('Явная ошибка/неопределённый результат установки блокирует verify и launch', async t => {
  const f = fixture(t);
  for (const install of [async () => { throw Error('installer failed'); }, async () => ({ installed: false, timedOut: false }), async () => ({ installed: true, failed: true })]) {
    const mock = transport(f.plan, { install });
    await assert.rejects(updater.install(f.plan, mock.remote, { root: f.root }));
    assert.deepEqual(mock.names(), ['preflight', 'upload', 'sha256', 'install']);
  }
});

test('Неточная версия или хотя бы один SHA установленного приложения блокирует запуск', async t => {
  const f = fixture(t);
  for (const mutation of [
    actual => { actual.app.appInfo.version = '0.1.0'; }, actual => { actual.app.appInfo.title = 'Other'; },
    actual => { actual.hashes['app.js'] = '0'.repeat(64); }, actual => { delete actual.hashes['wallpaper.js']; },
    actual => { actual.hashes['unexpected.js'] = '0'.repeat(64); }
  ]) {
    const actual = { app: { returnValue: true, appInfo: { id: updater.APP_ID, title: 'LG Gate', version: updater.VERSION } }, hashes: Object.fromEntries(f.plan.files.map(entry => [entry.path, entry.sha256])) };
    mutation(actual);
    const mock = transport(f.plan, { verify: async () => actual });
    await assert.rejects(updater.install(f.plan, mock.remote, { root: f.root }));
    assert.deepEqual(mock.names(), ['preflight', 'upload', 'sha256', 'install', 'verify']);
  }
});

test('Явное выполнение соблюдает порядок preflight/upload/hash/install/verify/launch', async t => {
  const f = fixture(t), mock = transport(f.plan);
  let created = 0;
  const result = await updater.main(['--tv-free', '--execute'], { root: f.root, loadPlan: () => f.plan, createTransport: () => { created++; return mock.remote; } });
  assert.equal(created, 1);
  assert.deepEqual(mock.names(), ['preflight', 'upload', 'sha256', 'install', 'verify', 'launch']);
  assert.equal(mock.calls[1].args[0], path.join(f.root, f.plan.ipk));
  assert.equal(mock.calls[1].args[1], '/tmp/lg-gate-update-' + updater.VERSION + '-' + f.plan.sha256.slice(0, 12) + '.ipk');
  assert.equal(result.verified, true); assert.equal(result.launched, true); assert.equal(result.fileCount, 35);
  assert.equal(mock.calls[4].args[1], updater.VERSION);
});

test('Явный откат передаёт резерв 0.1.6, проверяет его версию и каждый SHA до launch', async t => {
  const f = fixture(t), mock = transport(f.plan, {
    sha256: async () => f.plan.rollback.sha256,
    verify: async () => ({ app: { returnValue: true, appInfo: { id: updater.APP_ID, title: 'LG Gate', version: updater.ROLLBACK_VERSION } }, hashes: Object.fromEntries(f.plan.rollback.files.map(entry => [entry.path, entry.sha256])) })
  });
  const result = await updater.main(['--rollback', '--execute', '--tv-free'], { root: f.root, createTransport: () => mock.remote });
  assert.deepEqual(mock.names(), ['preflight', 'upload', 'sha256', 'install', 'verify', 'launch']);
  assert.equal(mock.calls[1].args[0], path.join(f.root, f.plan.rollback.ipk));
  assert.equal(mock.calls[1].args[1], '/tmp/lg-gate-update-0.1.6-' + f.plan.rollback.sha256.slice(0, 12) + '.ipk');
  assert.deepEqual(mock.calls[4].args[0], f.plan.rollback.files);
  assert.equal(mock.calls[4].args[1], updater.ROLLBACK_VERSION);
  assert.equal(result.rollback, true); assert.equal(result.version, '0.1.6'); assert.equal(result.verified, true); assert.equal(result.fileCount, 16);
});

test('Неточная версия после отката не допускает launch', async t => {
  const f = fixture(t), mock = transport(f.plan, { sha256: async () => f.plan.rollback.sha256 });
  await assert.rejects(updater.main(['--rollback', '--execute', '--tv-free'], { root: f.root, createTransport: () => mock.remote }), /версия/);
  assert.deepEqual(mock.names(), ['preflight', 'upload', 'sha256', 'install', 'verify']);
});

test('Разрешённый timeout подписки требует независимой полной проверки перед launch', async t => {
  const f = fixture(t), mock = transport(f.plan, { install: async () => ({ installed: false, timedOut: true }) });
  const result = await updater.install(f.plan, mock.remote, { root: f.root });
  assert.equal(result.installTimedOut, true);
  assert.deepEqual(mock.names(), ['preflight', 'upload', 'sha256', 'install', 'verify', 'launch']);
  const broken = transport(f.plan, { install: async () => ({ installed: false, timedOut: true }), verify: async () => ({ app: device().app, hashes: {} }) });
  await assert.rejects(updater.install(f.plan, broken.remote, { root: f.root }));
  assert.equal(broken.names().includes('launch'), false);
});

test('Ошибка launch не выдаётся за подтверждённый успех', async t => {
  const f = fixture(t), mock = transport(f.plan, { launch: async () => ({ returnValue: false }) });
  await assert.rejects(updater.install(f.plan, mock.remote, { root: f.root }), /запуск.*не подтверждён/);
});

test('Реальный адаптер с fake spawn использует точные SSH/SCP опции и открытый stdin', async () => {
  const calls = [], children = [];
  const source = device();
  const files = ipk().files;
  const remote = '/tmp/lg-gate-update-' + updater.VERSION + '-112233445566.ipk';
  const spawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { destroyed: false, destroy() { this.destroyed = true; }, end() { throw Error('stdin must stay open'); } };
    child.kill = () => { child.killed = true; };
    children.push(child);
    process.nextTick(() => {
      assert.equal(child.stdin.destroyed, false);
      const command = args.at(-1);
      let stdout = '';
      if (command === 'id -u') stdout = '0\n';
      else if (command.includes('getSystemInfo')) stdout = JSON.stringify(source.system);
      else if (command.includes('getAppInfo')) stdout = JSON.stringify(command.includes('org.webosbrew.hbchannel') ? source.homebrew : source.app);
      else if (command === 'head -c 513 /tmp/lg-gate-session.json') stdout = JSON.stringify(source.session);
      else if (command === 'head -c 80 /proc/sys/kernel/random/boot_id') stdout = source.bootId + '\n';
      else if (command.startsWith('sha256sum ')) stdout = command.includes(updater.INSTALLED_ROOT) ? files.map(entry => entry.sha256 + '  ' + updater.INSTALLED_ROOT + '/' + entry.path).join('\n') : 'a'.repeat(64) + '  ' + remote + '\n';
      else if (command.includes('/dev/install')) stdout = JSON.stringify({ subscribed: true, returnValue: true }) + '\n' + JSON.stringify({ id: updater.APP_ID, details: { packageId: updater.APP_ID, state: 'installed' } });
      else if (command.includes('applicationManager/launch')) stdout = JSON.stringify({ returnValue: true });
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    });
    return child;
  };
  const adapter = updater.createTransport({ spawn });
  updater.validateDevice(await adapter.preflight());
  await adapter.upload('C:/prepared/app.ipk', remote);
  assert.equal(await adapter.sha256(remote), 'a'.repeat(64));
  assert.equal((await adapter.install(remote)).installed, true);
  assert.deepEqual((await adapter.verify(files)).hashes, Object.fromEntries(files.map(entry => [entry.path, entry.sha256])));
  assert.equal((await adapter.launch()).returnValue, true);
  assert.ok(calls.every(call => call.options.shell === false && call.options.windowsHide === true));
  assert.ok(calls.every(call => ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'ConnectTimeout=8'].every(option => call.args.includes(option))));
  assert.equal(calls.find(call => call.executable === 'scp').args[0], '-O');
  assert.ok(calls.filter(call => call.executable === 'ssh').every(call => call.args.includes('lg-tv')));
  assert.ok(children.every(child => child.stdin.destroyed));
  assert.ok(calls.find(call => call.args.at(-1).includes('getSystemInfo')).args.at(-1).includes('"subscribe":false'));
  assert.equal(calls.length, 12);
  assert.ok(calls.every(call => !/reboot|defaultApps|startup-enabled|kill -|\/bin\/sh|button|keyevent|lg-gate-runtime|\/var\/lib|settingsservice/i.test(call.args.at(-1))));
  const commands = calls.filter(call => call.executable === 'ssh').map(call => call.args.at(-1));
  const permittedReads = ['id -u', 'head -c 513 /tmp/lg-gate-session.json', 'head -c 80 /proc/sys/kernel/random/boot_id'];
  assert.ok(commands.every(command => permittedReads.includes(command) || /^sha256sum (?:'[^']+'(?: |$))+$/.test(command) || /^luna-send -(?:n 1|i) -f '?luna:\/\/(?:com\.webos\.service\.tv\.systemproperty\/getSystemInfo|com\.webos\.applicationManager\/(?:getAppInfo|launch)|com\.webos\.appInstallService\/dev\/install)'? '\{.*\}'$/.test(command)), 'Нельзя добавлять команды Home, runtime, кнопок или настроек ТВ');
});

test('Адаптер проверяет SHA по версии: 35 файлов обновления и 16 файлов отката', async () => {
  for (const version of [updater.VERSION, updater.ROLLBACK_VERSION]) {
    const files = ipk(version).files;
    const calls = [];
    const adapter = updater.createTransport({ spawn(executable, args) {
      calls.push({ executable, args });
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { destroy() {} }; child.kill = () => {};
      process.nextTick(() => {
        const command = args.at(-1);
        const stdout = command.includes('getAppInfo') ? JSON.stringify({ returnValue: true, appInfo: { id: updater.APP_ID, title: 'LG Gate', version } }) : files.map(entry => entry.sha256 + '  ' + updater.INSTALLED_ROOT + '/' + entry.path).join('\n');
        child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', 0);
      });
      return child;
    } });
    const result = await adapter.verify(files, version);
    assert.equal(result.app.appInfo.version, version);
    assert.deepEqual(result.hashes, Object.fromEntries(files.map(entry => [entry.path, entry.sha256])));
    assert.equal(calls.length, 2);
    assert.equal(calls.every(call => call.executable === 'ssh'), true);
    const command = calls[1].args.at(-1);
    assert.equal(command.includes('/assets/wallpapers/northern-lake.png'), true);
    assert.equal(command.includes('/assets/wallpapers/coast.webp'), version === updater.VERSION);
    assert.equal(Object.keys(result.hashes).length, version === updater.VERSION ? 35 : 16);
  }
});

test('Неизвестная версия и чужой состав проверки отклоняются адаптером до сетевого spawn', async () => {
  let calls = 0;
  const adapter = updater.createTransport({ spawn() { calls++; throw Error('network prohibited'); } });
  for (const [files, version] of [
    [ipk().files, updater.ROLLBACK_VERSION], [ipk(updater.ROLLBACK_VERSION).files, updater.VERSION],
    [ipk().files, '0.1.8'], [ipk().files.slice(1), updater.VERSION],
    [ipk().files.map((entry, index) => index ? entry : { ...entry, path: 'foreign.js' }), updater.VERSION],
    [ipk(updater.ROLLBACK_VERSION).files.map((entry, index) => index ? entry : { ...entry, sha256: 'invalid' }), updater.ROLLBACK_VERSION]
  ]) await assert.rejects(adapter.verify(files, version));
  assert.equal(calls, 0);
});

test('Подписка адаптера прекращает обработку при FAILED и не принимает installed другого id', async () => {
  for (const event of [
    { id: updater.APP_ID, details: { state: 'FAILED', reason: 'bad package' } },
    { id: 'org.other', details: { packageId: 'org.other', state: 'installed' } },
    { returnValue: false, errorText: 'Denied' }
  ]) {
    const adapter = updater.createTransport({ spawn() {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { destroy() {} }; child.kill = () => {};
      process.nextTick(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(event))); child.emit('close', 0); });
      return child;
    } });
    await assert.rejects(adapter.install('/tmp/lg-gate-update-' + updater.VERSION + '-112233445566.ipk'));
  }
});

test('Адаптер принимает временный путь отката 0.1.6 и отклоняет прочие версии до spawn', async () => {
  let spawned = 0;
  const adapter = updater.createTransport({ spawn() {
    spawned++;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { destroy() {} }; child.kill = () => {};
    process.nextTick(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: updater.APP_ID, details: { packageId: updater.APP_ID, state: 'installed' } }))));
    return child;
  } });
  const remote = '/tmp/lg-gate-update-' + updater.ROLLBACK_VERSION + '-112233445566.ipk';
  assert.equal((await adapter.install(remote)).installed, true);
  assert.equal(spawned, 1);
  for (const invalid of [remote.replace('0.1.6', '0.1.5'), remote + '\n', '/tmp/../' + remote.slice(5)]) {
    await assert.rejects(adapter.install(invalid), /временный путь/);
  }
  assert.equal(spawned, 1);
});

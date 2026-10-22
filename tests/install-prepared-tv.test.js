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

function ipk(version = updater.VERSION, extraData = []) {
  const entries = ALLOWLIST.map(filename => [filename, filename === 'appinfo.json' ? Buffer.from(JSON.stringify({ ...MANIFEST, version })) : Buffer.from('Prepared contents: ' + filename)]);
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
  const ready = ipk(), rollback = ipk('0.1.3');
  const plan = {
    schema: 1, appId: updater.APP_ID, version: updater.VERSION, ipk: updater.IPK_PATH,
    sha256: hash(ready.bytes), files: ready.files,
    rollback: { ipk: updater.ROLLBACK_PATH, sha256: hash(rollback.bytes) }, expectedDevice: { ...updater.EXPECTED_DEVICE }
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
    app: { returnValue: true, appInfo: { id: updater.APP_ID, title: 'LG Gate', version: '0.1.0' } },
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

test('Без флагов и с --dry-run выполняется только полная локальная проверка', async t => {
  const f = fixture(t);
  let created = 0;
  for (const args of [[], ['--dry-run']]) {
    const result = await updater.main(args, { root: f.root, loadPlan: () => f.plan, createTransport: () => { created++; throw Error('network prohibited'); } });
    assert.equal(result.mode, 'dry-run'); assert.equal(result.ready, true); assert.equal(result.fileCount, 15);
  }
  assert.equal(created, 0);
  assert.deepEqual(updater.loadPlan(f.root), f.plan);
});

test('Неполные, повторные и неизвестные флаги останавливаются до чтения плана/transport', async () => {
  let reads = 0, created = 0;
  for (const args of [['--execute'], ['--tv-free'], ['install'], ['--execute', '--yes'], ['--execute', '--execute'], ['--dry-run', '--execute', '--tv-free'], ['--execute', '--tv-free', '--force']]) {
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

test('Разрешены только SM8200PLA с необязательной диагональю без suffix', () => {
  for (const name of ['SM8200PLA', '55SM8200PLA', '100SM8200PLA']) {
    const d = device(); d.system.modelName = name; assert.equal(updater.validateDevice(d), d);
  }
  for (const name of ['SM8200PLB', '55SM8200PLA.BRU', 'LG 55SM8200PLA', '5SM8200PLA', '1555SM8200PLA', '55SM8200PLA ', '55SM8200PLA\n']) {
    const d = device(); d.system.modelName = name; assert.throws(() => updater.validateDevice(d), /Модель/);
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
  assert.equal(result.verified, true); assert.equal(result.launched, true); assert.equal(result.fileCount, 15);
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
      else if (command.startsWith('sha256sum ')) stdout = 'a'.repeat(64) + '  ' + remote + '\n';
      else if (command.includes('/dev/install')) stdout = JSON.stringify({ subscribed: true, returnValue: true }) + '\n' + JSON.stringify({ id: updater.APP_ID, details: { packageId: updater.APP_ID, state: 'installed' } });
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
  assert.ok(calls.every(call => call.options.shell === false && call.options.windowsHide === true));
  assert.ok(calls.every(call => ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'ConnectTimeout=8'].every(option => call.args.includes(option))));
  assert.equal(calls.find(call => call.executable === 'scp').args[0], '-O');
  assert.ok(calls.filter(call => call.executable === 'ssh').every(call => call.args.includes('lg-tv')));
  assert.ok(children.every(child => child.stdin.destroyed));
  assert.ok(calls.find(call => call.args.at(-1).includes('getSystemInfo')).args.at(-1).includes('"subscribe":false'));
  assert.ok(calls.every(call => !/reboot|defaultApps|startup-enabled|kill -|\/bin\/sh/.test(call.args.at(-1))));
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

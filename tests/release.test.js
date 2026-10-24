'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const release = require('../scripts/prepare-release');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

test('Релиз сохраняет проверенный IPK и сверяет каждый файл с текущими исходниками', () => {
  const ipk = release.verifiedIPK();
  assert.equal(ipk.sha256, 'c0e26b12d0a30f2b296b2f784c16eadf8f1b037e1110f30ab5735cd30c72ca65');
  assert.equal(ipk.files.length, 35);
  const bundle = release.bundleContents(ipk);
  assert.equal(bundle.get('dist/' + release.IPK_NAME), ipk.data);
  for (const name of bundle.keys()) assert.doesNotMatch(name, /(?:^|\/)(?:\.ssh|\.build|node_modules|preview-catalog\.js|install-plan\.json)(?:\/|$)/);
  for (const name of ['LICENSE', 'scripts/manage-tv-home.js', 'scripts/manage-tv-startup.js', 'tv/launcher-startup.py', 'docs/QUICKSTART.md', 'docs/ROOTING.md', 'package-lock.json']) assert.ok(bundle.has(name), name);
  const pkg = JSON.parse(bundle.get('package.json'));
  assert.deepEqual(Object.keys(pkg.scripts), ['devices']);
  assert.equal(pkg.devDependencies['@webos-tools/cli'], '3.2.6');
});

test('Скачивание сторонних файлов отклоняет неизвестный источник, небезопасное имя и неверный хеш', async () => {
  for (const asset of [
    { name: 'tool.zip', url: 'https://example.invalid/tool.zip', sha256: '0'.repeat(64) },
    { name: '../tool.zip', url: 'https://github.com/example/tool.zip', sha256: '0'.repeat(64) }
  ]) await assert.rejects(release.fetchPinned(asset), /Некорректное/);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('modified download') });
  try {
    await assert.rejects(release.fetchPinned({ name: 'bad-download-test.zip', url: 'https://github.com/example/tool.zip', sha256: '0'.repeat(64) }), /SHA256/);
    assert.equal(fs.existsSync(path.resolve(__dirname, '../.build/release-cache/bad-download-test.zip')), false);
  } finally { global.fetch = originalFetch; }
});

test('Установочный ZIP воспроизводим, полностью проверяется и импортирует скрипты без подключения к ТВ', async () => {
  const first = await release.prepareRelease(false, '.build/release-tests/v' + release.VERSION);
  const zipName = 'lg-gate_' + release.VERSION + '_install.zip';
  const filename = path.join(first.output, zipName);
  const firstHash = hash(fs.readFileSync(filename));
  await release.prepareRelease(false, '.build/release-tests/v' + release.VERSION);
  assert.equal(hash(fs.readFileSync(filename)), firstHash);
  const inspected = cp.spawnSync(process.env.PYTHON || 'python', ['-c', [
    'import zipfile,json,sys,hashlib',
    'z=zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'prefix="lg-gate-0.1.7/"',
    'records=z.read(prefix+"SHA256SUMS.txt").decode().splitlines()',
    'for record in records:',
    '    digest,name=record.split("  ",1)',
    '    assert hashlib.sha256(z.read(prefix+name)).hexdigest()==digest',
    'print(json.dumps(z.namelist()))'
  ].join('\n'), filename], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  const actual = JSON.parse(inspected.stdout).map(name => name.replace(/^lg-gate-0\.1\.7\//, '')).sort();
  assert.deepEqual(actual, [...release.bundleContents(release.verifiedIPK()).keys()].sort());
  // All transitive local imports must resolve in the minimal installer ZIP.
  const smoke = cp.spawnSync(process.execPath, ['-e', [
    'const cp=require("node:child_process");',
    'for(const name of ["spawn","spawnSync","execFile","execFileSync","execSync"]) cp[name]=()=>{throw Error("Unexpected device process")};',
    'for(const name of ["manage-tv-home","manage-tv-startup","manage-tv-optimizations","manage-tv-remote"]) require("./scripts/"+name);'
  ].join('\n')], { cwd: first.stage, encoding: 'utf8' });
  assert.equal(smoke.status, 0, smoke.stderr);
});

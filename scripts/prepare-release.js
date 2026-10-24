'use strict';

// Offline unless --with-root-tool is explicitly requested. Never opens a TV
// transport and never runs downloaded code. Preserve the TV-tested IPK bytes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const builder = require('./package-tv');
const { validatePackage, EXPECTED_DEVICE } = require('./install-prepared-tv');
const ROOT = path.resolve(__dirname, '..');
const VERSION = builder.MANIFEST.version;
const IPK_NAME = builder.MANIFEST.id + '_' + VERSION + '_all.ipk';
const OUTPUT = '.build/releases/v' + VERSION;
const BUNDLE_FILES = Object.freeze([
  'package-lock.json', 'docs/QUICKSTART.md', 'docs/INSTALLATION.md', 'docs/ROOTING.md',
  'scripts/manage-tv-home.js', 'scripts/manage-tv-startup.js',
  'scripts/manage-tv-optimizations.js', 'scripts/manage-tv-remote.js',
  'scripts/install-prepared-tv.js', 'scripts/package-tv.js',
  'tv/launcher-startup.py', 'tv/ivi-youtube.js', 'tv/usp-zona.js'
]);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function read(relative) {
  const resolved = builder.projectPath(relative);
  let current = ROOT;
  const parts = path.relative(ROOT, resolved).split(path.sep);
  parts.forEach((part, index) => {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw Error('Релиз принимает только обычные файлы проекта: ' + relative);
    }
  });
  return fs.readFileSync(resolved);
}

function directory(relative) {
  const resolved = builder.projectPath(relative);
  let current = ROOT;
  for (const part of path.relative(ROOT, resolved).split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Некорректная папка релиза.');
  }
  return resolved;
}

function verifiedIPK() {
  const data = read('dist/' + IPK_NAME);
  const record = read('dist/SHA256SUMS.txt').toString('utf8').split(/\r?\n/)
    .filter(line => line.endsWith('  ' + IPK_NAME));
  if (record.length !== 1 || record[0] !== hash(data) + '  ' + IPK_NAME) throw Error('SHA256 опубликованного IPK не совпала.');
  // The transformed HTML and every other packaged byte must match this commit.
  const { stage } = builder.stageApplication();
  const files = builder.ALLOWLIST.map(filename => ({ path: filename, sha256: hash(fs.readFileSync(path.join(stage, filename))) }));
  validatePackage(data, files);
  return { data, files, sha256: hash(data) };
}

function bundleContents(ipk) {
  const contents = new Map(BUNDLE_FILES.map(filename => [filename, read(filename)]));
  const pkg = JSON.parse(read('package.json'));
  // Only ship commands supported by the installer bundle; app sources and
  // development tests remain in the repository and GitHub's source archives.
  pkg.scripts = { devices: 'ares-setup-device --list' };
  pkg.engines = { node: '>=20' };
  contents.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'));
  contents.set('dist/' + IPK_NAME, ipk.data);
  contents.set('README.md', Buffer.from('# LG Gate ' + VERSION + '\n\nНачните с [пошаговой установки](docs/QUICKSTART.md).\n\nStart with docs/QUICKSTART.md (Russian). Requires an already rooted compatible LG TV, Node.js 20+, and OpenSSH on the computer. No build or Git clone is needed.\n\nRoot USB tools are separate release assets; see docs/ROOTING.md. Nothing runs automatically when this ZIP is extracted.\n'));
  contents.set('SHA256SUMS.txt', Buffer.from([...contents].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => hash(data) + '  ' + name).join('\n') + '\n'));
  return contents;
}

async function fetchPinned(asset) {
  const hosts = ['github.com', 'raw.githubusercontent.com', 'codeload.github.com', 'busybox.net', 'cdn.openbsd.org', 'registry.npmjs.org'];
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || !/^[0-9a-f]{64}$/.test(asset.sha256) || !/^[A-Za-z0-9._-]+$/.test(asset.name)) throw Error('Некорректное описание upstream-файла.');
  const cache = directory('.build/release-cache');
  const filename = path.join(cache, asset.name);
  if (fs.existsSync(filename)) {
    const data = read('.build/release-cache/' + asset.name);
    if (hash(data) === asset.sha256) return data;
    throw Error('Кеш upstream-файла повреждён: ' + asset.name);
  }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error('Не удалось скачать ' + asset.name + ': HTTP ' + response.status);
  const data = Buffer.from(await response.arrayBuffer());
  if (hash(data) !== asset.sha256) throw Error('SHA256 upstream-файла не совпала: ' + asset.name);
  fs.writeFileSync(filename, data, { flag: 'wx' });
  return data;
}

function writeZIP(output, name, contents, prefix = '') {
  const stage = fs.mkdtempSync(path.join(directory('.build'), 'release-install-'));
  const entries = [];
  for (const [relative, data] of contents) {
    const filename = path.join(stage, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, data, { flag: 'wx' });
    entries.push({ name: prefix + relative, source: filename });
  }
  const result = cp.spawnSync(process.env.PYTHON || 'python', [path.join(__dirname, 'release-zip.py'), path.join(output, name)], {
    input: JSON.stringify(entries), encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000
  });
  if (result.error || result.status !== 0) throw Error('Для сборки ZIP нужен Python 3: ' + (result.error ? result.error.message : result.stderr));
  return { data: fs.readFileSync(path.join(output, name)), stage };
}

async function prepareRelease(withRootTool = false, outputRelative = OUTPUT) {
  const ipk = verifiedIPK();
  const assets = new Map([[IPK_NAME, ipk.data], ['INSTALLATION.md', read('docs/QUICKSTART.md')], ['ROOTING.md', read('docs/ROOTING.md')]]);
  let upstream, sourceContents;
  if (withRootTool) {
    upstream = JSON.parse(read('release/root-tool.json'));
    for (const asset of upstream.assets) assets.set(asset.name, await fetchPinned(asset));
    assets.set('ROOT-TOOL-NOTICES.md', read('release/ROOT-TOOL-NOTICES.md'));
    if (!/^[A-Za-z0-9._-]+\.zip$/.test(upstream.sourceBundle)) throw Error('Некорректное имя архива исходников.');
    sourceContents = new Map([
      ['root-tool.json', read('release/root-tool.json')],
      ['ROOT-TOOL-NOTICES.md', read('release/ROOT-TOOL-NOTICES.md')]
    ]);
    for (const source of upstream.sources) {
      if (sourceContents.has('sources/' + source.name)) throw Error('Повторный файл исходников.');
      sourceContents.set('sources/' + source.name, await fetchPinned(source));
    }
  }
  const contents = bundleContents(ipk);
  const output = directory(outputRelative);
  const zipName = 'lg-gate_' + VERSION + '_install.zip';
  const expected = [...assets.keys(), zipName, 'release-manifest.json', 'SHA256SUMS.txt', ...(upstream ? [upstream.sourceBundle] : [])];
  for (const filename of fs.readdirSync(output)) {
    const stat = fs.lstatSync(path.join(output, filename));
    if (!expected.includes(filename) || !stat.isFile() || stat.isSymbolicLink()) throw Error('Папка релиза содержит посторонний файл: ' + filename);
  }
  const zip = writeZIP(output, zipName, contents, 'lg-gate-' + VERSION + '/');
  assets.set(zipName, zip.data);
  if (sourceContents) assets.set(upstream.sourceBundle, writeZIP(output, upstream.sourceBundle, sourceContents).data);
  assets.set('release-manifest.json', Buffer.from(JSON.stringify({
    schema: 1, version: VERSION, appId: builder.MANIFEST.id, ipk: IPK_NAME, ipkSha256: ipk.sha256,
    verifiedDevice: EXPECTED_DEVICE, files: ipk.files, rootToolIncluded: withRootTool,
    assets: [...assets].map(([name, data]) => ({ name, bytes: data.length, sha256: hash(data) }))
  }, null, 2) + '\n'));
  assets.set('SHA256SUMS.txt', Buffer.from([...assets].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => hash(data) + '  ' + name).join('\n') + '\n'));
  for (const [name, data] of assets) fs.writeFileSync(path.join(output, name), data);
  console.log('Релиз: ' + output + '\nФайлов: ' + assets.size + '; IPK: ' + ipk.sha256 + '\nZIP проверен; файлы IPK совпадают с исходниками. Телевизор не подключался.');
  return { output, assets: [...assets.keys()], stage: zip.stage };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--with-root-tool')) {
    console.error('Использование: node scripts/prepare-release.js [--with-root-tool]');
    process.exitCode = 1;
  } else prepareRelease(args.length === 1).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { prepareRelease, verifiedIPK, bundleContents, BUNDLE_FILES, IPK_NAME, VERSION, OUTPUT, fetchPinned };

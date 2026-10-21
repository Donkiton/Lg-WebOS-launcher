'use strict';

// Reads only the installed-app catalogue and its PNG icons. The TV receives no
// install, launch, write, reboot, shell expansion or configuration commands.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const PROJECT_ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
const ICON_DIRECTORY = path.join(PROJECT_ROOT, 'assets', 'tv-apps');
const SNAPSHOT_PATH = path.join(PROJECT_ROOT, 'preview-catalog.js');
const HOST_ALIAS = 'lg-tv';
const REMOTE_CATALOG_COMMAND = "luna-send -n 1 -f luna://com.webos.applicationManager/listLaunchPoints '{}'";
const SSH_OPTIONS = ['-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validAppId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id);
}

function validRemoteIcon(filename) {
  if (typeof filename !== 'string' || filename.length > 2000 || !/^\/[A-Za-z0-9_@./-]+\.png$/i.test(filename)) return false;
  const parts = filename.slice(1).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  // No arbitrary root files or remote URLs: only application installation trees.
  return /^\/(?:usr\/palm\/applications|media\/(?:cryptofs|developer|system)\/apps\/usr\/palm\/applications|mnt\/[A-Za-z0-9_-]+\/usr\/palm\/applications)\//.test(filename);
}

function iconCandidates(app) {
  const result = [];
  for (const candidate of [app.largeIcon, app.icon]) {
    if (validRemoteIcon(candidate) && !result.includes(candidate)) result.push(candidate);
  }
  return result;
}

function parseCatalog(output) {
  let payload;
  try { payload = JSON.parse(String(output).replace(/^\uFEFF/, '').trim()); }
  catch (error) { throw new Error('Телевизор вернул некорректный JSON каталога; прежний снимок сохранён.'); }
  if (!payload || payload.returnValue !== true || !Array.isArray(payload.launchPoints) || payload.launchPoints.length > 2000) {
    throw new Error('Телевизор не подтвердил успешное чтение списка launchPoints; прежний снимок сохранён.');
  }
  const result = [];
  const seen = new Set();
  for (const point of payload.launchPoints) {
    if (!point || !validAppId(point.id)) throw new Error('В каталоге встретился небезопасный идентификатор приложения; прежний снимок сохранён.');
    if (seen.has(point.id)) continue;
    seen.add(point.id);
    const app = {
      id: point.id,
      title: typeof point.title === 'string' && point.title.trim() ? point.title.trim() : point.id,
      sources: iconCandidates(point)
    };
    if (typeof point.iconColor === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(point.iconColor)) app.iconColor = point.iconColor;
    if (Number.isSafeInteger(point.installTime) && point.installTime >= 0) app.installTime = point.installTime;
    result.push(app);
  }
  return result;
}

function runProcess(command, args, timeout) {
  return childProcess.spawnSync(command, args, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function readCatalog(run) {
  const result = run('ssh', SSH_OPTIONS.concat([HOST_ALIAS, REMOTE_CATALOG_COMMAND]), 20000);
  if (!result || result.error || result.status !== 0) {
    throw new Error('Не удалось прочитать каталог через SSH alias lg-tv. Проверьте доступность и уже сохранённый ключ узла; прежний снимок сохранён.');
  }
  return parseCatalog(result.stdout);
}

function assertInsideProject(filename) {
  const resolved = path.resolve(filename);
  const relative = path.relative(PROJECT_ROOT, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Локальный путь находится вне проекта.');
  }
  return resolved;
}

function ensureDirectory(directory) {
  const resolved = assertInsideProject(directory);
  const relative = path.relative(PROJECT_ROOT, resolved);
  let current = PROJECT_ROOT;
  if (!relative) return;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Папка снимка не должна быть ссылкой или файлом.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current);
    }
  }
}

function assertFileDestination(filename) {
  const resolved = assertInsideProject(filename);
  ensureDirectory(path.dirname(resolved));
  try {
    const info = fs.lstatSync(resolved);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Файл снимка не должен быть ссылкой или папкой.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolved;
}

function temporaryPath(filename) {
  return assertFileDestination(filename + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
}

function removeTemporary(filename) {
  assertInsideProject(filename);
  try { fs.unlinkSync(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function isPNG(filename) {
  let descriptor;
  try {
    const info = fs.statSync(filename);
    if (!info.isFile() || info.size < 33 || info.size > 10 * 1024 * 1024) return false;
    descriptor = fs.openSync(filename, 'r');
    const header = Buffer.alloc(24);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    return header.subarray(0, 8).equals(PNG_SIGNATURE) && header.toString('ascii', 12, 16) === 'IHDR' &&
      header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0;
  } catch (error) { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function scpArgs(remotePath, localPath) {
  if (!validRemoteIcon(remotePath)) throw new Error('Небезопасный путь значка на телевизоре.');
  return ['-O'].concat(SSH_OPTIONS, [HOST_ALIAS + ':' + remotePath, assertInsideProject(localPath)]);
}

function copyIcon(app, run) {
  const destination = assertFileDestination(path.join(ICON_DIRECTORY, app.id + '.png'));
  for (const source of app.sources) {
    const temporary = temporaryPath(destination);
    try {
      const result = run('scp', scpArgs(source, temporary), 20000);
      if (!result || result.error || result.status !== 0 || !isPNG(temporary)) continue;
      fs.renameSync(temporary, destination);
      return true;
    } finally { removeTemporary(temporary); }
  }
  return false;
}

function snapshotSource(snapshot) {
  // U+2028/U+2029 must be escaped for ES5 engines; no source catalogue paths,
  // device identifiers or unused service response fields are exported.
  const json = JSON.stringify(snapshot, null, 2).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return '(function (root, factory) {\n' +
    "  'use strict';\n" +
    "  if (typeof module === 'object' && module.exports) module.exports = factory();\n" +
    '  else root.LauncherPreviewCatalog = factory();\n' +
    '}(this, function () {\n' +
    "  'use strict';\n" +
    '  return ' + json + ';\n' +
    '}));\n';
}

function writeSnapshot(snapshot) {
  assertFileDestination(SNAPSHOT_PATH);
  const temporary = temporaryPath(SNAPSHOT_PATH);
  try {
    fs.writeFileSync(temporary, snapshotSource(snapshot), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, SNAPSHOT_PATH);
  } finally { removeTemporary(temporary); }
}

function syncCatalog(options) {
  const configuration = options || {};
  const run = configuration.run || runProcess;
  const log = configuration.log || console.log;
  const apps = readCatalog(run);
  const snapshot = { capturedAt: new Date().toISOString(), launchPoints: [] };
  const copied = [];
  const missing = [];
  ensureDirectory(ICON_DIRECTORY);
  assertFileDestination(SNAPSHOT_PATH);
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    const found = copyIcon(app, run);
    const point = { id: app.id, title: app.title, icon: found ? 'assets/tv-apps/' + app.id + '.png' : '' };
    if (app.iconColor !== undefined) point.iconColor = app.iconColor;
    if (app.installTime !== undefined) point.installTime = app.installTime;
    snapshot.launchPoints.push(point);
    (found ? copied : missing).push(app.id);
    log('[' + (i + 1) + '/' + apps.length + '] ' + app.id + ': ' + (found ? 'значок скопирован' : 'значок недоступен; останется текстовая карточка'));
  }
  writeSnapshot(snapshot);
  log('Снимок сохранён: приложений ' + apps.length + ', значков ' + copied.length + ', без значка ' + missing.length + '.');
  return { count: apps.length, copied, missing, capturedAt: snapshot.capturedAt };
}

if (require.main === module) {
  if (process.argv.length !== 2) {
    console.error('Использование: node scripts/sync-tv-catalog.js');
    process.exitCode = 1;
  } else {
    try { syncCatalog(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

module.exports = { validAppId, validRemoteIcon, parseCatalog, readCatalog, scpArgs, snapshotSource, syncCatalog };

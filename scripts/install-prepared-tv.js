'use strict';

// Offline by default. This updater neither creates a network transport on
// import/dry-run nor changes Home, runtime, startup hooks or TV settings.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const cp = require('node:child_process');
const { ALLOWLIST, validateManifest } = require('./package-tv');

const ROOT = path.resolve(__dirname, '..');
const APP_ID = 'org.lggate.launcher';
const VERSION = '0.1.5';
const ROLLBACK_VERSION = '0.1.4';
const PREPARED = '.build/wifi-handoff/';
const PLAN_PATH = PREPARED + 'install-plan.json';
const IPK_PATH = PREPARED + APP_ID + '_' + VERSION + '_all.ipk';
const ROLLBACK_PATH = PREPARED + 'rollback/' + APP_ID + '_' + ROLLBACK_VERSION + '_all.ipk';
const INSTALLED_ROOT = '/media/developer/apps/usr/palm/applications/' + APP_ID;
// sdkVersion is the SDK field from getSystemInfo, not the webOS release label
// recorded in project documentation. Read back on the target TV: 4.10.0.
const EXPECTED_DEVICE = Object.freeze({ model: 'SM8200PLA', firmwareVersion: '05.40.97', sdkVersion: '4.10.0', homebrewVersion: '0.7.3' });
const SSH_OPTIONS = Object.freeze(['-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']);
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REMOTE_PATTERN = new RegExp('^/tmp/lg-gate-update-(?:' + [VERSION, ROLLBACK_VERSION].map(version => version.replace(/\./g, '\\.')).join('|') + ')-[0-9a-f]{12}\\.ipk$');
const validHash = value => typeof value === 'string' && value.length === 64 && HASH.test(value);
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function keys(value, expected, label) {
  if (!object(value) || Object.keys(value).sort().join('\n') !== expected.slice().sort().join('\n')) throw Error('Некорректный состав ' + label + '.');
}

function localFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Небезопасный относительный путь пакета.');
  let current = fs.realpathSync(root);
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw Error('Пакет должен быть обычным файлом внутри проекта.');
  }
  return current;
}

function archiveMembers(data) {
  if (!Buffer.isBuffer(data) || data.subarray(0, 8).toString('ascii') !== '!<arch>\n') throw Error('Подготовленный IPK не является ar-архивом.');
  const members = new Map();
  let offset = 8;
  while (offset < data.length) {
    if (offset + 60 > data.length || data.toString('ascii', offset + 58, offset + 60) !== '`\n') throw Error('Повреждён заголовок IPK.');
    const name = data.toString('ascii', offset, offset + 16).trim().replace(/\/$/, '');
    const sizeText = data.toString('ascii', offset + 48, offset + 58).trim();
    if (!/^\d+$/.test(sizeText)) throw Error('Повреждён размер IPK.');
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || offset + 60 + size > data.length || members.has(name)) throw Error('Повреждён или дублирован файл внутри IPK.');
    members.set(name, data.subarray(offset + 60, offset + 60 + size));
    offset += 60 + size + size % 2;
  }
  if (offset !== data.length || members.size !== 3 || !['debian-binary', 'control.tar.gz', 'data.tar.gz'].every(name => members.has(name)) || members.get('debian-binary').toString('ascii') !== '2.0\n') throw Error('Неожиданный состав IPK.');
  return members;
}

function tarFiles(compressed) {
  const data = zlib.gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  const files = new Map();
  files.directories = [];
  const seen = new Set();
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!data.subarray(offset).every(byte => byte === 0)) throw Error('Данные после конца tar-архива.');
      return files;
    }
    const field = (start, size) => header.toString('utf8', start, start + size).split('\0')[0];
    const sumText = field(148, 8).trim();
    const sizeText = field(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(sumText)) throw Error('Повреждён заголовок tar.');
    const expectedSum = parseInt(sumText, 8);
    const actualSum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (actualSum !== expectedSum) throw Error('Контрольная сумма заголовка tar не совпала.');
    const prefix = field(345, 155);
    const filename = (prefix ? prefix + '/' : '') + field(0, 100);
    const clean = filename.replace(/\/$/, '');
    const size = parseInt(sizeText, 8);
    const kind = field(156, 1) || '0';
    if (!clean || clean.includes('\\') || clean.startsWith('/') || clean.split('/').some(part => !part || part === '.' || part === '..') || seen.has(clean)) throw Error('Небезопасный или повторный путь внутри IPK.');
    if (!Number.isSafeInteger(size) || offset + 512 + size > data.length || !['0', '5'].includes(kind) || (kind === '5' && size !== 0)) throw Error('IPK содержит повреждённый файл или ссылку.');
    seen.add(clean);
    if (kind === '0') files.set(clean, data.subarray(offset + 512, offset + 512 + size));
    else files.directories.push(clean);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error('Отсутствует конец tar-архива.');
}

function validatePackage(data, entries, version = VERSION) {
  if (![VERSION, ROLLBACK_VERSION].includes(version)) throw Error('Неизвестная версия подготовленного пакета.');
  const members = archiveMembers(data);
  const control = tarFiles(members.get('control.tar.gz'));
  if (control.size !== 1 || !control.has('control')) throw Error('Подготовленный пакет содержит неподтверждённые установочные скрипты.');
  const metadata = control.get('control').toString('utf8');
  const lines = metadata.split(/\r?\n/);
  if (control.directories.length || lines.filter(line => /^Package:/i.test(line)).length !== 1 || lines.filter(line => /^Version:/i.test(line)).length !== 1 || !lines.includes('Package: ' + APP_ID) || !lines.includes('Version: ' + version) || !lines.includes('Architecture: all')) throw Error('Контрольные данные IPK не соответствуют плану.');
  const files = tarFiles(members.get('data.tar.gz'));
  const prefix = 'usr/palm/applications/' + APP_ID + '/';
  const packageInfo = 'usr/palm/packages/' + APP_ID + '/packageinfo.json';
  const checkedEntries = entries || ALLOWLIST.map(filename => {
    const contents = files.get(prefix + filename);
    if (!contents) throw Error('В IPK отсутствует разрешённый файл: ' + filename);
    return { path: filename, sha256: hash(contents) };
  });
  validateEntries(checkedEntries);
  if (files.size !== checkedEntries.length + 1 || !files.has(packageInfo)) throw Error('Неожиданный состав приложения внутри IPK.');
  const allowedFiles = checkedEntries.map(entry => prefix + entry.path).concat(packageInfo);
  if (files.directories.some(directory => !allowedFiles.some(filename => filename.startsWith(directory + '/')))) throw Error('IPK содержит неподтверждённую папку.');
  for (const entry of checkedEntries) {
    const contents = files.get(prefix + entry.path);
    if (!contents || hash(contents) !== entry.sha256) throw Error('SHA256 файла внутри IPK не совпала: ' + entry.path);
  }
  const manifest = JSON.parse(files.get(prefix + 'appinfo.json').toString('utf8'));
  if (manifest.version !== version) throw Error('Версия appinfo.json не соответствует подготовленному пакету.');
  // The rollback keeps the same approved manifest schema. Only its explicitly
  // checked previous version differs; the builder remains strict for 0.1.5.
  validateManifest({ ...manifest, version: VERSION });
  const info = JSON.parse(files.get(packageInfo).toString('utf8'));
  if (info.id !== APP_ID || info.app !== APP_ID || info.version !== version) throw Error('packageinfo.json не соответствует LG Gate.');
  return checkedEntries;
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length !== ALLOWLIST.length) throw Error('План не содержит все 15 разрешённых файлов.');
  const seen = new Set();
  for (const entry of entries) {
    keys(entry, ['path', 'sha256'], 'файла приложения');
    if (!ALLOWLIST.includes(entry.path) || seen.has(entry.path) || !validHash(entry.sha256)) throw Error('Неизвестный путь, повтор или SHA256 файла в плане.');
    seen.add(entry.path);
  }
}

function validatePlan(plan, options = {}) {
  keys(plan, ['schema', 'appId', 'version', 'ipk', 'sha256', 'files', 'rollback', 'expectedDevice'], 'плана установки');
  if (plan.schema !== 1 || plan.appId !== APP_ID || plan.version !== VERSION || plan.ipk !== IPK_PATH || !validHash(plan.sha256)) throw Error('План не относится к подготовленному обновлению LG Gate ' + VERSION + '.');
  keys(plan.rollback, ['ipk', 'sha256', 'files'], 'резервной копии');
  if (plan.rollback.ipk !== ROLLBACK_PATH || !validHash(plan.rollback.sha256)) throw Error('Неизвестная резервная копия пакета.');
  keys(plan.expectedDevice, Object.keys(EXPECTED_DEVICE), 'конфигурации ТВ');
  if (Object.keys(EXPECTED_DEVICE).some(key => plan.expectedDevice[key] !== EXPECTED_DEVICE[key])) throw Error('План предназначен для другой конфигурации ТВ.');
  validateEntries(plan.files);
  validateEntries(plan.rollback.files);
  const root = options.root || ROOT;
  const ipkAbsolute = localFile(root, plan.ipk);
  const rollbackAbsolute = localFile(root, plan.rollback.ipk);
  const packageData = fs.readFileSync(ipkAbsolute);
  if (hash(packageData) !== plan.sha256) throw Error('SHA256 подготовленного IPK не совпала.');
  const rollbackData = fs.readFileSync(rollbackAbsolute);
  if (hash(rollbackData) !== plan.rollback.sha256) throw Error('SHA256 резервного IPK не совпала.');
  validatePackage(packageData, plan.files);
  validatePackage(rollbackData, plan.rollback.files, ROLLBACK_VERSION);
  return Object.freeze({
    ...plan, ipkAbsolute, rollbackAbsolute,
    files: Object.freeze(plan.files.map(entry => Object.freeze({ ...entry }))),
    expectedDevice: EXPECTED_DEVICE, rollback: Object.freeze({ ...plan.rollback, files: Object.freeze(plan.rollback.files.map(entry => Object.freeze({ ...entry }))) })
  });
}

function appInfo(reply, id, versions) {
  if (!object(reply) || reply.returnValue !== true || !object(reply.appInfo) || reply.appInfo.id !== id || !versions.includes(reply.appInfo.version)) throw Error('Не подтверждена версия установленного приложения ' + id + '.');
  if (id === APP_ID && reply.appInfo.title !== 'LG Gate') throw Error('Установленное приложение не является известным LG Gate.');
  return reply.appInfo;
}

function validateDevice(device, expected = EXPECTED_DEVICE) {
  if (!object(device) || device.uid !== '0') throw Error('Для обновления требуется существующий root-доступ.');
  const system = device.system;
  if (!object(system) || system.returnValue !== true || typeof system.modelName !== 'string' || system.modelName.trim() !== system.modelName || !/^(?:[0-9]{2,3})?SM8200PLA$/.test(system.modelName) || system.firmwareVersion !== expected.firmwareVersion || system.sdkVersion !== expected.sdkVersion) throw Error('Модель, прошивка или webOS телевизора не совпадает с проверенной конфигурацией.');
  appInfo(device.app, APP_ID, ['0.1.0', '0.1.1', '0.1.2', '0.1.3', ROLLBACK_VERSION, VERSION]);
  appInfo(device.homebrew, 'org.webosbrew.hbchannel', [expected.homebrewVersion]);
  const marker = device.session;
  if (typeof device.bootId !== 'string' || device.bootId.length !== 36 || !UUID.test(device.bootId) || !object(marker) || marker.version !== 1 || marker.bootId !== device.bootId || typeof marker.sessionId !== 'string' || marker.sessionId.length !== 24 || !/^[0-9a-f]{24}$/.test(marker.sessionId) || marker.sleeping !== false) throw Error('Нет действующего wake marker текущего включения. Требуется отдельная проверка runtime; автоматическая установка остановлена.');
  return device;
}

function parseFrames(text, partial = false) {
  const result = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (/\s/.test(c)) continue;
      if (c !== '{') throw Error('Неожиданный ответ установщика webOS.');
      start = i; depth = 1; continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { result.push(JSON.parse(text.slice(start, i + 1))); start = -1; }
  }
  if (start >= 0 && !partial) throw Error('Незавершённый ответ установщика webOS.');
  return result;
}

function terminalInstall(text, partial) {
  let installed = false;
  for (const event of parseFrames(text, partial)) {
    const state = event.details && event.details.state;
    if (event.returnValue === false || typeof state === 'string' && /failed|failure|cancelled|canceled|error/i.test(state)) throw Error('webOS отклонила установку: ' + (event.errorText || event.details && event.details.reason || state || 'ошибка'));
    if (event.id && event.id !== APP_ID) throw Error('Установщик ответил для другого приложения.');
    if (state === 'installed') {
      if (event.id !== APP_ID || event.details.packageId !== APP_ID) throw Error('Не подтверждён terminal installed для LG Gate.');
      installed = true;
    }
  }
  return installed;
}

function createTransport(options = {}) {
  const spawn = options.spawn || cp.spawn;
  function run(executable, args, subscription = false) {
    return new Promise((resolve, reject) => {
      let child, timer, output = '', stderr = '', settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child && child.stdin) child.stdin.destroy();
        if (error) reject(error); else resolve(result);
      };
      const stop = (error, result) => {
        finish(error, result);
        if (child) child.kill();
      };
      try { child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { finish(error); return; }
      timer = setTimeout(() => stop(subscription ? null : Error('Истекло время ответа телевизора.'), { stdout: output, timedOut: true, installed: false }), subscription ? 60000 : executable === 'scp' ? 30000 : 15000);
      child.on('error', error => stop(error));
      child.stdout.on('data', data => {
        if (settled) return;
        output += data.toString('utf8');
        if (Buffer.byteLength(output) > 1024 * 1024) { stop(Error('Ответ телевизора превысил ограничение.')); return; }
        if (subscription) {
          try { if (terminalInstall(output, true)) stop(null, { stdout: output, timedOut: false, installed: true }); }
          catch (error) { stop(error); }
        }
      });
      child.stderr.on('data', data => { if (stderr.length < 4096) stderr += data.toString('utf8').slice(0, 4096 - stderr.length); });
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) { finish(Error(executable + ' завершился с ошибкой: ' + stderr.trim())); return; }
        if (subscription) {
          try {
            const installed = terminalInstall(output, false);
            if (!installed) { finish(Error('Подписка установки завершилась без terminal installed.')); return; }
            finish(null, { stdout: output, timedOut: false, installed: true });
          } catch (error) { finish(error); }
        } else finish(null, { stdout: output, timedOut: false });
      });
      // Do not close stdin here: luna-send on the target firmware exits on EOF.
    });
  }
  const ssh = async (command, subscription = false) => run('ssh', SSH_OPTIONS.concat(['lg-tv', command]), subscription);
  async function rpc(uri, params) {
    const reply = JSON.parse((await ssh('luna-send -n 1 -f ' + quote(uri) + ' ' + quote(JSON.stringify(params)))).stdout);
    if (reply.returnValue !== true) throw Error(reply.errorText || 'webOS отклонила запрос.');
    return reply;
  }
  const remotePath = remote => {
    if (!REMOTE_PATTERN.test(remote)) throw Error('Неожиданный временный путь IPK.');
    return remote;
  };
  return {
    async preflight() {
      const uid = (await ssh('id -u')).stdout.trim();
      if (uid !== '0') throw Error('Для обновления требуется существующий root-доступ.');
      const system = await rpc('luna://com.webos.service.tv.systemproperty/getSystemInfo', { keys: ['modelName', 'sdkVersion', 'firmwareVersion'], subscribe: false });
      const app = await rpc('luna://com.webos.applicationManager/getAppInfo', { id: APP_ID });
      const homebrew = await rpc('luna://com.webos.applicationManager/getAppInfo', { id: 'org.webosbrew.hbchannel' });
      const rawMarker = (await ssh('head -c 513 /tmp/lg-gate-session.json')).stdout;
      if (Buffer.byteLength(rawMarker) > 512) throw Error('Wake marker превышает ограничение.');
      const session = JSON.parse(rawMarker);
      const bootId = (await ssh('head -c 80 /proc/sys/kernel/random/boot_id')).stdout.trim();
      return { uid, system, app, homebrew, session, bootId };
    },
    async upload(local, remote) { await run('scp', ['-O'].concat(SSH_OPTIONS, [local, 'lg-tv:' + remotePath(remote)])); },
    async sha256(remote) {
      const output = (await ssh('sha256sum ' + quote(remotePath(remote)))).stdout.trim();
      const match = output.match(/^([0-9a-f]{64}) [ *](.+)$/);
      if (!match || match[2] !== remote) throw Error('Некорректная SHA256 загруженного IPK.');
      return match[1];
    },
    async install(remote) {
      const params = { id: APP_ID, ipkUrl: remotePath(remote), subscribe: true };
      return ssh('luna-send -i -f luna://com.webos.appInstallService/dev/install ' + quote(JSON.stringify(params)), true);
    },
    async verify(files) {
      if (!Array.isArray(files) || files.length !== ALLOWLIST.length || new Set(files.map(entry => entry.path)).size !== ALLOWLIST.length || files.some(entry => !ALLOWLIST.includes(entry.path))) throw Error('Некорректный состав проверки файлов.');
      const app = await rpc('luna://com.webos.applicationManager/getAppInfo', { id: APP_ID });
      const output = (await ssh('sha256sum ' + files.map(entry => quote(INSTALLED_ROOT + '/' + entry.path)).join(' '))).stdout.trim();
      const hashes = {};
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
        const relative = match && match[2].startsWith(INSTALLED_ROOT + '/') ? match[2].slice(INSTALLED_ROOT.length + 1) : '';
        if (!match || !ALLOWLIST.includes(relative) || Object.prototype.hasOwnProperty.call(hashes, relative)) throw Error('Некорректная SHA256 установленного файла.');
        hashes[relative] = match[1];
      }
      return { app, hashes };
    },
    async launch() { return rpc('luna://com.webos.applicationManager/launch', { id: APP_ID, params: {} }); }
  };
}

async function installVerified(plan, transport, rollback = false) {
  validateDevice(await transport.preflight(), plan.expectedDevice);
  const version = rollback ? ROLLBACK_VERSION : VERSION;
  const target = rollback ? { ...plan.rollback, ipkAbsolute: plan.rollbackAbsolute } : plan;
  const remote = '/tmp/lg-gate-update-' + version + '-' + target.sha256.slice(0, 12) + '.ipk';
  await transport.upload(target.ipkAbsolute, remote);
  if (await transport.sha256(remote) !== target.sha256) throw Error('SHA256 переданного IPK не совпала. Установка не запрошена.');
  const receipt = await transport.install(remote);
  if (!object(receipt) || receipt.failed || receipt.installed !== true && receipt.timedOut !== true) throw Error('Установка не сообщила terminal installed и не завершилась разрешённым таймаутом.');
  // Even an installed event is insufficient. Check exact installed version and
  // every prepared file independently before launching the new application.
  const actual = await transport.verify(target.files);
  appInfo(actual && actual.app, APP_ID, [version]);
  if (!object(actual.hashes) || Object.keys(actual.hashes).length !== target.files.length || target.files.some(entry => actual.hashes[entry.path] !== entry.sha256)) throw Error('SHA256 установленного приложения не совпала. Запуск отменён.');
  const launch = await transport.launch();
  if (!launch || launch.returnValue !== true) throw Error('Обновление проверено, но запуск приложения не подтверждён.');
  return { mode: 'execute', rollback, installed: true, verified: true, launched: true, appId: APP_ID, version, sha256: target.sha256, fileCount: target.files.length, installTimedOut: receipt.timedOut === true };
}

async function install(plan, transport, options = {}) {
  return installVerified(validatePlan(plan, options), transport, options.rollback === true);
}

function loadPlan(root = ROOT) {
  const filename = localFile(root, PLAN_PATH);
  const raw = fs.readFileSync(filename, 'utf8');
  if (Buffer.byteLength(raw) > 65536) throw Error('План установки превышает ограничение.');
  return JSON.parse(raw);
}

async function main(argv = [], deps = {}) {
  const rollback = argv.includes('--rollback');
  const flags = argv.filter(arg => arg !== '--rollback');
  const unique = new Set(argv).size === argv.length;
  const dryRun = unique && (flags.length === 0 || flags.length === 1 && flags[0] === '--dry-run');
  const execute = unique && flags.length === 2 && flags.includes('--execute') && flags.includes('--tv-free');
  if (!dryRun && !execute) throw Error('Использование: node scripts/install-prepared-tv.js [--rollback] [--dry-run] | [--rollback] --execute --tv-free. Оба флага нужны только после команды пользователя и освобождения ТВ.');
  const raw = await (deps.loadPlan || (() => loadPlan(deps.root || ROOT)))();
  const plan = validatePlan(raw, { root: deps.root || ROOT });
  const target = rollback ? plan.rollback : plan;
  if (dryRun) return { mode: 'dry-run', ready: true, appId: APP_ID, version: rollback ? ROLLBACK_VERSION : VERSION, ipk: target.ipk, sha256: target.sha256, fileCount: target.files.length, rollback: plan.rollback.ipk, expectedDevice: plan.expectedDevice, executeCommand: 'node scripts/install-prepared-tv.js' + (rollback ? ' --rollback' : '') + ' --execute --tv-free' };
  const transport = await (deps.createTransport || createTransport)();
  return installVerified(plan, transport, rollback);
}

if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { main, loadPlan, validatePlan, validatePackage, validateDevice, install, createTransport, APP_ID, VERSION, ROLLBACK_VERSION, EXPECTED_DEVICE, PLAN_PATH, IPK_PATH, ROLLBACK_PATH, INSTALLED_ROOT };

'use strict';

// Installs only LG Gate's own Homebrew user hook and runtime. No system scripts
// or unrelated init.d hooks are changed. Device actions require an explicit verb.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { APP_ID, ssh, quote, validateBackup } = require('./manage-tv-home');
const ROOT = '/var/lib/lg-gate';
const RUNTIME = ROOT + '/launcher-startup.py';
const ENABLED = ROOT + '/startup-enabled';
const BACK_ENABLED = ROOT + '/back-enabled';
const DEPLOYMENT = ROOT + '/startup-deployment.json';
const HOOK = '/var/lib/webosbrew/init.d/50-lg-gate';
const PID = '/tmp/lg-gate-startup.pid';
const SOURCE = path.resolve(__dirname, '..', 'tv', 'launcher-startup.py');
const HOOK_SOURCE = '#!/bin/sh\n# Managed by LG Gate: boot, wake and final app return.\n' +
  '[ -f ' + ENABLED + ' ] || exit 0\n' +
  '[ -r ' + RUNTIME + ' ] || exit 0\n' +
  'nohup /usr/bin/python -u ' + RUNTIME + ' --run > /tmp/lg-gate-startup.log 2>&1 < /dev/null &\nexit 0\n';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function validateDeployment(record) {
  if (!record || record.version !== 1 || record.appId !== APP_ID || !/^[a-f0-9]{64}$/.test(record.runtimeHash) || !/^[a-f0-9]{64}$/.test(record.hookHash)) throw Error('Неизвестная запись установки автозапуска.');
  if (record.backReturnVersion !== undefined && record.backReturnVersion !== 1) throw Error('Неизвестная версия возврата Back.');
  return record;
}
function scp(source, target) {
  return new Promise((resolve, reject) => {
    cp.execFile('scp', ['-O', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', source, 'lg-tv:' + target], { windowsHide: true, shell: false, timeout: 20000 }, error => error ? reject(error) : resolve());
  });
}
async function readDeployment() {
  const raw = await ssh('if test -f ' + quote(DEPLOYMENT) + '; then cat ' + quote(DEPLOYMENT) + '; fi');
  return raw.trim() ? validateDeployment(JSON.parse(raw)) : null;
}
async function status() {
  const reply = await ssh('if test -f ' + quote(ENABLED) + '; then echo enabled; else echo disabled; fi; if test -f ' + quote(PID) + '; then p=$(cat ' + quote(PID) + '); case "$p" in *[!0-9]*|\'\') exit 0;; esac; if test -r "/proc/$p/cmdline"; then tr "\\000" " " < "/proc/$p/cmdline"; fi; fi; if test -f ' + quote(BACK_ENABLED) + '; then echo back-enabled; fi');
  return { enabled: reply.split('\n')[0] === 'enabled', running: reply.indexOf(RUNTIME + ' --run') >= 0, backEnabled: reply.indexOf('back-enabled') >= 0, deployment: await readDeployment() };
}
async function setBackEnabled(enabled) {
  const deployment = await readDeployment();
  if (!deployment || (enabled && deployment.backReturnVersion !== 1)) throw Error('Сначала установите runtime с поддержкой возврата Back: enable.');
  if (enabled) {
    const actual = (await ssh('sha256sum ' + quote(RUNTIME))).trim().split(/\s+/)[0];
    if (actual !== deployment.runtimeHash) throw Error('Runtime изменён вне установщика; включение возврата остановлено.');
  }
  await ssh(enabled ? 'touch ' + quote(BACK_ENABLED) : 'rm -f ' + quote(BACK_ENABLED));
  return status();
}
async function stopRuntime() {
  // Validate PID contents and current cmdline before signaling; no pkill/killall.
  await ssh('if test -f ' + quote(PID) + '; then p=$(cat ' + quote(PID) + '); case "$p" in *[!0-9]*|\'\') exit 1;; esac; if test -r "/proc/$p/cmdline"; then cmd=$(tr "\\000" " " < "/proc/$p/cmdline"); case "$cmd" in *' + quote(RUNTIME + ' --run') + '*) kill -TERM "$p";; *) echo "PID не принадлежит LG Gate" >&2; exit 1;; esac; fi; fi');
  // Wait for cleanup and flock release before starting a replacement process.
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!(await status()).running) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('Предыдущий runtime ещё завершает работу; новый не запущен.');
}
async function disable() {
  const deployment = await readDeployment();
  if (!deployment) {
    const present = await ssh('if test -e ' + quote(HOOK) + ' -o -e ' + quote(ENABLED) + ' -o -e ' + quote(BACK_ENABLED) + '; then echo unknown; fi');
    if (present.trim()) throw Error('Автозапуск не отмечен как установленный LG Gate; файлы оставлены для проверки.');
    return { enabled: false, running: false, backEnabled: false, deployment: null };
  }
  const actual = (await ssh('if test -f ' + quote(HOOK) + '; then sha256sum ' + quote(HOOK) + '; fi')).trim();
  if (actual && actual.split(/\s+/)[0] !== deployment.hookHash) throw Error('Загрузочный hook изменён вне установщика; отключение остановлено.');
  await ssh('rm -f ' + quote(ENABLED) + ' ' + quote(BACK_ENABLED));
  await stopRuntime();
  await ssh('rm -f ' + quote(HOOK));
  return status();
}
async function enable() {
  if (!fs.existsSync(SOURCE)) throw Error('Нет исходника tv/launcher-startup.py.');
  if ((await ssh('id -u')).trim() !== '0') throw Error('Для автозапуска требуется существующий root-доступ.');
  const backup = JSON.parse(await ssh('cat /var/lib/lg-gate/home-original.json'));
  validateBackup(backup);
  const preflight = JSON.parse(await ssh('luna-send -n 1 -f luna://com.webos.applicationManager/getAppInfo ' + quote(JSON.stringify({ id: APP_ID }))));
  if (preflight.returnValue !== true || !preflight.appInfo || preflight.appInfo.id !== APP_ID) throw Error('LG Gate не установлен.');
  const previous = await readDeployment();
  const backEnabled = previous && previous.backReturnVersion === 1 ? (await status()).backEnabled : true;
  if (previous) {
    const actual = (await ssh('if test -f ' + quote(HOOK) + '; then sha256sum ' + quote(HOOK) + '; fi')).trim();
    if (actual && actual.split(/\s+/)[0] !== previous.hookHash) throw Error('Существующий hook изменён вне установщика.');
    const runtime = (await ssh('if test -f ' + quote(RUNTIME) + '; then sha256sum ' + quote(RUNTIME) + '; fi')).trim();
    if (runtime && runtime.split(/\s+/)[0] !== previous.runtimeHash) throw Error('Существующий runtime изменён вне установщика.');
  } else {
    await ssh('test ! -e ' + quote(HOOK) + ' && test ! -e ' + quote(RUNTIME));
  }
  const source = fs.readFileSync(SOURCE);
  const runtimeHash = hash(source);
  const temporary = ROOT + '/.launcher-startup-' + crypto.randomBytes(6).toString('hex') + '.py';
  await scp(SOURCE, temporary);
  const actualHash = (await ssh('sha256sum ' + quote(temporary))).trim().split(/\s+/)[0];
  if (actualHash !== runtimeHash) throw Error('Контрольная сумма runtime не совпала.');
  // Parse on the actual Python 2.7 before replacing or starting anything.
  await ssh('/usr/bin/python -c ' + quote('import ast; ast.parse(open(' + JSON.stringify(temporary) + ').read())'));
  // The TV ships a reduced Python standard library. Parsing alone cannot detect
  // absent modules; execute the read-only mode before changing a working hook.
  const inspected = JSON.parse(await ssh('/usr/bin/python ' + quote(temporary) + ' --inspect'));
  if (inspected.appId !== APP_ID || inspected.manifestPresent !== true) throw Error('Проверка runtime на телевизоре не пройдена.');
  if (inspected.backSupported !== true) throw Error('Runtime не сообщил поддержку возврата Back.');
  const record = { version: 1, appId: APP_ID, runtimeHash, hookHash: hash(HOOK_SOURCE), backReturnVersion: 1, installedAt: new Date().toISOString() };
  if (previous) {
    await ssh('rm -f ' + quote(ENABLED));
    await stopRuntime();
  }
  await ssh('chmod 700 ' + quote(temporary) + ' && mv ' + quote(temporary) + ' ' + quote(RUNTIME) +
    ' && umask 077 && printf %s ' + quote(HOOK_SOURCE) + ' > ' + quote(HOOK + '.next') +
    ' && /bin/sh -n ' + quote(HOOK + '.next') + ' && chmod 755 ' + quote(HOOK + '.next') +
    ' && printf %s ' + quote(JSON.stringify(record)) + ' > ' + quote(DEPLOYMENT + '.next') +
    ' && mv ' + quote(HOOK + '.next') + ' ' + quote(HOOK) +
    ' && mv ' + quote(DEPLOYMENT + '.next') + ' ' + quote(DEPLOYMENT) +
    ' && touch ' + quote(ENABLED) +
    ' && ' + (backEnabled ? 'touch ' : 'rm -f ') + quote(BACK_ENABLED) + ' && sync');
  await ssh('/bin/sh ' + quote(HOOK));
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await status();
    if (current.running) return current;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('Runtime не запустился. Проверьте /tmp/lg-gate-startup.log.');
}
async function main(action) {
  if (action === 'status') return status();
  if (action === 'enable') return enable();
  if (action === 'disable') return disable();
  if (action === 'back-enable') return setBackEnabled(true);
  if (action === 'back-disable') return setBackEnabled(false);
  throw Error('Команда: node scripts/manage-tv-startup.js status | enable | disable | back-enable | back-disable');
}
if (require.main === module) main(process.argv[2]).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, enable, disable, status, setBackEnabled, validateDeployment, HOOK_SOURCE };

'use strict';

// Local packaging only. This script never invokes SSH, installation, launch or
// device-configuration commands. LG CLI reference:
// https://webostv.developer.lge.com/develop/tools/cli-dev-guide
// https://webostv.developer.lge.com/develop/references/appinfo-json
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const PROJECT_ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
const STAGE_DIRECTORY = path.join(PROJECT_ROOT, '.build', 'tv-app');
const DIST_DIRECTORY = path.join(PROJECT_ROOT, 'dist');
const CLI_STATE_DIRECTORY = path.join(PROJECT_ROOT, '.build', 'cli-state');
const CLI_TEMP_DIRECTORY = path.join(PROJECT_ROOT, '.build', 'cli-temp');
const CLI_VERSION = '3.2.6';
const ALLOWLIST = Object.freeze([
  'appinfo.json', 'index.html', 'portal.html', 'app.js', 'msx-catalog.js', 'platform.js', 'wallpaper.js', 'home-state.js', 'styles.css',
  'assets/wallpapers/morning.png', 'assets/wallpapers/day.png', 'assets/wallpapers/night.png',
  'assets/wallpapers/northern-lake.png',
  'assets/wallpapers/coast.webp', 'assets/wallpapers/coast-thumb.webp',
  'assets/wallpapers/city.webp', 'assets/wallpapers/city-thumb.webp',
  'assets/wallpapers/zen.webp', 'assets/wallpapers/zen-thumb.webp',
  'assets/wallpapers/obsidian.webp', 'assets/wallpapers/obsidian-thumb.webp',
  'assets/wallpapers/orbit.webp', 'assets/wallpapers/orbit-thumb.webp',
  'assets/wallpapers/aurora.webp', 'assets/wallpapers/aurora-thumb.webp',
  'assets/wallpapers/holiday.webp', 'assets/wallpapers/holiday-thumb.webp',
  'assets/wallpapers/northern-lake-thumb.webp', 'assets/wallpapers/morning-thumb.webp',
  'assets/wallpapers/day-thumb.webp', 'assets/wallpapers/evening-thumb.webp', 'assets/wallpapers/night-thumb.webp',
  'assets/mountain-sunset.png', 'assets/app-icon.png', 'assets/app-icon-large.png'
]);
const MANIFEST = Object.freeze({
  id: 'org.lggate.launcher', version: '0.1.7', type: 'web', main: 'index.html', title: 'LG Gate',
  icon: 'assets/app-icon.png', largeIcon: 'assets/app-icon-large.png', iconColor: '#0b1726',
  resolution: '1920x1080', disableBackHistoryAPI: true, handlesRelaunch: false, transparent: false
});

function projectPath(filename) {
  const resolved = path.resolve(PROJECT_ROOT, filename);
  const relative = path.relative(PROJECT_ROOT, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Путь сборки находится вне проекта.');
  }
  return resolved;
}

function ensureDirectory(directory) {
  const relative = path.relative(PROJECT_ROOT, projectPath(directory));
  let current = PROJECT_ROOT;
  if (!relative) return;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Папка сборки не должна быть ссылкой или файлом: ' + current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current);
    }
  }
}

function regularFile(filename) {
  const resolved = projectPath(filename);
  const parts = path.relative(PROJECT_ROOT, resolved).split(path.sep);
  let current = PROJECT_ROOT;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error('Сборка принимает только обычные файлы внутри проекта: ' + current);
    }
  }
  return resolved;
}

function fileDestination(filename) {
  const resolved = projectPath(filename);
  ensureDirectory(path.dirname(resolved));
  try { regularFile(resolved); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return resolved;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Некорректный appinfo.json.');
  const actual = Object.keys(manifest).sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(MANIFEST).sort())) {
    throw new Error('appinfo.json содержит пропущенные или неподтверждённые поля. Дополнительные права не включены в пробную сборку.');
  }
  for (const key of Object.keys(MANIFEST)) {
    if (manifest[key] !== MANIFEST[key]) throw new Error('Неожиданное значение appinfo.json: ' + key);
  }
  return manifest;
}

function stripPreviewScript(html) {
  const result = html.replace(/^[ \t]*<script\b[^>]*\bsrc\s*=\s*(["'])preview-catalog\.js\1[^>]*>\s*<\/script>[ \t]*\r?\n?/gim, '');
  if (/<script\b[^>]*preview-catalog/i.test(result)) throw new Error('Не удалось исключить браузерный каталог из index.html.');
  return result;
}

function validateLocalReference(reference, owner) {
  const value = reference.trim();
  if (!value || value[0] === '#' || /^data:/i.test(value)) return;
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|\\)/.test(value) || value.includes('\\')) throw new Error('В ТВ-странице обнаружен внешний ресурс: ' + owner);
  const clean = value.split(/[?#]/)[0];
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(owner), clean));
  if (!ALLOWLIST.includes(normalized)) throw new Error('Ресурс отсутствует в разрешённом составе ТВ-приложения: ' + normalized);
}

function validateReferences(html, css) {
  let match;
  const htmlReference = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi;
  while ((match = htmlReference.exec(html))) validateLocalReference(match[2], 'index.html');
  if (/@import\b/i.test(css)) throw new Error('Внешние CSS-импорты не включены в пробную ТВ-сборку.');
  const cssReference = /url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi;
  while ((match = cssReference.exec(css))) validateLocalReference(match[2], 'styles.css');
}

function pngSize(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Значок приложения должен быть PNG.');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function validateFileList(files, requireComplete) {
  const extra = files.filter(file => !ALLOWLIST.includes(file));
  if (extra.length) throw new Error('В staging найдены лишние файлы; они сохранены без удаления: ' + extra.join(', '));
  if (requireComplete && (files.length !== ALLOWLIST.length || ALLOWLIST.some(file => !files.includes(file)))) {
    throw new Error('Staging не содержит полный разрешённый состав приложения.');
  }
}

function stageFiles() {
  const result = [];
  function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Staging не должен содержать ссылки.');
      if (entry.isDirectory()) {
        if (relative !== 'assets' && relative !== 'assets/wallpapers') throw new Error('Лишняя папка в staging сохранена без удаления: ' + relative);
        walk(path.join(directory, entry.name), relative + '/');
      } else if (entry.isFile()) result.push(relative);
      else throw new Error('Неподдерживаемый тип файла в staging.');
    }
  }
  walk(STAGE_DIRECTORY, '');
  return result.sort();
}

function verifyStage() {
  const files = stageFiles();
  validateFileList(files, true);
  const manifest = validateManifest(JSON.parse(fs.readFileSync(regularFile(path.join(STAGE_DIRECTORY, 'appinfo.json')), 'utf8')));
  const html = fs.readFileSync(regularFile(path.join(STAGE_DIRECTORY, 'index.html')), 'utf8');
  if (/<script\b[^>]*preview-catalog/i.test(html)) throw new Error('Браузерный каталог попал в ТВ-страницу.');
  validateReferences(html, fs.readFileSync(regularFile(path.join(STAGE_DIRECTORY, 'styles.css')), 'utf8'));
  for (const [filename, dimension] of [[manifest.icon, 80], [manifest.largeIcon, 130]]) {
    const size = pngSize(fs.readFileSync(regularFile(path.join(STAGE_DIRECTORY, filename))));
    if (size.width !== dimension || size.height !== dimension) throw new Error('Неверный размер значка: ' + filename);
  }
  return { manifest, files, stage: STAGE_DIRECTORY };
}

function stageApplication() {
  // Read the entire allowlist before changing staging. No discovery/copy of
  // unrelated workspace files, browser snapshots or downloaded TV app icons.
  const sources = new Map(ALLOWLIST.map(filename => [filename, fs.readFileSync(regularFile(filename))]));
  validateManifest(JSON.parse(sources.get('appinfo.json').toString('utf8')));
  const html = stripPreviewScript(sources.get('index.html').toString('utf8'));
  validateReferences(html, sources.get('styles.css').toString('utf8'));
  ensureDirectory(STAGE_DIRECTORY);
  validateFileList(stageFiles(), false);
  sources.set('index.html', Buffer.from(html));
  for (const [filename, contents] of sources) {
    fs.writeFileSync(fileDestination(path.join(STAGE_DIRECTORY, filename)), contents);
  }
  return verifyStage();
}

function cliEnvironment() {
  ensureDirectory(CLI_STATE_DIRECTORY);
  ensureDirectory(CLI_TEMP_DIRECTORY);
  // Only these child processes receive isolated local CLI state/temp paths.
  return Object.assign({}, process.env, { APPDATA: CLI_STATE_DIRECTORY, TEMP: CLI_TEMP_DIRECTORY, TMP: CLI_TEMP_DIRECTORY, TMPDIR: CLI_TEMP_DIRECTORY });
}

function packageArguments() {
  return ['--no-minify', '--outdir', DIST_DIRECTORY, STAGE_DIRECTORY];
}

function packageTV() {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Сборка IPK требует Node.js 20 или новее. Предпросмотр npm start работает с Node.js 18+.');
  let cliPackage;
  try { cliPackage = require.resolve('@webos-tools/cli/package.json'); }
  catch (error) { throw new Error('Сначала установите зависимости сборки: npm ci --ignore-scripts'); }
  if (JSON.parse(fs.readFileSync(cliPackage, 'utf8')).version !== CLI_VERSION) throw new Error('Для воспроизводимой сборки нужен @webos-tools/cli@' + CLI_VERSION);
  const verification = stageApplication();
  ensureDirectory(DIST_DIRECTORY);
  const ipk = fileDestination(path.join(DIST_DIRECTORY, verification.manifest.id + '_' + verification.manifest.version + '_all.ipk'));
  const cli = path.join(path.dirname(cliPackage), 'bin', 'ares-package.js');
  const environment = cliEnvironment();
  for (const args of [['--check', STAGE_DIRECTORY], packageArguments()]) {
    const result = childProcess.spawnSync(process.execPath, [cli].concat(args), { cwd: PROJECT_ROOT, env: environment, shell: false, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('Официальный ares-package завершился с ошибкой: ' + (result.error ? result.error.message : (result.stderr || result.stdout).trim()));
    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
  }
  const data = fs.readFileSync(regularFile(ipk));
  if (data.subarray(0, 8).toString('ascii') !== '!<arch>\n') throw new Error('Официальный упаковщик не создал ожидаемый IPK-архив.');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  console.log('IPK: ' + ipk);
  console.log('SHA256: ' + sha256);
  console.log('Манифест проверен; файлов приложения: ' + verification.files.length + '. Установка на ТВ не выполнялась.');
  return { ipk, sha256, bytes: data.length, verification };
}

if (require.main === module) {
  try {
    if (process.argv.length === 2) packageTV();
    else if (process.argv.length === 3 && process.argv[2] === '--stage-only') {
      const result = stageApplication();
      console.log('Staging проверен: ' + result.stage + ', файлов: ' + result.files.length);
    } else throw new Error('Использование: node scripts/package-tv.js [--stage-only]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { ALLOWLIST, MANIFEST, STAGE_DIRECTORY, projectPath, validateManifest, stripPreviewScript, validateReferences, pngSize, validateFileList, stageApplication, verifyStage, packageArguments, packageTV };

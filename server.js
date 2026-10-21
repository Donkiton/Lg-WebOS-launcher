'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = fs.realpathSync(__dirname);
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const PUBLIC_FILES = new Set(['index.html', 'portal.html', 'app.js', 'preview-catalog.js', 'msx-catalog.js', 'platform.js', 'home-state.js', 'styles.css']);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT должен быть целым числом от 1 до 65535.');
}

function isPublicPath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  const parts = relativePath.split(/[\\/]/);
  if (parts.some(part => !part || part.startsWith('.'))) return false;
  if (PUBLIC_FILES.has(relativePath)) return true;
  return parts.length > 1 && parts[0] === 'assets' &&
    Object.prototype.hasOwnProperty.call(MIME_TYPES, path.extname(relativePath).toLowerCase());
}

function reply(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  response.end(message);
}

const server = http.createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    reply(response, 405, 'Метод не поддерживается.');
    return;
  }

  let requestedPath;
  try {
    requestedPath = decodeURIComponent((request.url || '/').split('?')[0]);
  } catch {
    reply(response, 400, 'Некорректный адрес.');
    return;
  }

  if (!requestedPath.startsWith('/') || /[\\\0]/.test(requestedPath)) {
    reply(response, 400, 'Некорректный адрес.');
    return;
  }

  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.slice(1);
  if (!isPublicPath(relativePath)) {
    reply(response, 404, 'Файл не найден.');
    return;
  }

  try {
    const filename = await fs.promises.realpath(path.resolve(ROOT, relativePath));
    const resolvedRelativePath = path.relative(ROOT, filename);
    if (!isPublicPath(resolvedRelativePath)) {
      reply(response, 404, 'Файл не найден.');
      return;
    }
    const stat = await fs.promises.stat(filename);
    if (!stat.isFile()) {
      reply(response, 404, 'Файл не найден.');
      return;
    }

    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filename).toLowerCase()],
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(filename);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch (error) {
    const missing = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code);
    reply(response, missing ? 404 : 500, missing ? 'Файл не найден.' : 'Ошибка чтения файла.');
  }
});

server.on('error', error => {
  console.error('Не удалось запустить предпросмотр: ' + error.message);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log('Предпросмотр лаунчера: http://' + HOST + ':' + PORT);
  console.log('Для остановки нажмите Ctrl+C.');
});

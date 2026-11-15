'use strict';
var crypto = require('crypto');
var VERSION = 'public-graphics-cache-v2';
function isGraphic(address, type) {
  type = String(type || '').toLowerCase();
  return /^image\//.test(type) || (/^application\/octet-stream(?:;|$)/.test(type) && /\.(?:jpe?g|png|webp|gif|svg|ico)$/i.test(address.split('?')[0]));
}
function isStaticCacheable(address, type) {
  var pathname = address.split('?')[0];
  type = String(type || '').toLowerCase();
  if (isGraphic(address, type)) return true;
  if (/\.js$/i.test(pathname)) return /^(?:application|text)\/(?:javascript|ecmascript|x-javascript)(?:;|$)/.test(type);
  if (/\.css$/i.test(pathname)) return /^text\/css(?:;|$)/.test(type);
  if (/\.woff2?$/i.test(pathname)) return /^(?:font\/|application\/(?:font-woff|octet-stream)(?:;|$))/.test(type);
  return false;
}
function tag(body) { return '"lg-gate-img-' + crypto.createHash('sha256').update(body).digest('hex') + '"'; }
function matches(value, etag) {
  if (!value || !etag) return false;
  return String(value).split(',').some(function (candidate) {
    candidate = candidate.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === etag;
  });
}
function send(req, res, address, status, type, body, completeRepresentation) {
  var graphic = status === 200 && (req.method === 'GET' || req.method === 'HEAD') && isGraphic(address, type);
  var headers = { 'Content-Type': type, 'Cache-Control': graphic ? 'public, max-age=86400' : 'no-store' };
  var etag = graphic && completeRepresentation ? tag(body) : null;
  if (etag) headers.ETag = etag;
  if (etag && matches(req.headers && req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers); res.end(); return;
  }
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}
exports.version = VERSION;
exports.isGraphic = isGraphic;
exports.isStaticCacheable = isStaticCacheable;
exports.send = send;
exports.tag = tag;

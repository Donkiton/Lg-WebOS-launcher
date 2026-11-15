'use strict';
var fs = require('fs'), path = require('path'), url = require('url'), crypto = require('crypto'), constants = require('constants');
var VERSION = 'persistent-catalog-images-v1';
var MAGIC = 'LGGATEIMG1\n', PREFIX = Buffer.byteLength(MAGIC) + 9, HEADER_MAX = 1024, BLOCK = 4096;
var FILE = /^([a-f0-9]{64})\.zimg$/, STAGE = /^[a-f0-9]{64}\.zimg\.tmp-[1-9][0-9]*-[a-f0-9]{16}$/;
function limit(value, fallback) { return typeof value === 'number' && isFinite(value) && value > 0 ? Math.min(Math.floor(value), fallback) : fallback; }
function charge(bytes) { return Math.ceil(bytes / BLOCK) * BLOCK; }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function number(value) { return typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value; }
function corrupt(reason) { var error = new Error(reason); error.cacheCorrupt = true; return error; }
function addressInfo(address) {
  if (typeof address !== 'string' || address.length > 2048 || /[\x00-\x20\x7f\\]/.test(address)) return null;
  var parsed = url.parse(address);
  if (parsed.protocol !== 'https:' || parsed.auth || parsed.port || parsed.hash || !/^img[0-9]+\.zonapic\.com$/i.test(parsed.hostname || '')) return null;
  var match = /^\/images\/[a-z0-9_.\/-]+\.(jpg|jpeg|png|webp|gif)$/i.exec(parsed.pathname || '');
  if (!match || /(^|\/)\.\.?($|\/)/.test(parsed.pathname)) return null;
  return { key: digest(address), extension: match[1].toLowerCase() };
}
function rasterType(type, extension) {
  type = String(type || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/octet-stream') type = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[extension] || '';
  return /^(image\/jpeg|image\/png|image\/webp|image\/gif)$/.test(type) ? type : null;
}
function magicMatches(body, type) {
  if (!Buffer.isBuffer(body)) return false;
  if (type === 'image/jpeg') return body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255;
  if (type === 'image/png') return body.length >= 8 && body.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (type === 'image/webp') return body.length >= 12 && body.slice(0, 4).toString('ascii') === 'RIFF' && body.slice(8, 12).toString('ascii') === 'WEBP' && body.readUInt32LE(4) + 8 === body.length;
  if (type === 'image/gif') return body.length >= 6 && /^(GIF87a|GIF89a)$/.test(body.slice(0, 6).toString('ascii'));
  return false;
}

function Cache(directory, options) {
  options = options || {};
  this.fs = options.fs || fs; this.now = options.now || Date.now;
  this.maxBytes = limit(options.maxBytes, 16 * 1024 * 1024);
  this.maxEntries = limit(options.maxEntries, 512);
  this.maxItemBytes = limit(options.maxItemBytes, 1024 * 1024);
  this.ttlMs = limit(options.ttlMs, 7 * 86400000);
  this.touchIntervalMs = limit(options.touchIntervalMs, 3600000);
  this.entries = Object.create(null); this.count = 0; this.bytes = 0; this.logicalBytes = 0; this.reservedBytes = 0; this.sequence = 0;
  this.enabled = false; this.reason = directory ? 'initializing' : 'no-directory';
  this.counters = { hits: 0, misses: 0, writes: 0, evictions: 0, errors: 0, corruptions: 0, expirations: 0, touches: 0, rejected: 0 };
  if (!directory) return;
  try {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Cache directory must be absolute');
    this.directory = path.resolve(directory);
    this._checkPath(true);
    this.identity = this.fs.lstatSync(this.directory);
    this.enabled = true; this.reason = null;
    this._recover();
  } catch (error) { this._disable('directory-unavailable'); }
}
Cache.prototype._disable = function (reason) { this.enabled = false; this.reason = reason; this.counters.errors++; };
Cache.prototype._checkPath = function (create) {
  var current = this.directory, parts = [], parent;
  for (;;) { parts.unshift(current); parent = path.dirname(current); if (parent === current) break; current = parent; }
  for (var i = 0; i < parts.length; i++) {
    var stat;
    try { stat = this.fs.lstatSync(parts[i]); }
    catch (error) {
      if (!create || i !== parts.length - 1 || error.code !== 'ENOENT') throw error;
      this.fs.mkdirSync(parts[i], 448); stat = this.fs.lstatSync(parts[i]);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe cache directory');
    if (i === parts.length - 1) {
      if (process.platform !== 'win32' && ((stat.mode & 63) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Cache directory is not private');
      if (this.identity && !sameFile(stat, this.identity)) throw new Error('Cache directory changed');
    }
  }
};
Cache.prototype._guard = function () { if (!this.enabled) return false; try { this._checkPath(false); return true; } catch (error) { this._disable('unsafe-directory'); return false; } };
Cache.prototype._stat = function (filename, expected) {
  var stat = this.fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > this.maxItemBytes || expected && !sameFile(stat, expected)) {
    this._disable('unsafe-entry'); throw new Error('Unsafe cache entry');
  }
  return stat;
};
Cache.prototype._read = function (filename, key, stat, withBody) {
  var fd = this.fs.openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  var owned = false;
  try {
    var opened = this.fs.fstatSync(fd);
    if (!sameFile(stat, opened) || !opened.isFile() || opened.nlink !== 1 || opened.size !== stat.size) { this._disable('entry-changed'); throw new Error('Cache entry changed'); }
    var prefix = new Buffer(PREFIX);
    var prefixRead = this.fs.readSync(fd, prefix, 0, PREFIX, 0);
    owned = prefixRead >= MAGIC.length && prefix.slice(0, MAGIC.length).toString('ascii') === MAGIC;
    if (prefixRead !== PREFIX || !owned) throw corrupt('Invalid cache prefix');
    var sizeText = prefix.slice(MAGIC.length, PREFIX - 1).toString('ascii');
    if (!/^[a-f0-9]{8}$/.test(sizeText) || prefix[PREFIX - 1] !== 10) throw corrupt('Invalid cache header size');
    var size = parseInt(sizeText, 16);
    if (!size || size > HEADER_MAX) throw corrupt('Cache header limit');
    var rawHeader = new Buffer(size);
    if (this.fs.readSync(fd, rawHeader, 0, size, PREFIX) !== size) throw corrupt('Truncated cache header');
    var header;
    try { header = JSON.parse(rawHeader.toString('utf8')); } catch (error) { throw corrupt('Invalid cache JSON'); }
    if (!header || header.v !== 1 || header.key !== key || !/^[a-f0-9]{64}$/.test(header.sha || '') || !rasterType(header.type) ||
        !number(header.length) || !header.length || !number(header.created) || header.created > this.now() + 300000 ||
        PREFIX + size + header.length !== stat.size || stat.size > this.maxItemBytes) throw corrupt('Cache header mismatch');
    var result = { type: header.type, created: header.created, header: header };
    if (withBody) {
      var body = new Buffer(header.length), offset = 0;
      while (offset < body.length) { var read = this.fs.readSync(fd, body, offset, body.length - offset, PREFIX + size + offset); if (!read) throw corrupt('Truncated image'); offset += read; }
      if (digest(body) !== header.sha || !magicMatches(body, header.type)) throw corrupt('Image integrity mismatch');
      result.body = body;
    }
    return result;
  } catch (error) { if (error.cacheCorrupt) error.cacheOwned = owned; throw error; }
  finally { this.fs.closeSync(fd); }
};
Cache.prototype._add = function (key, stat, created) {
  var modified = stat.mtime.getTime(), now = this.now();
  var access = Math.max(created, Math.min(now, isFinite(modified) ? modified : created));
  this.entries[key] = { key: key, filename: path.join(this.directory, key + '.zimg'), stat: stat, created: created,
    lastAccess: access, lastTouch: access, sequence: ++this.sequence, bytes: charge(stat.size), logical: stat.size, invalid: false };
  this.count++; this.bytes += charge(stat.size); this.logicalBytes += stat.size;
};
Cache.prototype._forget = function (entry) { delete this.entries[entry.key]; this.count--; this.bytes -= entry.bytes; this.logicalBytes -= entry.logical; };
Cache.prototype._unlink = function (filename, expected) {
  if (!this._guard()) return false;
  try { this._stat(filename, expected); this.fs.unlinkSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return true; this.counters.errors++; return false; }
};
Cache.prototype._remove = function (entry, reason) {
  if (!this._unlink(entry.filename, entry.stat)) return false;
  this._forget(entry); this.counters.evictions++;
  if (reason === 'expired') this.counters.expirations++;
  return true;
};
Cache.prototype._reserve = function (bytes, slots) {
  while (this.bytes + bytes > this.maxBytes || this.count + slots > this.maxEntries) {
    var oldest = null, keys = Object.keys(this.entries);
    for (var i = 0; i < keys.length; i++) { var item = this.entries[keys[i]]; if (!oldest || item.lastAccess < oldest.lastAccess || item.lastAccess === oldest.lastAccess && item.sequence < oldest.sequence) oldest = item; }
    if (!oldest || !this._remove(oldest, 'budget')) return false;
  }
  return this.enabled;
};
Cache.prototype._recover = function () {
  var names = this.fs.readdirSync(this.directory), records = [], i;
  if (names.length > 1024) { this._disable('scan-limit'); return; }
  // Inventory first: do not read/delete anything if any foreign name or link exists.
  for (i = 0; i < names.length; i++) {
    if (!FILE.test(names[i]) && !STAGE.test(names[i])) { this._disable('foreign-entry'); return; }
    var filename = path.join(this.directory, names[i]);
    records.push({ filename: filename, name: names[i], stat: this._stat(filename) });
  }
  for (i = 0; i < records.length && this.enabled; i++) {
    var record = records[i];
    if (STAGE.test(record.name)) { if (!this._unlink(record.filename, record.stat)) this._disable('staging-recovery-error'); continue; }
    var key = FILE.exec(record.name)[1];
    try {
      var parsed = this._read(record.filename, key, record.stat, false);
      this._add(key, record.stat, parsed.created);
      if (this.now() - parsed.created >= this.ttlMs) this._remove(this.entries[key], 'expired');
    } catch (error) {
      if (!this.enabled) return;
      if (!error.cacheCorrupt || !error.cacheOwned) { this._disable('foreign-or-unreadable-entry'); return; }
      this.counters.corruptions++;
      if (!this._unlink(record.filename, record.stat)) this._disable('corruption-recovery-error');
    }
  }
  if (!this.enabled || !this._reserve(0, 0)) return;
  // Only the bounded retained set is hashed (at most16MiB, one item at a time).
  var keys = Object.keys(this.entries);
  for (i = 0; i < keys.length && this.enabled; i++) {
    var entry = this.entries[keys[i]];
    try { this._read(entry.filename, entry.key, entry.stat, true); }
    catch (error) {
      if (!this.enabled) return;
      if (!error.cacheCorrupt || !error.cacheOwned) { this._disable('foreign-or-unreadable-entry'); return; }
      this.counters.corruptions++; entry.invalid = true; this._remove(entry, 'corrupt');
    }
  }
};
Cache.prototype.get = function (address) {
  var info = addressInfo(address), entry = info && this.entries[info.key];
  if (!this._guard() || !entry || entry.invalid) { this.counters.misses++; return null; }
  if (this.now() - entry.created >= this.ttlMs) { this._remove(entry, 'expired'); this.counters.misses++; return null; }
  try {
    var stat = this._stat(entry.filename, entry.stat), result = this._read(entry.filename, info.key, stat, true), now = this.now();
    entry.lastAccess = now; entry.sequence = ++this.sequence;
    if (now - entry.lastTouch >= this.touchIntervalMs) {
      entry.lastTouch = now;
      var touchFd = null;
      try {
        this._stat(entry.filename, entry.stat);
        touchFd = this.fs.openSync(entry.filename, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
        var touchStat = this.fs.fstatSync(touchFd);
        if (!sameFile(touchStat, entry.stat) || !touchStat.isFile() || touchStat.nlink !== 1) { this._disable('touch-entry-changed'); throw new Error('Cache entry changed'); }
        this.fs.futimesSync(touchFd, new Date(now), new Date(now)); this.counters.touches++;
      } catch (touchError) { this.counters.errors++; }
      finally { if (touchFd !== null) { try { this.fs.closeSync(touchFd); } catch (closeError) { this.counters.errors++; } } }
    }
    this.counters.hits++; return { type: result.type, body: result.body };
  } catch (error) {
    if (error.cacheCorrupt && error.cacheOwned) { this.counters.corruptions++; entry.invalid = true; this._remove(entry, 'corrupt'); }
    else if (error.cacheCorrupt) this._disable('foreign-or-unreadable-entry');
    else if (error.code === 'ENOENT') this._forget(entry);
    else this.counters.errors++;
    this.counters.misses++; return null;
  }
};
Cache.prototype.set = function (address, value) {
  var info = addressInfo(address), type = info && value && rasterType(value.type, info.extension);
  if (!info || !type || !value || !magicMatches(value.body, type) || value.body.length > this.maxItemBytes) { this.counters.rejected++; return false; }
  if (!this._guard()) return false;
  var header = new Buffer(JSON.stringify({ v: 1, key: info.key, type: type, length: value.body.length, sha: digest(value.body), created: this.now() }), 'utf8');
  var length = header.length.toString(16); while (length.length < 8) length = '0' + length;
  var content = Buffer.concat([new Buffer(MAGIC + length + '\n', 'ascii'), header, value.body]);
  var required = charge(content.length);
  if (header.length > HEADER_MAX || content.length > this.maxItemBytes || required > this.maxBytes) { this.counters.rejected++; return false; }
  var previous = this.entries[info.key];
  if (previous && !this._remove(previous, 'replace')) return false;
  if (!this._reserve(required, 1)) return false;
  var filename = path.join(this.directory, info.key + '.zimg'), stage = null;
  var fd = null, created = false, renamed = false, stageStat = null;
  this.reservedBytes = required;
  try {
    stage = filename + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
    try { this.fs.lstatSync(filename); this._disable('unexpected-destination'); return false; } catch (existing) { if (existing.code !== 'ENOENT') throw existing; }
    fd = this.fs.openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 384);
    created = true; stageStat = this.fs.fstatSync(fd);
    var offset = 0;
    while (offset < content.length) { var written = this.fs.writeSync(fd, content, offset, content.length - offset, offset); if (!written) throw new Error('Short cache write'); offset += written; }
    this.fs.fsyncSync(fd); this.fs.closeSync(fd); fd = null;
    this._stat(stage, stageStat);
    if (!this._guard()) throw new Error('Cache directory changed');
    this.fs.renameSync(stage, filename); renamed = true;
    var stat = this._stat(filename, stageStat);
    this._add(info.key, stat, this.now()); this.counters.writes++; return true;
  } catch (error) {
    this.counters.errors++;
    if (renamed) this._disable('write-state-error');
    return false;
  } finally {
    if (fd !== null) { try { this.fs.closeSync(fd); } catch (closeError) { this.counters.errors++; } }
    if (created && !renamed && !this._unlink(stage, stageStat)) this._disable('staging-cleanup-error');
    this.reservedBytes = 0;
  }
};
Cache.prototype.stats = function () {
  var result = { version: VERSION, enabled: this.enabled, disabledReason: this.reason, entries: this.count,
    bytes: this.bytes + this.reservedBytes, logicalBytes: this.logicalBytes, allocationBlockBytes: BLOCK,
    maxBytes: this.maxBytes, maxEntries: this.maxEntries, maxItemBytes: this.maxItemBytes, ttlMs: this.ttlMs, touchIntervalMs: this.touchIntervalMs };
  var counters = this.counters; Object.keys(counters).forEach(function (key) { result[key] = counters[key]; }); return result;
};
module.exports = Cache;
module.exports.version = VERSION;

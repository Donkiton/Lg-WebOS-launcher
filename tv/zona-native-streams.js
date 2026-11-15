'use strict';

// Android source metadata only. No source key or signed media URL is logged.
// Both the cache and in-flight identity include the episode, including movies ''.
var VERSION = 'android-source-metadata-v1';
function integer(value, minimum, maximum) {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= minimum && value <= maximum;
}
function identifier(value) {
  if (typeof value === 'string' && /^[1-9][0-9]{0,11}$/.test(value)) value = Number(value);
  if (!integer(value, 1, 999999999999)) throw new Error('Invalid content identifier');
  return value;
}
function episodeKey(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^S[0-9]{2,4}E[0-9]{2,6}$/.test(value)) throw new Error('Invalid episode identity');
  return value;
}
function field(row, camel, snake) {
  if (Object.prototype.hasOwnProperty.call(row, camel) && Object.prototype.hasOwnProperty.call(row, snake) && row[camel] !== row[snake]) {
    throw new Error('Conflicting source aliases');
  }
  return Object.prototype.hasOwnProperty.call(row, camel) ? row[camel] : row[snake];
}
function normalizeRow(row, kpId, episode) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid Android source');
  var movie = identifier(field(row, 'kinopoiskId', 'kinopoisk_id'));
  var sourceEpisode = episodeKey(field(row, 'episodeKey', 'episode_key'));
  if (movie !== kpId || sourceEpisode !== episode) throw new Error('Android source identity mismatch');
  var type = field(row, 'videoSourceTypeId', 'video_source_type_id');
  var link = field(row, 'downloadLinkKey', 'download_link_key');
  if (!integer(type, 1, 1000) || typeof link !== 'string' || !link.length || link.length > 32768) throw new Error('Invalid required Android source fields');
  var result = { kinopoiskId: movie, episodeKey: sourceEpisode, videoSourceTypeId: type, downloadLinkKey: link };
  if (row.id !== undefined && row.id !== null) {
    if (typeof row.id === 'number' && !integer(row.id, 0, 9007199254740991)) throw new Error('Unsafe Android source identifier');
    if (typeof row.id !== 'number' && (typeof row.id !== 'string' || !/^[0-9]{1,24}$/.test(row.id))) throw new Error('Invalid Android source identifier');
    result.id = String(row.id);
  }
  if (row.info !== undefined && row.info !== null) {
    if (typeof row.info !== 'string' || row.info.length > 131072) throw new Error('Invalid Android source info');
    result.info = row.info;
  }
  var contentType = field(row, 'videoContentTypeId', 'video_content_type_id');
  if (contentType !== undefined && contentType !== null) {
    if (!integer(contentType, 0, 1000)) throw new Error('Invalid Android source content type');
    result.videoContentTypeId = contentType;
  }
  return result;
}
function create(options) {
  options = options || {};
  var native = options.native;
  if (!native || typeof native.request !== 'function') throw new Error('Native API dependency missing');
  var now = options.now || Date.now;
  var later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  var cache = [], pending = Object.create(null), bytes = 0, hits = 0, requests = 0;
  var maximumBytes = 2 * 1024 * 1024, maximumEntries = 16, ttl = 90000;
  function getSources(value, requestedEpisode, callback) {
    var kpId, episode;
    try { kpId = identifier(value); episode = episodeKey(requestedEpisode); }
    catch (error) { callback(error); return; }
    var key = kpId + ':' + episode, i, time = now();
    for (i = cache.length - 1; i >= 0; i--) {
      if (time - cache[i].at >= ttl) { bytes -= cache[i].bytes; cache.splice(i, 1); }
      else if (cache[i].key === key) {
        var entry = cache.splice(i, 1)[0]; cache.push(entry); hits++;
        callback(null, JSON.parse(entry.json)); return;
      }
    }
    if (pending[key]) {
      if (pending[key].length >= 8) { callback(new Error('Source metadata waiter limit')); return; }
      pending[key].push(callback); return;
    }
    if (Object.keys(pending).length >= 4) { callback(new Error('Source metadata concurrency limit')); return; }
    pending[key] = [callback]; requests++;
    var settled = false, timer = later(function () { finish(new Error('Android source metadata deadline')); }, 22000);
    function finish(error, value) {
      if (settled) return; settled = true;
      cancel(timer);
      var callbacks = pending[key]; delete pending[key];
      callbacks.forEach(function (cb) { try { cb(error, value && JSON.parse(JSON.stringify(value))); } catch (ignoreConsumer) {} });
    }
    try {
      native.request('/getVideoSources', { kinopoiskId: kpId, episodeKey: episode, movieSourceTypes: native.sourceTypes || [] }, function (error, raw) {
        if (settled) return;
        if (error) { finish(error); return; }
        try {
          if (!raw || !Array.isArray(raw.data) || raw.data.length > 128) throw new Error('Invalid Android source list');
          var data = raw.data.map(function (row) { return normalizeRow(row, kpId, episode); });
          var value = { data: data }, json = JSON.stringify(value), size = Buffer.byteLength(json, 'utf8');
          if (size > 1024 * 1024) throw new Error('Android source metadata size limit');
          // Empty responses are not retained: a temporary provider failure can
          // recover on the next opening instead of looking like missing content.
          if (data.length) {
            while (cache.length && (cache.length >= maximumEntries || bytes + size > maximumBytes)) bytes -= cache.shift().bytes;
            cache.push({ key: key, json: json, bytes: size, at: now() }); bytes += size;
          }
          finish(null, value);
        } catch (failure) { finish(failure); }
      });
    } catch (error) { finish(error); }
  }
  return {
    getSources: getSources,
    stats: function () { return { version: VERSION, entries: cache.length, bytes: bytes, pending: Object.keys(pending).length, hits: hits, requests: requests }; }
  };
}
exports.create = create;
exports.normalizeRow = normalizeRow;
exports.identifier = identifier;
exports.episodeKey = episodeKey;
exports.version = VERSION;

'use strict';
// Public anonymous HDrezka2 page/translation contract, native APK3.0.77 Ac/v.
// Authentication, Premium and anti-bot challenges are deliberately not solved.
var JUNK = ['$$#!!@#!@##', '^^^!@##!!##', '####^!!##!@@', '@@@@@!##!^^^', '$$!!@$$@^!@#$$@'];
function fail(message) { return new Error('HDREZKA_' + message); }
function plain(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&#([0-9]+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
function attrs(tag) {
  var out = {}, re = /([\w-]+)\s*=\s*(["'])(.*?)\2/g, m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3];
  return out;
}
function page(value) {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) throw fail('PAGE_INVALID');
  if (/anubis_challenge|techaro\.lol|<title>Sign In<\/title>|b-player__restricted__block_message/i.test(value)) throw fail('AUTH_OR_CHALLENGE_REQUIRED');
  var init = /initCDN(?:Series|Movies)Events\(\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!init) throw fail('PAGE_CONTRACT_CHANGED');
  var translations = [], seen = {}, re = /<(li|a)\b([^>]*data-translator_id[^>]*)>([\s\S]*?)<\/\1>/gi, m;
  while ((m = re.exec(value))) {
    var a = attrs(m[2]), id = a['data-translator_id'];
    if (!/^\d+$/.test(id || '') || seen[id] || /b-prem_translator/.test(m[0])) continue;
    seen[id] = true;
    translations.push({id: id, title: plain(a.title || m[3]), contentId: a['data-id'] || init[1],
      camrip: a['data-camrip'] || '0', ads: a['data-ads'] || '0', director: a['data-director'] || '0'});
  }
  if (!translations.length) translations.push({id: init[2], contentId: init[1], title: '', camrip: '0', ads: '0', director: '0'});
  var favs = '', inputs = /<input\b[^>]*>/gi;
  while ((m = inputs.exec(value))) { var input = attrs(m[0]); if (input.id === 'ctrl_favs') favs = input.value || ''; }
  return {translations: translations.slice(0, 24), favs: favs};
}
function decode(value) {
  if (typeof value !== 'string' || value.length > 1024 * 1024) throw fail('STREAM_FORMAT_INVALID');
  if (value.charAt(0) !== '#') return value;
  value = value.slice(2).replace(/\\\//g, '/');
  for (var i = JUNK.length - 1; i >= 0; i--) value = value.split('//_//' + new Buffer(JUNK[i], 'utf8').toString('base64')).join('');
  if (!/^[A-Za-z0-9+/=\s]*$/.test(value)) throw fail('STREAM_FORMAT_INVALID');
  return new Buffer(value, 'base64').toString('utf8');
}
function streams(value, translation, config, referer) {
  var data = typeof value === 'string' ? JSON.parse(value) : value;
  if (!data || data.success === false) throw fail('TRANSLATION_UNAVAILABLE');
  var raw = decode(data.url || data.streams || ''), re = /\[([^\]]+)\]([^,]+)/g, m, out = [];
  while ((m = re.exec(raw))) {
    var alternatives = m[2].split(' or '), quality = m[1], address = '';
    for (var i = 0; i < alternatives.length; i++) {
      var candidate = alternatives[i].replace(/\\\//g, '/').trim();
      if (candidate.indexOf('//') === 0) candidate = 'https:' + candidate;
      if (/^https?:\/\/[^\s]+$/i.test(candidate)) {address = candidate; break;}
    }
    if (!address) continue;
    var headers = {Referer: referer}; if (config.userAgent) headers['User-Agent'] = config.userAgent;
    out.push({source: {url: address, headers: headers}, translation: translation, language: /English|Original|Оригинал/i.test(translation) ? 'en' : /Украин|Ukr/i.test(translation) ? 'uk' : 'ru',
      resolution: config.qualityFixMap && config.qualityFixMap[quality] || quality, isTrailer: false});
  }
  return out;
}
function create(options) {
  options = options || {};
  var native = options.native, http = options.http, portable = options.portable;
  if (!native || typeof native.request !== 'function' || typeof http !== 'function' || !portable) throw fail('DEPENDENCY_MISSING');
  var later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  var cached = null, at = 0, configWaiters = null;
  function config(callback) {
    if (cached && Date.now() - at < 300000) return callback(null, cached);
    if (configWaiters) { configWaiters.push(callback); return; }
    configWaiters = [callback];
    function finish(error, c) {
      var waiters = configWaiters; configWaiters = null;
      if (!error) { cached = c; at = Date.now(); }
      waiters.forEach(function (cb) { cb(error, c); });
    }
    http({url: 'https://vsr01.zonasearch.com/static/cfg/ext2.cfg', timeoutMs: 6000, maxBytes: 1024 * 1024, stage: 'rezka-config'}, function (e, r) {
      if (e || !r || r.statusCode !== 200) return finish(fail('CONFIG_UNAVAILABLE'));
      var c;
      try { c = portable.decodeConfig(r.body, (r.headers || {})['content-encoding']); if (!c || !Array.isArray(c.hosts) || !c.hosts.length) throw fail('CONFIG_INVALID'); }
      catch (error) { return finish(fail('CONFIG_INVALID')); }
      finish(null, c);
    });
  }
  function getStreams(id, episode, callback) {
    if (!/^[1-9][0-9]{0,11}$/.test(String(id)) || typeof episode !== 'string' || !/^(?:S[0-9]{2,4}E[0-9]{2,6})?$/.test(episode)) return callback(fail('IDENTITY_INVALID'));
    id = Number(id);
    var done = false, output = [], timer = later(function () { finish(output.length ? null : fail('DEADLINE')); }, 21000);
    function finish(error) { if (done) return; done = true; cancel(timer); callback(error, {items: output.length ? [{extractorType: {id: 2, name: 'HDREZKA'}, videoStreams: output}] : []}); }
    native.request('/getVideoSources', {kinopoiskId: id, episodeKey: episode, movieSourceTypes: native.sourceTypes || ['2']}, function (error, result) {
      if (done) return; if (error) return finish(fail('SOURCES_UNAVAILABLE'));
      var rows = result && result.data;
      if (!Array.isArray(rows) || !rows.every(function (x) { return Number(x.kinopoisk_id) === id && String(x.episode_key || '') === episode; })) return finish(fail('IDENTITY_MISMATCH'));
      var row = rows.filter(function (x) { return Number(x.video_source_type_id) === 2; })[0];
      if (!row) return finish(null);
      var key = row.download_link_key;
      if (typeof key !== 'string' || !/^[A-Za-z0-9_/-]+(?:\.html)?$/.test(key) || key.indexOf('..') >= 0) return finish(fail('SOURCE_KEY_INVALID'));
      config(function (error, c) {
        if (done) return; if (error) return finish(error);
        var host = c.hosts.filter(function (x) { return /^https:\/\/[A-Za-z0-9.-]+$/.test(x); })[0];
        if (!host) return finish(fail('HOST_INVALID'));
        var address = host + '/' + key.replace(/^\//, '') + (/\.html$/.test(key) ? '' : '.html');
        var headers = {}; Object.keys(c.appHeaders || {}).forEach(function (k) { if (/^(?:User-Agent|Accept|Accept-Encoding)$/i.test(k)) headers[k] = c.appHeaders[k]; });
        http({url: address, headers: headers, timeoutMs: 7000, maxBytes: 2 * 1024 * 1024, stage: 'rezka-page'}, function (error, response) {
          if (done) return; if (error || !response || response.statusCode !== 200) return finish(fail('PAGE_UNAVAILABLE'));
          var parsed;
          try { parsed = page(response.body.toString('utf8')); } catch (error) { return finish(error); }
          var cookies = (response.headers || {})['set-cookie'] || [];
          if (typeof cookies === 'string') cookies = [cookies];
          var cookie = cookies.map(function (x) { return String(x).split(';')[0]; }).join('; '), next = 0, active = 0, remaining = parsed.translations.length;
          function pump() {
            while (!done && active < 4 && next < parsed.translations.length) {
              (function (t) {
                active++; var p = {id: t.contentId, translator_id: t.id, is_camrip: t.camrip, is_ads: t.ads, is_director: t.director, favs: parsed.favs};
                if (episode) {var match = /^S(\d+)E(\d+)$/.exec(episode); p.action = 'get_stream'; p.season = Number(match[1]); p.episode = Number(match[2]);} else p.action = 'get_movie';
                var body = Object.keys(p).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]); }).join('&');
                var h = {Referer: address, Origin: host, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest'};
                if (c.userAgent) h['User-Agent'] = c.userAgent; if (cookie) h.Cookie = cookie;
                http({url: host + '/ajax/get_cdn_series/?t=' + Date.now(), method: 'POST', body: body, headers: h, timeoutMs: 6000, maxBytes: 1024 * 1024, stage: 'rezka-translation'}, function (error, r) {
                  if (done) return;
                  if (!error && r && r.statusCode === 200) { try { output = output.concat(streams(r.body.toString('utf8'), t.title, c, address)); } catch (unavailable) {} }
                  active--; remaining--; if (!remaining) finish(output.length ? null : fail('STREAMS_UNAVAILABLE')); else pump();
                });
              }(parsed.translations[next++]));
            }
          }
          pump();
        });
      });
    });
  }
  return {name: 'HDREZKA', getStreams: getStreams};
}
exports.create = create;
exports.parsePage = page;
exports.parseStreams = streams;
exports.decode = decode;
exports.version = 'hdrezka-anonymous-v1';

'use strict';
// Anonymous Cdnvideohub source33 contract from Android3.0.77 Ltc/d + Llc/s.
// Its configuration is embedded in the APK; there is no ext33.cfg endpoint.
var url = require('url');
var HOST = 'https://plapi.cdnvideohub.com';
var AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
var QUALITY = {mpeg4kUrl:'2160p',mpeg2kUrl:'1440p',mpegFullHdUrl:'1080p',mpegHighUrl:'720p',mpegMediumUrl:'480p',mpegLowUrl:'360p',mpegLowestUrl:'240p',mpegTinyUrl:'144p'};
function fail(code) { var e = new Error('CDNVIDEOHUB_' + code); e.code = e.message; return e; }
function address(value) {
  if (typeof value !== 'string' || value.length > 16384 || /\s/.test(value)) return false;
  var p; try { p = url.parse(value); } catch (invalid) { return false; }
  return /^https?:$/.test(p.protocol || '') && !!p.hostname && !p.auth;
}
function voice(item) {
  var studio = typeof item.voiceStudio === 'string' ? item.voiceStudio.trim() : '';
  var type = typeof item.voiceType === 'string' ? item.voiceType.trim() : '';
  return studio && type ? studio + ' (' + type + ')' : studio || type || '';
}
function parseStreams(video, item) {
  var sources = video && video.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return [];
  var out = [], seen = {}, translation = voice(item);
  var language = /English|Original|Оригинал|Английский/i.test(translation) ? 'en' : /Украин|Ukr/i.test(translation) ? 'uk' : 'ru';
  Object.keys(QUALITY).forEach(function (key) {
    var link = sources[key];
    if (!address(link) || seen[link]) return;
    seen[link] = true;
    out.push({source:{url:link,headers:{'User-Agent':AGENT}},translation:translation,language:language,resolution:QUALITY[key],isTrailer:false});
  });
  if (!out.length && address(sources.hlsUrl)) out.push({source:{url:sources.hlsUrl,headers:{'User-Agent':AGENT}},translation:translation,language:language,resolution:'auto',isTrailer:false});
  return out;
}
function selectItems(playlist, episode) {
  if (!playlist || !Array.isArray(playlist.items) || typeof playlist.isSerial !== 'boolean') throw fail('PLAYLIST_INVALID');
  var match = /^S(\d+)E(\d+)$/.exec(episode), seen = {};
  if (!!match !== playlist.isSerial) return [];
  return playlist.items.filter(function (item) {
    if (!item || typeof item.vkId !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(item.vkId) || seen[item.vkId]) return false;
    if (match && (Number(item.season) !== Number(match[1]) || Number(item.episode) !== Number(match[2]))) return false;
    seen[item.vkId] = true; return true;
  }).slice(0, 24);
}
function create(options) {
  options = options || {};
  var native = options.native, http = options.http;
  if (!native || typeof native.request !== 'function' || typeof http !== 'function') throw fail('DEPENDENCY_MISSING');
  var later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  var random = options.random || Math.random;
  function getStreams(id, episode, callback) {
    if (!/^[1-9][0-9]{0,11}$/.test(String(id)) || typeof episode !== 'string' || !/^(?:S\d{1,3}E\d{1,4})?$/.test(episode)) return callback(fail('IDENTITY_INVALID'), {items:[]});
    id = Number(id);
    var done = false, sourcesReceived = false, output = [], handles = [];
    var timer = later(function () { finish(output.length ? null : fail('DEADLINE')); }, 21000);
    function finish(error) {
      if (done) return; done = true; cancel(timer);
      handles.forEach(function (h) { if (h && typeof h.abort === 'function') { try { h.abort(); } catch (ignored) {} } });
      callback(error, {items:output.length ? [{extractorType:{id:33,name:'CDNVIDEOHUB'},videoStreams:output}] : []});
    }
    function json(path, stage, cb) {
      var handle, settled = false;
      try {
        handle = http({url:HOST + path,headers:{'User-Agent':AGENT},timeoutMs:6000,maxBytes:2*1024*1024,stage:stage},function (e,r) {
          if (done || settled) return; settled = true;
          if (e || !r || r.statusCode !== 200) return cb(fail(stage === 'cdnvideohub-playlist' ? 'PLAYLIST_UNAVAILABLE' : 'VIDEO_UNAVAILABLE'));
          var data;
          try { data = JSON.parse(Buffer.isBuffer(r.body) ? r.body.toString('utf8') : r.body); } catch (invalid) { return cb(fail('JSON_INVALID')); }
          cb(null,data);
        });
        handles.push(handle);
      } catch (e) { if (!done && !settled) { settled = true; cb(fail('REQUEST_FAILED')); } }
    }
    function onSources(e,result) {
      if (done || sourcesReceived) return; sourcesReceived = true; if (e) return finish(fail('SOURCES_UNAVAILABLE'));
      var rows = result && result.data;
      if (!Array.isArray(rows) || !rows.every(function (r) { return r && Number(r.kinopoisk_id) === id && String(r.episode_key || '') === episode; })) return finish(fail('IDENTITY_MISMATCH'));
      var row = rows.filter(function (r) { return Number(r.video_source_type_id) === 33; })[0];
      if (!row) return finish(null);
      if (typeof row.download_link_key !== 'string' || !/^\d{1,12}$/.test(row.download_link_key)) return finish(fail('SOURCE_KEY_INVALID'));
      var attempt = 0;
      function playlist() {
        var pub = 1 + Math.floor(Math.max(0, Math.min(0.999999, random())) * 30);
        attempt++;
        json('/api/v1/player/sv/playlist?pub=' + pub + '&id=' + encodeURIComponent(row.download_link_key) + '&aggr=kp','cdnvideohub-playlist',function (e,data) {
          if (e) { if (attempt < 2) return playlist(); return finish(e); }
          var items;
          try { items = selectItems(data,episode); } catch (invalid) { return finish(invalid); }
          if (!items.length) return finish(null);
          var next = 0, active = 0, remaining = items.length;
          function pump() {
            while (!done && active < 4 && next < items.length) {
              (function (item) {
                active++;
                json('/api/v1/player/sv/video/' + encodeURIComponent(item.vkId),'cdnvideohub-video',function (e,video) {
                  if (!e) output = output.concat(parseStreams(video,item));
                  active--; remaining--;
                  if (!remaining) finish(output.length ? null : fail('STREAMS_UNAVAILABLE')); else pump();
                });
              }(items[next++]));
            }
          }
          pump();
        });
      }
      playlist();
    }
    try { native.request('/getVideoSources',{kinopoiskId:id,episodeKey:episode,movieSourceTypes:native.sourceTypes || ['33']},onSources); }
    catch (e) { finish(fail('SOURCES_UNAVAILABLE')); }
  }
  // Turbo41 currently requires its Android WebView runtime. It is not claimed.
  return {name:'Cdnvideohub',getStreams:getStreams};
}
exports.create = create;
exports.selectItems = selectItems;
exports.parseStreams = parseStreams;

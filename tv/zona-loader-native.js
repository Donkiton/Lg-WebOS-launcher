'use strict';
var crypto = require('crypto');
var VERSION = 'android-catalog-stream-loader-v2';
var FACTORY = 'function Xlt(t){return new Ep(t=t===h?new wT:t)}';
var SOURCE = 'function j_t(t,n,i,r,u){var s=new cP(t,n,i,r,u);return s.q8_1=w,s.r8_1=null,s.w8()}';

// This factory is serialized into the reviewed upstream loader's own scope.
// Kotlin source/extractor objects remain owned by each provider, never a global
// override. A request for another episode invalidates all older callbacks.
function Xlt(t) {
  var timeout = __ZONA_NATIVE_TIMEOUT_MS__;
  var config = t === h ? new wT() : t;
  var provider = new Ep(config), original = provider.getStreams;
  
  var previous = null;
  provider.getStreams = function (kpId, trailer, episode, callback) {
    if (previous) previous.cancel();
    if (!callback || typeof callback.onStreamsReceived !== 'function' || typeof callback.onCompletion !== 'function') {
      return original.call(provider, kpId, trailer, episode, callback);
    }
    var live = true, completed = false, nativeDone = false, addonDone = false;
    var hasVideo = false, fallbackStarted = false, sourceXhr = null;
    var nativeTimer = null, addonTimer = null, fallbackTimer = null;
    var addons = ['kinogo', 'rezka', 'extra'].map(function (name) { return { name: name, xhr: null, done: false }; });
    var addonPending = addons.length;
    var seen = Object.create(null), emitted = 0;
    function active() { return live && !completed; }
    function clear(timer) { if (timer !== null) clearTimeout(timer); }
    function detachAddon(job, abort) {
      if (!job.xhr) return;
      var old = job.xhr; job.xhr = null;
      old.onload = old.onerror = old.ontimeout = old.onabort = null;
      if (abort) { try { old.abort(); } catch (ignoreAbort) {} }
    }
    function detachSource(abort) {
      if (!sourceXhr) return;
      var old = sourceXhr; sourceXhr = null;
      old.onload = old.onerror = old.ontimeout = old.onabort = null;
      if (abort) { try { old.abort(); } catch (ignoreSourceAbort) {} }
    }
    function cleanup() {
      clear(nativeTimer); clear(addonTimer); clear(fallbackTimer);
      nativeTimer = addonTimer = fallbackTimer = null;
      addons.forEach(function (job) { detachAddon(job, true); });
      detachSource(true);
    }
    function cancel() { if (!live) return; live = false; cleanup(); }
    previous = { cancel: cancel };
    function complete() {
      if (!active()) return;
      completed = true; cleanup();
      callback.onCompletion();
    }
    function receive(text) {
      if (!active() || emitted >= 64 || typeof text !== 'string' || text.length > 1024 * 1024 || seen[text]) return;
      var value;
      try { value = JSON.parse(text); } catch (ignoreInvalid) { return; }
      if (!value || !value.extractorType || !Array.isArray(value.videoStreams)) return;
      for (var i = 0; i < value.videoStreams.length; i++) {
        var stream = value.videoStreams[i];
        if (stream && stream.source && typeof stream.source.url === 'string' && /^https?:\/\//i.test(stream.source.url)) hasVideo = true;
      }
      seen[text] = true; emitted++;
      try { callback.onStreamsReceived(text); } catch (ignoreConsumer) {}
    }
    function legacy() {
      if (!active() || fallbackStarted) return;
      fallbackStarted = true;
      var fallback = new Ep(config);
      fallbackTimer = setTimeout(complete, timeout);
      try {
        original.call(fallback, kpId, trailer, episode, {
          onStreamsReceived: receive,
          onCompletion: complete
        });
      } catch (ignoreLegacy) { complete(); }
    }
    function settled() {
      if (!active() || !nativeDone || !addonDone) return;
      if (hasVideo) complete(); else legacy();
    }
    function finishNative() {
      if (nativeDone) return;
      nativeDone = true; clear(nativeTimer); nativeTimer = null; detachSource(true); settled();
    }
    function finishAddon(job, items, abort) {
      if (job.done) return;
      job.done = true; detachAddon(job, abort);
      if (Array.isArray(items)) for (var i = 0; i < items.length; i++) receive(JSON.stringify(items[i]));
      addonPending--;
      if (addonPending === 0) { addonDone = true; clear(addonTimer); addonTimer = null; }
      settled();
    }
    if (trailer) { nativeDone = addonDone = true; legacy(); return; }
    nativeTimer = setTimeout(finishNative, timeout);
    try {
      sourceXhr = new XMLHttpRequest();
      sourceXhr.open('GET', '/__zona/sources?kpId=' + encodeURIComponent(kpId) + '&episodeKey=' + encodeURIComponent(episode || ''), true);
      sourceXhr.timeout = timeout;
      sourceXhr.onload = function () {
        if (!active() || nativeDone) return;
        var rows = null;
        try {
          if (sourceXhr.status === 200) rows = JSON.parse(sourceXhr.responseText);
          if (!rows || !Array.isArray(rows.data) || rows.data.length > 128) throw new Error('Invalid native source response');
          for (var i = 0; i < rows.data.length; i++) {
            var row = rows.data[i];
            if (!row || String(row.kinopoiskId) !== String(kpId) || (row.episodeKey || '') !== (episode || '')) throw new Error('Native source response identity mismatch');
          }
          detachSource(false);
          var nativeProvider = new Ep(config);
          nativeProvider.t6m_1.__lgGateNativeRows = rows;
          original.call(nativeProvider, kpId, trailer, episode, {
            onStreamsReceived: function (text) { if (!nativeDone) receive(text); },
            onCompletion: finishNative
          });
        } catch (ignoreNative) { finishNative(); }
      };
      sourceXhr.onerror = sourceXhr.ontimeout = sourceXhr.onabort = finishNative;
      sourceXhr.send(null);
    } catch (ignoreSource) { finishNative(); }
    // Independent provider requests deliver early translations immediately.
    // One shared deadline prevents three slow providers from extending the
    // discovery budget beyond the native branch's 25-second allowance.
    addonTimer = setTimeout(function () {
      addons.forEach(function (job) { finishAddon(job, null, true); });
    }, timeout);
    addons.forEach(function (job) {
      try {
        var xhr = job.xhr = new XMLHttpRequest();
        xhr.open('GET', '/__zona/streams?provider=' + job.name + '&kpId=' + encodeURIComponent(kpId) + '&episodeKey=' + encodeURIComponent(episode || ''), true);
        xhr.timeout = timeout;
        xhr.onload = function () {
          if (!active() || job.done) return;
          var items = null;
          try { if (xhr.status === 200) items = JSON.parse(xhr.responseText).items; } catch (ignoreResponse) {}
          finishAddon(job, items, false);
        };
        xhr.onerror = xhr.ontimeout = xhr.onabort = function () { finishAddon(job, null, true); };
        xhr.send(null);
      } catch (ignoreAddon) { finishAddon(job, null, true); }
    });
    return;
  };
  return provider;
}
function buildFactoryReplacement(options) {
  var timeout = options && options.nativeTimeoutMs;
  // The upstream player's first-source deadline is 60 seconds. Reserve time
  // for the legacy fallback as well as native discovery (25s + 25s < 60s).
  if (timeout === undefined) timeout = 25000;
  if (typeof timeout !== 'number' || !isFinite(timeout) || Math.floor(timeout) !== timeout || timeout < 1 || timeout > 25000) throw new RangeError('Invalid native stream deadline');
  return Xlt.toString().replace('__ZONA_NATIVE_TIMEOUT_MS__', String(timeout));
}
function patch(source, options) {
  if (typeof source !== 'string' || source.split(FACTORY).length !== 2 || source.split(SOURCE).length !== 2) throw new Error('Reviewed native loader anchors differ');
  var address = 'function j_t(t,n,i,r,u){var raw=t.r5v_1.__lgGateNativeRows;if(raw){var object=Yr().e51(e3.k53(),JSON.stringify(raw));return Yr().f51(N4(nit.k53()),object.rd("data"))}var s=new cP(t,n,i,r,u);return s.q8_1=w,s.r8_1=null,s.w8()}';
  return '/* ' + VERSION + ' */\n' + source.replace(SOURCE, address).replace(FACTORY, buildFactoryReplacement(options));
}
exports.patch = patch;
exports.buildFactoryReplacement = buildFactoryReplacement;
exports.version = VERSION;
exports.upstreamSha256 = function (source) { return crypto.createHash('sha256').update(source, 'utf8').digest('hex'); };

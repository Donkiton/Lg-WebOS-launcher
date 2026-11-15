'use strict';

// Serialized into the pinned loader's scope, where Ep, wT and h already exist.
// Ep's public StreamsCallback contract has onStreamsReceived and onCompletion.
function Xlt(t) {
  var nativeTimeoutMs = __ZONA_NATIVE_TIMEOUT_MS__;
  var provider = new Ep(t = t === h ? new wT() : t);
  var original = provider.getStreams;
  provider.getStreams = function (kpId, trailer, episode, callback) {
    if (trailer || episode || !callback ||
        typeof callback.onStreamsReceived !== 'function' ||
        typeof callback.onCompletion !== 'function') {
      return original.call(provider, kpId, trailer, episode, callback);
    }

    // Both branches are pending before either may complete synchronously.
    var legacyDone = false;
    var nativeDone = false;
    var nativeSettled = false;
    var completed = false;
    var xhr = null;
    var timer = null;
    var legacyReturn;
    function emit(value) {
      if (completed) return;
      try { callback.onStreamsReceived(value); } catch (ignored) {}
    }
    function complete() {
      if (completed || !legacyDone || !nativeDone) return;
      completed = true;
      callback.onCompletion();
    }
    function finishNative(items, abortRequest) {
      if (nativeSettled) return;
      nativeSettled = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (xhr) {
        var request = xhr;
        xhr = null;
        request.onload = request.onerror = request.ontimeout = request.onabort = null;
        if (abortRequest) { try { request.abort(); } catch (ignored) {} }
      }
      if (items) {
        for (var i = 0; i < items.length; i++) emit(JSON.stringify(items[i]));
      }
      nativeDone = true;
      complete();
    }
    var legacyCallbacks = {
      onStreamsReceived: function (value) { if (!legacyDone) emit(value); },
      onCompletion: function () {
        if (legacyDone) return;
        legacyDone = true;
        complete();
      }
    };

    // Start legacy first, preserving its owner and return value. No shared
    // timeout cancels it; native failures cannot discard its incoming streams.
    try {
      legacyReturn = original.call(provider, kpId, trailer, episode, legacyCallbacks);
    } catch (ignored) {
      legacyDone = true;
      complete();
    }
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', '/__zona/streams?kpId=' + encodeURIComponent(kpId), true);
      xhr.timeout = nativeTimeoutMs;
      xhr.onload = function () {
        if (nativeSettled) return;
        var items = null;
        try {
          if (xhr.status === 200) {
            var response = JSON.parse(xhr.responseText);
            var rows = response && response.items;
            if (Object.prototype.toString.call(rows) === '[object Array]') {
              items = [];
              for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                if (row && row.extractorType && row.extractorType.id === 54 &&
                    Object.prototype.toString.call(row.videoStreams) === '[object Array]' &&
                    row.videoStreams.length) items.push(row);
              }
            }
          }
        } catch (ignored) {}
        finishNative(items, false);
      };
      xhr.onerror = xhr.ontimeout = xhr.onabort = function () { finishNative(null, true); };
      // Also bound implementations which fail to dispatch XHR timeout events.
      timer = setTimeout(function () { finishNative(null, true); }, nativeTimeoutMs);
      xhr.send();
    } catch (ignored) {
      finishNative(null, true);
    }
    return legacyReturn;
  };
  return provider;
}

function buildFactoryReplacement(options) {
  var timeout = options && options.nativeTimeoutMs;
  if (timeout === undefined) timeout = 45000;
  if (typeof timeout !== 'number' || !isFinite(timeout) || timeout < 1 ||
      timeout > 60000 || Math.floor(timeout) !== timeout) {
    throw new RangeError('nativeTimeoutMs must be an integer from 1 to 60000');
  }
  var source = Xlt.toString();
  var marker = '__ZONA_NATIVE_TIMEOUT_MS__';
  if (source.split(marker).length !== 2) throw new Error('Factory timeout anchor mismatch');
  return source.replace(marker, String(timeout));
}

exports.buildFactoryReplacement = buildFactoryReplacement;
exports.version = 'legacy-plus-kinogo-v1';

'use strict';
// Independent providers share a finite response budget. A failed provider must
// not discard streams already obtained from another one.
function create(options) {
  options = options || {};
  var providers = options.providers || [], later = options.setTimeout || setTimeout;
  var cancel = options.clearTimeout || clearTimeout, timeout = options.timeoutMs || 23000;
  var pending = Object.create(null), recent = [], calls = 0;
  function getStreams(id, episode, callback) {
    var key = String(id) + ':' + episode;
    if (pending[key]) {
      if (pending[key].length >= 8) return callback(new Error('Provider waiter limit'));
      pending[key].push(callback); return;
    }
    if (Object.keys(pending).length >= 3) return callback(new Error('Provider concurrency limit'));
    pending[key] = [callback]; calls++;
    var remaining = providers.length, done = false, items = [], statuses = [], settled = {};
    var timer = later(function () { finish(true); }, timeout);
    function finish(expired) {
      if (done) return;
      done = true; cancel(timer);
      providers.forEach(function (provider, index) {
        if (!settled[index]) statuses.push({name: String(provider.name || index), status: 'timeout', streams: 0});
      });
      var report = {kpId: id, episodeKey: episode, expired: !!expired, providers: statuses, items: items.length};
      recent.push(report); if (recent.length > 8) recent.shift();
      var callbacks = pending[key]; delete pending[key];
      callbacks.forEach(function (cb) { try {cb(null, {items: items, report: report});} catch (ignoreConsumer) {} });
    }
    if (!remaining) { finish(false); return; }
    providers.forEach(function (provider, index) {
      function accept(error, value) {
        if (done || settled[index]) return;
        settled[index] = true;
        var accepted = 0;
        if (!error && value && Array.isArray(value.items)) value.items.slice(0, 16).forEach(function (item) {
          if (!item || !item.extractorType || !Array.isArray(item.videoStreams)) return;
          var valid = item.videoStreams.filter(function (stream) {
            return stream && stream.source && typeof stream.source.url === 'string' && /^https?:\/\//.test(stream.source.url);
          }).slice(0, 256);
          if (valid.length) {items.push({extractorType: item.extractorType, videoStreams: valid}); accepted += valid.length;}
        });
        statuses.push({name: String(provider.name || index), status: error ? 'failed' : 'complete', streams: accepted});
        remaining--; if (!remaining) finish(false);
      }
      try {provider.getStreams(id, episode, accept);} catch (error) {accept(error);}
    });
  }
  return {getStreams: getStreams, stats: function () {return {pending: Object.keys(pending).length, calls: calls, recent: recent.slice()};}};
}
exports.create = create;
exports.version = 'native-provider-addon-v1';

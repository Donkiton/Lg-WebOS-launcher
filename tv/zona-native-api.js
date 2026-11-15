'use strict';

// Shared Android metadata transport. All execution stays on the TV's Node 0.12;
// no Android process, account credentials or external computer is required.
var DEFAULT_HOST = 'https://apirn1.mzona.net';
var DEFAULT_AGENT = 'Zona/3.0.77 (Android unknown)';
// Catalog endpoints accept JSON even though the native source list uses its
// legacy parameter codec. A common codec for all endpoints returns HTTP 500.
var ENCODED = { '/getVideoSources': true };
var sourceTypes = [];
for (var type = 1; type <= 60; type++) if (type !== 4 && type !== 11) sourceTypes.push(String(type));

function failure(code, status) {
  var error = new Error(code);
  error.code = code;
  if (status) error.statusCode = status;
  return error;
}

function create(options) {
  options = options || {};
  var http = options.http, portable = options.portable;
  if (typeof http !== 'function' || !portable || typeof portable.makeTransport !== 'function' || typeof portable.encodeParams !== 'function') {
    throw new TypeError('Native API requires HTTP and portable transport');
  }
  var host = options.host || DEFAULT_HOST;
  if (host !== DEFAULT_HOST && host !== 'https://apiwn1.mzona.net') throw new TypeError('Unsupported native API host');
  var agent = DEFAULT_AGENT;
  var now = options.now || Date.now;
  var later = options.setTimeout || setTimeout;
  var cancel = options.clearTimeout || clearTimeout;
  var queue = [], active = 0, clock = null, clockWaiters = null;
  var totals = { completed: 0, failed: 0, clockRequests: 0 };

  function aligned(callback) {
    var age = clock ? now() - clock.saved : -1;
    if (clock && age >= 0 && age < 300000) return callback(null, now() + clock.offset);
    if (clockWaiters) { clockWaiters.push(callback); return; }
    clockWaiters = [callback];
    totals.clockRequests++;
    var settled = false, handle = null;
    var timer = later(function () {
      finish(failure('NATIVE_CLOCK_TIMEOUT'));
      if (handle && typeof handle.abort === 'function') handle.abort();
    }, 10000);
    function finish(error, response) {
      if (settled) return;
      settled = true;
      cancel(timer);
      var time = response && response.headers && Date.parse(response.headers.date);
      if (!error && (!response || response.statusCode !== 200 || !isFinite(time))) error = failure('NATIVE_CLOCK_INVALID');
      if (!error) clock = { saved: now(), offset: time - now() };
      var callbacks = clockWaiters;
      clockWaiters = null;
      callbacks.forEach(function (cb) { cb(error, error ? null : now() + clock.offset); });
    }
    try {
      handle = http({ url: host + '/getTime', method: 'HEAD', headers: { 'User-Agent': agent }, timeoutMs: 9000,
        maxBytes: 16384, stage: 'native-clock' }, finish);
    } catch (error) { finish(failure('NATIVE_CLOCK_FAILED')); }
  }

  function pump() {
    while (active < 4 && queue.length) {
      var job = queue.shift();
      if (job.done) continue;
      active++;
      job.active = true;
      run(job);
    }
  }
  function complete(job, error, value) {
    if (job.done) return;
    job.done = true;
    cancel(job.timer);
    if (job.active) { active--; job.active = false; }
    else {
      var index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
    }
    totals.completed++;
    if (error) totals.failed++;
    pump();
    job.callback(error, value);
  }
  function run(job) {
    aligned(function (error, time) {
      if (job.done) return;
      if (error) return complete(job, error);
      var generated, payload, address;
      try {
        generated = portable.makeTransport(time, agent);
        payload = ENCODED[job.path] ? portable.encodeParams(job.params) : job.json;
        address = host + job.path + '?params=' + encodeURIComponent(payload) + '&client_time=' + encodeURIComponent(generated.client_time);
      } catch (badTransport) { complete(job, failure('NATIVE_TRANSPORT_FAILED')); return; }
      try {
        job.handle = http({ url: address, headers: { 'User-Agent': agent, Cookie: generated.cookie,
          'Content-Type': 'application/json', Accept: 'application/json' }, maxBytes: 4 * 1024 * 1024,
          timeoutMs: 18000, stage: 'native' + job.path }, function (requestError, response) {
          if (job.done) return;
          if (requestError) return complete(job, failure('NATIVE_REQUEST_FAILED'));
          if (!response || response.statusCode !== 200) return complete(job, failure('NATIVE_HTTP_ERROR', response && response.statusCode));
          var value;
          try { value = JSON.parse(response.body.toString('utf8')); } catch (badJson) { return complete(job, failure('NATIVE_JSON_INVALID')); }
          if (!value || typeof value !== 'object' || Array.isArray(value) || value.error) return complete(job, failure('NATIVE_RESPONSE_INVALID'));
          complete(job, null, value);
        });
      } catch (requestError) { complete(job, failure('NATIVE_REQUEST_FAILED')); }
    });
  }
  function request(path, params, callback) {
    if (typeof callback !== 'function') throw new TypeError('Native callback required');
    var json;
    if (!/^\/[A-Za-z][A-Za-z0-9]{0,60}$/.test(path || '') || !params || typeof params !== 'object' || Array.isArray(params)) {
      callback(failure('NATIVE_PARAMETERS_INVALID')); return;
    }
    try { json = JSON.stringify(params); } catch (badParams) { callback(failure('NATIVE_PARAMETERS_INVALID')); return; }
    if (!json || Buffer.byteLength(json) > 32768) { callback(failure('NATIVE_PARAMETERS_INVALID')); return; }
    if (queue.length >= 32) { callback(failure('NATIVE_BUSY')); return; }
    // Snapshot inputs: a caller changing its filters cannot change an enqueued request.
    var job = { path: path, params: JSON.parse(json), json: json, callback: callback, active: false, done: false };
    job.timer = later(function () {
      complete(job, failure('NATIVE_REQUEST_TIMEOUT'));
      if (job.handle && typeof job.handle.abort === 'function') job.handle.abort();
    }, 30000);
    queue.push(job);
    pump();
  }
  return {
    request: request, sourceTypes: sourceTypes.slice(),
    stats: function () { return { active: active, queued: queue.length, completed: totals.completed, failed: totals.failed,
      clockRequests: totals.clockRequests, host: host }; }
  };
}

exports.create = create;
exports.version = 'android-metadata-api-v1';
exports.sourceTypes = sourceTypes.slice();

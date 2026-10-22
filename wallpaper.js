(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.LauncherWallpaper = factory();
    root.LauncherWallpaper.bootstrap(root);
  }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var BACKGROUNDS = {
    morning: 'assets/wallpapers/morning.png',
    day: 'assets/wallpapers/day.png',
    evening: 'assets/mountain-sunset.png',
    night: 'assets/wallpapers/night.png'
  };
  if (Object.freeze) Object.freeze(BACKGROUNDS);

  function validPeriod(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BACKGROUNDS, value);
  }

  function validWake(value) {
    return typeof value === 'string' && /^wake:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{24}$/i.test(value);
  }

  function preparedRecord(record) {
    return record && record.version === 1 && validWake(record.session) && validPeriod(record.period) ?
      { version: 1, session: record.session, period: record.period } : null;
  }

  function launchParams(value) {
    if (typeof value === 'string') {
      if (value.length > 8192) return null;
      try { value = JSON.parse(value); } catch (ignore) { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function parseLaunchHint(value) {
    var params = launchParams(value);
    return params && params.lgGateStartup === true ? preparedRecord(params.lgGateWallpaper) : null;
  }

  function bootstrap(env) {
    // This runs synchronously in <head>, before platform.js and its LS2 calls.
    // No Promise, service call, or wall-clock guess is needed here.
    if (api.initialParamsRead) return api.early;
    var agent = env.navigator && env.navigator.userAgent || '';
    if (!(typeof env.PalmServiceBridge !== 'undefined' || env.webOSSystem || /web[o0]s/i.test(agent))) return null;
    api.initialParamsRead = true;
    var params = null;
    try { params = launchParams(env.PalmSystem && env.PalmSystem.launchParams); } catch (ignoreParams) {}
    api.initialParams = params;
    var record = parseLaunchHint(params);
    if (!record) return null;
    // Only the native hint can establish today's awake session. After that
    // validation, preserve a legacy renderer's already chosen period for it.
    // Never speculate from yesterday's saved record before session validation.
    try {
      var storage = env.localStorage;
      var raw = storage && storage.getItem('lg-home-wallpaper-v1-webos');
      var cached = typeof raw === 'string' && raw.length <= 512 ? preparedRecord(JSON.parse(raw)) : null;
      if (cached && cached.session === record.session) record = cached;
    } catch (ignoreCache) {}
    var path = BACKGROUNDS[record.period];
    var listeners = [];
    var early = { record: record, path: path, state: 'loading', image: null, error: null };
    early.listen = function (callback) {
      if (early.state !== 'loading') callback(early.error);
      else listeners.push(callback);
      return function () {
        var index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    };
    function finish(error) {
      if (early.state !== 'loading') return;
      early.error = error || null;
      early.state = error ? 'failed' : 'ready';
      var pending = listeners.slice();
      listeners = [];
      for (var i = 0; i < pending.length; i++) pending[i](early.error);
    }
    api.early = early;
    try {
      early.image = new env.Image();
      early.image.onload = function () { finish(null); };
      early.image.onerror = function () { finish(new Error('Prepared wallpaper unavailable')); };
      early.image.src = path;
      var doc = env.document;
      if (doc && doc.head && doc.createElement) {
        var style = doc.createElement('style');
        style.id = 'lg-gate-wallpaper-bootstrap';
        style.textContent = '#wallpaper {background-image:url("' + path + '")}';
        doc.head.appendChild(style);
      }
    } catch (failure) { finish(failure); }
    return early;
  }

  function validDate(date) {
    try {
      return date && typeof date.getTime === 'function' && typeof date.getFullYear === 'function' &&
        typeof date.getHours === 'function' && isFinite(date.getTime()) && date.getFullYear() >= 2020;
    } catch (ignore) { return false; }
  }

  function periodForDate(date) {
    if (!validDate(date)) return 'evening';
    var hour = date.getHours();
    if (hour >= 6 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 18) return 'day';
    if (hour >= 18 && hour < 23) return 'evening';
    return 'night';
  }

  function validSession(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
      value.replace(/^\s+|\s+$/g, '') === value && !/[\x00-\x1f\x7f]/.test(value);
  }

  function validRecord(value) {
    return value && value.version === 1 && validSession(value.session) &&
      typeof value.period === 'string' && Object.prototype.hasOwnProperty.call(BACKGROUNDS, value.period);
  }

  function createController(options) {
    options = options || {};
    var storage = options.storage;
    var key = 'lg-home-wallpaper-v1-' + (options.mode === 'browser' ? 'browser' : 'webos');
    var now = options.now || function () { return new Date(); };
    var loadImage = options.loadImage || function () { return Promise.reject(new Error('Image loader unavailable')); };
    var apply = options.apply || function () {};
    var schedule = options.setTimeout || setTimeout;
    var cancel = options.clearTimeout || clearTimeout;
    var timeout = typeof options.sessionTimeoutMs === 'number' && isFinite(options.sessionTimeoutMs) && options.sessionTimeoutMs > 0 ? options.sessionTimeoutMs : 2500;
    var generation = 0;
    var displayTicket = 0;
    var disposed = false;
    var currentPeriod = null;
    var remembered = null;
    // A verified session can already have a pending image. Preserve that choice
    // if another lifecycle event arrives before loading finishes or LS2 fails.
    var choice = null;
    var loads = {};
    var pendingReads = [];
    var saved = null;
    var initial = options.mode === 'browser' ? null : preparedRecord(options.initialRecord);

    try {
      var raw = storage && storage.getItem(key);
      var parsed = raw ? JSON.parse(raw) : null;
      if (validRecord(parsed)) {
        remembered = { version: 1, session: parsed.session, period: parsed.period };
        saved = JSON.stringify(remembered);
      }
    } catch (ignore) {}

    function snapshot(status) {
      var period = currentPeriod;
      return { period: period, path: period ? BACKGROUNDS[period] : null, session: remembered ? remembered.session : null, status: status };
    }

    function live(epoch, ticket) {
      return !disposed && epoch === generation && ticket === displayTicket;
    }

    function remember(record) {
      remembered = { version: 1, session: record.session, period: record.period };
      var serialized = JSON.stringify(remembered);
      if (serialized === saved) return;
      try {
        if (storage) {
          storage.setItem(key, serialized);
          saved = serialized;
        }
      } catch (ignore) {}
    }

    function load(period) {
      // Only a whitelisted period reaches this function. Share an in-flight
      // request, and remember failures for this renderer to avoid focus loops.
      if (!Object.prototype.hasOwnProperty.call(loads, period)) {
        loads[period] = Promise.resolve().then(function () { return loadImage(BACKGROUNDS[period]); });
      }
      return loads[period];
    }

    function select(record, epoch, commit, status, fallbackAttempt) {
      var ticket = ++displayTicket;
      var period = record.period;
      var ready = currentPeriod === period ? Promise.resolve() : load(period);
      return ready.then(function () {
        if (!live(epoch, ticket)) return snapshot(disposed ? 'disposed' : 'stale');
        if (currentPeriod !== period) {
          apply(BACKGROUNDS[period]);
          currentPeriod = period;
        }
        if (commit) remember(record);
        return snapshot(status);
      }).catch(function () {
        if (!live(epoch, ticket)) return snapshot(disposed ? 'disposed' : 'stale');
        // Before first paint, an unavailable image must leave the neutral
        // surface instead of introducing an unrelated evening background.
        if (fallbackAttempt || !currentPeriod) return snapshot('image-unavailable');
        var fallback = { version: 1, session: record.session, period: currentPeriod || 'evening' };
        if (commit) choice = fallback;
        return select(fallback, epoch, commit, 'fallback', true);
      });
    }

    function restoreFor(epoch) {
      var record = choice || remembered;
      if (record) return select(record, epoch, true, 'cached', false);
      return select({ period: 'evening', session: null }, epoch, false, 'fallback', true);
    }

    function readSession() {
      return new Promise(function (resolve) {
        var settled = false;
        var timer;
        function finish(value) {
          if (settled) return;
          settled = true;
          if (timer !== undefined) cancel(timer);
          var index = pendingReads.indexOf(stop);
          if (index >= 0) pendingReads.splice(index, 1);
          if (validSession(value)) resolve({ session: value, period: null });
          else if (value && value.version === 1 && validSession(value.session)) {
            resolve({ session: value.session, period: options.mode !== 'browser' && validWake(value.session) && validPeriod(value.period) ? value.period : null });
          } else resolve(null);
        }
        function stop() { finish(null); }
        pendingReads.push(stop);
        timer = schedule(stop, timeout);
        Promise.resolve().then(function () {
          return typeof options.readSession === 'function' ? options.readSession() : null;
        }).then(finish, stop);
      });
    }

    function restore() {
      if (disposed) return Promise.resolve(snapshot('disposed'));
      return restoreFor(++generation);
    }

    function refresh(preparedHint) {
      if (disposed) return Promise.resolve(snapshot('disposed'));
      var epoch = ++generation;
      var prepared = options.mode === 'browser' ? null : preparedRecord(preparedHint) || initial;
      initial = null;
      if (prepared) {
        choice = choice && choice.session === prepared.session ? choice :
          remembered && remembered.session === prepared.session ? remembered : prepared;
        return select(choice, epoch, true, 'prepared', false);
      }
      // A saved record can belong to yesterday's boot. Do not paint it before
      // checking the current session: first paint must use the final selection.
      // An already verified in-memory choice remains usable during later reads.
      // The stylesheet supplies only a neutral surface while startup is pending.
      var restoration = choice ? restoreFor(epoch) : Promise.resolve(snapshot('pending'));
      function fallback(status) {
        return restoration.then(function () {
          if (disposed || epoch !== generation) return snapshot(disposed ? 'disposed' : 'stale');
          if (currentPeriod) return snapshot(status);
          // No session has been verified in this renderer. Keep startup
          // neutral even when LS2/clock fails, and retry on the next refresh.
          if (!choice) return snapshot(status);
          return restoreFor(epoch).then(function () { return snapshot(status); });
        });
      }
      return readSession().then(function (power) {
        if (disposed || epoch !== generation) return snapshot(disposed ? 'disposed' : 'stale');
        if (!power) return fallback('session-unavailable');
        var session = power.session;
        var record = choice && choice.session === session ? choice : remembered && remembered.session === session ? remembered :
          power.period ? { version: 1, session: session, period: power.period } : null;
        if (!record) {
          var date;
          try { date = now(); } catch (ignore) {}
          if (!validDate(date)) return fallback('clock-unavailable');
          record = { version: 1, session: session, period: periodForDate(date) };
        }
        choice = record;
        return select(record, epoch, true, 'ready', false);
      });
    }

    function dispose() {
      disposed = true;
      generation += 1;
      displayTicket += 1;
      var reads = pendingReads.slice();
      for (var i = 0; i < reads.length; i += 1) reads[i]();
    }

    return { restore: restore, refresh: refresh, dispose: dispose };
  }

  var api = { BACKGROUNDS: BACKGROUNDS, periodForDate: periodForDate, createController: createController,
    parseLaunchHint: parseLaunchHint, bootstrap: bootstrap, early: null, initialParams: null, initialParamsRead: false };
  return api;
}));

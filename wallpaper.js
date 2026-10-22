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
    lake: 'assets/wallpapers/northern-lake.png',
    morning: 'assets/wallpapers/morning.png',
    day: 'assets/wallpapers/day.png',
    evening: 'assets/mountain-sunset.png',
    night: 'assets/wallpapers/night.png',
    none: null
  };
  var OPTIONS = [
    { id: 'lake', label: 'Северное озеро' },
    { id: 'morning', label: 'Утро' },
    { id: 'day', label: 'День' },
    { id: 'evening', label: 'Вечер' },
    { id: 'night', label: 'Ночь' },
    { id: 'none', label: 'Без фона' }
  ];
  var DEFAULT = 'lake';
  var bootstrapped = false;
  if (Object.freeze) {
    Object.freeze(BACKGROUNDS);
    for (var i = 0; i < OPTIONS.length; i += 1) Object.freeze(OPTIONS[i]);
    Object.freeze(OPTIONS);
  }

  function validSelection(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BACKGROUNDS, value);
  }

  function storageKey(mode) {
    return 'lg-home-wallpaper-v2-' + (mode === 'browser' ? 'browser' : 'webos');
  }

  function readSelection(storage, mode) {
    try {
      var raw = storage && storage.getItem(storageKey(mode));
      if (typeof raw !== 'string' || raw.length > 128) return null;
      var value = JSON.parse(raw);
      if (value && value.version === 2 && validSelection(value.selection)) return value.selection;
    } catch (ignore) { /* The bundled default remains available without storage. */ }
    return null;
  }

  function launchParams(value) {
    if (typeof value === 'string') {
      if (value.length > 8192) return null;
      try { value = JSON.parse(value); } catch (ignore) { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function bootstrap(env) {
    // Runs synchronously in <head>. CSS requests only the saved local image;
    // the first paint never waits for a service, clock, Promise, or Image.onload.
    if (bootstrapped) return api.early;
    bootstrapped = true;
    env = env || {};
    var agent = env.navigator && env.navigator.userAgent || '';
    var isTV = typeof env.PalmServiceBridge !== 'undefined' || !!env.webOSSystem || /web[o0]s/i.test(agent);
    if (isTV) {
      api.initialParamsRead = true;
      try { api.initialParams = launchParams(env.PalmSystem && env.PalmSystem.launchParams); } catch (ignoreParams) {}
    }
    var selection = null;
    try { selection = readSelection(env.localStorage, isTV ? 'webos' : 'browser'); } catch (ignoreStorage) {}
    selection = selection || DEFAULT;
    var path = BACKGROUNDS[selection];
    api.early = { selection: selection, path: path };
    try {
      var doc = env.document;
      if (doc && doc.head && doc.createElement) {
        var style = doc.createElement('style');
        style.id = 'lg-gate-wallpaper-bootstrap';
        style.textContent = '#wallpaper {background-color:#000;background-image:' + (path ? 'url("' + path + '")' : 'none') + '}';
        doc.head.appendChild(style);
      }
    } catch (ignoreStyle) { /* The base stylesheet also supplies the default. */ }
    return api.early;
  }

  function createController(options) {
    options = options || {};
    var storage = options.storage;
    var key = storageKey(options.mode);
    var selection = validSelection(options.initialSelection) ? options.initialSelection : readSelection(storage, options.mode) || DEFAULT;
    var loadImage = options.loadImage || function () { return Promise.reject(new Error('Image loader unavailable')); };
    var apply = options.apply || function () {};
    var applied = false;
    var disposed = false;
    var ticket = 0;
    // Retain at most the current request, never every decoded image or failure.
    var loading = null;

    function snapshot(status, error) {
      var result = { selection: selection, path: BACKGROUNDS[selection], status: status };
      if (error) result.error = error;
      return result;
    }

    function live(request) {
      return !disposed && request === ticket;
    }

    function restore() {
      if (disposed) return snapshot('disposed');
      if (!applied) {
        try {
          apply(BACKGROUNDS[selection]);
          applied = true;
        } catch (failure) { return snapshot('apply-unavailable', failure); }
      }
      return snapshot('ready');
    }

    function load(id) {
      var path = BACKGROUNDS[id];
      if (!path) return Promise.resolve();
      if (loading && loading.path === path) return loading.promise;
      var request = { path: path, promise: null };
      request.promise = Promise.resolve().then(function () { return loadImage(path); }).then(function () {
        if (loading === request) loading = null;
      }, function (failure) {
        if (loading === request) loading = null;
        throw failure;
      });
      loading = request;
      return request.promise;
    }

    function select(id) {
      if (disposed) return Promise.resolve(snapshot('disposed'));
      if (!validSelection(id)) return Promise.resolve(snapshot('invalid-selection', new Error('Unknown wallpaper')));
      var request = ++ticket;
      if (id === selection) {
        var same = restore();
        if (same.status === 'ready') same.status = 'unchanged';
        return Promise.resolve(same);
      }
      return load(id).then(function () {
        if (!live(request)) return snapshot(disposed ? 'disposed' : 'stale');
        var previous = selection;
        try {
          if (!storage || typeof storage.setItem !== 'function') throw new Error('Wallpaper storage unavailable');
          storage.setItem(key, JSON.stringify({ version: 2, selection: id }));
        } catch (failure) { return snapshot('storage-unavailable', failure); }
        try { apply(BACKGROUNDS[id]); }
        catch (failure) {
          // A DOM failure must not turn into a different saved selection.
          try { storage.setItem(key, JSON.stringify({ version: 2, selection: previous })); } catch (ignoreRollback) {}
          return snapshot('apply-unavailable', failure);
        }
        selection = id;
        applied = true;
        return snapshot('ready');
      }, function (failure) {
        if (!live(request)) return snapshot(disposed ? 'disposed' : 'stale');
        return snapshot('image-unavailable', failure);
      });
    }

    function refresh() {
      // Returning Home restores the existing manual selection immediately.
      // It neither cancels a user's pending choice nor reopens the image.
      return Promise.resolve(restore());
    }

    function dispose() {
      disposed = true;
      ticket += 1;
      loading = null;
    }

    return { getSelection: function () { return selection; }, select: select, refresh: refresh, dispose: dispose };
  }

  var api = { BACKGROUNDS: BACKGROUNDS, OPTIONS: OPTIONS, DEFAULT: DEFAULT,
    createController: createController, bootstrap: bootstrap, early: null, initialParams: null, initialParamsRead: false };
  return api;
}));

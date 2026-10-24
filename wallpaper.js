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
    coast: 'assets/wallpapers/coast.webp',
    city: 'assets/wallpapers/city.webp',
    zen: 'assets/wallpapers/zen.webp',
    obsidian: 'assets/wallpapers/obsidian.webp',
    orbit: 'assets/wallpapers/orbit.webp',
    aurora: 'assets/wallpapers/aurora.webp',
    holiday: 'assets/wallpapers/holiday.webp',
    none: null
  };
  var OPTIONS = [
    { id: 'lake', label: 'Северное озеро', group: 'classic', material: 'water', thumbnail: 'assets/wallpapers/northern-lake-thumb.webp' },
    { id: 'morning', label: 'Утро', group: 'classic', material: 'water', thumbnail: 'assets/wallpapers/morning-thumb.webp' },
    { id: 'day', label: 'День', group: 'classic', material: 'water', thumbnail: 'assets/wallpapers/day-thumb.webp' },
    { id: 'evening', label: 'Вечер', group: 'classic', material: 'water', thumbnail: 'assets/wallpapers/evening-thumb.webp' },
    { id: 'night', label: 'Ночь', group: 'classic', material: 'water', thumbnail: 'assets/wallpapers/night-thumb.webp' },
    { id: 'coast', label: 'Морской берег', group: 'new', material: 'water', thumbnail: 'assets/wallpapers/coast-thumb.webp' },
    { id: 'city', label: 'После дождя', group: 'new', material: 'wet-stone', thumbnail: 'assets/wallpapers/city-thumb.webp' },
    { id: 'zen', label: 'Японский сад', group: 'new', material: 'stone', thumbnail: 'assets/wallpapers/zen-thumb.webp' },
    { id: 'obsidian', label: 'Обсидиан', group: 'new', material: 'stone', thumbnail: 'assets/wallpapers/obsidian-thumb.webp' },
    { id: 'orbit', label: 'Орбита', group: 'new', material: 'glass', thumbnail: 'assets/wallpapers/orbit-thumb.webp' },
    { id: 'aurora', label: 'Северное сияние', group: 'new', material: 'ice', thumbnail: 'assets/wallpapers/aurora-thumb.webp' },
    { id: 'holiday', label: 'Новогодний вечер', group: 'new', material: 'wood', thumbnail: 'assets/wallpapers/holiday-thumb.webp' },
    { id: 'none', label: 'Без фона', group: 'new', material: 'none', thumbnail: null }
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

  function optionFor(id) {
    for (var i = 0; i < OPTIONS.length; i += 1) if (OPTIONS[i].id === id) return OPTIONS[i];
    return null;
  }

  function optionsForGroup(group) {
    return OPTIONS.filter(function (option) { return option.group === group; });
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
    var visibleSelection = null;
    var previewing = false;
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

    function applyChoice(id) {
      apply(BACKGROUNDS[id], id, optionFor(id));
      applied = true;
      visibleSelection = id;
    }

    function restore() {
      if (disposed) return snapshot('disposed');
      if (!applied || !previewing && visibleSelection !== selection) {
        try {
          applyChoice(selection);
        } catch (failure) { return snapshot('apply-unavailable', failure); }
      }
      return snapshot('ready');
    }

    function cancelLoading() {
      if (!loading) return;
      var previous = loading;
      loading = null;
      previous.cancelled = true;
      if (typeof previous.cancel === 'function') {
        try { previous.cancel(); } catch (ignoreCancel) { /* The ticket also rejects late results. */ }
      }
    }

    function load(id) {
      var path = BACKGROUNDS[id];
      if (loading && loading.path === path) return loading.promise;
      cancelLoading();
      if (!path) return Promise.resolve();
      var request = { path: path, promise: null, cancelled: false, cancel: null };
      request.promise = Promise.resolve().then(function () {
        if (request.cancelled) throw new Error('Wallpaper request cancelled');
        var result = loadImage(path);
        request.cancel = result && result.cancel;
        return result;
      }).then(function () {
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
        cancelLoading();
        previewing = false;
        var same = restore();
        if (same.status === 'ready') same.status = 'unchanged';
        return Promise.resolve(same);
      }
      var alreadyVisible = applied && visibleSelection === id;
      if (alreadyVisible) cancelLoading();
      return (alreadyVisible ? Promise.resolve() : load(id)).then(function () {
        if (!live(request)) return snapshot(disposed ? 'disposed' : 'stale');
        var previous = selection;
        try {
          if (!storage || typeof storage.setItem !== 'function') throw new Error('Wallpaper storage unavailable');
          storage.setItem(key, JSON.stringify({ version: 2, selection: id }));
        } catch (failure) { return snapshot('storage-unavailable', failure); }
        try { if (visibleSelection !== id) applyChoice(id); }
        catch (failure) {
          // A DOM failure must not turn into a different saved selection.
          try { storage.setItem(key, JSON.stringify({ version: 2, selection: previous })); } catch (ignoreRollback) {}
          return snapshot('apply-unavailable', failure);
        }
        selection = id;
        applied = true;
        previewing = false;
        return snapshot('ready');
      }, function (failure) {
        if (!live(request)) return snapshot(disposed ? 'disposed' : 'stale');
        return snapshot('image-unavailable', failure);
      });
    }

    function preview(id) {
      if (disposed) return Promise.resolve(snapshot('disposed'));
      if (!validSelection(id)) return Promise.resolve(snapshot('invalid-selection', new Error('Unknown wallpaper')));
      var request = ++ticket;
      previewing = true;
      if (id === visibleSelection || id === selection) {
        cancelLoading();
        try { if (id !== visibleSelection) applyChoice(id); }
        catch (failure) { return Promise.resolve(snapshot('apply-unavailable', failure)); }
        return Promise.resolve(snapshot('ready'));
      }
      return load(id).then(function () {
        if (!live(request)) return snapshot(disposed ? 'disposed' : 'stale');
        try { applyChoice(id); }
        catch (failure) { return snapshot('apply-unavailable', failure); }
        return snapshot('ready');
      }, function (failure) {
        if (!live(request)) return snapshot(disposed ? 'disposed' : 'stale');
        return snapshot('image-unavailable', failure);
      });
    }

    function cancelPreview() {
      if (disposed) return Promise.resolve(snapshot('disposed'));
      ticket += 1;
      cancelLoading();
      previewing = false;
      return Promise.resolve(restore());
    }

    function refresh() {
      // Returning Home restores the existing manual selection immediately.
      // It neither cancels a user's pending choice nor reopens the image.
      return Promise.resolve(restore());
    }

    function dispose() {
      disposed = true;
      ticket += 1;
      cancelLoading();
    }

    return { getSelection: function () { return selection; }, getPreview: function () { return visibleSelection || selection; },
      select: select, preview: preview, cancelPreview: cancelPreview, refresh: refresh, dispose: dispose };
  }

  var api = { BACKGROUNDS: BACKGROUNDS, OPTIONS: OPTIONS, DEFAULT: DEFAULT,
    optionFor: optionFor, optionsForGroup: optionsForGroup,
    createController: createController, bootstrap: bootstrap, early: null, initialParams: null, initialParamsRead: false };
  return api;
}));

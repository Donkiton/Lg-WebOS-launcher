(function (root, factory) {
  'use strict';
  var snapshot = typeof module === 'object' && module.exports ? require('./preview-catalog.js') : root.LauncherPreviewCatalog;
  var msx = typeof module === 'object' && module.exports ? require('./msx-catalog.js') : root.LauncherMSXCatalog;
  var platform = factory(root, snapshot, msx);
  if (typeof module === 'object' && module.exports) module.exports = platform;
  if (typeof window !== 'undefined') window.LauncherPlatform = platform;
}(typeof window !== 'undefined' ? window : {}, function (defaultEnvironment, previewSnapshot, msxCatalog) {
  'use strict';

  // ES5 syntax for the existing webOS engine; Promise is available in Chromium 53.
  // The PC preview reads an SSH snapshot. TV mode always requests its live catalogue.

  // Primary references. TV firmware/LS2 permissions must still be tested on-device.
  // https://webostv.developer.lge.com/develop/references/application-manager
  // https://webostv.developer.lge.com/develop/references/connection-manager
  // https://github.com/partridgeworks/webos-launcher/blob/main/src/lib/inputs.ts
  // https://github.com/partridgeworks/webos-launcher/blob/main/src/config/constants.ts
  // https://github.com/zzeppieri/webos-custom-home/blob/main/src/service/luna.ts
  // https://github.com/webosose/com.webos.app.settings/blob/master/webos-meta/appinfo.json
  var SERVICES = {
    apps: 'luna://com.webos.applicationManager/listLaunchPoints',
    homebrew: 'luna://org.webosbrew.hbchannel.service/exec',
    launch: 'luna://com.webos.applicationManager/launch',
    network: 'luna://com.palm.connectionmanager/getStatus',
    inputs: 'luna://com.webos.service.eim/getAllInputStatus'
  };
  var APP_ID = 'org.lggate.launcher';
  // Existing Homebrew Channel supplies the permission needed on webOS 4.5.
  // This read-only command is constant: never interpolate app IDs or UI input.
  var CATALOG_COMMAND = "luna-send -n 1 -f luna://com.webos.applicationManager/listLaunchPoints '{}'";
  // Firmware 4.5 stores MSX's settings as UTF-16LE blobs. Read only these five
  // public configuration fields; never read its device ID, tokens or history.
  var MSX_COMMAND = "sqlite3 'file:/var/lib/wam/Default/Local Storage/file_de.benzac.msx_0.localstorage?mode=ro' " +
    "\"SELECT key,hex(value) FROM ItemTable WHERE key IN ('server','server_secure','start','start_name','start_version');\"";
  var MSX_CACHE_KEY = 'lg-gate-msx-catalog-v1';
  var MSX_SOURCE_KEY = 'lg-gate-msx-source-v1';
  var MSX_RETRY_KEY = 'lg-gate-msx-retry-v1';
  // The boot/wake daemon owns this public marker. Read the kernel boot ID too
  // so an orphaned marker can never validate another boot's cached catalogue.
  var SESSION_COMMAND = "head -c 513 /tmp/lg-gate-session.json 2>/dev/null; printf '\\n'; head -c 80 /proc/sys/kernel/random/boot_id 2>/dev/null";
  var MSX_RETRY_MS = 30000;
  var HOME_CACHE_PREFIX = 'lg-gate-home-cards-v1-';
  // Six 130px icons normally use far less. Keep storage bounded even when a
  // vendor publishes an unusually large PNG; metadata always has precedence.
  var HOME_CACHE_LIMIT = 1048576;
  var HOME_LIMIT = 6;
  var ICON_BATCH_LIMIT = 6;
  var ICON_READ_PREFIX = 'for p in ';
  var ICON_READ_SUFFIX = '; do printf \'%s\\t\' "$p"; head -c 262145 "$p" | base64 | tr -d \'\\n\'; printf \'\\n\'; done';

  function validIconPath(path) {
    if (typeof path !== 'string' || path.length > 2000 || !/^\/[A-Za-z0-9_@./-]+\.png$/i.test(path)) return false;
    if (path.slice(1).split('/').some(function (part) { return !part || part === '.' || part === '..'; })) return false;
    return /^\/(?:usr\/palm\/applications|media\/(?:cryptofs|developer|system)\/apps\/usr\/palm\/applications|mnt\/[A-Za-z0-9_-]+\/usr\/palm\/applications)\//.test(path);
  }

  function validIconBytes(bytes) {
    return typeof bytes === 'string' && bytes.length <= 349528 && bytes.indexOf('iVBORw0KGgo') === 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes) &&
      bytes.length / 4 * 3 - (/==$/.test(bytes) ? 2 : /=$/.test(bytes) ? 1 : 0) <= 262144;
  }

  function error(code, message, uri) {
    var result = new Error(message);
    result.code = code;
    if (uri) result.uri = uri;
    return result;
  }

  function text(value) {
    return typeof value === 'string' ? value.replace(/^\s+|\s+$/g, '') : '';
  }

  function inferBrand(id, name) {
    var identity = (id + ' ' + name).toLowerCase();
    if (/youtube.*(kids|дет)|дет.*youtube/.test(identity)) return 'kids';
    if (/youtube/.test(identity)) return 'youtube';
    if (/okko|окко/.test(identity)) return 'okko';
    if (/rutube|рутуб/.test(identity)) return 'rutube';
    if (/\bivi\b|иви/.test(identity)) return 'ivi';
    if (/\bzona\b|зона/.test(identity)) return 'zona';
    if (/kinopoisk|кинопоиск/.test(identity)) return 'kinopoisk';
    if (/\bwink\b|винк/.test(identity)) return 'wink';
    if (/\bkion\b|кион/.test(identity)) return 'kion';
    if (/\bvk\b|вк видео/.test(identity)) return 'vk';
    if (/mediastation|media station|\bmsx\b/.test(identity)) return 'msx';
    if (/iptv/.test(identity)) return 'iptv';
    if (/\bmts\b|мтс/.test(identity)) return 'mts';
    if (/yandex|яндекс/.test(identity)) return 'yandex';
    if (/homebrew|hbchannel/.test(identity)) return 'homebrew';
    return '';
  }

  function normalizeApps(payload) {
    if (!Array.isArray(payload.launchPoints)) {
      throw error('INVALID_RESPONSE', 'Служба приложений не вернула список launchPoints.', SERVICES.apps);
    }
    var result = [];
    var seen = Object.create(null);
    payload.launchPoints.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var id = text(item.id) || text(item.appId);
      if (!id || id === APP_ID || text(item.appId) === APP_ID || seen[id]) return;
      seen[id] = true;
      var app = { id: id, name: text(item.title) || text(item.name) || id };
      var brand = inferBrand(app.id, app.name);
      if (brand) app.brand = brand;
      if (text(item.largeIcon) || text(item.icon)) app.icon = text(item.largeIcon) || text(item.icon);
      result.push(app);
    });
    return result;
  }

  function connectionState(connection) {
    var state = connection && text(connection.state).toLowerCase();
    if (state === 'connected' || state === 'online' || state === 'ready') return true;
    if (state === 'disconnected' || state === 'idle' || state === 'offline') return false;
    return null;
  }

  function normalizeNetwork(payload) {
    var wired = connectionState(payload.wired);
    var wifi = connectionState(payload.wifi);
    var active = wired === true ? payload.wired : wifi === true ? payload.wifi : null;
    var internet = typeof payload.isInternetConnectionAvailable === 'boolean' ? payload.isInternetConnectionAvailable : null;
    if (internet === null && active) {
      if (active.onInternet === 'yes' || active.onInternet === true) internet = true;
      else if (active.onInternet === 'no' || active.onInternet === false) internet = false;
    }
    var result = {
      available: true,
      kind: wired === true ? 'wired' : wifi === true ? 'wifi' : wired === false && wifi === false ? 'none' : 'unknown',
      connected: active ? true : wired === false && wifi === false ? false : internet === true ? true : null,
      internet: internet
    };
    if (result.kind === 'wifi' && text(payload.wifi.ssid)) result.ssid = text(payload.wifi.ssid);
    if (result.kind === 'unknown') result.message = 'Система не сообщила тип подключения.';
    return result;
  }

  function normalizeInputs(payload) {
    if (!Array.isArray(payload.devices)) {
      throw error('INVALID_RESPONSE', 'Служба входов не вернула список devices.', SERVICES.inputs);
    }
    var seen = Object.create(null);
    var result = [];
    payload.devices.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var id = text(item.id) || text(item.appId);
      if (!id || seen[id]) return;
      seen[id] = true;
      var input = {
        id: id,
        name: text(item.label) || text(item.name) || id,
        connected: typeof item.connected === 'boolean' ? item.connected : null
      };
      if (text(item.appId)) input.appId = text(item.appId);
      result.push(input);
    });
    return result;
  }

  function createPlatform(environment, options) {
    var env = environment || {};
    var configuration = options || {};
    var PromiseClass = env.Promise || Promise;
    var schedule = env.setTimeout || setTimeout;
    var unschedule = env.clearTimeout || clearTimeout;
    var agent = env.navigator && env.navigator.userAgent || '';
    // A webOS browser without its native bridge must report unavailability,
    // rather than present a desktop demo as a working TV integration.
    var isTV = typeof env.PalmServiceBridge !== 'undefined' || !!env.webOSSystem || /web[o0]s/i.test(agent);
    var mode = isTV ? 'webos' : 'browser';
    var pending = [];
    var cancellationEpoch = 0;
    var iconCache = Object.create(null);
    var nativeApps = [];
    var nativeDescriptors = Object.create(null);
    var homePriorities = [];
    var visiblePriorities = [];
    var homeCache = Object.create(null);
    var catalogRequest = 0;
    var iconGeneration = 0;
    var iconAttempted = Object.create(null);
    var iconBusy = false;
    var iconTimer = null;
    var updateListener = null;
    var msxApps = [];
    var msxSource = '';
    var msxRequests = 0;
    var msxVerifiedSession = '';
    var msxFlight = null;
    var msxRetry = null;
    var powerSessionFlight = null;
    var previewSession = '';
    var now = env.Date && typeof env.Date.now === 'function' ? function () { return env.Date.now(); } : function () { return Date.now(); };
    var timeoutMs = typeof configuration.timeoutMs === 'number' && configuration.timeoutMs > 0 ? configuration.timeoutMs : 5000;
    var homeCacheKey = HOME_CACHE_PREFIX + mode;

    function copyApp(app) {
      var copy = {};
      Object.keys(app).forEach(function (key) { copy[key] = app[key]; });
      return copy;
    }

    function cleanIds(ids, maximum) {
      var result = [];
      if (!Array.isArray(ids)) return result;
      ids.forEach(function (id) {
        if (result.length < maximum && validId(id) && id.length <= 24576 && result.indexOf(id) < 0) result.push(id);
      });
      return result;
    }

    function sanitizeCard(app) {
      if (!app || typeof app !== 'object' || !validId(app.id) || app.id === APP_ID || app.id.length > 24576 || typeof app.name !== 'string') return null;
      var name = text(app.name).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').substr(0, 512);
      if (!name) return null;
      var copy = { id: app.id, name: name };
      var brand = inferBrand(copy.id, copy.name);
      if (brand) copy.brand = brand;
      if (app.id.indexOf('msx:') === 0) {
        if (!msxCatalog) return null;
        var parsed = msxCatalog.parseApps({ items: [{ title: name, action: app.action, image: app.icon }] })[0];
        if (!parsed || parsed.id !== app.id) return null;
        copy = parsed;
        if (brand) copy.brand = brand;
      } else if (typeof app.icon === 'string') {
        if (app.icon.indexOf('data:image/png;base64,') === 0 && validIconBytes(app.icon.substr(22))) copy.icon = app.icon;
        else if (validIconPath(app.icon) || (mode === 'browser' && /^assets\/tv-apps\/[A-Za-z0-9_.-]+\.png$/.test(app.icon))) copy.icon = app.icon;
      }
      return copy;
    }

    function readHomeCache() {
      try {
        var raw = env.localStorage && env.localStorage.getItem(homeCacheKey);
        if (!raw || raw.length > HOME_CACHE_LIMIT) return;
        var saved = JSON.parse(raw);
        if (!saved || saved.version !== 1 || !Array.isArray(saved.cards) || saved.cards.length > HOME_LIMIT) return;
        saved.cards.forEach(function (record) {
          var card = sanitizeCard(record && record.app);
          if (!card || homeCache[card.id]) return;
          var clean = { app: card };
          if (validIconPath(record.iconPath)) clean.iconPath = record.iconPath;
          if (typeof record.revision === 'string' && record.revision.length <= 2048) clean.revision = record.revision;
          if (card.source === 'msx' && typeof record.msxStart === 'string' && msxCatalog.getContentUrl(record.msxStart)) clean.msxStart = record.msxStart;
          homeCache[card.id] = clean;
        });
      } catch (ignoreCache) { /* Invalid or unavailable persistence is optional. */ }
    }
    readHomeCache();

    function getCachedHome(ids) {
      return cleanIds(ids, HOME_LIMIT).map(function (id) {
        var record = homeCache[id];
        if (!record || (record.app.source === 'msx' && (!msxSource || !msxApps.some(function (app) { return app.id === id; })))) return null;
        return copyApp(record.app);
      }).filter(function (app) { return !!app; });
    }

    function writeHomeRecords(records) {
      if (!env.localStorage) return false;
      var saved = { version: 1, cards: records };
      var json = JSON.stringify(saved);
      // Keep the earliest selected icons when the total budget is exceeded.
      for (var i = records.length - 1; json.length > HOME_CACHE_LIMIT && i >= 0; i--) {
        if (records[i].app.icon && records[i].app.icon.indexOf('data:') === 0) delete records[i].app.icon;
        json = JSON.stringify(saved);
      }
      try { env.localStorage.setItem(homeCacheKey, json); return true; }
      catch (quota) {
        records.forEach(function (record) { if (record.app.icon && record.app.icon.indexOf('data:') === 0) delete record.app.icon; });
        try { env.localStorage.setItem(homeCacheKey, JSON.stringify(saved)); return true; }
        catch (unavailable) { return false; }
      }
    }

    function saveHomeCache(ids, apps) {
      var selected = cleanIds(ids, HOME_LIMIT);
      var byId = Object.create(null);
      if (Array.isArray(apps)) apps.forEach(function (app) { if (app && selected.indexOf(app.id) >= 0) byId[app.id] = app; });
      var records = [];
      selected.forEach(function (id) {
        var card = sanitizeCard(byId[id]);
        var old = homeCache[id];
        if (!card && old) card = copyApp(old.app);
        if (!card) return;
        var record = { app: card };
        var descriptor = nativeDescriptors[id];
        if (descriptor) { record.iconPath = descriptor.path; record.revision = descriptor.revision; }
        else if (old) { record.iconPath = old.iconPath; record.revision = old.revision; }
        if (card.source === 'msx') record.msxStart = msxSource || old && old.msxStart || '';
        records.push(record);
      });
      // Update the in-memory copy even when localStorage is full. Favorites are
      // stored independently by the UI and are never rolled back for this cache.
      homeCache = Object.create(null);
      records.forEach(function (record) { homeCache[record.app.id] = { app: copyApp(record.app), iconPath: record.iconPath, revision: record.revision, msxStart: record.msxStart }; });
      try { return writeHomeRecords(records); } catch (ignoreCache) { return false; }
    }

    function dropCachedMSX() {
      Object.keys(homeCache).forEach(function (id) { if (homeCache[id].app.source === 'msx') delete homeCache[id]; });
      try { writeHomeRecords(Object.keys(homeCache).map(function (id) { return homeCache[id]; })); } catch (ignoreCache) { /* Optional cache. */ }
    }

    function cachedMSX() {
      try {
        var stampRaw = env.localStorage && env.localStorage.getItem(MSX_SOURCE_KEY);
        var stamp = null;
        try { stamp = stampRaw && stampRaw.length <= 16384 ? JSON.parse(stampRaw) : null; } catch (badStamp) { /* Ignore corrupt metadata. */ }
        if (stamp && (stamp.version !== 1 || typeof stamp.start !== 'string' || (stamp.start && !msxCatalog.getContentUrl(stamp.start)))) stamp = null;
        var raw = env.localStorage && env.localStorage.getItem(MSX_CACHE_KEY);
        var saved = null;
        try { saved = raw && raw.length <= 1048576 ? JSON.parse(raw) : null; } catch (badCatalog) { /* Home fallback can still be valid. */ }
        if (saved && saved.version === 1 && typeof saved.start === 'string' && msxCatalog.getContentUrl(saved.start) && Array.isArray(saved.items) && (!stamp || stamp.start === saved.start)) {
          msxSource = saved.start;
          msxApps = msxCatalog.parseApps({ items: saved.items });
          if (validSession(saved.session)) msxVerifiedSession = saved.session;
          return;
        }
        // A selected MSX card is usable even if the larger catalogue was evicted.
        // Require an independent source stamp so a confirmed reset cannot bring
        // back a shortcut from an older home snapshot.
        if (stamp && stamp.start) {
          msxSource = stamp.start;
          Object.keys(homeCache).forEach(function (id) {
            var record = homeCache[id];
            if (record.app.source === 'msx' && record.msxStart === msxSource) msxApps.push(copyApp(record.app));
          });
        }
      } catch (ignoreCache) { /* Read-only operation still works without persistence. */ }
    }
    if (msxCatalog) cachedMSX();

    function saveMSX() {
      try {
        if (!env.localStorage) return;
        env.localStorage.setItem(MSX_SOURCE_KEY, JSON.stringify({ version: 1, start: msxSource }));
      } catch (ignoreCache) {
        // Clearing optional stale data remains possible when quota prevents a
        // source-change write. Never resurrect a different portal after restart.
        try { env.localStorage.removeItem(MSX_CACHE_KEY); env.localStorage.removeItem(MSX_SOURCE_KEY); env.localStorage.removeItem(homeCacheKey); } catch (ignoreRemoval) { /* Persistence may be entirely unavailable. */ }
        return;
      }
      if (!msxSource) { try { env.localStorage.removeItem(MSX_CACHE_KEY); } catch (ignoreRemoval) { /* Optional. */ } return; }
      // Keep the small source stamp if the larger catalogue no longer fits;
      // selected home cards can then supply the validated early-launch fallback.
      try {
        var json = JSON.stringify({ version: 1, start: msxSource, session: msxVerifiedSession, items: msxApps.map(function (app) {
          return { title: app.name, action: app.action, image: app.icon || '' };
        }) });
        if (json.length > 1048576) throw error('CACHE_LIMIT', 'Каталог MSX превышает размер кэша.');
        env.localStorage.setItem(MSX_CACHE_KEY, json);
      } catch (catalogQuota) { try { env.localStorage.removeItem(MSX_CACHE_KEY); } catch (ignoreRemoval) { /* Optional. */ } }
    }

    function validBootId(value) {
      return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    function validSession(value) {
      if (typeof value !== 'string' || value.length > 128) return false;
      var parts = value.split(':');
      return (parts[0] === 'boot' && parts.length === 2 && validBootId(parts[1])) ||
        (parts[0] === 'wake' && parts.length === 3 && validBootId(parts[1]) && /^[0-9a-f]{24}$/.test(parts[2]));
    }

    function readPowerRecord() {
      if (powerSessionFlight) return powerSessionFlight;
      powerSessionFlight = lunaCall(SERVICES.homebrew, { command: SESSION_COMMAND }).then(function (payload) {
        var output = payload.stdoutString;
        if (typeof output !== 'string' || output.length > 600) return { session: '', awakeSession: '' };
        var split = output.lastIndexOf('\n', output.length - (output.slice(-1) === '\n' ? 2 : 1));
        var bootId = text(output.substr(split + 1));
        if (!validBootId(bootId)) return { session: '', awakeSession: '' };
        var marker = null;
        try { marker = JSON.parse(output.substr(0, split)); } catch (invalidMarker) { /* Boot-scoped fallback before daemon installation. */ }
        if (marker && marker.version === 1 && marker.bootId === bootId && typeof marker.sessionId === 'string' && /^[0-9a-f]{24}$/.test(marker.sessionId)) {
          var session = 'wake:' + bootId + ':' + marker.sessionId;
          return { session: session, awakeSession: marker.sleeping === false ? session : '' };
        }
        return { session: 'boot:' + bootId, awakeSession: '' };
      }).catch(function (failure) {
        if (failure.code === 'CANCELLED') throw failure;
        return { session: '', awakeSession: '' };  // Optional marker failure never hides native apps.
      });
      var flight = powerSessionFlight;
      function settled() { if (powerSessionFlight === flight) powerSessionFlight = null; }
      flight.then(settled, settled);
      return flight;
    }

    function readMSXSession() {
      return readPowerRecord().then(function (record) { return record.session; });
    }

    function readPreviewSession() {
      if (previewSession) return previewSession;
      var key = 'lg-gate-preview-session-v1';
      try {
        var saved = env.sessionStorage && env.sessionStorage.getItem(key);
        if (typeof saved === 'string' && /^preview:[a-z0-9:-]{1,90}$/.test(saved)) previewSession = saved;
      } catch (ignoreRead) { /* Private browsing may block sessionStorage. */ }
      if (!previewSession) {
        previewSession = 'preview:' + now().toString(36) + ':' + Math.random().toString(36).substr(2, 16);
        try { if (env.sessionStorage) env.sessionStorage.setItem(key, previewSession); } catch (ignoreWrite) { /* This renderer still has a stable preview session. */ }
      }
      return previewSession;
    }

    function clearMSXRetry() {
      msxRetry = null;
      try { if (env.localStorage) env.localStorage.removeItem(MSX_RETRY_KEY); } catch (ignoreStorage) { /* Optional. */ }
    }

    function retryMSXLater(source, session) {
      msxRetry = { version: 1, start: source, session: session, retryAt: now() + MSX_RETRY_MS };
      try { if (env.localStorage) env.localStorage.setItem(MSX_RETRY_KEY, JSON.stringify(msxRetry)); } catch (ignoreStorage) { /* In-memory cooldown remains useful. */ }
    }

    function msxRetryPending(source, session) {
      if (!msxRetry) {
        try {
          var raw = env.localStorage && env.localStorage.getItem(MSX_RETRY_KEY);
          if (raw && raw.length <= 32768) msxRetry = JSON.parse(raw);
        } catch (ignoreStorage) { /* Treat corrupt data as an expired cooldown. */ }
      }
      var time = now();
      return msxRetry && msxRetry.version === 1 && msxRetry.start === source && msxRetry.session === session &&
        typeof msxRetry.retryAt === 'number' && isFinite(msxRetry.retryAt) && msxRetry.retryAt > time && msxRetry.retryAt <= time + MSX_RETRY_MS;
    }

    function readMSXJSON(url) {
      return new PromiseClass(function (resolve, reject) {
        var xhr;
        var timer;
        var settled = false;
        var cancel;
        function finish(failure, payload) {
          if (settled) return;
          settled = true;
          if (timer !== undefined) unschedule.call(env, timer);
          var index = pending.indexOf(cancel);
          if (index >= 0) pending.splice(index, 1);
          if (xhr) {
            xhr.onload = xhr.onerror = xhr.onprogress = null;
            if (failure) try { xhr.abort(); } catch (ignoreAbort) { /* Already stopped. */ }
          }
          if (failure) reject(failure); else resolve(payload);
        }
        cancel = function () { finish(error('CANCELLED', 'Чтение каталога MSX отменено.')); };
        pending.push(cancel);
        try {
          if (!msxCatalog.isHttpUrl(url) || typeof env.XMLHttpRequest !== 'function') throw error('MSX_UNAVAILABLE', 'Каталог MSX недоступен.');
          xhr = new env.XMLHttpRequest();
          xhr.open('GET', url, true);
          // No credentials are copied from MSX. The configured public endpoint
          // supplies the catalogue, with the same CORS rules as a regular web app.
          xhr.onload = function () {
            if (xhr.status < 200 || xhr.status >= 300 || typeof xhr.responseText !== 'string' || xhr.responseText.length > 1048576) {
              finish(error('MSX_UNAVAILABLE', 'Не удалось загрузить каталог MSX.')); return;
            }
            var payload;
            try { payload = JSON.parse(xhr.responseText); }
            catch (invalidJSON) { finish(error('INVALID_RESPONSE', 'Каталог MSX вернул некорректный JSON.')); return; }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
              finish(error('INVALID_RESPONSE', 'Каталог MSX вернул некорректный список.')); return;
            }
            finish(null, payload);
          };
          xhr.onerror = function () { finish(error('MSX_UNAVAILABLE', 'Каталог MSX недоступен по сети.')); };
          xhr.onprogress = function (event) {
            if (event.loaded > 1048576) finish(error('INVALID_RESPONSE', 'Каталог MSX превышает допустимый размер.'));
          };
          timer = schedule.call(env, function () { finish(error('TIMEOUT', 'Каталог MSX не ответил вовремя.')); }, timeoutMs);
          xhr.send();
        } catch (failure) { finish(failure); }
      });
    }

    function combinedCatalog() {
      return nativeApps.concat(msxApps.map(function (app) {
        var copy = copyApp(app);
        var brand = inferBrand(copy.id, copy.name);
        if (brand) copy.brand = brand;
        return copy;
      })).map(copyApp);
    }

    function emitCatalog(iconsOnly) {
      platform.catalogStatus.iconsOnly = !!iconsOnly;
      var catalog = combinedCatalog();
      if (updateListener) {
        // Listeners receive snapshots; later icons/source updates never mutate
        // records the UI may currently be using for a reorder draft.
        try { updateListener(catalog, copyApp(platform.catalogStatus)); }
        catch (ignoreListener) { /* A consumer callback must not stop service cleanup. */ }
      }
      return catalog;
    }

    function mergeMSX(catalog, epoch, catalogSequence) {
      var request = ++msxRequests;
      if (!msxCatalog || !catalog.some(function (app) { return app.id === 'de.benzac.msx'; })) {
        msxApps = []; msxSource = ''; msxVerifiedSession = ''; clearMSXRetry(); saveMSX();
        dropCachedMSX();
        platform.catalogStatus.msxComplete = true;
        return PromiseClass.resolve(emitCatalog(false));
      }
      var source = null;
      var session = '';
      var fetched = false;
      var cooldown = false;
      function active() {
        if (epoch !== cancellationEpoch || request !== msxRequests || catalogSequence !== catalogRequest) throw error('CANCELLED', 'Чтение каталога MSX отменено.');
      }
      function follow(url, depth, visited) {
        if (!url || depth > 3 || visited.indexOf(url) >= 0) throw error('MSX_UNAVAILABLE', 'Неподдерживаемая конфигурация каталога MSX.');
        visited.push(url);
        return readMSXJSON(url).then(function (payload) {
          // Network work can be shared by a newer native catalogue refresh.
          // Only its latest consumer may commit the resulting MSX snapshot.
          if (epoch !== cancellationEpoch) throw error('CANCELLED', 'Чтение каталога MSX отменено.');
          // Start objects may point at the actual content/menu. Do not follow
          // parameter on a content object that already has its own items.
          if (!Array.isArray(payload.items) && !Array.isArray(payload.pages) && !Array.isArray(payload.menu) && payload.parameter) {
            return follow(msxCatalog.getContentUrl(payload.parameter), depth + 1, visited);
          }
          if (!Array.isArray(payload.items) && !Array.isArray(payload.pages) && !Array.isArray(payload.menu)) {
            throw error('INVALID_RESPONSE', 'Каталог MSX не содержит списка приложений.');
          }
          return msxCatalog.parseApps(payload);
        });
      }
      return lunaCall(SERVICES.homebrew, { command: MSX_COMMAND }).then(function (payload) {
        active();
        var settings = msxCatalog.parseSettings(payload.stdoutString);
        source = settings.start;
        var url = msxCatalog.getContentUrl(source);
        if (source !== msxSource) {
          msxApps = []; msxSource = url ? source : ''; msxVerifiedSession = ''; clearMSXRetry(); saveMSX(); dropCachedMSX();
          platform.catalogStatus.msxComplete = true;
          emitCatalog(false);
        }
        if (!url) {
          msxApps = []; msxSource = ''; msxVerifiedSession = ''; clearMSXRetry(); saveMSX();
          platform.msxStatus = { available: false, message: 'Для этой конфигурации MSX автоматический импорт недоступен.' };
          return [];
        }
        return readMSXSession().then(function (currentSession) {
          active();
          session = currentSession;
          if (session && msxVerifiedSession === session) return msxApps;
          if (msxRetryPending(source, session)) { cooldown = true; return msxApps; }
          fetched = true;
          if (msxFlight && msxFlight.epoch === epoch && msxFlight.source === source && msxFlight.session === session) return msxFlight.promise;
          var flight = { epoch: epoch, source: source, session: session };
          msxFlight = flight;
          flight.promise = follow(url, 0, []).then(function (items) {
            if (msxFlight === flight) msxFlight = null;
            return items;
          }, function (failure) {
            if (msxFlight === flight) msxFlight = null;
            throw failure;
          });
          return flight.promise;
        });
      }).then(function (items) {
        active();
        if (cooldown) {
          platform.msxStatus = { available: false, cached: msxApps.length > 0, retryPending: true, message: 'Повторное чтение MSX отложено после временной ошибки.' };
          return emitCatalog(false);
        }
        msxApps = items; msxSource = source && msxCatalog.getContentUrl(source) ? source : '';
        if (fetched) { msxVerifiedSession = session; clearMSXRetry(); saveMSX(); }
        // Successful empty/new catalogues invalidate selected stale shortcuts.
        Object.keys(homeCache).forEach(function (id) {
          if (homeCache[id].app.source === 'msx' && !msxApps.some(function (app) { return app.id === id; })) delete homeCache[id];
        });
        try { writeHomeRecords(Object.keys(homeCache).map(function (id) { return homeCache[id]; })); } catch (ignoreCache) { /* Optional. */ }
        platform.catalogStatus.msxComplete = true;
        platform.msxStatus = { available: !!msxSource, count: items.length, sessionCached: !!session && !fetched };
        return emitCatalog(false);
      }).catch(function (failure) {
        active();
        if (failure.code === 'CANCELLED') throw failure;
        if (fetched && source && msxCatalog.getContentUrl(source)) retryMSXLater(source, session);
        // Keep known shortcuts during a temporary network/read failure. A
        // different configured source must never inherit the old portal's apps.
        if (source !== null && source !== msxSource) { msxApps = []; msxSource = ''; msxVerifiedSession = ''; saveMSX(); dropCachedMSX(); platform.catalogStatus.msxComplete = true; }
        platform.msxStatus = { available: false, cached: msxApps.length > 0, message: failure.message };
        return emitCatalog(false);
      });
    }

    function lunaCall(uri, params) {
      return new PromiseClass(function (resolve, reject) {
        var Bridge = env.PalmServiceBridge;
        var bridge;
        var timer;
        var settled = false;
        var cancelRequest;

        function finish(failure, payload) {
          if (settled) return;
          settled = true;
          if (timer !== undefined) unschedule.call(env, timer);
          var index = pending.indexOf(cancelRequest);
          if (index >= 0) pending.splice(index, 1);
          if (bridge) {
            try { bridge.onservicecallback = null; } catch (ignoreCallback) { /* Native bridge may already be gone. */ }
            try { if (typeof bridge.cancel === 'function') bridge.cancel(); } catch (ignoreCancel) { /* Settled calls must stay settled. */ }
          }
          if (failure) reject(failure);
          else resolve(payload);
        }

        if (typeof Bridge !== 'function') {
          reject(error('BRIDGE_UNAVAILABLE', 'Системный мост webOS недоступен. Откройте установленное приложение на телевизоре.', uri));
          return;
        }
        cancelRequest = function () { finish(error('CANCELLED', 'Запрос к webOS отменён.', uri)); };
        pending.push(cancelRequest);
        try {
          bridge = new Bridge();
          bridge.onservicecallback = function (message) {
            if (settled) return;
            var payload;
            try { payload = JSON.parse(message); }
            catch (invalidJSON) {
              finish(error('INVALID_RESPONSE', 'Служба webOS вернула некорректный JSON.', uri));
              return;
            }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.returnValue !== 'boolean') {
              finish(error('INVALID_RESPONSE', 'В ответе webOS отсутствует признак успешного выполнения returnValue.', uri));
              return;
            }
            if (!payload.returnValue) {
              var failure = error('SERVICE_ERROR', text(payload.errorText) || 'Служба webOS отклонила запрос. Проверьте доступность API и права приложения.', uri);
              if (payload.errorCode !== undefined) failure.serviceCode = payload.errorCode;
              finish(failure);
              return;
            }
            finish(null, payload);
          };
          timer = schedule.call(env, function () {
            finish(error('TIMEOUT', 'Служба webOS не ответила вовремя.', uri));
          }, timeoutMs);
          bridge.call(uri, JSON.stringify(params || {}));
        } catch (bridgeError) {
          finish(error('BRIDGE_ERROR', 'Не удалось вызвать службу webOS: ' + (bridgeError && bridgeError.message || String(bridgeError)), uri));
        }
      });
    }

    function validId(id) {
      return typeof id === 'string' && text(id) === id && id.length > 0;
    }

    function describeNative(payload) {
      var result = Object.create(null);
      payload.launchPoints.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var id = text(item.id) || text(item.appId);
        var path = text(item.largeIcon) || text(item.icon);
        if (!id || result[id] || !validIconPath(path)) return;
        // Version/install timestamps distinguish app updates at the same path.
        // Every successful native refresh still revalidates visible PNG bytes,
        // because older firmware does not always supply an update timestamp.
        var revision = [item.version, item.installTime, item.updateTime, item.lastUpdated].map(function (part) {
          return typeof part === 'string' || typeof part === 'number' ? String(part).substr(0, 256) : '';
        }).join('|');
        result[id] = { path: path, revision: revision };
      });
      return result;
    }

    function usefulIcon(app) {
      return app && !/^(youtube|okko|rutube|ivi|zona)$/.test(app.brand || '') && nativeDescriptors[app.id];
    }

    function applyKnownIcons() {
      nativeApps.forEach(function (app) {
        var descriptor = usefulIcon(app);
        if (!descriptor) return;
        var cached = iconCache[app.id];
        var saved = homeCache[app.id];
        if (cached) app.icon = cached.icon;
        else if (saved && saved.app.icon && saved.app.icon.indexOf('data:') === 0) app.icon = saved.app.icon;
      });
    }

    function queueIcons() {
      if (mode !== 'webos' || iconBusy || iconTimer !== null || !platform.catalogStatus.nativeComplete) return;
      // Defer reads until after the metadata callback can render a first frame.
      iconTimer = schedule.call(env, function () { iconTimer = null; readIconBatch(); }, 0);
    }

    function readIconBatch() {
      if (iconBusy || !platform.catalogStatus.nativeComplete) return;
      var generation = iconGeneration;
      var epoch = cancellationEpoch;
      var sequence = catalogRequest;
      var order = cleanIds(homePriorities.concat(visiblePriorities), 1000);
      var paths = [];
      var requested = Object.create(null);
      var descriptors = [];
      order.some(function (id) {
        var app = nativeApps.filter(function (candidate) { return candidate.id === id; })[0];
        var descriptor = usefulIcon(app);
        if (!descriptor || iconAttempted[id]) return false;
        iconAttempted[id] = true;
        descriptors.push({ id: id, path: descriptor.path, revision: descriptor.revision });
        if (!requested[descriptor.path]) { requested[descriptor.path] = true; paths.push(descriptor.path); }
        return descriptors.length >= ICON_BATCH_LIMIT;
      });
      if (!paths.length) return;
      iconBusy = true;
      // Bounded read-only batches; paths come only from the system catalogue,
      // pass the application-tree PNG allowlist and are separately quoted.
      var command = ICON_READ_PREFIX + paths.map(function (path) { return "'" + path + "'"; }).join(' ') + ICON_READ_SUFFIX;
      lunaCall(SERVICES.homebrew, { command: command }).then(function (response) {
        if (epoch !== cancellationEpoch || sequence !== catalogRequest || generation !== iconGeneration || typeof response.stdoutString !== 'string' || response.stdoutString.length > ICON_BATCH_LIMIT * 352000) return;
        var received = Object.create(null);
        response.stdoutString.split('\n').forEach(function (line) {
          var columns = line.split('\t');
          if (columns.length === 2 && requested[columns[0]] && validIconBytes(columns[1])) received[columns[0]] = 'data:image/png;base64,' + columns[1];
        });
        var changed = false;
        descriptors.forEach(function (descriptor) {
          var current = nativeDescriptors[descriptor.id];
          if (!received[descriptor.path] || !current || current.path !== descriptor.path || current.revision !== descriptor.revision) return;
          iconCache[descriptor.id] = { path: descriptor.path, revision: descriptor.revision, icon: received[descriptor.path] };
          nativeApps.forEach(function (app) { if (app.id === descriptor.id && app.icon !== received[descriptor.path]) { app.icon = received[descriptor.path]; changed = true; } });
        });
        if (changed) emitCatalog(true);
      }).catch(function () {
        // PNG work is independent of getApps(). A failed/cancelled late read has
        // no unhandled rejection and never hides an application's metadata.
      }).then(function () {
        iconBusy = false;
        // Re-evaluate priorities between batches; recently pinned cards win.
        queueIcons();
      });
    }

    function launch(id) {
      if (!validId(id)) return PromiseClass.reject(error('INVALID_ID', 'Не указан идентификатор приложения.'));
      if (mode === 'browser') return PromiseClass.resolve({ simulated: true });
      if (id.indexOf('msx:') === 0) {
        var shortcut = msxApps.filter(function (app) { return app.id === id; })[0];
        if (!shortcut || !msxCatalog.isHttpUrl(shortcut.launchUrl)) return PromiseClass.reject(error('INVALID_ID', 'Приложение MSX отсутствует в текущем каталоге.'));
        if (shortcut.launchMode === 'embedded') return PromiseClass.resolve({ simulated: false, embedded: true, url: shortcut.launchUrl });
        return lunaCall(SERVICES.launch, { id: 'com.webos.app.browser', params: { target: shortcut.launchUrl } }).then(function () { return { simulated: false }; });
      }
      // The actual service-supplied ID goes directly to JSON, never to a shell.
      return lunaCall(SERVICES.launch, { id: id, params: {} }).then(function () { return { simulated: false }; });
    }

    var platform = {
      mode: mode,
      catalogSource: mode === 'browser' ? 'tv-snapshot' : 'webos',
      catalogStatus: { nativeComplete: false, msxComplete: false, iconsOnly: false },
      getPowerSession: function () {
        // Only an awake marker identifies the currently active power session.
        // MSX retains its historical boot-scoped fallback independently.
        return mode === 'browser' ? PromiseClass.resolve(readPreviewSession()) : readPowerRecord().then(function (record) { return record.awakeSession; });
      },
      getCachedHome: getCachedHome,
      saveHomeCache: saveHomeCache,
      setAppPriorities: function (homeIds, visibleIds) {
        homePriorities = cleanIds(homeIds, HOME_LIMIT);
        visiblePriorities = cleanIds(visibleIds, 1000);
        queueIcons();
      },
      getApps: function (options) {
        var requestEpoch = cancellationEpoch;
        var sequence = ++catalogRequest;
        updateListener = options && typeof options.onUpdate === 'function' ? options.onUpdate : null;
        platform.catalogStatus = { nativeComplete: false, msxComplete: false, iconsOnly: false };
        function active() {
          if (requestEpoch !== cancellationEpoch || sequence !== catalogRequest) throw error('CANCELLED', 'Запрос к webOS отменён.', SERVICES.apps);
        }
        if (mode === 'browser') return PromiseClass.resolve().then(function () {
          active();
          if (!previewSnapshot) throw error('SNAPSHOT_UNAVAILABLE', 'Снимок приложений телевизора не загружен. Обновите предпросмотр.');
          nativeApps = normalizeApps(previewSnapshot);
          platform.catalogStatus = { nativeComplete: true, msxComplete: true, iconsOnly: false };
          return emitCatalog(false);
        });
        return lunaCall(SERVICES.apps, {}).catch(function (failure) {
          if (failure.code !== 'SERVICE_ERROR') throw failure;
          active();
          return lunaCall(SERVICES.homebrew, { command: CATALOG_COMMAND }).then(function (response) {
            var catalog;
            try { catalog = JSON.parse(response.stdoutString); }
            catch (invalidCatalog) { throw error('INVALID_RESPONSE', 'Homebrew Channel не вернул JSON каталога.', SERVICES.apps); }
            if (!catalog || catalog.returnValue !== true) {
              throw error('SERVICE_ERROR', 'Не удалось прочитать каталог через Homebrew Channel.', SERVICES.apps);
            }
            return catalog;
          });
        }).then(function (payload) {
          active();
          nativeApps = normalizeApps(payload);
          nativeDescriptors = describeNative(payload);
          iconGeneration++;
          iconAttempted = Object.create(null);
          // Bound in-memory icon data to the current native catalogue.
          Object.keys(iconCache).forEach(function (id) { if (!nativeDescriptors[id]) delete iconCache[id]; });
          applyKnownIcons();
          platform.catalogStatus.nativeComplete = true;
          emitCatalog(false);
          queueIcons();
          return mergeMSX(nativeApps, requestEpoch, sequence);
        }).then(function (catalog) {
          active();
          return catalog;
        });
      },
      getNetwork: function () {
        if (mode === 'browser') return PromiseClass.resolve({
          available: false,
          kind: 'unknown',
          connected: null,
          internet: null,
          message: 'Сеть телевизора недоступна в браузерном предпросмотре.'
        });
        return lunaCall(SERVICES.network, { subscribe: false }).then(normalizeNetwork);
      },
      getInputs: function () {
        if (mode === 'browser') return PromiseClass.resolve([]);
        return lunaCall(SERVICES.inputs, {}).then(normalizeInputs);
      },
      launchApp: launch,
      openSettings: function () { return launch('com.palm.app.settings'); },
      openWifiSettings: function () {
        if (mode === 'browser') return PromiseClass.resolve({ simulated: true });
        // The installed LG settings app maps WifiConnection to Network/Wifi.
        // Let webOS handle network selection and credentials in its own UI.
        return lunaCall(SERVICES.launch, {
          id: 'com.palm.app.settings', params: { target: 'WifiConnection' }
        }).then(function () { return { simulated: false }; });
      },
      switchInput: function (id, control) {
        if (!validId(id)) return PromiseClass.reject(error('INVALID_ID', 'Не указан идентификатор входа.'));
        if (control && control.cancelled === true) return PromiseClass.reject(error('CANCELLED', 'Переключение входа отменено.'));
        if (mode === 'browser') return PromiseClass.resolve({ simulated: true });
        return platform.getInputs().then(function (inputs) {
          // The UI can cancel while the EIM read is pending. Once the launch
          // request has been sent, cancellation cannot undo that system action.
          if (control && control.cancelled === true) throw error('CANCELLED', 'Переключение входа отменено.');
          for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].id !== id) continue;
            if (!inputs[i].appId) throw error('INPUT_UNAVAILABLE', 'Система не сообщила приложение для выбранного входа.');
            return launch(inputs[i].appId);
          }
          throw error('INPUT_UNAVAILABLE', 'Выбранный вход отсутствует в текущем списке телевизора.');
        });
      },
      // Optional lifecycle hook for a consumer leaving the page; always cancels
      // each native bridge and rejects its pending Promise exactly once.
      cancelPending: function () {
        cancellationEpoch++;
        iconGeneration++;
        platform.catalogStatus.nativeComplete = false;
        updateListener = null;
        if (iconTimer !== null) { unschedule.call(env, iconTimer); iconTimer = null; }
        pending.slice().forEach(function (cancel) { cancel(); });
      }
    };
    return platform;
  }

  var platform = createPlatform(defaultEnvironment);
  platform.createPlatform = createPlatform;
  return platform;
}));

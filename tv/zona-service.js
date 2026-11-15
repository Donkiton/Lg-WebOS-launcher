'use strict';
// PC proof of an on-TV loopback service. All runtime code is ES5/Node 0.12.
// This file never invokes Python, SSH, browsers, installers, or child processes.
var http = require('http');
var url = require('url');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var request = require('./request');
var nativeClient = require('./native-client');
var nativeApi = require('./native-api').create({ http: request, portable: require('./portable') });
var catalogModule = require('./native-catalog');
var nativeCatalog = catalogModule.create({ native: nativeApi });
var nativeStreamsModule = require('./native-streams');
var nativeStreams = nativeStreamsModule.create({ native: nativeApi });
var providerDependencies = { native: nativeApi, http: request, portable: require('./portable') };
var providerMap = { kinogo: { name: 'Kinogo', getStreams: extract },
  rezka: require('./provider-rezka').create(providerDependencies),
  extra: require('./provider-extra').create(providerDependencies) };
var providerAddon = require('./provider-addon').create({ providers: Object.keys(providerMap).map(function (name) {return providerMap[name];}) });
var providerResults = [];
var kinogo = require('./kinogo/kinogo');
var loaderMerge = require('./loader-native');
var playerPatch = require('./player-patch');
var compatibilityVersion = 'zona-providers-20261115.1';
var capabilities = { catalog: 'android-api-v1', episodeSources: 'android-api-v1', providerAddon: 'native-provider-addon-v1', mediaProxy: true };
var playerPatchStatus = { version: playerPatch.version, appliedAssets: 0, upstreamAssets: 0, mode: 'pending', lastUpstreamSha256: null, lastError: null };
var portalImages = require('./portal-image-patch');
var portalImageStatus = { version: portalImages.version, appliedAssets: 0, upstreamAssets: 0, mode: 'pending', lastUpstreamSha256: null, lastError: null };
var graphicCache = require('./graphic-cache');
var PersistentImageCache = require('./persistent-image-cache');
var heroMaskVersion = 'legacy-hero-mask-bottom-v1';
var heroMaskStyle = '<style id="lg-gate-legacy-hero-mask-v1">@supports (-webkit-mask-composite: source-in) { @supports not (mask-composite: intersect) { img._backgroundImage_1e3b9_21 { -webkit-mask-composite: source-in, source-over; } } }</style>';
var args = {};
process.argv.slice(2).forEach(function (item) { var pair = item.replace(/^--/, '').split('='); args[pair.shift()] = pair.join('='); });
var forbiddenChildAttempts = 0;
if (args['forbid-child-processes'] === '1') {
  process.env.PATH = '';
  var childProcess = require('child_process');
  ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync'].forEach(function (method) {
    childProcess[method] = function () { forbiddenChildAttempts++; throw new Error('External process forbidden by autonomy proof'); };
  });
}
var host = args.host || '127.0.0.1';
var publicHost = args['public-host'] || host;
var portalPort = Number(args.port || 17861);
var playerPort = portalPort + 1;
var portalOrigin = 'http://' + publicHost + ':' + portalPort;
var playerOrigin = 'http://' + publicHost + ':' + playerPort;
var mediaRelay = require('./media-relay').create({ origin: playerOrigin,
  allowedHosts: [/(^|\.)vkuser\.net$/, /(^|\.)okcdn\.ru$/] });
var Cache = require('./bounded-cache');
var log = require('./bounded-log')(args['log-file']);
var cache = new Cache(4, 1024 * 1024, 120000, 512 * 1024);
var reports = [];
var pending = {};
var assets = new Cache(256, 8 * 1024 * 1024, 1800000, 3 * 1024 * 1024);
var imageCacheDirectory = args['image-cache-dir'] || (process.platform === 'linux' ? '/var/lib/lg-gate/zona/image-cache' : null);
var imageFiles = new PersistentImageCache(imageCacheDirectory);
var pendingImages = Object.create(null);
var portalReady = false, playerReady = false;
var loaderPath = path.join(__dirname, '..', 'vendor', 'loader-original.js');
var loader = fs.readFileSync(loaderPath, 'utf8');
loader = 'var globalThis=window;\n' + loaderMerge.patch(loader, { nativeTimeoutMs: 25000, playerOrigin: playerOrigin });

function safeError(error) { return String(error && error.message || error).replace(/https?:\/\/[^\s"']+/g, '[URL]').slice(0, 250); }
// These guards protect optional transformations, not the public site's trust.
// A new provider build must still boot with its own legacy implementation.
// Exact supported builds retain strict anchor checks inside each patcher.
function compatibleAsset(patcher, status, text, stage) {
  var digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  var supported = patcher.supportedUpstreamSha256 || [patcher.pinnedUpstreamSha256];
  status.lastUpstreamSha256 = digest;
  if (supported.indexOf(digest) < 0) {
    status.mode = 'upstream';
    status.upstreamAssets++;
    status.lastError = 'Optional compatibility patch skipped for unknown upstream SHA256: ' + digest;
    log(JSON.stringify({ stage: stage, mode: status.mode, sha256: digest }));
    return text;
  }
  var patched = patcher.patch(text);
  status.mode = 'patched';
  status.appliedAssets++;
  status.lastError = null;
  return patched;
}
function json(response, status, value) {
  if (response.finished || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
function extract(kpId, episodeKey, callback) {
  var key = String(kpId) + ':' + episodeKey;
  var cached = cache.get(key);
  if (cached) return callback(null, cached);
  if (pending[key]) { if (pending[key].length >= 8) return callback(new Error('Metadata waiter limit')); pending[key].push(callback); return; }
  if (Object.keys(pending).length >= 2) return callback(new Error('Metadata concurrency limit'));
  pending[key] = [callback];
  var started = Date.now();
  function finish(error, value) {
    var callbacks = pending[key]; delete pending[key];
    callbacks.forEach(function (cb) { cb(error, value); });
  }
  nativeStreams.getSources(kpId, episodeKey, function (error, sources) {
    if (error) return finish(error);
    var row = sources.data.filter(function (item) { return item.videoSourceTypeId === 54; })[0];
    // This optional provider does not cover every title/episode. Absence is a
    // successful empty result, not an HTTP error in an otherwise working player.
    if (!row) return finish(null, { items: [], report: { kpId: kpId, episodeKey: episodeKey, sourceType: 54, available: false } });
    var source = { kinopoisk_id: kpId, episode_key: episodeKey, video_source_type_id: 54, download_link_key: row.downloadLinkKey };
    nativeClient.fetchConfig(function (error, config) {
      if (error) return finish(error);
      kinogo.fetchKinogoStreams(source, config, request).then(function (result) {
        if (!result.summary || result.summary.status !== 'streams_found' || !result.streams || !result.streams.length) return finish(new Error('No complete usable translation metadata'));
        var translations = [];
        var russian = [];
        result.streams.forEach(function (stream) {
          if (translations.indexOf(stream.translation) < 0) translations.push(stream.translation);
          if (stream.language === 'ru' && russian.indexOf(stream.translation) < 0) russian.push(stream.translation);
        });
        var videoStreams = result.streams.map(function (stream) { return { source: { url: stream.url, headers: stream.headers }, translation: stream.translation || '', language: stream.language || '', resolution: stream.resolution, isTrailer: false }; });
        var report = { kpId: kpId, episodeKey: episodeKey, sourcesCount: sources.data.length, translations: translations, russian: russian, streamsCount: result.streams.length, node: process.version, pythonRequired: false, externalProcessRequired: false, durationMs: Date.now() - started, memory: process.memoryUsage(), createdAt: new Date().toISOString() };
        var value = { items: [{ extractorType: { id: 54, name: 'KINOGO' }, videoStreams: videoStreams }], report: report, createdAt: Date.now() };
        cache.set(key, value, Buffer.byteLength(JSON.stringify(value)));
        reports.push(report);
        if (reports.length > 8) reports.splice(0, reports.length - 8);
        log(JSON.stringify({ stage: 'metadata', report: report }));
        finish(null, value);
      }, finish);
    });
  });
}
function rewrite(text) {
  var imagePrefix = portalOrigin + '/__zona/img/';
  text = text.replace(/https:\/\/(img\d+\.zonapic\.com)/g, imagePrefix + '$1');
  return text.split('https://kinoserial.online').join(playerOrigin).split('https://msx.zona.ms').join(portalOrigin);
}
var imageBootstrap = '(function(){var prefix=' + JSON.stringify(portalOrigin + '/__zona/img/') + ';function fix(n){if(!n||n.nodeType!==1)return;if(n.tagName==="IMG"){var s=n.getAttribute("src")||"",m=/^(?:https?:)?\\/\\/(img\\d+\\.zona(?:pic\\.com|film\\.ru))/.exec(s);if(m)n.setAttribute("src",prefix+m[1].replace("zonafilm.ru","zonapic.com")+s.slice(m[0].length));}var a=n.querySelectorAll("img");for(var i=0;i<a.length;i++)fix(a[i]);}new MutationObserver(function(rs){for(var i=0;i<rs.length;i++){if(rs[i].type==="attributes")fix(rs[i].target);else for(var j=0;j<rs[i].addedNodes.length;j++)fix(rs[i].addedNodes[j]);}}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["src"]});fix(document.documentElement);})();';
function isCatalogImage(address) {
  return /^https:\/\/img\d+\.zonapic\.com\/images\/[A-Za-z0-9_\/-]+\.(?:jpe?g|png|webp|gif)(?:\?[^#]*)?$/i.test(address);
}
function proxy(origin, req, res, extraHeaders) {
  var address = origin + req.url;
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Read-only preview' });
  var catalogImage = isCatalogImage(address);
  function reply(request, response, status, type, body, complete, tier) {
    if (catalogImage) response.setHeader('X-LG-Gate-Image-Cache', tier);
    graphicCache.send(request, response, address, status, type, body, complete);
  }
  var asset = assets.get(address);
  if (asset) {
    return reply(req, res, 200, asset.type, asset.body, true, 'memory');
  }
  if (catalogImage) {
    asset = imageFiles.get(address);
    if (asset) {
      assets.set(address, asset, asset.body.length);
      return reply(req, res, 200, asset.type, asset.body, true, 'disk');
    }
  }
  // Merge only public catalog GETs. Other APIs, headers and asset rewrites keep
  // their existing request semantics; waiter and key counts remain bounded.
  var waiters = [{ request: req, response: res }];
  var ownsPending = false;
  if (catalogImage && req.method === 'GET') {
    if (pendingImages[address] && pendingImages[address].length < 16) {
      pendingImages[address].push(waiters[0]);
      return;
    }
    if (!pendingImages[address] && Object.keys(pendingImages).length < 32) {
      pendingImages[address] = waiters;
      ownsPending = true;
    }
  }
  function finish(error, status, type, body, complete) {
    if (ownsPending) delete pendingImages[address];
    waiters.forEach(function (waiter) {
      var response = waiter.response;
      if (response.finished || response.destroyed || (response.connection && response.connection.destroyed)) return;
      try {
        if (error) json(response, 502, { error: safeError(error) });
        else reply(waiter.request, response, status, type, body, complete, 'upstream');
      } catch (responseError) {
        // A disconnected client must not interrupt other requests sharing bytes.
        log(JSON.stringify({ stage: 'catalog-image-response', error: safeError(responseError) }));
      }
    });
  }
  var upstreamHeaders = { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0', Accept: req.headers.accept || '*/*' };
  Object.keys(extraHeaders || {}).forEach(function (key) { upstreamHeaders[key] = extraHeaders[key]; });
  request({ url: address, method: req.method, headers: upstreamHeaders, maxBytes: 12 * 1024 * 1024, stage: origin.indexOf('zonapic') >= 0 ? 'catalog-image' : origin.indexOf('msx') >= 0 ? 'portal-asset' : 'player-asset' }, function (error, upstream) {
    if (error) return finish(error);
    var type = upstream.headers['content-type'] || 'application/octet-stream';
    var body = upstream.body;
    if (/javascript|json|text\/|xml/.test(type)) {
      var text = body.toString('utf8');
      // Editorial/studio lists may retain their web ordering. Their entries
      // still open the Android card by the same content ID, rather than falling
      // back to a restricted web detail when the user selects a poster.
      if (origin === 'https://msx.zona.ms' && upstream.statusCode === 200 && /json/.test(type) && /^\/api\//.test(req.url)) {
        try {
          var expected = /^\/api\/series(?:\/|\?|$)/.test(req.url) ? 'series' : /^\/api\/movies(?:\/|\?|$)/.test(req.url) ? 'movie' : null;
          text = JSON.stringify(catalogModule.rewriteLegacy(JSON.parse(text), expected));
        } catch (invalidMetadata) { return finish(new Error('Invalid legacy catalog metadata')); }
      }
      if (req.method === 'GET' && origin === 'https://msx.zona.ms' && /^\/assets\/index-legacy-[A-Za-z0-9_-]+\.js$/.test(req.url.split('?')[0]) && upstream.statusCode === 200) {
        try {
          text = compatibleAsset(portalImages, portalImageStatus, text, 'portal-compatibility');
        } catch (portalError) {
          portalImageStatus.lastError = safeError(portalError);
          portalImageStatus.mode = 'error';
          log(JSON.stringify({ stage: 'portal-images', error: portalImageStatus.lastError }));
          return json(res, 502, { error: 'Portal compatibility guard: ' + portalImageStatus.lastError });
        }
      }
      if (req.method === 'GET' && origin === 'https://kinoserial.online' && /^\/assets\/index-legacy-[A-Za-z0-9_-]+\.js$/.test(req.url.split('?')[0]) && upstream.statusCode === 200) {
        try {
          text = compatibleAsset(playerPatch, playerPatchStatus, text, 'player-compatibility');
        } catch (patchError) {
          playerPatchStatus.lastError = safeError(patchError);
          playerPatchStatus.mode = 'error';
          log(JSON.stringify({ stage: 'player-patch', error: playerPatchStatus.lastError }));
          return json(res, 502, { error: 'Player compatibility guard: ' + playerPatchStatus.lastError });
        }
      }
      text = rewrite(text);
      if (origin === 'https://msx.zona.ms' && /text\/html/.test(type)) {
        text = text.replace(/<head(?:\s[^>]*)?>/i, function (head) { return head + '<script>' + imageBootstrap + '</script>'; });
        text = text.replace(/<\/head>/i, heroMaskStyle + '</head>');
      }
      body = new Buffer(text, 'utf8');
    }
    if (req.method === 'GET' && upstream.statusCode === 200 && graphicCache.isStaticCacheable(address, type)) assets.set(address, { type: type, body: body }, body.length);
    if (catalogImage && req.method === 'GET' && upstream.statusCode === 200 && graphicCache.isGraphic(address, type)) imageFiles.set(address, { type: type, body: body });
    finish(null, upstream.statusCode, type, body, req.method === 'GET');
  });
}
var portal = http.createServer(function (req, res) {
  var image = /^\/__zona\/img\/(img\d+\.zonapic\.com)(\/.*)$/.exec(req.url);
  if (image) return proxy('https://' + image[1], { url: image[2], method: req.method, headers: req.headers }, res, { Referer: 'https://msx.zona.ms/' });
  var parsed = url.parse(req.url, true);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Read-only catalog' });
  try {
    if (nativeCatalog.handle(parsed.pathname, parsed.query, function (error, value) {
      if (res.finished || res.destroyed) return;
      if (error) return json(res, [400, 404, 503].indexOf(error.statusCode) >= 0 ? error.statusCode : 502, { error: 'Android catalog unavailable', code: error.code || 'NATIVE_CATALOG_FAILED' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(rewrite(JSON.stringify(value)));
    })) return;
  } catch (catalogError) { return json(res, 502, { error: 'Android catalog unavailable' }); }
  proxy('https://msx.zona.ms', req, res);
});
var player = http.createServer(function (req, res) {
  if (mediaRelay.handle(req, res)) return;
  var parsed = url.parse(req.url, true);
  if (parsed.pathname === '/__zona/health') { res.setHeader('Access-Control-Allow-Origin', '*'); return json(res, 200, { service: 'lg-gate-zona', protocol: 1, ready: portalReady && playerReady, capabilities: capabilities, nativeApi: nativeApi.stats(), limits: { mediaRelay: mediaRelay.stats(), metadata: cache.stats(), assets: assets.stats(), imageFiles: imageFiles.stats(), pendingImages: Object.keys(pendingImages).length, reports: reports.length, observations: request.observations.length, pending: Object.keys(pending).length }, node: process.version, versions: process.versions, pid: process.pid, pythonRequired: false, mediaProxyUsed: mediaRelay.stats().entries > 0, childProcessesForbidden: args['forbid-child-processes'] === '1', forbiddenChildAttempts: forbiddenChildAttempts, loadedLocalModules: Object.keys(require.cache).map(function (filename) { return path.relative(path.join(__dirname, '..'), filename).replace(/\\/g, '/'); }), loaderSha256: crypto.createHash('sha256').update(loader).digest('hex'), repairs: { compatibility: compatibilityVersion, unifiedCatalog: catalogModule.version, nativeSources: nativeStreamsModule.version, legacySources: loaderMerge.version, isolatedSourceErrors: playerPatchStatus, pinnedPlayerSha256: playerPatch.pinnedUpstreamSha256, portalImages: portalImageStatus, pinnedPortalSha256: portalImages.pinnedUpstreamSha256, graphicCache: graphicCache.version, persistentImages: PersistentImageCache.version, heroMask: heroMaskVersion } }); }
  if (parsed.pathname === '/__zona/reports') return json(res, 200, { reports: reports, providerReports: providerResults.concat(providerAddon.stats().recent).slice(-16), requests: request.observations });
  if (parsed.pathname === '/__zona/sources') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Read-only metadata' });
    var sourceId, sourceEpisode;
    try { sourceId = nativeStreamsModule.identifier(parsed.query.kpId); sourceEpisode = nativeStreamsModule.episodeKey(parsed.query.episodeKey || ''); }
    catch (invalidIdentity) { return json(res, 400, { error: 'Invalid content or episode identifier' }); }
    return nativeStreams.getSources(sourceId, sourceEpisode, function (error, value) {
      json(res, error ? (error.statusCode === 400 ? 400 : 502) : 200, error ? { error: 'Android sources unavailable', code: error.code || 'NATIVE_SOURCES_FAILED' } : value);
    });
  }
  if (parsed.pathname === '/__zona/streams') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Read-only metadata' });
    var kpId = Number(parsed.query.kpId);
    if (!(kpId > 0 && kpId < 1000000000000 && kpId % 1 === 0)) return json(res, 400, { error: 'Invalid film identifier' });
    var episodeKey = parsed.query.episodeKey || '';
    if (typeof episodeKey !== 'string' || !/^(?:S[0-9]{1,4}E[0-9]{1,5})?$/.test(episodeKey)) return json(res, 400, { error: 'Invalid episode identifier' });
    var providerName = parsed.query.provider;
    if (providerName !== undefined && (typeof providerName !== 'string' || !Object.prototype.hasOwnProperty.call(providerMap, providerName))) return json(res, 400, {error: 'Invalid provider'});
    var selected = providerName ? providerMap[providerName] : providerAddon;
    return selected.getStreams(kpId, episodeKey, function (error, value) {
      var result = error ? {items: [], report: {status: 'failed'}} : value;
      if (!result || !Array.isArray(result.items)) result = {items: [], report: {status: 'invalid'}};
      result = JSON.parse(JSON.stringify(result));
      if (providerName) {
        providerResults.push({kpId: kpId, episodeKey: episodeKey, provider: providerName, status: error ? 'failed' : 'complete', items: result.items.length});
        if (providerResults.length > 16) providerResults.shift();
      }
      result.items.forEach(function (item) {
        if (item.extractorType && item.extractorType.id === 33 && Array.isArray(item.videoStreams)) item.videoStreams = item.videoStreams.filter(function (stream) {
          try {stream.source = mediaRelay.register(stream.source); return true;} catch (invalidRelaySource) {return false;}
        });
      });
      json(res, 200, result);
    });
  }
  if (parsed.pathname === '/loader.js') { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(loader); }
  proxy('https://kinoserial.online', req, res);
});
portal.listen(portalPort, host, function () { portalReady = true; log(JSON.stringify({ stage: 'listen', role: 'portal', origin: portalOrigin, node: process.version })); });
player.listen(playerPort, host, function () { playerReady = true; log(JSON.stringify({ stage: 'listen', role: 'player', origin: playerOrigin, node: process.version })); });
function shutdown() { portalReady = false; playerReady = false; portal.close(); player.close(); setTimeout(function () { process.exit(0); }, 300); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

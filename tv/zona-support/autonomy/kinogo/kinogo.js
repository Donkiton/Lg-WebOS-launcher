'use strict';

// Ordinary anonymous Kinogo54 movie metadata contract, APK 3.0.77 LDc/e.
// ES5/CommonJS; no Python, DEX, browser, external dependencies or media fetches.
var http = require('http');
var https = require('https');
var zlib = require('zlib');
var url = require('url');
var PromiseImpl = require('./promise');

function StopStage(stage, reason, networkCode) {
    this.name = 'StopStage';
    this.stage = stage;
    this.reason = reason;
    this.networkCode = networkCode;
    this.message = stage + ':' + reason;
}
StopStage.prototype = Object.create(Error.prototype);
StopStage.prototype.constructor = StopStage;
function copy(source) {
    var target = {};
    Object.keys(source || {}).forEach(function (key) { target[key] = source[key]; });
    return target;
}
function unique(values) {
    return values.filter(function (value, index) { return values.indexOf(value) === index; });
}
function origin(address) {
    var parsed = url.parse(address);
    return parsed.protocol + '//' + parsed.host;
}
function header(headers, name) {
    var result;
    Object.keys(headers || {}).some(function (key) {
        if (key.toLowerCase() === name.toLowerCase()) { result = headers[key]; return true; }
        return false;
    });
    return result;
}
function textBody(body) { return Buffer.isBuffer(body) ? body.toString('utf8') : String(body === undefined ? '' : body); }

function CookieJar() { this.cookies = []; }
CookieJar.prototype.store = function (address, setCookies) {
    var self = this;
    var parsed = url.parse(address);
    var list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
    list.forEach(function (line) {
        var parts = line.split(';');
        var separator = parts[0].indexOf('=');
        if (separator < 1) { return; }
        var cookie = {name: parts[0].slice(0, separator).trim(), value: parts[0].slice(separator + 1),
            domain: parsed.hostname.toLowerCase(), hostOnly: true,
            path: (parsed.pathname || '/').replace(/[^/]*$/, '') || '/', secure: false};
        parts.slice(1).forEach(function (part) {
            var pair = part.trim().split('=');
            var key = pair.shift().toLowerCase();
            var value = pair.join('=');
            if (key === 'domain') { cookie.domain = value.replace(/^\./, '').toLowerCase(); cookie.hostOnly = false; }
            if (key === 'path') { cookie.path = value || '/'; }
            if (key === 'secure') { cookie.secure = true; }
            if (key === 'max-age' && Number(value) <= 0) { cookie.expired = true; }
            if (key === 'expires' && Date.parse(value) <= Date.now()) { cookie.expired = true; }
        });
        if (parsed.hostname !== cookie.domain && parsed.hostname.slice(-(cookie.domain.length + 1)) !== '.' + cookie.domain) { return; }
        self.cookies = self.cookies.filter(function (old) { return !(old.name === cookie.name && old.domain === cookie.domain && old.path === cookie.path); });
        if (!cookie.expired) { self.cookies.push(cookie); }
    });
};
CookieJar.prototype.get = function (address) {
    var parsed = url.parse(address);
    return this.cookies.filter(function (cookie) {
        var host = parsed.hostname.toLowerCase();
        return (host === cookie.domain || (!cookie.hostOnly && host.slice(-(cookie.domain.length + 1)) === '.' + cookie.domain)) &&
            (parsed.pathname || '/').indexOf(cookie.path) === 0 && (!cookie.secure || parsed.protocol === 'https:');
    }).map(function (cookie) { return cookie.name + '=' + cookie.value; }).join('; ');
};

// Callback adapter shared by all requests of one extraction. No user's cookies.
function createNodeRequest() {
    var jar = new CookieJar();
    return function request(options, callback) {
        var redirects = 0;
        var completed = false;
        function finish(error, response) { if (!completed) { completed = true; callback(error, response); } }
        function visit(address, method, body) {
            var parsed = url.parse(address);
            if (parsed.protocol !== 'https:') { finish(new StopStage(options.stage, 'non_https_metadata_url')); return; }
            var headers = copy(options.headers);
            var cookies = jar.get(address);
            if (cookies) { headers.Cookie = cookies; }
            if (!header(headers, 'Accept-Encoding')) { headers['Accept-Encoding'] = 'identity'; }
            if (body !== undefined && body !== null) { headers['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, 'utf8'); }
            var transport = parsed.protocol === 'https:' ? https : http;
            var req = transport.request({protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port,
                path: parsed.path, method: method, headers: headers}, function (res) {
                jar.store(address, res.headers['set-cookie']);
                if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
                    res.resume();
                    redirects += 1;
                    if (redirects > 5) { finish(new StopStage(options.stage, 'too_many_redirects')); return; }
                    var nextMethod = method;
                    var nextBody = body;
                    if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) { nextMethod = 'GET'; nextBody = undefined; }
                    visit(url.resolve(address, res.headers.location), nextMethod, nextBody);
                    return;
                }
                var stream = res;
                var encoding = String(res.headers['content-encoding'] || '').toLowerCase();
                if (encoding === 'gzip') { stream = res.pipe(zlib.createGunzip()); }
                else if (encoding === 'deflate') { stream = res.pipe(zlib.createInflate()); }
                else if (encoding && encoding !== 'identity') { res.resume(); finish(new StopStage(options.stage, 'unsupported_content_encoding')); return; }
                var chunks = [];
                var bytes = 0;
                stream.on('data', function (chunk) {
                    bytes += chunk.length;
                    if (bytes > (options.maxBytes || 2097152)) { req.abort(); finish(new StopStage(options.stage, 'metadata_body_too_large')); return; }
                    chunks.push(chunk);
                });
                stream.on('error', function (error) { finish(error); });
                res.on('error', function (error) { finish(error); });
                stream.on('end', function () { finish(null, {statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: address}); });
            });
            req.setTimeout(options.timeoutMs || 25000, function () { req.abort(); finish(new StopStage(options.stage, 'timeout')); });
            req.on('error', function (error) { finish(error); });
            if (body !== undefined && body !== null) { req.write(body, 'utf8'); }
            req.end();
        }
        visit(options.url, options.method || 'GET', options.body);
    };
}

function fromCodePoint(point) {
    if (point <= 65535) { return String.fromCharCode(point); }
    point -= 65536;
    return String.fromCharCode((point >> 10) + 55296, (point % 1024) + 56320);
}
function plainText(value) {
    var entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…'};
    return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (whole, entity) {
        if (entity.charAt(0) === '#') {
            var point = entity.charAt(1).toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            return point >= 0 && point <= 1114111 ? fromCodePoint(point) : '�';
        }
        return Object.prototype.hasOwnProperty.call(entities, entity) ? entities[entity] : whole;
    }).replace(/<[^>]*>/g, '').trim();
}
function labelLanguage(label) {
    if (label.indexOf('English') === 0) { return 'en'; }
    if (label.indexOf('Португальский') === 0) { return 'pt'; }
    if (label.indexOf('Украинский') === 0) { return 'uk'; }
    return 'ru';
}
function decodeCinemarPlaylist(value) {
    if (value.slice(0, 2) !== '#2' || !/^\d\d$/.test(value.slice(2, 4))) { throw new Error('Invalid Cinemar #2 format'); }
    var separator = String.fromCharCode(parseInt(value.slice(2, 4), 10));
    var encoded = value.slice(4).split(separator).map(function (part) {
        if (part.length <= 32) { return part; }
        var last = part.charAt(part.length - 1);
        var number = /^\d$/.test(last) ? parseInt(last, 10) : 0;
        var start = Math.min(part.length, number * 2);
        var length = Math.max(0, part.length - 3 * number - 1);
        return part.slice(start, Math.min(start + length, part.length)) + part.slice(0, number);
    }).join('');
    while (encoded.length % 4) { encoded += '='; }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) { throw new Error('Invalid Cinemar base64'); }
    return new Buffer(encoded, 'base64').toString('utf8');
}
function parseJson(text, stage) {
    try { return JSON.parse(text); } catch (error) { throw new StopStage(stage, 'invalid_json'); }
}
function requestPromise(request, options) {
    return new PromiseImpl(function (resolve, reject) {
        if (request.length >= 2) { request(options, function (error, response) { if (error) { reject(error); } else { resolve(response); } }); }
        else { resolve(request(options)); }
    });
}
function MetadataSession(request) { this.requestAdapter = request || createNodeRequest(); this.history = []; }
MetadataSession.prototype.request = function (address, stage, headers, body) {
    var self = this;
    var requestHeaders = copy(headers);
    if (body !== undefined) { requestHeaders['Content-Type'] = 'application/json'; }
    var record = {stage: stage, method: body === undefined ? 'GET' : 'POST', origin: origin(address)};
    if (url.parse(address).protocol !== 'https:') { return PromiseImpl.reject(new StopStage(stage, 'non_https_metadata_url')); }
    return requestPromise(self.requestAdapter, {url: address, method: record.method, headers: requestHeaders,
        body: body, timeoutMs: 25000, maxBytes: 2097152, stage: stage}).then(function (response) {
        var status = response.statusCode === undefined ? response.status : response.statusCode;
        var bodyText = textBody(response.body);
        var finalUrl = response.url || address;
        record.status = status;
        record.bytes = Buffer.byteLength(bodyText, 'utf8');
        record.origin = origin(finalUrl);
        record.contentType = header(response.headers, 'Content-Type') || '';
        self.history.push(record);
        if (status < 200 || status >= 300) { throw new StopStage(stage, 'http_' + status); }
        if (record.bytes > 2097152) { throw new StopStage(stage, 'metadata_body_too_large'); }
        if (/\/(login|signin|sign-in)(?:[/?]|$)/i.test(url.parse(finalUrl).pathname || '')) { throw new StopStage(stage, 'authentication_redirect'); }
        var title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(bodyText);
        var visible = plainText(bodyText.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ''));
        if (/just a moment|verify you are human|подтвердите.{0,40}не робот|проверка.{0,30}браузера/i.test((title ? title[1] : '') + ' ' + visible.slice(0, 3000))) { throw new StopStage(stage, 'access_challenge'); }
        return bodyText;
    }, function (error) {
        if (error instanceof StopStage) { self.history.push(record); throw error; }
        record.networkError = error && error.code ? String(error.code) : 'network_error';
        self.history.push(record);
        throw new StopStage(stage, 'network_error', record.networkError);
    });
};

function fetchKinogoStreams(source, config, request) {
    if (!source || source.video_source_type_id !== 54 || typeof source.download_link_key !== 'string' || !source.download_link_key) { return PromiseImpl.reject(new TypeError('Expected native Kinogo source54 with key')); }
    if (!config || typeof config.kinogoHost !== 'string' || typeof config.userAgent !== 'string' || !config.kinogoApiHeaders || typeof config.playerApiUrlTemplate !== 'string' || typeof config.cinemarFilePattern !== 'string') { return PromiseImpl.reject(new TypeError('Missing Kinogo config fields')); }
    var session = new MetadataSession(request);
    var streams = [];
    var summary = {sourceType: 54, kinopoiskId: source.kinopoisk_id, uaProfile: 'current ext54 config', accountUsed: false, challengeBypassed: false, mediaSegmentsFetched: 0};
    var iframeUrl;
    var iframeOrigin;
    var entries;
    var failures = [];
    var apiUrl = config.playerApiUrlTemplate.split('{host}').join(config.kinogoHost).split('{key}').join(source.download_link_key);
    return session.request(apiUrl, 'player-api', config.kinogoApiHeaders).then(function (text) {
        var data = parseJson(text, 'player-api');
        var tabs = data && data.data && Array.isArray(data.data.tabs) ? data.data.tabs : [];
        summary.balancers = tabs.filter(function (tab) { return tab && typeof tab === 'object'; }).map(function (tab) { return String(tab.balancer || ''); });
        var matches = tabs.filter(function (tab) { return tab && tab.balancer === 'cinemar'; });
        if (!matches.length) { throw new StopStage('player-api', 'cinemar_tab_not_found'); }
        iframeUrl = matches[0].iframe_url;
        if (typeof iframeUrl !== 'string' || !iframeUrl) { throw new StopStage('player-api', 'iframe_url_missing'); }
        iframeOrigin = origin(iframeUrl);
        return session.request(iframeUrl, 'iframe', {Referer: 'https://' + config.kinogoHost + '/', 'User-Agent': config.userAgent});
    }).then(function (text) {
        var match = new RegExp(config.cinemarFilePattern).exec(text);
        if (!match) { throw new StopStage('iframe', 'encoded_playlist_not_found'); }
        var decoded;
        try { decoded = decodeCinemarPlaylist(match[1]); } catch (error) { throw new StopStage('iframe', 'playlist_decode_failed'); }
        entries = parseJson(decoded, 'playlist-decode');
        if (!Array.isArray(entries)) { throw new StopStage('playlist-decode', 'playlist_array_missing'); }
        if (entries.some(function (entry) { return entry && Object.prototype.hasOwnProperty.call(entry, 'folder'); })) { throw new StopStage('playlist-decode', 'series_folders_require_episode'); }
        summary.translationEntries = entries.length;
        summary.translationMetadata = [];
        var payloads = [];
        entries.forEach(function (entry, index) {
            if (!entry || typeof entry !== 'object') { return; }
            summary.translationMetadata.push({providerEntryIndex: index + 1, translationId: 'kinogo54:' + source.kinopoisk_id + ':' + (index + 1), title: plainText(entry.title || '')});
            if (typeof entry.data === 'string') { payloads.push(entry.data); }
        });
        summary.distinctTranslationPayloads = unique(payloads).length;
        summary.translationLabels = unique(summary.translationMetadata.map(function (entry) { return entry.title; })).sort();
        var chain = PromiseImpl.resolve();
        entries.forEach(function (entry, index) {
            chain = chain.then(function () {
                if (!entry || typeof entry.data !== 'string' || !entry.data) { return; }
                var translation = plainText(entry.title || '');
                var playlistStage = 'playlist-' + (index + 1);
                var hlsStage = 'hls-' + (index + 1);
                var masterUrl;
                return session.request(iframeOrigin + '/api/playlist/load', playlistStage,
                    {Origin: iframeOrigin, Referer: iframeUrl, 'User-Agent': config.userAgent, 'X-Requested-With': 'biz.kinogo.app'},
                    JSON.stringify(entry.data)).then(function (text) {
                    var playlist = parseJson(text, playlistStage);
                    masterUrl = playlist && playlist.file;
                    if (typeof masterUrl !== 'string' || !masterUrl) { throw new StopStage(playlistStage, 'file_url_missing'); }
                    return session.request(masterUrl, hlsStage, {'User-Agent': config.userAgent});
                }).then(function (master) {
                    if (master.indexOf('#EXTM3U') !== 0) { throw new StopStage(hlsStage, 'not_hls_metadata'); }
                    var pattern = /^\.\/(\d+)\..*?\.m3u8$/gm;
                    var match;
                    var count = 0;
                    while ((match = pattern.exec(master)) !== null) {
                        streams.push({translation: translation, translationId: 'kinogo54:' + source.kinopoisk_id + ':' + (index + 1), providerEntryIndex: index + 1,
                            language: labelLanguage(translation), resolution: match[1] + 'p', masterUrl: masterUrl,
                            url: url.resolve(masterUrl, match[0]), isTrailer: false, headers: {'User-Agent': config.userAgent}});
                        count += 1;
                    }
                    if (!count) { failures.push({translation: translation, stage: hlsStage, reason: 'native_variant_pattern_no_matches'}); }
                })['catch'](function (error) {
                    if (!(error instanceof StopStage)) { throw error; }
                    failures.push({translation: translation, stage: error.stage, reason: error.reason});
                    if (error.reason === 'access_challenge' || error.reason === 'authentication_redirect') { throw error; }
                });
            });
        });
        return chain;
    }).then(function () {
        summary.status = streams.length ? 'streams_found' : 'no_streams';
        summary.translations = unique(streams.map(function (stream) { return stream.translation; })).sort();
        summary.resolutions = unique(streams.map(function (stream) { return stream.resolution; })).sort();
        summary.translationFailures = failures;
    })['catch'](function (error) {
        if (!(error instanceof StopStage)) { throw error; }
        summary.status = 'blocked_or_unavailable';
        summary.stage = error.stage;
        summary.reason = error.reason;
        if (error.networkCode) { summary.networkCode = error.networkCode; }
    }).then(function () {
        summary.streamCount = streams.length;
        summary.requests = session.history;
        return {streams: streams, summary: summary};
    });
}

module.exports = {fetchKinogoStreams: fetchKinogoStreams, decodeCinemarPlaylist: decodeCinemarPlaylist,
    createNodeRequest: createNodeRequest, Promise: PromiseImpl};

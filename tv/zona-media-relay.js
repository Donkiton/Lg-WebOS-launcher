'use strict';
// Streaming relay for provider URLs whose ordinary client headers are required.
// Clients receive opaque capabilities, never a URL-fetching endpoint.
var http = require('http'), https = require('https'), url = require('url');
var crypto = require('crypto'), fs = require('fs'), path = require('path');
var VERSION = 'provider-media-relay-v1';
function create(options) {
  options = options || {};
  var origin = options.origin || 'http://127.0.0.1:17862';
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(origin)) throw new Error('Invalid local relay origin');
  var clock = options.now || Date.now, entries = Object.create(null), order = [], active = 0, registryBytes = 0;
  var ttl = options.ttlMs || 1800000, maximum = options.maximumEntries || 4096;
  var ca = null, transaction = null;
  function allowed(address) {
    var p;
    try { p = url.parse(address); } catch (e) { return false; }
    if (typeof address !== 'string' || address.length > 16384 || /[\x00-\x20]/.test(address) || !p.hostname || p.auth) return false;
    if (options.allowUrl) return options.allowUrl(address) === true;
    if (p.protocol !== 'https:' || p.port && p.port !== '443' || /^[0-9.]+$/.test(p.hostname) || /:/.test(p.hostname) || /(?:^|\.)(localhost|local|internal)$/.test(p.hostname)) return false;
    return (options.allowedHosts || []).some(function (host) {
      return typeof host === 'string' ? p.hostname.toLowerCase() === host.toLowerCase() : host instanceof RegExp && host.test(p.hostname);
    });
  }
  function copyHeaders(input) {
    var out = {};
    Object.keys(input || {}).forEach(function (name) {
      if (!/^(user-agent|referer|origin|cookie|accept)$/i.test(name)) return;
      var value = input[name];
      if (typeof value !== 'string' || value.length > 8192 || /[\r\n\x00]/.test(value)) throw new Error('Invalid provider header');
      out[name] = value;
    });
    return out;
  }
  function remove(token) { registryBytes -= entries[token].bytes; delete entries[token]; var i = order.indexOf(token); if (i >= 0) order.splice(i, 1); }
  function reserve(size) {
    while (order.length >= maximum || registryBytes + size > 4 * 1024 * 1024) {
      var victim = null;
      for (var i = 0; i < order.length; i++) {
        var token = order[i];
        if (!transaction || entries[token].family !== transaction.family && !transaction.pins[token]) { victim = token; break; }
      }
      if (victim === null) throw new Error('Manifest exceeds media registry capacity');
      remove(victim);
    }
  }
  function register(source, family) {
    if (!source || !allowed(source.url)) throw new Error('Untrusted media address');
    var headers = copyHeaders(source.headers), key = source.url + '\n' + JSON.stringify(headers), time = clock(), i;
    for (i = order.length - 1; i >= 0; i--) {
      var old = entries[order[i]];
      if (time - old.family.at >= ttl || time < old.family.at) remove(order[i]);
      else if (old.key === key) {
        old.family.at = time;
        if (transaction) transaction.pins[order[i]] = true;
        return {url: origin + '/__zona/media/' + order[i], headers: {}};
      }
    }
    var size = 2 * Buffer.byteLength(key, 'utf8') + 256;
    reserve(size);
    var token = crypto.randomBytes(18).toString('hex');
    entries[token] = {url: source.url, headers: headers, key: key, family: family || {at:time}, bytes:size}; order.push(token); registryBytes += size;
    if (transaction) transaction.pins[token] = true;
    return {url: origin + '/__zona/media/' + token, headers: {}};
  }
  function rewrite(text, base, headers, family) {
    // Rewriting a VOD playlist is one registry transaction. Neither the parent
    // family nor capabilities already emitted into this response may be evicted
    // while later lines are registered. A capacity failure rolls the registry
    // back and produces HTTP 502, never a successful playlist with dead links.
    var savedEntries = Object.create(null), savedOrder = order.slice(), savedBytes = registryBytes;
    Object.keys(entries).forEach(function (token) { savedEntries[token] = entries[token]; });
    transaction = {family:family,pins:Object.create(null)};
    function child(address) {
      // data: keys need no network request and must retain their original value.
      if (/^data:/i.test(address)) return address;
      return register({url: url.resolve(base, address), headers: headers}, family).url;
    }
    try {
      var output = text.split(/\r?\n/).map(function (line) {
        if (!line || /^\s*$/.test(line)) return line;
        if (line.charAt(0) !== '#') return child(line.trim());
        return line.replace(/URI="([^"\r\n]+)"/g, function (_, address) { return 'URI="' + child(address) + '"'; });
      }).join('\n');
      if (Buffer.byteLength(output, 'utf8') > 2 * 1024 * 1024) throw new Error('Manifest output limit');
      return output;
    } catch (error) {
      entries = savedEntries; order = savedOrder; registryBytes = savedBytes;
      throw error;
    } finally { transaction = null; }
  }
  function handle(req, res) {
    var route = url.parse(req.url).pathname;
    if (route.indexOf('/__zona/media/') !== 0) return false;
    function reply(status) { if (!res.headersSent && !res.finished) { res.writeHead(status, {'Cache-Control': 'no-store'}); res.end(); } else if (!res.finished) res.destroy(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { reply(405); return true; }
    var match = /^\/__zona\/media\/([a-f0-9]{36})$/.exec(route), entry = match && entries[match[1]];
    if (!entry || clock() - entry.family.at >= ttl || clock() < entry.family.at) { reply(404); return true; }
    entry.family.at = clock();
    if (active >= 12) { reply(503); return true; }
    active++;
    var upstream = null, incoming = null, done = false, redirects = 0, fallback = false, timer;
    function cleanup() { if (done) return; done = true; clearTimeout(timer); active--; req.removeListener('aborted', aborted); res.removeListener('close', aborted); }
    function abortUpstream() { if (incoming) incoming.destroy(); if (upstream) upstream.destroy(); }
    function aborted() { cleanup(); abortUpstream(); }
    function fail(status) { if (done) return; cleanup(); abortUpstream(); reply(status || 502); }
    req.on('aborted', aborted); res.on('close', aborted);
    timer = setTimeout(function () { fail(504); }, options.headerTimeoutMs || 20000);
    function connect(address) {
      if (done) return;
      if (!allowed(address)) return fail(502);
      var p = url.parse(address), headers = copyHeaders(entry.headers);
      headers['Accept-Encoding'] = 'identity';
      if (req.headers.range && !/\.m3u8(?:$|[?#])/i.test(address)) {
        if (!/^bytes=[0-9]*-[0-9]*(?:,[0-9]*-[0-9]*)*$/.test(req.headers.range)) return fail(400);
        headers.Range = req.headers.range;
      }
      try {
        upstream = (p.protocol === 'https:' ? https : http).request({hostname:p.hostname,port:p.port,path:p.path,method:req.method,headers:headers,
          agent:false,rejectUnauthorized:true,servername:p.hostname,ca:fallback ? ca : undefined}, function (response) {
          if (done) { response.resume(); return; }
          incoming = response;
          response.on('error', function () {if (incoming === response) fail(502);});
          response.on('aborted', function () {if (incoming === response) fail(502);});
          response.on('close', function () {if (incoming === response && !response.complete && !done) fail(502);});
          if ([301,302,303,307,308].indexOf(response.statusCode) >= 0 && response.headers.location) {
            response.resume(); if (++redirects > 8) return fail(502);
            return connect(url.resolve(address, response.headers.location));
          }
          var type = response.headers['content-type'] || 'application/octet-stream';
          var manifest = /mpegurl/i.test(type) || /\.m3u8(?:$|[?#])/i.test(address);
          clearTimeout(timer);
          // MP4 may be one long request. Activity is bounded by the socket
          // timeout, not a short wall-clock cutoff that would truncate a film.
          timer = setTimeout(function () { fail(504); }, options.deadlineMs || (manifest ? 20000 : 4 * 60 * 60 * 1000));
          var forward = {'Access-Control-Allow-Origin':'*'};
          ['content-type','content-length','content-range','accept-ranges','cache-control','etag','last-modified','content-encoding'].forEach(function (name) {if (response.headers[name] !== undefined) forward[name] = response.headers[name];});
          if (req.method === 'HEAD' || !manifest || response.statusCode !== 200) {
            res.writeHead(response.statusCode, forward);
            response.on('error', function () {fail(502);});
            response.on('end', cleanup);
            // pipe provides backpressure; MP4/segments never accumulate in RAM.
            response.pipe(res); return;
          }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return fail(502);
          var chunks = [], bytes = 0;
          response.on('data', function (chunk) {bytes += chunk.length; if (bytes > 1024 * 1024) return fail(502); chunks.push(chunk);});
          response.on('error', function () {fail(502);});
          response.on('end', function () {
            if (done) return;
            try {
              var body = new Buffer(rewrite(Buffer.concat(chunks).toString('utf8'), address, entry.headers, entry.family), 'utf8');
              if (body.length > 2 * 1024 * 1024) return fail(502);
              res.writeHead(200, {'Content-Type':'application/vnd.apple.mpegurl','Content-Length':body.length,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
              cleanup(); res.end(body);
            } catch (error) {fail(502);}
          });
        });
        upstream.setTimeout(options.inactivityMs || 20000, function () {fail(504);});
        upstream.on('error', function (error) {
          if (done) return;
          if (!fallback && /^(UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)$/.test(error.code || '')) {
            try {ca = ca || fs.readFileSync(options.caPath || path.join(__dirname,'runtime/public-ca.pem'),'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);} catch (readError) {return fail(502);}
            fallback = true; connect(address); return;
          }
          fail(502);
        });
        upstream.end();
      } catch (error) {fail(502);}
    }
    connect(entry.url); return true;
  }
  return {register:register,handle:handle,stats:function(){return {version:VERSION,entries:order.length,bytes:registryBytes,maximumBytes:4*1024*1024,active:active,maximumEntries:maximum};}};
}
exports.create = create;
exports.version = VERSION;

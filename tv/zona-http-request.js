'use strict';
// ES5 / Node 0.12. No browser interception, external process, or TLS bypass.
var http = require('http');
var https = require('https');
var url = require('url');
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');
var caText = fs.readFileSync(path.join(__dirname, 'runtime', 'public-ca.pem'), 'utf8');
var ca = caText.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
var observations = [];

function request(options, callback) {
  var started = Date.now();
  var done = false;
  var redirects = 0;
  var useBundledCa = false;
  var currentRequest = null;
  // Socket inactivity alone does not bound DNS, redirects or a slow trickle.
  // Keep one deadline for the entire request, including a validated CA retry.
  var deadline = setTimeout(function () {
    finish(new Error('Request deadline exceeded'));
  }, options.timeoutMs || 20000);
  function finish(error, response) {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    if (error && currentRequest) { try { currentRequest.destroy(); } catch (ignored) {} }
    observations.push({ stage: options.stage || 'request', origin: url.parse(options.url).protocol + '//' + url.parse(options.url).host, status: response ? response.statusCode : null, errorCode: error ? error.code || error.message : null, durationMs: Date.now() - started });
    if (observations.length > 64) observations.splice(0, observations.length - 64);
    callback(error, response);
  }
  function send(target, method, body) {
    if (done) return;
    var parsed = url.parse(target);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return finish(new Error('Unsupported protocol'));
    var headers = {};
    Object.keys(options.headers || {}).forEach(function (key) { headers[key] = options.headers[key]; });
    if (!headers['Accept-Encoding']) headers['Accept-Encoding'] = 'gzip, deflate';
    if (body !== undefined && body !== null) headers['Content-Length'] = Buffer.byteLength(body);
    var transport = parsed.protocol === 'https:' ? https : http;
    var req = transport.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.path, method: method, headers: headers, ca: useBundledCa ? ca : undefined, rejectUnauthorized: true, servername: parsed.hostname, agent: false }, function (res) {
      if (done) { res.resume(); return; }
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
        res.resume();
        if (++redirects > 8) return finish(new Error('Redirect limit'));
        var next = url.resolve(target, res.headers.location);
        if (options.redirectPolicy === 'same-origin') {
          var first = url.parse(options.url), destination = url.parse(next);
          if (first.protocol !== destination.protocol || first.host !== destination.host) return finish(new Error('Cross-origin redirect rejected'));
        }
        if (parsed.protocol === 'https:' && url.parse(next).protocol !== 'https:') return finish(new Error('TLS downgrade rejected'));
        return send(next, res.statusCode === 303 ? 'GET' : method, res.statusCode === 303 ? null : body);
      }
      var chunks = [], count = 0, limit = options.maxBytes || 4 * 1024 * 1024;
      res.on('data', function (chunk) {
        count += chunk.length;
        if (count > limit) { req.destroy(); finish(new Error('Response body limit')); return; }
        chunks.push(chunk);
      });
      res.on('error', finish);
      res.on('end', function () {
        if (done) return;
        var raw = Buffer.concat(chunks);
        function decoded(error, data) {
          if (error) return finish(new Error('Compressed response invalid'));
          if (data.length > limit) return finish(new Error('Decoded response limit'));
          var headers = {};
          Object.keys(res.headers).forEach(function (key) { headers[key] = res.headers[key]; });
          if (encoding === 'gzip' || encoding === 'deflate') { delete headers['content-encoding']; delete headers['content-length']; }
          finish(null, { statusCode: res.statusCode, headers: headers, body: data, url: target });
        }
        var encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        if (method === 'HEAD' || !raw.length) decoded(null, raw);
        else if (encoding === 'gzip') zlib.gunzip(raw, decoded);
        else if (encoding === 'deflate') zlib.inflate(raw, decoded);
        else decoded(null, raw);
      });
    });
    currentRequest = req;
    req.setTimeout(options.timeoutMs || 20000, function () { req.destroy(); finish(new Error('Request timeout')); });
    req.on('error', function (error) {
      if (done) return;
      // Retain the runtime's own validated CA path. Modern public roots are an
      // additional validated path for providers newer than the TV root bundle.
      if (!useBundledCa && /^(UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)$/.test(error.code || '')) {
        useBundledCa = true;
        return send(target, method, body);
      }
      finish(error);
    });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  }
  send(options.url, options.method || 'GET', options.body);
  return { abort: function () { finish(new Error('Request aborted')); } };
}
request.observations = observations;
module.exports = request;

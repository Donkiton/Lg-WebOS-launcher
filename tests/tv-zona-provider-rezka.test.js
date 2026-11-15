'use strict';
var assert = require('assert');
var querystring = require('querystring');
var rezka = require('../tv/zona-provider-rezka');
var total = 0;
function test(name, fn) { fn(); total++; console.log('ok ' + name); }
var html = '<script>sof.tv.initCDNSeriesEvents(391, 7, {});</script>' +
  '<li title="Voice &amp; One" data-id="391" data-translator_id="7" data-camrip="0" data-ads="0" data-director="0">one</li>' +
  '<a title="English Original" data-translator_id="8" href="/example.html">two</a>' +
  '<li class="b-prem_translator" title="Premium" data-translator_id="9">premium</li>' +
  '<input type="hidden" id="ctrl_favs" value="anonymous-token">';
var cfg = {hosts: ['https://public.example'], userAgent: 'Native test', qualityFixMap: {'720p': '480p'}};
function timerClock() {
  var callbacks = [];
  return {set: function (fn) { callbacks.push(fn); return callbacks.length; }, clear: function () {}, fire: function () { callbacks[0](); }};
}
function fixture(settings) {
  settings = settings || {};
  var calls = [], pending = [], configFetches = 0, clock = timerClock();
  var p = rezka.create({setTimeout: clock.set, clearTimeout: clock.clear,
    portable: {decodeConfig: function () { return cfg; }},
    native: {sourceTypes: ['2', '34'], request: function (path, params, cb) {
      calls.push({stage: 'sources', path: path, params: params});
      cb(null, {data: [{kinopoisk_id: settings.wrongId ? 12 : params.kinopoiskId, episode_key: params.episodeKey,
        video_source_type_id: 2, download_link_key: 'serials/example'}]});
    }},
    http: function (options, cb) {
      calls.push(options);
      if (options.stage === 'rezka-config') { configFetches++; return cb(null, {statusCode: 200, headers: {}, body: new Buffer('config')}); }
      if (options.stage === 'rezka-page') return cb(null, {statusCode: 200, headers: {'set-cookie': ['anonymous=value; Path=/; Secure']}, body: new Buffer(settings.challenge ? '<script>anubis_challenge</script>' : html)});
      if (options.stage === 'rezka-translation') {
        var params = querystring.parse(options.body);
        if (settings.pending && params.translator_id === '8') { pending.push(cb); return; }
        cb(null, {statusCode: 200, body: new Buffer(JSON.stringify({url: '[720p]https://media.example/' + params.translator_id + '.m3u8,[480p]https://media.example/' + params.translator_id + '.mp4'}))});
      }
    }});
  return {provider: p, calls: calls, pending: pending, clock: clock, configs: function () { return configFetches; }};
}
test('native translator metadata and premium exclusion', function () {
  var p = rezka.parsePage(html);
  assert.deepEqual(p.translations.map(function (v) { return [v.id, v.title, v.contentId]; }), [['7', 'Voice & One', '391'], ['8', 'English Original', '391']]);
  assert.equal(p.favs, 'anonymous-token');
});
test('native encoded streams including escaped separator', function () {
  var raw = '[720p]https://media.example/a.m3u8';
  var junk = '//_//' + new Buffer('$$#!!@#!@##').toString('base64');
  var base = new Buffer(raw).toString('base64');
  assert.equal(rezka.decode('#h' + (base.slice(0, 8) + junk + base.slice(8)).replace(/\//g, '\\/')), raw);
  assert.throws(function () { rezka.decode('#hnot-valid!'); }, /STREAM_FORMAT/);
});
test('quality mapping and selected public alternative', function () {
  var r = rezka.parseStreams({url: '[720p]//media.example/one.m3u8 or https://media.example/two.mp4'}, 'English Original', cfg, 'https://public.example/');
  assert.equal(r.length, 1); assert.equal(r[0].source.url, 'https://media.example/one.m3u8');
  assert.equal(r[0].resolution, '480p'); assert.equal(r[0].language, 'en');
  assert.equal(r[0].source.headers.Referer, 'https://public.example/');
});
test('two translations and exact requested episode in independent requests', function () {
  var f = fixture(), result, called = 0;
  f.provider.getStreams(308625, 'S02E03', function (e, value) { assert.ifError(e); result = value; called++; });
  assert.equal(called, 1); assert.equal(result.items[0].extractorType.id, 2);
  assert.deepEqual(result.items[0].videoStreams.map(function (v) { return v.translation; }), ['Voice & One', 'Voice & One', 'English Original', 'English Original']);
  var translations = f.calls.filter(function (v) { return v.stage === 'rezka-translation'; });
  assert.equal(translations.length, 2);
  translations.forEach(function (v) {
    var p = querystring.parse(v.body);
    assert.equal(p.id, '391'); assert.equal(p.season, '2'); assert.equal(p.episode, '3'); assert.equal(p.action, 'get_stream');
    assert.equal(v.headers.Cookie, 'anonymous=value'); assert.equal(v.timeoutMs, 6000);
  });
  f.provider.getStreams(308625, 'S02E04', function (e) { assert.ifError(e); });
  assert.equal(f.configs(), 1);
});
test('movies use movie action without stale season or episode', function () {
  var f = fixture();
  f.provider.getStreams(12345, '', function (e) { assert.ifError(e); });
  f.calls.filter(function (v) { return v.stage === 'rezka-translation'; }).forEach(function (v) {
    var p = querystring.parse(v.body); assert.equal(p.action, 'get_movie'); assert.equal(p.season, undefined); assert.equal(p.episode, undefined);
  });
});
test('content identity mismatch stops before config and page', function () {
  var f = fixture({wrongId: true}), called = 0;
  f.provider.getStreams(308625, 'S01E01', function (e) { assert.equal(e.message, 'HDREZKA_IDENTITY_MISMATCH'); called++; });
  assert.equal(called, 1); assert.equal(f.calls.length, 1);
});
test('challenge is reported without translation requests', function () {
  var f = fixture({challenge: true}), called = 0;
  f.provider.getStreams(308625, 'S01E01', function (e) { assert.equal(e.message, 'HDREZKA_AUTH_OR_CHALLENGE_REQUIRED'); called++; });
  assert.equal(called, 1); assert.equal(f.calls.filter(function (v) { return v.stage === 'rezka-translation'; }).length, 0);
  assert.throws(function () { rezka.parsePage('<span class="b-player__restricted__block_message">unavailable</span>'); }, /AUTH_OR_CHALLENGE/);
});
test('deadline returns completed translation once and ignores late response', function () {
  var f = fixture({pending: true}), called = 0, result;
  f.provider.getStreams(308625, 'S01E01', function (e, value) { assert.ifError(e); called++; result = value; });
  assert.equal(called, 0); f.clock.fire();
  assert.equal(called, 1); assert.equal(result.items[0].videoStreams.length, 2);
  f.pending[0](null, {statusCode: 200, body: new Buffer('{"url":"[1080p]https://media.example/late.mp4"}')});
  assert.equal(called, 1); assert.equal(result.items[0].videoStreams.length, 2);
});
test('invalid requested identity causes no HTTP request', function () {
  var f = fixture(), called = 0;
  f.provider.getStreams(308625, '../other', function (e) { assert.equal(e.message, 'HDREZKA_IDENTITY_INVALID'); called++; });
  assert.equal(called, 1); assert.equal(f.calls.length, 0);
});
console.log('HDrezka: ' + total + ' tests passed');

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const api = require('../tv/zona-native-api');

function harness(host) {
  let now = 1000000, serial = 0;
  const pending = [], calls = [], timers = new Map();
  const portable = {makeTransport(time, agent) { return {client_time: 'opaque-time', cookie: 'opaque-cookie'}; }, encodeParams(value) {return 'encoded:' + JSON.stringify(value);} };
  const native = api.create({portable, host, now: () => now,
    setTimeout(fn, ms) {const id = ++serial; timers.set(id, {fn, at: now + ms}); return id;},
    clearTimeout(id) {timers.delete(id);},
    http(options, callback) {const call = {options, callback, aborted: false}; calls.push(call); pending.push(call); return {abort() {call.aborted = true;}};}
  });
  function answer(call, data, status = 200) {call.callback(null, {statusCode: status, headers: {date: new Date(now).toUTCString()}, body: Buffer.from(JSON.stringify(data))});}
  return {native, calls, pending, answer, timers,
    clock() {answer(calls.find(c => c.options.method === 'HEAD'), {});},
    tick(ms) {now += ms; for (const [id, t] of [...timers]) if (t.at <= now && timers.has(id)) {timers.delete(id); t.fn();}}
  };
}

test('Android catalog sends plain JSON and sources alone use the legacy parameter codec', () => {
  const h = harness(), results = [];
  h.native.request('/search', {query: 'Сплетница'}, (e, v) => results.push([e, v]));
  h.native.request('/getVideoSources', {kinopoiskId: 308625, episodeKey: 'S02E03'}, (e, v) => results.push([e, v]));
  h.native.request('/getMovieIds', {page: {limit: 20, offset: 0}}, (e, v) => results.push([e, v]));
  assert.equal(h.calls.length, 1, 'concurrent requests share one clock request');
  h.clock();
  const dataCalls = h.calls.filter(c => c.options.method !== 'HEAD');
  assert.equal(new URL(dataCalls[0].options.url).searchParams.get('params'), JSON.stringify({query: 'Сплетница'}));
  assert.match(new URL(dataCalls[1].options.url).searchParams.get('params'), /^encoded:/);
  assert.equal(new URL(dataCalls[2].options.url).searchParams.get('params'), JSON.stringify({page: {limit: 20, offset: 0}}));
  dataCalls.forEach(c => h.answer(c, {data: []}));
  assert.equal(results.length, 3); assert(results.every(x => x[0] === null));
  assert.equal(h.timers.size, 0); assert.equal(h.native.stats().active, 0);
});

test('Android requests isolate server errors and never expose transport values', () => {
  const h = harness('https://apirn1.mzona.net'), results = [];
  h.native.request('/search', {query: 'x'}, e => results.push(e)); h.clock();
  h.answer(h.calls[1], {error: 'private server detail opaque-cookie'}, 403);
  assert.equal(results[0].message, 'NATIVE_HTTP_ERROR'); assert.equal(results[0].statusCode, 403);
  h.native.request('/search', {query: 'x'}, e => results.push(e));
  h.calls[2].callback(null, {statusCode: 200, body: Buffer.from('not-json')});
  assert.equal(results[1].message, 'NATIVE_JSON_INVALID');
  assert(!JSON.stringify(h.native.stats()).includes('opaque'));
});

test('Android request queues are bounded, snapshot inputs, and release slots after failure', () => {
  const h = harness(), errors = [], params = {query: 'original'};
  for (let i = 0; i < 37; i++) h.native.request('/search', params, e => {if (e) errors.push(e.code);});
  params.query = 'mutated';
  assert.equal(h.native.stats().active, 4); assert.equal(h.native.stats().queued, 32);
  assert.deepEqual(errors, ['NATIVE_BUSY']); h.clock();
  assert.equal(JSON.parse(new URL(h.calls[1].options.url).searchParams.get('params')).query, 'original');
  const first = h.calls[1]; h.answer(first, {data: []});
  assert.equal(h.native.stats().active, 4); assert.equal(h.native.stats().queued, 31);
  h.tick(30001); assert.equal(h.native.stats().active, 0); assert.equal(h.native.stats().queued, 0);
  assert.equal(h.timers.size, 0); assert(first.aborted === false);
});

test('clock failure and deadline call consumers once; late HTTP callbacks do not revive a request', () => {
  const h = harness('https://apirn1.mzona.net'), results = [];
  h.native.request('/search', {query: 'x'}, e => results.push(e.code));
  h.tick(10001); assert.deepEqual(results, ['NATIVE_CLOCK_TIMEOUT']);
  h.clock(); assert.equal(results.length, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.native.stats().active, 0); assert.equal(h.timers.size, 0);
});

test('the direct mirror is preferred and a transient response gets one try on the other direct host', () => {
  const h = harness(), results = [];
  h.native.request('/search', {query: 'test'}, (error, data) => results.push([error, data]));
  assert.equal(h.calls[0].options.url, 'https://apiwn1.mzona.net/getTime');
  h.answer(h.calls[0], {});
  assert.equal(h.calls[1].options.timeoutMs, 7000);
  h.answer(h.calls[1], {}, 503);
  assert.equal(h.calls[2].options.url, 'https://apirn1.mzona.net/getTime');
  h.answer(h.calls[2], {});
  assert.equal(new URL(h.calls[3].options.url).origin, 'https://apirn1.mzona.net');
  assert.equal(new URL(h.calls[3].options.url).searchParams.get('params'), '{"query":"test"}');
  assert(h.calls.every(c => c.options.redirectPolicy === 'same-origin'));
  h.answer(h.calls[3], {data: []});
  h.answer(h.calls[1], {data: ['late result']});
  assert.deepEqual(results, [[null, {data: []}]]);
  assert.equal(h.timers.size, 0);
});

test('a dead mirror clock leaves time for fallback and reuses one fallback clock for concurrent requests', () => {
  const h = harness(), results = [];
  for (let i = 0; i < 3; i++) h.native.request('/search', {i}, (error, data) => results.push([error, data]));
  assert.equal(h.calls.length, 1);
  h.tick(4001);
  assert(h.calls[0].aborted);
  assert.equal(h.calls[1].options.url, 'https://apirn1.mzona.net/getTime');
  h.answer(h.calls[0], {});
  assert.equal(h.calls.length, 2, 'a late primary clock must stay ignored');
  h.answer(h.calls[1], {});
  assert.equal(h.calls.length, 5);
  h.calls.slice(2).forEach(c => h.answer(c, {ok: true}));
  assert(results.every(([error, data]) => !error && data.ok));
  assert.equal(results.length, 3);
  assert.equal(h.timers.size, 0);
});

test('authorization errors are returned without trying another mirror', () => {
  const h = harness(), errors = [];
  h.native.request('/search', {query: 'test'}, error => errors.push(error));
  h.answer(h.calls[0], {});
  h.answer(h.calls[1], {}, 403);
  assert.equal(h.calls.length, 2);
  assert.equal(errors[0].statusCode, 403);
  assert.equal(h.timers.size, 0);
});

test('malformed paths and oversized or circular parameters never reach the network', () => {
  const h = harness(), errors = [], circular = {}; circular.x = circular;
  for (const [route, params] of [['https://elsewhere.test/search', {}], ['/../search', {}], ['/search', []], ['/search', circular], ['/search', {query: 'x'.repeat(32769)}]]) {
    h.native.request(route, params, e => errors.push(e.code));
  }
  assert.equal(errors.length, 5); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
  assert.throws(() => api.create({http() {}, portable: {}, host: 'https://evil.test'}));
});

const binary = process.env.ZONA_NODE012 || path.resolve(__dirname, '../.build/zona-source-lab/autonomy/runtime/node-v0.12.2-x64.exe');
test('native API module runs on the exact Node 0.12.2 runtime', {skip: !fs.existsSync(binary)}, () => {
  const file = path.resolve(__dirname, '../tv/zona-native-api.js');
  const script = 'var a=require(process.argv[1]); if(a.sourceTypes.length!==58)throw Error("source types"); console.log(process.version);';
  const result = spawnSync(binary, ['-e', script, file], {encoding: 'utf8', windowsHide: true, timeout: 10000});
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'v0.12.2');
});

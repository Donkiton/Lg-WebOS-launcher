'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');

function harness() {
  const calls = [], timers = new Map(); let serial = 0;
  const transport = {request(options, callback) {
    const req = new EventEmitter(); req.destroyed = false;
    req.destroy = () => {req.destroyed = true;}; req.end = () => {}; req.write = () => {};
    req.setTimeout = (ms, fn) => {req.inactivity = fn;};
    const call = {options, req, callback}; calls.push(call); return req;
  }};
  const context = {module: {exports: {}}, Buffer, Date,
    setTimeout(fn) {const id = ++serial; timers.set(id, fn); return id;}, clearTimeout(id) {timers.delete(id);},
    require(name) {if (name === 'http' || name === 'https') return transport;
      if (name === 'fs') return {readFileSync() {return '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----';}};
      return require(name);}, __dirname: '/owned/runtime'
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../tv/zona-http-request.js'), 'utf8'), context);
  return {request: context.module.exports, calls, timers,
    respond(index, status, body, headers = {}) {const res = new EventEmitter(); res.statusCode = status; res.headers = headers; res.resume = () => {};
      calls[index].callback(res); if (body !== undefined) {res.emit('data', Buffer.from(body)); res.emit('end');} return res;},
    expire() {for (const [id, fn] of [...timers]) {timers.delete(id); fn();}}
  };
}

test('HTTP deadline bounds DNS/stalled request and discards a late response', () => {
  const h = harness(), replies = [];
  h.request({url: 'https://native.test/search', timeoutMs: 25}, (e, v) => replies.push([e, v]));
  h.expire(); assert.equal(h.calls[0].req.destroyed, true);
  assert.match(replies[0][0].message, /deadline/);
  h.respond(0, 200, '{}'); assert.equal(replies.length, 1); assert.equal(h.timers.size, 0);
});

test('redirects and validated CA retry share one deadline and keep TLS validation enabled', () => {
  const h = harness(), replies = [];
  h.request({url: 'https://native.test/search'}, (e, v) => replies.push([e, v]));
  h.respond(0, 302, undefined, {location: '/second'});
  assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 1);
  h.calls[1].req.emit('error', {code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'});
  assert.equal(h.calls.length, 3); assert.equal(h.timers.size, 1);
  h.calls.forEach(c => assert.equal(c.options.rejectUnauthorized, true));
  assert(h.calls[2].options.ca); h.respond(2, 200, '{"data":[]}');
  assert.equal(replies.length, 1); assert.equal(replies[0][0], null); assert.equal(h.timers.size, 0);
});

test('HTTP abort, size limit and TLS downgrade fail exactly once', () => {
  for (const action of ['abort', 'size', 'downgrade']) {
    const h = harness(), replies = [];
    const handle = h.request({url: 'https://native.test/search', maxBytes: 2}, e => replies.push(e));
    if (action === 'abort') handle.abort();
    if (action === 'size') h.respond(0, 200, 'too large');
    if (action === 'downgrade') h.respond(0, 302, undefined, {location: 'http://native.test/search'});
    assert.equal(replies.length, 1); assert(replies[0]); assert(h.calls[0].req.destroyed); assert.equal(h.timers.size, 0);
  }
});

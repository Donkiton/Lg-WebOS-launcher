'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatform } = require('../platform');
const BOOT = '12345678-1234-5678-90ab-1234567890ab';
const WAKE = '111111111111111111111111';
function tv() {
  const calls = [];
  function Bridge() {}
  Bridge.prototype.cancel = function () {};
  Bridge.prototype.call = function (uri, params) { calls.push({ uri, params: JSON.parse(params), bridge: this }); };
  return { calls, platform: createPlatform({ PalmServiceBridge: Bridge, Promise, setTimeout, clearTimeout }, { timeoutMs: 30 }) };
}
function answer(call, marker = { version: 1, bootId: BOOT, sessionId: WAKE, sleeping: false }) {
  call.bridge.onservicecallback(JSON.stringify({ returnValue: true, stdoutString: JSON.stringify(marker) + '\n' + BOOT + '\n' }));
}
test('Сеанс питания доступен независимо от установки MSX; одновременные чтения объединяются', async () => {
  const h = tv();
  const a = h.platform.getPowerSession(), b = h.platform.getPowerSession();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].uri, 'luna://org.webosbrew.hbchannel.service/exec');
  assert.match(h.calls[0].params.command, /head -c 513 \/tmp\/lg-gate-session\.json/);
  answer(h.calls[0]);
  assert.equal(await a, 'wake:' + BOOT + ':' + WAKE);
  assert.equal(await b, 'wake:' + BOOT + ':' + WAKE);
  const c = h.platform.getPowerSession();
  assert.equal(h.calls.length, 2);
  answer(h.calls[1], { version: 1, bootId: BOOT, sessionId: '222222222222222222222222', sleeping: false });
  assert.equal(await c, 'wake:' + BOOT + ':222222222222222222222222');
});
test('Повреждённый marker и ошибка службы не создают выдуманный активный сеанс', async () => {
  const h = tv();
  const a = h.platform.getPowerSession();
  answer(h.calls[0], { version: 1, bootId: 'other', sessionId: WAKE });
  assert.equal(await a, '');
  const b = h.platform.getPowerSession();
  h.calls[1].bridge.onservicecallback('{"returnValue":false,"errorText":"unavailable"}');
  assert.equal(await b, '');
  const c = h.platform.getPowerSession();
  answer(h.calls[2]);
  assert.equal(await c, 'wake:' + BOOT + ':' + WAKE);
});
test('Спящий marker и marker без состояния awake не считаются активным сеансом', async () => {
  const h = tv();
  for (const marker of [{ version: 1, bootId: BOOT, sessionId: WAKE, sleeping: true }, { version: 1, bootId: BOOT, sessionId: WAKE }]) {
    const request = h.platform.getPowerSession();
    answer(h.calls[h.calls.length - 1], marker);
    assert.equal(await request, '');
  }
});
test('Отмена и тайм-аут чтения сеанса завершаются, следующий запрос может повториться', async () => {
  const h = tv();
  const a = h.platform.getPowerSession();
  const cancelled = assert.rejects(a, { code: 'CANCELLED' });
  h.platform.cancelPending();
  await cancelled;
  assert.equal(await h.platform.getPowerSession(), '');
  const c = h.platform.getPowerSession();
  answer(h.calls[2]);
  assert.equal(await c, 'wake:' + BOOT + ':' + WAKE);
});
test('Браузерный сеанс сохраняется в одной вкладке после reload, но другой вкладке принадлежит новый', async () => {
  const values = new Map();
  const sessionStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const a = await createPlatform({ sessionStorage }).getPowerSession();
  assert.match(a, /^preview:/);
  assert.equal(await createPlatform({ sessionStorage }).getPowerSession(), a);
  assert.notEqual(await createPlatform({}).getPowerSession(), a);
});
test('Запрет sessionStorage не мешает стабильному сеансу текущего browser renderer', async () => {
  const blocked = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  const p = createPlatform({ sessionStorage: blocked });
  assert.equal(await p.getPowerSession(), await p.getPowerSession());
});

test('Старый wallpaperPeriod в marker игнорируется и не меняет MSX-сеанс', async () => {
  const h = tv();
  for (const period of [undefined, null, 'night', '__proto__', 'https://evil.example/a.png', ['morning']]) {
    const request = h.platform.getPowerSession();
    answer(h.calls[h.calls.length - 1], { version: 1, bootId: BOOT, sessionId: WAKE, sleeping: false, wallpaperPeriod: period });
    assert.equal(await request, 'wake:' + BOOT + ':' + WAKE);
  }
  const sleeping = h.platform.getPowerSession();
  answer(h.calls[h.calls.length - 1], { version: 1, bootId: BOOT, sessionId: WAKE, sleeping: true, wallpaperPeriod: 'night' });
  assert.equal(await sleeping, '');
  const broken = h.platform.getPowerSession();
  answer(h.calls[h.calls.length - 1], { version: 1, bootId: 'other', sessionId: WAKE, sleeping: false, wallpaperPeriod: 'night' });
  assert.equal(await broken, '');
});

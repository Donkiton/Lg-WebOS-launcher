'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createPlatform } = require('../platform.js');
const previewSnapshot = require('../preview-catalog.js');

const URI = {
  apps: 'luna://com.webos.applicationManager/listLaunchPoints',
  homebrew: 'luna://org.webosbrew.hbchannel.service/exec',
  network: 'luna://com.palm.connectionmanager/getStatus',
  inputs: 'luna://com.webos.service.eim/getAllInputStatus',
  launch: 'luna://com.webos.applicationManager/launch'
};

function fakeEnvironment(respond) {
  const calls = [];
  const bridges = [];
  function Bridge() {
    this.cancelled = 0;
    bridges.push(this);
  }
  Bridge.prototype.call = function (uri, params) {
    const record = { uri, params: JSON.parse(params), bridge: this };
    calls.push(record);
    if (respond) respond(record);
  };
  Bridge.prototype.cancel = function () { this.cancelled++; };
  return { env: { PalmServiceBridge: Bridge, setTimeout, clearTimeout, Promise }, calls, bridges };
}

function answer(call, payload) {
  call.bridge.onservicecallback(JSON.stringify(payload));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected asynchronous platform update');
}

test('Браузер получает реальные ID и названия из снимка ТВ без демонстрационных приложений', async () => {
  const platform = createPlatform({});
  assert.equal(platform.mode, 'browser');
  assert.equal(platform.catalogSource, 'tv-snapshot');
  const apps = await platform.getApps();
  assert.ok(apps.length > 0);
  assert.equal(apps.length, previewSnapshot.launchPoints.length);
  assert.deepEqual(apps.map(app => app.id), previewSnapshot.launchPoints.map(app => app.id));
  assert.deepEqual(apps.map(app => app.name), previewSnapshot.launchPoints.map(app => app.title));
  assert.ok(apps.every(app => !app.id.startsWith('preview.')));
  apps[0].name = 'mutated';
  apps.pop();
  assert.equal((await platform.getApps())[0].name, previewSnapshot.launchPoints[0].title);
  assert.equal((await platform.getApps()).length, previewSnapshot.launchPoints.length);
  assert.deepEqual(await platform.getNetwork(), {
    available: false, kind: 'unknown', connected: null, internet: null,
    message: 'Сеть телевизора недоступна в браузерном предпросмотре.'
  });
  assert.deepEqual(await platform.getInputs(), []);
  assert.deepEqual(await platform.launchApp('youtube'), { simulated: true });
  assert.deepEqual(await platform.openSettings(), { simulated: true });
  assert.deepEqual(await platform.switchInput('preview-input'), { simulated: true });
});

test('browser script publishes window.LauncherPlatform without making a service request', () => {
  const window = {};
  const context = vm.createContext({ window, Promise, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'preview-catalog.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'platform.js'), 'utf8'), context);
  assert.equal(window.LauncherPlatform.mode, 'browser');
  assert.equal(typeof window.LauncherPlatform.getApps, 'function');
});
test('Отсутствующий снимок в браузере даёт ошибку вместо заглушек', async () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'platform.js'), 'utf8'), { window, Promise, setTimeout, clearTimeout });
  await assert.rejects(window.LauncherPlatform.getApps(), { code: 'SNAPSHOT_UNAVAILABLE' });
});
test('После установки на ТВ используется текущий ответ webOS, а не сохранённый снимок', async () => {
  const fake = fakeEnvironment(call => answer(call, { returnValue: true, launchPoints: [
    { id: 'newly.installed.app', title: 'Новое установленное приложение', icon: '/media/apps/icon80.png', largeIcon: '/media/apps/icon130.png' }
  ] }));
  const platform = createPlatform(fake.env);
  assert.equal(platform.catalogSource, 'webos');
  assert.deepEqual(await platform.getApps(), [{ id: 'newly.installed.app', name: 'Новое установленное приложение', icon: '/media/apps/icon130.png' }]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].uri, URI.apps);
});

test('webOS without a usable bridge fails instead of using browser data', async () => {
  for (const env of [{ navigator: { userAgent: 'Mozilla/5.0 (Web0S; SmartTV)' } }, { webOSSystem: {} }, { PalmServiceBridge: {} }]) {
    const platform = createPlatform(env);
    assert.equal(platform.mode, 'webos');
    await assert.rejects(platform.getApps(), { code: 'BRIDGE_UNAVAILABLE' });
    await assert.rejects(platform.getNetwork(), { code: 'BRIDGE_UNAVAILABLE' });
    await assert.rejects(platform.launchApp('youtube.leanback.v4'), { code: 'BRIDGE_UNAVAILABLE' });
  }
});

test('actual catalogue IDs survive normalization, deduplication and presentation branding', async () => {
  const fake = fakeEnvironment(call => answer(call, { returnValue: true, launchPoints: [
    { id: 'youtube.leanback.v4', title: 'YouTube', icon: '/media/apps/youtube/icon.png' },
    { id: 'org.webosbrew.hbchannel', title: 'Homebrew Channel' },
    { id: 'real.vendor.app', title: 'Новое приложение' },
    { id: 'youtube.leanback.v4', title: 'Duplicate' },
    { appId: 'custom.media', name: 'Media Station X' },
    { title: 'No ID' }, null
  ] }));
  const platform = createPlatform(fake.env);
  assert.equal(platform.mode, 'webos');
  assert.deepEqual(await platform.getApps(), [
    { id: 'youtube.leanback.v4', name: 'YouTube', brand: 'youtube', icon: '/media/apps/youtube/icon.png' },
    { id: 'org.webosbrew.hbchannel', name: 'Homebrew Channel', brand: 'homebrew' },
    { id: 'real.vendor.app', name: 'Новое приложение' },
    { id: 'custom.media', name: 'Media Station X', brand: 'msx' }
  ]);
  assert.equal(fake.calls[0].uri, URI.apps);
  assert.deepEqual(fake.calls[0].params, {});
  assert.equal(fake.bridges[0].cancelled, 1);
  assert.equal(fake.bridges[0].onservicecallback, null);
});

test('launch/settings pass exact IDs and structured parameters', async () => {
  const fake = fakeEnvironment(call => answer(call, { returnValue: true }));
  const platform = createPlatform(fake.env);
  const actualID = 'com.vendor.real-id';
  assert.deepEqual(await platform.launchApp(actualID), { simulated: false });
  assert.deepEqual(await platform.openSettings(), { simulated: false });
  assert.deepEqual(fake.calls.map(call => ({ uri: call.uri, params: call.params })), [
    { uri: URI.launch, params: { id: actualID, params: {} } },
    { uri: URI.launch, params: { id: 'com.palm.app.settings', params: {} } }
  ]);
  await assert.rejects(platform.launchApp(''), { code: 'INVALID_ID' });
  assert.equal(fake.calls.length, 2);
});

test('network distinguishes Wi-Fi, cable, disconnected and unknown values', async () => {
  const responses = [
    { returnValue: true, wired: { state: 'disconnected' }, wifi: { state: 'connected', ssid: 'My Wi-Fi' }, isInternetConnectionAvailable: false },
    { returnValue: true, wired: { state: 'connected', onInternet: 'yes' }, wifi: { state: 'disconnected' } },
    { returnValue: true, wired: { state: 'disconnected' }, wifi: { state: 'disconnected' }, isInternetConnectionAvailable: false },
    { returnValue: true }
  ];
  const fake = fakeEnvironment(call => answer(call, responses.shift()));
  const platform = createPlatform(fake.env);
  assert.deepEqual(await platform.getNetwork(), { available: true, kind: 'wifi', connected: true, internet: false, ssid: 'My Wi-Fi' });
  assert.deepEqual(await platform.getNetwork(), { available: true, kind: 'wired', connected: true, internet: true });
  assert.deepEqual(await platform.getNetwork(), { available: true, kind: 'none', connected: false, internet: false });
  assert.deepEqual(await platform.getNetwork(), { available: true, kind: 'unknown', connected: null, internet: null, message: 'Система не сообщила тип подключения.' });
  assert.equal(fake.calls[0].uri, URI.network);
  assert.deepEqual(fake.calls[0].params, { subscribe: false });
});

test('inputs preserve unknown connection status and only switch through a reported appId', async () => {
  const payload = { returnValue: true, devices: [
    { id: 'HDMI_1', label: 'Консоль', appId: 'com.webos.app.hdmi1', connected: true },
    { id: 'HDMI_2', label: 'HDMI 2', appId: 'com.webos.app.hdmi2', connected: false },
    { id: 'AV', label: 'AV' }
  ] };
  const fake = fakeEnvironment(call => answer(call, call.uri === URI.inputs ? payload : { returnValue: true }));
  const platform = createPlatform(fake.env);
  assert.deepEqual(await platform.getInputs(), [
    { id: 'HDMI_1', name: 'Консоль', connected: true, appId: 'com.webos.app.hdmi1' },
    { id: 'HDMI_2', name: 'HDMI 2', connected: false, appId: 'com.webos.app.hdmi2' },
    { id: 'AV', name: 'AV', connected: null }
  ]);
  assert.deepEqual(await platform.switchInput('HDMI_2'), { simulated: false });
  assert.deepEqual(fake.calls[2].params, { id: 'com.webos.app.hdmi2', params: {} });
  await assert.rejects(platform.switchInput('AV'), { code: 'INPUT_UNAVAILABLE' });
  await assert.rejects(platform.switchInput('HDMI_99'), { code: 'INPUT_UNAVAILABLE' });
  assert.equal(fake.calls.filter(call => call.uri === URI.launch).length, 1);
});

test('service denial and unavailable Homebrew remain an error without a fixture catalogue', async () => {
  const fake = fakeEnvironment(call => answer(call, { returnValue: false, errorCode: -1, errorText: 'Permission denied' }));
  const platform = createPlatform(fake.env);
  await assert.rejects(platform.getApps(), error => {
    assert.equal(error.code, 'SERVICE_ERROR');
    assert.equal(error.serviceCode, -1);
    assert.equal(error.uri, URI.homebrew);
    assert.match(error.message, /Permission denied/);
    return true;
  });
  assert.equal(fake.bridges[0].cancelled, 1);
  assert.equal(fake.bridges[1].cancelled, 1);
  assert.equal(fake.calls.length, 2);
});

test('Homebrew reads the live catalogue with one constant command only after a service denial', async () => {
  const fake = fakeEnvironment(call => answer(call, call.uri === URI.apps
    ? { returnValue: false, errorCode: -1, errorText: 'Permission denied' }
    : { returnValue: true, stdoutString: JSON.stringify({ returnValue: true, launchPoints: [
      { id: 'newly.installed.app', title: 'Новое приложение' },
      { id: 'org.lggate.launcher', title: 'LG Gate' }
    ] }) }));
  const platform = createPlatform(fake.env);
  assert.deepEqual(await platform.getApps(), [{ id: 'newly.installed.app', name: 'Новое приложение' }]);
  assert.deepEqual(fake.calls.map(call => ({ uri: call.uri, params: call.params })), [
    { uri: URI.apps, params: {} },
    { uri: URI.homebrew, params: { command: "luna-send -n 1 -f luna://com.webos.applicationManager/listLaunchPoints '{}'" } }
  ]);
  assert.equal(platform.catalogSource, 'webos');
});

test('Homebrew output must confirm a valid live catalogue', async () => {
  for (const stdoutString of [undefined, '{bad', 'null', '{}', '{"returnValue":false}', '{"returnValue":true}']) {
    const fake = fakeEnvironment(call => answer(call, call.uri === URI.apps
      ? { returnValue: false, errorText: 'Permission denied' }
      : { returnValue: true, stdoutString }));
    await assert.rejects(createPlatform(fake.env).getApps(), error => ['INVALID_RESPONSE', 'SERVICE_ERROR'].includes(error.code));
    assert.equal(fake.calls.length, 2);
  }
});

test('launcher excludes itself from the native catalogue', async () => {
  const fake = fakeEnvironment(call => answer(call, { returnValue: true, launchPoints: [
    { id: 'org.lggate.launcher', title: 'LG Gate' },
    { id: 'org.lggate.launcher_other', appId: 'org.lggate.launcher', title: 'Extra launch point' },
    { id: 'youtube.leanback.v4', title: 'YouTube' }
  ] }));
  assert.deepEqual((await createPlatform(fake.env).getApps()).map(app => app.id), ['youtube.leanback.v4']);
});

test('native metadata appears before a prioritized icon, and a later native refresh revalidates its bytes', async () => {
  const iconPath = '/media/cryptofs/apps/usr/palm/applications/vendor.app/largeIcon.png';
  const bytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=';
  const fake = fakeEnvironment(call => answer(call, call.uri === URI.apps
    ? { returnValue: true, launchPoints: [{ id: 'vendor.app', title: 'Native', largeIcon: iconPath }] }
    : { returnValue: true, stdoutString: iconPath + '\t' + bytes + '\n' }));
  const platform = createPlatform(fake.env);
  platform.setAppPriorities(['vendor.app'], []);
  const updates = [];
  assert.equal((await platform.getApps({ onUpdate: (apps, meta) => updates.push({ apps, meta }) }))[0].icon, iconPath);
  await waitFor(() => updates.some(update => update.meta.iconsOnly));
  assert.equal(updates.at(-1).apps[0].icon, 'data:image/png;base64,' + bytes);
  assert.equal(updates[0].apps[0].icon, iconPath, 'earlier callback snapshots stay unchanged');
  assert.equal((await platform.getApps())[0].icon, 'data:image/png;base64,' + bytes);
  await waitFor(() => fake.calls.filter(call => call.uri === URI.homebrew).length === 2);
  const reads = fake.calls.filter(call => call.uri === URI.homebrew);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].params.command, 'for p in ' + "'" + iconPath + "'" + '; do printf \'%s\\t\' "$p"; head -c 262145 "$p" | base64 | tr -d \'\\n\'; printf \'\\n\'; done');
});

test('icon batches reject paths outside application trees and shell syntax', async () => {
  for (const icon of ['/etc/shadow', '/usr/palm/applications/../secret.png', '/usr/palm/applications/a/icon.png;id', "/usr/palm/applications/a/'x.png", '/usr/palm/applications/a//icon.png', 'https://example.com/a.png']) {
    const fake = fakeEnvironment(call => answer(call, { returnValue: true, launchPoints: [{ id: 'vendor.app', title: 'Native', icon }] }));
    const platform = createPlatform(fake.env);
    platform.setAppPriorities(['vendor.app'], []);
    assert.equal((await platform.getApps()).length, 1);
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(fake.calls.length, 1);
  }
});

test('failed and malformed icon responses keep the live app and never substitute another path', async () => {
  const icon = '/usr/palm/applications/vendor.app/icon.png';
  for (const response of [
    { returnValue: false, errorText: 'Not available' },
    { returnValue: true, stdoutString: icon + '\tinvalid\n' },
    { returnValue: true, stdoutString: '/other.png\tiVBORw0KGgo=\n' },
    { returnValue: true, stdoutString: icon + '\tiVBORw0KGgo' + 'A'.repeat(349528) + '\n' }
  ]) {
    const fake = fakeEnvironment(call => answer(call, call.uri === URI.apps
      ? { returnValue: true, launchPoints: [{ id: 'vendor.app', title: 'Native', icon }] } : response));
    const platform = createPlatform(fake.env);
    const updates = [];
    platform.setAppPriorities(['vendor.app'], []);
    assert.deepEqual(await platform.getApps({ onUpdate: apps => updates.push(apps) }), [{ id: 'vendor.app', name: 'Native', icon }]);
    await waitFor(() => fake.calls.length === 2);
    assert.ok(updates.every(apps => apps[0].icon === icon));
  }
});

test('cancellation stops an independent in-flight icon batch after metadata has resolved', async () => {
  const fake = fakeEnvironment(call => {
    if (call.uri === URI.apps) answer(call, { returnValue: true, launchPoints: [{ id: 'vendor.app', icon: '/usr/palm/applications/vendor.app/icon.png' }] });
  });
  const platform = createPlatform(fake.env);
  platform.setAppPriorities(['vendor.app'], []);
  const updates = [];
  await platform.getApps({ onUpdate: apps => updates.push(apps) });
  await waitFor(() => fake.calls.length === 2);
  assert.equal(fake.calls[1].uri, URI.homebrew);
  const lateCallback = fake.calls[1].bridge.onservicecallback;
  const before = updates.length;
  platform.cancelPending();
  assert.equal(fake.calls[1].bridge.cancelled, 1);
  lateCallback(JSON.stringify({ returnValue: true, stdoutString: '' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(updates.length, before);
});

test('cancellation after catalogue response prevents a new icon batch', async () => {
  const fake = fakeEnvironment(call => answer(call, { returnValue: true, launchPoints: [
    { id: 'vendor.app', icon: '/usr/palm/applications/vendor.app/icon.png' }
  ] }));
  const platform = createPlatform(fake.env);
  platform.setAppPriorities(['vendor.app'], []);
  const request = platform.getApps();
  platform.cancelPending();
  await assert.rejects(request, { code: 'CANCELLED' });
  assert.equal(fake.calls.length, 1);
});

test('cancellation between service denial and fallback prevents the Homebrew request', async () => {
  const fake = fakeEnvironment();
  const platform = createPlatform(fake.env);
  const request = platform.getApps();
  answer(fake.calls[0], { returnValue: false, errorText: 'Permission denied' });
  platform.cancelPending();
  await assert.rejects(request, { code: 'CANCELLED' });
  assert.equal(fake.calls.length, 1);
});

test('cancellation while Homebrew is pending cancels its bridge', async () => {
  const fake = fakeEnvironment(call => {
    if (call.uri === URI.apps) answer(call, { returnValue: false, errorText: 'Permission denied' });
  });
  const platform = createPlatform(fake.env);
  const request = platform.getApps();
  await Promise.resolve();
  assert.equal(fake.calls.length, 2);
  platform.cancelPending();
  await assert.rejects(request, { code: 'CANCELLED' });
  assert.deepEqual(fake.bridges.map(bridge => bridge.cancelled), [1, 1]);
});

test('input selection cancelled while EIM is pending cannot launch an input', async () => {
  const fake = fakeEnvironment();
  const platform = createPlatform(fake.env);
  const control = { cancelled: false };
  const request = platform.switchInput('HDMI_1', control);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].uri, URI.inputs);
  control.cancelled = true;
  answer(fake.calls[0], { returnValue: true, devices: [
    { id: 'HDMI_1', label: 'Консоль', appId: 'com.webos.app.hdmi1', connected: true }
  ] });
  await assert.rejects(request, { code: 'CANCELLED' });
  assert.equal(fake.calls.length, 1, 'cancelled selection must not submit a launch');
  assert.equal(fake.bridges[0].cancelled, 1);
});

test('already cancelled input selection does not read EIM', async () => {
  const fake = fakeEnvironment();
  await assert.rejects(createPlatform(fake.env).switchInput('HDMI_1', { cancelled: true }), { code: 'CANCELLED' });
  assert.equal(fake.calls.length, 0);
  await assert.rejects(createPlatform({}).switchInput('preview-input', { cancelled: true }), { code: 'CANCELLED' });
});

test('malformed JSON, missing returnValue and malformed catalogue shapes reject', async () => {
  for (const response of ['{bad', 'null', '{}', '{"returnValue":true}']) {
    const fake = fakeEnvironment(call => call.bridge.onservicecallback(response));
    await assert.rejects(createPlatform(fake.env).getApps(), { code: 'INVALID_RESPONSE' });
    assert.equal(fake.bridges[0].cancelled, 1);
    assert.equal(fake.calls.length, 1);
  }
});

test('timeout cancels native request and ignores a late callback', async () => {
  const fake = fakeEnvironment();
  const platform = createPlatform(fake.env, { timeoutMs: 10 });
  const request = platform.getApps();
  const lateCallback = fake.bridges[0].onservicecallback;
  await assert.rejects(request, { code: 'TIMEOUT' });
  lateCallback('{"returnValue":true,"launchPoints":[]}');
  assert.equal(fake.bridges[0].cancelled, 1);
  assert.equal(fake.calls.length, 1);
});

test('explicit cancellation settles all in-flight calls exactly once', async () => {
  const fake = fakeEnvironment();
  const platform = createPlatform(fake.env);
  const requests = [platform.getApps(), platform.getNetwork()];
  const assertions = requests.map(request => assert.rejects(request, { code: 'CANCELLED' }));
  platform.cancelPending();
  platform.cancelPending();
  await Promise.all(assertions);
  assert.deepEqual(fake.bridges.map(bridge => bridge.cancelled), [1, 1]);
});

test('bridge construction and call exceptions reject without hanging', async () => {
  function BrokenBridge() { throw new Error('constructor failed'); }
  await assert.rejects(createPlatform({ PalmServiceBridge: BrokenBridge }).getNetwork(), { code: 'BRIDGE_ERROR' });
  const fake = fakeEnvironment(() => { throw new Error('call failed'); });
  await assert.rejects(createPlatform(fake.env).getApps(), { code: 'BRIDGE_ERROR' });
  assert.equal(fake.bridges[0].cancelled, 1);
});

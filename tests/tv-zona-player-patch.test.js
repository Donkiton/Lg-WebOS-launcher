'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const patcher = require('../tv/zona-player-patch');
const fixture = require('./fixtures/zona-player/pinned-fragments.json');

function scheduler() {
    let time = 1000, serial = 0;
    const tasks = new Map();
    return {
        now: () => time,
        setTimeout(fn, delay) { const id = ++serial; tasks.set(id, {at: time + delay, fn}); return id; },
        clearTimeout(id) { tasks.delete(id); },
        tick(ms) {
            const until = time + ms;
            for (let guard = 0; guard < 1000; guard++) {
                const next = [...tasks.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) { time = until; return; }
                time = next[1].at; tasks.delete(next[0]); next[1].fn();
            }
            throw Error('Unbounded timer loop');
        },
        get size() { return tasks.size; }
    };
}
function player(initial = 600) {
    const handlers = new Map();
    const p = {time: initial, uri: 'https://media.invalid/A.m3u8', ready: 4, stopped: false, currentError: null, loads: 0, plays: 0, seeks: [], kpId: 4450194, episodeKey: null, mediaGeneration: 1, mediaReleased: false, hasBeenReady: true, hasRealDuration: true,
        currentTime(value) { if (arguments.length) { this.time = value; this.seeks.push(value); return this; } return this.time; },
        currentSrc() { return this.uri; },
        duration() { return 7929; }, readyState() { return this.ready; }, paused() { return this.stopped; },
        error(value) { if (arguments.length && value !== undefined) this.currentError = value; return this.currentError; },
        load() { this.loads++; this.time = 0; this.ready = 0; },
        play() { this.plays++; this.stopped = false; return Promise.resolve(); },
        pause() { this.stopped = true; this.emit('pause'); },
        on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return this; },
        one(name, fn) { const once = (...args) => { this.off(name, once); return fn(...args); }; return this.on(name, once); },
        off(name, fn) { handlers.set(name, (handlers.get(name) || []).filter(x => x !== fn)); return this; },
        emit(name) { if (name === 'playing') { this.ready = 4; this.stopped = false; } for (const fn of [...handlers.get(name) || []]) fn(); },
        trigger(name) { this.emit(name); },
        el() { return {classList: {add() {}, remove() {}, toggle() {}}}; },
        tech() { return {el: () => ({})}; },
        addClass() {}, removeClass() {}, controls() {}
    };
    return p;
}
function runtime() {
    const clock = scheduler(), root = {};
    const recovery = patcher.createRecovery({...clock, window: root});
    return {clock, root, recovery};
}
function emitted(name) {
    let text = fixture.fragments[name];
    for (const [before, after] of patcher.operations()) if (text.includes(before)) text = text.replace(before, after);
    return text;
}
function compile(context, name, next) {
    let text = emitted(name);
    if (name === 'store') text = text.slice(text.lastIndexOf('kS='));
    text = text.slice(0, text.lastIndexOf(',' + next + '='));
    vm.runInContext('var ' + text + ';', context);
}
function storeHarness() {
    const run = runtime();
    const context = vm.createContext({lgGateRecovery: run.recovery, Set,
        cC(object, key, value) { object[key] = value; }
    });
    compile(context, 'store', 'IS');
    return {...run, store: new context.kS(), context};
}
function group() {
    return {qualitiesByQuality: {'720': [
        {streamId: 54, resolution: '720p', translation: 'A', url: 'https://media.invalid/A/720.m3u8', isAvailable: true},
        {streamId: 54, resolution: '720p', translation: 'B', url: 'https://media.invalid/B/720.m3u8', isAvailable: true},
        {streamId: 34, resolution: '720p', translation: 'legacy', url: 'https://legacy.invalid/720.m3u8', isAvailable: true}
    ], '1080': [{streamId: 54, resolution: '1080p', translation: 'A', url: 'https://media.invalid/A/1080.m3u8', isAvailable: true}]}, audioByQuality: {'720': [
        {streamId: 54, resolution: '720p', name: 'A', uid: 'A-720-url-1', isAvailable: true},
        {streamId: 54, resolution: '720p', name: 'B', uid: 'B-720-url-1', isAvailable: true}
    ]}};
}
function markA(store) {
    const next = JSON.parse(JSON.stringify(store.sources.groupedData));
    next.qualitiesByQuality['720'][0].isAvailable = false;
    next.audioByQuality['720'][0].isAvailable = false;
    store.setGroupedSourceData(next);
    return next;
}

test('Pinned source fragments cover every unique surgical replacement', () => {
    assert(patcher.supportedUpstreamSha256.includes(fixture.upstreamSha256));
    const all = Object.values(fixture.fragments).join('\n');
    for (const [before] of patcher.operations()) assert.equal(all.split(before).length - 1, 1, before.slice(0, 70));
    assert.throws(() => patcher.patch(all), /UPSTREAM_MISMATCH/);
    assert.throws(() => patcher.patch(null), /PLAYER_PATCH_INPUT/);
    assert.throws(() => patcher.patch(patcher.marker), /ALREADY_APPLIED/);
});

const currentFixture = require('./fixtures/zona-player/current-fragments.json');
function currentEmitted(name) {
    let text = currentFixture.fragments[name];
    for (const [before, after] of patcher.operations(currentFixture.upstreamSha256)) {
        if (text.includes(before)) text = text.replace(before, after);
    }
    return text;
}
test('Current reviewed player covers all26 guarded operations and emits valid source regions', () => {
    assert.equal(currentFixture.upstreamSha256, patcher.pinnedUpstreamSha256);
    const all = Object.values(currentFixture.fragments).join('\n');
    const operations = patcher.operations(currentFixture.upstreamSha256);
    assert.equal(operations.length, 26);
    for (const [before] of operations) assert.equal(all.split(before).length - 1, 1, before.slice(0, 70));
    for (const name of Object.keys(currentFixture.fragments)) {
        if (name === 'variables') continue;
        let text = currentEmitted(name);
        if (name === 'playGuard') { new vm.Script('var guard=' + text); continue; }
        const boundary = /,[$A-Z_a-z][$\w]*=$/.exec(text);
        assert(boundary, name + ' retains its actual next-definition boundary');
        text = text.slice(0, boundary.index).replace(/^,/, '');
        new vm.Script('var ' + text + ';', {filename: 'current-player-' + name + '.js'});
    }
    assert(currentEmitted('store').includes(patcher.createRecovery.toString()), 'Complete recovery-v4 factory is preserved byte-for-byte');
    assert.throws(() => patcher.operations('unknown-profile'), /UPSTREAM_MISMATCH/);
});
test('Current emitted lw preserves voice isolation, expiry and changed URL identity', () => {
    const run = runtime();
    const context = vm.createContext({lgGateRecovery: run.recovery, Set,
        YI(object, key, value) { object[key] = value; }
    });
    const text = currentEmitted('store');
    vm.runInContext('var ' + text.slice(text.lastIndexOf('lw='), text.lastIndexOf(',uw=')) + ';', context);
    const store = new context.lw();
    store.sources.groupedData = group(); markA(store);
    const next = group(); store.applyBrokenMarks(next);
    assert.equal(next.qualitiesByQuality['720'][0].isAvailable, false);
    assert.equal(next.audioByQuality['720'][0].isAvailable, false);
    assert.equal(next.qualitiesByQuality['720'][1].isAvailable, true);
    assert.equal(next.qualitiesByQuality['1080'][0].isAvailable, true);
    const fresh = group(); fresh.qualitiesByQuality['720'][0].url += '?renewed';
    fresh.audioByQuality['720'][0].uid += '-renewed'; store.applyBrokenMarks(fresh);
    assert.equal(fresh.qualitiesByQuality['720'][0].isAvailable, true);
    assert.equal(fresh.audioByQuality['720'][0].isAvailable, true);
    run.clock.tick(30001); store.getSources();
    assert.equal(store.brokenStreamKeys.size, 0);
    assert.equal(store.sources.groupedData.qualitiesByQuality['720'][0].isAvailable, true);
});

test('Actual emitted kS isolates voice, provider, quality and URL identity', () => {
    const {store} = storeHarness();
    store.sources.groupedData = group(); markA(store);
    assert.equal(store.brokenStreamKeys.size, 2);
    const next = group(); store.applyBrokenMarks(next);
    assert.equal(next.qualitiesByQuality['720'][0].isAvailable, false);
    assert.equal(next.audioByQuality['720'][0].isAvailable, false);
    assert.equal(next.qualitiesByQuality['720'][1].isAvailable, true);
    assert.equal(next.qualitiesByQuality['720'][2].isAvailable, true);
    assert.equal(next.qualitiesByQuality['1080'][0].isAvailable, true);
    const fresh = group(); fresh.qualitiesByQuality['720'][0].url += '?renewed'; fresh.audioByQuality['720'][0].uid += '-renewed'; store.applyBrokenMarks(fresh);
    assert.equal(fresh.qualitiesByQuality['720'][0].isAvailable, true);
    assert.equal(fresh.audioByQuality['720'][0].isAvailable, true);
});

test('Playback failure expires after30s without copied/regroup data extending it', () => {
    const {store, clock} = storeHarness(); store.sources.groupedData = group(); markA(store);
    clock.tick(29000);
    store.setGroupedSourceData(JSON.parse(JSON.stringify(store.sources.groupedData)));
    const regrouped = group(); store.applyBrokenMarks(regrouped); store.sources.groupedData = regrouped;
    clock.tick(1001); const next = store.getSources().groupedData;
    assert.equal(next.qualitiesByQuality['720'][0].isAvailable, true);
    assert.equal(next.audioByQuality['720'][0].isAvailable, true);
    assert.equal(store.brokenStreamKeys.size, 0);
});

test('Expired copied flags recover while fresh unsupported parser flags stay false', () => {
    const {store, clock} = storeHarness(); store.sources.groupedData = group(); const failed = markA(store);
    const copied = JSON.parse(JSON.stringify(failed)); clock.tick(30001); store.setGroupedSourceData(copied);
    assert.equal(copied.qualitiesByQuality['720'][0].isAvailable, true);
    const again = markA(store); clock.tick(30001);
    const unsupported = group(); unsupported.qualitiesByQuality['720'][0].isAvailable = false;
    store.setGroupedSourceData(unsupported);
    assert.equal(unsupported.qualitiesByQuality['720'][0].isAvailable, false);
    assert.equal(store.brokenStreamKeys.size, 0);
    assert.equal(again.qualitiesByQuality['720'][0].__lgGatePlaybackFailure, undefined);
});

test('Originally unavailable rows and other voices are not re-enabled by expiry', () => {
    const {store, clock} = storeHarness(); const initial = group(); initial.qualitiesByQuality['720'][1].isAvailable = false; store.sources.groupedData = initial;
    markA(store); clock.tick(30001);
    assert.equal(store.getSources().groupedData.qualitiesByQuality['720'][0].isAvailable, true);
    assert.equal(store.getSources().groupedData.qualitiesByQuality['720'][1].isAvailable, false);
    store.clearSources(); assert.equal(store.brokenStreamKeys.size, 0); assert.deepEqual(Object.keys(store.__lgGateFailures), []);
});

function switchHarness(run, p, history = 590) {
    const calls = [];
    const context = vm.createContext({lgGateRecovery: run.recovery, Number,
        MS: () => ({getSources: () => ({adaptedData: []})}), yy: () => history, vy: () => history - 10, by: () => false,
        my: {set() {}}, ny: {activeAudioTrack: 'audio'}, u: Object.assign, _y: {HIDE_ERROR: 'hide'},
        Gy: () => ({source: {url: 'https://media.invalid/B.m3u8'}}), sy: () => 'hls', Iy: () => ({}), g_: () => ({setStreamSubtitles() {}}),
        vh: {HLS: 'hls', MP4: 'mp4', DASH: 'dash'}, t_: value => calls.push(value), c_() {}, mb() {}
    });
    compile(context, 'sourceSwitch', 'b_');
    return {calls, switchSource(options = {}) { context.y_({audio: {name: 'B'}, player: p, videoElement: {}, externalStreams: {qualitiesByQuality: {'720': []}}, activeQuality: '720', ...options}); }};
}
test('Actual manual source switch keeps phantom position after an unsuccessful load', () => {
    const run = runtime(), p = player(602), h = switchHarness(run, p);
    h.switchSource(); assert.equal(h.calls[0].currentTime, 602);
    p.time = 0; p.ready = 0; p.hasRealDuration = false;
    h.switchSource(); assert.equal(h.calls[1].currentTime, 602); assert.equal(p.phantomPositionSec, 602);
    p.phantomPositionSec = undefined; h.switchSource(); assert.equal(h.calls[2].currentTime, 602);
});
test('Actual switch captures a pending resume before begin cancels its old seek', () => {
    const run = runtime(), p = player(602), h = switchHarness(run, p);
    run.recovery.begin(p, false, true); p.time = 0.4; p.ready = 0; p.stopped = true; p.hasRealDuration = true; p.phantomPositionSec = 602;
    run.recovery.scheduleSeek(p, 602);
    h.switchSource(); assert.equal(h.calls[0].currentTime, 602); assert.equal(p.phantomPositionSec, 602);
});
test('Actual first selection retains its bookmark when native fails before metadata', () => {
    const run = runtime(), p = player(0), h = switchHarness(run, p, 601); p.hasRealDuration = false; p.ready = 0;
    h.switchSource({isFirstChange: true}); assert.equal(h.calls[0].currentTime, 591);
    assert.equal(p.cancelPendingNativeSeek, undefined); assert.equal(p.phantomPositionSec, undefined);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {});
    assert.equal(run.recovery.position(p), 591);
    run.clock.tick(350); assert.equal(run.recovery.position(p), 591);
});
test('Physical/current, explicit zero and genuine user seek win over old resume', () => {
    const run = runtime(), p = player(602), h = switchHarness(run, p);
    h.switchSource({resumeTime: 0}); assert.equal(h.calls[0].currentTime, 0);
    p.hasRealDuration = true; p.time = 145; p.emit('timeupdate'); h.switchSource(); assert.equal(h.calls[1].currentTime, 145);
    p.hasRealDuration = true; p.emit('playing'); p.time = 0; p.emit('seeking'); h.switchSource(); assert.equal(h.calls[2].currentTime, 0);
});
test('New entity cannot inherit the last position of a different movie', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true);
    p.kpId = 999; p.time = 0; p.hasRealDuration = false; p.phantomPositionSec = undefined;
    run.recovery.begin(p, true, true);
    assert.equal(run.recovery.position(p, 0, true, 0), 0);
    assert.equal(run.recovery.position(p, undefined, true, 80), 80);
});

test('Slow native playing after5s still restores and verifies the pending position', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true); p.time = 0; p.ready = 0; p.stopped = true; p.hasRealDuration = false;
    run.recovery.scheduleSeek(p, 602); run.clock.tick(10000); assert.equal(p.seeks.length, 0);
    p.emit('playing'); assert.deepEqual(p.seeks, [602]); run.clock.tick(350); assert.equal(p.cancelPendingNativeSeek, undefined);
    assert(run.recovery.snapshot().events.some(x => x.kind === 'resume-confirmed'));
});
test('Ignored first native seek retries once and advancing zero clock cannot replace desired resume', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true); p.time = 0; p.ready = 0; p.stopped = true;
    let attempts = 0;
    p.currentTime = function (value) { if (!arguments.length) return this.time; this.seeks.push(value); if (++attempts > 1) this.time = value; };
    run.recovery.scheduleSeek(p, 602); p.emit('playing'); p.time = 0.4;
    assert.equal(run.recovery.position(p, undefined, false, 590), 602);
    run.clock.tick(700); assert.deepEqual(p.seeks, [602, 602]); assert.equal(p.time, 602);
    assert.equal(p.cancelPendingNativeSeek, undefined);
});
test('A deliberate seek tozero while buffering cancels old queued resume permanently', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true); p.time = 0; p.ready = 0; p.hasRealDuration = false; p.phantomPositionSec = 602;
    run.recovery.scheduleSeek(p, 602); run.recovery.userSeek(p, 0); p.emit('seeking');
    assert.equal(p.cancelPendingNativeSeek, undefined); assert.equal(run.recovery.position(p, undefined, false, 590), 0);
    p.emit('playing'); run.clock.tick(60001); assert.deepEqual(p.seeks, []);
});
test('Internal MSE initialization seekingzero does not cancel pending resume', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true); p.time = 0; p.ready = 0; p.stopped = true; p.hasRealDuration = true; p.phantomPositionSec = 602;
    run.recovery.scheduleSeek(p, 602); p.emit('seeking');
    assert.equal(typeof p.cancelPendingNativeSeek, 'function'); assert.equal(run.recovery.position(p), 602);
    p.emit('playing'); run.clock.tick(350); assert.equal(p.time, 602);
});
test('Internal zero before MSE canplay installs its pendingseek cannot become user intent', () => {
    const run = runtime(), p = player(602), h = switchHarness(run, p); run.recovery.begin(p, false, true);
    p.time = 0; p.ready = 1; p.hasRealDuration = true; p.phantomPositionSec = 602; p.emit('seeking');
    h.switchSource(); assert.equal(h.calls[0].currentTime, 602);
});
test('Actual remote seek commitzero overrides pending resume even during buffering', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true); p.time = 0; p.ready = 0; p.hasRealDuration = false; p.phantomPositionSec = 602; p.stopped = true;
    run.recovery.scheduleSeek(p, 602);
    const context = vm.createContext({lgGateRecovery: run.recovery, cC(object, key, value) { object[key] = value; }});
    compile(context, 'userSeek', 'vE'); const control = new context.gE(p); control.pendingTarget = 0; control.commit();
    assert.equal(p.cancelPendingNativeSeek, undefined); assert.equal(run.recovery.position(p, undefined, false, 590), 0);
    p.emit('playing'); run.clock.tick(1000); assert.equal(p.time, 0);
});
test('Queued native seek is cancelled by new source, release and dispose', () => {
    for (const action of ['source', 'release', 'dispose']) {
        const run = runtime(), p = player(602); run.recovery.begin(p, false, true); p.time = 0; p.ready = 0; p.stopped = true;
        run.recovery.scheduleSeek(p, 602);
        if (action === 'source') run.recovery.begin(p, false, false);
        else if (action === 'release') { run.recovery.reset(p, true); p.mediaReleased = true; }
        else p.emit('dispose');
        p.emit('playing'); run.clock.tick(60001); assert.deepEqual(p.seeks, [], action); assert.equal(run.clock.size, 0);
    }
});

test('Code4 gets one delayed same-source retry and duplicate errors cannot loop', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true); p.currentError = {code: 4}; p.time = 0; p.hasRealDuration = false; p.phantomPositionSec = 602;
    let fallbacks = 0;
    assert.equal(run.recovery.recover(p, 'player-error', () => ++fallbacks), 'retrying');
    assert.equal(run.recovery.recover(p, 'player-error', () => ++fallbacks), 'retrying');
    run.clock.tick(350); assert.equal(p.loads, 1); assert.equal(p.plays, 1);
    p.emit('playing'); assert.equal(p.currentTime(), 602);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => ++fallbacks);
    assert.equal(fallbacks, 1); run.clock.tick(1000); assert.equal(p.loads, 1);
});
test('Paused retry stays paused and a manual source change cancels old retry timer', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, false); p.stopped = true; p.currentError = {code: 4};
    run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    assert.equal(p.loads, 1); assert.equal(p.plays, 0);
    const next = player(602); run.recovery.begin(next, false, true); next.currentError = {code: 4}; run.recovery.recover(next, 'player-error', () => {});
    run.recovery.begin(next, false, false); run.clock.tick(350); assert.equal(next.loads, 0);
});
test('A deliberate pause of a healthy source remains paused during a transient reload', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true); p.emit('playing'); p.pause(); p.currentError = {code: 4};
    run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    assert.equal(p.loads, 1); assert.equal(p.plays, 0);
});
test('Release cancels the old load watchdog before it can resurrect playback', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true);
    const timer = run.clock.setTimeout(() => p.play(), 8000); p.cancelStreamLoadWatchdog = () => run.clock.clearTimeout(timer);
    run.recovery.reset(p, true); p.mediaReleased = true; run.clock.tick(16000); assert.equal(p.plays, 0);
});
test('Automatic fallback budget survives new-source events until stable playback', () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true); p.emit('playing'); run.clock.tick(11000);
    for (let i = 0; i < 2; i++) run.recovery.recover(p, 'segment-errors', () => { assert.equal(run.recovery.allowFallback(p), true); run.recovery.begin(p, false, true); p.emit('timeupdate'); });
    assert.equal(run.recovery.allowFallback(p), false);
    p.emit('playing'); run.clock.tick(10001); p.time += 20; p.emit('timeupdate'); assert.equal(run.recovery.allowFallback(p), true);
    run.recovery.begin(p, false, true); assert.equal(run.recovery.allowFallback(p), true);
});

test('Actual auto fallback stops aftertwo transitions, leaving other voices selectable', () => {
    const run = runtime(), p = player(602), data = {qualitiesByQuality: {'720': []}, audioByQuality: {'720': []}};
    for (let i = 0; i < 9; i++) { data.qualitiesByQuality['720'].push({streamId: 54, resolution: '720p', translation: 'voice' + i, url: 'https://media.invalid/' + i + '.m3u8', isAvailable: true}); data.audioByQuality['720'].push({streamId: 54, resolution: '720p', name: 'voice' + i, isAvailable: true}); }
    const {store} = storeHarness(); store.sources.groupedData = data; store.sources.isFetchingComplete = true; p.uri = data.qualitiesByQuality['720'][0].url;
    let chosen = 0, terminal = 0;
    const context = vm.createContext({lgGateRecovery: run.recovery, Object, Number,
        MS: () => store, yy: () => 590, vy: () => 580, my: {set() {}, get: () => null}, ny: {},
        u: Object.assign, gh: {HLS: 'HLS', DASH: 'DASH', DASHA: 'DASHA'},
        Mb: [], jb: new Set(), ub() {}, nb: {}, Pb: {}, _y: {SET_NEW_AUDIO_TRACK: 'new-audio'},
        setTimeout: run.clock.setTimeout, clearTimeout: run.clock.clearTimeout,
        Vb: () => '720', Gb: x => x, Hb: () => false, Bb: () => ({}), qb: () => { terminal++; },
        y_(args) { chosen++; p.uri = args.externalStreams.qualitiesByQuality['720'].find(x => x.translation === args.audio.name).url; p.currentError = null; run.recovery.begin(p, false, true); p.emit('playing'); }
    });
    compile(context, 'identify', 'Bb'); compile(context, 'mark', 'Wb'); compile(context, 'fallback', 'Fb');
    run.recovery.begin(p, false, true);
    for (let i = 0; i < 3; i++) { p.currentError = {code: 2}; context.zb(p, 'player-error'); }
    assert.equal(chosen, 2); assert.equal(terminal, 1);
    assert.equal(store.sources.groupedData.audioByQuality['720'].filter(x => x.isAvailable).length, 6);
});

test('Old delayed transform cannot replace a newer direct/native source', async () => {
    const run = runtime(), p = player(602); run.recovery.begin(p, false, true);
    let resolve, calls = [];
    const context = vm.createContext({lgGateRecovery: run.recovery, Lb: () => new Promise(done => { resolve = done; }), i_: (p, uri) => calls.push(uri)});
    compile(context, 'native', 's_');
    p.transformFn = value => value;
    context.a_({player: p, streamUrl: 'https://media.invalid/A.m3u8', switchTrackAndQuality() {}});
    run.recovery.begin(p, false, true); p.transformFn = undefined;
    context.a_({player: p, streamUrl: 'https://media.invalid/B.m3u8', switchTrackAndQuality() {}});
    resolve({masterSrcUrl: 'https://media.invalid/stale-A.m3u8'}); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(calls, ['https://media.invalid/B.m3u8']);
});
test('Actual non-native HLS ready handler verifies resume when its first seek is ignored', () => {
    const run = runtime(), p = player(606); run.recovery.begin(p, false, true); p.time = 0; p.ready = 0; p.stopped = true; p.hasRealDuration = false;
    p.audioTracks = () => []; p.qualityLevels = () => [];
    let attempts = 0;
    p.currentTime = function (value) { if (!arguments.length) return this.time; this.seeks.push(value); if (++attempts > 1) this.time = value; };
    const context = vm.createContext({lgGateRecovery: run.recovery, ch: () => false, $y() { p.emit('playing'); }});
    compile(context, 'hlsReady', 'u_');
    context.l_(p, {id: 'audio'}, '720', 606, null, true, false);
    p.time = 0.4; run.clock.tick(700);
    assert.deepEqual(p.seeks, [606, 606]); assert.equal(p.time, 606); assert.equal(p.cancelPendingNativeSeek, undefined);
    assert(run.recovery.snapshot().events.some(x => x.kind === 'resume-confirmed'));
});
test('Configured VHS bypasses platform native HLS routing and uses actual MSE ready path', () => {
    const run = runtime(), p = player(606); run.recovery.begin(p, false, true);
    p.options_ = {html5: {vhs: {overrideNative: true}}}; p.tech_ = {options_: {vhs: {overrideNative: true}}};
    p.audioTracks = () => []; p.qualityLevels = () => []; p.time = 0; p.ready = 0; p.stopped = true;
    let native = 0, mse = 0;
    const context = vm.createContext({lgGateRecovery: run.recovery, ch: () => true, gh: {HLS: 'HLS'},
        a_() { native++; }, i_(_p, _uri, _type, ready) { mse++; ready(); }, e_() { throw Error('native track path'); },
        $y() { p.emit('playing'); }
    });
    compile(context, 'hlsReady', 'u_'); compile(context, 'hlsTransport', 'n_');
    context.t_({player: p, availableQualityLevels: [], streamUrl: p.uri, audio: {}, streamType: 'hls', activeQuality: '720', currentTime: 606, autoPlay: true, isFirstChange: false});
    run.clock.tick(350); assert.equal(native, 0); assert.equal(mse, 1); assert.equal(p.time, 606);
});

function enableMseFixture(run, p, supported = true) {
    function Html5() {}
    Html5.sourceHandlers = [{name: 'videojs-http-streaming'}];
    const sharedHtml = {vhs: {overrideNative: false}, nativeAudioTracks: true, nativeVideoTracks: true};
    const sharedTech = {vhs: {overrideNative: false}, nativeAudioTracks: true, nativeVideoTracks: true};
    p.options_ = {html5: sharedHtml}; p.tech_ = {constructor: Html5, options_: sharedTech};
    p.currentSource = () => ({src: p.uri, type: 'application/x-mpegURL'});
    p.sourcesSet = [];
    p.src = function (value) { this.sourcesSet.push(value); this.uri = value.src; this.time = 0; this.ready = 0; this.tech_.vhs = {}; };
    run.root.MediaSource = {isTypeSupported: () => supported};
    return {sharedHtml, sharedTech};
}
test('Repeated native code4 reselects registered VHS exactlyonce with cloned instance options', () => {
    const run = runtime(), p = player(606), previous = enableMseFixture(run, p);
    run.recovery.begin(p, false, true); p.currentError = {code: 4}; p.time = 0; p.hasRealDuration = false; p.phantomPositionSec = 606;
    let fallback = 0, ready = [];
    run.recovery.recover(p, 'player-error', () => fallback++); run.clock.tick(350);
    p.currentError = {code: 4}; assert.equal(run.recovery.recover(p, 'player-error', () => fallback++, (pos, auto) => { ready.push({pos, auto}); p.emit('playing'); }), 'retrying-mse');
    run.clock.tick(350);
    assert.equal(p.sourcesSet.length, 1); assert.equal(fallback, 0); assert.equal(ready.length, 0);
    assert.equal(p.options_.html5.vhs.overrideNative, true); assert.equal(p.tech_.options_.vhs.overrideNative, true);
    assert.equal(p.options_.html5.nativeAudioTracks, false); assert.equal(p.tech_.options_.nativeVideoTracks, false);
    assert.equal(previous.sharedHtml.vhs.overrideNative, false); assert.equal(previous.sharedTech.nativeAudioTracks, true);
    p.emit('canplay'); run.clock.tick(350); assert.deepEqual(ready, [{pos: 606, auto: true}]); assert.equal(p.time, 606);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => fallback++); run.clock.tick(1000);
    assert.equal(p.sourcesSet.length, 1); assert.equal(fallback, 1);
    assert(run.recovery.snapshot().events.some(e => e.kind === 'native-to-mse'));
});
test('Unsupported MSE capability and an already-VHS tech skip transport fallback', () => {
    for (const kind of ['unsupported', 'already-vhs', 'no-handler']) {
        const run = runtime(), p = player(606); enableMseFixture(run, p, kind !== 'unsupported');
        if (kind === 'already-vhs') p.tech_.vhs = {};
        if (kind === 'no-handler') p.tech_.constructor.sourceHandlers = [];
        run.recovery.begin(p, false, true); p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
        p.currentError = {code: 4}; let fallback = 0; run.recovery.recover(p, 'player-error', () => fallback++); run.clock.tick(350);
        assert.equal(p.sourcesSet.length, 0, kind); assert.equal(fallback, 1, kind);
    }
});
test('New selection cancels delayed MSE reselect and ready completion cannot affect another source', () => {
    const run = runtime(), p = player(606); enableMseFixture(run, p); run.recovery.begin(p, false, true);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {});
    run.recovery.begin(p, false, true); run.clock.tick(350); assert.equal(p.sourcesSet.length, 0);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    p.currentError = {code: 4}; let completed = 0; run.recovery.recover(p, 'player-error', () => {}, () => completed++);
    run.clock.tick(350); assert.equal(p.sourcesSet.length, 1);
    run.recovery.begin(p, false, true); p.uri = 'https://media.invalid/new-selection.m3u8'; p.currentError = null;
    p.emit('canplay'); run.clock.tick(16000);
    assert.equal(completed, 0); assert.equal(p.currentError, null);
});
test('Actual recovery wrapper completes VHS readiness with the current audio and saved position', () => {
    const run = runtime(), p = player(606); enableMseFixture(run, p); run.recovery.begin(p, false, true);
    p.time = 0; p.hasRealDuration = false; p.phantomPositionSec = 606;
    const audio = {streamId: 54, resolution: '1080p', name: 'HDrezka', quality: '1080'}, grouped = group(), selected = [];
    const context = vm.createContext({lgGateRecovery: run.recovery, MS: () => ({getSources: () => ({groupedData: grouped})}),
        my: {get(key) { return key === 'audio' ? audio : '1080'; }}, ny: {activeAudioTrack: 'audio', activeQualityLevel: 'quality'},
        y_(args) { selected.push(args); run.recovery.begin(p, false, args.autoPlay); p.emit('playing'); }
    });
    compile(context, 'fallback', 'Fb'); p.currentError = {code: 4}; context.zb(p, 'player-error'); run.clock.tick(350);
    p.currentError = {code: 4}; context.zb(p, 'player-error'); run.clock.tick(350); p.emit('canplay');
    assert.equal(selected.length, 1); assert.equal(selected[0].audio, audio); assert.equal(selected[0].activeQuality, '1080');
    assert.equal(selected[0].resumeTime, 606); assert.equal(selected[0].externalStreams, grouped);
});
test('Actual native master binding supplies its real input URI to VHS instead of generated data', async () => {
    const run = runtime(), p = player(606); enableMseFixture(run, p); run.recovery.begin(p, false, true);
    const real = 'https://media.invalid/real-1080.m3u8', data = 'data:application/x-mpegURL;base64,I0VYVE0zVQ==';
    p.transformFn = value => value;
    const context = vm.createContext({lgGateRecovery: run.recovery, Lb: () => Promise.resolve({masterSrcUrl: data}), i_(p, uri) { p.uri = uri; }});
    compile(context, 'native', 's_'); context.a_({player: p, streamUrl: real, streamType: 'hls', switchTrackAndQuality() {}, isFirstChange: false});
    await Promise.resolve(); await Promise.resolve(); assert.equal(p.uri, data); assert.equal(p.nativeHlsSourceKey, real);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    assert.equal(p.sourcesSet.length, 1); assert.equal(p.sourcesSet[0].src, real); assert(!p.sourcesSet[0].src.startsWith('data:'));
});
test('Stale native key cannot replace a different HTTP source or race its queued data retry', () => {
    const run = runtime(), p = player(606); enableMseFixture(run, p); run.recovery.begin(p, false, true);
    const current = p.uri; p.nativeHlsSourceKey = 'https://media.invalid/stale.m3u8';
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    assert.equal(p.sourcesSet[0].src, current);
    const next = player(606); enableMseFixture(run, next); run.recovery.begin(next, false, true);
    next.uri = 'data:application/x-mpegURL;base64,I0VYVE0zVQ=='; next.nativeHlsSourceKey = 'https://media.invalid/real.m3u8';
    run.recovery.rememberNative(next, next.nativeHlsSourceKey, next.uri);
    next.currentError = {code: 4}; run.recovery.recover(next, 'player-error', () => {}); run.clock.tick(350);
    next.currentError = {code: 4}; run.recovery.recover(next, 'player-error', () => {});
    next.nativeHlsSourceKey = 'https://media.invalid/unrelated.m3u8'; run.clock.tick(350);
    assert.equal(next.sourcesSet.length, 0);
});
test('The MSE play nudge opens a source that cannot emit canplay while paused', () => {
    const run = runtime(), p = player(606); enableMseFixture(run, p); run.recovery.begin(p, false, true);
    let completed = 0;
    p.play = function () { this.plays++; this.stopped = false; if (this.tech_.vhs) { this.ready = 3; this.emit('canplay'); this.emit('playing'); } return Promise.resolve(); };
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}, () => completed++); run.clock.tick(700);
    assert.equal(completed, 1); assert.equal(p.time, 606); assert.equal(p.sourcesSet.length, 1);
    assert(!run.recovery.snapshot().events.some(e => e.kind === 'mse-ready-timeout'));
});
test('Cold autoplay intent survives the real play readiness guard during MSE recovery', () => {
    const run = runtime(), p = player(0); enableMseFixture(run, p); p.hasBeenReady = false; p.hasRealDuration = false; p.autoPlayOnReady = true;
    const guardContext = vm.createContext({nT: 'not-ready', _y: {NEW_ENTITY: 'new-entity', STREAMS_LOADING_START: 'loading', CONTENT_LOADED: 'content'}});
    vm.runInContext('var guard=' + fixture.fragments.playGuard, guardContext); guardContext.guard(p);
    run.recovery.begin(p, true, false); run.recovery.position(p, 606, true);
    p.play = function () { this.plays++; this.stopped = false; this.emit('play'); if (!this.stopped && this.tech_.vhs) { this.ready = 3; this.emit('canplay'); this.emit('playing'); } return Promise.resolve(); };
    let ready = 0;
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}, (position, auto) => { ready++; assert.equal(auto, true); assert.equal(position, 606); p.emit('content'); });
    run.clock.tick(700); assert.equal(ready, 1); assert.equal(p.time, 606); assert.equal(p.paused(), false);
});
test('Continue/defer choice blocks a cold automatic MSE play nudge', () => {
    const run = runtime(), p = player(0); enableMseFixture(run, p); p.hasBeenReady = false; p.autoPlayOnReady = true; p.deferResumeToButton = true; p.blockAutoPlayForContinue = true; p.stopped = true;
    run.recovery.begin(p, true, false); run.recovery.position(p, 606, true);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    p.currentError = {code: 4}; run.recovery.recover(p, 'player-error', () => {}); run.clock.tick(350);
    assert.equal(p.sourcesSet.length, 1); assert.equal(p.plays, 0); assert.equal(p.paused(), true); assert.equal(run.recovery.position(p), 606);
});
test('Actual HLS ready handler respects deferred resume and explicit button applies guarded seek', () => {
    const run = runtime(), p = player(0); run.recovery.begin(p, true, false); p.stopped = true; p.ready = 0; p.deferResumeToButton = true;
    p.audioTracks = () => []; p.qualityLevels = () => [];
    const context = vm.createContext({lgGateRecovery: run.recovery, ch: () => false, $y() {}});
    compile(context, 'hlsReady', 'u_'); context.l_(p, {id: 'audio'}, '720', 606, null, false, true);
    assert.equal(p.cancelPendingNativeSeek, undefined); assert.deepEqual(p.seeks, []);
    p.applyStartPosition(606); p.emit('playing'); run.clock.tick(350); assert.equal(p.time, 606);
});
test('Actual MP4 ready handler restores the requested position after playing', () => {
    const run = runtime(), p = player(606); run.recovery.begin(p, false, true); p.time = 0; p.ready = 0; p.stopped = true;
    p.src = function (value) { this.uri = value.src; this.time = 0; };
    const context = vm.createContext({lgGateRecovery: run.recovery, u_: ['loadedmetadata'], Wb: options => options.onReady(), $y() { p.emit('playing'); }});
    compile(context, 'mp4Ready', 'd_'); context.c_({player: p, streamUrl: 'https://media.invalid/B.mp4', streamType: 'mp4', currentTime: 606, autoPlay: true, isFirstChange: false});
    run.clock.tick(350); assert.equal(p.time, 606); assert.equal(p.cancelPendingNativeSeek, undefined);
});
test('Deferred MP4 Continue replaces a stale DASH setter with the current transport seek', () => {
    const run = runtime(), p = player(0); run.recovery.begin(p, true, false); p.time = 0; p.ready = 0; p.stopped = true; p.deferResumeToButton = true;
    p.applyStartPosition = () => { throw Error('stale DASH seek'); };
    p.dashPlayer = {destroy() {}, seek() { throw Error('old DASH transport'); }};
    p.src = function (value) { this.uri = value.src; this.time = 0; };
    const context = vm.createContext({lgGateRecovery: run.recovery, u_: ['loadedmetadata'], Wb: options => options.onReady(), $y() {}});
    compile(context, 'mp4Ready', 'd_'); context.c_({player: p, streamUrl: 'https://media.invalid/B.mp4', streamType: 'mp4', currentTime: 606, autoPlay: false, isFirstChange: true});
    assert.deepEqual(p.seeks, []); assert.equal(p.dashPlayer, undefined);
    p.applyStartPosition(606); p.emit('playing'); run.clock.tick(350); assert.equal(p.time, 606);
});
test('Native HLS Continue also replaces a stale DASH setter before its early branch', () => {
    const run = runtime(), p = player(0); run.recovery.begin(p, true, false); p.time = 0; p.ready = 0; p.stopped = true;
    p.applyStartPosition = () => { throw Error('stale DASH seek'); };
    const context = vm.createContext({lgGateRecovery: run.recovery, ch: () => true, e_() {}, o_: run.recovery.scheduleSeek, $y() {}});
    compile(context, 'hlsReady', 'u_'); context.l_(p, {}, '720', 0, null, false, true);
    p.applyStartPosition(606); p.emit('playing'); run.clock.tick(350); assert.equal(p.time, 606);
});
test('Actual DASH initialized handler retains its DASH seek API and verifies resume', () => {
    const run = runtime(), p = player(606); run.recovery.begin(p, false, true); p.time = 0; p.ready = 0; p.stopped = true;
    const calls = []; p.dashPlayer = {duration: () => 7929, seek: value => { calls.push(value); p.time = value; }};
    const context = vm.createContext({lgGateRecovery: run.recovery, Number, vb() { p.emit('playing'); }});
    compile(context, 'dashReady', 'vb');
    context.gb({player: p, currentTime: 606, audio: {}, activeQuality: '720', dashQualityId: 'q720', autoPlay: true, isFirstChange: false});
    run.clock.tick(350); assert.deepEqual(calls, [606]); assert.equal(p.time, 606); assert.equal(p.cancelPendingNativeSeek, undefined);
});
test('Diagnostics remain bounded, copied, read-only and contain no playback URLs', () => {
    const run = runtime(), p = player(602);
    for (let i = 0; i < 80; i++) run.recovery.begin(p, false, true);
    const first = run.root.__lgGatePlayerRecovery.snapshot(); assert.equal(first.events.length, 40);
    assert(!JSON.stringify(first).includes('https://')); assert(Object.isFrozen(run.root.__lgGatePlayerRecovery));
    first.events.length = 0; assert.equal(run.root.__lgGatePlayerRecovery.snapshot().events.length, 40);
    assert.equal(Object.keys(run.root).includes('__lgGatePlayerRecovery'), false);
});

const rawPath = path.resolve(__dirname, '../.build/zona-narnia-fix-20261104/player-upstream-original.js');
test('Available exact upstream passes pinned patch and generated bundle syntax', {skip: !fs.existsSync(rawPath)}, () => {
    const raw = fs.readFileSync(rawPath, 'utf8'), result = patcher.patch(raw);
    new vm.Script(result);
    assert.equal(result.split(patcher.marker).length - 1, 1);
    assert.throws(() => patcher.patch(result), /ALREADY_APPLIED/);
});
const node012 = process.env.ZONA_NODE012 || path.resolve(__dirname, '../.build/zona-source-lab/autonomy/runtime/node-v0.12.2-x64.exe');
test('Patch module and runtime factory execute on official Node0.12.2', {skip: !fs.existsSync(node012)}, () => {
    const script = 'var p=require(process.argv[1]),r=p.createRecovery({window:{}});console.log(JSON.stringify({node:process.version,version:p.version,snapshot:r.snapshot()}));';
    const result = spawnSync(node012, ['-e', script, path.resolve(__dirname, '../tv/zona-player-patch.js')], {encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false});
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).node, 'v0.12.2');
    if (fs.existsSync(rawPath)) {
        const compare = 'var fs=require("fs"),p=require(process.argv[1]),o=p.patch(fs.readFileSync(process.argv[2],"utf8"));console.log(require("crypto").createHash("sha256").update(o,"utf8").digest("hex"));';
        const actual = spawnSync(node012, ['-e', compare, path.resolve(__dirname, '../tv/zona-player-patch.js'), rawPath], {encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false});
        const expected = require('node:crypto').createHash('sha256').update(patcher.patch(fs.readFileSync(rawPath, 'utf8'))).digest('hex');
        assert.equal(actual.status, 0, actual.stderr); assert.equal(actual.stdout.trim(), expected, 'Emitted asset is deterministic across Node versions');
    }
});

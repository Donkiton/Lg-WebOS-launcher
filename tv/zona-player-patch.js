'use strict';

// The TV service applies this only to the reviewed raw legacy player, before
// rewriting its origins. The runtime factory deliberately uses ES5 syntax.
var crypto = require('crypto');
var VERSION = 'player-recovery-v4-compat-20261106';
var MARKER = 'lg-gate-player-recovery-v4';
var PINNED = 'dc860543885329f16a0bc8387d4c7f7a7e58cafec5464af0a1e565bebd45c87f';
var PREVIOUS = 'bd14992cb038894619559a4d19ca6265a247eabda553926e32c1c3129cf6a632';

function createRecovery(environment) {
    var env = environment || {};
    var now = env.now || function () { return Date.now(); };
    var later = env.setTimeout || function (fn, delay) { return setTimeout(fn, delay); };
    var cancel = env.clearTimeout || function (id) { clearTimeout(id); };
    var failureLifetime = 30000;
    var maximumFallbacks = 2;
    var events = [];
    var lastSummary = null;
    function finite(value) { return typeof value === 'number' && isFinite(value) && value >= 0; }
    function clock(player) { try { var n = player.currentTime(); return finite(n) ? n : null; } catch (error) { return null; } }
    function source(player) { try { return player.currentSrc() || ''; } catch (error) { return ''; } }
    function opaque(value) {
        var text = String(value || ''), hash = 2166136261, i;
        for (i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24); }
        return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
    }
    function event(player, kind, detail) {
        var state = player && player.__lgGateRecovery;
        var row = { at: now(), kind: kind, epoch: state ? state.epoch : 0, sourceId: opaque(player ? source(player) : ''), time: player ? clock(player) : null };
        Object.keys(detail || {}).forEach(function (key) { row[key] = detail[key]; });
        events.push(row); if (events.length > 40) events.shift();
        lastSummary = { epoch: row.epoch, sourceId: row.sourceId, time: row.time, lastGood: state ? state.lastGood : null, fallbacks: state ? state.fallbacks : 0 };
    }
    function entity(player) { return String(player.kpId || '') + ':' + String(player.episodeKey || ''); }
    function cancelFallback(player, state) {
        var fn = state.cancelFallback;
        state.cancelFallback = null;
        if (fn) fn();
        player.isSwitchingStreamOnError = false;
        player.hasStreamErrorDuringSwitch = false;
    }
    function cancelPending(player, state) {
        if (state.retryTimer !== null) { cancel(state.retryTimer); state.retryTimer = null; }
        if (state.cancelMseReady) state.cancelMseReady();
        cancelFallback(player, state);
        if (player.cancelStreamLoadWatchdog) player.cancelStreamLoadWatchdog();
        if (player.cancelPendingNativeSeek) player.cancelPendingNativeSeek();
    }
    function remember(player, state, keepBudget) {
        var value = clock(player);
        if (state.pendingSeek || player.hasRealDuration === false || value === null) return;
        var ready = 0;
        try { ready = player.readyState(); } catch (error) { ready = 0; }
        if (ready < 2 || (value === 0 && !state.zeroChosen)) return;
        state.lastGood = value;
        if (value > 0) state.zeroChosen = false;
        if (!keepBudget && state.playingAt && now() - state.playingAt > 10000) { state.fallbacks = 0; state.retries = {}; }
    }
    function stateFor(player) {
        var state = player.__lgGateRecovery;
        if (!state) {
            state = player.__lgGateRecovery = { entity: entity(player), epoch: 0, lastGood: null, zeroChosen: false, fallbacks: 0, retries: {}, retryTimer: null, cancelFallback: null, automatic: false, pendingSeek: null, playingAt: 0, disposed: false, shouldPlay: false, switching: false, mseAttempted: false };
            if (player.on) {
                player.on('timeupdate', function () { remember(player, state); });
                player.on('playing', function () { state.playingAt = now(); state.shouldPlay = true; state.switching = false; remember(player, state); });
                player.on('pause', function () {
                    try { if (!state.switching && player.readyState() >= 2 && !player.error()) state.shouldPlay = false; } catch (error) {}
                });
                player.on('seeking', function () {
                    var value = clock(player), pending = state.pendingSeek;
                    var scrubbing = false;
                    try { scrubbing = !!(player.scrubbing && player.scrubbing()); } catch (error) {}
                    if (pending && !pending.setting && scrubbing && finite(value) && Math.abs(value - pending.target) > 2) {
                        userSeek(player, value);
                    }
                    if (!state.pendingSeek && !state.switching && player.hasRealDuration !== false && finite(value)) { state.lastGood = value; state.zeroChosen = value === 0; }
                });
                player.one('dispose', function () { reset(player, true); state.disposed = true; });
            }
        }
        return state;
    }
    function token(player) { var state = stateFor(player); return { epoch: state.epoch, generation: player.mediaGeneration || 0, entity: entity(player) }; }
    function same(player, value) {
        var state = stateFor(player);
        return !state.disposed && !player.mediaReleased && value && state.epoch === value.epoch && (player.mediaGeneration || 0) === value.generation && entity(player) === value.entity;
    }
    function position(player, explicit, first, history) {
        var state = stateFor(player), value = clock(player), phantom = player.phantomPositionSec;
        // The first source may fail before loadedmetadata installs its seek.
        // Retain the declared bookmark in memory without claiming a user seek.
        if (finite(explicit)) { state.lastGood = explicit; return explicit; }
        if (state.pendingSeek && finite(state.pendingSeek.target)) return state.pendingSeek.target;
        if (state.zeroChosen && value === 0) return 0;
        if (finite(value) && value > 0 && player.hasRealDuration !== false) { state.lastGood = value; return value; }
        if (finite(phantom) && phantom > 0) return phantom;
        if (!first && finite(state.lastGood)) return state.lastGood;
        return finite(history) ? history : 0;
    }
    function begin(player, first, autoPlay) {
        var state = stateFor(player), key = entity(player);
        if (state.entity !== key) { reset(player, true); state.entity = key; }
        else {
            remember(player, state, true);
            // Capture an unconfirmed resume BEFORE cancelling its old seek.
            // A newly loaded native clock may already advance from zero while
            // the requested position still belongs to the previous selection.
            if (state.pendingSeek && finite(state.pendingSeek.target)) {
                state.lastGood = state.pendingSeek.target;
                player.phantomPositionSec = state.pendingSeek.target > 0 ? state.pendingSeek.target : undefined;
                state.zeroChosen = state.pendingSeek.target === 0;
                player.hasRealDuration = false;
            }
        }
        if (state.cancelMseReady) state.cancelMseReady();
        if (!state.automatic) { cancelPending(player, state); state.fallbacks = 0; state.retries = {}; }
        else if (player.cancelPendingNativeSeek) player.cancelPendingNativeSeek();
        state.epoch++;
        state.shouldPlay = autoPlay !== false; state.switching = true; state.playingAt = 0;
        player.nativeHlsReqSeq = (player.nativeHlsReqSeq || 0) + 1;
        event(player, first ? 'entity-source' : 'source-change', { resume: position(player, undefined, !!first) });
    }
    function reset(player, discardPosition) {
        var state = stateFor(player);
        cancelPending(player, state);
        state.epoch++;
        state.fallbacks = 0; state.retries = {}; state.playingAt = 0; state.switching = false;
        player.nativeHlsReqSeq = (player.nativeHlsReqSeq || 0) + 1;
        if (discardPosition) { state.lastGood = null; state.zeroChosen = false; state.nativeMaster = null; }
    }
    function scheduleSeek(player, target, writePosition) {
        if (!finite(target)) return;
        if (player.cancelPendingNativeSeek) player.cancelPendingNativeSeek();
        var state = stateFor(player), stamp = token(player), attempts = 0, timer = null, verifyTimer = null;
        var pending = { target: target, setting: false, stop: stop, lastSetAt: null };
        state.pendingSeek = pending;
        function stop() {
            if (state.pendingSeek === pending) state.pendingSeek = null;
            if (player.cancelPendingNativeSeek === stop) player.cancelPendingNativeSeek = undefined;
            player.off('playing', apply); player.off('timeupdate', verify); player.off('seeked', verify);
            if (timer !== null) cancel(timer);
            if (verifyTimer !== null) cancel(verifyTimer);
        }
        function verify() {
            if (!same(player, stamp)) return stop();
            // VideoJS may echo a just-written cached value before its media
            // engine accepts the seek. Verify a later clock/event instead.
            if (pending.lastSetAt === null || now() - pending.lastSetAt < 100) return;
            var value = clock(player);
            if (finite(value) && Math.abs(value - target) < 2) {
                state.lastGood = value; state.zeroChosen = target === 0;
                event(player, 'resume-confirmed', { wanted: target }); stop();
            }
        }
        function apply() {
            if (!same(player, stamp)) return stop();
            if (attempts >= 2) return;
            attempts++; pending.setting = true; pending.lastSetAt = now();
            try { if (writePosition) writePosition(target); else player.currentTime(target); } catch (error) { event(player, 'resume-set-error', { wanted: target }); }
            pending.setting = false; verify();
            if (state.pendingSeek === pending) verifyTimer = later(function () {
                verify();
                var value = clock(player);
                if (state.pendingSeek === pending && attempts < 2 && finite(value) && Math.abs(value - target) >= 2) apply();
            }, 350);
        }
        player.cancelPendingNativeSeek = stop;
        player.on('playing', apply); player.on('timeupdate', verify); player.on('seeked', verify);
        // Do not lose a valid resume merely because native playback buffers for
        // several seconds before its first playing event.
        timer = later(function () { event(player, 'resume-unconfirmed', { wanted: target }); stop(); }, 60000);
        try { if (!player.paused() && player.readyState() >= 2) apply(); } catch (error) {}
    }
    function userSeek(player, value) {
        if (!finite(value)) return;
        var state = stateFor(player);
        if (state.pendingSeek) state.pendingSeek.stop();
        state.lastGood = value; state.zeroChosen = value === 0;
        player.phantomPositionSec = value > 0 ? value : undefined;
        event(player, 'user-seek', { wanted: value });
    }
    function techFor(player) {
        if (player.tech_) return player.tech_;
        try { return player.tech && player.tech({ IWillNotUseThisInPlugins: true }); } catch (error) { return null; }
    }
    function isMse(player) {
        var tech = techFor(player), html = player.options_ && player.options_.html5, options = tech && tech.options_;
        return !!(tech && tech.vhs || html && html.vhs && html.vhs.overrideNative === true && options && options.vhs && options.vhs.overrideNative === true);
    }
    function canUseMse(player) {
        var tech = techFor(player), handlers = tech && tech.constructor && tech.constructor.sourceHandlers || [], supported = false;
        handlers.forEach(function (handler) { if (handler && handler.name === 'videojs-http-streaming') supported = true; });
        var media = root && root.MediaSource;
        if (!supported || !media || typeof media.isTypeSupported !== 'function' || isMse(player)) return false;
        var current = null;
        try { current = player.currentSource && player.currentSource(); } catch (error) {}
        var type = current && current.type || '';
        if (!/mpegurl/i.test(type) && !/\.m3u8(?:[?#]|$)/i.test(source(player))) return false;
        try { return !!media.isTypeSupported('video/mp4; codecs="avc1.4d401f"') && !!media.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'); } catch (error) { return false; }
    }
    function copyOptions(value) { var result = {}; Object.keys(value || {}).forEach(function (key) { result[key] = value[key]; }); return result; }
    function configureMse(player) {
        var tech = techFor(player), options = copyOptions(player.options_), html = copyOptions(options.html5), vhs = copyOptions(html.vhs), current = copyOptions(tech.options_), techVhs = copyOptions(current.vhs);
        vhs.overrideNative = true; techVhs.overrideNative = true;
        html.vhs = vhs; html.nativeAudioTracks = false; html.nativeVideoTracks = false;
        current.vhs = techVhs; current.nativeAudioTracks = false; current.nativeVideoTracks = false;
        options.html5 = html; player.options_ = options; tech.options_ = current;
    }
    function rememberNative(player, key, uri) {
        stateFor(player).nativeMaster = key && uri ? { key: key, uri: uri, stamp: token(player) } : null;
    }
    function playbackWanted(player, state) {
        if (player.deferResumeToButton || player.blockAutoPlayForContinue) return false;
        return state.shouldPlay || !player.hasBeenReady && player.autoPlayOnReady === true;
    }
    function retryWithMse(player, state, onReady) {
        if (state.mseAttempted || !canUseMse(player) || typeof player.src !== 'function') return false;
        var stamp = token(player), uri = source(player), resume = position(player), shouldPlay = playbackWanted(player, state), current = null;
        try { current = player.currentSource && player.currentSource(); } catch (error) {}
        var selected = copyOptions(current);
        selected.src = uri; selected.type = selected.type || 'application/x-mpegURL';
        if (/^data:application\/(?:x-mpegurl|vnd\.apple\.mpegurl)[;,]/i.test(uri)) {
            // a_ creates a synthetic master for native HLS. VHS must receive
            // its real playlist, bound to this exact master and source epoch.
            var master = state.nativeMaster;
            if (!master || master.uri !== uri || master.key !== player.nativeHlsSourceKey || !same(player, master.stamp) || !/^https?:\/\//i.test(master.key)) { event(player, 'mse-source-unresolved', {}); return false; }
            selected.src = master.key;
        }
        state.retryTimer = later(function () {
            state.retryTimer = null;
            if (!same(player, stamp) || source(player) !== uri) return;
            if (master && (state.nativeMaster !== master || master.key !== player.nativeHlsSourceKey || !same(player, master.stamp))) return;
            state.mseAttempted = true;
            try {
                configureMse(player);
                state.automatic = true;
                try { begin(player, false, shouldPlay); } finally { state.automatic = false; }
                player.error(null); player.hasRealDuration = false;
                player.phantomPositionSec = resume > 0 ? resume : undefined;
                event(player, 'native-to-mse', { code: 4, resume: resume });
                var readyStamp = token(player), readyTimer = null;
                var cleanupReady = function () {
                    player.off('canplay', ready); player.off('dispose', cleanupReady);
                    if (readyTimer !== null) cancel(readyTimer);
                    if (state.cancelMseReady === cleanupReady) state.cancelMseReady = null;
                    if (same(player, readyStamp) && !state.cancelFallback) { player.isSwitchingStreamOnError = false; player.hasStreamErrorDuringSwitch = false; }
                };
                var ready = function () {
                    cleanupReady();
                    if (!same(player, readyStamp) || source(player) !== selected.src) return;
                    event(player, 'mse-ready', { resume: resume });
                    if (onReady) {
                        state.automatic = true;
                        try { onReady(resume, shouldPlay); } finally { state.automatic = false; }
                    } else if (shouldPlay && player.play) { var promise = player.play(); if (promise && promise.catch) promise.catch(function () {}); }
                };
                state.cancelMseReady = cleanupReady;
                player.on('canplay', ready); player.on('dispose', cleanupReady);
                readyTimer = later(function () {
                    cleanupReady();
                    if (!same(player, readyStamp) || source(player) !== selected.src) return;
                    event(player, 'mse-ready-timeout', {});
                    player.error({ code: 4, message: 'Не удалось загрузить видео. Выберите другую озвучку или повторите попытку.' });
                }, 30000);
                // load() retains the old native source handler. A new source
                // object deliberately re-runs the already-registered VHS path.
                player.isSwitchingStreamOnError = true; player.hasStreamErrorDuringSwitch = false;
                player.src(selected);
                scheduleSeek(player, resume);
                // The original ready watchdog also nudges play before canplay.
                // A failed native load can leave sourceopen waiting for this.
                if (shouldPlay && player.play) { var promise = player.play(); if (promise && promise.catch) promise.catch(function () { event(player, 'mse-start-rejected', {}); }); }
            } catch (error) { if (state.cancelMseReady) state.cancelMseReady(); event(player, 'mse-retry-error', {}); player.error({ code: 4, message: 'Не удалось повторно загрузить видео.' }); }
        }, 350);
        return true;
    }
    function recover(player, reason, run, onMseReady) {
        var state = stateFor(player);
        if (state.disposed || player.mediaReleased) return 'ignored';
        if (state.retryTimer !== null) return 'retrying';
        var error = player.error && player.error(), key = opaque(source(player));
        if (reason === 'player-error' && error && state.cancelMseReady) state.cancelMseReady();
        event(player, 'recovery', { reason: String(reason).slice(0, 48), code: error && error.code || 0, resume: position(player) });
        if (reason === 'player-error' && error && error.code === 4 && !player.isSwitchingStreamOnError && !state.retries[key] && source(player) && player.load) {
            state.retries[key] = 1;
            var stamp = token(player), uri = source(player), resume = position(player), shouldPlay = playbackWanted(player, state);
            state.retryTimer = later(function () {
                state.retryTimer = null;
                if (!same(player, stamp) || source(player) !== uri) return;
                event(player, 'same-source-retry', { resume: resume });
                player.error(null);
                if (player.cancelStreamLoadWatchdog) player.cancelStreamLoadWatchdog();
                try { player.load(); scheduleSeek(player, resume); if (shouldPlay && player.play) { var promise = player.play(); if (promise && promise.catch) promise.catch(function () {}); } } catch (failure) { event(player, 'retry-load-error', {}); }
            }, 350);
            return 'retrying';
        }
        if (reason === 'player-error' && error && error.code === 4 && !player.isSwitchingStreamOnError && retryWithMse(player, state, onMseReady)) return 'retrying-mse';
        state.automatic = true;
        try { return run(); } finally { state.automatic = false; }
    }
    function allowFallback(player) {
        var state = stateFor(player);
        if (state.fallbacks >= maximumFallbacks) { event(player, 'fallback-limit', { limit: maximumFallbacks }); return false; }
        state.fallbacks++; return true;
    }
    function trackFallback(player, fn) { stateFor(player).cancelFallback = fn; }
    function finishFallback(player, fn) { var state = stateFor(player); if (state.cancelFallback !== fn) return false; state.cancelFallback = null; return true; }
    function rowKey(row, bucket) {
        var data = row && row.data || {}, nested = row && row.source || {}, inner = data.source || {};
        return JSON.stringify([row.streamId == null ? data.streamId : row.streamId, row.resolution == null ? data.resolution : row.resolution, String(bucket), row.translation || data.translation || row.name || data.name || '', row.url || nested.url || data.url || inner.url || '', row.uid || data.uid || '']);
    }
    function each(group, callback) {
        ['qualitiesByQuality', 'audioByQuality'].forEach(function (field) {
            Object.keys(group && group[field] || {}).forEach(function (bucket) { group[field][bucket].forEach(function (row) { callback(row, rowKey(row, bucket)); }); });
        });
    }
    function expireStore(store, incoming) {
        var failures = store.__lgGateFailures || {}, expired = {}, time = now();
        Object.keys(failures).forEach(function (key) { if (failures[key] <= time) { expired[key] = true; delete failures[key]; store.brokenStreamKeys.delete(key); } });
        // Only lift flags owned by this recovery layer, never parse failures.
        each(store.sources.groupedData, function (row, key) { if (expired[key] && row.__lgGatePlaybackFailure) { row.isAvailable = true; delete row.__lgGatePlaybackFailure; } });
        if (incoming) each(incoming, function (row, key) { if (failures[key] && row.isAvailable !== false) { row.isAvailable = false; row.__lgGatePlaybackFailure = true; } });
    }
    function setGroup(store, group) {
        var expiredCopies = {}, existing = store.__lgGateFailures || {}, time = now();
        Object.keys(existing).forEach(function (key) { if (existing[key] <= time) expiredCopies[key] = true; });
        expireStore(store);
        var previous = {}, failures = store.__lgGateFailures || (store.__lgGateFailures = {});
        each(store.sources.groupedData, function (row, key) { previous[key] = row.isAvailable; });
        each(group, function (row, key) {
            if (expiredCopies[key]) { if (row.__lgGatePlaybackFailure) { row.isAvailable = true; delete row.__lgGatePlaybackFailure; } return; }
            if (row.isAvailable === false && previous[key] === true && !failures[key]) { failures[key] = now() + failureLifetime; store.brokenStreamKeys.add(key); row.__lgGatePlaybackFailure = true; }
        });
        store.sources.groupedData = group;
    }
    function getSources(store) { expireStore(store); return store.sources; }
    function clearStore(store) { store.__lgGateFailures = {}; store.brokenStreamKeys.clear(); }
    var api = { key: rowKey, expireStore: expireStore, setGroup: setGroup, getSources: getSources, clearStore: clearStore, position: position, begin: begin, reset: reset, token: token, same: same, scheduleSeek: scheduleSeek, userSeek: userSeek, isMse: isMse, rememberNative: rememberNative, recover: recover, allowFallback: allowFallback, trackFallback: trackFallback, finishFallback: finishFallback,
        snapshot: function () { return { version: 'player-recovery-v4', events: events.map(function (row) { var copy = {}; Object.keys(row).forEach(function (key) { copy[key] = row[key]; }); return copy; }), last: lastSummary ? JSON.parse(JSON.stringify(lastSummary)) : null }; } };
    var root = env.window || (typeof window !== 'undefined' ? window : null);
    if (root) {
        var diagnostic = { snapshot: api.snapshot };
        if (Object.freeze) Object.freeze(diagnostic);
        try { Object.defineProperty(root, '__lgGatePlayerRecovery', { value: diagnostic, configurable: true }); } catch (error) {}
    }
    return api;
}

function previousOperations() {
    var oldKey = 'streamKey(e,t){return`${e}:${t}`}';
    var oldApply = 'applyBrokenMarks(e){if(!this.brokenStreamKeys.size)return;const t=e=>{Object.values(e).forEach(e=>{e.forEach(e=>{this.brokenStreamKeys.has(this.streamKey(e.streamId,e.resolution))&&(e.isAvailable=!1)})})};t(e.qualitiesByQuality),t(e.audioByQuality)}';
    var oldSet = 'setGroupedSourceData(e){const t=e=>{Object.values(e).forEach(e=>{e.forEach(e=>{!1===e.isAvailable&&this.brokenStreamKeys.add(this.streamKey(e.streamId,e.resolution))})})};t(e.qualitiesByQuality),t(e.audioByQuality),this.sources.groupedData=e}';
    return [
        [',wS,kS,IS,CS', ',wS,lgGateRecovery,kS,IS,CS'],
        [',kS=class{', ',lgGateRecovery=/*' + MARKER + '*/(' + createRecovery.toString() + ')(),kS=class{'],
        [oldKey, 'streamKey(e,t){return lgGateRecovery.key(e,t)}'],
        [oldApply, 'applyBrokenMarks(e){lgGateRecovery.expireStore(this,e)}'],
        [oldSet, 'setGroupedSourceData(e){lgGateRecovery.setGroup(this,e)}'],
        ['getSources(){return this.sources}', 'getSources(){return lgGateRecovery.getSources(this)}'],
        ['clearSources(){this.sources=', 'clearSources(){lgGateRecovery.clearStore(this),this.sources='],
        ['zb=(e,t)=>{var n,r,i;', 'zb=(e,t)=>lgGateRecovery.recover(e,t,()=>{var n,r,i;'],
        ['s=a&&a>0?a:null!=o?o:0,l=e.tech().el()', 's=lgGateRecovery.position(e,void 0,!1,o),l=e.tech().el()'],
        ['const f=()=>{e.isSwitchingStreamOnError=!1,e.hasStreamErrorDuringSwitch=!1,e.off("playing",f),clearTimeout(m)},m=setTimeout(()=>{const t=!0===e.hasStreamErrorDuringSwitch&&!!e.error();f(),t&&zb(e,"player-error")},5e3);e.one("playing",f)', 'var j;const f=()=>{lgGateRecovery.finishFallback(e,f)&&(e.isSwitchingStreamOnError=!1,e.hasStreamErrorDuringSwitch=!1),e.off("playing",f),clearTimeout(m)},m=setTimeout(()=>{if(j&&!lgGateRecovery.same(e,j))return f(),void 0;const t=!0===e.hasStreamErrorDuringSwitch&&!!e.error();f(),t&&zb(e,"player-error")},5e3);lgGateRecovery.trackFallback(e,f),e.one("playing",f)'],
        ['r.setGroupedSourceData(p);const g=Vb', 'r.setGroupedSourceData(p);if(!lgGateRecovery.allowFallback(e))return f(),qb(e,{retryable:!0,automaticSwitchLimit:2}),"exhausted";const g=Vb'],
        ['resumeTime:E?void 0:s}),"switched"},Fb=', 'resumeTime:E?void 0:s}),j=lgGateRecovery.token(e),"switched"},(s,a)=>{const n=MS(),r=my.get(ny.activeAudioTrack),i=my.get(ny.activeQualityLevel)||(r&&r.quality);if(n&&r)y_({audio:r,player:e,videoElement:e.tech().el(),externalStreams:n.getSources().groupedData,activeQuality:i,autoPlay:a,isFirstChange:!e.hasBeenReady,resumeTime:s})}),Fb='],
        ['resumeTime:s})=>{var l,c,d;o||', 'resumeTime:s})=>{var l,c,d;lgGateRecovery.begin(t,o,a),o||'],
        ['p=o?t.forceAutoPlayNextEntity?0:null!==(d=vy(t))&&void 0!==d?d:0:null!=s?s:t.currentTime();', 'p=lgGateRecovery.position(t,null!=s?s:o?t.forceAutoPlayNextEntity?0:null!==(d=vy(t))&&void 0!==d?d:0:void 0,o,yy(t));'],
        ['a_=({player:e,streamUrl:t,streamType:n,switchTrackAndQuality:r,isFirstChange:i})=>{var a;if(!i&&e.nativeHlsSourceKey===t)return r(),void 0;if(!t||!e.transformFn)return e.nativeHlsSourceKey=void 0,i_(e,t,n,r,!0),void 0;const o=e.nativeHlsReqSeq=(null!==(a=e.nativeHlsReqSeq)&&void 0!==a?a:0)+1;Lb(t,e.transformFn).then(({masterSrcUrl:i})=>{o===e.nativeHlsReqSeq&&(e.nativeHlsSourceKey=t,i_(e,i,n,r,!0))}).catch(i=>{o===e.nativeHlsReqSeq&&(e.nativeHlsSourceKey=void 0,i_(e,t,n,r,!0))})}', 'a_=({player:e,streamUrl:t,streamType:n,switchTrackAndQuality:r,isFirstChange:i})=>{const o=e.nativeHlsReqSeq=(e.nativeHlsReqSeq||0)+1,a=lgGateRecovery.token(e);if(!i&&e.nativeHlsSourceKey===t)return lgGateRecovery.rememberNative(e,t,e.currentSrc()),r(),void 0;if(!t||!e.transformFn)return e.nativeHlsSourceKey=void 0,lgGateRecovery.rememberNative(e,null,null),i_(e,t,n,r,!0),void 0;Lb(t,e.transformFn).then(({masterSrcUrl:i})=>{o===e.nativeHlsReqSeq&&lgGateRecovery.same(e,a)&&(e.nativeHlsSourceKey=t,lgGateRecovery.rememberNative(e,t,i),i_(e,i,n,r,!0))}).catch(i=>{o===e.nativeHlsReqSeq&&lgGateRecovery.same(e,a)&&(e.nativeHlsSourceKey=void 0,lgGateRecovery.rememberNative(e,null,null),i_(e,t,n,r,!0))})}'],
        ['o_=(e,t)=>{var n;null===(n=e.cancelPendingNativeSeek)||void 0===n||n.call(e);const r=e.nativeHlsSourceKey,i=e.nativeHlsReqSeq;let a=!1;const o=()=>{a=!0,e.cancelPendingNativeSeek=void 0,e.off("playing",s),null!==l&&clearTimeout(l)};e.cancelPendingNativeSeek=o;const s=()=>{if(!a){if(e.nativeHlsSourceKey!==r||e.nativeHlsReqSeq!==i)return o(),void 0;e.currentTime(t),o()}};e.on("playing",s);const l=setTimeout(o,s_)}', 'o_=(e,t)=>lgGateRecovery.scheduleSeek(e,t)'],
        ['if(ch())return a_({player:e,streamUrl:n,streamType:i,switchTrackAndQuality:d,isFirstChange:l})', 'if(ch()&&!lgGateRecovery.isMse(e))return a_({player:e,streamUrl:n,streamType:i,switchTrackAndQuality:d,isFirstChange:l})'],
        ['e.applyStartPosition=t=>e.currentTime(t),o&&!("number"==typeof r&&r>0)||e.deferResumeToButton||e.currentTime(r)', 'o&&!("number"==typeof r&&r>0)||e.deferResumeToButton||lgGateRecovery.scheduleSeek(e,r)'],
        ['l_=(e,t,n,r,i,a,o)=>{var s;if(ch())', 'l_=(e,t,n,r,i,a,o)=>{var s;e.applyStartPosition=t=>lgGateRecovery.scheduleSeek(e,t);if(ch()&&!lgGateRecovery.isMse(e))'],
        ['c_=({player:e,streamUrl:t,streamType:n,currentTime:r,audio:i,activeQuality:a,autoPlay:o,isFirstChange:s})=>{var l;', 'c_=({player:e,streamUrl:t,streamType:n,currentTime:r,audio:i,activeQuality:a,autoPlay:o,isFirstChange:s})=>{var l;e.applyStartPosition=t=>lgGateRecovery.scheduleSeek(e,t);'],
        ['(!s||"number"==typeof r&&r>0)&&e.currentTime(r),$y({player:e,autoPlay:o,audio:i,quality:a,isFirstChange:s})', '(!s||"number"==typeof r&&r>0)&&!e.deferResumeToButton&&lgGateRecovery.scheduleSeek(e,r),$y({player:e,autoPlay:o,audio:i,quality:a,isFirstChange:s})'],
        ['e.applyStartPosition=t=>{var n;return null===(n=e.dashPlayer)||void 0===n?void 0:n.seek(t)},l&&!(n>0)||e.deferResumeToButton||e.one("loadedmetadata",()=>{var t;return null===(t=e.dashPlayer)||void 0===t?void 0:t.seek(n)})', 'e.applyStartPosition=t=>lgGateRecovery.scheduleSeek(e,t,function(t){e.dashPlayer&&e.dashPlayer.seek(t)}),l&&!(n>0)||e.deferResumeToButton||lgGateRecovery.scheduleSeek(e,n,function(t){e.dashPlayer&&e.dashPlayer.seek(t)})'],
        ['o&&!(t>0)||e.deferResumeToButton||e.dashPlayer.seek(t),vb(e,n,r,i,a,o)', 'o&&!(t>0)||e.deferResumeToButton||lgGateRecovery.scheduleSeek(e,t,function(t){e.dashPlayer&&e.dashPlayer.seek(t)}),vb(e,n,r,i,a,o)'],
        ['RE=(e,t)=>{var n,r,i,a,o,s,l,u;if(NE(e,t))return;try{', 'RE=(e,t)=>{var n,r,i,a,o,s,l,u;if(NE(e,t))return;lgGateRecovery.reset(e,!0);try{'],
        ['PE=e=>{var t,n,r,i,a,o,s;k_(e),e.mediaGeneration=', 'PE=e=>{var t,n,r,i,a,o,s;k_(e),lgGateRecovery.reset(e,!0),e.mediaGeneration=']
        ,['this.player.phantomDismissed=!0,this.player.currentTime(n)', 'lgGateRecovery.userSeek(this.player,n),this.player.phantomDismissed=!0,this.player.currentTime(n)']
    ];
}
// Minifier aliases are reviewed for the exact current raw asset. Local argument
// names and all recovery-v4 runtime behavior remain unchanged.
function operations(profile) {
    var result = previousOperations();
    if (profile === undefined || profile === PREVIOUS) return result;
    if (profile !== PINNED) throw new Error('PLAYER_PATCH_UPSTREAM_MISMATCH');
    var aliases = { wS: 'sw', kS: 'lw', IS: 'uw', CS: 'cw', zb: 'Vb', Vb: 'Xb',
        Fb: 'Yb', MS: 'bw', my: 'yy', ny: 'my', y_: 'S_', qb: 'Kb', vy: 'Ey',
        yy: 'Ty', a_: 'd_', i_: 'c_', Lb: 'Fb', o_: 'h_', s_: 'p_', '$y': 'tb',
        l_: 'f_', c_: 'g_', vb: 'Ab', RE: 'zE', NE: 'UE', PE: 'oT', k_: 'L_' };
    result = result.map(function (pair) {
        return pair.map(function (text) {
            return text.replace(/[$A-Z_a-z][$\w]*/g, function (name) {
                return Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;
            });
        });
    });
    // The serialized recovery factory has no upstream aliases. Keep its bytes
    // exact rather than renaming even incidental names in its comments.
    result[1][1] = ',lgGateRecovery=/*' + MARKER + '*/(' + createRecovery.toString() + ')(),lw=class{';
    // Upstream inserted one earlier const and two optional popup cleanup slots.
    result[13] = result[13].map(function (text) { return text.replace(/^p=/, 'f='); });
    result[23] = result[23].map(function (text) { return text.replace('var n,r,i,a,o,s,l,u;', 'var n,r,i,a,o,s,l,u,c;'); });
    result[24] = result[24].map(function (text) { return text.replace('var t,n,r,i,a,o,s;', 'var t,n,r,i,a,o,s,l,u;'); });
    return result;
}

function patch(text) {
    if (typeof text !== 'string') throw new TypeError('PLAYER_PATCH_INPUT: expected raw upstream UTF-8 text');
    if (text.indexOf(MARKER) !== -1) throw new Error('PLAYER_PATCH_ALREADY_APPLIED: use raw upstream');
    var received = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    if (received !== PINNED && received !== PREVIOUS) throw new Error('PLAYER_PATCH_UPSTREAM_MISMATCH');
    var result = text;
    operations(received).forEach(function (operation, index) {
        if (result.split(operation[0]).length !== 2) throw new Error('PLAYER_PATCH_ANCHOR_MISMATCH: ' + index);
        result = result.replace(operation[0], operation[1]);
    });
    if (result.split(MARKER).length !== 2 || result.indexOf('this.streamKey(e.streamId,e.resolution)') !== -1) throw new Error('PLAYER_PATCH_POSTCONDITION');
    return result;
}
exports.patch = patch;
exports.version = VERSION;
exports.marker = MARKER;
exports.pinnedUpstreamSha256 = PINNED;
exports.supportedUpstreamSha256 = [PINNED, PREVIOUS];
// These pure seams let the checked-in regression fixtures exercise exactly the
// emitted recovery code without vendoring the complete third-party bundle.
exports.createRecovery = createRecovery;
exports.operations = operations;

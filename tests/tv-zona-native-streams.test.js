'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const sources = require('../tv/zona-native-streams');
const loader = require('../tv/zona-loader-native');

function row(id = 123, episode = '', type = 34) {
  return {id: 987, kinopoisk_id: id, episode_key: episode, video_source_type_id: type, download_link_key: 'opaque-source-fixture', video_content_type_id: 2};
}
function setup() {
  const calls = [], timers = new Map(); let clock = 0, next = 0;
  const api = sources.create({native: {sourceTypes: ['2', '34', '54'], request(path, params, cb) {calls.push({path, params, cb});}}, now: () => clock,
    setTimeout(fn) {const id = ++next; timers.set(id, fn); return id;}, clearTimeout(id) {timers.delete(id);}});
  return {api, calls, timers, advance(ms) {clock += ms;}};
}
function answer(call, rows) {call.cb(null, {data: rows});}
function request(api, id, episode = '') {return new Promise(resolve => api.getSources(id, episode, (error, value) => resolve({error, value})));}

test('Android source rows retain movie and episode identities and decode numeric IDs as strings', () => {
  assert.deepEqual(sources.normalizeRow(row(123, 'S02E03'), 123, 'S02E03'), {id: '987', kinopoiskId: 123, episodeKey: 'S02E03', videoSourceTypeId: 34, downloadLinkKey: 'opaque-source-fixture', videoContentTypeId: 2});
  assert.equal(sources.normalizeRow(row(), 123, '').episodeKey, '');
  assert.equal(sources.normalizeRow({...row(), info: '{"provider":"fixture"}'}, 123, '').info, '{"provider":"fixture"}');
});
test('source identity and alias conflicts are rejected before returning a playable row', () => {
  for (const value of [row(124), row(123, 'S01E02'), {...row(), kinopoiskId: 124}, {...row(), downloadLinkKey: 'other'}, {...row(), id: 9007199254740992}, {...row(), info: {bad: true}}, {...row(), video_source_type_id: -1}]) {
    assert.throws(() => sources.normalizeRow(value, 123, ''));
  }
});
test('invalid identifiers and episode keys never reach the network', async () => {
  const h = setup();
  for (const id of [0, -1, 1.5, Infinity, {}, '1;run', '00123']) assert((await request(h.api, id)).error);
  for (const ep of ['../S01E01', 'S1E1', 's01e01', 'S01E01&kpId=2', {}]) assert((await request(h.api, 123, ep)).error);
  assert.equal(h.calls.length, 0);
});
test('film, neighbouring episodes, and other films cannot share a cache or in-flight result', async () => {
  const h = setup();
  const a = request(h.api, 123, 'S01E01'), b = request(h.api, 123, 'S01E02'), c = request(h.api, 123), d = request(h.api, 124);
  assert.equal(h.calls.length, 4);
  h.calls.forEach(call => answer(call, [row(call.params.kinopoiskId, call.params.episodeKey)]));
  const result = await Promise.all([a,b,c,d]);
  assert.deepEqual(result.map(x => x.value.data[0].episodeKey), ['S01E01','S01E02','','']);
  assert.equal(h.timers.size, 0);
  const again = await request(h.api, 123, 'S01E01');
  again.value.data[0].downloadLinkKey = 'consumer mutation';
  assert.equal((await request(h.api, 123, 'S01E01')).value.data[0].downloadLinkKey, 'opaque-source-fixture');
  assert.equal(h.calls.length, 4);
});
test('duplicate requests coalesce and a callback cannot settle twice', async () => {
  const h = setup(), a = request(h.api, 123), b = request(h.api, 123);
  assert.equal(h.calls.length, 1); answer(h.calls[0], [row()]); answer(h.calls[0], [row(999)]);
  assert.equal((await a).value.data[0].kinopoiskId, 123);
  assert.equal((await b).value.data[0].kinopoiskId, 123);
  assert.equal(h.api.stats().pending, 0);
});
test('empty and failed metadata responses are retried instead of cached as missing content', async () => {
  const h = setup(), a = request(h.api, 123); answer(h.calls[0], []); assert.deepEqual((await a).value, {data: []});
  const b = request(h.api, 123); h.calls[1].cb(new Error('provider unavailable')); assert((await b).error);
  const c = request(h.api, 123); answer(h.calls[2], [row()]); assert((await c).value);
});
test('metadata deadline releases pending key and ignores a late response', async () => {
  const h = setup(), a = request(h.api, 123);
  [...h.timers.values()][0](); assert.match((await a).error.message, /deadline/);
  answer(h.calls[0], [row()]); assert.equal(h.api.stats().entries, 0);
  const b = request(h.api, 123); answer(h.calls[1], [row()]); assert((await b).value);
});
test('cache TTL and LRU have explicit finite budgets', async () => {
  const h = setup();
  for (let id = 1; id <= 20; id++) {const result = request(h.api, id); answer(h.calls.at(-1), [row(id)]); await result;}
  assert.equal(h.api.stats().entries, 16);
  h.advance(90001); const result = request(h.api, 20); answer(h.calls.at(-1), [row(20)]); await result;
  assert.equal(h.api.stats().entries, 1);
});
test('source response limits, per-key waiters, and concurrency are enforced', async () => {
  const h = setup(); const waiting = Array.from({length: 8}, () => request(h.api, 123));
  assert.match((await request(h.api, 123)).error.message, /waiter/);
  const others = [124,125,126].map(id => request(h.api,id));
  assert.match((await request(h.api,127)).error.message, /concurrency/);
  h.calls.forEach(call => answer(call, Array.from({length: 129}, () => row(call.params.kinopoiskId))));
  assert((await Promise.all(waiting.concat(others))).every(x => x.error));
});

function loaderHarness(options = {}) {
  const instances = [], requests = [], timers = new Map(), due = new Map(); let next = 0, time = 0;
  function Ep() {this.t6m_1 = {}; this.calls = []; instances.push(this);}
  Ep.prototype.getStreams = function (id,trailer,episode,cb) {this.calls.push({id,trailer,episode,cb});return 'legacy-return';};
  function XHR() {requests.push(this);}
  XHR.prototype.open = function(method,url) {this.url=url;};
  XHR.prototype.send = function() {};
  XHR.prototype.abort = function() {this.aborted=true;};
  const env = {Ep,wT:function(){},h:undefined,XMLHttpRequest:XHR,setTimeout(fn,ms){const id=++next;timers.set(id,fn);due.set(id,time+ms);return id;},clearTimeout(id){timers.delete(id);due.delete(id);}};
  vm.createContext(env); const factory = vm.runInContext('('+loader.buildFactoryReplacement({nativeTimeoutMs:options.timeout || 50})+')',env);
  const api = factory();
  function result(type=34) {return JSON.stringify({extractorType:{id:type,name:'Fixture'},videoStreams:[{source:{url:'https://media.example/fixture.m3u8'},resolution:'720p'}]});}
  function reply(xhr,body) {xhr.status=200;xhr.responseText=JSON.stringify(body);xhr.onload();}
  function source(index=0,id=123,episode='') {reply(requests.filter(x=>x.url.includes('/__zona/sources?'))[index],{data:[sources.normalizeRow(row(id,episode),id,episode)]});return instances.at(-1).calls[0];}
  function addonRequests(index=0) {return requests.filter(x=>x.url.includes('/__zona/streams?')).slice(index*3,index*3+3);}
  function addon(index=0,items=[],provider) {
    const selected=addonRequests(index).filter(x=>!provider || x.url.includes('provider='+provider+'&'));
    selected.forEach((xhr,i)=>reply(xhr,{items:i===0?items:[]}));
  }
  function tick(ms) {
    const end = time + ms;
    while (true) {
      const task = [...due].filter(([id, at]) => timers.has(id) && at <= end).sort((a, b) => a[1] - b[1])[0];
      if (!task) break;
      const [id, at] = task, fn = timers.get(id); time = at; due.delete(id); timers.delete(id); fn();
    }
    time = end;
  }
  return {api,instances,requests,timers,result,addon,addonRequests,source,reply,tick,get time(){return time;}};
}
test('loader uses source metadata for movies and episodes and sends exact episode to both endpoints', () => {
  const h=loaderHarness(), received=[]; let completed=0;
  h.api.getStreams(123,false,'S01E02',{onStreamsReceived:x=>received.push(x),onCompletion:()=>completed++});
  assert.equal(h.instances.length,1);
  assert.match(h.requests[0].url,/sources\?kpId=123&episodeKey=S01E02$/);
  assert.equal(h.addonRequests().length,3);
  assert.deepEqual(h.addonRequests().map(x=>new URL(x.url,'http://localhost').searchParams.get('provider')),['kinogo','rezka','extra']);
  h.addonRequests().forEach(xhr=>assert.match(xhr.url,/&kpId=123&episodeKey=S01E02$/));
  const call=h.source(0,123,'S01E02');
  assert.equal(h.instances[1].t6m_1.__lgGateNativeRows.data[0].episodeKey,'S01E02');
  call.cb.onStreamsReceived(h.result());call.cb.onCompletion();
  assert.equal(completed,0); h.addon(); assert.equal(completed,1); assert.equal(received.length,1); assert.equal(h.instances.length,2);
});
test('legacy provider is a fallback after both native branches have no playable stream', () => {
  const h=loaderHarness();let done=0;
  h.api.getStreams(123,false,'S01E01',{onStreamsReceived(){},onCompletion(){done++;}});
  h.source(0,123,'S01E01').cb.onCompletion();h.addon();
  assert.equal(h.instances.length,3); assert.equal(h.instances[2].t6m_1.__lgGateNativeRows,undefined);
  assert.equal(h.instances[2].calls[0].episode,'S01E01');h.instances[2].calls[0].cb.onCompletion();assert.equal(done,1);
});
test('a new episode aborts old requests and isolates every old completion and source callback', () => {
  const h=loaderHarness(),old=[],current=[];let oldDone=0,newDone=0;
  h.api.getStreams(123,false,'S01E01',{onStreamsReceived:x=>old.push(x),onCompletion:()=>oldDone++});
  const oldCallbacks=h.source(0,123,'S01E01').cb;
  h.api.getStreams(123,false,'S01E02',{onStreamsReceived:x=>current.push(x),onCompletion:()=>newDone++});
  assert(h.addonRequests(0).every(xhr=>xhr.aborted));oldCallbacks.onStreamsReceived(h.result());oldCallbacks.onCompletion();
  assert.equal(old.length,0);assert.equal(oldDone,0);
  const call=h.source(1,123,'S01E02');
  assert.notEqual(h.instances[1].t6m_1,h.instances[2].t6m_1);
  assert.equal(h.instances[1].t6m_1.__lgGateNativeRows.data[0].episodeKey,'S01E01');
  call.cb.onStreamsReceived(h.result());call.cb.onCompletion();h.addon(1);
  assert.equal(current.length,1);assert.equal(newDone,1);assert.equal(h.timers.size,0);
});
test('source identity mismatch is never passed into the compiled extractor', () => {
  const h=loaderHarness();let done=0;
  h.api.getStreams(123,false,'S01E01',{onStreamsReceived(){},onCompletion(){done++;}});
  h.reply(h.requests[0],{data:[sources.normalizeRow(row(123,'S01E02'),123,'S01E02')]});h.addon();
  assert.equal(h.instances.length,2);assert.equal(h.instances[1].t6m_1.__lgGateNativeRows,undefined);
  h.instances[1].calls[0].cb.onCompletion();assert.equal(done,1);
});
test('addon supports any provider type and successful addon prevents unnecessary fallback', () => {
  const h=loaderHarness(),received=[];let done=0;
  h.api.getStreams(123,false,null,{onStreamsReceived:x=>received.push(x),onCompletion:()=>done++});
  h.source().cb.onCompletion();h.addon(0,[JSON.parse(h.result(54))]);
  assert.equal(done,1);assert.equal(received.length,1);assert.equal(h.instances.length,2);
});
test('one fast provider delivers all its translations before slower providers or their shared deadline', () => {
  const h=loaderHarness({timeout:25000}),received=[];let done=0;
  h.api.getStreams(123,false,'S01E01',{onStreamsReceived:x=>received.push(JSON.parse(x)),onCompletion:()=>done++});
  const native=h.source(0,123,'S01E01');native.cb.onStreamsReceived(h.result());native.cb.onCompletion();
  h.tick(3000);
  const early=JSON.parse(h.result(33));
  early.videoStreams=['Voice A','Voice B','Voice C','Voice D'].map(translation=>({source:{url:'https://media.example/'+encodeURIComponent(translation)+'.m3u8'},translation,resolution:'720p'}));
  h.addon(0,[early],'extra');
  assert.equal(h.time,3000);
  assert.deepEqual(received.flatMap(item=>item.videoStreams).filter(stream=>stream.translation).map(stream=>stream.translation),['Voice A','Voice B','Voice C','Voice D']);
  assert.equal(done,0,'slow providers still pending without withholding early translations');
  const rezka=h.addonRequests().find(xhr=>xhr.url.includes('provider=rezka&'));
  rezka.status=502;rezka.responseText='provider unavailable';rezka.onload();
  assert.equal(received.length,2,'failed provider cannot discard previous native or addon streams');
  h.tick(22000);
  assert.equal(done,1);assert.equal(h.instances.length,2,'early usable streams prevent a legacy fallback');
  assert(h.addonRequests().find(xhr=>xhr.url.includes('provider=kinogo&')).aborted);
  assert.equal(h.timers.size,0);
});
test('a failed provider and a late duplicate response cannot discard or repeat another provider result', () => {
  const h=loaderHarness(),received=[];let done=0;
  h.api.getStreams(123,false,null,{onStreamsReceived:x=>received.push(JSON.parse(x)),onCompletion:()=>done++});
  h.source().cb.onCompletion();
  const rezka=h.addonRequests().find(xhr=>xhr.url.includes('provider=rezka&'));
  const lateFailure=rezka.onerror;rezka.onerror();
  h.addon(0,[JSON.parse(h.result(33))],'extra');
  assert.equal(received.length,1);assert.equal(done,0);
  lateFailure();assert.equal(received.length,1);assert.equal(done,0);
  h.addon(0,[],'kinogo');assert.equal(done,1);assert.equal(received[0].extractorType.id,33);
});
test('changing episode detaches all provider XHRs and ignores saved late provider callbacks', () => {
  const h=loaderHarness(),old=[],current=[];
  h.api.getStreams(123,false,'S01E01',{onStreamsReceived:x=>old.push(x),onCompletion(){}});
  const stale=h.addonRequests().map(xhr=>({xhr,onload:xhr.onload,onerror:xhr.onerror}));
  h.api.getStreams(123,false,'S01E02',{onStreamsReceived:x=>current.push(x),onCompletion(){}});
  stale.forEach(({xhr,onload,onerror})=>{
    assert(xhr.aborted);assert.equal(xhr.onload,null);assert.equal(xhr.onerror,null);
    xhr.status=200;xhr.responseText=JSON.stringify({items:[JSON.parse(h.result(33))]});onload();onerror();
  });
  assert.equal(old.length,0);assert.equal(current.length,0);
  h.source(1,123,'S01E02').cb.onCompletion();h.addon(1,[JSON.parse(h.result(33))],'extra');h.addon(1,[],'kinogo');h.addon(1,[],'rezka');
  assert.equal(current.length,1);assert.equal(h.timers.size,0);
});
test('native and addon watchdogs produce one bounded legacy fallback; legacy watchdog completes once', () => {
  const h=loaderHarness();let done=0;
  h.api.getStreams(123,false,null,{onStreamsReceived(){},onCompletion(){done++;}});
  [...h.timers.values()].forEach(fn=>fn());assert.equal(h.instances.length,2);
  assert(h.addonRequests().every(xhr=>xhr.aborted),'all stalled providers share the native discovery deadline');
  [...h.timers.values()].forEach(fn=>fn());assert.equal(done,1);
  h.instances[1].calls[0].cb.onCompletion();assert.equal(done,1);
});
test('trailers retain original legacy path without Android addon', () => {
  const h=loaderHarness();let done=0;
  h.api.getStreams(123,true,null,{onStreamsReceived(){},onCompletion(){done++;}});
  assert.equal(h.requests.length,0);assert.equal(h.instances.length,2);h.instances[1].calls[0].cb.onCompletion();assert.equal(done,1);
});
test('loader patch is exact and cannot silently alter an unknown loader structure', () => {
  const factory='function Xlt(t){return new Ep(t=t===h?new wT:t)}';
  const source='function j_t(t,n,i,r,u){var s=new cP(t,n,i,r,u);return s.q8_1=w,s.r8_1=null,s.w8()}';
  const patched=loader.patch(factory+source);
  assert.match(patched,/sources\?kpId=/);assert.match(patched,/episodeKey=/);assert.match(patched,/__lgGateNativeRows/);
  assert.throws(()=>loader.patch(factory));assert.throws(()=>loader.patch(factory+factory+source));
  for(const timeout of [0,-1,Infinity,'50',25001,60001])assert.throws(()=>loader.buildFactoryReplacement({nativeTimeoutMs:timeout}));
});

test('a stalled native discovery leaves time for legacy playback inside the upstream 60-second deadline', () => {
  assert.match(loader.buildFactoryReplacement(), /var timeout = 25000;/);
  const h = loaderHarness({timeout:25000}), received = []; let completed = 0;
  h.api.getStreams(123,false,'S01E01',{onStreamsReceived:x=>received.push(x),onCompletion(){completed++;}});
  h.tick(25000);
  assert.equal(h.instances.length, 2, 'one legacy fallback after native watchdogs');
  h.tick(16000);
  const fallback = h.instances[1].calls[0].cb;
  fallback.onStreamsReceived(h.result()); fallback.onCompletion();
  assert.equal(h.time, 41000); assert(h.time < 60000); assert.equal(received.length, 1); assert.equal(completed, 1);
  h.tick(30000); assert.equal(completed, 1); assert.equal(h.timers.size, 0);
});

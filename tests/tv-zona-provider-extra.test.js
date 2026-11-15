'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const extra = require('../tv/zona-provider-extra');
function row(id,episode,type=33) { return {kinopoisk_id:id,episode_key:episode,video_source_type_id:type,download_link_key:String(id)}; }
function response(value,statusCode=200) {return {statusCode,headers:{},body:Buffer.from(JSON.stringify(value))};}
function setup(rows,handlers) {
 const calls=[],timers=[];
 const provider=extra.create({native:{request(path,params,cb){calls.push({path,params});cb(null,{data:rows});}},
  http(options,cb){calls.push(options);handlers(options,cb);},random:()=>0,setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){}});
 return {provider,calls,timers};
}
test('source33 selects episode before requests and retains all voices and MP4 qualities',()=>{
 const items=[{vkId:'first',season:1,episode:1,voiceStudio:'Studio',voiceType:'Dub'},
  {vkId:'second',season:1,episode:1,voiceType:'English'}, {vkId:'wrong',season:1,episode:2}];
 const s=setup([row(123,'S01E01')],(o,cb)=>cb(null,response(o.stage.endsWith('playlist')?{isSerial:true,items}:{sources:{mpegFullHdUrl:'https://media.example/'+o.url.split('/').pop()+'/1080.mp4',mpegHighUrl:'https://media.example/'+o.url.split('/').pop()+'/720.mp4'}})));
 let result;s.provider.getStreams(123,'S01E01',(e,v)=>{assert.ifError(e);result=v;});
 assert.equal(result.items[0].extractorType.id,33);assert.equal(result.items[0].videoStreams.length,4);
 assert.deepEqual([...new Set(result.items[0].videoStreams.map(x=>x.translation))],['Studio (Dub)','English']);
 assert.equal(result.items[0].videoStreams[2].language,'en');
 assert.equal(s.calls.length,4);assert.ok(s.calls.slice(1).every(x=>/Chrome\/128/.test(x.headers['User-Agent'])));
 assert.ok(s.calls[1].url.includes('pub=1&id=123&aggr=kp'));assert.ok(s.calls.every(x=>!x.url||!x.url.endsWith('wrong')));
});
test('mismatched movie or episode identity never fetches provider',()=>{
 for(const bad of [row(124,'S01E01'),row(123,'S01E02')]) {
  const s=setup([bad],()=>assert.fail('unexpected HTTP'));let error;
  s.provider.getStreams(123,'S01E01',e=>error=e);assert.match(error.code,/IDENTITY_MISMATCH/);assert.equal(s.calls.length,1);
 }
});
test('movie and serial lists are isolated and absent33 is a clean empty result',()=>{
 assert.deepEqual(extra.selectItems({isSerial:true,items:[{vkId:'x',season:1,episode:1}]},''),[]);
 assert.deepEqual(extra.selectItems({isSerial:false,items:[{vkId:'x'}]},'S01E01'),[]);
 const s=setup([row(123,'',41)],()=>assert.fail('unexpected HTTP'));let result;
 s.provider.getStreams(123,'',(e,v)=>{assert.ifError(e);result=v;});assert.deepEqual(result.items,[]);
});
test('invalid source and media addresses are rejected and fallback HLS is exposed once',()=>{
 assert.deepEqual(extra.parseStreams({sources:{mpegHighUrl:'javascript:bad',hlsUrl:'http://[bad'}},{}),[]);
 const h=extra.parseStreams({sources:{hlsUrl:'https://media.example/master.m3u8'}},{voiceType:'Original'});
 assert.equal(h.length,1);assert.equal(h[0].resolution,'auto');assert.equal(h[0].language,'en');
 const s=setup([Object.assign(row(123,''),{download_link_key:'../elsewhere'})],()=>assert.fail('unexpected HTTP'));let error;
 s.provider.getStreams(123,'',e=>error=e);assert.match(error.code,/SOURCE_KEY_INVALID/);
});
test('deadline returns completed voices while late replies and duplicates are ignored',()=>{
 let pending,called=0,result;
 const s=setup([row(123,'')],(o,cb)=>{
  if(o.stage.endsWith('playlist'))cb(null,response({isSerial:false,items:[{vkId:'ok',voiceStudio:'First'},{vkId:'late',voiceStudio:'Second'}]}));
  else if(o.url.endsWith('ok')){cb(null,response({sources:{mpegHighUrl:'https://media.example/ok.mp4'}}));cb(null,response({sources:{mpegHighUrl:'https://media.example/duplicate.mp4'}}));}
  else pending=cb;
 });
 s.provider.getStreams(123,'',(e,v)=>{assert.ifError(e);result=v;called++;});s.timers[0]();
 assert.equal(result.items[0].videoStreams.length,1);pending(null,response({sources:{mpegHighUrl:'https://media.example/late.mp4'}}));assert.equal(called,1);
});
test('unavailable API retries a bounded number and never exposes opaque failure text',()=>{
 const s=setup([row(123,'')],(o,cb)=>cb(new Error('https://secret.example/token')));let error;
 s.provider.getStreams(123,'',e=>error=e);assert.equal(s.calls.length,3);assert.equal(error.message,'CDNVIDEOHUB_PLAYLIST_UNAVAILABLE');
});
test('episode requests use independent source identity and invalid inputs stop early',()=>{
 const s=setup([],()=>assert.fail('unexpected HTTP'));let n=0;
 for(const ep of ['S01E01','S01E02',''])s.provider.getStreams(123,ep,(e,v)=>{assert.ifError(e);n++;});
 assert.equal(n,3);assert.deepEqual(s.calls.map(x=>x.params.episodeKey),['S01E01','S01E02','']);
 s.provider.getStreams(123,'wrong',e=>assert.match(e.code,/IDENTITY_INVALID/));assert.equal(s.calls.length,3);
});

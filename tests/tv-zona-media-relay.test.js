'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const relayModule = require('../tv/zona-media-relay');
async function fixture(t, handler, options = {}) {
  const seen = [], sockets = [];
  const upstream = http.createServer((req,res) => {seen.push({url:req.url,agent:req.headers['user-agent'],range:req.headers.range});handler(req,res);});
  await new Promise(r => upstream.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:'+upstream.address().port;
  let relay;
  const local = http.createServer((req,res) => {if(!relay.handle(req,res)){res.writeHead(404);res.end();}});
  await new Promise(r => local.listen(0,'127.0.0.1',r));
  const origin = 'http://127.0.0.1:'+local.address().port;
  relay = relayModule.create({origin,allowUrl:a=>new URL(a).origin===base,...options});
  for(const server of [upstream,local])server.on('connection',s=>{sockets.push(s);});
  t.after(()=>{sockets.forEach(s=>s.destroy());upstream.close();local.close();});
  return {relay,base,origin,seen,source:p=>relay.register({url:base+p,headers:{'User-Agent':'AndroidFixture'}}).url};
}
test('MP4 forwards required headers and streams real byte ranges with status and metadata',async t=>{
  const f=await fixture(t,(req,res)=>{assert.equal(req.headers['user-agent'],'AndroidFixture');res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes 10-13/20','Accept-Ranges':'bytes','Content-Length':4});res.end('abcd');});
  const response=await fetch(f.source('/movie.mp4'),{headers:{Range:'bytes=10-13'}});
  assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 10-13/20');assert.equal(response.headers.get('accept-ranges'),'bytes');assert.equal(await response.text(),'abcd');assert.equal(f.seen[0].range,'bytes=10-13');
  assert.equal(f.relay.stats().active,0);
});
test('HLS rewrites variants, relative segments, maps and encryption-key URI attributes with inherited headers',async t=>{
  const f=await fixture(t,(req,res)=>{res.setHeader('Content-Type','application/x-mpegURL');
    if(req.url==='/master.m3u8')return res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo/list.m3u8\n');
    if(req.url==='/video/list.m3u8')return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n');
    res.setHeader('Content-Type','application/octet-stream');res.end('media');
  });
  const master=await(await fetch(f.source('/master.m3u8'))).text();
  assert(!master.includes('video/list.m3u8'));assert(!master.includes(f.base));
  const variant=master.trim().split('\n').at(-1);const media=await(await fetch(variant)).text();
  const urls=[...media.matchAll(/URI="([^"]+)"/g)].map(m=>m[1]);urls.push(media.split('\n').find(x=>x.startsWith('http:')));
  for(const u of urls){assert(u.startsWith(f.origin+'/__zona/media/'));assert.equal(await(await fetch(u)).text(),'media');}
  assert(f.seen.every(x=>x.agent==='AndroidFixture'));assert(f.seen.some(x=>x.url==='/key'));assert(f.seen.some(x=>x.url==='/video/init.mp4'));assert(f.seen.some(x=>x.url==='/video/seg.ts'));
});
test('unknown tokens, method misuse, untrusted registration and redirects never fetch arbitrary addresses',async t=>{
  const f=await fixture(t,(req,res)=>{res.writeHead(302,{Location:'http://127.0.0.1:1/private'});res.end();});
  assert.throws(()=>f.relay.register({url:'http://127.0.0.1:1/private'}),/Untrusted/);
  assert.equal((await fetch(f.origin+'/__zona/media/not-a-token?url=http://evil.test')).status,404);
  assert.equal((await fetch(f.source('/redirect'),{method:'POST'})).status,405);
  assert.equal((await fetch(f.source('/redirect'))).status,502);assert.equal(f.seen.length,1);
  const production=relayModule.create({allowedHosts:[/(^|\.)vkuser\.net$/]});
  for(const address of ['https://127.0.0.1/media','http://ok.vkuser.net/media','https://user:pass@ok.vkuser.net/media','https://evilvkuser.net/media'])assert.throws(()=>production.register({url:address}));
  assert(production.register({url:'https://ok.vkuser.net/media'}).url.includes('/__zona/media/'));
});
test('expired idle groups are rejected, active VOD groups keep future segment capabilities alive and registry is bounded',async t=>{
  let now=0;const f=await fixture(t,(req,res)=>{res.writeHead(200,{'Content-Type':'application/x-mpegURL'});res.end('#EXTM3U\n#EXTINF:6,\none.ts\n#EXTINF:6,\ntwo.ts\n');},{now:()=>now,ttlMs:1000,maximumEntries:5});
  const master=f.source('/master.m3u8'),body=await(await fetch(master)).text(),segments=body.split('\n').filter(x=>x.startsWith('http'));
  now=900;await fetch(segments[0]);now=1800;assert.equal((await fetch(segments[1])).status,200);
  now=3000;assert.equal((await fetch(master)).status,404);
  for(let i=0;i<12;i++)f.source('/'+i);assert(f.relay.stats().entries<=5);assert(f.relay.stats().bytes<=f.relay.stats().maximumBytes);
});
test('client disconnect aborts upstream and inactivity deadline releases relay slots',async t=>{
  let closed=false;const f=await fixture(t,(req,res)=>{req.on('close',()=>{closed=true;});res.writeHead(200,{'Content-Type':'video/mp4'});res.write('first');},{inactivityMs:70,headerTimeoutMs:100,deadlineMs:500});
  const address=f.source('/movie');
  await new Promise(resolve=>{http.get(address,res=>{res.once('data',()=>{res.destroy();resolve();});});});
  await new Promise(r=>setTimeout(r,30));assert(closed);assert.equal(f.relay.stats().active,0);
  const response=await fetch(f.source('/stalled'));await assert.rejects(response.arrayBuffer());assert.equal(f.relay.stats().active,0);
});
test('large MP4 writes encounter backpressure instead of being buffered as a complete body',async t=>{
  let blocked=0;const f=await fixture(t,(req,res)=>{res.writeHead(200,{'Content-Type':'video/mp4'});let left=64;function write(){while(left--){if(!res.write(Buffer.alloc(65536))){blocked++;res.once('drain',write);return;}}res.end();}write();});
  const response=await fetch(f.source('/large.mp4'));assert.equal((await response.arrayBuffer()).byteLength,64*65536);assert(blocked>0);assert.equal(f.relay.stats().active,0);
});
test('an interrupted upstream body closes the downstream instead of hanging a player request',async t=>{
  const f=await fixture(t,(req,res)=>{res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':100000});res.write('partial');setTimeout(()=>res.destroy(),20);});
  const response=await fetch(f.source('/interrupted.mp4'));await assert.rejects(response.arrayBuffer());assert.equal(f.relay.stats().active,0);
});
test('an oversized HLS capability set fails atomically instead of evicting earlier segment links',async t=>{
  let oversized=true;
  const f=await fixture(t,(req,res)=>{
    if(req.url==='/master.m3u8'){
      res.writeHead(200,{'Content-Type':'application/x-mpegURL'});
      return res.end('#EXTM3U\n'+(oversized?'one.ts\ntwo.ts\nthree.ts\nfour.ts\n':'one.ts\ntwo.ts\n'));
    }
    res.end('segment');
  },{maximumEntries:3});
  const master=f.source('/master.m3u8'),before=f.relay.stats();
  const rejected=await fetch(master);assert.equal(rejected.status,502);assert.equal(await rejected.text(),'');
  assert.equal(f.relay.stats().entries,before.entries);assert.equal(f.relay.stats().bytes,before.bytes);assert.equal(f.relay.stats().active,0);
  // The existing parent capability still works, and a fitting playlist returns
  // only capabilities that can all be fetched without re-registering anything.
  oversized=false;const accepted=await fetch(master);assert.equal(accepted.status,200);
  const children=(await accepted.text()).split('\n').filter(x=>x.startsWith('http:'));
  assert.equal(children.length,2);
  for(const child of children)assert.equal(await(await fetch(child)).text(),'segment');
  assert.equal(f.relay.stats().entries,3);assert(f.relay.stats().bytes<=f.relay.stats().maximumBytes);
});

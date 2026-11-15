'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),addon=require('../tv/zona-provider-addon');
const value=id=>({items:[{extractorType:{id,name:'fixture'},videoStreams:[{source:{url:'https://media.example/stream'},translation:'voice'}]}]});
test('provider faults do not discard other translations; duplicates settle once',()=>{
 const callbacks=[],providers=[1,2,3].map(name=>({name,getStreams(id,episode,cb){callbacks.push(cb);}}));
 let result,called=0;const a=addon.create({providers});a.getStreams(123,'S02E01',(e,v)=>{assert.ifError(e);result=v;called++;});
 callbacks[0](new Error('down'));callbacks[1](null,value(2));callbacks[1](null,value(99));callbacks[2](null,value(3));
 assert.equal(called,1);assert.deepEqual(result.items.map(x=>x.extractorType.id),[2,3]);assert.equal(result.report.episodeKey,'S02E01');
});
test('provider deadline returns partial results and isolates late callbacks',()=>{
 let expire,result;const callbacks=[];const a=addon.create({providers:[1,2].map(name=>({name,getStreams(i,e,cb){callbacks.push(cb);}})),setTimeout(fn){expire=fn;return 1;},clearTimeout(){}});
 a.getStreams(123,'S01E01',(e,v)=>{result=v;});callbacks[0](null,value(1));expire();callbacks[1](null,value(2));
 assert.equal(result.items.length,1);assert.equal(result.report.expired,true);assert.equal(a.stats().pending,0);
});
test('same episode coalesces while other episodes and movies stay separate',()=>{
 const calls=[],a=addon.create({providers:[{getStreams(id,ep,cb){calls.push({id,ep,cb});}}]});let n=0;
 for(const ep of ['S01E01','S01E01','S01E02',''])a.getStreams(123,ep,()=>n++);
 assert.equal(calls.length,3);calls.forEach(x=>x.cb(null,value(2)));assert.equal(n,4);
});

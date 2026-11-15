'use strict';
function Cache(maxEntries, maxBytes, ttlMs, maxItemBytes) { this.maxEntries=maxEntries; this.maxBytes=maxBytes; this.ttlMs=ttlMs; this.maxItemBytes=maxItemBytes; this.entries=Object.create(null); this.count=0; this.bytes=0; this.tick=0; }
Cache.prototype.remove=function(key){var item=this.entries[key];if(!item)return;this.bytes-=item.bytes;this.count--;delete this.entries[key];};
Cache.prototype.sweep=function(){var now=Date.now(),self=this;Object.keys(this.entries).forEach(function(key){if(now-self.entries[key].createdAt>=self.ttlMs)self.remove(key);});};
Cache.prototype.get=function(key){this.sweep();var item=this.entries[key];if(!item)return null;item.used=++this.tick;return item.value;};
Cache.prototype.set=function(key,value,bytes){this.sweep();bytes=bytes||0;if(bytes>this.maxItemBytes||bytes>this.maxBytes)return false;this.remove(key);while(this.count>=this.maxEntries||this.bytes+bytes>this.maxBytes){var keys=Object.keys(this.entries),oldest=keys[0],self=this;keys.forEach(function(k){if(self.entries[k].used<self.entries[oldest].used)oldest=k;});this.remove(oldest);}this.entries[key]={value:value,bytes:bytes,createdAt:Date.now(),used:++this.tick};this.count++;this.bytes+=bytes;return true;};
Cache.prototype.stats=function(){this.sweep();return{entries:this.count,bytes:this.bytes,maxEntries:this.maxEntries,maxBytes:this.maxBytes};};
module.exports=Cache;

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const catalog = require('../tv/zona-native-catalog');

function movie(id = '100', extra = {}) {
  return {_type: 'Movie', id, name: {ru: 'Фильм', original: 'A movie'}, year: 2020, minAge: 16,
    ratings: {zona: {value: 7.2}, kinopoisk: {value: 7.4}}, ...extra};
}
function series(id = '200', extra = {}) {
  return {...movie(id), _type: 'Serial', name: {ru: 'Сериал', original: 'A series'}, year: 2010,
    episodes: ['S02E02', 'S01E02', 'S01E01', 'S02E01', 'S01E01'], ...extra};
}
function harness(reply, options) {
  const calls = [];
  const native = {sourceTypes: ['2', '34', '54'], request(route, params, cb) {
    calls.push({route, params}); setImmediate(() => {try {reply(route, params, cb);} catch (e) {cb(e);}});
  }};
  return {calls, adapter: catalog.create({native, ...options})};
}
function handle(adapter, pathname, query = {}) {
  return new Promise((resolve, reject) => {
    const handled = adapter.handle(pathname, query, (error, value) => error ? reject(error) : resolve(value));
    if (!handled) resolve(null);
  });
}

test('Android search preserves film/serial identity, both namesakes, original titles and portal cards', async () => {
  const h = harness((route, p, cb) => {
    assert.equal(route, '/search'); assert.equal(p.query, 'Название'); assert.equal(p.hideUnavailable, true);
    assert.deepEqual(p.movieSourceTypes, ['2', '34', '54']);
    cb(null, {data: [series('200'), series('201', {year: 2021}), movie('100'), {_type: 'Person', id: '9'}, movie('../escape')]});
  });
  const value = await handle(h.adapter, '/search', {query: '  Название  '});
  assert.deepEqual(value.data.map(x => [x.slug, x.year, x.type]), [
    ['android-series-200', 2010, 'series'], ['android-series-201', 2021, 'series'], ['android-movie-100', 2020, 'movie']]);
  assert.equal(value.data[0].kp_id, 200); assert.equal(value.data[0].title_original, 'A series');
  assert.equal(value.data[2].cover_url, 'https://img1.zonapic.com/images/film_240/0/100.jpg');
  assert.equal(value.data[2].rating, 7.2);
});

test('Suggestions use the same native catalog and a bounded result count', async () => {
  const h = harness((route, p, cb) => cb(null, {data: [movie('1'), movie('2'), movie('3')]}));
  assert.equal((await handle(h.adapter, '/suggest', {query: 'пример', limit: '2'})).data.length, 2);
  await assert.rejects(handle(h.adapter, '/suggest', {query: 'пример', limit: '500'}), /suggestion limit/);
  assert.equal(h.calls.length, 1);
});

test('Search rejects malformed input, preserves native failures and does not cache failed responses', async () => {
  let n = 0;
  const h = harness((route, p, cb) => {if (++n === 1) cb(new Error('Native timeout')); else cb(null, {data: [movie()]});});
  assert.deepEqual(await handle(h.adapter, '/search', {query: '  '}), {data: []});
  await assert.rejects(handle(h.adapter, '/search', {query: ['a', 'b']}), /Invalid search/);
  await assert.rejects(handle(h.adapter, '/search', {query: 'a'.repeat(201)}), /Invalid search/);
  await assert.rejects(handle(h.adapter, '/search', {query: 'фильм'}), /Native timeout/);
  assert.equal((await handle(h.adapter, '/search', {query: 'фильм'})).data[0].kp_id, 100);
  assert.equal(h.calls.length, 2);
});

test('Series metadata sorts seasons and episodes, matches metadata by both numbers and keeps exact keys', async () => {
  const h = harness((route, params, cb) => {
    if (route === '/getMovieOrSerialById') {
      assert.deepEqual(params, {id: '200', occupancy: 'Full', installerPackage: ''});
      return cb(null, {data: [series('200', {backdropId: 901, yearEnd: 2012, genreIds: ['8'], countryIds: ['1'],
        actors: [{id: '7', name: {ru: 'Актёр'}}], description: {ru: 'Описание'}})]});
    }
    assert.equal(route, '/getEpisodes'); assert.equal(params.entityId, 200);
    cb(null, {data: [
      {num: {season: 2, episode: 1}, title: {original: 'Second season'}, releaseDate: 1577836800000},
      {num: {season: 1, episode: 1}, title: {ru: 'Первая'}},
      {num: {season: 2, episode: 2}, title: {ru: 'Вторая'}},
      {num: {season: 2, episode: 99}, title: {ru: 'Чужой эпизод'}}]});
  });
  const value = (await handle(h.adapter, '/api/series/android-series-200', {season: '2'})).data;
  assert.equal(value.description, 'Описание'); assert.equal(value.kp_id, 200);
  assert.deepEqual(value.seasons.map(x => [x.part, x.episode_count]), [[1, 2], [2, 2]]);
  assert.deepEqual(value.episodes.map(x => [x.part, x.title, x.meta.episodeKey]), [[1, 'Second season', 'S02E01'], [2, 'Вторая', 'S02E02']]);
  assert.equal(value.episodes[0].release_date, '2020-01-01');
  assert.equal(value.meta.tags.find(x => x.type === 'genre').title, 'Драма');
  assert.equal(value.meta.tags.find(x => x.type === 'country').title, 'США');
  assert.equal(value.meta.actors[0].name, 'Актёр');
  assert.match(value.backdrop_url, /backdrop_1920\/0\/901\.jpg$/);
  const next = (await handle(h.adapter, '/api/series/android-series-200', {season: '1'})).data;
  assert.deepEqual(next.episodes.map(x => x.meta.episodeKey), ['S01E01', 'S01E02']);
  assert.equal(h.calls.length, 2, 'entity + episode metadata are shared across seasons');
  await assert.rejects(handle(h.adapter, '/api/series/android-series-200', {season: '3'}), e => e.statusCode === 404);
});

test('A movie opens without episode requests and refuses mismatched returned identities', async () => {
  const h = harness((route, params, cb) => cb(null, {data: [movie(params.id === '101' ? '999' : params.id)]}));
  const value = (await handle(h.adapter, '/api/movies/android-movie-100')).data;
  assert.equal(value.kp_id, 100); assert.equal(value.type, 'movie');
  assert.equal(value.seasons, undefined); assert.equal(h.calls.length, 1);
  await assert.rejects(handle(h.adapter, '/api/movies/android-movie-101'), /identity mismatch/);
  await assert.rejects(handle(h.adapter, '/api/movies/android-series-200'), /Invalid native content route/);
});

test('Native runtime is in minutes and related cards preserve their own content kind and identifier', async () => {
  const h = harness((route, params, cb) => {
    if (params.id === '100') return cb(null, {data: [movie('100', {runtime: 136, rels: [{rmi: 200}, {rmi: 201}, {rmi: 100}, {rmi: 200}]})]});
    if (params.id === '200') return cb(null, {data: [series('200')]});
    cb(new Error('Optional recommendation unavailable'));
  });
  const value = (await handle(h.adapter, '/api/movies/android-movie-100')).data;
  assert.equal(value.duration, 136);
  assert.deepEqual(value.meta.relations.map(x => [x.slug, x.type]), [['android-series-200', 'series']]);
  assert.equal(value.meta.relations_status, 'unavailable');
  assert.equal(h.calls.length, 3);
});

test('Native lists page by IDs, keep ordering, translate filters, and expose real pagination', async () => {
  const h = harness((route, p, cb) => {
    if (route === '/getSerialIds') {
      assert.equal(p.page.offset, 20); assert.equal(p.page.limit, 20);
      assert.equal(p.filter.genres, '8'); assert.equal(p.filter.countries, '1');
      assert.equal(p.filter.yearFrom, 2000); assert.equal(p.filter.yearTo, 2009); assert.equal(p.filter.ratingFrom, 7);
      assert.equal(p.filter.sortBy, 'rating');
      return cb(null, {data: ['200', '201'], total: 41});
    }
    assert.equal(p.occupancy, 'Lite'); cb(null, {data: [series(p.id)]});
  });
  const value = await handle(h.adapter, '/api/series/filter', {page: '2', genre: 'drama', country: 'android:1', year: '2000s', rating: '7', sort: 'rating'});
  assert.deepEqual(value.data.map(x => x.kp_id), [200, 201]);
  assert.equal(value.meta.total, 41); assert.equal(value.links.next, '/api/series/filter?page=3');
  await assert.rejects(handle(h.adapter, '/api/series/filter', {genre: 'unknown'}), /Unsupported native/);
  await assert.rejects(handle(h.adapter, '/api/series/filter', {page: '-1'}), /Invalid native page/);
});

test('Homepage collections 2/3/4 use Android lists and the portal collection shape', async () => {
  const h = harness((route, p, cb) => {
    if (route === '/getMovieIds' || route === '/getSerialIds') return cb(null, {data: [route === '/getMovieIds' ? '100' : '200'], total: 1});
    cb(null, {data: [p.id === '100' ? movie() : series()]});
  });
  const values = await Promise.all(['2', '3', '4'].map(x => handle(h.adapter, '/api/collection/' + x)));
  assert.deepEqual(values.map(x => x.data.entities[0].type), ['series', 'movie', 'series']);
  assert.equal(values[0].data.title, 'Популярные сериалы');
  const lists = h.calls.filter(x => /Ids$/.test(x.route));
  assert.equal(lists.find(x => x.route === '/getMovieIds').params.filter.sortBy, 'release_date');
  assert.equal(lists.filter(x => x.route === '/getSerialIds').length, 2);
});

test('Dictionary labels come from Android resources and native filter values round-trip', async () => {
  const h = harness((route, params, cb) => {
    assert.equal(params.filter.genres, 'tv'); cb(null, {data: [], total: 0});
  });
  const refs = await handle(h.adapter, '/api/assist/references');
  assert.equal(refs.genres.find(x => x.value === 'android:8').title, 'Драма');
  assert.equal(refs.countries.find(x => x.value === 'android:1').title, 'США');
  assert.ok(refs.genres.length > 25); assert.ok(refs.countries.length > 200);
  assert.deepEqual((await handle(h.adapter, '/api/movies/filter', {genre: 'android:tv'})).data, []);
});

test('Pending lists respect metadata concurrency and matching requests coalesce', async () => {
  let running = 0, maximum = 0;
  const callbacks = [];
  const h = harness((route, params, cb) => {
    if (route === '/getMovieIds') return cb(null, {data: Array.from({length: 20}, (_, i) => String(i + 1)), total: 20});
    running++; maximum = Math.max(maximum, running);
    callbacks.push(() => {running--; cb(null, {data: [movie(params.id)]});});
  }, {concurrency: 3});
  const a = handle(h.adapter, '/api/movies'), b = handle(h.adapter, '/api/movies');
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  while (callbacks.length || h.adapter.stats().active || h.adapter.stats().queued) {
    while (callbacks.length) callbacks.shift()();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal((await a).data.length, 20); assert.equal((await b).data.length, 20);
  assert.ok(maximum <= 3); assert.equal(h.calls.filter(x => x.route === '/getMovieIds').length, 1);
  assert.equal(h.calls.length, 21); assert.equal(h.adapter.stats().active, 0);
});

test('Cache size and TTL are bounded across distinct searches', async () => {
  let now = 100000;
  const h = harness((route, p, cb) => cb(null, {data: [movie()]}), {now: () => now});
  for (let i = 0; i < 132; i++) await handle(h.adapter, '/search', {query: 'Фильм ' + i});
  assert.ok(h.adapter.stats().entries <= 128); assert.ok(h.adapter.stats().bytes <= 2 * 1024 * 1024);
  const n = h.calls.length; await handle(h.adapter, '/search', {query: 'Фильм 131'}); assert.equal(h.calls.length, n);
  now += 30001; await handle(h.adapter, '/search', {query: 'Фильм 131'}); assert.equal(h.calls.length, n + 1);
});

test('Legacy saved URLs and unsupported editorial filters remain explicit fallback routes', async () => {
  const h = harness(() => assert.fail('Unexpected native request'));
  for (const [route, query] of [['/api/series/old-title', {}], ['/api/movies/old-title', {}], ['/api/movies/filter', {studio: 'netflix'}], ['/api/series/filter', {sort: 'last'}], ['/api/profile', {}]]) {
    assert.equal(await handle(h.adapter, route, query), null);
  }
  const value = {data: {entities: [{slug: 'old', title: 'Название', type: 'series', kp_id: 200}, {slug: 'unknown', title: 'Без ID'}]}};
  const converted = catalog.rewriteLegacy(value);
  assert.equal(converted.data.entities[0].slug, 'android-series-200'); assert.equal(value.data.entities[0].slug, 'old');
  assert.equal(converted.data.entities[1].slug, 'unknown');
});

test('Series with later seasons or no published episodes keep their valid cards', async () => {
  const h = harness((route, params, cb) => {
    if (route === '/getMovieOrSerialById') return cb(null, {data: [series(params.id, {episodes: params.id === '200' ? ['S02E03'] : []})]});
    assert.equal(route, '/getEpisodes'); cb(null, {data: [{num: {season: 2, episode: 3}, title: {ru: 'Поздний сезон'}}]});
  });
  const later = await handle(h.adapter, '/api/series/android-series-200');
  assert.equal(later.data.title, 'Сериал'); assert.deepEqual(later.data.seasons.map(x => x.part), [2]);
  assert.equal(later.data.episodes[0].meta.episodeKey, 'S02E03');
  await assert.rejects(handle(h.adapter, '/api/series/android-series-200', {season: '1'}), /season is unavailable/);
  const upcoming = await handle(h.adapter, '/api/series/android-series-201');
  assert.deepEqual(upcoming.data.seasons, []); assert.deepEqual(upcoming.data.episodes, []);
  assert.equal(h.calls.filter(x => x.route === '/getEpisodes').length, 1);
  await assert.rejects(handle(h.adapter, '/api/series/android-series-201', {season: '1'}), /season is unavailable/);
});

test('Slow optional recommendations cannot hold a valid card past the portal deadline', async () => {
  let expire, held, delivered = 0;
  const h = harness((route, params, cb) => {
    if (params.id === '100') return cb(null, {data: [movie('100', {rels: [{rmi: 101}]})]});
    held = cb;
  }, {setTimeout(fn, ms) {assert(ms < 10000); expire = fn; return 1;}, clearTimeout() {}});
  const result = new Promise((resolve, reject) => h.adapter.handle('/api/movies/android-movie-100', {}, (error, value) => {
    delivered++; if (error) reject(error); else resolve(value);
  }));
  while (!held) await new Promise(resolve => setImmediate(resolve));
  expire();
  const value = await result;
  assert.equal(value.data.kp_id, 100); assert.deepEqual(value.data.meta.relations, []);
  assert.equal(value.data.meta.relations_status, 'unavailable');
  held(null, {data: [movie('101')]});
  assert.equal(delivered, 1); assert.deepEqual(value.data.meta.relations, []);
  assert.equal(h.adapter.stats().active, 0);
});

const node012 = process.env.ZONA_NODE012 || path.resolve(__dirname, '../.build/zona-source-lab/autonomy/runtime/node-v0.12.2-x64.exe');
test('Actual Node 0.12 executes catalog search and episode mapping', {skip: !require('node:fs').existsSync(node012)}, () => {
  const script = `var assert=require('assert'),c=require(process.argv[1]);var n={sourceTypes:['2'],request:function(p,q,cb){if(p==='/search')return cb(null,{data:[{_type:'Serial',id:'123',name:{ru:'Series'},year:2000}]});if(p==='/getMovieOrSerialById')return cb(null,{data:[{_type:'Serial',id:'123',name:{ru:'Series'},episodes:['S02E01','S01E02','S01E01']}]});cb(null,{data:[{num:{season:1,episode:2},title:{ru:'Second'}}]});}};var a=c.create({native:n}),checks=0;a.handle('/search',{query:'Series'},function(e,v){assert.ifError(e);assert.equal(v.data[0].slug,'android-series-123');checks++;});a.handle('/api/series/android-series-123',{season:'1'},function(e,v){assert.ifError(e);assert.deepEqual(v.data.episodes.map(function(x){return x.meta.episodeKey;}),['S01E01','S01E02']);checks++;});assert.equal(checks,2);console.log('Node0.12 catalog contract passed');`;
  const result = spawnSync(node012, ['-e', script, path.resolve(__dirname, '../tv/zona-native-catalog.js')], {encoding: 'utf8', windowsHide: true, timeout: 10000});
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /catalog contract passed/);
});

'use strict';
var portable = require('./portable');
var request = require('./request');
var host = 'https://apirn1.mzona.net';
var ua = 'Zona/3.0.77 (Android unknown)';
var clock = null;
var types = [];
for (var i = 1; i <= 60; i++) if (i !== 4 && i !== 11) types.push(String(i));

function alignedTime(callback) {
  if (clock && Date.now() - clock.saved < 300000) return callback(null, Date.now() + clock.offset);
  request({ url: host + '/getTime', method: 'HEAD', headers: { 'User-Agent': ua }, stage: 'native-clock' }, function (error, response) {
    if (error) return callback(error);
    var time = Date.parse(response.headers.date);
    if (!isFinite(time)) return callback(new Error('Native clock Date missing'));
    clock = { saved: Date.now(), offset: time - Date.now() };
    callback(null, Date.now() + clock.offset);
  });
}

function fetchSources(kpId, callback) {
  if (!(kpId > 0 && kpId < 1000000000000 && kpId % 1 === 0)) return callback(new Error('Invalid film identifier'));
  alignedTime(function (error, now) {
    if (error) return callback(error);
    var generated;
    try { generated = portable.makeTransport(now, ua); } catch (err) { return callback(err); }
    var params = portable.encodeParams({ kinopoiskId: kpId, episodeKey: '', movieSourceTypes: types });
    request({ url: host + '/getVideoSources?params=' + encodeURIComponent(params) + '&client_time=' + encodeURIComponent(generated.client_time), headers: { 'User-Agent': ua, Cookie: generated.cookie, 'Content-Type': 'application/json', Accept: 'application/json' }, stage: 'native-sources' }, function (error, response) {
      if (error) return callback(error);
      try {
        var raw = JSON.parse(response.body.toString('utf8'));
        if (response.statusCode !== 200 || !raw || !Array.isArray(raw.data) || !raw.data.length) throw new Error('Native source list unavailable');
        if (!raw.data.every(function (row) { return row.kinopoisk_id === kpId; })) throw new Error('Native movie identity mismatch');
        callback(null, { raw: raw, summary: { kinopoiskId: kpId, sourcesCount: raw.data.length, identityMatches: true, anonymous: true, sourceTypeIds: raw.data.map(function (row) { return row.video_source_type_id; }) } });
      } catch (err) { callback(err); }
    });
  });
}

function fetchConfig(callback) {
  request({ url: 'https://vsr01.zonasearch.com/static/cfg/ext54.cfg', headers: { 'Accept-Encoding': 'identity' }, maxBytes: 1024 * 1024, stage: 'native-config' }, function (error, response) {
    if (error) return callback(error);
    if (response.statusCode !== 200) return callback(new Error('Native config unavailable'));
    try { callback(null, portable.decodeConfig(response.body, response.headers['content-encoding'])); } catch (err) { callback(err); }
  });
}
exports.fetchSources = fetchSources;
exports.fetchConfig = fetchConfig;

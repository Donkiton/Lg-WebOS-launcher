(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LauncherMSXCatalog = factory();
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var maxUrlLength = 4096;
  var maxSettingsLength = 131072;
  var maxPayloadLength = 1048576;
  var maxEntries = 1000;
  var maxApps = 200;
  var own = Object.prototype.hasOwnProperty;
  var settingKeys = {
    start: 'start', server: 'server', server_secure: 'serverSecure',
    start_name: 'name', start_version: 'version'
  };

  function settingsError() {
    var error = new Error('Некорректный ответ настроек Media Station X.');
    error.code = 'MSX_INVALID_SETTINGS';
    return error;
  }

  function hasValidUnicode(value) {
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code >= 55296 && code <= 56319) {
        var next = value.charCodeAt(++i);
        if (!(next >= 56320 && next <= 57343)) return false;
      } else if (code >= 56320 && code <= 57343) return false;
    }
    return true;
  }

  function decodeHexUTF16LE(hex) {
    if (hex.length > 32768 || hex.length % 4 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw settingsError();
    var result = '';
    for (var i = 0; i < hex.length; i += 4) {
      var unit = parseInt(hex.substr(i, 2), 16) + parseInt(hex.substr(i + 2, 2), 16) * 256;
      result += String.fromCharCode(unit);
    }
    if (!hasValidUnicode(result) || /[\u0000-\u001f\u007f-\u009f]/.test(result)) throw settingsError();
    return result;
  }

  // Only the explicitly selected SQLite key/value rows are accepted. No JSON or code is evaluated.
  function parseSettings(sqliteOutput) {
    if (typeof sqliteOutput !== 'string' || sqliteOutput.length > maxSettingsLength) throw settingsError();
    var result = { start: '', server: '', serverSecure: false, name: '', version: '' };
    var seen = Object.create(null);
    var lines = sqliteOutput.split(/\r?\n/);
    if (lines.length > 32) throw settingsError();
    lines.forEach(function (line) {
      if (!line) return;
      var separator = line.indexOf('|');
      var key = separator < 0 ? line : line.substr(0, separator);
      if (!own.call(settingKeys, key)) return;
      if (separator < 0 || own.call(seen, key)) throw settingsError();
      seen[key] = true;
      var value = decodeHexUTF16LE(line.substr(separator + 1));
      if (key === 'server_secure') {
        if (!/^(?:true|false|1|0)?$/.test(value)) throw settingsError();
        result.serverSecure = value === 'true' || value === '1';
      } else {
        var limit = key === 'start_name' ? 512 : key === 'start_version' ? 128 : 8192;
        if (value.length > limit) throw settingsError();
        result[settingKeys[key]] = value;
      }
    });
    return result;
  }

  function isHttpUrl(value) {
    if (typeof value !== 'string' || !value || value.length > maxUrlLength || !hasValidUnicode(value) || /[\s\\<>\u0000-\u0020\u007f-\u009f]/.test(value)) return false;
    var match = /^https?:\/\/([^/?#]+)(?:[/?#].*)?$/i.exec(value);
    if (!match || match[1].indexOf('@') >= 0) return false;
    var authority = match[1];
    var hostMatch;
    if (authority.charAt(0) === '[') hostMatch = /^(\[[0-9a-f:.]+\])(?::([0-9]{1,5}))?$/i.exec(authority);
    else hostMatch = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(authority);
    if (!hostMatch || (hostMatch[2] && (+hostMatch[2] < 1 || +hostMatch[2] > 65535))) return false;
    if (authority.charAt(0) !== '[') {
      if (hostMatch[1].length > 253) return false;
      var labels = hostMatch[1].replace(/\.$/, '').split('.');
      for (var i = 0; i < labels.length; i++) {
        if (!labels[i] || labels[i].length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(labels[i])) return false;
      }
    }
    return true;
  }

  function getContentUrl(start) {
    if (typeof start !== 'string' || start.length > 8192) return null;
    var match = /^(?:content|menu|redirect):(.+)$/.exec(start);
    if (!match) return null;
    var url = match[1].split('>')[0];
    return isHttpUrl(url) ? url : null;
  }

  function cleanName(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    // MSX labels support inline expressions; show their human-readable text without styling.
    return value.replace(/\{[^{}]*\}/g, '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/^\s+|\s+$/g, '').substr(0, 512);
  }

  function normalizeAction(action) {
    if (typeof action !== 'string' || action.length > 8192) return null;
    var match = /^(link:(?:(?:replace|window):)?|content:|menu:)(.+)$/.exec(action);
    if (!match) return null;
    var prefix = match[1];
    var target = match[2];
    if (prefix.indexOf('link:') === 0) {
      if (!isHttpUrl(target)) return null;
      return { action: prefix + target, url: target, mode: prefix === 'link:window:' ? 'browser' : 'embedded' };
    }
    var parts = target.split('>');
    if (!isHttpUrl(parts[0])) return null;
    // Only documented focus selectors are accepted; arbitrary compound MSX actions are not imported.
    var focuses = parts.slice(1);
    if (focuses.length && focuses[focuses.length - 1] === 'execute') focuses.pop();
    if (focuses.length > (prefix === 'menu:' ? 2 : 1) || (parts.length > 1 && !focuses.length)) return null;
    for (var i = 0; i < focuses.length; i++) if (!/^(?:index:[0-9]+|[a-z0-9_.-]+)$/i.test(focuses[i])) return null;
    return { action: prefix + target, url: 'https://msx.benzac.de/lg.html?start=' + encodeURIComponent(prefix + target), mode: 'embedded' };
  }

  // Read only one catalogue level. Nested content, media lists and interaction plugins are not crawled.
  // Menu items use data:URL, rather than action: https://msx.benzac.de/wiki/index.php?title=Menu_Item_Object
  function parseApps(payload, settings) {
    if (typeof payload === 'string') {
      if (payload.length > maxPayloadLength) return [];
      try { payload = JSON.parse(payload); } catch (ignore) { return []; }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    var apps = [];
    var seen = Object.create(null);
    var inspected = 0;
    function add(item, isMenu) {
      if (++inspected > maxEntries || apps.length >= maxApps || !item || typeof item !== 'object' || Array.isArray(item)) return;
      if (item.display === false || item.enable === false || item.type === 'separator' || item.type === 'settings') return;
      var action = isMenu ? (isHttpUrl(item.data) ? 'content:' + item.data : null) : item.action;
      var normalized = normalizeAction(action);
      if (!normalized || own.call(seen, normalized.action)) return;
      var name = cleanName(item.title) || cleanName(item.label) || cleanName(item.name);
      if (!name) return;
      var app = {
        id: 'msx:' + encodeURIComponent(normalized.action), name: name, source: 'msx',
        launchUrl: normalized.url, launchMode: normalized.mode, action: normalized.action
      };
      if (isHttpUrl(item.image)) app.icon = item.image;
      seen[normalized.action] = true;
      apps.push(app);
    }
    function addItems(items, isMenu) {
      if (!Array.isArray(items)) return;
      for (var i = 0; i < items.length && inspected < maxEntries && apps.length < maxApps; i++) add(items[i], isMenu);
    }
    addItems(payload.items, false);
    if (Array.isArray(payload.pages)) {
      for (var p = 0; p < payload.pages.length && p < maxEntries && inspected < maxEntries && apps.length < maxApps; p++) {
        if (payload.pages[p] && typeof payload.pages[p] === 'object') addItems(payload.pages[p].items, false);
      }
    }
    addItems(payload.menu, true);
    return apps;
  }

  return { parseSettings: parseSettings, isHttpUrl: isHttpUrl, getContentUrl: getContentUrl, parseApps: parseApps };
}));

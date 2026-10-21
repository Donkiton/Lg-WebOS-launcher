'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalog = require('../msx-catalog.js');

function row(key, value) { return key + '|' + Buffer.from(value, 'utf16le').toString('hex'); }

test('Настройки читаются из разрешённых hex UTF-16LE строк SQLite без доступа к остальным данным', () => {
  const input = [
    row('start', 'content:https://m.zona.ms/msx/start.json'), row('server', 'm.zona.ms'),
    row('server_secure', 'true'), row('start_name', 'Зона 🎬'), row('start_version', '1.1.0'),
    'unrelated|not-hex', '__proto__|constructor'
  ].join('\r\n') + '\r\n';
  assert.deepEqual(catalog.parseSettings(input), {
    start: 'content:https://m.zona.ms/msx/start.json', server: 'm.zona.ms', serverSecure: true, name: 'Зона 🎬', version: '1.1.0'
  });
  assert.deepEqual(catalog.parseSettings(''), { start: '', server: '', serverSecure: false, name: '', version: '' });
  assert.equal(catalog.parseSettings(row('server_secure', '1')).serverSecure, true);
  assert.equal(catalog.parseSettings(row('server_secure', 'false')).serverSecure, false);
  assert.equal(catalog.parseSettings(row('server_secure', '0')).serverSecure, false);
});

test('Повреждённый hex, дубликаты, превышение лимита и неверный Unicode настроек отклоняются', () => {
  for (const input of [null, {}, 'start', 'start|00', 'start|GGGG', 'start|4100|4200', 'start|00d8', 'start|00dc',
    'start|0000', row('start', 'a\nb'), row('start', 'a') + '\n' + row('start', 'b'),
    row('server_secure', 'yes'), row('start_name', 'a'.repeat(513)), 'x'.repeat(131073), '\n'.repeat(33)]) {
    assert.throws(() => catalog.parseSettings(input), { code: 'MSX_INVALID_SETTINGS' });
  }
});

test('HTTP URL допускает только абсолютные ограниченные адреса без пробелов, controls и backslash', () => {
  for (const url of ['https://example.com', 'http://localhost:8080/path?q=1#section', 'HTTPS://EXAMPLE.COM/a',
    'http://192.168.1.2:9000/a', 'https://[::1]:443/a', 'https://example.com/a%20b']) assert.equal(catalog.isHttpUrl(url), true, url);
  for (const url of ['', null, '/relative', '//example.com', 'javascript:alert(1)', 'file:///etc/a', 'https://',
    'https://a b/', 'https://example.com/\n', ' https://example.com', 'https://example.com/\\x',
    'https://user:password@example.com', 'https://example.com:99999/', 'https://-invalid.example', 'https://a..b',
    'https://example.com/<script>', 'https://example.com/\ud800', 'https://example.com/' + 'a'.repeat(4096)]) assert.equal(catalog.isHttpUrl(url), false, String(url));
});

test('URL содержимого извлекается из start без исполнения focus и interaction request', () => {
  assert.equal(catalog.getContentUrl('content:https://example.com/root.json>app>execute'), 'https://example.com/root.json');
  assert.equal(catalog.getContentUrl('menu:http://example.com/menu.json>index:0>index:1'), 'http://example.com/menu.json');
  assert.equal(catalog.getContentUrl('redirect:https://example.com/start.json'), 'https://example.com/start.json');
  for (const start of ['', null, 'start:https://example.com', 'content:request:interaction:init@https://example.com',
    'content:javascript:alert(1)', 'menu:/relative', 'content:https://example.com\\evil']) assert.equal(catalog.getContentUrl(start), null);
});

test('Фактический Zona JSON превращается в самостоятельную карточку без hardcode адреса', () => {
  const payload = { name: 'Zona', type: 'list', headline: 'Zona', version: 'v1.1.0',
    parameter: 'content:https://m.zona.ms/msx/start.json', action: '[settings:validate_links:0|home]',
    template: { type: 'separate', layout: '0,0,3,4', color: 'msx-glass' },
    items: [{ title: 'Zona', label: 'v1.1.0', image: 'https://msx.zona.ms/assets/logo_512_512.png', action: 'link:https://msx.zona.ms' }] };
  assert.deepEqual(catalog.parseApps(payload, {}), [{
    id: 'msx:' + encodeURIComponent('link:https://msx.zona.ms'), name: 'Zona', source: 'msx', launchUrl: 'https://msx.zona.ms',
    launchMode: 'embedded', action: 'link:https://msx.zona.ms', icon: 'https://msx.zona.ms/assets/logo_512_512.png'
  }]);
  assert.equal(catalog.parseApps({ items: [{ title: 'Другое приложение', action: 'link:https://other.example/app' }] })[0].launchUrl, 'https://other.example/app');
});

test('Импортируются прямые supported actions, их режимы и документированные focus selectors', () => {
  const actions = ['link:https://a.example', 'link:replace:https://b.example', 'link:window:https://c.example',
    'content:https://d.example/data.json>index:0>execute', 'menu:https://e.example/menu.json>section>first>execute'];
  const apps = catalog.parseApps({ pages: [{ items: actions.map((action, i) => ({ label: 'Приложение ' + i, action })) }] });
  assert.equal(apps.length, 5);
  assert.deepEqual(apps.map(app => app.launchMode), ['embedded', 'embedded', 'browser', 'embedded', 'embedded']);
  assert.equal(apps[1].launchUrl, 'https://b.example');
  assert.equal(apps[3].launchUrl, 'https://msx.benzac.de/lg.html?start=' + encodeURIComponent(actions[3]));
  assert.deepEqual(apps.map(app => app.action), actions);
});

test('Медиадействия, native side effects, произвольные commands и вложенные каталоги не импортируются', () => {
  const actions = ['video:https://example.com/a.mp4', 'audio:https://example.com/a.mp3', 'settings:reset',
    'execute:https://example.com', 'javascript:alert(1)', 'file:///tmp/app', 'start:https://example.com',
    'content:request:interaction:init@https://example.com', '[link:https://example.com|execute:alert]',
    'content:https://example.com>execute', 'content:https://example.com>item>index:2',
    'menu:https://example.com>item>evil:action', 'link:javascript:alert(1)'];
  const payload = { items: actions.map(action => ({ title: 'Не приложение', action })),
    data: { items: [{ title: 'Вложенное', action: 'link:https://nested.example' }] },
    pages: [{ items: [{ title: 'Вложенное', data: { items: [{ title: 'Ещё глубже', action: 'link:https://deep.example' }] } }] }] };
  assert.deepEqual(catalog.parseApps(payload), []);
});

test('Menu Item использует только документированный data HTTP URL и не рекурсивный data object', () => {
  const apps = catalog.parseApps({ menu: [
    { label: 'Сервис', data: 'https://example.com/content.json', image: 'https://example.com/logo.png' },
    { label: 'Неизвестный action', action: 'link:https://unknown.example' },
    { label: 'Интерактивный', data: 'request:interaction:init@https://example.com' },
    { label: 'Встроенные данные', data: { items: [{ title: 'Внутри', action: 'link:https://nested.example' }] } }
  ] });
  assert.equal(apps.length, 1);
  assert.equal(apps[0].action, 'content:https://example.com/content.json');
});

test('ID не зависит от имени или позиции; одинаковые действия дедуплицируются между страницами', () => {
  const action = 'link:https://example.com/app';
  const first = catalog.parseApps({ items: [{ title: 'Первое имя', action }], pages: [{ items: [{ title: 'Дубликат', action }] }] });
  const reordered = catalog.parseApps({ items: [{ title: 'Другое', action: 'link:https://another.example' }, { title: 'Новое имя', action }] });
  assert.equal(first.length, 1);
  assert.equal(first[0].name, 'Первое имя');
  assert.equal(first[0].id, reordered[1].id);
});

test('Скрытые карточки, служебные пункты и invalid image пропускаются без выполнения HTML', () => {
  const payload = { items: [
    { title: '{col:blue}<b>Название</b>', action: 'link:https://example.com', image: 'javascript:alert(1)' },
    { title: 'Hidden', display: false, action: 'link:https://hidden.example' },
    { title: 'Disabled', enable: false, action: 'link:https://disabled.example' },
    { type: 'separator', title: 'Separator', action: 'link:https://separator.example' },
    { type: 'settings', title: 'Settings', action: 'link:https://settings.example' },
    { title: '{col:red}', action: 'link:https://nameless.example' }, null, []
  ] };
  assert.equal(catalog.parseApps(payload).length, 1);
  assert.equal(catalog.parseApps(payload)[0].name, 'Название');
  assert.equal(Object.hasOwn(catalog.parseApps(payload)[0], 'icon'), false);
  assert.deepEqual(catalog.parseApps('{"items":[],"__proto__":{"polluted":true}}'), []);
  assert.equal({}.polluted, undefined);
});

test('Неверный JSON, отсутствующий каталог и чрезмерные ответы не порождают заглушки', () => {
  for (const payload of [null, undefined, false, [], 'not JSON', '{"items":[],}', 'x'.repeat(1048577)]) assert.deepEqual(catalog.parseApps(payload), []);
  const apps = catalog.parseApps({ items: Array.from({ length: 300 }, (_, i) => ({ title: 'App ' + i, action: 'link:https://example.com/' + i })) });
  assert.equal(apps.length, 200);
  const malformed = catalog.parseApps({ items: [
    { title: 'Invalid Unicode', action: 'link:https://example.com/\ud800' },
    { title: 'Валидное приложение', action: 'link:https://example.com/good' }
  ] });
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].launchUrl, 'https://example.com/good');
});

test('Модуль публикует browser API без Node зависимостей', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'msx-catalog.js'), 'utf8'), { window });
  assert.equal(typeof window.LauncherMSXCatalog.parseSettings, 'function');
  assert.equal(typeof window.LauncherMSXCatalog.parseApps, 'function');
  assert.equal(window.LauncherMSXCatalog.isHttpUrl('https://example.com'), true);
});

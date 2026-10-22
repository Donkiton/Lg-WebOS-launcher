(function () {
  'use strict';

  // ES5 syntax baseline for the webOS 4.x engine. System calls live in platform.js.
  var stage = document.getElementById('stage');
  var overlay = document.getElementById('overlay');
  var home = document.getElementById('home');
  var rail = document.getElementById('home-rail');
  var storageKey = 'lg-home-prototype-v1';
  var settings = { motion: 'smooth', reflections: true, dim: false, hints: false };
  var platform = window.LauncherPlatform;
  var wallpaperController = null;
  var homeState = window.LauncherHomeState;
  var favoritesKey = 'lg-home-favorites-v1-' + platform.mode;
  var catalogOrderKey = 'lg-home-catalog-order-v1-' + platform.mode;
  var catalogOrder = [];
  var catalogStorageFailed = false;
  var favorites = [];
  var savedFavorites = null;
  var favoritesReady = false;
  var apps = [];
  var catalogLoading = false;
  var pendingShortcut = null;
  var nativeLaunchSeen = false;
  var coldShortcutConsumed = false;
  var catalogError = '';
  var queuedCatalog = null;
  var catalogStatus = { nativeComplete: false, msxComplete: false, iconsOnly: false };
  var lastCatalogRead = 0;
  var network = { available: false, kind: 'unknown', connected: null };
  var view = 'home';
  var viewData = null;
  var stack = [];
  var viewRevision = 0;
  var press = null;
  var enterDown = false;
  var pointerDown = false;
  var pointerConsumed = false;
  var suppressClickUntil = 0;
  var toastTimer = null;
  var clockTimer = null;
  var lastHomeIndex = 0;
  var lastHeaderId = 'all-apps-button';
  var icons = {
    wifi: '<path d="M3 9a21 21 0 0 1 30 0M8 15a14 14 0 0 1 20 0M13 21a7 7 0 0 1 10 0"/><circle cx="18" cy="27" r="2" fill="currentColor" stroke="none"/>',
    settings: '<path d="m22 3 1.1 4.2 3.2 1.9 4.2-1.2 4 6.8-3.1 3v3.7l3.1 3-4 6.8-4.2-1.2-3.2 1.9L22 36h-8l-1.1-4.1-3.2-1.9-4.2 1.2-4-6.8 3.1-3v-3.7l-3.1-3 4-6.8 4.2 1.2 3.2-1.9L14 3z" fill="currentColor" stroke="none"/><circle cx="18" cy="19.5" r="7" fill="#18283b" stroke="none"/>',
    back: '<path d="m15 8-9 9 9 9M7 17h17a8 8 0 0 1 0 16h-7"/>',
    grid: '<rect x="3" y="3" width="12" height="12" rx="1.5"/><rect x="21" y="3" width="12" height="12" rx="1.5"/><rect x="3" y="21" width="12" height="12" rx="1.5"/><rect x="21" y="21" width="12" height="12" rx="1.5"/>'
  };
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function theme(app) {
    var key = app.brand || app.id;
    return /^(youtube|okko|rutube|ivi|zona|all|kinopoisk|wink|kion|vk|msx|iptv|mts|yandex|kids|homebrew)$/.test(key) ? key : 'generic';
  }
  function svg(name, className) {
    return '<svg class="' + (className || '') + '" viewBox="0 0 36 40" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
  }
  function brand(app) {
    var key = theme(app);
    if (key === 'youtube') {
      return '<svg class="youtube-symbol" viewBox="0 0 116 82" aria-hidden="true"><path fill="#ff0000" d="M112 14C110 6 105 3 97 2 77-1 39-1 19 2 10 3 5 7 3 15-1 29-1 53 3 67c2 8 7 12 16 13 20 3 58 3 78 0 8-1 13-5 15-13 4-15 4-38 0-53Z"/><path fill="#fff" d="m47 24 29 17-29 17Z"/></svg><span class="youtube-label">YouTube</span>';
    }
    if (key === 'okko') return '<span class="okko-logo">ökko</span>';
    if (key === 'rutube') return '<span class="rutube-logo">RUTUBE</span>';
    if (key === 'ivi') return '<span class="ivi-logo">иви</span>';
    if (key === 'zona') return '<span class="zona-logo">zona</span>';
    if (key === 'all') return svg('grid', 'all-symbol') + '<span class="all-label">Все приложения</span>';
    var icon = iconSource(app);
    if (icon) return '<img class="installed-app-icon" src="' + escapeHtml(icon) + '" alt="" draggable="false"><span class="installed-app-name' + (app.name.length > 26 ? ' long-name' : '') + '">' + escapeHtml(app.name) + '</span>';
    return '<span class="generic-logo">' + escapeHtml(app.name) + '</span>';
  }
  function iconSource(app) {
    var path = app.icon || '';
    if (app.source === 'msx' && window.LauncherMSXCatalog && window.LauncherMSXCatalog.isHttpUrl(path)) return path;
    if (/^assets\/tv-apps\/[A-Za-z0-9_.-]+\.png$/.test(path)) return path;
    if (platform.mode === 'webos' && path.length <= 349550 && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(path)) return path;
    // Other apps' file:// images are blocked by WAM on this TV. During a
    // progressive read, show the app name until its validated PNG arrives.
    return '';
  }
  function card(app, id, extra) {
    var position = favorites.indexOf(app.id);
    var badge = id.indexOf('grid-app-') === 0 && position >= 0 ? '<span class="home-badge" aria-hidden="true"><svg class="home-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10"/></svg>' + (position + 1) + '</span>' : '';
    return '<button id="' + id + '" class="app-card brand-' + theme(app) + '" data-app="' + escapeHtml(app.id) + '" title="' + escapeHtml(app.name) + '" aria-label="' + escapeHtml(app.name) + (badge ? ', на главном, место ' + (position + 1) : '') + '"' + (extra || '') + '>' + brand(app) + badge + '</button>';
  }
  function findApp(id) {
    for (var i = 0; i < apps.length; i++) if (apps[i].id === id) return apps[i];
    return null;
  }
  function homeApps() { return favorites.map(findApp).filter(function (app) { return !!app; }); }
  function homeCardIndex(id) {
    var list = homeApps();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }
  function selectedApp(id) { return findApp(id) || { id: id, name: 'Приложение загружается' }; }
  function focusHome() {
    var count = homeApps().length;
    lastHomeIndex = Math.max(0, Math.min(lastHomeIndex, count - 1));
    if (!count || !focusId('home-app-' + lastHomeIndex)) focusId('all-apps-button');
  }
  function focusId(id) {
    var el = document.getElementById(id);
    if (el) el.focus();
    return !!el;
  }
  function notify(text) {
    var toast = document.getElementById('toast');
    window.clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = window.setTimeout(function () { toast.hidden = true; }, 3200);
  }
  function readFavorites() {
    try {
      var value = JSON.parse(localStorage.getItem(favoritesKey));
      if (Array.isArray(value)) savedFavorites = homeState.selection(value);
    } catch (ignore) { /* Missing or damaged storage uses the first-run selection. */ }
  }
  function readCatalogOrder() {
    try {
      var value = JSON.parse(localStorage.getItem(catalogOrderKey));
      if (Array.isArray(value)) catalogOrder = value;
    } catch (ignore) { /* First discovery order becomes the baseline. */ }
  }
  function catalogApps() { return homeState.catalog(apps, favorites, catalogOrder); }
  function updatePriorities() {
    if (!platform.setAppPriorities) return;
    var visible = view === 'apps' ? homeState.paginate(catalogApps(), viewData.page || 0).items.map(function (app) { return app.id; }) : [];
    platform.setAppPriorities(favorites, visible);
  }
  function saveHomeCache() {
    if (platform.saveHomeCache) platform.saveHomeCache(favorites, apps);
  }
  function catalogIndex(appId) {
    var ordered = catalogApps();
    for (var i = 0; i < ordered.length; i++) if (ordered[i].id === appId) return i;
    return -1;
  }
  function commitFavorites(next, text) {
    var normalized = homeState.selection(next);
    try { localStorage.setItem(favoritesKey, JSON.stringify(normalized)); }
    catch (ignore) { notify('Не удалось сохранить. Порядок оставлен без изменений.'); return false; }
    favorites = normalized;
    savedFavorites = favorites.slice();
    lastHomeIndex = Math.max(0, Math.min(lastHomeIndex, homeApps().length - 1));
    saveHomeCache();
    updatePriorities();
    renderHome();
    notify(text);
    return true;
  }
  function restoreSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved || typeof saved !== 'object') return;
      if (saved.motion === 'smooth' || saved.motion === 'fast' || saved.motion === 'off') settings.motion = saved.motion;
      ['reflections', 'dim', 'hints'].forEach(function (key) {
        if (typeof saved[key] === 'boolean') settings[key] = saved[key];
      });
    } catch (ignore) { /* A blocked/full browser store must not stop the UI. */ }
  }
  function applySettings() {
    stage.classList.toggle('no-reflections', !settings.reflections);
    stage.classList.toggle('is-dimmed', settings.dim);
    stage.classList.toggle('no-motion', settings.motion === 'off');
    stage.style.setProperty('--motion', settings.motion === 'fast' ? '120ms' : '220ms');
    document.getElementById('remote-hint').hidden = !settings.hints;
  }
  function saveSettings() {
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); }
    catch (ignore) { notify('Не удалось сохранить настройки.'); }
    applySettings();
  }
  function fitStage() {
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'scale(' + scale + ')';
    stage.style.left = Math.round((window.innerWidth - 1920 * scale) / 2) + 'px';
    stage.style.top = Math.round((window.innerHeight - 1080 * scale) / 2) + 'px';
  }
  function setupWallpaper() {
    var wallpaper = document.getElementById('wallpaper');
    if (!wallpaper || !window.LauncherWallpaper || !(platform.getWallpaperRecord || platform.getPowerSession)) return;
    var storage = null;
    try { storage = window.localStorage || localStorage; } catch (ignoreStorage) { /* Optional persistence. */ }
    wallpaperController = window.LauncherWallpaper.createController({
      mode: platform.mode,
      storage: storage,
      initialRecord: platform.mode === 'webos' && window.LauncherWallpaper.early ? window.LauncherWallpaper.early.record : null,
      now: function () { return new Date(); },
      readSession: function () { return platform.getWallpaperRecord ? platform.getWallpaperRecord() : platform.getPowerSession(); },
      loadImage: function (path) {
        return new Promise(function (resolve, reject) {
          var image = null;
          var settled = false;
          var stopListening = function () {};
          var timer = window.setTimeout(function () { finish(new Error('Wallpaper load timed out')); }, 5000);
          function finish(error) {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            stopListening();
            if (image) { image.onload = null; image.onerror = null; }
            if (error) reject(error); else resolve();
          }
          var early = window.LauncherWallpaper.early;
          if (platform.mode === 'webos' && early && early.path === path) {
            stopListening = early.listen(finish);
            return;
          }
          image = new window.Image();
          image.onload = function () { finish(); };
          image.onerror = function () { finish(new Error('Wallpaper unavailable')); };
          image.src = path;
        });
      },
      apply: function (path) { wallpaper.style.backgroundImage = 'url("' + path + '")'; }
    });
  }
  function refreshWallpaper(params) {
    if (wallpaperController) {
      var hint = platform.mode === 'webos' ? window.LauncherWallpaper.parseLaunchHint(params) : null;
      wallpaperController.refresh(hint).catch(function () {});
    }
  }
  function updateClock() {
    var now = new Date();
    var days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    var months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    var hour = now.getHours();
    var min = now.getMinutes();
    var time = document.getElementById('clock-time');
    var date = document.getElementById('clock-date');
    var text = (hour < 10 ? '0' : '') + hour + ':' + (min < 10 ? '0' : '') + min;
    var dateText = days[now.getDay()] + ', ' + now.getDate() + ' ' + months[now.getMonth()];
    var timestamp = now.getTime();
    var minute = new Date(timestamp - now.getSeconds() * 1000 - now.getMilliseconds()).toISOString();
    if (time.textContent !== text) time.textContent = text;
    if (time.getAttribute('datetime') !== minute) time.setAttribute('datetime', minute);
    if (date.textContent !== dateText) date.textContent = dateText;
    return timestamp;
  }
  function stopClock() {
    if (clockTimer !== null) window.clearTimeout(clockTimer);
    clockTimer = null;
  }
  function syncClock(force) {
    stopClock();
    if (document.hidden && force !== true) return;
    var now = updateClock();
    if (document.hidden) return;
    // Align to a calendar minute rather than the time this page was opened.
    // Recalculate after each tick so sleep and system clock changes cannot drift.
    clockTimer = window.setTimeout(function () { clockTimer = null; syncClock(); }, 60000 - now % 60000);
  }
  function renderHome() {
    var html = '';
    var list = homeApps();
    for (var i = 0; i < list.length; i++) {
      html += '<div class="tile' + (i === lastHomeIndex ? ' is-active' : '') + '">' + card(list[i], 'home-app-' + i, ' data-home-index="' + i + '"') + '<div class="reflection" aria-hidden="true"><div class="app-card brand-' + theme(list[i]) + '" data-reflection-app="' + escapeHtml(list[i].id) + '">' + brand(list[i]) + '</div></div></div>';
    }
    rail.innerHTML = html;
    document.getElementById('all-apps-button').innerHTML = svg('grid');
    document.getElementById('settings-button').innerHTML = svg('settings');
    renderNetworkIcon();
  }
  function renderNetworkIcon() {
    var button = document.getElementById('network-button');
    // Keep the approved Wi-Fi symbol for the connection shortcut in every state.
    button.innerHTML = svg('wifi');
    var label = network.available ? 'Подключение: ' + (network.kind === 'wifi' ? 'Wi-Fi' : network.kind === 'wired' ? 'кабель' : network.kind === 'none' ? 'нет подключения' : 'тип не определён') : 'Подключение: данные недоступны';
    button.setAttribute('aria-label', 'Сети Wi-Fi. ' + label);
    button.setAttribute('title', 'Сети Wi-Fi. ' + label);
  }
  function backButton() {
    return '<button id="view-back" class="icon-button back-button" data-action="back" aria-label="Назад" title="Назад">' + svg('back') + '</button>';
  }
  function toggleRow(key, text) {
    return '<button id="setting-' + key + '" class="setting-row" data-setting="' + key + '" role="switch" aria-checked="' + settings[key] + '"><span>' + text + '</span><span class="toggle" aria-hidden="true"></span></button>';
  }
  function renderView(name, data) {
    var html = '';
    var i;
    if (name === 'apps') {
      var page = homeState.paginate(catalogApps(), data.page || 0);
      data.page = page.page;
      var showHints = platform.mode === 'browser' || settings.hints;
      html = '<h1 class="view-heading">' + (data.manage ? 'Настройка приложений' : 'Все приложения') + '</h1>' + (showHints && !catalogError ? '<p class="view-subtitle">' + (data.manage ? 'OK — действия с приложением · Назад — завершить настройку' : platform.mode === 'browser' ? 'OK — открыть · Удерживайте OK — действия с приложением' : 'OK — открыть · Синяя кнопка — действия') + '</p>' : '') + backButton();
      if (apps.length) html += '<button id="catalog-manage" class="text-button catalog-manage" data-action="catalog-manage" aria-pressed="' + !!data.manage + '">' + (data.manage ? 'Готово' : 'Настроить') + '</button>';
      if (catalogError) html += '<div class="catalog-message"><span>' + escapeHtml(catalogError) + '</span><button id="catalog-retry" class="text-button" data-action="reload-apps">Повторить</button></div>';
      html += '<div class="apps-grid' + (data.direction > 0 ? ' page-forward' : data.direction < 0 ? ' page-backward' : '') + '" aria-label="Список приложений, страница ' + (page.page + 1) + ' из ' + page.count + '">';
      data.direction = 0;
      if (!apps.length && !catalogError) html += '<p class="empty-state">' + (catalogLoading ? 'Получаем список приложений…' : 'Установленные приложения не найдены.') + '</p>';
      for (i = 0; i < page.items.length; i++) html += '<div class="grid-tile">' + card(page.items[i], 'grid-app-' + (page.start + i), ' data-grid-index="' + i + '"') + '</div>';
      html += '</div>';
      if (page.count > 1) html += '<nav class="catalog-pages" aria-label="Страницы приложений"><button id="catalog-prev" class="page-button" data-action="page-prev" aria-label="Предыдущая страница"' + (page.page === 0 ? ' disabled' : '') + '>‹</button><span id="catalog-page-number" class="page-number" aria-live="polite">' + (page.page + 1) + ' / ' + page.count + '</span><button id="catalog-next" class="page-button" data-action="page-next" aria-label="Следующая страница"' + (page.page + 1 === page.count ? ' disabled' : '') + '>›</button></nav>';
      if (platform.mode === 'browser') html += '<p class="catalog-footer">Правый клик или M — меню</p>';
    } else if (name === 'settings') {
      html = '<div class="settings-panel"><h1 class="view-heading">Настройки лаунчера</h1>' + backButton() + '<div class="settings-group"><h2 class="group-label">Анимация</h2><div class="choice-row">';
      var modes = [['smooth', 'Плавно'], ['fast', 'Быстро'], ['off', 'Без анимации']];
      for (i = 0; i < modes.length; i++) html += '<button id="motion-' + modes[i][0] + '" class="choice" data-motion="' + modes[i][0] + '" aria-pressed="' + (settings.motion === modes[i][0]) + '">' + modes[i][1] + '</button>';
      html += '</div></div><div class="settings-group">' + toggleRow('reflections', 'Отражения карточек') + toggleRow('dim', 'Приглушить фон') + toggleRow('hints', 'Подсказки управления') + '</div><div class="settings-group system-links"><button id="tv-settings-button" class="setting-row" data-action="tv-settings"><span>Настройки телевизора</span><span class="chevron" aria-hidden="true">›</span></button><button id="inputs-button" class="setting-row" data-action="inputs"><span>Источники сигнала</span><span class="chevron" aria-hidden="true">›</span></button><button id="help-button" class="setting-row" data-action="help"><span>Управление</span><span class="chevron" aria-hidden="true">›</span></button></div><p class="settings-note">' + (platform.mode === 'browser' ? 'Предпросмотр в браузере · приложения с вашего ТВ' : 'Режим webOS · системные данные телевизора') + '<br>Карточки и порядок сохраняются на этом устройстве.</p></div>';
    } else if (name === 'launch') {
      var app = findApp(data.appId);
      html = '<div class="center-dialog" aria-labelledby="dialog-title">' + (app ? '<div class="launch-brand brand-' + theme(app) + '" aria-hidden="true">' + brand(app) + '</div>' : '') + '<h2 id="dialog-title">' + escapeHtml(app ? app.name : 'Запуск приложения') + '</h2><p>' + escapeHtml(data.message || 'Открываем приложение…') + '</p><button id="launch-back" class="text-button" data-action="back">Вернуться</button></div>';
    } else if (name === 'portal') {
      html = '<iframe id="msx-portal" class="msx-portal" title="' + escapeHtml(findApp(data.appId).name) + '" src="portal.html" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation allow-popups" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>';
    } else if (name === 'context') {
      var target = findApp(data.appId);
      var position = favorites.indexOf(data.appId);
      html = '<div class="center-dialog context-dialog" aria-labelledby="dialog-title"><div class="context-heading"><div class="context-brand brand-' + theme(target) + '" aria-hidden="true">' + brand(target) + '</div><div><h2 id="dialog-title">' + escapeHtml(target.name) + '</h2><p>' + (position >= 0 ? 'На главном · место ' + (position + 1) + ' из ' + favorites.length : 'В каталоге приложений') + '</p></div></div><button id="context-open" class="menu-action" data-action="context-open">Открыть<span>›</span></button><button id="context-pin" class="menu-action" data-action="context-pin">' + (position >= 0 ? 'Убрать с главного экрана' : 'Добавить на главный экран') + '<span>' + (position >= 0 ? '−' : '+') + '</span></button>';
      if (position >= 0 && favorites.length > 1) html += '<button id="context-move" class="menu-action" data-action="context-move">Изменить порядок<span>↔</span></button>';
      html += '<button id="context-back" class="menu-action menu-cancel" data-action="back">Назад</button></div>';
    } else if (name === 'replace') {
      html = '<h1 class="view-heading">Какую карточку заменить?</h1><p class="view-subtitle">' + escapeHtml(findApp(data.appId).name) + ' займёт выбранное место. Предыдущее приложение останется в каталоге.</p>' + backButton() + '<div class="edit-rail" style="' + editRailStyle(favorites.length) + '" aria-label="Выбор места на главном экране">';
      for (i = 0; i < favorites.length; i++) html += '<div class="edit-tile"><span class="slot-number">' + (i + 1) + '</span>' + card(selectedApp(favorites[i]), 'replace-slot-' + i, ' data-replace-index="' + i + '"') + '</div>';
      html += '</div><p class="edit-help">← → Выбрать место <span>OK Заменить</span><span>Назад Отмена</span></p>';
    } else if (name === 'reorder') {
      html = '<h1 class="view-heading">Порядок на главном экране</h1><p class="view-subtitle">' + escapeHtml(findApp(data.appId).name) + ': переместите карточку стрелками ← →</p>' + backButton() + '<div class="edit-rail reorder-rail" style="' + editRailStyle(data.order.length) + '" aria-label="Перестановка карточек">';
      for (i = 0; i < data.order.length; i++) html += '<div class="reorder-tile' + (data.order[i] === data.appId ? ' is-moving' : '') + '" data-order-app="' + escapeHtml(data.order[i]) + '" style="transform:translateX(' + (i * 298) + 'px)"><span class="slot-number">' + (i + 1) + '</span>' + card(selectedApp(data.order[i]), 'reorder-slot-' + i, ' data-reorder-index="' + i + '"') + '</div>';
      html += '</div><div class="edit-controls"><button id="reorder-left" class="text-button" data-action="move-left" aria-label="Передвинуть влево">←</button><button id="reorder-save" class="text-button" data-action="save-order">Сохранить · OK</button><button id="reorder-right" class="text-button" data-action="move-right" aria-label="Передвинуть вправо">→</button><button id="reorder-back" class="text-button secondary" data-action="back">Отмена</button></div><p class="edit-help">← → Передвинуть <span>↓ Кнопки</span><span>OK Сохранить</span><span>Назад Отменить</span></p>';
    } else if (name === 'network') {
      html = '<div class="center-dialog" aria-labelledby="dialog-title"><h2 id="dialog-title">Сети Wi-Fi</h2><p>' + escapeHtml(data.message || 'Открываем список сетей в настройках LG…') + '</p>';
      if (data.failed) html += '<button id="network-settings" class="text-button" data-action="network-settings">Настройки телевизора</button>';
      html += '<button id="network-back" class="text-button" data-action="back">Назад</button></div>';
    } else if (name === 'inputs') {
      html = '<div class="center-dialog inputs-dialog" aria-labelledby="dialog-title"><h2 id="dialog-title">Источники сигнала</h2>';
      if (data.loading) html += '<p>Получаем входы телевизора…</p>';
      else if (data.error) html += '<p>Список входов недоступен</p><p class="detail-note">' + escapeHtml(data.error) + '</p>';
      else if (!data.items.length) html += '<p>Телевизор не сообщил доступных входов.</p>';
      else for (i = 0; i < data.items.length; i++) html += '<button id="input-' + i + '" class="menu-action" data-input-index="' + i + '">' + escapeHtml(data.items[i].name) + '<span>' + (data.items[i].connected === true ? 'Подключён' : data.items[i].connected === false ? 'Нет сигнала' : 'Статус неизвестен') + '</span></button>';
      html += '<button id="inputs-back" class="text-button" data-action="back">Назад</button></div>';
    } else if (name === 'tv-settings' || name === 'input-launch') {
      html = '<div class="center-dialog" aria-labelledby="dialog-title"><h2 id="dialog-title">' + (name === 'tv-settings' ? 'Настройки телевизора' : 'Источник сигнала') + '</h2><p>' + escapeHtml(data.message || 'Открываем…') + '</p><button id="' + name + '-back" class="text-button" data-action="back">Назад</button></div>';
    } else if (name === 'help') {
      html = '<div class="center-dialog help-dialog" aria-labelledby="dialog-title"><h2 id="dialog-title">Управление</h2><dl class="help-keys"><div><dt>← ↑ ↓ →</dt><dd>Выбор элемента</dd></div><div><dt>← → на краю</dt><dd>Перелистнуть страницу</dd></div><div><dt>' + (platform.mode === 'browser' ? 'OK / Enter' : 'OK') + '</dt><dd>Открыть приложение</dd></div>' + (platform.mode === 'browser' ? '<div><dt>Удерживать OK</dt><dd>Меню приложения</dd></div>' : '<div><dt>Настроить</dt><dd>В каталоге: OK — действия</dd></div>') + (platform.mode === 'browser' ? '<div><dt>M / правый клик</dt><dd>То же меню на компьютере</dd></div>' : '<div><dt>Синяя кнопка</dt><dd>Действия с приложением</dd></div>') + '<div><dt>' + (platform.mode === 'browser' ? 'Esc / Назад' : 'Назад') + '</dt><dd>Вернуться / отменить</dd></div><div><dt>' + (platform.mode === 'browser' ? 'Home / H' : 'Home') + '</dt><dd>Главный экран</dd></div>' + (platform.mode === 'browser' ? '<div><dt>F</dt><dd>На весь экран</dd></div>' : '') + '</dl><p class="detail-note">Кнопка настроек на пульте открывает системные настройки LG.</p><button id="help-back" class="text-button" data-action="back">Понятно</button></div>';
    }
    overlay.innerHTML = html;
    overlay.setAttribute('aria-label', name === 'apps' ? 'Все приложения' : name === 'settings' ? 'Настройки' : 'Дополнительный экран');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.hidden = false;
    overlay.className = 'overlay is-open' + (name === 'portal' ? ' portal-open' : '');
    stage.classList.add('has-overlay');
    stage.classList.toggle('apps-open', name === 'apps' || name === 'replace' || name === 'reorder' || stack.some(function (item) { return item.name === 'apps'; }));
    home.setAttribute('aria-hidden', 'true');
    if (name === 'portal') {
      var frame = document.getElementById('msx-portal');
      var entryUrl = frame.src;
      var entered = false;
      frame.onload = function () {
        if (view !== 'portal' || document.getElementById('msx-portal') !== frame) return;
        var frameUrl = '';
        try {
          frameUrl = frame.contentWindow.location.href;
        } catch (crossOrigin) { /* Remote documents keep their own origin. */ }
        // webOS 4.5 exposes the frame URL here. MSX's common Exit document
        // otherwise traverses the joint history and can reopen the web app.
        if (/^https?:\/\/msx\.benzac\.de\/exit\.html(?:[?#].*)?$/.test(frameUrl)) { closeView(); return; }
        if (frameUrl === entryUrl) {
          // Keep an owned first history entry: MSX Exit returns to it rather
          // than reopening the portal. Use navigation, not location.replace.
          if (entered) { closeView(); return; }
          entered = true;
          window.setTimeout(function () {
            if (view === 'portal' && document.getElementById('msx-portal') === frame) frame.contentWindow.location.href = data.url;
          }, 0);
        } else if (entered && frameUrl === 'about:blank') { closeView(); return; }
        frame.focus();
      };
      frame.focus();
      return;
    }
    var first = name === 'apps' ? (apps.length ? 'grid-app-' + (data.page * homeState.pageSize) : 'catalog-retry') : name === 'settings' ? 'motion-' + settings.motion : name === 'context' ? 'context-open' : name === 'replace' ? 'replace-slot-0' : name === 'reorder' ? 'reorder-slot-' + data.order.indexOf(data.appId) : name + '-back';
    if (!focusId(first)) focusId('view-back');
  }
  function detailRow(label, value) {
    return '<div class="detail-row"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
  }
  function editRailStyle(count) {
    var width = Math.max(0, count * 298 - 28);
    return 'width:' + width + 'px;left:' + Math.round((1920 - width) / 2) + 'px';
  }
  function updateCurrentView() {
    var focused = document.activeElement ? document.activeElement.id : '';
    if (view === 'apps') {
      var focusedApp = document.activeElement && document.activeElement.getAttribute('data-app');
      var newIndex = catalogIndex(focusedApp);
      if (newIndex >= 0) {
        viewData.page = Math.floor(newIndex / homeState.pageSize);
        focused = 'grid-app-' + newIndex;
      }
    }
    renderView(view, viewData);
    focusId(focused);
  }
  function artworkMatches(node, app) {
    // These logos are drawn locally and have no asynchronous artwork to update.
    if (/^(youtube|okko|rutube|ivi|zona)$/.test(theme(app))) return true;
    var icon = iconSource(app);
    var image = node.querySelector('.installed-app-icon');
    var label = node.querySelector(icon ? '.installed-app-name' : '.generic-logo');
    return !!label && label.textContent === app.name && (icon ? !!image && image.getAttribute('src') === icon : !image);
  }
  function patchCardImages() {
    // Keep button/iframe nodes and focus intact when only artwork changes.
    var buttons = stage.querySelectorAll('button[data-app]');
    for (var i = 0; i < buttons.length; i++) {
      var app = findApp(buttons[i].getAttribute('data-app'));
      if (!app || artworkMatches(buttons[i], app)) continue;
      var badge = buttons[i].querySelector('.home-badge');
      var content = brand(app) + (badge ? badge.outerHTML : '');
      buttons[i].innerHTML = content;
    }
    var reflections = rail.querySelectorAll('[data-reflection-app]');
    for (var j = 0; j < reflections.length; j++) {
      var reflected = findApp(reflections[j].getAttribute('data-reflection-app'));
      if (reflected && !artworkMatches(reflections[j], reflected)) reflections[j].innerHTML = brand(reflected);
    }
  }
  function migrateKnownIds(ids, aliases) {
    return ids.map(function (id) { return homeState.migrateIds([id], apps, aliases)[0] || id; });
  }
  function catalogFingerprint(catalog) {
    return JSON.stringify(catalog.map(function (app) { return [app.id, app.name, app.brand || '', app.source || '']; }));
  }
  function applyCatalog(catalog, meta) {
    meta = meta || { nativeComplete: true, msxComplete: true, iconsOnly: false };
    catalogStatus = meta;
    var previousStructure = catalogFingerprint(apps);
    var previousFavorites = favorites.join('\n');
    var previousOrder = JSON.stringify(catalogOrder);
    apps = homeState.reconcile(apps, catalog, meta);
    if (!favoritesReady && platform.mode === 'browser' && meta.nativeComplete) {
      var aliases = { zona: 'msx' };
      catalogOrder = migrateKnownIds(catalogOrder, aliases);
      if (savedFavorites !== null) savedFavorites = migrateKnownIds(savedFavorites, aliases);
    }
    var baseline = homeState.reconcileOrder(catalogOrder, apps, meta);
    if (JSON.stringify(baseline) !== previousOrder) {
      catalogOrder = baseline;
      try {
        localStorage.setItem(catalogOrderKey, JSON.stringify(catalogOrder));
        catalogStorageFailed = false;
      } catch (ignore) {
        if (!catalogStorageFailed) notify('Не удалось сохранить сортировку каталога на устройстве.');
        catalogStorageFailed = true;
      }
    }
    queuedCatalog = null;
    if (!meta.iconsOnly) lastCatalogRead = Date.now();
    var selected = savedFavorites === null ? favorites : savedFavorites;
    if (savedFavorites === null && !favoritesReady && meta.nativeComplete) {
      selected = homeState.defaults(apps);
      favoritesReady = true;
    } else if (savedFavorites !== null && meta.nativeComplete && meta.msxComplete) favoritesReady = true;
    favorites = homeState.reconcileIds(selected, apps, meta, homeState.limit);
    if (savedFavorites !== null || favoritesReady) {
      savedFavorites = favorites.slice();
      try { localStorage.setItem(favoritesKey, JSON.stringify(savedFavorites)); }
      catch (ignore) { /* Cache refresh must not block a usable launcher. */ }
    }
    lastHomeIndex = Math.max(0, Math.min(lastHomeIndex, homeApps().length - 1));
    saveHomeCache();
    updatePriorities();
    if (meta.iconsOnly && previousStructure === catalogFingerprint(apps) && previousFavorites === favorites.join('\n')) { patchCardImages(); tryPendingShortcut(); return; }
    var focused = document.activeElement ? document.activeElement.id : '';
    var focusedApp = document.activeElement && document.activeElement.getAttribute('data-app');
    renderHome();
    if (view === 'apps') updateCurrentView();
    else if (view === 'home') {
      var position = homeCardIndex(focusedApp);
      if (position >= 0) focusId('home-app-' + position);
      else if (!focusId(focused)) focusHome();
    }
    tryPendingShortcut();
  }
  function acceptCatalog(catalog, meta) {
    // Keep our own metadata: platform.catalogStatus can change at the next
    // callback, and a late PNG cannot downgrade a queued metadata refresh.
    var status = meta ? { nativeComplete: meta.nativeComplete === true, msxComplete: meta.msxComplete === true, iconsOnly: meta.iconsOnly === true } : { nativeComplete: true, msxComplete: true, iconsOnly: false };
    // Catalogues never replace a menu/edit draft or held activation target.
    if (view !== 'home' && view !== 'apps' && view !== 'settings' || press || enterDown || pointerDown) {
      if (queuedCatalog && !queuedCatalog.meta.iconsOnly) status.iconsOnly = false;
      queuedCatalog = { catalog: catalog, meta: status };
    } else applyCatalog(catalog, status);
  }
  function flushCatalog() {
    if (queuedCatalog && !press && !enterDown && !pointerDown && (view === 'home' || view === 'apps' || view === 'settings')) {
      var pending = queuedCatalog;
      applyCatalog(pending.catalog, pending.meta);
    }
  }
  function loadApps(force) {
    if (queuedCatalog) { flushCatalog(); return; }
    if (catalogLoading || (press && !force) || (!force && Date.now() - lastCatalogRead < 5000)) return;
    if (view !== 'home' && view !== 'apps' && view !== 'settings') return;
    catalogLoading = true;
    catalogError = '';
    platform.getApps({ onUpdate: acceptCatalog }).then(function (catalog) {
      catalogLoading = false;
      acceptCatalog(catalog, platform.catalogStatus);
    }).catch(function (error) {
      catalogLoading = false;
      catalogError = 'Не удалось получить приложения: ' + error.message;
      if (view === 'apps' && !press && !enterDown && !pointerDown) updateCurrentView();
      tryPendingShortcut();
    });
  }
  function shortcutFromParams(params) {
    if (typeof params === 'string') {
      if (params.length > 2048) return null;
      try { params = JSON.parse(params); } catch (ignore) { return null; }
    }
    return params && typeof params === 'object' && !Array.isArray(params) && params.shortcut === 'zona' ? 'zona' : null;
  }
  function tryPendingShortcut() {
    if (!pendingShortcut || view !== 'home' || press || enterDown || pointerDown) return;
    // Reuse the active progressive catalog request. Starting another getApps()
    // would cancel the first MSX source read and could discard the shortcut.
    if (catalogLoading) return;
    var target = null;
    for (var i = 0; i < apps.length; i++) {
      if (apps[i].brand === pendingShortcut) { target = apps[i]; break; }
    }
    pendingShortcut = null;
    if (!target) { notify('Zona не найдена в текущем каталоге приложений.'); return; }
    openView('launch', { appId: target.id });
  }
  function handleNativeLaunch(event, initial) {
    if (platform.mode !== 'webos') return;
    nativeLaunchSeen = true;
    var shortcut = shortcutFromParams(event && event.detail);
    // webOS may expose cold parameters before dispatching webOSLaunch.
    // Consume that second delivery without reopening the same portal.
    if (initial && coldShortcutConsumed && shortcut === 'zona') { coldShortcutConsumed = false; return; }
    coldShortcutConsumed = false;
    cancelActivation();
    goHome();
    if (shortcut) { pendingShortcut = shortcut; tryPendingShortcut(); }
    refreshWallpaper(event && event.detail);
  }
  function handleColdLaunch() {
    if (platform.mode !== 'webos' || nativeLaunchSeen) return;
    var shortcut = null;
    try {
      var wallpaper = window.LauncherWallpaper;
      shortcut = shortcutFromParams(wallpaper && wallpaper.initialParamsRead ? wallpaper.initialParams : window.PalmSystem && window.PalmSystem.launchParams);
    }
    catch (ignore) { /* A native launch event can still supply the parameters. */ }
    if (!shortcut) return;
    coldShortcutConsumed = true;
    pendingShortcut = shortcut;
    tryPendingShortcut();
  }
  function refreshNetwork() {
    return platform.getNetwork().then(function (status) {
      network = status;
      renderNetworkIcon();
      return status;
    }).catch(function (error) {
      network = { available: false, kind: 'unknown', connected: null, message: error.message };
      renderNetworkIcon();
      throw error;
    });
  }
  function openView(name, data) {
    pendingShortcut = null;
    cancelPress();
    stack.push({ name: view, data: viewData, focus: document.activeElement ? document.activeElement.id : '', appId: document.activeElement && document.activeElement.getAttribute('data-app') });
    view = name;
    viewData = data || {};
    var revision = ++viewRevision;
    if (name === 'inputs') viewData.loading = true;
    renderView(name, viewData);
    updatePriorities();
    if (name === 'inputs') {
      var request = platform.mode === 'browser' ? Promise.reject(new Error('В браузере нет доступа к входам телевизора. На LG список запрашивается у webOS.')) : platform.getInputs();
      request.then(function (result) {
        if (revision !== viewRevision) return;
        viewData = { loading: false, items: result };
        updateCurrentView();
      }).catch(function (error) {
        if (revision !== viewRevision) return;
        viewData = { loading: false, error: error.message };
        updateCurrentView();
      });
    } else if (name === 'apps') loadApps(false);
    else if (name === 'launch' || name === 'network' || name === 'tv-settings' || name === 'input-launch') {
      if (name === 'input-launch') viewData.control = { cancelled: false };
      var operation = name === 'launch' ? platform.launchApp(viewData.appId) : name === 'network' ? platform.openWifiSettings() : name === 'tv-settings' ? platform.openSettings() : platform.switchInput(viewData.inputId, viewData.control);
      operation.then(function (result) {
        if (revision !== viewRevision) return;
        if (result.embedded) {
          if (!window.LauncherMSXCatalog || !window.LauncherMSXCatalog.isHttpUrl(result.url)) throw new Error('Некорректный адрес приложения MSX.');
          view = 'portal';
          viewData.url = result.url;
          renderView(view, viewData);
          return;
        }
        if (!result.simulated) {
          var returnFocus = name === 'network' ? 'network-button' : viewData.returnFocus;
          goHome();
          if (returnFocus) focusId(returnFocus);
          return;
        }
        viewData.message = name === 'network' ? 'На телевизоре откроется список сетей Wi-Fi в настройках LG. Выберите сеть и введите пароль.' : name === 'tv-settings' ? 'На телевизоре этот пункт откроет системные настройки LG. Кнопка ⚙ на пульте также останется доступна.' : name === 'launch' ? 'Предпросмотр запуска. На телевизоре откроется выбранное установленное приложение.' : 'Вход переключается при запуске на телевизоре.';
        updateCurrentView();
      }).catch(function (error) {
        if (revision !== viewRevision) return;
        viewData.message = 'Не удалось открыть: ' + error.message;
        if (name === 'network') viewData.failed = true;
        updateCurrentView();
      });
    }
  }
  function closeView() {
    pendingShortcut = null;
    if (view === 'home') return;
    cancelPress();
    if (view === 'apps' && viewData.manage) {
      viewData.manage = false;
      updateCurrentView();
      focusId('catalog-manage');
      return;
    }
    if (viewData && viewData.control) viewData.control.cancelled = true;
    ++viewRevision;
    var previous = stack.pop() || { name: 'home', focus: 'home-app-' + lastHomeIndex };
    view = previous.name;
    viewData = previous.data || null;
    var returnFocus = previous.focus;
    if (view === 'apps' && previous.appId) {
      var gridIndex = catalogIndex(previous.appId);
      if (gridIndex >= 0) {
        viewData.page = Math.floor(gridIndex / homeState.pageSize);
        returnFocus = 'grid-app-' + gridIndex;
      }
    }
    if (view === 'home') {
      overlay.hidden = true;
      overlay.innerHTML = '';
      stage.classList.remove('has-overlay');
      stage.classList.remove('apps-open');
      home.removeAttribute('aria-hidden');
    } else {
      renderView(view, viewData);
    }
    if (view === 'home' && previous.appId) {
      var position = homeCardIndex(previous.appId);
      if (position >= 0) returnFocus = 'home-app-' + position;
    }
    if (!focusId(returnFocus) && view === 'home') focusHome();
    updatePriorities();
    flushCatalog();
  }
  function goHome() {
    pendingShortcut = null;
    cancelPress();
    if (viewData && viewData.control) viewData.control.cancelled = true;
    ++viewRevision;
    stack = [];
    view = 'home';
    viewData = null;
    overlay.hidden = true;
    overlay.innerHTML = '';
    stage.classList.remove('has-overlay');
    stage.classList.remove('apps-open');
    home.removeAttribute('aria-hidden');
    focusHome();
    updatePriorities();
    flushCatalog();
    loadApps(false);
  }
  function openContext(button) {
    var id = button && button.getAttribute('data-app');
    if ((view !== 'home' && view !== 'apps') || !findApp(id)) return;
    openView('context', { appId: id });
  }
  function finishEditing() {
    // Replacement/reorder and their parent context return directly to the source card.
    closeView();
    if (view === 'context') closeView();
  }
  function moveCard(direction) {
    var current = viewData.order.indexOf(viewData.appId);
    viewData.order = homeState.move(viewData.order, viewData.appId, current + direction);
    var tiles = overlay.querySelectorAll('[data-order-app]');
    for (var i = 0; i < tiles.length; i++) {
      var id = tiles[i].getAttribute('data-order-app');
      var position = viewData.order.indexOf(id);
      tiles[i].style.transform = 'translateX(' + (position * 298) + 'px)';
      tiles[i].querySelector('.slot-number').textContent = String(position + 1);
      tiles[i].querySelector('button').setAttribute('data-reorder-index', position);
    }
    document.getElementById('announcement').textContent = 'Место ' + (viewData.order.indexOf(viewData.appId) + 1) + ' из ' + viewData.order.length;
  }
  function saveOrder() {
    var selected = viewData.appId;
    if (commitFavorites(viewData.order, 'Порядок сохранён')) {
      lastHomeIndex = homeCardIndex(selected);
      finishEditing();
      if (view === 'home') focusId('home-app-' + lastHomeIndex);
    }
  }
  function changePage(target, index) {
    var currentPage = viewData.page || 0;
    var page = homeState.paginate(catalogApps(), target);
    if (page.page === currentPage) return;
    viewData.page = page.page;
    viewData.direction = page.page > currentPage ? 1 : -1;
    renderView('apps', viewData);
    updatePriorities();
    var itemIndex = Math.max(0, Math.min(page.items.length - 1, index || 0));
    focusId('grid-app-' + (page.start + itemIndex));
    document.getElementById('announcement').textContent = 'Страница ' + (page.page + 1) + ' из ' + page.count;
  }
  function onAction(button) {
    var appId = button.getAttribute('data-app');
    var action = button.getAttribute('data-action');
    var setting = button.getAttribute('data-setting');
    var mode = button.getAttribute('data-motion');
    var replaceIndex = button.getAttribute('data-replace-index');
    var reorderIndex = button.getAttribute('data-reorder-index');
    var inputIndex = button.getAttribute('data-input-index');
    if (replaceIndex !== null) {
      var next = homeState.replace(favorites, Number(replaceIndex), viewData.appId);
      if (next && commitFavorites(next, 'Карточка на главном экране заменена')) finishEditing();
    } else if (reorderIndex !== null) {
      if (appId === viewData.appId) saveOrder();
      else moveCard(Number(reorderIndex) - viewData.order.indexOf(viewData.appId));
    }
    else if (inputIndex !== null) openView('input-launch', { inputId: viewData.items[Number(inputIndex)].id });
    else if (appId) {
      if (view === 'apps' && viewData.manage) openContext(button);
      else openView('launch', { appId: appId });
    } else if (action === 'back') closeView();
    else if (action === 'network-settings') openView('tv-settings', { returnFocus: 'network-button' });
    else if (action === 'context-open') {
      var id = viewData.appId;
      closeView();
      openView('launch', { appId: id });
    } else if (action === 'context-pin') {
      var targetId = viewData.appId;
      if (favorites.indexOf(targetId) >= 0) {
        if (commitFavorites(homeState.remove(favorites, targetId), 'Приложение убрано с главного экрана')) closeView();
      } else {
        var added = homeState.add(favorites, targetId);
        if (added === null) openView('replace', { appId: targetId });
        else if (commitFavorites(added, 'Приложение добавлено на главный экран')) closeView();
      }
    } else if (action === 'context-move') openView('reorder', { appId: viewData.appId, order: favorites.slice() });
    else if (action === 'move-left' || action === 'move-right') moveCard(action === 'move-left' ? -1 : 1);
    else if (action === 'save-order') saveOrder();
    else if (action === 'catalog-manage') {
      viewData.manage = !viewData.manage;
      updateCurrentView();
      if (viewData.manage) focusId('grid-app-' + ((viewData.page || 0) * homeState.pageSize));
    }
    else if (action === 'page-prev' || action === 'page-next') changePage((viewData.page || 0) + (action === 'page-prev' ? -1 : 1), 0);
    else if (action === 'reload-apps') { loadApps(true); updateCurrentView(); }
    else if (action) openView(action);
    else if (setting) {
      settings[setting] = !settings[setting];
      button.setAttribute('aria-checked', String(settings[setting]));
      saveSettings();
    } else if (mode) {
      settings.motion = mode;
      var choices = overlay.querySelectorAll('[data-motion]');
      for (var i = 0; i < choices.length; i++) choices[i].setAttribute('aria-pressed', String(choices[i] === button));
      saveSettings();
    }
    flushCatalog();
  }
  function closestButton(node) {
    while (node && node !== stage) {
      if (node.tagName === 'BUTTON') return node;
      node = node.parentNode;
    }
    return null;
  }
  function visibleButtons() {
    var buttons = (view === 'home' ? home : overlay).querySelectorAll('button');
    var visible = [];
    for (var i = 0; i < buttons.length; i++) if (buttons[i].getBoundingClientRect().width > 0 && !buttons[i].disabled) visible.push(buttons[i]);
    return visible;
  }
  function moveFocus(key) {
    var active = document.activeElement;
    var index = active && active.getAttribute('data-home-index');
    if (view === 'reorder') {
      var reorderIndex = active && active.getAttribute('data-reorder-index');
      var controls = ['reorder-left', 'reorder-save', 'reorder-right', 'reorder-back'];
      var controlIndex = active ? controls.indexOf(active.id) : -1;
      if (reorderIndex !== null && reorderIndex !== undefined) {
        if (key === 37 || key === 39) moveCard(key === 37 ? -1 : 1);
        else if (key === 40) focusId('reorder-save');
        else if (key === 38) focusId('view-back');
        return;
      }
      if (controlIndex >= 0 && (key === 37 || key === 39)) {
        focusId(controls[Math.max(0, Math.min(controls.length - 1, controlIndex + (key === 37 ? -1 : 1)))]);
        return;
      }
      if (controlIndex >= 0 && key === 38 || active && active.id === 'view-back' && key === 40) {
        // moveCard updates positions but keeps each card's original DOM id.
        var reorderButtons = overlay.querySelectorAll('[data-reorder-index]');
        for (var r = 0; r < reorderButtons.length; r++) {
          if (reorderButtons[r].getAttribute('data-app') === viewData.appId) { reorderButtons[r].focus(); break; }
        }
        return;
      }
      if (controlIndex >= 0) return;
    }
    if (view === 'home') {
      var headerIds = ['all-apps-button', 'network-button', 'settings-button'];
      var headerIndex = active ? headerIds.indexOf(active.id) : -1;
      if (index !== null && index !== undefined) {
        if (key === 37 || key === 39) {
          var homeCount = homeApps().length;
          if (homeCount) focusId('home-app-' + ((Number(index) + (key === 37 ? -1 : 1) + homeCount) % homeCount));
        }
        else if (key === 38) focusId(lastHeaderId);
      } else if (key === 40) focusHome();
      else if (headerIndex >= 0 && (key === 37 || key === 39)) focusId(headerIds[Math.max(0, Math.min(headerIds.length - 1, headerIndex + (key === 37 ? -1 : 1)))]);
      else if (headerIndex < 0) focusId('all-apps-button');
      return;
    }
    if (view === 'apps') {
      var gridIndex = active && active.getAttribute('data-grid-index');
      if (gridIndex !== null && gridIndex !== undefined) {
        var relativeIndex = Number(gridIndex);
        var currentPage = viewData.page || 0;
        var page = homeState.paginate(catalogApps(), currentPage);
        if (key === 38 && relativeIndex < homeState.columns) focusId('view-back');
        else if (key === 40 && relativeIndex + homeState.columns >= page.items.length && Math.floor(relativeIndex / homeState.columns) === Math.floor((page.items.length - 1) / homeState.columns)) {
          if (!focusId('catalog-next') || document.getElementById('catalog-next').disabled) focusId('catalog-prev');
        } else {
          var target = homeState.navigatePage(apps.length, currentPage, relativeIndex, key);
          if (target && target.page !== currentPage) changePage(target.page, target.index);
          else if (target) focusId('grid-app-' + (currentPage * homeState.pageSize + target.index));
        }
        return;
      }
      if (active && active.id === 'view-back' && key === 40) { focusId('grid-app-' + ((viewData.page || 0) * homeState.pageSize)); return; }
      if (active && (active.id === 'catalog-prev' || active.id === 'catalog-next')) {
        if (key === 37 || key === 39) { changePage((viewData.page || 0) + (key === 37 ? -1 : 1), 0); return; }
        if (key === 38) { focusId('grid-app-' + ((viewData.page || 0) * homeState.pageSize)); return; }
      }
    }
    var buttons = visibleButtons();
    if (!active || buttons.indexOf(active) < 0) { if (buttons.length) buttons[0].focus(); return; }
    var rect = active.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    var best = null;
    var score = Infinity;
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i] === active) continue;
      var r = buttons[i].getBoundingClientRect();
      var dx = r.left + r.width / 2 - x;
      var dy = r.top + r.height / 2 - y;
      var primary = key === 37 ? -dx : key === 39 ? dx : key === 38 ? -dy : dy;
      var cross = key === 37 || key === 39 ? Math.abs(dy) : Math.abs(dx);
      if (primary < 5) continue;
      var candidate = primary + cross * 3 + (cross > primary * 1.5 ? 3000 : 0);
      if (candidate < score) { score = candidate; best = buttons[i]; }
    }
    if (best) best.focus();
  }
  function fullscreen() {
    var el = document.documentElement;
    var request = el.requestFullscreen || el.webkitRequestFullscreen;
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    var result;
    if (document.fullscreenElement || document.webkitFullscreenElement) result = exit && exit.call(document);
    else result = request && request.call(el);
    if (result && result.catch) result.catch(function () { document.getElementById('announcement').textContent = 'Полноэкранный режим недоступен в этом окне.'; });
  }
  function cancelPress() {
    if (!press) return;
    if (enterDown || pointerDown) {
      pointerConsumed = true;
      suppressClickUntil = Date.now() + 500;
    }
    window.clearTimeout(press.timer);
    press.button.classList.remove('is-held');
    press = null;
  }
  function beginPress(button, kind) {
    // Magic Remote can send both mouse and Enter events for the same gesture.
    // The first down owns the timer; an echoed/repeated down cannot restart it.
    if (press && press.button === button && press.origin === view) return;
    cancelPress();
    if (!button || button.disabled) return;
    var current = { button: button, kind: kind, origin: view, startedAt: Date.now(), timer: null,
      holdable: (view === 'home' || view === 'apps') && !!findApp(button.getAttribute('data-app')) };
    press = current;
    if (current.holdable) {
      button.classList.add('is-held');
      current.timer = window.setTimeout(function () {
        if (press !== current) return;
        pointerConsumed = true;
        openContext(button);
      }, 700);
    }
  }
  function releasePress(button) {
    if (enterDown || pointerDown) return;
    var current = press;
    var consumed = pointerConsumed;
    cancelPress();
    pointerConsumed = false;
    if (current || consumed) suppressClickUntil = Date.now() + 500;
    if (!current || consumed || current.origin !== view || !stage.contains(current.button) || button !== current.button) {
      flushCatalog();
      return;
    }
    // A busy TV may deliver release before the overdue timer callback.
    if (current.holdable && Date.now() - current.startedAt >= 700) openContext(current.button);
    else onAction(current.button);
    flushCatalog();
  }
  function cancelActivation() {
    cancelPress();
    enterDown = false;
    pointerDown = false;
    pointerConsumed = false;
    suppressClickUntil = Date.now() + 500;
  }
  stage.addEventListener('click', function (event) {
    // Never launch on a click synthesized before release, or on the click
    // accompanying an already handled short/long press (even after a re-render).
    if (press || enterDown || pointerDown || pointerConsumed || Date.now() < suppressClickUntil) { event.preventDefault(); return; }
    var button = closestButton(event.target);
    if (button && !button.disabled) onAction(button);
  });
  stage.addEventListener('error', function (event) {
    if (event.target.tagName === 'IMG' && event.target.classList.contains('installed-app-icon')) event.target.hidden = true;
  }, true);
  stage.addEventListener('mousedown', function (event) {
    if (event.button !== 0 && event.button !== 1) return;
    var button = closestButton(event.target);
    if (!button || button.disabled) return;
    if (!enterDown && !pointerDown) { pointerConsumed = false; suppressClickUntil = 0; }
    pointerDown = true;
    if (pointerConsumed) return;
    button.focus();
    beginPress(button, 'pointer');
  });
  window.addEventListener('mouseup', function (event) {
    if (event.button !== 0 && event.button !== 1) return;
    pointerDown = false;
    releasePress(closestButton(event.target));
  });
  stage.addEventListener('contextmenu', function (event) {
    var button = closestButton(event.target);
    if (!button || !findApp(button.getAttribute('data-app')) || view !== 'home' && view !== 'apps') return;
    event.preventDefault();
    suppressClickUntil = Date.now() + 500;
    button.focus();
    openContext(button);
  });
  stage.addEventListener('mouseleave', function () { if (press && pointerDown) cancelPress(); });
  stage.addEventListener('mousemove', function (event) {
    if (press || enterDown || pointerDown) return;
    var button = closestButton(event.target);
    if (button && button !== document.activeElement && (view === 'home' ? home.contains(button) : overlay.contains(button))) button.focus();
  });
  stage.addEventListener('focusin', function (event) {
    var button = closestButton(event.target);
    if (!button) return;
    var index = button.getAttribute('data-home-index');
    if (index !== null) {
      lastHomeIndex = Number(index);
      var tiles = rail.querySelectorAll('.tile');
      for (var i = 0; i < tiles.length; i++) tiles[i].classList.toggle('is-active', i === lastHomeIndex);
    } else if (button.id === 'all-apps-button' || button.id === 'settings-button' || button.id === 'network-button') lastHeaderId = button.id;
  });
  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    var key = event.keyCode;
    if (key === 13) {
      event.preventDefault();
      if (enterDown || event.repeat) return;
      if (!pointerDown) { pointerConsumed = false; suppressClickUntil = 0; }
      enterDown = true;
      if (pointerConsumed) return;
      beginPress(closestButton(document.activeElement), 'keyboard');
    } else if (key >= 37 && key <= 40) {
      event.preventDefault();
      cancelPress();
      moveFocus(key);
    }
    else if (key === 27 || key === 8 || key === 461) { event.preventDefault(); closeView(); }
    else if (key === 36 || key === 72) { event.preventDefault(); goHome(); }
    else if (key === 77 || key === 93 || key === 406) { event.preventDefault(); openContext(closestButton(document.activeElement)); }
    else if (key === 70) { event.preventDefault(); fullscreen(); }
    else if (key === 9) {
      cancelPress();
      var buttons = visibleButtons();
      if (!buttons.length) return;
      event.preventDefault();
      var index = buttons.indexOf(document.activeElement);
      index = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[index].focus();
      flushCatalog();
    }
  });
  document.addEventListener('keyup', function (event) {
    if (event.keyCode !== 13) return;
    event.preventDefault();
    enterDown = false;
    releasePress(closestButton(document.activeElement));
  });
  window.addEventListener('blur', cancelActivation);
  document.addEventListener('webOSLaunch', function (event) { handleNativeLaunch(event, true); });
  document.addEventListener('webOSRelaunch', function (event) { handleNativeLaunch(event, false); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) cancelActivation();
    else { loadApps(false); refreshNetwork().catch(function () {}); refreshWallpaper(); }
  });
  window.addEventListener('focus', function () { loadApps(false); refreshNetwork().catch(function () {}); refreshWallpaper(); });
  window.addEventListener('resize', fitStage);
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopClock(); else syncClock(); });
  document.addEventListener('webOSRelaunch', syncClock);
  window.addEventListener('focus', syncClock);
  restoreSettings();
  readFavorites();
  readCatalogOrder();
  if (savedFavorites !== null) {
    favorites = savedFavorites.slice();
    if (platform.getCachedHome) apps = platform.getCachedHome(favorites);
  }
  applySettings();
  setupWallpaper();
  refreshWallpaper();
  renderHome();
  fitStage();
  syncClock(true);
  focusHome();
  updatePriorities();
  loadApps(true);
  handleColdLaunch();
  refreshNetwork().catch(function () {});
}());

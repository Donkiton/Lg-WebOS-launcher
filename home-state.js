(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LauncherHomeState = factory();
}(this, function () {
  'use strict';
  var limit = 6;
  var pageSize = 18;
  var columns = 6;
  function selection(ids) {
    var result = [];
    if (!Array.isArray(ids)) return result;
    ids.forEach(function (id) {
      if (typeof id === 'string' && id && id !== '__all__' && result.indexOf(id) < 0 && result.length < limit) result.push(id);
    });
    return result;
  }
  function normalize(ids, apps) {
    var result = [];
    if (!Array.isArray(ids)) return result;
    ids.forEach(function (id) {
      if (typeof id === 'string' && result.indexOf(id) < 0 && apps.some(function (app) { return app.id === id; }) && result.length < limit) result.push(id);
    });
    return result;
  }
  function defaults(apps) {
    var result = [];
    ['youtube', 'okko', 'rutube', 'ivi', 'zona', 'msx'].forEach(function (brand) {
      var match = apps.filter(function (app) { return (app.brand || app.id) === brand; })[0];
      if (match && result.length < limit && result.indexOf(match.id) < 0) result.push(match.id);
    });
    apps.forEach(function (app) { if (result.length < limit && result.indexOf(app.id) < 0) result.push(app.id); });
    return result;
  }
  function add(ids, id) {
    if (ids.indexOf(id) >= 0) return ids.slice();
    return ids.length < limit ? ids.concat([id]) : null;
  }
  function replace(ids, index, id) {
    if (index < 0 || index >= ids.length || ids.indexOf(id) >= 0) return null;
    var result = ids.slice();
    result[index] = id;
    return result;
  }
  function remove(ids, id) { return ids.filter(function (item) { return item !== id; }); }
  function move(ids, id, target) {
    var result = ids.slice();
    var from = result.indexOf(id);
    if (from < 0 || target < 0 || target >= result.length) return result;
    result.splice(from, 1);
    result.splice(target, 0, id);
    return result;
  }

  function indexApps(apps) {
    var indexed = { ids: [], byId: Object.create(null) };
    if (!Array.isArray(apps)) return indexed;
    apps.forEach(function (app) {
      if (!app || typeof app.id !== 'string' || !app.id || indexed.byId[app.id]) return;
      indexed.ids.push(app.id);
      indexed.byId[app.id] = app;
    });
    return indexed;
  }

  // Move old preview choices to service-supplied IDs without resetting their order.
  function migrateIds(ids, apps, aliases) {
    var indexed = indexApps(apps);
    var result = [];
    if (!Array.isArray(ids)) return result;
    ids.forEach(function (id) {
      if (typeof id !== 'string') return;
      var actual = indexed.byId[id] ? id : '';
      var brand = aliases && Object.prototype.hasOwnProperty.call(aliases, id) ? aliases[id] : id;
      if (!actual) {
        for (var i = 0; i < indexed.ids.length; i++) {
          if (indexed.byId[indexed.ids[i]].brand === brand) { actual = indexed.ids[i]; break; }
        }
      }
      if (actual && result.indexOf(actual) < 0) result.push(actual);
    });
    return result;
  }

  // This baseline is independent of the home favourites. Removing a pin can
  // therefore return its app to the original position among unpinned apps.
  function mergeCatalogOrder(savedIds, apps) {
    var indexed = indexApps(apps);
    var seen = Object.create(null);
    var result = [];
    function append(id) {
      if (typeof id !== 'string' || !indexed.byId[id] || seen[id]) return;
      seen[id] = true;
      result.push(id);
    }
    if (Array.isArray(savedIds)) savedIds.forEach(append);
    indexed.ids.forEach(append);
    return result;
  }

  function sourceConfirmed(id, status) {
    return id.indexOf('msx:') === 0 ? status.msxComplete === true : status.nativeComplete === true;
  }

  // Cached cards and partial service replies cannot prove an app was removed.
  // A successful snapshot only authorizes pruning its own source.
  function reconcile(previous, incoming, status) {
    var indexed = indexApps(incoming);
    var result = indexed.ids.map(function (id) { return indexed.byId[id]; });
    var old = indexApps(previous);
    old.ids.forEach(function (id) {
      if (!indexed.byId[id] && !sourceConfirmed(id, status || {})) result.push(old.byId[id]);
    });
    return result;
  }

  function reconcileIds(ids, apps, status, cap) {
    var indexed = indexApps(apps);
    var result = [];
    (Array.isArray(ids) ? ids : []).forEach(function (id) {
      if (typeof id !== 'string' || !id || result.indexOf(id) >= 0 || cap && result.length >= cap) return;
      if (indexed.byId[id] || !sourceConfirmed(id, status || {})) result.push(id);
    });
    return result;
  }

  function reconcileOrder(ids, apps, status) {
    var result = reconcileIds(ids, apps, status);
    indexApps(apps).ids.forEach(function (id) { if (result.indexOf(id) < 0) result.push(id); });
    return result;
  }

  function catalog(apps, favorites, baseIds) {
    var indexed = indexApps(apps);
    var baseline = mergeCatalogOrder(baseIds, apps);
    var validApps = indexed.ids.map(function (id) { return indexed.byId[id]; });
    var pinned = normalize(favorites, validApps);
    var ordered = pinned.concat(baseline.filter(function (id) { return pinned.indexOf(id) < 0; }));
    return ordered.map(function (id) { return indexed.byId[id]; });
  }

  function normalizeTotal(total) {
    return typeof total === 'number' && isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  }

  function clampPage(page, count) {
    var numeric = Number(page);
    if (isNaN(numeric)) numeric = 0;
    return Math.max(0, Math.min(count - 1, Math.floor(numeric)));
  }

  function paginate(items, pageIndex) {
    var list = Array.isArray(items) ? items : [];
    var count = Math.max(1, Math.ceil(list.length / pageSize));
    var page = clampPage(pageIndex, count);
    var start = page * pageSize;
    return { items: list.slice(start, start + pageSize), page: page, count: count, total: list.length, start: start };
  }

  // index is relative to the current page, not an absolute catalogue index.
  // null lets the UI handle focus on Back and other non-grid controls itself.
  function navigatePage(total, page, index, keyCode) {
    var length = normalizeTotal(total);
    if (!length || keyCode !== 37 && keyCode !== 38 && keyCode !== 39 && keyCode !== 40) return null;
    var count = Math.ceil(length / pageSize);
    var currentPage = clampPage(page, count);
    var currentSize = Math.min(pageSize, length - currentPage * pageSize);
    if (typeof index !== 'number' || !isFinite(index) || Math.floor(index) !== index || index < 0 || index >= currentSize) return null;

    var row = Math.floor(index / columns);
    var column = index % columns;
    var nextIndex = index;
    var nextPage = currentPage;
    if (keyCode === 39) {
      if (column < columns - 1) {
        if (index + 1 < currentSize) nextIndex = index + 1;
      } else if (currentPage < count - 1) {
        nextPage++;
        var nextSize = Math.min(pageSize, length - nextPage * pageSize);
        nextIndex = Math.min(row * columns, nextSize - 1);
      }
    } else if (keyCode === 37) {
      if (column > 0) nextIndex = index - 1;
      else if (currentPage > 0) {
        nextPage--;
        nextIndex = row * columns + columns - 1;
      }
    } else if (keyCode === 38) {
      if (row > 0) nextIndex = index - columns;
    } else if (row < Math.floor((currentSize - 1) / columns)) {
      nextIndex = Math.min(index + columns, currentSize - 1);
    }
    return { page: nextPage, index: nextIndex };
  }

  return {
    limit: limit, selection: selection, normalize: normalize, defaults: defaults, migrateIds: migrateIds, add: add, replace: replace, remove: remove, move: move,
    reconcile: reconcile, reconcileIds: reconcileIds, reconcileOrder: reconcileOrder,
    pageSize: pageSize, columns: columns, mergeCatalogOrder: mergeCatalogOrder, catalog: catalog,
    paginate: paginate, navigatePage: navigatePage
  };
}));

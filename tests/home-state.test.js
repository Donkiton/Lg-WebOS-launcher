'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../home-state');
const apps = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, name: id }));
test('Сохранённые карточки: удалённые приложения и дубли исключаются, шесть мест доступны', () => {
  assert.deepEqual(state.normalize(['missing', 'b', 'b', 'a', 'c', 'd', 'e', 'f'], apps), ['b', 'a', 'c', 'd', 'e', 'f']);
  assert.deepEqual(state.normalize([], apps), []);
  assert.deepEqual(state.normalize({}, apps), []);
});
test('Первое заполнение использует реальные идентификаторы установленных приложений', () => {
  const catalog = [{ id: 'other' }, { id: 'actual.youtube.id', brand: 'youtube' }, { id: 'actual.ivi.id', brand: 'ivi' }];
  assert.deepEqual(state.defaults(catalog), ['actual.youtube.id', 'actual.ivi.id', 'other']);
});
test('Сохранённый порядок прототипа переносится на реальные ID без случайных приложений', () => {
  const actual = [
    { id: 'youtube.leanback.v4', brand: 'youtube' },
    { id: 'com.685631.3411', brand: 'kinopoisk' },
    { id: 'de.benzac.msx', brand: 'msx' },
    { id: 'rutube', brand: 'rutube' },
    { id: 'yota.play', brand: 'okko' }
  ];
  const before = ['youtube', 'kinopoisk', 'zona', 'rutube', 'okko', 'preview.netflix'];
  assert.deepEqual(state.migrateIds(before, actual, { zona: 'msx' }), actual.map(app => app.id));
  assert.deepEqual(before, ['youtube', 'kinopoisk', 'zona', 'rutube', 'okko', 'preview.netflix']);
  assert.deepEqual(state.migrateIds(['de.benzac.msx', 'msx', 'missing'], actual), ['de.benzac.msx']);
  assert.deepEqual(state.migrateIds([], actual), []);
});
test('Начальный экран использует установленный MSX, когда отдельной Zona нет, и не превышает шесть мест', () => {
  const actual = ['youtube', 'okko', 'rutube', 'ivi', 'msx'].map(brand => ({ id: 'real.' + brand, brand }));
  const withKidsFirst = [{ id: 'real.kids', brand: 'kids' }].concat(actual);
  assert.deepEqual(state.defaults(withKidsFirst), actual.map(app => app.id).concat(['real.kids']));
  assert.deepEqual(state.defaults(withKidsFirst.concat([{ id: 'real.zona', brand: 'zona' }])), ['real.youtube', 'real.okko', 'real.rutube', 'real.ivi', 'real.zona', 'real.msx']);
});
test('Занятые шесть мест требуют выбора замены без предварительного удаления', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.equal(state.add(before, 'g'), null);
  assert.deepEqual(state.add(before.slice(0, 5), 'f'), before);
  assert.deepEqual(state.replace(before, 2, 'g'), ['a', 'b', 'g', 'd', 'e', 'f']);
  assert.deepEqual(before, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(state.replace(before, 3, 'a'), null);
});
test('Удаление с главного не меняет каталог; пустой список остаётся пустым', () => {
  assert.deepEqual(state.remove(['a'], 'a'), []);
  assert.equal(apps.length, 6);
  assert.deepEqual(state.add(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(state.add(['a'], 'a'), ['a']);
});
test('Перестановка — независимый черновик: отмена сохраняет исходный порядок', () => {
  const before = ['a', 'b', 'c', 'd', 'e'];
  const draft = state.move(before, 'b', 3);
  assert.deepEqual(draft, ['a', 'c', 'd', 'b', 'e']);
  assert.deepEqual(before, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(state.move(draft, 'b', 0), ['b', 'a', 'c', 'd', 'e']);
  assert.deepEqual(state.move(before, 'a', -1), before);
});

test('Базовый порядок сохраняется при перестановках службы, удалениях и новых приложениях', () => {
  const baseline = ['c', 'a', 'b', 'missing', 'c'];
  const observed = [{ id: 'b' }, { id: 'd' }, { id: 'c' }, { id: 'a' }, { id: 'd' }, { id: 'e' }];
  assert.deepEqual(state.mergeCatalogOrder(baseline, observed), ['c', 'a', 'b', 'd', 'e']);
  assert.deepEqual(baseline, ['c', 'a', 'b', 'missing', 'c']);
  const installedLater = [{ id: 'e' }, { id: 'd' }, { id: 'b' }, { id: 'f' }];
  assert.deepEqual(state.mergeCatalogOrder(['c', 'a', 'b', 'd', 'e'], installedLater), ['b', 'd', 'e', 'f']);
});

test('Каталог исключает невалидные и повторные записи без изменения объектов приложений', () => {
  const first = Object.freeze({ id: '__proto__', name: 'Особый ID' });
  const second = Object.freeze({ id: 'b', name: 'Первая запись' });
  const observed = Object.freeze([null, {}, { id: '' }, { id: 3 }, first, second, { id: 'b', name: 'Повтор' }]);
  const base = Object.freeze(['missing', '__proto__', '__proto__']);
  assert.deepEqual(state.mergeCatalogOrder(base, observed), ['__proto__', 'b']);
  const result = state.catalog(observed, ['b'], base);
  assert.deepEqual(result.map(app => app.id), ['b', '__proto__']);
  assert.equal(result[0], second);
  assert.equal(result[1], first);
  assert.deepEqual(state.mergeCatalogOrder(null, null), []);
  assert.deepEqual(state.catalog(null, null, null), []);
});

test('Первые шесть валидных избранных идут точно как на главном, остальное — по базе', () => {
  const observed = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => ({ id }));
  const baseline = ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'];
  const pins = ['missing', 'c', 'c', 'a', 'h', 'f', 'd', 'b'];
  assert.deepEqual(state.catalog(observed, pins, baseline).map(app => app.id), ['c', 'a', 'h', 'f', 'd', 'b', 'g', 'e']);
  assert.deepEqual(pins, ['missing', 'c', 'c', 'a', 'h', 'f', 'd', 'b']);
  assert.deepEqual(baseline, ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']);
});

test('Перестановка, замена и снятие избранного не меняют базовый порядок каталога', () => {
  const baseline = state.mergeCatalogOrder([], apps);
  let pins = ['d', 'b', 'a', 'c', 'e'];
  assert.deepEqual(state.catalog(apps, pins, baseline).map(app => app.id), ['d', 'b', 'a', 'c', 'e', 'f']);
  pins = state.move(pins, 'd', 3);
  assert.deepEqual(state.catalog(apps, pins, baseline).map(app => app.id), ['b', 'a', 'c', 'd', 'e', 'f']);
  pins = state.replace(pins, 1, 'f');
  assert.deepEqual(state.catalog(apps, pins, baseline).map(app => app.id), ['b', 'f', 'c', 'd', 'e', 'a']);
  pins = state.remove(pins, 'd');
  assert.deepEqual(state.catalog(apps, pins, baseline).map(app => app.id), ['b', 'f', 'c', 'e', 'a', 'd']);
  assert.deepEqual(state.catalog(apps, [], baseline).map(app => app.id), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(baseline, ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('Новые приложения дописываются после прежней базы и не перемешивают каталог', () => {
  const baseline = state.mergeCatalogOrder([], apps);
  const refreshed = [{ id: 'new-first' }].concat(apps.slice().reverse(), [{ id: 'new-second' }]);
  const merged = state.mergeCatalogOrder(baseline, refreshed);
  assert.deepEqual(merged, ['a', 'b', 'c', 'd', 'e', 'f', 'new-first', 'new-second']);
  assert.deepEqual(state.catalog(refreshed, ['e', 'b'], merged).map(app => app.id), ['e', 'b', 'a', 'c', 'd', 'f', 'new-first', 'new-second']);
  assert.deepEqual(state.catalog(refreshed, [], merged).map(app => app.id), merged);
});

test('Страницы 0/1/18/19/36/37/137 содержат все элементы ровно один раз', () => {
  assert.equal(state.limit, 6);
  assert.equal(state.pageSize, 18);
  assert.equal(state.columns, 6);
  for (const total of [0, 1, 18, 19, 36, 37, 137]) {
    const catalog = Array.from({ length: total }, (_, id) => ({ id: String(id) }));
    const count = Math.max(1, Math.ceil(total / 18));
    const concatenated = [];
    for (let page = 0; page < count; page++) {
      const result = state.paginate(catalog, page);
      assert.equal(result.page, page);
      assert.equal(result.count, count);
      assert.equal(result.total, total);
      assert.equal(result.start, page * 18);
      assert.equal(result.items.length, Math.min(18, Math.max(0, total - page * 18)));
      concatenated.push(...result.items);
    }
    assert.deepEqual(concatenated, catalog);
    assert.equal(new Set(concatenated.map(app => app.id)).size, total);
    assert.equal(catalog.length, total);
  }
});

test('Номер страницы ограничен целым доступным диапазоном, срез независимый', () => {
  const catalog = Array.from({ length: 37 }, (_, id) => id);
  assert.equal(state.paginate(catalog, -20).page, 0);
  assert.equal(state.paginate(catalog, 1.9).page, 1);
  assert.equal(state.paginate(catalog, 900).page, 2);
  assert.equal(state.paginate(catalog, Infinity).page, 2);
  assert.equal(state.paginate(catalog, NaN).page, 0);
  assert.equal(state.paginate(catalog).page, 0);
  const first = state.paginate(catalog, 0);
  first.items.pop();
  assert.equal(catalog.length, 37);
  assert.deepEqual(state.paginate([], 100), { items: [], page: 0, count: 1, total: 0, start: 0 });
});

test('Горизонтальный переход листает страницы только через край шести столбцов', () => {
  assert.deepEqual(state.navigatePage(36, 0, 1, 39), { page: 0, index: 2 });
  assert.deepEqual(state.navigatePage(36, 0, 2, 37), { page: 0, index: 1 });
  for (let row = 0; row < 3; row++) {
    assert.deepEqual(state.navigatePage(36, 0, row * 6 + 5, 39), { page: 1, index: row * 6 });
    assert.deepEqual(state.navigatePage(36, 1, row * 6, 37), { page: 0, index: row * 6 + 5 });
    assert.deepEqual(state.navigatePage(36, 0, row * 6, 37), { page: 0, index: row * 6 });
    assert.deepEqual(state.navigatePage(36, 1, row * 6 + 5, 39), { page: 1, index: row * 6 + 5 });
  }
});

test('Переход на короткую страницу ограничивает позицию последней карточкой', () => {
  for (const index of [5, 11, 17]) assert.deepEqual(state.navigatePage(19, 0, index, 39), { page: 1, index: 0 });
  assert.deepEqual(state.navigatePage(19, 1, 0, 37), { page: 0, index: 5 });
  assert.deepEqual(state.navigatePage(37, 1, 17, 39), { page: 2, index: 0 });
  assert.deepEqual(state.navigatePage(37, 2, 0, 37), { page: 1, index: 5 });
  assert.deepEqual(state.navigatePage(26, 0, 11, 39), { page: 1, index: 6 });
  assert.deepEqual(state.navigatePage(26, 0, 17, 39), { page: 1, index: 7 });
  assert.deepEqual(state.navigatePage(26, 1, 7, 39), { page: 1, index: 7 });
});

test('Вертикальная навигация остаётся на странице и ограничивает неполную строку', () => {
  assert.deepEqual(state.navigatePage(32, 1, 4, 40), { page: 1, index: 10 });
  assert.deepEqual(state.navigatePage(32, 1, 10, 40), { page: 1, index: 13 });
  assert.deepEqual(state.navigatePage(32, 1, 12, 40), { page: 1, index: 12 });
  assert.deepEqual(state.navigatePage(32, 1, 13, 40), { page: 1, index: 13 });
  assert.deepEqual(state.navigatePage(32, 1, 12, 38), { page: 1, index: 6 });
  assert.deepEqual(state.navigatePage(32, 1, 13, 38), { page: 1, index: 7 });
  assert.deepEqual(state.navigatePage(32, 1, 4, 38), { page: 1, index: 4 });
  assert.deepEqual(state.navigatePage(19, 1, 0, 40), { page: 1, index: 0 });
});

test('Пустая сетка, фокус вне карточек и неподдерживаемые кнопки дают null', () => {
  assert.equal(state.navigatePage(0, 0, 0, 39), null);
  for (const index of [null, undefined, -1, 18, 1.5, NaN, Infinity, '0']) assert.equal(state.navigatePage(18, 0, index, 39), null);
  assert.equal(state.navigatePage(19, 1, 1, 39), null);
  assert.equal(state.navigatePage(18, 0, 0, 13), null);
  assert.equal(state.navigatePage(Infinity, 0, 0, 39), null);
});

test('Любой переход в большом каталоге остаётся в существующей странице и карточке', () => {
  for (const total of [1, 18, 19, 36, 37, 137]) {
    for (let absolute = 0; absolute < total; absolute++) {
      const page = Math.floor(absolute / 18);
      const index = absolute % 18;
      for (const key of [37, 38, 39, 40]) {
        const next = state.navigatePage(total, page, index, key);
        assert.ok(next.page >= 0 && next.page < Math.ceil(total / 18));
        assert.ok(next.index >= 0 && next.index < 18);
        assert.ok(next.page * 18 + next.index < total);
        if (key === 38 || key === 40) assert.equal(next.page, page);
      }
    }
  }
});

test('Неполные ответы сохраняют карточки, выбор и базу до подтверждения своего источника', () => {
  const cached = [{ id: 'native.old' }, { id: 'msx:old' }];
  const incoming = [{ id: 'native.new' }];
  const native = { nativeComplete: true, msxComplete: false };
  const merged = state.reconcile(cached, incoming, native);
  assert.deepEqual(merged.map(app => app.id), ['native.new', 'msx:old']);
  assert.deepEqual(state.reconcileIds(['native.old', 'msx:old'], merged, native, 6), ['msx:old']);
  assert.deepEqual(state.reconcileOrder(['native.old', 'native.unseen', 'msx:old', 'msx:unseen'], merged, native), ['msx:old', 'msx:unseen', 'native.new']);
  assert.deepEqual(state.reconcile(cached, [], {}).map(app => app.id), ['native.old', 'msx:old']);
  assert.deepEqual(state.reconcile(cached, [], { msxComplete: true }).map(app => app.id), ['native.old']);
  assert.deepEqual(state.reconcileIds(['native.old', 'msx:old'], [], {}), ['native.old', 'msx:old']);
  assert.deepEqual(state.reconcileOrder(['native.old', 'msx:old'], [], { nativeComplete: true, msxComplete: true }), []);
});

test('Выбор не зависит от наличия карточки в частичном кеше и старые пять не дополняются сами', () => {
  assert.deepEqual(state.selection(['a', 'missing', 'a', 'b', 'c', 'd', 'e', 'f']), ['a', 'missing', 'b', 'c', 'd', 'e']);
  assert.deepEqual(state.selection(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(state.selection(['__all__', null, '', 5]), []);
});

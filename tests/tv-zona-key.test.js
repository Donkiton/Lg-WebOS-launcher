'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../tv/usp-zona.js'), 'utf8');
function fixture() {
  const launches = [];
  const context = {
    WebOS: { Key_webOS_USP: 50001, Key_webOS_IVI: 50002 }, KeyPolicy: { NextPolicy: 0, Accepted: 1 },
    access: { keyAction: { launchApp: true } }, bootManager: { bootFirstUse: false }, systemPropertyService: { powerOnlyMode: false },
    nudgeView: { visible: false, close() { this.visible = false; } },
    applicationManager: { launch(...args) { launches.push(args); } }
  };
  vm.runInNewContext(source, context);
  return { launches, context, press: (pressed = true, repeat = false, key = context.WebOS.Key_webOS_USP) => context.handleUspZona(key, pressed, repeat) };
}
test('USP отправляет одну команду Zona в LG Gate, без URL, и поглощает отпускание/повторы', () => {
  const f = fixture(); f.context.init();
  assert.equal(f.press(), 1); assert.equal(f.press(true, true), 1); assert.equal(f.press(false), 1);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0][0], 'org.lggate.launcher');
  assert.deepEqual(JSON.parse('{' + f.launches[0][1] + '}'), { shortcut: 'zona', reason: 'hotkey' });
  assert.deepEqual(f.launches[0].slice(2), [false, false]);
});
test('IVI, Home, Back и стрелки не перехватываются фильтром Zona', () => {
  const f = fixture();
  for (const key of [f.context.WebOS.Key_webOS_IVI, 1039, 13, 461, 36, 37]) {
    assert.equal(f.press(true, false, key), 0); assert.equal(f.press(false, false, key), 0);
  }
  assert.equal(f.launches.length, 0);
});
test('Запрет запуска и первый запуск ТВ соблюдаются правилом Zona', () => {
  for (const change of [c => { c.access.keyAction.launchApp = false; }, c => { c.bootManager.bootFirstUse = true; }]) {
    const f = fixture(); change(f.context); assert.equal(f.press(), 1); assert.equal(f.launches.length, 0);
  }
});

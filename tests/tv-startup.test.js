'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateDeployment } = require('../scripts/manage-tv-startup');
test('Установщик отличает собственную запись автозапуска от чужой или повреждённой', () => {
  const record = { version: 1, appId: 'org.lggate.launcher', runtimeHash: 'a'.repeat(64), hookHash: 'b'.repeat(64) };
  assert.equal(validateDeployment(record), record);
  for (const value of [null, {}, { ...record, appId: 'other' }, { ...record, version: 2 }, { ...record, runtimeHash: '../file' }, { ...record, hookHash: '' }]) assert.throws(() => validateDeployment(value));
});

function installerFixture(record, runtimeHash = 'a'.repeat(64)) {
  const commands = [];
  const filename = path.resolve(__dirname, '../scripts/manage-tv-startup.js');
  const module = { exports: {} };
  const remote = {
    APP_ID: 'org.lggate.launcher',
    quote: value => "'" + value + "'",
    validateBackup: value => value,
    ssh: async command => {
      commands.push(command);
      if (command.startsWith('if test -f \'/var/lib/lg-gate/startup-deployment.json\'')) return JSON.stringify(record);
      if (command.startsWith('sha256sum ')) return runtimeHash + '  /var/lib/lg-gate/launcher-startup.py';
      if (command.startsWith('if test -f \'/var/lib/lg-gate/startup-enabled\'')) return 'enabled\n/usr/bin/python /var/lib/lg-gate/launcher-startup.py --run\n';
      return '';
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    require: name => name === './manage-tv-home' ? remote : require(name),
    setTimeout, console,
  }, { filename });
  return { api: module.exports, commands };
}

test('Откат Back оставляет автозапуск и назначение Home включёнными', async () => {
  const record = { version: 1, appId: 'org.lggate.launcher', runtimeHash: 'a'.repeat(64), hookHash: 'b'.repeat(64), backReturnVersion: 1 };
  const fixture = installerFixture(record);
  const status = await fixture.api.setBackEnabled(false);
  assert.equal(status.enabled, true);
  assert.equal(status.running, true);
  assert.equal(status.backEnabled, false);
  const mutations = fixture.commands.filter(command => command.startsWith('rm ') || command.startsWith('touch ') || command.includes('kill -'));
  assert.deepEqual(mutations, ["rm -f '/var/lib/lg-gate/back-enabled'"]);
});

test('Возврат Back нельзя включить для старого или изменённого runtime', async () => {
  const record = { version: 1, appId: 'org.lggate.launcher', runtimeHash: 'a'.repeat(64), hookHash: 'b'.repeat(64) };
  const old = installerFixture(record);
  await assert.rejects(old.api.setBackEnabled(true), /поддержкой/);
  assert.equal(old.commands.some(command => command.startsWith('touch ')), false);
  const modified = installerFixture({ ...record, backReturnVersion: 1 }, 'c'.repeat(64));
  await assert.rejects(modified.api.setBackEnabled(true), /изменён/);
  assert.equal(modified.commands.some(command => command.startsWith('touch ')), false);
});

test('Повторное включение Back проверяет контрольную сумму принадлежащего LG Gate runtime', async () => {
  const record = { version: 1, appId: 'org.lggate.launcher', runtimeHash: 'a'.repeat(64), hookHash: 'b'.repeat(64), backReturnVersion: 1 };
  const fixture = installerFixture(record);
  await fixture.api.setBackEnabled(true);
  const hashCheck = fixture.commands.findIndex(command => command.startsWith('sha256sum '));
  const flagWrite = fixture.commands.findIndex(command => command === "touch '/var/lib/lg-gate/back-enabled'");
  assert.ok(hashCheck >= 0 && flagWrite > hashCheck);
});

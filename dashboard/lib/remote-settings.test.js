'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRemoteSettings } = require('./remote-settings');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sym-rs-')), 'sous', 'remote-settings.json');

test('par defaut : auto (le proprietaire veut pouvoir commander sans etre devant le PC)', () => {
  assert.equal(createRemoteSettings({ filePath: tmp() }).getMode(), 'auto');
});

test('on peut passer en ask puis revenir en auto ; le choix survit a un redemarrage', () => {
  const f = tmp();
  const s = createRemoteSettings({ filePath: f });
  assert.equal(s.setMode('ask'), 'ask');
  assert.equal(createRemoteSettings({ filePath: f }).getMode(), 'ask');
  s.setMode('auto');
  assert.equal(createRemoteSettings({ filePath: f }).getMode(), 'auto');
});

test('valeur invalide refusee, fichier corrompu = auto', () => {
  const f = tmp();
  const s = createRemoteSettings({ filePath: f });
  for (const bad of ['', 'yes', 'ASK', null, undefined, 1, {}]) assert.throws(() => s.setMode(bad), /bad_mode/);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{pas du json');
  assert.equal(s.getMode(), 'auto');
  fs.writeFileSync(f, JSON.stringify({ commandMode: 'n importe quoi' }));
  assert.equal(s.getMode(), 'auto');
});

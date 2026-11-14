'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnHeadless } = require('./spawn-headless');

test('Qwen cannot claim write or read confinement without an enforced adapter', () => {
  for (const opts of [{ readOnly: true }, { confineWrites: true }]) {
    assert.throws(() => spawnHeadless.call({}, { cli: 'qwen', prompt: 'x', ...opts }), /Qwen.*confinement/i);
  }
});

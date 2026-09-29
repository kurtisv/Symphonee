'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { probeExistingInstance } = require('./instance-probe');
const { shouldReload } = require('./crash-guard');

// Fake http.get: each call consumes the next scripted outcome.
function scriptedGet(outcomes) {
  let i = 0;
  const get = (_url, _opts, onRes) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    const o = outcomes[Math.min(i++, outcomes.length - 1)];
    setImmediate(() => {
      if (o === 'alive') onRes({ resume() {} });
      else if (o === 'timeout') req.emit('timeout');
      else req.emit('error', Object.assign(new Error(o), { code: o }));
    });
    return req;
  };
  get.calls = () => i;
  return get;
}
const noSleep = async () => {};

test('instance probe: a responding server is alive (never killed)', async () => {
  assert.strictEqual(await probeExistingInstance({ host: 'h', port: 1, get: scriptedGet(['alive']), sleep: noSleep }), 'alive');
});

test('instance probe: a slow/timing-out server is NOT treated as dead', async () => {
  const get = scriptedGet(['timeout', 'timeout', 'timeout']);
  assert.strictEqual(await probeExistingInstance({ host: 'h', port: 1, get, sleep: noSleep }), 'slow');
  assert.strictEqual(get.calls(), 3);
});

test('instance probe: slow then answering is alive', async () => {
  assert.strictEqual(await probeExistingInstance({ host: 'h', port: 1, get: scriptedGet(['timeout', 'alive']), sleep: noSleep }), 'alive');
});

test('instance probe: only refused on every probe is dead', async () => {
  const get = scriptedGet(['ECONNREFUSED', 'ECONNREFUSED', 'ECONNREFUSED']);
  assert.strictEqual(await probeExistingInstance({ host: 'h', port: 1, get, sleep: noSleep }), 'dead');
  assert.strictEqual(get.calls(), 3);
  assert.strictEqual(await probeExistingInstance({ host: 'h', port: 1, get: scriptedGet(['ECONNREFUSED', 'ECONNRESET', 'ECONNREFUSED']), sleep: noSleep }), 'slow');
});

test('crash guard: renderer reload is bounded to avoid a crash loop', () => {
  const h = [];
  assert.strictEqual(shouldReload(h, 0), true);
  assert.strictEqual(shouldReload(h, 1000), true);
  assert.strictEqual(shouldReload(h, 2000), true);
  assert.strictEqual(shouldReload(h, 3000), false);
  assert.strictEqual(shouldReload(h, 10 * 60 * 1000), true);
});

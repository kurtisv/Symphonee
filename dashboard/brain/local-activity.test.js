'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createLocalActivity } = require('./local-activity');
const { mountBrain } = require('./index');
const localAnswer = require('./local-answer');

test('direct local activity counts concurrent requests and closes idempotently without content', () => {
  let clock = 10; const events = [];
  const activity = createLocalActivity({ now: () => clock, broadcast: e => events.push(e) });
  const endA = activity.begin(); clock = 11; const endB = activity.begin();
  assert.deepEqual(activity.snapshot(), { activeCount: 2, startedAt: 10, updatedAt: 11, scope: 'direct-local-ask' });
  clock = 12; endA(); endA();
  assert.equal(activity.snapshot().activeCount, 1);
  clock = 13; endB();
  assert.deepEqual(activity.snapshot(), { activeCount: 0, startedAt: null, updatedAt: 13, scope: 'direct-local-ask' });
  assert.equal(events.length, 4);
  assert.ok(events.every(e => e.type === 'symphonee-local-activity' && Object.keys(e.payload).sort().join(',') === 'activeCount,scope,startedAt,updatedAt'));
});

test('broadcast failure cannot break a local request', () => {
  const activity = createLocalActivity({ broadcast() { throw new Error('offline'); } });
  const end = activity.begin();
  assert.equal(activity.snapshot().activeCount, 1);
  end(); assert.equal(activity.snapshot().activeCount, 0);
});

test('fast and streaming ask expose actual pending activity and clear it on failures', async (t) => {
  const routes = new Map(), events = [];
  const brain = mountBrain((method, path, fn) => routes.set(method + ' ' + path, fn), (res, data, status) => { res.data = data; res.status = status || 200; return data; }, {
    repoRoot: process.cwd(), broadcast: e => events.push(e), getUiContext: () => ({}),
  });
  t.after(() => { brain.stopBrainStatus(); brain.stopObserver(); });
  let finishFast, failStream;
  t.mock.method(localAnswer, 'localAnswer', () => new Promise(resolve => { finishFast = resolve; }));
  t.mock.method(localAnswer, 'deepAnswer', () => new Promise((_, reject) => { failStream = reject; }));
  const req = body => Readable.from([JSON.stringify(body)]);
  const fastRes = {};
  const streamRes = { writeHead() {}, write() {}, end() {} };
  const fast = routes.get('POST /api/symphonee/ask')(req({ input: 'private fast prompt', fast: true }), fastRes);
  const stream = routes.get('POST /api/symphonee/ask/stream')(req({ input: 'private stream prompt' }), streamRes);
  await new Promise(resolve => setImmediate(resolve));
  const statusRes = {};
  routes.get('GET /api/symphonee/activity')({}, statusRes);
  assert.equal(statusRes.data.activeCount, 2);
  finishFast({ grounded: true, answer: 'private response', model: 'local' });
  await fast;
  routes.get('GET /api/symphonee/activity')({}, statusRes);
  assert.equal(statusRes.data.activeCount, 1);
  failStream(new Error('private failure'));
  await stream;
  routes.get('GET /api/symphonee/activity')({}, statusRes);
  assert.equal(statusRes.data.activeCount, 0);
  const activityEvents = events.filter(e => e.type === 'symphonee-local-activity');
  assert.deepEqual(activityEvents.map(e => e.payload.activeCount), [1, 2, 1, 0]);
  assert.doesNotMatch(JSON.stringify(activityEvents), /private/);
});

test('fast ask clears activity when the local answer rejects', async (t) => {
  const routes = new Map();
  const brain = mountBrain((method, path, fn) => routes.set(method + ' ' + path, fn), (res, data) => { res.data = data; }, {
    repoRoot: process.cwd(), getUiContext: () => ({}),
  });
  t.after(() => { brain.stopBrainStatus(); brain.stopObserver(); });
  t.mock.method(localAnswer, 'localAnswer', async () => { throw new Error('generation failed'); });
  await assert.rejects(routes.get('POST /api/symphonee/ask')(Readable.from([JSON.stringify({ input: 'question', fast: true })]), {}), /generation failed/);
  const res = {};
  routes.get('GET /api/symphonee/activity')({}, res);
  assert.equal(res.data.activeCount, 0);
});

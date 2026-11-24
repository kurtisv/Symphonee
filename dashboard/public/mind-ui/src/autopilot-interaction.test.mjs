import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { makeLatest } from './latest.js';
import { createSnapshotStore } from './autopilot-state.js';
import { cardModel, cardHtml, CARD_CSS } from './autopilot-card.js';
import { pilotIdsFrom, calendarModel, kpiModel, kpiHtml, calendarHtml, OVERVIEW_CSS } from './autopilot-overview.js';

function harness() {
  const main = { innerHTML: '' }, pending = [], posts = [], elements = {};
  const response = data => ({ ok: true, json: async () => data });
  const context = vm.createContext({
    $, state: { view: 'other' }, escapeHtml: s => String(s).replaceAll('<', '&lt;'), makeLatest, createSnapshotStore,
    cardModel, cardHtml, CARD_CSS, pilotIdsFrom, calendarModel, kpiModel, kpiHtml, calendarHtml, OVERVIEW_CSS,
    localStorage: { getItem() {}, setItem() {} }, window: { confirm: () => false },
    Date, Promise, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch(url, opts = {}) {
      if (opts.method === 'POST') { posts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve(response({ pilot: 'default', updatedAt: 400 })); }
      if (!url.startsWith('/api/mind/autopilot?')) return Promise.resolve(response({}));
      return new Promise(resolve => pending.push({ url, resolve: data => resolve(response(data)) }));
    },
  });
  function $(id) { return id === 'mindMain' ? main : elements[id] || null; }
  const source = fs.readFileSync(new URL('./autopilot.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export .*;\r?$/gm, '');
  vm.runInContext(source + '\nglobalThis.inspect = () => ap;', context);
  return { context, api: context.window.MindAutopilot, main, pending, posts, elements, inspect: context.inspect };
}
const snapshot = (pilot, updatedAt) => ({ pilot, updatedAt, status: 'active', enabled: true, history: [], pilots: [], budget: {}, limits: {} });

test('changing pilots while HTTP is pending never displays the previous pilot response', async () => {
  const h = harness();
  const first = h.api.refresh();
  const second = h.api.select('gas-saver');
  h.pending[2].resolve(snapshot('default', 200));
  h.pending[3].resolve(snapshot('gas-saver', 200));
  await second;
  h.pending[0].resolve(snapshot('default', 100));
  h.pending[1].resolve(snapshot('gas-saver', 100));
  await first;
  assert.equal(h.inspect().pilot, 'gas-saver');
  assert.equal(h.inspect().snap.pilot, 'gas-saver');
  assert.equal(h.inspect().snap.updatedAt, 200);
});
test('socket update wins over pending HTTP and duplicate polls are coalesced', async () => {
  const h = harness();
  const first = h.api.refresh();
  await h.api.refresh();
  assert.equal(h.pending.length, 2);
  h.api.onUpdate(snapshot('default', 300));
  h.pending[0].resolve(snapshot('default', 100));
  h.pending[1].resolve(snapshot('gas-saver', 100));
  await first;
  assert.equal(h.inspect().snap.updatedAt, 300);
});
test('stop requires confirmation and targets the selected pilot', async () => {
  const h = harness();
  await h.api.stop();
  assert.equal(h.posts.length, 0);
  h.context.window.confirm = () => true;
  await h.api.stop();
  assert.equal(h.posts[0].url, '/api/mind/autopilot/stop');
  assert.equal(h.posts[0].body.pilot, 'default');
});
test('fallback configuration sends independent explicit consents, never inherits Claude consent', async () => {
  const h = harness();
  h.elements.apFallbackEnabled = { checked: true };
  h.elements.apQwenCloud = { checked: true };
  h.elements.apQwenWrites = { checked: false };
  h.elements.apQwenCalls = { value: '2' };
  h.elements.apQwenTokens = { value: '500000' };
  await h.api.saveFallback();
  assert.equal(h.posts[0].url, '/api/mind/autopilot/fallback');
  assert.equal(h.posts[0].body.fallback.cloudConsent, true);
  assert.equal(h.posts[0].body.fallback.worktreeWritesConsent, false);
  assert.equal(h.posts[0].body.fallback.tokenCeiling, 500000);
});

test('a third pilot announced by the server is read on the next refresh (no hard-coded pair)', async () => {
  const h = harness();
  const first = h.api.refresh();
  h.pending[0].resolve({ ...snapshot('default', 100), pilots: [{ pilot: 'default' }, { pilot: 'gas-saver' }, { pilot: 'nuit' }] });
  h.pending[1].resolve(snapshot('gas-saver', 100));
  await first;
  const second = h.api.refresh();
  const next = h.pending.slice(2);
  assert.equal(next.length, 3);
  assert.ok(next.some(p => p.url.includes('pilot=nuit')));
  next.forEach(p => p.resolve(snapshot(decodeURIComponent(p.url.split('pilot=')[1]), 200)));
  await second;
});

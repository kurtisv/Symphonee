'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyTaskPrefix } = require('./embeddings');

test('applyTaskPrefix: prepends nomic search_document/search_query prefixes', () => {
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', 'search_document'), 'search_document: hello');
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', 'search_query'), 'search_query: hello');
  assert.strictEqual(applyTaskPrefix('x', 'nomic-embed-text-v1.5', 'classification'), 'classification: x');
  assert.strictEqual(applyTaskPrefix('x', 'nomic-embed-text', 'clustering'), 'clustering: x');
});

test('applyTaskPrefix: no-op without a task (preserves prior behaviour)', () => {
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', null), 'hello');
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', undefined), 'hello');
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', ''), 'hello');
});

test('applyTaskPrefix: only nomic models get prefixed', () => {
  assert.strictEqual(applyTaskPrefix('hello', 'text-embedding-3-small', 'search_query'), 'hello');
  assert.strictEqual(applyTaskPrefix('hello', 'text-embedding-004', 'search_document'), 'hello');
  assert.strictEqual(applyTaskPrefix('hello', null, 'search_query'), 'hello');
});

test('applyTaskPrefix: unknown task is ignored, not blindly prepended', () => {
  assert.strictEqual(applyTaskPrefix('hello', 'nomic-embed-text', 'banana'), 'hello');
});

test('ollama embed circuit breaker: stops calling a crashing runner after repeated failures', async () => {
  const emb = require('./embeddings');
  const { ollamaEmbed, setNow, reset, EMBED_BREAKER_THRESHOLD } = emb._test;
  let now = 1_000_000;
  setNow(() => now);
  reset();
  let calls = 0;
  const failing = async () => { calls++; throw new Error('HTTP 500: llama runner process has terminated'); };
  for (let i = 0; i < EMBED_BREAKER_THRESHOLD; i++) {
    await assert.rejects(ollamaEmbed(['x'], { _post: failing }), /HTTP 500/);
  }
  assert.strictEqual(calls, EMBED_BREAKER_THRESHOLD);
  assert.strictEqual(emb.getEmbedBreakerState().open, true);
  // While open: no network call at all, and the auto picker yields BM25-only.
  await assert.rejects(ollamaEmbed(['x'], { _post: failing }), /paused after repeated failures/);
  assert.strictEqual(calls, EMBED_BREAKER_THRESHOLD);
  assert.strictEqual(emb.pickProvider(), null);
  // After the cooldown a single probe is allowed; success closes the breaker.
  now += 61_000;
  const ok = async () => { calls++; return { embedding: [0.1, 0.2] }; };
  const out = await ollamaEmbed(['x'], { _post: ok });
  assert.deepStrictEqual(out, [[0.1, 0.2]]);
  assert.strictEqual(emb.getEmbedBreakerState().open, false);
  setNow(null); reset();
});

test('ollama embed circuit breaker: cooldown doubles on re-trip and is capped', async () => {
  const emb = require('./embeddings');
  const { ollamaEmbed, setNow, reset, EMBED_BREAKER_THRESHOLD } = emb._test;
  let now = 5_000_000;
  setNow(() => now);
  reset();
  const failing = async () => { throw new Error('timeout'); };
  const trip = async () => { for (let i = 0; i < EMBED_BREAKER_THRESHOLD; i++) await ollamaEmbed(['x'], { _post: failing }).catch(() => {}); };
  await trip();
  assert.strictEqual(emb.getEmbedBreakerState().retryInMs, 60_000);
  now += 60_001; await trip();
  assert.strictEqual(emb.getEmbedBreakerState().retryInMs, 120_000);
  for (let k = 0; k < 10; k++) { now += 31 * 60_000; await trip(); }
  assert.strictEqual(emb.getEmbedBreakerState().retryInMs, 30 * 60_000);
  setNow(null); reset();
});

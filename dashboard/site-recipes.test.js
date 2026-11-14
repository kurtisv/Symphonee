'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const S = require('./site-recipes');

function withHost(fn) {
  const host = 'zzsiterecipestest' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.test';
  const dirExisted = fs.existsSync(S.RECIPES_DIR);
  const file = S.recipesPath(host);
  try { return fn(host); } finally {
    try { fs.unlinkSync(file); } catch (_) {}
    if (!dirExisted) { try { fs.rmdirSync(S.RECIPES_DIR); } catch (_) {} }
  }
}

test('normalizeHost: existing hostname and URL outputs are unchanged', () => {
  assert.strictEqual(S.normalizeHost('WWW.Reddit.com'), 'reddit.com');
  assert.strictEqual(S.normalizeHost('https://www.example.com/a?b'), 'example.com');
  assert.strictEqual(S.normalizeHost('http://Example.com'), 'example.com');
  assert.strictEqual(S.normalizeHost('sub.example.co.uk'), 'sub.example.co.uk');
});

test('normalizeHost: bare host with port or path matches the URL form', () => {
  assert.strictEqual(S.normalizeHost('example.com:8080'), 'example.com');
  assert.strictEqual(S.normalizeHost('https://example.com:8080/'), 'example.com');
  assert.strictEqual(S.normalizeHost('reddit.com/r/x'), 'reddit.com');
  assert.strictEqual(S.normalizeHost('reddit.com/r/x'), S.normalizeHost('https://reddit.com/r/x'));
  assert.strictEqual(S.normalizeHost('www.example.com:443?q=1#h'), 'example.com');
  assert.strictEqual(S.normalizeHost('localhost:3000'), 'localhost');
});

test('normalizeHost: empty and dot-only inputs map to __unknown__', () => {
  for (const v of ['', '.', '..', '...', '  ', null, undefined, '/', ':8080']) {
    assert.strictEqual(S.normalizeHost(v), '__unknown__', JSON.stringify(v));
  }
  const dir = path.join(S.SNAPSHOT_DIR, S.normalizeHost('..'));
  const rel = path.relative(S.SNAPSHOT_DIR, dir);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), rel);
});

test('actionsToSteps: maps browser actions to web verbs and drops unknowns', () => {
  assert.deepStrictEqual(S.actionsToSteps([
    { name: 'navigate', args: { url: 'https://example.com/' } },
    { name: 'click_text', args: { text: 'Sign in' } },
    { name: 'click', args: { selector: '#go' } },
    { name: 'fill_by_label', args: { label: 'Email', value: 'a@b.c' } },
    { name: 'press_key', args: { key: 'Enter' } },
    { name: 'fill_saved_credentials', args: { account: 'main' } },
    { name: 'screenshot', args: {} },
    { name: 'navigate', args: {} },
  ]), [
    { verb: 'GOTO', target: 'https://example.com/' },
    { verb: 'CLICK', target: 'text=Sign in' },
    { verb: 'CLICK', target: '#go' },
    { verb: 'TYPE', target: 'label=Email', text: 'a@b.c' },
    { verb: 'PRESS', target: 'Enter' },
    { verb: 'TYPE', target: 'credentials:main', text: '<saved>', notes: 'fill_saved_credentials' },
  ]);
  assert.deepStrictEqual(S.actionsToSteps(undefined), []);
});

test('saveRecipe: rejects unknown verbs without writing', () => withHost((host) => {
  assert.throws(() => S.saveRecipe(host, { name: 'x', steps: [{ verb: 'RM_RF' }] }), /unknown verb/);
  assert.strictEqual(fs.existsSync(S.recipesPath(host)), false);
}));

test('saveRecipe: caps REPEAT, replaces unsafe ids, persists under normalized host', () => withHost((host) => {
  const res = S.saveRecipe(host, {
    name: 'demo',
    steps: [
      { id: 'ok-id', verb: 'repeat', target: '999999' },
      { id: '../evil', verb: 'CLICK', target: '#a' },
      { verb: 'ENDREPEAT' },
    ],
  });
  assert.strictEqual(res.ok, true);
  const [rep, click, end] = res.recipe.steps;
  assert.strictEqual(rep.verb, 'REPEAT');
  assert.strictEqual(rep.id, 'ok-id');
  assert.strictEqual(rep.target, '1000');
  assert.notStrictEqual(click.id, '../evil');
  assert.match(click.id, /^[a-zA-Z][\w-]{0,63}$/);
  assert.match(end.id, /^[a-zA-Z][\w-]{0,63}$/);
  assert.strictEqual(res.recipe.host, S.normalizeHost(host));
  assert.strictEqual(path.dirname(res.path), S.RECIPES_DIR);
  assert.strictEqual(S.listRecipes(host).recipes.length, 1);
}));

'use strict';
// 2026-11-22: the tolerant edit-block parser and SEARCH matching added for the local Qwen developer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseActions, locateSearch } = require('./qwen-repo-worker');

test('a well-formed EDIT block is parsed as before', () => {
  const r = parseActions('EDIT a.js\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\nRUN');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.actions[0], { type: 'edit', file: 'a.js', search: 'old', replace: 'new' });
  assert.equal(r.actions[1].type, 'run');
});

test('common form mistakes of a small model are tolerated', () => {
  const text = [
    'EDIT `dashboard/lib/x.js`', '```js', '  <<<<<<<< search', 'old', '  ======', 'new', ' >>>>>>> replace', '```',
    'edit: b.js', '<<<<<<< SEARCH', 'x', '=======', 'y', '>>>>>>> REPLACE',
    'CREATE c.test.js', '```', '<<<<<<< CONTENT', 'hello', '>>>>>>> END', '```'].join('\n');
  const r = parseActions(text);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.actions.map((a) => [a.type, a.file]), [['edit', 'dashboard/lib/x.js'], ['edit', 'b.js'], ['create', 'c.test.js']]);
  assert.equal(r.actions[0].search, 'old');
  assert.equal(r.actions[0].replace, 'new');
  assert.equal(r.actions[2].content, 'hello');
});

test('a block with no separator is still refused', () => {
  const r = parseActions('EDIT a.js\n<<<<<<< SEARCH\nold\nnew\n>>>>>>> REPLACE');
  assert.equal(r.actions.length, 0);
  assert.match(r.errors[0], /incomplete block/);
});

test('locateSearch: exact unique match, duplicates refused', () => {
  assert.equal(locateSearch('a\nb\nc', 'b', 'B').next, 'a\nB\nc');
  assert.match(locateSearch('b\nb', 'b', 'B').err, /occurs 2 times/);
  assert.match(locateSearch('a', 'zzz', 'B').err, /not found/);
});

test('locateSearch: READ line numbers copied into SEARCH and REPLACE are removed', () => {
  const r = locateSearch('const a = 1;\nconst b = 2;\n', '  12 const a = 1;\n  13 const b = 2;', '  12 const a = 10;\n  13 const b = 2;');
  assert.equal(r.next, 'const a = 10;\nconst b = 2;\n');
  assert.match(r.note, /line numbers/);
});

test('locateSearch: trailing spaces do not prevent a unique match', () => {
  const r = locateSearch('if (x) {   \n  go();\n}\n', 'if (x) {\n  go();', 'if (y) {\n  go();');
  assert.equal(r.next, 'if (y) {\n  go();\n}\n');
  assert.match(r.note, /trailing spaces/);
  assert.match(locateSearch('x  \ny\nx \ny', 'x\ny', 'z').err, /occurs 2 times/);
});

test('prose that starts with Create/Edit is ignored, a bare uppercase EDIT <path> is still an error', () => {
  for (const t of ['Create a helper first.', 'Edit the parser, then RUN.', 'CREATE the test next']) assert.deepEqual(parseActions(t), { actions: [], errors: [] }, t);
  assert.match(parseActions('EDIT src/a.js').errors[0], /must start on the next line/);
  assert.equal(parseActions('edit src/a.js\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE').actions.length, 1);
});

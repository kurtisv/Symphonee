'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { extractPriorities, buildBrief, briefText, parseHints } = require('./local-brief');

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
  fs.writeFileSync(path.join(d, 'TASKS.md'), '# Tasks\n## P0-critique\n- Queue offline perd des donnees\n- PleinSens seuil a revoir\n## P2\n- cosmetique\nRate limit IP (P1)\n');
  return d;
}
test('extract: P0/P1 lines and items of P0/P1 sections, excluded topics dropped', () => {
  const e = extractPriorities(repo(), ['TASKS.md', 'absent.md'], { exclude: ['pleinsens'] });
  assert.match(e.text, /Queue offline/); assert.match(e.text, /Rate limit IP/);
  assert.doesNotMatch(e.text, /PleinSens|cosmetique/);
  assert.match(e.text, /^TASKS\.md:\d+ /);
});
test('brief: local model hints parsed; skipped on low RAM, failure or no model', async () => {
  const d = repo();
  const ok = await buildBrief({ repoPath: d, files: ['TASKS.md'], local: { model: 'q', loadRamMB: 1000 } },
    { freemem: () => 8e9, post: async (url, body) => { assert.match(url, /127\.0\.0\.1:1234\/v1\/chat\/completions$/); assert.equal(body.model, 'q');
      return { choices: [{ message: { content: 'x {"candidates":[{"priority":"P0","title":"Queue","where":"a.ts","why":"l"}]}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }; } });
  assert.equal(ok.hints.length, 1); assert.equal(ok.model, 'q'); assert.match(briefText(ok), /UNVERIFIED hints[\s\S]*Local hints/);
  const low = await buildBrief({ repoPath: d, files: ['TASKS.md'], local: { model: 'q', loadRamMB: 7000 } }, { freemem: () => 2e9, post: () => { throw new Error('must not call'); } });
  assert.match(low.skipped, /free RAM/); assert.ok(low.extract, 'the token-free extract still goes to discovery');
  const down = await buildBrief({ repoPath: d, files: ['TASKS.md'], local: { model: 'q', loadRamMB: 1 } }, { freemem: () => 8e9, post: async () => { throw new Error('ECONNREFUSED'); } });
  assert.match(down.skipped, /unavailable: ECONNREFUSED/);
  const none = await buildBrief({ repoPath: d, files: ['TASKS.md'], local: null });
  assert.equal(none.hints, null); assert.ok(none.extract);
  assert.equal(parseHints('no json'), null);
});

test('postJson: absolute deadline even when the server keeps streaming', async () => {
  const http = require('http');
  const { postJson } = require('./local-brief');
  const srv = http.createServer((req, res) => { res.writeHead(200); const t = setInterval(() => res.write(' '), 50); res.on('close', () => clearInterval(t)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  await assert.rejects(postJson('http://127.0.0.1:' + srv.address().port + '/v1/chat/completions', {}, 400), /timeout after 400 ms/);
  assert.ok(Date.now() - t0 < 2000);
  srv.close();
});

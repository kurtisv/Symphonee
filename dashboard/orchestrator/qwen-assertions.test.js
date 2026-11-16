'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAssertions, runAssertions } = require('./qwen-assertions');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const basic = [{ file:'app.js', export:'average', args:[[]], expected:null }];

test('requires a fixed manifest and rejects non-JSON-equivalent values', () => {
  assert.throws(() => validateAssertions([], ['app.js']), /manifest/);
  for (const expected of [NaN, Infinity, -0, [undefined]]) assert.throws(() => validateAssertions([{...basic[0],expected}], ['app.js']));
  assert.throws(() => validateAssertions(basic, ['other.js']));
});

test('refuses all assertions while the independent protocol is unverified', async () => {
  const cases = validateAssertions(basic, ['app.js']);
  await assert.rejects(runAssertions(async () => '', 'worker', cases), /protocol is not secure/);
  await assert.rejects(runAssertions(async args => JSON.stringify({nonce:args.at(-1),value:123}), 'worker', cases), /protocol is not secure/);
});

test('documents why a shared-process nonce cannot yet be trusted', async () => {
  const cases = validateAssertions(basic, ['app.js']);
  // A malicious module can inspect argv and emit this response before the
  // exported function is called. The worker must remain blocked.
  const forged = async args => JSON.stringify({nonce:args.at(-1),value:null});
  await assert.rejects(runAssertions(forged, 'worker', cases), /protocol is not secure/);
});

test('experimental worker stays blocked even when explicitly enabled', () => {
  const { spawnQwenDocker } = require('./spawn-qwen-docker');
  assert.throws(() => spawnQwenDocker.call({getConfig:()=>({QwenDocker:{enabled:true}})}, {}), /assertion integrity is not verified/);
});

test('real subprocess can forge a response before invoking the requested export', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-assertion-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'app.js'),"console.log(JSON.stringify({nonce:process.argv[4],value:null}));process.exit(0)");
  const child = cp.spawnSync(process.execPath, ['-e', "require(process.argv[1]);throw Error('export never reached')", path.join(dir,'app.js'), 'average', 'W10=', 'known-nonce'], {encoding:'utf8',timeout:5000});
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), {nonce:'known-nonce',value:null});
});

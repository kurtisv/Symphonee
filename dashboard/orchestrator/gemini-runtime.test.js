'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGeminiEnv, classifyProbe, probeGemini, probeGeminiSync } = require('./gemini-runtime');

test('Gemini environment prepends Symphonee Node and preserves PATH casing', () => {
  const env = buildGeminiEnv({ Path: 'C:\\OldNode;C:\\Tools', KEEP: 'yes' }, 'C:\\ModernNode\\node.exe');
  assert.equal(env.Path, 'C:\\ModernNode;C:\\OldNode;C:\\Tools');
  assert.equal(env.KEEP, 'yes');
});

test('Gemini probe classifies ready, missing, incompatible and timeout', async () => {
  assert.equal(classifyProbe('0.57.0', 0), 'READY');
  assert.equal(classifyProbe("'gemini' is not recognized", 1), 'NOT_INSTALLED');
  assert.equal(classifyProbe('Gemini CLI requires Node.js >=20', 1), 'RUNTIME_INCOMPATIBLE');
  let killed = false;
  const fake = { stdout: { on() {} }, stderr: { on() {} }, once(event, cb) { if (event === 'close') this.close = cb; if (event === 'error') this.error = cb; }, kill() { killed = true; } };
  const result = await probeGemini({ command: 'gemini.cmd', timeoutMs: 5, spawnFn: () => fake });
  assert.equal(result.reason, 'STARTUP_TIMEOUT');
  assert.equal(killed, true);
});

test('synchronous Gemini preflight is bounded and reports runtime incompatibility', () => {
  const result = probeGeminiSync({ command: 'gemini.cmd', execFileSyncFn: () => { const e = new Error('requires Node.js >=20'); e.status = 1; throw e; } });
  assert.equal(result.reason, 'RUNTIME_INCOMPATIBLE');
});

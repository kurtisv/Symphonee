'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAiResume, resumeCommand } = require('./ai-resume');

test('remembered AI survives a restart once; stale, unknown and forgotten ones do not', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-resume-')), 'terminal-ai.json');
  let t = 1_000_000;
  const a = createAiResume({ file, now: () => t });
  a.remember('main', 'claude'); a.remember('term-3', 'codex'); a.remember('term-4', 'gemini'); a.remember('term-5', 'claude');
  a.forget('term-5');
  // Symphonee stops here (no forget on shutdown). Next start:
  t += 3600000;
  const b = createAiResume({ file, now: () => t });
  assert.deepEqual(Object.keys(b.planned()).sort(), ['main', 'term-3']);
  assert.equal(b.take('main').cli, 'claude'); assert.equal(b.take('main'), null, 'one shot');
  // Older than 24 h: nothing.
  t += 25 * 3600000;
  assert.deepEqual(createAiResume({ file, now: () => t }).planned(), {});
});

test('resume commands: only CLIs with a continue command; permissions flag in bypass mode', () => {
  assert.equal(resumeCommand('claude', 'edit'), 'claude --continue');
  assert.equal(resumeCommand('claude', 'bypass'), 'claude --continue --dangerously-skip-permissions');
  assert.equal(resumeCommand('codex', 'bypass'), 'codex resume --last --dangerously-bypass-approvals-and-sandbox');
  assert.equal(resumeCommand('gemini', 'bypass'), null);
});

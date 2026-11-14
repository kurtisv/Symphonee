'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAiResume, resumeCommand, lastPromptDir } = require('./ai-resume');

test('remembered AI survives a restart once; stale, unknown and forgotten ones do not', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-resume-')), 'terminal-ai.json');
  let t = 1_000_000;
  const a = createAiResume({ file, now: () => t });
  a.remember('main', 'claude', 'C:\\Sym'); a.remember('term-3', 'codex', 'C:\\Repo'); a.remember('term-4', 'gemini', 'C:\\x'); a.remember('term-5', 'claude', 'C:\\y'); a.remember('term-6', 'claude', null);
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
  assert.equal(resumeCommand('claude', 'edit', 'C:\\a b'), "Set-Location -LiteralPath 'C:\\a b'; claude --continue");
  assert.equal(resumeCommand('claude', 'bypass', "C:\\it's"), "Set-Location -LiteralPath 'C:\\it''s'; claude --continue --dangerously-skip-permissions");
  assert.equal(resumeCommand('codex', 'bypass', 'C:\\r'), "Set-Location -LiteralPath 'C:\\r'; codex resume --last --dangerously-bypass-approvals-and-sandbox");
  assert.equal(resumeCommand('gemini', 'bypass', 'C:\\r'), null);
  assert.equal(resumeCommand('claude', 'edit', null), null, 'unknown folder: no resume');
});

test('lastPromptDir reads the folder of the last PowerShell prompt', () => {
  assert.equal(lastPromptDir('PS C:\\Users\\k> cd source\r\n\x1b[32mPS C:\\Users\\k\\source>\x1b[0m claude\r\n...tui...'), 'C:\\Users\\k\\source');
  assert.equal(lastPromptDir('no prompt here'), null);
});

test('an unreadable folder keeps the remembered one and never creates an entry', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-resume-')), 'terminal-ai.json');
  let t = 5_000_000;
  const a = createAiResume({ file, now: () => t });
  a.remember('main', 'claude', 'C:\Sym');
  t += 120000; a.remember('main', 'claude', null);
  a.remember('term-9', 'claude', null);
  const b = createAiResume({ file, now: () => t });
  assert.deepEqual(b.planned(), { main: { cli: 'claude', cwd: 'C:\Sym', at: t } });
});

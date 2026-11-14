'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAiResume, resumeCommand, lastPromptDir } = require('./ai-resume');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-resume-')), 'terminal-ai.json');

test('remembered AI survives a restart once; stale, unknown, folderless and forgotten ones do not', () => {
  const file = tmpFile();
  let t = 1_000_000;
  const a = createAiResume({ file, now: () => t });
  a.remember('main', 'claude', 'C:\\Sym'); a.remember('term-3', 'codex', 'C:\\Repo'); a.remember('term-4', 'gemini', 'C:\\x');
  a.remember('term-5', 'claude', 'C:\\y'); a.remember('term-6', 'claude', null);
  a.forget('term-5');
  // Symphonee stops here (no forget on shutdown). Next start:
  t += 3600000;
  const b = createAiResume({ file, now: () => t });
  assert.deepEqual(Object.keys(b.planned()).sort(), ['main', 'term-3']);
  assert.equal(b.take('main').cwd, 'C:\\Sym'); assert.equal(b.take('main'), null, 'one shot');
  t += 25 * 3600000;
  assert.deepEqual(createAiResume({ file, now: () => t }).planned(), {}, 'older than 24 h');
});

test('an unreadable folder keeps the remembered one and never creates an entry', () => {
  const file = tmpFile();
  let t = 5_000_000;
  const a = createAiResume({ file, now: () => t });
  a.remember('main', 'claude', 'C:\\Sym');
  t += 120000; a.remember('main', 'claude', null);
  a.remember('term-9', 'claude', null);
  assert.deepEqual(createAiResume({ file, now: () => t }).planned(), { main: { cli: 'claude', cwd: 'C:\\Sym', at: t } });
});

test('resume command: folder as base64 (no injection), permissions flag in bypass mode, known CLIs only', () => {
  const enc = (d) => "Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(d, 'utf8').toString('base64') + "'))); ";
  assert.equal(resumeCommand('claude', 'edit', 'C:\\a b'), enc('C:\\a b') + 'claude --continue');
  const evil = 'C:\\a\u2019; Write-Output X; #';
  assert.equal(resumeCommand('claude', 'bypass', evil), enc(evil) + 'claude --continue --dangerously-skip-permissions');
  assert.ok(!/Write-Output/.test(resumeCommand('claude', 'edit', evil)), 'nothing of the path is readable as code');
  assert.equal(resumeCommand('codex', 'bypass', 'C:\\r'), enc('C:\\r') + 'codex resume --last --dangerously-bypass-approvals-and-sandbox');
  assert.equal(resumeCommand('gemini', 'bypass', 'C:\\r'), null);
  assert.equal(resumeCommand('claude', 'edit', null), null, 'unknown folder: no resume');
});

test('lastPromptDir: only a prompt line that launches the CLI directly', () => {
  assert.equal(lastPromptDir('PS C:\\Users\\k> cd source\r\n\x1b[32mPS C:\\Users\\k\\source>\x1b[0m cls; claude --dangerously-skip-permissions\r\n...tui...'), 'C:\\Users\\k\\source');
  assert.equal(lastPromptDir('PS C:\\RepoA> Set-Location C:\\RepoB; claude\r\n'), null, 'folder changed on the same line');
  assert.equal(lastPromptDir('PS C:\\RepoA> npm test\r\n'), null, 'not a CLI launch');
  assert.equal(lastPromptDir('no prompt here'), null);
  assert.equal(lastPromptDir('PS C:\\RepoA> codex -C RepoB\r\n'), null, 'codex -C');
  assert.equal(lastPromptDir('PS C:\\RepoA> codex --cd=RepoB\r\n'), null, 'codex --cd=');
});

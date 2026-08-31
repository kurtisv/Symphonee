'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cfg = require('./cli-config');
const { pretrustFolderForCli } = require('./pretrust');

const CLIS = ['claude', 'gemini', 'codex', 'antigravity', 'copilot', 'grok', 'qwen'];

test('cli-config exposes all maps for all supported CLIs', () => {
  for (const m of ['HEADLESS_FLAGS', 'CLI_MODELS', 'CLI_CONFIG']) {
    for (const c of CLIS) assert.ok(cfg[m][c], `${m} missing ${c}`);
  }
  assert.equal(cfg.CLI_CONFIG.claude.label, 'Claude Code');
  assert.equal(cfg.CLI_MODELS.gemini.defaultModel, 'flash');
  assert.equal(cfg.HEADLESS_FLAGS.antigravity.cmd, 'agy');
  assert.deepEqual(cfg.HEADLESS_FLAGS.antigravity.args, ['-p']);
  assert.equal(cfg.HEADLESS_FLAGS.antigravity.promptMode, 'flag');
  assert.equal(cfg.CLI_CONFIG.antigravity.label, 'Antigravity');
  assert.equal(cfg.CLI_CONFIG.antigravity.pipeMode, true);
  assert.equal(cfg.CLI_MODELS.antigravity.defaultModel, null);
  assert.equal(cfg.CLI_MODELS.antigravity.modelFlag, '--model');
  assert.equal(cfg.CLI_MODELS.antigravity.effortFlag, '--effort');
  assert.equal(cfg.CLI_MODELS.antigravity.permissionFlag, '--dangerously-skip-permissions');
  assert.ok(cfg.ESCALATION_ORDER.indexOf('antigravity') < cfg.ESCALATION_ORDER.indexOf('codex'));
  assert.ok(cfg.ESCALATION_ORDER.indexOf('antigravity') < cfg.ESCALATION_ORDER.indexOf('claude'));
});

test('pretrustFolderForCli is a no-op for non-gated CLIs / missing cwd (no home writes)', () => {
  assert.equal(typeof pretrustFolderForCli, 'function');
  assert.doesNotThrow(() => pretrustFolderForCli('claude', 'C:/x'));   // claude: not folder-gated -> no write
  assert.doesNotThrow(() => pretrustFolderForCli('copilot', 'C:/x'));
  assert.doesNotThrow(() => pretrustFolderForCli('gemini', ''));        // no cwd -> early return
});

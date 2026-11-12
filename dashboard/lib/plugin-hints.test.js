'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPluginHints } = require('./plugin-hints');

const OUTPUTS = [
  ['CLAUDE.md', 'CLAUDE.md'],
  ['AGENTS.md', 'AGENTS.md'],
  ['GEMINI.md', 'GEMINI.md'],
  ['GROK.md', 'GROK.md'],
  ['QWEN.md', 'QWEN.md'],
  [path.join('.github', 'copilot-instructions.md'), 'copilot-instructions.md'],
];

const TEMPLATE = [
  '# {{FILENAME}}',
  'intro',
  '<!-- REPO_CONTEXT_START -->',
  'REPO_ONE',
  '<!-- REPO_CONTEXT_END -->',
  'middle',
  '<!-- REPO_CONTEXT_START -->',
  'REPO_TWO',
  '<!-- REPO_CONTEXT_END -->',
  '<!-- PLUGIN_INSTRUCTIONS_START -->',
  'OLD_PLUGIN_TEXT',
  '<!-- PLUGIN_INSTRUCTIONS_END -->',
  'footer',
].join('\n');

function setup({ template = TEMPLATE, plugins = {}, activeRepo = '' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hints-'));
  const repoRoot = path.join(base, 'repo');
  const pluginsDir = path.join(base, 'plugins');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  if (template !== null) fs.writeFileSync(path.join(repoRoot, 'INSTRUCTIONS.base.md'), template);
  for (const [dir, manifest] of Object.entries(plugins)) {
    fs.mkdirSync(path.join(pluginsDir, dir), { recursive: true });
    if (manifest === undefined) continue;
    fs.writeFileSync(path.join(pluginsDir, dir, 'plugin.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  const broadcasts = [];
  const write = createPluginHints({
    repoRoot,
    pluginsDir,
    getConfig: () => ({}),
    getUiContext: () => ({ activeRepo }),
    broadcast: (m) => broadcasts.push(m),
  });
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));
  const cleanup = () => fs.rmSync(base, { recursive: true, force: true });
  return { write, read, exists, cleanup, repoRoot };
}

// Silence the module's console chatter (audit / warnings) during tests.
function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return fn(); } finally { Object.assign(console, saved); }
}

test('writes all six outputs with filename substitution and plugin index', () => {
  const env = setup({
    plugins: {
      alpha: { id: 'alpha', name: 'Alpha', description: 'Alpha tool', aiKeywords: ['kw1', 'kw2'] },
    },
  });
  try {
    quiet(env.write);
    for (const [rel, name] of OUTPUTS) {
      assert.ok(env.exists(rel), `${rel} should exist`);
      const c = env.read(rel);
      assert.ok(c.startsWith(`# ${name}\n`), `${rel} should contain its filename`);
      assert.ok(!c.includes('{{FILENAME}}'));
      const s = c.indexOf('<!-- PLUGIN_INSTRUCTIONS_START -->');
      const e = c.indexOf('<!-- PLUGIN_INSTRUCTIONS_END -->');
      assert.ok(s !== -1 && e > s);
      const inner = c.slice(s, e);
      assert.ok(inner.includes('- **Alpha** (Alpha tool): kw1, kw2\n'));
      assert.ok(inner.includes('## Installed Plugins'));
      assert.ok(!c.includes('OLD_PLUGIN_TEXT'), 'old marker content replaced');
      assert.ok(c.endsWith('footer'));
    }
  } finally { env.cleanup(); }
});

test('strips every REPO_CONTEXT block when activeRepo is empty', () => {
  const env = setup({ activeRepo: '' });
  try {
    quiet(env.write);
    const c = env.read('CLAUDE.md');
    assert.ok(!c.includes('REPO_CONTEXT_START'));
    assert.ok(!c.includes('REPO_CONTEXT_END'));
    assert.ok(!c.includes('REPO_ONE'));
    assert.ok(!c.includes('REPO_TWO'));
    assert.ok(c.includes('intro') && c.includes('middle'));
  } finally { env.cleanup(); }
});

test('keeps REPO_CONTEXT blocks when activeRepo is set', () => {
  const env = setup({ activeRepo: 'C:/some/repo' });
  try {
    quiet(env.write);
    const c = env.read('AGENTS.md');
    assert.ok(c.includes('REPO_ONE') && c.includes('REPO_TWO'));
    assert.strictEqual(c.split('<!-- REPO_CONTEXT_START -->').length - 1, 2);
  } finally { env.cleanup(); }
});

test('skips sdk, missing/malformed manifests and keyword-less plugins', () => {
  const env = setup({
    plugins: {
      sdk: { id: 'sdk', name: 'SdkPlugin', description: 'd', aiKeywords: ['sdkkw'] },
      empty: undefined,
      broken: '{ not json',
      nokw: { id: 'nokw', name: 'NoKw', description: 'none' },
      good: { id: 'good', name: 'Good', aiKeywords: ['g'] },
    },
  });
  try {
    quiet(env.write);
    const c = env.read('CLAUDE.md');
    assert.ok(!c.includes('SdkPlugin'));
    assert.ok(!c.includes('NoKw'));
    assert.ok(c.includes('- **Good** (): g\n'));
    const lines = c.split('\n').filter((l) => l.startsWith('- **') && l.includes('): '));
    assert.deepStrictEqual(lines, ['- **Good** (): g']);
  } finally { env.cleanup(); }
});

test('no plugins at all leaves an empty plugin block', () => {
  const env = setup({ plugins: { sdk: { name: 'S', aiKeywords: ['x'] }, broken: '{' } });
  try {
    quiet(env.write);
    const c = env.read('CLAUDE.md');
    assert.ok(!c.includes('## Installed Plugins'));
    assert.ok(c.includes('<!-- PLUGIN_INSTRUCTIONS_START -->\n\n<!-- PLUGIN_INSTRUCTIONS_END -->'));
  } finally { env.cleanup(); }
});

test('template without plugin markers produces no output files', () => {
  const env = setup({ template: '# {{FILENAME}}\nno markers here\n' });
  try {
    assert.doesNotThrow(() => quiet(env.write));
    for (const [rel] of OUTPUTS) assert.ok(!env.exists(rel), `${rel} should not be written`);
  } finally { env.cleanup(); }
});

test('missing template returns early without writing', () => {
  const env = setup({ template: null });
  try {
    assert.strictEqual(quiet(env.write), undefined);
    for (const [rel] of OUTPUTS) assert.ok(!env.exists(rel));
    assert.deepStrictEqual(fs.readdirSync(env.repoRoot), []);
  } finally { env.cleanup(); }
});

'use strict';
// Real git: regeneration of generated documents inside the gate's tested merge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runChain } = require('./merge-gate');

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
// gen.js writes the number of files in src/ into docs/gen.md.
const GEN = "const fs=require('fs');fs.writeFileSync('docs/gen.md','files: '+fs.readdirSync('src').length+'\\n');";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porte-regen-'));
  const repo = path.join(root, 'r');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'));
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'gen.js'), GEN);
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(repo, 'docs', 'gen.md'), 'files: 1\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'base');
  return repo;
}
const policy = (repo, extra = {}) => ({ name: 'R', path: repo, base: 'main', linkDirs: [],
  chain: [{ name: 'gen-check', cmd: ['node', '-e', "const fs=require('fs');process.exit(fs.readFileSync('docs/gen.md','utf8')==='files: '+fs.readdirSync('src').length+'\\n'?0:1)"] }],
  regenerate: [{ name: 'gen', cmd: ['node', 'gen.js'] }], regeneratePaths: ['^docs/gen\\.md$'], ...extra });

test('regeneration is folded into the tested merge commit (two parents, doc up to date)', async () => {
  const repo = setup();
  g(repo, 'checkout', '-qb', 'feat'); fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'b\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'feat');
  const sha = g(repo, 'rev-parse', 'HEAD'); g(repo, 'checkout', '-q', 'main');
  const base = g(repo, 'rev-parse', 'main');
  const r = await runChain(policy(repo), base, sha);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(g(repo, 'rev-parse', r.merge + '^1'), base); assert.equal(g(repo, 'rev-parse', r.merge + '^2'), sha);
  assert.equal(g(repo, 'show', r.merge + ':docs/gen.md'), 'files: 2');
});

test('a conflict limited to the generated document is resolved by regeneration; a code conflict is not', async () => {
  const repo = setup();
  g(repo, 'checkout', '-qb', 'feat'); fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'b\n'); fs.writeFileSync(path.join(repo, 'docs', 'gen.md'), 'files: 2\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'feat'); const sha = g(repo, 'rev-parse', 'HEAD');
  g(repo, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(repo, 'src', 'c.js'), 'c\n'); fs.writeFileSync(path.join(repo, 'docs', 'gen.md'), 'files: 2 (c)\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'main moves');
  let r = await runChain(policy(repo), g(repo, 'rev-parse', 'main'), sha);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(g(repo, 'show', r.merge + ':docs/gen.md'), 'files: 3');
  g(repo, 'checkout', '-qb', 'feat2', sha); fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'feat2\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'f2');
  const sha2 = g(repo, 'rev-parse', 'HEAD'); g(repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'main\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'main a');
  r = await runChain(policy(repo), g(repo, 'rev-parse', 'main'), sha2);
  assert.equal(r.conflict, true);
});

test('regeneration may not touch other paths nor commit by itself', async () => {
  const repo = setup();
  g(repo, 'checkout', '-qb', 'feat'); fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'b\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'feat');
  const sha = g(repo, 'rev-parse', 'HEAD'); g(repo, 'checkout', '-q', 'main');
  const base = g(repo, 'rev-parse', 'main');
  let r = await runChain(policy(repo, { regenerate: [{ cmd: ['node', '-e', "require('fs').writeFileSync('src/evil.js','x')"] }] }), base, sha);
  assert.match(r.regenError || '', /chemins non autorises.*src\/evil\.js/);
  r = await runChain(policy(repo, { regenerate: [{ cmd: ['git', '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '--allow-empty', '-m', 'sneaky'] }] }), base, sha);
  assert.match(r.regenError || '', /historique/);
});

test('a regeneration that renames code into an allowed path is refused', async () => {
  const repo = setup();
  g(repo, 'checkout', '-qb', 'feat'); fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'b\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'feat');
  const sha = g(repo, 'rev-parse', 'HEAD'); g(repo, 'checkout', '-q', 'main');
  const r = await runChain(policy(repo, { regenerate: [{ cmd: ['git', 'mv', '-f', 'src/a.js', 'docs/gen.md'] }] }), g(repo, 'rev-parse', 'main'), sha);
  assert.match(r.regenError || '', /src\/a\.js/);
});

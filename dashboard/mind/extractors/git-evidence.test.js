'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { collectGitEvidence, configuredSource, fetchGitHubEvidence, githubRepository } = require('./git-evidence');
const workspace = path.resolve(__dirname, '../../../.ai-workspace');
fs.mkdirSync(workspace, { recursive: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(workspace, 'git-evidence-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'symphonee' }));
  t.after(() => { assert.ok(root.startsWith(workspace + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
test('no Git and no configured provider cleanly returns unavailable', async t => {
  const result = await collectGitEvidence(fixture(t));
  assert.equal(result.available, false); assert.equal(result.source, 'none'); assert.deepEqual(result.evidences, []);
});
test('local Git reads bounded commits and assertion counts without raw patches', async t => {
  const root = fixture(t); git(root, 'init'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'contract.test.js'), "test('contract', () => assert.equal(1, 1));\n");
  git(root, 'add', '.'); git(root, 'commit', '-m', 'Add contract verification');
  const result = await collectGitEvidence(root);
  assert.equal(result.available, true); assert.equal(result.source, 'local-git'); assert.equal(result.commitsScanned, 1);
  const evidence = result.evidences[0]; assert.equal(evidence.sessionId, null); assert.equal(evidence.verified, false);
  assert.equal(evidence.isCorroboration, true); assert.equal(evidence.diffStats.addedChecks, 1);
  assert.ok(!JSON.stringify(evidence).includes("assert.equal(1, 1)"));
});
test('unrelated parent Git repository is never attributed to archive nested within it', async t => {
  const root = fixture(t); git(root, 'init'); fs.writeFileSync(path.join(root, 'package.json'), '{"name":"other-project"}');
  const nested = path.join(root, 'Symphonee-master'); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'package.json'), '{"name":"symphonee"}');
  const result = await collectGitEvidence(nested); assert.equal(result.coverage.localRootFound, false);
});
test('explicit configured provider is fallback and never establishes test success', async t => {
  const root = fixture(t); let calls = 0;
  const result = await collectGitEvidence(root, { configuredSource: { source: 'https://example.invalid/symphonee.git', identity: 'symphonee' },
    fetchConfigured: async (_, limits) => { calls++; assert.equal(limits.maxCommits, 80); return [{ sha: 'a'.repeat(40), subject: 'Verify renderer', files: ['dashboard/renderer.test.js'] }]; } });
  assert.equal(calls, 1); assert.equal(result.source, 'configured-repository'); assert.equal(result.evidences[0].verified, false);
});
test('credential URL, unrelated identity, and sensitive records are not accepted', async t => {
  const root = fixture(t);
  assert.equal(configuredSource(root, { source: 'https://user:secret@example.invalid/repo' }), null);
  let calls = 0;
  await collectGitEvidence(root, { configuredSource: { source: 'https://example.invalid/repo', identity: 'other-project' }, fetchConfigured: async () => { calls++; return []; } });
  assert.equal(calls, 0);
  const result = await collectGitEvidence(root, { configuredSource: { source: 'https://example.invalid/repo', identity: 'symphonee' },
    fetchConfigured: async () => [{ sha: 'a'.repeat(40), subject: 'token=real_secret_credential_1234' }] });
  assert.equal(result.evidences.length, 0);
});
test('Mind fallback is scoped, fingerprint deduplicated, and excludes foreign commits', async t => {
  const root = fixture(t); const commit = { kind: 'git-commit', repoPath: root, sha: 'b'.repeat(40), subject: 'Confirm focused checks', files: ['contract.test.js'] };
  const result = await collectGitEvidence(root, { graph: { nodes: [commit, { ...commit }, { ...commit, sha: 'c'.repeat(40), repoPath: path.join(root, 'other') }] } });
  assert.equal(result.source, 'mind-git'); assert.equal(result.evidences.length, 1);
});
test('default configured GitHub source performs bounded official GETs and discards personal fields/patches', async t => {
  const root = fixture(t), sha = 'd'.repeat(40), calls = [];
  const result = await collectGitEvidence(root, { configuredSource: { source: 'https://github.com/example/symphonee.git', identity: 'symphonee' },
    fetch: async (url, options) => {
      calls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
      return new Response(JSON.stringify(url.includes('?') ? [{ sha, commit: { message: 'Strengthen contract', committer: { date: '2026-01-02T00:00:00Z', email: 'private@example.invalid' } } }] :
        { sha, files: [{ filename: 'contract.test.js', patch: "+test('contract', () => assert.equal(1, 1));\n" }] }));
    } });
  assert.equal(result.source, 'configured-repository'); assert.equal(calls.length, 2); assert.ok(calls.every(url => url.startsWith('https://api.github.com/repos/example/symphonee/commits')));
  assert.equal(result.evidences[0].diffStats.addedChecks, 1); assert.equal(result.evidences[0].verified, false);
  assert.ok(!JSON.stringify(result).includes('private@example.invalid')); assert.ok(!JSON.stringify(result).includes('assert.equal(1, 1)'));
});
test('GitHub REST failures, oversized responses and aborts cleanly return no evidence', async () => {
  const source = { url: 'https://github.com/example/symphonee' };
  assert.deepEqual(await fetchGitHubEvidence(source, {}, async () => new Response('rate limited', { status: 403 })), []);
  assert.deepEqual(await fetchGitHubEvidence(source, { maxBytes: 1024 }, async () => new Response('x'.repeat(2048))), []);
  assert.deepEqual(await fetchGitHubEvidence(source, { timeoutMs: 5 }, (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))), []);
});
test('GitHub URLs cannot redirect the provider to arbitrary hosts or encoded path traversal', async () => {
  for (const url of ['https://github.com.evil.invalid/owner/repo', 'https://github.com/owner/repo/issues', 'https://github.com/owner/%2e%2e', 'https://github.com/owner/repo?token=secret', 'https://github.com:8443/owner/repo']) {
    assert.equal(githubRepository({ url }), null);
  }
  let calls = 0;
  assert.deepEqual(await fetchGitHubEvidence({ url: 'https://example.invalid/owner/repo' }, {}, async () => { calls++; }), []);
  assert.equal(calls, 0);
});
test('GitHub maximum backfill stays within two list pages and twelve commit details', async () => {
  let lists = 0, details = 0;
  const sha = index => index.toString(16).padStart(40, '0');
  const records = await fetchGitHubEvidence({ url: 'https://github.com/example/symphonee' }, { maxCommits: 999 }, async url => {
    if (url.includes('?')) {
      const page = Number(new URL(url).searchParams.get('page')); lists++;
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ sha: sha((page - 1) * 100 + index + 1), commit: { message: 'Verify contract' } }))));
    }
    details++; return new Response(JSON.stringify({ sha: url.split('/').at(-1), files: [] }));
  });
  assert.equal(records.length, 200); assert.equal(lists, 2); assert.equal(details, 12);
});
test('explicit configured source persists compact cache then works without source or network', async t => {
  const root = fixture(t), source = { source: 'https://github.com/example/symphonee', identity: 'symphonee' }; let calls = 0;
  const fetchConfigured = async () => { calls++; return [{ sha: 'e'.repeat(40), subject: 'Confirm diagnostics', files: ['contract.test.js'] }]; };
  const initial = await collectGitEvidence(root, { repoRoot: root, configuredSource: source, fetchConfigured });
  assert.equal(initial.coverage.cacheWritten, true);
  const cached = await collectGitEvidence(root, { repoRoot: root, fetchConfigured });
  assert.equal(calls, 1); assert.equal(cached.source, 'configured-repository-cache'); assert.equal(cached.evidences.length, 1);
  await collectGitEvidence(root, { repoRoot: root, configuredSource: source, fetchConfigured, refresh: true });
  assert.equal(calls, 2);
});
test('dry run never writes Git index and corrupt, foreign or sensitive caches are ignored', async t => {
  const root = fixture(t), file = path.join(root, 'skills', '.reflection', 'git-index.json');
  await collectGitEvidence(root, { repoRoot: root, dryRun: true, configuredSource: { source: 'https://github.com/example/symphonee', identity: 'symphonee' },
    fetchConfigured: async () => [{ sha: 'f'.repeat(40), subject: 'Verify diagnostics' }] });
  assert.equal(fs.existsSync(file), false); fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const data of [ { version: 1, source: { url: 'https://github.com/example/gassaver', identity: 'gassaver' }, evidences: [] },
    { version: 1, source: { url: 'https://user:password@github.com/example/symphonee', identity: 'symphonee' }, evidences: [] },
    { version: 1, source: { url: 'https://github.com/example/symphonee', identity: 'symphonee' }, evidences: [{ id: 'git-' + 'f'.repeat(40), fingerprint: 'invalid', text: 'Verify diagnostics', sessionId: null, verified: false }] },
    { version: 1, source: { url: 'https://github.com/example/symphonee', identity: 'symphonee' }, evidences: [], secret: 'token=literal_private_credential_1234' } ]) {
    fs.writeFileSync(file, JSON.stringify(data)); const result = await collectGitEvidence(root, { repoRoot: root }); assert.equal(result.available, false); assert.equal(result.coverage.cacheUsed, false);
  }
});
test('oversized commit details preserve bounded compact list evidence without claiming successful checks', async () => {
  const sha = 'a'.repeat(40);
  const records = await fetchGitHubEvidence({ url: 'https://github.com/example/symphonee' }, { maxBytes: 1024 }, async url =>
    new Response(url.includes('?') ? JSON.stringify([{ sha, commit: { message: 'Verify diagnostics' } }]) : 'x'.repeat(2048)));
  assert.equal(records.length, 1); assert.equal(records[0].sha, sha); assert.equal(records[0].diffStats.diffRead, false); assert.equal(records[0].diffStats.addedChecks, 0);
});

test('a second list page exceeding the budget retains first-page evidence and reports why', async () => {
  const failures = [], sha = 'b'.repeat(40);
  const records = await fetchGitHubEvidence({ url: 'https://github.com/example/symphonee' },
    { maxCommits: 200, maxBytes: 20000, onFailure: reason => failures.push(reason) }, async url => {
      if (url.includes('page=2')) return new Response('x'.repeat(30000));
      if (url.includes('?')) return new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ sha, commit: { message: 'Verify diagnostics' } }))));
      return new Response(JSON.stringify({ sha, files: [] }));
    });
  assert.equal(records.length, 1); assert.deepEqual(failures, ['response-budget']);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { mountGit } = require('./git');
const { SWRCache } = require('../utils/swr-cache');
const { BusyGuard } = require('../utils/busy-guard');

const workspaceRoot = path.resolve(__dirname, '..', '..', '.ai-workspace');
let repoRoot;
test.before(() => {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  repoRoot = fs.mkdtempSync(path.join(workspaceRoot, 'git-routes-test-'));
  const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
  git(['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(repoRoot, 'fixture.txt'), 'Git route fixture\n');
  git(['add', 'fixture.txt']);
  git(['-c', 'user.name=Route Test', '-c', 'user.email=route-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initialize route fixture']);
  git(['branch', 'feature/route-fixture']);
});
test.after(() => {
  const resolved = path.resolve(repoRoot);
  assert.ok(resolved.startsWith(workspaceRoot + path.sep), 'cleanup must stay in the test workspace');
  fs.rmSync(resolved, { recursive: true, force: true });
});

function harness(getRepoPath) {
  const routes = {};
  const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
  const json = (res, data, status = 200) => { res._data = data; res._status = status; };
  mountGit(addRoute, json, {
    getRepoPath: getRepoPath || (() => repoRoot),
    broadcast: () => {},
    swrGit: new SWRCache({ staleTTL: 1000, maxAge: 5000 }),
    guard: new BusyGuard(),
  });
  return routes;
}

test('git routes are all registered', () => {
  const r = harness();
  for (const key of [
    'GET /api/git/status', 'GET /api/git/diff', 'GET /api/git/branches',
    'GET /api/git/log', 'GET /api/git/commit-diff', 'GET /api/git/split-diff',
    'POST /api/git/checkout', 'POST /api/git/pull', 'POST /api/git/push',
    'POST /api/git/fetch', 'POST /api/git/discard',
  ]) assert.ok(r[key], `missing route ${key}`);
});

test('git status returns {branch, files, clean}', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/status']({}, res, new URL('http://x/api/git/status?repo=test'));
  assert.ok(res._data, 'responded');
  assert.ok('branch' in res._data && 'files' in res._data && 'clean' in res._data, 'shape');
  assert.equal(typeof res._data.branch, 'string');
  assert.equal(res._data.branch, 'main');
  assert.ok(Array.isArray(res._data.files));
  assert.equal(res._data.clean, true);
});

test('git branches returns current + branches[]', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/branches']({}, res, new URL('http://x/?repo=test'));
  assert.ok(Array.isArray(res._data.branches), 'branches array');
  assert.equal(typeof res._data.current, 'string');
  assert.equal(res._data.current, 'main');
  assert.ok(res._data.branches.includes('main'));
  assert.ok(res._data.branches.includes('feature/route-fixture'));
});

test('git log returns commits[]', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/log']({}, res, new URL('http://x/?repo=test&count=3'));
  assert.ok(Array.isArray(res._data.commits));
  assert.equal(res._data.commits.length, 1);
  assert.ok(JSON.stringify(res._data.commits).includes('Initialize route fixture'));
});

test('missing repo -> 400', async () => {
  const r = harness(() => null);
  const res = {};
  await r['GET /api/git/status']({}, res, new URL('http://x/?repo=nope'));
  assert.equal(res._status, 400);
});

test('git diff blocks path traversal (untracked-file read stays in repo)', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/diff']({}, res, new URL('http://x/?repo=test&path=../../../../etc/passwd'));
  // Must never leak file content from outside the repo
  const diff = (res._data && res._data.diff) || '';
  assert.ok(!diff.includes('root:'), 'no /etc/passwd content in diff');
});

test('split-diff blocks path traversal -> no disk content from outside repo', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/split-diff']({}, res, new URL('http://x/?repo=test&path=../../../../etc/passwd'));
  assert.equal((res._data && res._data.modified) || '', '', 'modified must be empty for escaped path');
});

test('split-diff rejects flag-injection base ref -> 400', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/split-diff']({}, res, new URL('http://x/?repo=test&path=package.json&base=--output%3Dpwn'));
  assert.equal(res._status, 400);
});

test('commit-diff rejects flag-injection hash -> 400', async () => {
  const r = harness();
  const res = {};
  await r['GET /api/git/commit-diff']({}, res, new URL('http://x/?repo=test&hash=--output%3Dpwn'));
  assert.equal(res._status, 400);
});

'use strict';
// Read content only from immutable Git objects. Never read worktree file bytes.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { safeName } = require('./qwen-snapshot');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

function git(root, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  return cp.execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    env, input,
    windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
  });
}

// Reconstruct only in a private throwaway directory, from verified Git blobs.
// The canonical diff check binds the tested bytes to the entire original diff.
function reconstructProposal(root, names, diff, editable) {
  if (typeof diff !== 'string' || !diff || Buffer.byteLength(diff) > 2 * 1024 * 1024 || diff.includes('\0')) throw new Error('Invalid diff');
  const base = gitSnapshot(root, names);
  const allowed = new Set(base.files.map(f => f.path));
  if (!Array.isArray(editable) || !editable.length || editable.some(n => !allowed.has(n)) || new Set(editable).size !== editable.length) throw new Error('Invalid editable selection');
  for (const line of diff.split('\n')) {
    if (/^(diff --git |new file mode |deleted file mode |old mode |new mode |rename |copy |GIT binary patch|index )/.test(line)) throw new Error('Unsupported diff metadata');
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const m = /^(?:--- a\/|\+\+\+ b\/)([A-Za-z0-9_./-]+)$/.exec(line);
      if (!m || !allowed.has(m[1])) throw new Error('Diff path outside selection');
    }
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-reconstruct-'));
  try {
    for (const file of base.files) {
      const target = path.join(temp, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(file.content, 'base64'), { flag: 'wx' });
    }
    git(temp, ['apply', '--check', '-'], Buffer.from(diff, 'utf8'));
    git(temp, ['apply', '-'], Buffer.from(diff, 'utf8'));
    const { snapshotFiles, validateProposal } = require('./qwen-snapshot');
    const candidate = snapshotFiles(temp, names);
    const changes = validateProposal(base.files, candidate, editable);
    const { formatDiff } = require('./qwen-docker-adapter');
    if (!changes.length || formatDiff(changes, base.files) !== diff) throw new Error('Diff does not match reconstructed content');
    assertGitSnapshotUnchanged(base);
    return { baseCommit: base.commit, baseFiles: base.files.map(f => ({ path:f.path, blobOid:f.blobOid })), diff, files: candidate, changes };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function gitSnapshot(root, names) {
  if (!Array.isArray(names) || !names.length || names.length > 16) throw new Error('Invalid file selection');
  const unique = new Set();
  for (const input of names) { const n = safeName(input); if (unique.has(n.toLowerCase())) throw new Error('Duplicate file path'); unique.add(n.toLowerCase()); }
  const actualRoot = fs.realpathSync(root);
  const top = fs.realpathSync(git(actualRoot, ['rev-parse', '--show-toplevel']).toString('utf8').trim());
  if (actualRoot.toLowerCase() !== top.toLowerCase()) throw new Error('Workspace must be the Git repository root');
  const commit = git(top, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Only SHA-1 Git repositories are currently supported');
  // Git status may execute configured clean/process filters. Do not run it
  // against such repositories; proving the worktree clean is then unsafe.
  try {
    const configured = git(top, ['config', '--name-only', '--get-regexp', '^filter\\.']);
    if (configured.length) throw new Error('Configured Git filters are not supported');
  } catch (e) {
    if (e.message === 'Configured Git filters are not supported') throw e;
    if (e.status !== 1) throw new Error('Unable to verify Git filters');
  }
  const status = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...names]);
  if (status.length) throw new Error('Selected files must be committed and clean');
  const result = []; let total = 0;
  for (const name of names) {
    const tree = git(top, ['ls-tree', '-z', '--full-tree', commit, '--', name]);
    const records = tree.toString('utf8').split('\0').filter(Boolean);
    if (records.length !== 1) throw new Error('Selected file not found in commit');
    const entry = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(records[0]);
    if (!entry || entry[3] !== name) throw new Error('Special, linked or unexpected Git entry');
    const indexed = git(top, ['ls-files', '-v', '--stage', '-z', '--', name]).toString('utf8').split('\0').filter(Boolean);
    if (indexed.length !== 1 || !indexed[0].startsWith('H ' + entry[1] + ' ' + entry[2] + ' 0\t') || indexed[0].slice(indexed[0].indexOf('\t') + 1) !== name) throw new Error('Unmerged, modified or special index entry');
    const length = Number(git(top, ['cat-file', '-s', entry[2]]).toString('ascii').trim());
    if (!Number.isSafeInteger(length) || length > 256 * 1024) throw new Error('Blob too large');
    const data = git(top, ['cat-file', 'blob', entry[2]]); total += data.length;
    if (data.length !== length || total > 1024 * 1024 || data.includes(0)) throw new Error('Invalid blob content');
    const oid = crypto.createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex');
    if (oid !== entry[2]) throw new Error('Git blob integrity mismatch');
    result.push({ path: name, content: data.toString('base64'), sha256: sha256(data), blobOid: oid });
  }
  if (git(top, ['rev-parse', '--verify', 'HEAD^{commit}']).toString('ascii').trim() !== commit || git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...names]).length) throw new Error('Git state changed during snapshot');
  return { root: top, commit, files: result };
}

function assertGitSnapshotUnchanged(snapshot) {
  const current = gitSnapshot(snapshot.root, snapshot.files.map(f => f.path));
  if (current.commit !== snapshot.commit || current.files.some((f, i) => f.blobOid !== snapshot.files[i].blobOid)) throw new Error('Git snapshot changed during task');
}
module.exports = { gitSnapshot, assertGitSnapshotUnchanged, reconstructProposal };

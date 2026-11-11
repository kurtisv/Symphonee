'use strict';

// Git is corroboration, never an independent successful CLI session. Neither
// patches nor credentials are retained in the procedural index.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { safetyIssue } = require('../../skill-corpus');
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const run = (cwd, args, maxBuffer = 512 * 1024) => execFileSync('git', args,
  { cwd, encoding: 'utf8', timeout: 3000, maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] });

function identity(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name || ''; }
  catch (_) { return ''; }
}
function matchingRoot(candidate, repoPath) {
  if (path.resolve(candidate).toLowerCase() === path.resolve(repoPath).toLowerCase()) return true;
  const expected = identity(repoPath);
  return !!expected && identity(candidate) === expected &&
    fs.existsSync(path.join(candidate, 'dashboard', 'skill-reflection.js')) &&
    fs.existsSync(path.join(candidate, 'dashboard', 'mind', 'extractors', 'cli-history.js'));
}
function localRoot(repoPath) {
  try {
    const root = run(repoPath, ['rev-parse', '--show-toplevel']).trim();
    return matchingRoot(root, repoPath) ? root : null;
  } catch (_) { return null; }
}
function configuredSource(repoPath, configured = {}) {
  // Only explicit repository metadata is eligible. README clone examples and
  // arbitrary GitHub mentions are audit hints, not an implicit network grant.
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')); } catch (_) {}
  const source = configured.source || configured.remoteUrl || configured.gitRemote ||
    (typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url);
  if (!source || typeof source !== 'string') return null;
  try {
    const url = new URL(source.replace(/^git\+/, ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (safetyIssue(url.href)) return null;
    return { url: url.href, identity: configured.identity || metadata.name || '', type: configured.type || 'configured-repository' };
  } catch (_) { return null; }
}
function compactCommit(record, source) {
  if (!record || typeof record !== 'object') return null;
  const sha = String(record.sha || record.hash || '');
  if (!/^[a-f0-9]{7,64}$/i.test(sha)) return null;
  const subject = String(record.subject || record.message || '').split('\n')[0].slice(0, 240);
  const rawFiles = record.changedFiles || record.files;
  const changedFiles = (Array.isArray(rawFiles) ? rawFiles : []).filter(file => typeof file === 'string' &&
    !path.isAbsolute(file) && !/^(?:[a-z]:|\/|\\)|(?:^|[\/\\])\.\.(?:[\/\\]|$)/i.test(file) && !safetyIssue(file)).slice(0, 30);
  if (safetyIssue(subject)) return null;
  return { id: 'git-' + sha.toLowerCase(), fingerprint: digest('git:' + sha.toLowerCase()), sessionId: null,
    sourceType: 'git-diff', source, createdAt: Number.isFinite(Date.parse(record.createdAt || record.date)) ? new Date(record.createdAt || record.date).toISOString() : null,
    isCorroboration: true, changedFiles, diffStats: { addedChecks: Math.min(10000, Math.max(0, Number(record.diffStats?.addedChecks) || 0)),
      removedChecks: Math.min(10000, Math.max(0, Number(record.diffStats?.removedChecks) || 0)), diffRead: !!record.diffStats?.diffRead },
    text: subject + '\nChanged files: ' + changedFiles.join(', '), verified: false };
}
function localEvidence(root, maxCommits) {
  const log = run(root, ['log', '-n', String(maxCommits), '--format=%H%x09%cI%x09%s', '--name-only']);
  return log.split(/(?=^[a-f0-9]{40}\t)/m).filter(Boolean).map((block, index) => {
    const [header, ...files] = block.split('\n'); const [sha, createdAt, subject] = header.split('\t');
    const diffStats = { addedChecks: 0, removedChecks: 0, diffRead: false };
    if (index < 12) try {
      const diff = run(root, ['show', '--format=', '--no-ext-diff', '--unified=0', sha, '--', '*.test.js', '*.test.ts', '*spec*'], 64 * 1024);
      for (const line of diff.split('\n')) if (/\b(?:test|it|expect|assert\.\w+)\s*\(/.test(line)) {
        if (/^\+[^+]/.test(line)) diffStats.addedChecks++;
        if (/^-[^-]/.test(line)) diffStats.removedChecks++;
      }
      diffStats.diffRead = true;
    } catch (_) { /* a missing or oversized patch supplies no check evidence */ }
    return compactCommit({ sha, createdAt, subject, changedFiles: files.filter(Boolean), diffStats }, 'local-git');
  }).filter(Boolean);
}
function mindEvidence(graph, repoPath, maxCommits) {
  const nodes = Array.isArray(graph) ? graph : Array.isArray(graph?.nodes) ? graph.nodes : Object.values(graph?.nodes || {});
  return nodes.filter(node => /^(?:git-commit|commit|git-diff)$/.test(node.kind || node.type || '') &&
    (node.repoPath && path.resolve(node.repoPath).toLowerCase() === path.resolve(repoPath).toLowerCase() ||
      node.scope?.repoPath && path.resolve(node.scope.repoPath).toLowerCase() === path.resolve(repoPath).toLowerCase()))
    .slice(0, maxCommits).map(node => compactCommit({ ...node, ...(node.metadata || {}) }, 'mind-git')).filter(Boolean);
}
function githubRepository(source) {
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length !== 2 || parts.some(p => !/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(p) || p === '.' || p === '..')) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch (_) { return null; }
}
async function fetchGitHubEvidence(source, limits = {}, fetchImpl = globalThis.fetch) {
  const repository = githubRepository(source);
  if (!repository || typeof fetchImpl !== 'function') return [];
  const maxCommits = Math.max(1, Math.min(200, Number(limits.maxCommits) || 80));
  const maxBytes = Math.max(1024, Math.min(512 * 1024, Number(limits.maxBytes) || 512 * 1024));
  const controller = new AbortController(); let bytes = 0, requests = 0;
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(5000, Number(limits.timeoutMs) || 5000)));
  const base = `https://api.github.com/repos/${repository.owner}/${repository.repo}/commits`;
  // Official REST endpoints: https://docs.github.com/en/rest/commits/commits
  // Only GET against constructed api.github.com URLs. No token is required or
  // harvested; private/rate-limited sources cleanly supply no evidence.
  const read = async url => {
    if (++requests > 14) throw new Error('request-budget');
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Symphonee-Skill-Gardener' } });
    if (!response.ok || !response.body) throw new Error('source-http-' + response.status);
    if (Number(response.headers?.get('content-length')) > maxBytes - bytes) { await response.body.cancel(); throw new Error('response-budget'); }
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) { controller.abort(); throw new Error('response-budget'); }
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  try {
    const commits = [];
    for (let page = 1; page <= 2 && commits.length < maxCommits; page++) {
      const count = Math.min(100, maxCommits - commits.length);
      let records;
      try { records = await read(base + `?per_page=${count}&page=${page}`); }
      catch (error) { if (!commits.length) throw error; limits.onFailure?.(error.message); break; }
      if (!Array.isArray(records)) throw new Error('unexpected-commits');
      commits.push(...records.slice(0, count)); if (records.length < count) break;
    }
    const seen = new Set(), result = []; let detailsAvailable = true;
    for (const commit of commits) {
      if (!/^[a-f0-9]{40}$/i.test(commit?.sha || '') || seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      const record = { sha: commit.sha, subject: commit.commit?.message, createdAt: commit.commit?.committer?.date,
        files: [], diffStats: { addedChecks: 0, removedChecks: 0, diffRead: false } };
      if (result.length < 12 && detailsAvailable) try {
        const details = await read(base + '/' + commit.sha);
        if (details.sha !== commit.sha || !Array.isArray(details.files)) throw new Error('unexpected-commit');
        record.files = details.files.map(file => file.filename);
        for (const file of details.files) {
          if (!/(?:\.test\.[jt]s$|spec)/.test(file.filename || '') || typeof file.patch !== 'string') continue;
          record.diffStats.diffRead = true;
          for (const line of file.patch.split('\n')) if (/\b(?:test|it|expect|assert\.\w+)\s*\(/.test(line)) {
            if (/^\+[^+]/.test(line)) record.diffStats.addedChecks++;
            if (/^-[^-]/.test(line)) record.diffStats.removedChecks++;
          }
        }
      } catch (_) { detailsAvailable = false; /* keep compact list evidence, never invent checks */ }
      result.push(record);
    }
    return result;
  } catch (error) { limits.onFailure?.(/^(?:source-http-\d+|response-budget|request-budget|unexpected-commits)$/.test(error.message) ? error.message : 'source-read-unavailable'); return []; }
  finally { clearTimeout(timeout); controller.abort(); }
}
function cachePath(options) {
  return options.repoRoot ? path.join(options.repoRoot, 'skills', '.reflection', 'git-index.json') : null;
}
function readCache(repoPath, options, source) {
  const file = cachePath(options);
  if (!file) return null;
  try {
    if (fs.statSync(file).size > 512 * 1024) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const established = configuredSource(repoPath, { source: data.source?.url, identity: data.source?.identity });
    if (data.version !== 1 || !established || established.identity !== identity(repoPath) ||
      source && source.url !== established.url || !Array.isArray(data.evidences) || data.evidences.length > 200 || safetyIssue(JSON.stringify(data))) return null;
    const evidences = [];
    for (const evidence of data.evidences) {
      const compact = compactCommit({ ...evidence, sha: String(evidence.id || '').replace(/^git-/, ''),
        subject: String(evidence.text || '').split('\n')[0] }, 'configured-repository');
      if (!compact || compact.fingerprint !== evidence.fingerprint || evidence.sessionId !== null || evidence.verified !== false) return null;
      evidences.push(compact);
    }
    return { source: established, evidences: [...new Map(evidences.map(e => [e.fingerprint, e])).values()], confirmedAt: data.confirmedAt };
  } catch (_) { return null; }
}
function writeCache(options, source, evidences) {
  const file = cachePath(options);
  if (!file || options.dryRun) return false;
  const content = JSON.stringify({ version: 1, source: { url: source.url, identity: source.identity }, confirmedAt: new Date().toISOString(), evidences });
  if (Buffer.byteLength(content) > 512 * 1024 || safetyIssue(content)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, content); fs.renameSync(temporary, file); return true;
  } catch (_) { return false; }
}
async function collectGitEvidence(repoPath, options = {}) {
  const maxCommits = Math.max(1, Math.min(200, Number(options.maxCommits) || 80));
  const coverage = { localRootFound: false, configuredSourceFound: false, configuredSourceRead: false, cacheUsed: false, cacheWritten: false, mindCommits: 0, failures: [] };
  const root = localRoot(repoPath);
  if (root) {
    coverage.localRootFound = true;
    try { const evidences = localEvidence(root, maxCommits); return { evidences, commitsScanned: evidences.length, available: true, source: 'local-git', coverage }; }
    catch (_) { coverage.failures.push('local-history-unavailable'); }
  }
  const source = configuredSource(repoPath, options.configuredSource);
  coverage.configuredSourceFound = !!source;
  const cached = readCache(repoPath, options, source);
  if (cached && (!source || !options.refresh)) {
    coverage.cacheUsed = true; coverage.configuredSourceFound = true;
    const evidences = cached.evidences.slice(0, maxCommits);
    return { evidences, commitsScanned: evidences.length, available: !!evidences.length, source: 'configured-repository-cache', coverage };
  }
  const fetchConfigured = options.fetchConfigured || (githubRepository(source || {}) ?
    (source, limits) => fetchGitHubEvidence(source, { ...limits, onFailure: reason => coverage.failures.push(reason) }, options.fetch) : null);
  if (source && source.identity === identity(repoPath) && typeof fetchConfigured === 'function') try {
    let timer;
    const records = await Promise.race([Promise.resolve(fetchConfigured(source, { maxCommits, timeoutMs: 5000, maxBytes: 512 * 1024 })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('source-timeout')), 5000); })]).finally(() => clearTimeout(timer));
    if (!Array.isArray(records) || Buffer.byteLength(JSON.stringify(records)) > 512 * 1024) throw new Error('source-budget');
    coverage.configuredSourceRead = true;
    const evidences = [...new Map(records.slice(0, maxCommits).map(r => compactCommit(r, 'configured-repository')).filter(Boolean).map(e => [e.fingerprint, e])).values()];
    if (evidences.length) {
      coverage.cacheWritten = writeCache(options, source, evidences);
      return { evidences, commitsScanned: evidences.length, available: true, source: 'configured-repository', coverage };
    }
  } catch (_) { coverage.failures.push('configured-history-unavailable'); }
  if (cached) {
    coverage.cacheUsed = true;
    const evidences = cached.evidences.slice(0, maxCommits);
    return { evidences, commitsScanned: evidences.length, available: !!evidences.length, source: 'configured-repository-cache', coverage };
  }
  const evidences = [...new Map(mindEvidence(options.graph, repoPath, maxCommits).map(e => [e.fingerprint, e])).values()];
  coverage.mindCommits = evidences.length;
  return { evidences, commitsScanned: evidences.length, available: !!evidences.length, source: evidences.length ? 'mind-git' : 'none', coverage };
}
module.exports = { collectGitEvidence, GitEvidenceProvider: collectGitEvidence, localRoot, configuredSource, compactCommit, githubRepository, fetchGitHubEvidence };

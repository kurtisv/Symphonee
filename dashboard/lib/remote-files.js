'use strict';
// remote-files -- READ-ONLY file browsing for the phone. SECURITY-RELEVANT, pure and testable.
//
// The desktop file API (routes/files.js) only checks "inside the repo", so through it a phone could read
// config/runtime.json (the internal API token) or config.json (PATs). This module is stricter, and it
// is the ONLY file access a phone gets:
//   - the repo must be a configured one; the path is resolved with realpath and must stay inside the repo
//     (a symlink that points outside is refused);
//   - hidden files and folders (.git, .env, .ssh, .symphonee, .qwen...), node_modules, config, secrets,
//     keys, certificates and files named like credentials are invisible and unreadable;
//   - text extensions only, 200 KB max, and content that looks like a secret is refused.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 200 * 1024;
const MAX_ENTRIES = 300;
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.css', '.scss', '.html', '.htm', '.yml', '.yaml',
  '.py', '.ps1', '.sh', '.bat', '.cs', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.sql', '.xml', '.toml', '.csv', '.log', '.gitignore']);
const BAD_SEGMENT = /^(\.|node_modules$|config$|secrets?$|\.?credentials?$|private$|keys?$)/i;
const BAD_NAME = /(\.env|\.pem|\.key|\.pfx|\.p12|\.kdbx|\.jks|\.keystore|id_rsa|id_ed25519|secret|credential|password|passwd|token|runtime\.json|config\.json|\.npmrc|\.netrc|auth\.json)/i;
// Obvious secret assignments inside a file (api_key = "....", token: '....', Bearer xxxx, private key blocks).
const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(api[_-]?key|secret|token|passw(or)?d|pat)\b["']?\s*[:=]\s*["'][A-Za-z0-9_\-\/+=.]{16,}["']/i,
  /\bBearer\s+[A-Za-z0-9_\-.=]{24,}/,
  /\b(ghp|gho|ghs|github_pat|glpat|sk-ant|sk|xox[abp])[-_][A-Za-z0-9_\-]{16,}/,
];

function cleanRel(rel) {
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
  return r;
}

function hiddenName(name) { return BAD_SEGMENT.test(name) || BAD_NAME.test(name); }

// Returns { ok, abs, rel } with abs verified INSIDE the repo (realpath), or { ok:false, code }.
function resolveInside(repoRoot, rel) {
  if (typeof repoRoot !== 'string' || !repoRoot) return { ok: false, code: 'NO_REPO' };
  const r = cleanRel(rel);
  if (r.includes('\0') || r.length > 400) return { ok: false, code: 'BAD_PATH' };
  const segments = r.split('/').filter(Boolean);
  if (segments.some(s => s === '..' || s === '.')) return { ok: false, code: 'BAD_PATH' };
  if (segments.some(hiddenName)) return { ok: false, code: 'FORBIDDEN' };
  let rootReal;
  try { rootReal = fs.realpathSync(path.resolve(repoRoot)); } catch (_) { return { ok: false, code: 'NO_REPO' }; }
  const target = path.join(rootReal, ...segments);
  let real;
  try { real = fs.realpathSync(target); } catch (_) { return { ok: false, code: 'NOT_FOUND' }; }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { ok: false, code: 'FORBIDDEN' }; // symlink escape
  // Every segment of the REAL path must also be allowed (a visible name can point into a hidden folder).
  const relReal = path.relative(rootReal, real).split(path.sep).filter(Boolean);
  if (relReal.some(hiddenName)) return { ok: false, code: 'FORBIDDEN' };
  return { ok: true, abs: real, rel: segments.join('/') };
}

function listDir(repoRoot, rel) {
  const r = resolveInside(repoRoot, rel);
  if (!r.ok) return r;
  let st; try { st = fs.statSync(r.abs); } catch (_) { return { ok: false, code: 'NOT_FOUND' }; }
  if (!st.isDirectory()) return { ok: false, code: 'NOT_A_DIRECTORY' };
  let names; try { names = fs.readdirSync(r.abs, { withFileTypes: true }); } catch (_) { return { ok: false, code: 'UNREADABLE' }; }
  const entries = [];
  for (const d of names) {
    if (hiddenName(d.name)) continue;
    // Resolve each entry through the same checks (drops symlinks that leave the repo).
    const child = resolveInside(repoRoot, (r.rel ? r.rel + '/' : '') + d.name);
    if (!child.ok) continue;
    let s; try { s = fs.statSync(child.abs); } catch (_) { continue; }
    if (s.isDirectory()) entries.push({ name: d.name, type: 'dir' });
    else if (s.isFile() && TEXT_EXT.has(path.extname(d.name).toLowerCase())) entries.push({ name: d.name, type: 'file', size: s.size });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { ok: true, path: r.rel, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

function readFile(repoRoot, rel) {
  const r = resolveInside(repoRoot, rel);
  if (!r.ok) return r;
  let st; try { st = fs.statSync(r.abs); } catch (_) { return { ok: false, code: 'NOT_FOUND' }; }
  if (!st.isFile()) return { ok: false, code: 'NOT_A_FILE' };
  if (!TEXT_EXT.has(path.extname(r.abs).toLowerCase())) return { ok: false, code: 'NOT_TEXT' };
  if (st.size > MAX_BYTES) return { ok: false, code: 'TOO_LARGE', size: st.size };
  let text; try { text = fs.readFileSync(r.abs, 'utf8'); } catch (_) { return { ok: false, code: 'UNREADABLE' }; }
  if (text.includes('\0')) return { ok: false, code: 'NOT_TEXT' };
  if (SECRET_CONTENT.some(re => re.test(text))) return { ok: false, code: 'SENSITIVE_CONTENT' };
  return { ok: true, path: r.rel, size: st.size, text };
}

module.exports = { resolveInside, listDir, readFile, hiddenName, MAX_BYTES, MAX_ENTRIES, TEXT_EXT };

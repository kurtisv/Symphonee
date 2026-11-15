'use strict';

// Snapshot and proposal validation only. No changes are applied to the source.
// This does not replace a container boundary or protect against concurrent
// filesystem changes between validation and use.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const MAX_FILES = 16;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

function safeName(name) {
  if (typeof name !== 'string' || !name || !/^[A-Za-z0-9_./-]+$/.test(name) || name.includes('\\') || name.includes('\0') ||
      name.startsWith('/') || name.includes(':') ||
      name.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || part.toLowerCase() === '.git' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Invalid relative file path');
  }
  return name;
}

function snapshotFiles(root, names) {
  if (!Array.isArray(names) || !names.length || names.length > MAX_FILES) throw new Error('Invalid file selection');
  const canonicalRoot = fs.realpathSync(root);
  const result = [];
  const seen = new Set();
  let total = 0;
  for (const input of names) {
    const name = safeName(input);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate file path');
    seen.add(key);
    let current = canonicalRoot;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Links are not allowed');
    }
    const actual = fs.realpathSync(current);
    const rel = path.relative(canonicalRoot, actual);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Real path outside workspace');
    const st = fs.statSync(current);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error('Unsupported file');
    const data = fs.readFileSync(current);
    const after = fs.statSync(current);
    if (fs.realpathSync(current) !== actual || st.dev !== after.dev || st.ino !== after.ino || st.size !== after.size || st.mtimeMs !== after.mtimeMs) throw new Error('Source changed while reading');
    total += data.length;
    if (data.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || data.includes(0)) throw new Error('File size or content limit');
    result.push({ path: name, content: data.toString('base64'), sha256: hash(data) });
  }
  return result;
}

function assertSourceUnchanged(root, snapshot, expectedRoot) {
  if (fs.realpathSync(root) !== expectedRoot) throw new Error('Workspace real path changed');
  const current = snapshotFiles(root, snapshot.map(x => x.path));
  for (let i = 0; i < snapshot.length; i++) {
    if (snapshot[i].path !== current[i].path || snapshot[i].sha256 !== current[i].sha256) throw new Error('Source changed during task');
  }
}

function validateProposal(snapshot, proposed, editable) {
  if (!Array.isArray(snapshot) || !Array.isArray(proposed) || !Array.isArray(editable)) throw new Error('Invalid proposal');
  const originals = new Map(snapshot.map(item => [safeName(item.path), item]));
  const editableSet = new Set(editable.map(safeName));
  if (originals.size !== snapshot.length || proposed.length !== snapshot.length) throw new Error('File set changed');
  const result = [];
  const seen = new Set();
  let total = 0;
  for (const item of proposed) {
    const name = safeName(item.path);
    if (seen.has(name) || !originals.has(name) || typeof item.content !== 'string') throw new Error('Unexpected file');
    seen.add(name);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content)) throw new Error('Invalid encoding');
    const bytes = Buffer.from(item.content, 'base64');
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || bytes.includes(0)) throw new Error('File size or content limit');
    const original = originals.get(name);
    const before = Buffer.from(original.content, 'base64');
    if (hash(before) !== original.sha256) throw new Error('Invalid snapshot');
    if (!bytes.equals(before)) {
      if (!editableSet.has(name)) throw new Error('Change outside allowed files');
      result.push({ path: name, beforeSha256: original.sha256, afterSha256: hash(bytes), content: item.content });
    }
  }
  return result;
}

module.exports = { safeName, snapshotFiles, validateProposal, assertSourceUnchanged };

'use strict';

// Lexical mapping only. This is not a filesystem security boundary: junctions,
// symlinks and concurrent path replacement require an OS-enforced sandbox.
const path = require('path');

function resolveWorkspacePath(workspace, requested) {
  if (typeof workspace !== 'string' || !path.win32.isAbsolute(workspace) ||
      workspace.startsWith('\\\\') || !/^[a-zA-Z]:[\\/]/.test(workspace)) {
    throw new Error('A local absolute Windows workspace is required');
  }
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) {
    throw new Error('Invalid workspace path');
  }
  const raw = requested.replace(/\//g, '\\');
  if (raw.startsWith('\\\\') || /^[a-zA-Z]:[^\\]/.test(raw) ||
      (raw.includes(':') && !/^[a-zA-Z]:\\[^:]*$/.test(raw))) {
    throw new Error('Unsupported Windows path');
  }
  const root = path.win32.resolve(workspace);
  // A single leading slash is the model's workspace-root convention, not C:\.
  const candidate = /^[a-zA-Z]:\\/.test(raw)
    ? path.win32.resolve(raw)
    : path.win32.resolve(root, raw.replace(/^\\/, ''));
  const relative = path.win32.relative(root, candidate);
  if (relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)) {
    throw new Error('Path is outside the workspace');
  }
  return candidate;
}

module.exports = { resolveWorkspacePath };

'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
function quote(arg) {
  return '"' + String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function prepareWindowsJob({ command, args, cwd, shell, storageDir }) {
  const attemptId = randomUUID();
  const dir = path.join(storageDir, 'termination');
  fs.mkdirSync(dir, { recursive: true });
  const requestFile = path.join(dir, attemptId + '.request.json');
  const proofPath = path.join(dir, attemptId + '.proof.json');
  // For shell mode args already use the existing Windows shell quoting policy.
  const line = shell
    ? quote(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') + ' /d /s /c "' + command + ' ' + args.join(' ') + '"'
    : [command, ...args].map(quote).join(' ');
  fs.writeFileSync(requestFile, JSON.stringify({ command: line, cwd, proofPath, attemptId }), { flag: 'wx', mode: 0o600 });
  return { attemptId, proofPath, requestFile, command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-job.ps1'), '-RequestFile', requestFile] };
}
function readProof(job, pid) {
  try {
    const stat = fs.statSync(job.proofPath);
    if (stat.size > 2048) return null;
    const e = JSON.parse(fs.readFileSync(job.proofPath, 'utf8'));
    return e.attemptId === job.attemptId && e.wrapperPid === pid ? e : null;
  } catch (_) { return null; }
}
module.exports = { prepareWindowsJob, readProof, quote };

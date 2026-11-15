'use strict';

// Experimental fixture-only runner. This does not authorize a real project.
// Source is interpreted by the trusted supervisor, never loaded as Node code.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { isJsonSafe } = require('./qwen-assertions');

function verifyFixture(sources, cases, { timeoutMs = 5000 } = {}) {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 32) return Promise.reject(Error('Assertion manifest required'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return Promise.reject(Error('Invalid timeout'));
  if (!isJsonSafe({ sources, cases })) return Promise.reject(Error('Non-JSON fixture'));
  let input;
  try { input = JSON.stringify({ sources, cases }); } catch { return Promise.reject(Error('Invalid fixture')); }
  if (typeof input !== 'string' || Buffer.byteLength(input) > 300000) return Promise.reject(Error('Input limit'));
  // Resolve the dependency in the trusted parent, never inherit NODE_OPTIONS or
  // arbitrary NODE_PATH from the environment into the verification process.
  let modules;
  try { modules = path.dirname(path.dirname(path.dirname(require.resolve('@babel/parser/package.json')))); }
  catch { return Promise.reject(Error('Trusted parser unavailable')); }
  const env = { NODE_PATH: modules };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', path.join(__dirname, 'qwen-pure-supervisor.js')], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, oversized = false, done = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    function finish(error, result) { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); }
    child.on('error', err => finish(Error('Supervisor start failed: ' + err.message)));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8192) { oversized = true; child.kill(); } });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 8192) { oversized = true; child.kill(); } });
    child.on('close', (code, signal) => {
      if (timedOut) return finish(Error('Supervisor timeout'));
      if (oversized) return finish(Error('Supervisor output limit'));
      if (code !== 0 || signal) return finish(Error('Supervisor refused: ' + stderr.trim().slice(0, 300)));
      let result; try { result = JSON.parse(stdout); } catch { return finish(Error('Missing or invalid supervisor result')); }
      if (!result || result.ok !== true || result.expected !== cases.length || result.executed !== cases.length || Object.keys(result).sort().join(',') !== 'executed,expected,ok') return finish(Error('Incomplete supervisor result'));
      finish(null, result);
    });
    child.stdin.end(input);
  });
}
module.exports = { verifyFixture };

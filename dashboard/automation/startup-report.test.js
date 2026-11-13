'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { buildReport, scheduleStartupReport } = require('./startup-report');

test('the startup report lists autopilots, active graph runs, jobs and the merge gate', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/mind/autopilots') return res.end(JSON.stringify({ pilots: [{ pilot: 'gas-saver', label: 'Gas Saver (nuit)', status: 'waiting', repoName: 'Gas Saver' }] }));
    if (req.url === '/api/graph-runs') return res.end(JSON.stringify([{ id: 'gr_1', name: 'Boucle cycle 1', status: 'pending', completedNodes: 2, nodeCount: 10 }, { id: 'gr_0', name: 'old', status: 'completed' }]));
    if (req.url === '/api/jobs') return res.end(JSON.stringify([{ name: 'Lanceur', enabled: true, nextRun: Date.now() }]));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-start-'));
  try {
    fs.mkdirSync(path.join(repoRoot, '.ai-workspace', 'merge-gate'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.ai-workspace', 'merge-gate', 'state.json'), JSON.stringify({ candidates: { k: { branch: 'mind-autopilot/x', status: 'pr-open' } } }));
    const lines = await buildReport({ port: server.address().port, repoRoot });
    assert.match(lines.join('\n'), /Autopilote Gas Saver \(nuit\) \(gas-saver\) : waiting sur Gas Saver/);
    assert.match(lines.join('\n'), /Graph run Boucle cycle 1 \(gr_1\) : pending 2\/10/);
    assert.doesNotMatch(lines.join('\n'), /old/);
    assert.match(lines.join('\n'), /Job Lanceur : prochain/);
    assert.match(lines.join('\n'), /Porte de fusion : active, 1 candidate\(s\) en cours : mind-autopilot\/x=pr-open/);
    // Scheduled report: log written and one Sentry event, never a throw.
    const sent = [];
    scheduleStartupReport({ repoRoot, port: server.address().port, delayMs: 10, sentry: { event: async (e) => { sent.push(e); return { ok: true }; } } });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(sent.length, 1);
    assert.match(fs.readFileSync(path.join(repoRoot, '.ai-workspace', 'startup-report.log'), 'utf8'), /DEMARRAGE/);
  } finally { server.close(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

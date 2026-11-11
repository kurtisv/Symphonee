'use strict';
// Run the same reflection engine without restarting the Electron terminal.
// The regular UI uses POST /api/skills/reflect; this maintenance entry point
// loads the current implementation and obeys the live permission decision.
const path = require('path');
const { authHeaders } = require('./api-token');
const { evaluate } = require('../dashboard/permissions');
const { mountReflection } = require('../dashboard/skill-reflection');
async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const base = 'http://127.0.0.1:3800';
  const bootstrap = await fetch(base + '/api/bootstrap').then(r => r.json());
  const ui = bootstrap.context;
  if (path.resolve(ui.activeRepoPath || '') !== repoRoot) throw new Error('Select the Symphonee repository before reflecting');
  const dryRun = process.argv.includes('--dry-run');
  const decision = evaluate({ type: 'api', value: 'POST /api/skills/reflect' }, bootstrap.permissions.settings);
  if (!dryRun && decision.decision !== 'allow') throw new Error('Use the UI permission gate for reflection: ' + decision.decision);
  const changes = [];
  const sourceIndex = process.argv.indexOf('--git-source');
  const gitSource = sourceIndex >= 0 ? { source: process.argv[sourceIndex + 1], identity: require('../package.json').name } : undefined;
  if (gitSource && !require('../dashboard/mind/extractors/git-evidence').configuredSource(repoRoot, gitSource)) throw new Error('Invalid explicit repository source');
  if (process.argv.includes('--inspect')) {
    const corpus = require('../dashboard/skill-corpus');
    const h = require('../dashboard/mind/extractors/cli-history').collectProceduralHistory({ activeRepoPath: ui.activeRepoPath });
    console.log(JSON.stringify({ sessions: h.sessionsScanned, perCli: h.perCli,
      workflows: h.evidences.filter(e => e.steps).map(e => ({ id: e.id, steps: e.steps.filter(s => !corpus.safetyIssue(s)).map(s => s.slice(0, 300)), verified: e.verified })) }, null, 2));
    return;
  }
  const engine = mountReflection(() => {}, () => {}, { repoRoot, getUiContext: () => ui, broadcast: msg => changes.push(msg), gitSource,
    gitMaxCommits: Number(process.argv[process.argv.indexOf('--git-max-commits') + 1]) || 80 });
  const result = await engine.runDigest({ autoApply: process.argv.includes('--auto'), dryRun,
    useLocalModel: !process.argv.includes('--no-model'), max: 50, backfill: process.argv.includes('--backfill'), forceBackfill: process.argv.includes('--force') });
  if (!result.ok) throw new Error(result.reason || result.error || 'Reflection failed');
  // Re-publish canonical changes through the existing API so the running
  // editor receives its usual skills-changed event, even before a restart.
  if (!dryRun) {
    const corpus = require('../dashboard/skill-corpus');
    for (const change of changes.filter(c => c.payload.id)) {
      const skill = corpus.loadCorpus(repoRoot).find(s => s.id === change.payload.id);
      const response = await fetch(base + '/api/skills', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(skill) });
      if (!response.ok) throw new Error('Live API rejected skill notification; stopped');
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

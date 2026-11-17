/**
 * FreeLLM plugin routes -- all under /api/plugins/freellm/*.
 *   GET  /status                     installed / running / configured (never returns a key)
 *   POST /start   POST /stop         start or stop the FreeLLMAPI process Symphonee launched
 *   POST /chat { prompt, scope, model? }   scope MUST be 'public' or 'fictional-fixture'; secrets and
 *                                    personal / payroll looking text are refused before any network call
 * The provider keys live only inside FreeLLMAPI (encrypted); Symphonee only holds the unified local key in
 * .symphonee/freellm.json and sends it to loopback only.
 */
'use strict';
const path = require('path');
const lib = require('./lib/freellm');

module.exports = function register(ctx) {
  const { json, readBody, getConfig } = ctx;
  const repoRoot = (ctx.shell && ctx.shell.repoRoot) || process.cwd();
  const settings = () => { try { return (getConfig && getConfig('freellm.settings')) || {}; } catch (_) { return {}; } };
  const cfg = () => lib.loadConfig({ dataDir: path.join(repoRoot, '.symphonee') });
  const dir = () => settings().installDir || lib.findInstallDir({ repoRoot });
  // One manager: it remembers the process it started.
  const manager = lib.createManager({ installDir: dir(), getConfig: cfg, log: (m) => console.log('[freellm] ' + m) });

  ctx.addRoute('GET', '/status', async (_req, res) => json(res, Object.assign({ ok: true }, await manager.status())));
  ctx.addRoute('POST', '/start', async (_req, res) => { const r = await manager.start(); json(res, r, r.ok ? 200 : 500); });
  ctx.addRoute('POST', '/stop', async (_req, res) => json(res, manager.stop()));
  ctx.addRoute('POST', '/chat', async (req, res) => {
    let body; try { body = await readBody(req); } catch (_) { return json(res, { ok: false, error: 'bad JSON' }, 400); }
    const r = await lib.chat({ config: cfg(), prompt: body && body.prompt, scope: body && body.scope, model: body && body.model });
    json(res, r, r.ok ? 200 : (/^refused/.test(r.error || '') ? 403 : 502));
  });

  // Automatic start (default on): never blocks boot, never throws.
  if (settings().autostart !== false) {
    setTimeout(() => {
      manager.start().then((r) => console.log('[freellm] autostart: ' + (r.ok ? (r.already ? 'already running' : 'started') : r.error))).catch(() => {});
    }, 8000).unref();
  }
};

'use strict';
// Sentry reporting for Symphonee's unattended loops (autopilots, graph runs,
// the merge gate). One dedicated Sentry project; its DSN lives in
// config/sentry-automation.json ({ "dsn": "https://key@host/projectId" }) or
// SYMPHONEE_SENTRY_DSN. No SDK, no dependency: events and cron check-ins are
// posted as Sentry envelopes over HTTPS.
//
// Contract: these functions NEVER throw and never block a loop for long. A
// missing DSN or an unreachable Sentry resolves { ok:false, skipped|error } so
// monitoring can fail without breaking the work it watches.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'sentry-automation.json');
const CLIENT = 'symphonee-automation/1.0';
const SLUG = /^[a-z0-9][a-z0-9_-]{0,49}$/;

// Anything that looks like a credential is masked before it leaves the machine.
const SECRET_PATTERNS = [
  /sntry[su]_[A-Za-z0-9_=+/-]{10,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g, /sk_(live|test)_[A-Za-z0-9]{10,}/g, /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
// "token: abc...", "password=...": keep the name, mask the value.
const NAMED_SECRET = /(x-symphonee-token|authorization|password|secret|token|dsn)(["'\s:=]+)([^\s"',;]{8,})/gi;
function scrub(value, max = 4000) {
  let s = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch (_) { return String(value); } })();
  if (s === undefined) s = '';
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[masque]');
  s = s.replace(NAMED_SECRET, (_m, name, sep) => name + sep + '[masque]');
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function loadDsn() {
  if (process.env.SYMPHONEE_SENTRY_DSN) return process.env.SYMPHONEE_SENTRY_DSN;
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).dsn || null; } catch (_) { return null; }
}
function parseDsn(dsn) {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!u.username || !projectId || !/^\d+$/.test(projectId)) throw new Error('invalid DSN');
  return { key: u.username, host: u.host, protocol: u.protocol, projectId,
    url: u.protocol + '//' + u.host + '/api/' + projectId + '/envelope/' };
}

function httpsTransport(url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.request(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

async function sendEnvelope(type, payload, { dsn, transport = httpsTransport, timeoutMs = 10000 } = {}) {
  // Under `node --test` nothing reaches the real project unless a test passes its own DSN.
  if (dsn === undefined) dsn = process.env.NODE_TEST_CONTEXT ? null : loadDsn();
  if (!dsn) return { ok: false, skipped: 'no DSN configured' };
  let d;
  try { d = parseDsn(dsn); } catch (e) { return { ok: false, error: e.message }; }
  const header = { sent_at: new Date().toISOString(), dsn, ...(payload.event_id ? { event_id: payload.event_id } : {}) };
  const body = JSON.stringify(header) + '\n' + JSON.stringify({ type }) + '\n' + JSON.stringify(payload) + '\n';
  const headers = { 'Content-Type': 'application/x-sentry-envelope',
    'X-Sentry-Auth': 'Sentry sentry_version=7, sentry_key=' + d.key + ', sentry_client=' + CLIENT };
  try { return await transport(d.url, headers, body, timeoutMs); }
  catch (e) { return { ok: false, error: e.message }; }
}

// A message event. level: debug|info|warning|error|fatal. The fingerprint
// decides grouping: one Sentry issue per distinct fingerprint.
function event({ message, level = 'info', tags = {}, extra = {}, fingerprint, loop } = {}, opts = {}) {
  const lv = ['debug', 'info', 'warning', 'error', 'fatal'].includes(level) ? level : 'info';
  const t = {};
  for (const [k, v] of Object.entries({ ...(loop ? { boucle: loop } : {}), ...tags })) {
    if (v !== undefined && v !== null) t[String(k).slice(0, 32)] = scrub(String(v), 200);
  }
  const x = {};
  for (const [k, v] of Object.entries(extra || {})) x[String(k).slice(0, 64)] = scrub(v, 8000);
  const payload = {
    event_id: crypto.randomBytes(16).toString('hex'),
    timestamp: Date.now() / 1000, platform: 'node', level: lv, logger: 'symphonee.automation',
    environment: 'symphonee', server_name: 'symphonee',
    message: { formatted: scrub(String(message || '(sans message)'), 8000) },
    tags: t, extra: x,
    ...(Array.isArray(fingerprint) && fingerprint.length ? { fingerprint: fingerprint.map(f => String(f).slice(0, 200)) } : {}),
  };
  return sendEnvelope('event', payload, opts);
}

// A cron check-in. With `monitor` the monitor is created or updated on the
// fly (upsert): schedule (crontab string), margin and maxRuntime in minutes,
// timezone (IANA). status: in_progress | ok | error.
// Allow-list of monitors (config "monitors": [...]): a Sentry plan has a limited
// number of cron seats; check-ins for other slugs are skipped instead of
// creating disabled monitors. No list = every slug is allowed.
function allowedMonitors() {
  try { const m = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).monitors; return Array.isArray(m) ? m : null; } catch (_) { return null; }
}
function checkIn({ slug, status, checkInId, durationSec, monitor } = {}, opts = {}) {
  if (!SLUG.test(String(slug || ''))) return Promise.resolve({ ok: false, error: 'invalid monitor slug' });
  const allow = opts.monitors !== undefined ? opts.monitors : (opts.dsn ? null : allowedMonitors());
  if (allow && !allow.includes(slug)) return Promise.resolve({ ok: false, skipped: 'monitor not enabled: ' + slug });
  if (!['in_progress', 'ok', 'error'].includes(status)) return Promise.resolve({ ok: false, error: 'invalid status' });
  const id = checkInId || crypto.randomBytes(16).toString('hex');
  const payload = { check_in_id: id, monitor_slug: slug, status, environment: 'symphonee',
    ...(Number.isFinite(durationSec) ? { duration: Math.max(0, durationSec) } : {}) };
  if (monitor && monitor.schedule) {
    // schedule: a crontab string, or { type:'interval', value, unit } (unit: minute|hour|day).
    const sch = typeof monitor.schedule === 'object'
      ? { type: 'interval', value: Math.max(1, Math.round(monitor.schedule.value)), unit: monitor.schedule.unit || 'minute' }
      : { type: 'crontab', value: String(monitor.schedule) };
    payload.monitor_config = {
      schedule: sch,
      checkin_margin: Math.max(1, Math.round(monitor.margin || 30)),
      max_runtime: Math.max(1, Math.round(monitor.maxRuntime || 60)),
      timezone: monitor.timezone || 'America/Toronto',
      failure_issue_threshold: monitor.failureThreshold || 1,
      recovery_threshold: monitor.recoveryThreshold || 1,
    };
  }
  return sendEnvelope('check_in', payload, opts).then((r) => ({ ...r, checkInId: id }));
}

// "HH:MM" -> "MM HH * * *" (daily crontab) for window-based monitors.
function dailyCrontab(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  return m ? Number(m[2]) + ' ' + Number(m[1]) + ' * * *' : null;
}

function configured() { return !!loadDsn(); }

module.exports = { event, checkIn, sendEnvelope, scrub, parseDsn, dailyCrontab, configured, CONFIG_FILE };

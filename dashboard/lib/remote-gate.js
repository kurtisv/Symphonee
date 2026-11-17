'use strict';
// remote-gate -- decides, for every incoming request, whether it is a LOCAL
// caller (the PC: loopback, no forwarding headers) or a REMOTE one (the phone,
// reaching us through Tailscale Serve or any non-loopback name). SECURITY-RELEVANT.
//
// Local callers keep the existing rules unchanged (request-firewall.js + the
// per-boot API token). Remote callers are judged ONLY by the device-session
// cookie from lib/remote-access.js, and never receive the per-boot token.
//
// Why "forwarding headers count as remote": Tailscale Serve connects to us from
// 127.0.0.1, so a proxied phone request can look loopback. Serve adds forwarding
// headers, and a local CLI never sends them, so their presence marks a proxied
// request as remote even when Host says 127.0.0.1.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-headers'];
const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// Reachable by a phone WITHOUT a session: the login page and the pairing calls only.
// The manifest and icon carry no data; the browser fetches them without the session cookie, so they must be public.
const PUBLIC_REMOTE = new Set(['/remote', '/api/remote/pair', '/api/remote/session', '/mobile.webmanifest', '/icon.png']);
// Never reachable from a phone, even with a session: pairing is started on the PC only.
const LOCAL_ONLY = new Set(['/api/remote/pairing/start', '/api/remote/sessions']);

// DENY BY DEFAULT for a phone, even with a valid session. A session proves WHO is calling, not that every route is safe:
// config and secrets stay on the PC, and the phone must never approve its own command (/api/permissions/resolve) or
// run destructive routes (git push, merge, plugin install...) that BYPASS mode would otherwise let through.
const REMOTE_GET_ALLOW = new Set([
  '/mobile', '/mobile.css', '/mobile.js', '/mobile.webmanifest', '/icon.png',
  '/xterm.js', '/xterm.css', '/xterm-addon-fit.js', '/xterm-addon-unicode11.js',
  '/ws', // WebSocket upgrade (terminal output); its own checks are in server.js
  '/api/busy', '/api/startup/status', '/api/ui/context', '/api/remote/session',
  '/api/orchestrator/agents', '/api/orchestrator/tasks', '/api/orchestrator/task',
  '/api/mind/stats', '/api/mind/wakeup', '/api/mind/autopilots', '/api/mind/autopilot',
  '/api/learnings', '/api/jobs', '/api/ledger', '/api/repos',
  '/api/git/status', '/api/git/branches', '/api/git/log',
  '/api/permissions/pending', '/api/github/pulls',
]);
// Writes a phone may do: log out, ask for ONE terminal command (approved on the PC), and search Mind (read-only POST).
const REMOTE_WRITE_ALLOW = new Set(['/api/remote/logout', '/api/remote/terminal/command', '/api/mind/recall']);

function hostname(req) {
  const h = String((req && req.headers && req.headers.host) || '').toLowerCase().trim();
  if (!h) return '';
  if (h.startsWith('[')) { const i = h.indexOf(']'); return i > 0 ? h.slice(0, i + 1) : h; }
  const i = h.lastIndexOf(':');
  return i > -1 && h.indexOf(':') === i ? h.slice(0, i) : h;
}

function classify(req) {
  const hdrs = (req && req.headers) || {};
  if (FORWARD_HEADERS.some(k => hdrs[k] !== undefined)) return 'remote';
  const host = hostname(req);
  if (!host) return 'local'; // no Host: the firewall rejects it on the local path, unchanged
  return LOOPBACK_HOSTS.has(host) ? 'local' : 'remote';
}

// For remote requests. `check(cookieValue)` returns { id } for a valid session, else null.
// `cookieValue` is the sym_remote cookie. `allowedOrigin` is the https origin of
// the tailnet name (e.g. https://pc.tail1234.ts.net), or null when not configured.
function decideRemote({ method, pathname, cookieValue, check, allowedOrigin, origin }) {
  const m = String(method || 'GET').toUpperCase();
  const session = check(cookieValue);
  if (!PUBLIC_REMOTE.has(pathname) && !session) {
    return { allow: false, status: 401, code: 'REMOTE_LOGIN_REQUIRED', redirect: m === 'GET' && !pathname.startsWith('/api/') ? '/remote' : null };
  }
  if (LOCAL_ONLY.has(pathname)) return { allow: false, status: 403, code: 'LOCAL_ONLY' };
  if (!PUBLIC_REMOTE.has(pathname)) {
    const ok = MUTATING.has(m) ? REMOTE_WRITE_ALLOW.has(pathname) : REMOTE_GET_ALLOW.has(pathname);
    if (!ok) {
      // The desktop home page is not for phones: send them to the mobile one instead of a dead end.
      if (m === 'GET' && pathname === '/') return { allow: false, status: 302, code: 'USE_MOBILE', redirect: '/mobile' };
      return { allow: false, status: 403, code: 'REMOTE_NOT_ALLOWED' };
    }
  }
  if (MUTATING.has(m) && origin) {
    // A browser cross-site request always carries Origin. Only our own https origin is accepted.
    if (!allowedOrigin || String(origin).toLowerCase() !== String(allowedOrigin).toLowerCase()) {
      return { allow: false, status: 403, code: 'ORIGIN_NOT_ALLOWED' };
    }
  }
  return { allow: true, status: 200, authed: !!session, sessionId: session ? session.id : null };
}

// Single entry point used by server.js.
function decide(req, { method, pathname, cookieValue, check, allowedOrigin }) {
  const mode = classify(req);
  if (mode === 'local') return { mode: 'local', allow: true };
  const origin = req && req.headers && req.headers.origin;
  return Object.assign({ mode: 'remote' }, decideRemote({ method, pathname, cookieValue, check, allowedOrigin, origin }));
}

module.exports = { classify, decide, decideRemote, hostname, PUBLIC_REMOTE, LOCAL_ONLY, FORWARD_HEADERS, REMOTE_GET_ALLOW, REMOTE_WRITE_ALLOW };

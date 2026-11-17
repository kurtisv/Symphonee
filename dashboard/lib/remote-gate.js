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
const PUBLIC_REMOTE = new Set(['/remote', '/api/remote/pair', '/api/remote/session']);
// Never reachable from a phone, even with a session: pairing is started on the PC only.
const LOCAL_ONLY = new Set(['/api/remote/pairing/start', '/api/remote/sessions']);

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

module.exports = { classify, decide, decideRemote, hostname, PUBLIC_REMOTE, LOCAL_ONLY, FORWARD_HEADERS };

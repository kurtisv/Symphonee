'use strict';
// remote-access -- authentication for the PHONE (remote clients reaching the
// dashboard through Tailscale Serve). SECURITY-RELEVANT, pure and split out so
// it is unit-testable without a network.
//
// Model:
//   - A pairing code (6 digits, 5 minutes, 5 attempts) is shown ON THE PC only.
//     Typing it on the phone creates a device session.
//   - A device session is a random 256-bit secret handed to the phone in an
//     HttpOnly, Secure, SameSite=Strict cookie. Only its SHA-256 is stored, so a
//     read of the store file does not reveal a usable session.
//   - Sessions expire after 30 days and can be revoked one by one or all at once.
//   - The per-boot API token (lib/auth-token.js) is NEVER sent to a remote client:
//     remote requests get no injected token, and the token stays on the PC.
//
// Nothing here trusts the Host or Origin headers for authentication: those are
// handled by request-firewall.js. Authentication is the cookie only.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CODE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_ATTEMPTS = 5;
const COOKIE = 'sym_remote';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Constant-time equality for equal-length hex strings (both sides are SHA-256 hex).
function timingEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Read one cookie value from a raw Cookie header. Returns null if absent.
function cookieFrom(header) {
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

// The Set-Cookie value that gives the phone its session.
function sessionCookie(value, now = Date.now()) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // SameSite=Lax : envoye aussi quand on ouvre le lien depuis une autre application (icone d'ecran d'accueil, lien).
  // Les ecritures inter-sites restent bloquees : la verification d'origine (remote-gate) les refuse.
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// The Set-Cookie value that removes the session on the phone.
function clearedCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// True when the request reached us through the tailnet name, not loopback.
function isRemoteRequest(req, tailnetHost) {
  const h = req && req.headers && req.headers.host;
  if (!h || !tailnetHost) return false;
  return String(h).toLowerCase() === String(tailnetHost).toLowerCase();
}

function createRemoteAccess({ storePath, now = () => Date.now() }) {
  let pending = null; // { codeHash, expires, attempts }
  let store = load();

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return j && typeof j.sessions === 'object' && j.sessions ? j : { sessions: {} };
    } catch (_) { return { sessions: {} }; }
  }

  function save() {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = storePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
    try { fs.chmodSync(storePath, 0o600); } catch (_) {}
  }

  // Shown on the PC. A new call replaces any code still pending.
  function startPairing() {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    pending = { codeHash: sha256(code), expires: now() + CODE_TTL_MS, attempts: 0 };
    return { code, expiresAt: pending.expires };
  }

  // Called by the phone with the code it was shown. Returns the cookie value on success.
  function redeem(code) {
    if (!pending) return { ok: false, reason: 'no_pending_code' };
    if (now() > pending.expires) { pending = null; return { ok: false, reason: 'expired' }; }
    pending.attempts += 1;
    if (pending.attempts > MAX_ATTEMPTS) { pending = null; return { ok: false, reason: 'locked' }; }
    if (!/^\d{6}$/.test(String(code || '')) || !timingEq(sha256(String(code)), pending.codeHash)) {
      return { ok: false, reason: 'bad_code', attemptsLeft: MAX_ATTEMPTS - pending.attempts };
    }
    pending = null; // one-time use
    const id = crypto.randomBytes(12).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    store.sessions[id] = { hash: sha256(secret), created: now(), expires: now() + SESSION_TTL_MS };
    save();
    return { ok: true, value: `${id}.${secret}`, id };
  }

  // Returns { id } for a valid, unexpired session cookie value, else null.
  function check(value) {
    if (!value || typeof value !== 'string') return null;
    const dot = value.indexOf('.');
    if (dot < 1) return null;
    const id = value.slice(0, dot), secret = value.slice(dot + 1);
    const s = Object.prototype.hasOwnProperty.call(store.sessions, id) ? store.sessions[id] : null;
    if (!s || now() > s.expires) return null;
    return timingEq(sha256(secret), s.hash) ? { id } : null;
  }

  function revoke(id) {
    if (!Object.prototype.hasOwnProperty.call(store.sessions, id)) return false;
    delete store.sessions[id];
    save();
    return true;
  }

  function revokeAll() { store.sessions = {}; save(); }

  // Never exposes hashes or secrets.
  function listSessions() {
    return Object.entries(store.sessions).map(([id, s]) => ({ id, created: s.created, expires: s.expires }));
  }

  return { startPairing, redeem, check, revoke, revokeAll, listSessions };
}

module.exports = {
  createRemoteAccess, cookieFrom, sessionCookie, clearedCookie, isRemoteRequest, timingEq,
  CODE_TTL_MS, SESSION_TTL_MS, MAX_ATTEMPTS, COOKIE,
};

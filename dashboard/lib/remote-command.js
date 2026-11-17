'use strict';
// remote-command -- lets the PHONE send ONE command line to a PC terminal, but only after the
// owner approves it ON THE PC. SECURITY-RELEVANT, dependency-injected so it is unit-testable.
//
// Why it does not use permGate(): permGate follows the current permission mode, and in BYPASS
// mode every action is allowed. A command typed on a phone must NEVER ride that shortcut, so
// this module always asks (requestApproval) whatever the mode is, and it never promotes the
// answer to an "always allow" rule (the PC modal offers that button; its result is ignored).
//
// Rules: one single printable line (no control characters, no ESC, no newline); at most 2000
// characters; the terminal must exist; one pending request per phone session, three overall;
// 90 s to answer on the PC, then the request is refused.

const MAX_LEN = 2000;
const MAX_PENDING_TOTAL = 3;
const APPROVAL_TIMEOUT_MS = 90 * 1000;
// Anything below 0x20 (including ESC, CR, LF, TAB) and DEL is refused: a phone cannot smuggle
// escape sequences or a second command line into the PTY.
const FORBIDDEN = /[\x00-\x1f\x7f]/;

function validate(termId, text, knownTerms) {
  if (typeof termId !== 'string' || !termId || termId.length > 64) return { ok: false, code: 'BAD_TERMINAL' };
  if (Array.isArray(knownTerms) && !knownTerms.includes(termId)) return { ok: false, code: 'UNKNOWN_TERMINAL' };
  if (typeof text !== 'string') return { ok: false, code: 'BAD_TEXT' };
  // Control characters are checked on the RAW text: trim() would silently erase a trailing CR/LF/TAB.
  if (FORBIDDEN.test(text)) return { ok: false, code: 'CONTROL_CHARS' };
  const t = text.trim();
  if (!t) return { ok: false, code: 'EMPTY' };
  if (t.length > MAX_LEN) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, text: t };
}

function createRemoteCommand({ requestApproval, inject, listTerminals, log = () => {}, timeoutMs = APPROVAL_TIMEOUT_MS }) {
  const pendingBySession = new Set();
  let pendingTotal = 0;

  async function send({ termId, text, sessionId }) {
    const sid = String(sessionId || 'local');
    let known = null;
    try { known = typeof listTerminals === 'function' ? await listTerminals() : null; } catch (_) { known = null; }
    const v = validate(termId, text, known);
    if (!v.ok) return { status: 'refused', code: v.code };
    if (pendingBySession.has(sid)) return { status: 'refused', code: 'ALREADY_PENDING' };
    if (pendingTotal >= MAX_PENDING_TOTAL) return { status: 'refused', code: 'TOO_MANY_PENDING' };

    pendingBySession.add(sid); pendingTotal += 1;
    try {
      const shown = v.text.length > 300 ? v.text.slice(0, 300) + '...' : v.text;
      const ans = await requestApproval(
        { type: 'remote-terminal', value: `[${termId}] ${shown}`, op: 'Commande envoyee depuis le telephone (aucun BYPASS applicable)' },
        { label: `Telephone -> terminal ${termId}`, remote: true, session: sid.slice(0, 8) },
        timeoutMs,
      );
      // "promote" (always allow) is deliberately ignored: a remote command is approved one at a time.
      if (!ans || ans.decision !== 'allow') {
        const timedOut = ans && /timeout/i.test(String(ans.reason || ''));
        log(`remote command ${timedOut ? 'timeout' : 'denied'} term=${termId} session=${sid.slice(0, 8)}`);
        return { status: timedOut ? 'timeout' : 'denied' };
      }
      const r = inject(termId, v.text);
      if (r && r.ok === false) return { status: 'failed', code: 'INJECT_FAILED' };
      log(`remote command sent term=${termId} session=${sid.slice(0, 8)} len=${v.text.length}`);
      return { status: 'sent' };
    } finally {
      pendingBySession.delete(sid); pendingTotal -= 1;
    }
  }

  return { send, _validate: validate };
}

module.exports = { createRemoteCommand, validate, MAX_LEN, MAX_PENDING_TOTAL, APPROVAL_TIMEOUT_MS };

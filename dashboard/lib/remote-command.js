'use strict';
// remote-command -- lets the PHONE send ONE command line to a PC terminal, but only after the
// owner approves it ON THE PC. SECURITY-RELEVANT, dependency-injected so it is unit-testable.
//
// Why it does not use permGate(): permGate follows the current permission mode, and in BYPASS
// mode every action is allowed. A command typed on a phone must NEVER ride that shortcut, so
// this module always asks (requestApproval) whatever the mode is, and it never promotes the
// answer to an "always allow" rule (the PC modal offers that button; its result is ignored).
//
// Two modes (lib/remote-settings.js): 'ask' = every command waits for approval on the PC; 'auto' = a valid command goes
// straight to the terminal because the owner is away from the PC. Even in 'auto', a command that looks DESTRUCTIVE
// (recursive delete, format, shutdown, force push, pipe-to-shell...) still asks. Every command is written to the audit hook.
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

// Commands that keep asking on the PC even in 'auto' mode: hard to undo or able to take the PC down.
const ASK_ALWAYS = [
  /\brm\b(?=[^|;&]*\s-\w*[rR])(?=[^|;&]*\s-\w*[fF])/,
  /\bgit\s+branch\s+-D\b/,
  /\b(Remove-Item|ri|rmdir|rd|del|erase)\b.*(-Recurse|\s\/s\b)/i,
  /\bformat\s+[a-z]:/i, /\b(diskpart|mkfs)\b/i, /\bcipher\s+\/w\b/i,
  /\b(shutdown|Restart-Computer|Stop-Computer)\b/i,
  /\bgit\s+push\b.*(--force|--force-with-lease|\s-f\b)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i,
  /\b(reg\s+delete|bcdedit)\b/i,
  /\|\s*(sh|bash|iex|Invoke-Expression|powershell(\.exe)?)\b/i, /\b(iex|Invoke-Expression)\b/i,
];
function needsApproval(text) { return ASK_ALWAYS.some(re => re.test(text)); }

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

function createRemoteCommand({ requestApproval, inject, listTerminals, log = () => {}, audit = () => {}, getMode = () => 'ask', timeoutMs = APPROVAL_TIMEOUT_MS }) {
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

    const mode = getMode() === 'auto' ? 'auto' : 'ask';
    const record = (outcome) => { try { audit({ session: sid.slice(0, 8), termId, text: v.text.slice(0, 500), outcome }); } catch (_) {} };
    // 'auto' : straight to the terminal, unless the command looks destructive.
    if (mode === 'auto' && !needsApproval(v.text)) {
      const r = inject(termId, v.text);
      if (r && r.ok === false) { record('failed'); return { status: 'failed', code: 'INJECT_FAILED' }; }
      record('auto'); log(`remote command sent (auto) term=${termId} session=${sid.slice(0, 8)} len=${v.text.length}`);
      return { status: 'sent', mode: 'auto' };
    }

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
        record(timedOut ? 'timeout' : 'denied');
        return { status: timedOut ? 'timeout' : 'denied' };
      }
      const r = inject(termId, v.text);
      if (r && r.ok === false) { record('failed'); return { status: 'failed', code: 'INJECT_FAILED' }; }
      record('approved'); log(`remote command sent term=${termId} session=${sid.slice(0, 8)} len=${v.text.length}`);
      return { status: 'sent', mode: 'approved' };
    } finally {
      pendingBySession.delete(sid); pendingTotal -= 1;
    }
  }

  return { send, _validate: validate };
}

module.exports = { createRemoteCommand, validate, needsApproval, ASK_ALWAYS, MAX_LEN, MAX_PENDING_TOTAL, APPROVAL_TIMEOUT_MS };

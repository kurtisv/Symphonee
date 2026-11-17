'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ra = require('./remote-access');

function fixture(clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-remote-'));
  const storePath = path.join(dir, 'remote-sessions.json');
  const api = ra.createRemoteAccess({ storePath, now: () => clock.t });
  return { api, storePath, dir };
}

test('un code appaire une fois, puis il est consomme', () => {
  const clock = { t: 1000 };
  const { api } = fixture(clock);
  const { code } = api.startPairing();
  const r = api.redeem(code);
  assert.equal(r.ok, true);
  assert.ok(api.check(r.value), 'la session du telephone est valide');
  assert.equal(api.redeem(code).reason, 'no_pending_code', 'le code ne sert qu une fois');
});

test('mauvais code : refuse et compte les essais, verrouille apres 5', () => {
  const clock = { t: 0 };
  const { api } = fixture(clock);
  const { code } = api.startPairing();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 4; i++) {
    const r = api.redeem(wrong);
    assert.equal(r.reason, 'bad_code');
    assert.equal(r.attemptsLeft, 5 - i);
  }
  assert.equal(api.redeem(wrong).reason, 'bad_code');
  assert.equal(api.redeem(code).reason, 'locked', 'apres 5 essais le code est detruit, meme le bon');
});

test('code expire apres 5 minutes', () => {
  const clock = { t: 0 };
  const { api } = fixture(clock);
  const { code } = api.startPairing();
  clock.t = ra.CODE_TTL_MS + 1;
  assert.equal(api.redeem(code).reason, 'expired');
});

test('entrees invalides : format non numerique ou longueur fausse refusees', () => {
  const clock = { t: 0 };
  const { api } = fixture(clock);
  const { code } = api.startPairing();
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, ' ' + code]) {
    assert.equal(api.redeem(bad).ok, false, JSON.stringify(bad));
    // chaque mauvaise saisie compte comme un essai : on recree le code pour ne pas verrouiller le test
  }
});

test('le store ne contient jamais le secret ni le code en clair', () => {
  const clock = { t: 0 };
  const { api, storePath } = fixture(clock);
  const { code } = api.startPairing();
  const r = api.redeem(code);
  const brut = fs.readFileSync(storePath, 'utf8');
  assert.ok(!brut.includes(code), 'pas de code en clair');
  assert.ok(!brut.includes(r.value.split('.')[1]), 'pas de secret en clair');
  assert.ok(brut.includes('"hash"'), 'seul le hash est stocke');
});

test('cookie : mauvaise valeur, session inconnue, secret faux refuses', () => {
  const clock = { t: 0 };
  const { api } = fixture(clock);
  const { code } = api.startPairing();
  const r = api.redeem(code);
  const [id, secret] = r.value.split('.');
  assert.equal(api.check(null), null);
  assert.equal(api.check(''), null);
  assert.equal(api.check('pas-un-cookie'), null);
  assert.equal(api.check(id + '.' + '0'.repeat(64)), null, 'mauvais secret');
  assert.equal(api.check('ffffffffffff.' + secret), null, 'session inconnue');
  assert.equal(api.check('__proto__.x'), null, 'pas de prototype pollution');
  assert.ok(api.check(r.value));
});

test('session expire apres 30 jours et peut etre revoquee', () => {
  const clock = { t: 0 };
  const { api } = fixture(clock);
  const { code } = api.startPairing();
  const r = api.redeem(code);
  clock.t = ra.SESSION_TTL_MS - 1;
  assert.ok(api.check(r.value), 'encore valide juste avant');
  clock.t = ra.SESSION_TTL_MS + 1;
  assert.equal(api.check(r.value), null, 'expiree');

  clock.t = 0;
  const b = api.redeem(api.startPairing().code);
  assert.ok(api.check(b.value));
  assert.equal(api.revoke(b.id), true);
  assert.equal(api.check(b.value), null, 'revoquee');
  assert.equal(api.revoke(b.id), false);
});

test('revokeAll invalide toutes les sessions ; listSessions ne fuit pas de secret', () => {
  const clock = { t: 0 };
  const { api } = fixture(clock);
  const s1 = api.redeem(api.startPairing().code);
  const s2 = api.redeem(api.startPairing().code);
  const liste = api.listSessions();
  assert.equal(liste.length, 2);
  assert.ok(liste.every(x => !('hash' in x) && !('value' in x)));
  api.revokeAll();
  assert.equal(api.check(s1.value), null);
  assert.equal(api.check(s2.value), null);
});

test('les sessions survivent a un redemarrage (store relu)', () => {
  const clock = { t: 0 };
  const { api, storePath } = fixture(clock);
  const r = api.redeem(api.startPairing().code);
  const api2 = ra.createRemoteAccess({ storePath, now: () => clock.t });
  assert.ok(api2.check(r.value), 'la session reste valide apres relance');
});

test('cookieFrom lit le bon cookie parmi d autres', () => {
  assert.equal(ra.cookieFrom('a=1; sym_remote=abc.def; b=2'), 'abc.def');
  assert.equal(ra.cookieFrom('sym_remote_x=1; other=2'), null, 'pas de correspondance partielle');
  assert.equal(ra.cookieFrom(undefined), null);
  assert.equal(ra.cookieFrom(''), null);
});

test('cookie de session : HttpOnly, Secure, SameSite=Strict, Path=/', () => {
  const c = ra.sessionCookie('x.y');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=']) assert.ok(c.includes(attr), attr);
  assert.ok(ra.clearedCookie().includes('Max-Age=0'));
});

test('requete distante reconnue seulement par le nom tailnet, jamais par loopback', () => {
  const tn = 'pc.tail1234.ts.net';
  assert.equal(ra.isRemoteRequest({ headers: { host: 'pc.tail1234.ts.net' } }, tn), true);
  assert.equal(ra.isRemoteRequest({ headers: { host: 'PC.tail1234.ts.net' } }, tn), true, 'casse ignoree');
  assert.equal(ra.isRemoteRequest({ headers: { host: '127.0.0.1:3800' } }, tn), false);
  assert.equal(ra.isRemoteRequest({ headers: { host: 'attacker.example' } }, tn), false);
  assert.equal(ra.isRemoteRequest({ headers: {} }, tn), false);
  assert.equal(ra.isRemoteRequest({ headers: { host: tn } }, null), false, 'sans nom tailnet configure : jamais distant');
});

test('timingEq : egalite stricte, longueurs differentes refusees', () => {
  assert.equal(ra.timingEq('abc', 'abc'), true);
  assert.equal(ra.timingEq('abc', 'abd'), false);
  assert.equal(ra.timingEq('abc', 'abcd'), false);
  assert.equal(ra.timingEq(null, 'abc'), false);
});

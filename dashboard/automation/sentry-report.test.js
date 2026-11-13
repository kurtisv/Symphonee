'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sentry = require('./sentry-report');

const DSN = 'https://abc123@o1.ingest.sentry.io/4510000000000001';
function capture() {
  const sent = [];
  const transport = async (url, headers, body) => { sent.push({ url, headers, body }); return { ok: true, status: 200 }; };
  const items = () => sent.map(s => s.body.split('\n').filter(Boolean).map(l => JSON.parse(l)));
  return { sent, transport, items };
}

test('no DSN: nothing is sent and nothing throws', async () => {
  const r = await sentry.event({ message: 'x' }, { dsn: null });
  assert.equal(r.ok, false);
  assert.match(r.skipped, /no DSN/);
});

test('an event is a valid envelope with tags, level and fingerprint', async () => {
  const c = capture();
  const r = await sentry.event({ message: 'Fusion faite', level: 'info', loop: 'porte-fusion', tags: { depot: 'Gas Saver' },
    extra: { pr: 12 }, fingerprint: ['fusion', 'Gas Saver'] }, { dsn: DSN, transport: c.transport });
  assert.equal(r.ok, true);
  assert.equal(c.sent[0].url, 'https://o1.ingest.sentry.io/api/4510000000000001/envelope/');
  assert.match(c.sent[0].headers['X-Sentry-Auth'], /sentry_key=abc123/);
  const [header, item, payload] = c.items()[0];
  assert.equal(header.event_id, payload.event_id);
  assert.equal(item.type, 'event');
  assert.equal(payload.level, 'info');
  assert.equal(payload.message.formatted, 'Fusion faite');
  assert.deepEqual(payload.tags, { boucle: 'porte-fusion', depot: 'Gas Saver' });
  assert.deepEqual(payload.fingerprint, ['fusion', 'Gas Saver']);
  assert.equal(payload.server_name, 'symphonee', 'no machine name leaves the computer');
});

test('secrets are masked before sending', async () => {
  const c = capture();
  await sentry.event({ message: 'echec avec ghp_' + 'a'.repeat(36) + ' et token: supersecretvalue123',
    extra: { log: 'sntrys_' + 'b'.repeat(40) + ' sk_live_' + 'c'.repeat(24) } }, { dsn: DSN, transport: c.transport });
  const body = c.sent[0].body;
  assert.doesNotMatch(body, /ghp_a{36}/);
  assert.doesNotMatch(body, /supersecretvalue123/);
  assert.doesNotMatch(body, /sntrys_b{40}/);
  assert.doesNotMatch(body, /sk_live_c{24}/);
  assert.match(body, /token: \[masque\]/);
});

test('a check-in upserts its monitor configuration', async () => {
  const c = capture();
  const r = await sentry.checkIn({ slug: 'pleinsens-lanceur', status: 'ok', durationSec: 3,
    monitor: { schedule: sentry.dailyCrontab('08:00'), margin: 60, maxRuntime: 30 } }, { dsn: DSN, transport: c.transport });
  assert.equal(r.ok, true);
  assert.ok(r.checkInId);
  const [, item, payload] = c.items()[0];
  assert.equal(item.type, 'check_in');
  assert.equal(payload.monitor_slug, 'pleinsens-lanceur');
  assert.equal(payload.status, 'ok');
  assert.equal(payload.duration, 3);
  assert.deepEqual(payload.monitor_config.schedule, { type: 'crontab', value: '0 8 * * *' });
  assert.equal(payload.monitor_config.timezone, 'America/Toronto');
  assert.equal(payload.monitor_config.checkin_margin, 60);
});

test('invalid slug, status or DSN are refused without throwing; transport errors are absorbed', async () => {
  assert.equal((await sentry.checkIn({ slug: 'Bad Slug', status: 'ok' }, { dsn: DSN })).ok, false);
  assert.equal((await sentry.checkIn({ slug: 'ok-slug', status: 'done' }, { dsn: DSN })).ok, false);
  assert.equal((await sentry.event({ message: 'x' }, { dsn: 'not a dsn' })).ok, false);
  const r = await sentry.event({ message: 'x' }, { dsn: DSN, transport: async () => { throw new Error('reseau'); } });
  assert.deepEqual(r, { ok: false, error: 'reseau' });
  assert.equal(sentry.dailyCrontab('22:00'), '0 22 * * *');
  assert.equal(sentry.dailyCrontab('7h'), null);
});

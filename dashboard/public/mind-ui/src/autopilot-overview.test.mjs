import test from 'node:test';
import assert from 'node:assert/strict';
import { pilotIdsFrom, parseWindow, calendarModel, kpiModel, kpiHtml, calendarHtml } from './autopilot-overview.js';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const at = (h, m = 0) => new Date(2026, 10, 17, h, m, 0);
// Real shapes seen on 2026-11-17 from /api/automation/loops.
const REAL = [
  { id: 'autopilote:gas-saver', kind: 'autopilot', pilot: 'gas-saver', label: 'Autopilote Gas Saver', status: 'resting', statusLabel: 'en pause', window: '22:00-04:00' },
  { id: 'pleinsens', kind: 'graph', label: 'Boucle PleinSens', status: 'working', statusLabel: 'travaille', window: '08:00-13:00' },
  { id: 'autopilote:default', kind: 'autopilot', pilot: 'default', label: 'Autopilote Principale (Symphonee)', status: 'error', statusLabel: 'en erreur', window: '14:00-19:00' },
];

test('pilotIdsFrom : liste du serveur, sans doublon ; repli sur les deux ids historiques', () => {
  assert.deepEqual(pilotIdsFrom([{ pilot: 'default' }, { pilot: 'gas-saver' }, { pilot: 'nuit' }, { pilot: 'nuit' }]), ['default', 'gas-saver', 'nuit']);
  assert.deepEqual(pilotIdsFrom(null), ['default', 'gas-saver']);
  assert.deepEqual(pilotIdsFrom([{ nope: 1 }, null, { pilot: '' }]), ['default', 'gas-saver']);
});

test('parseWindow : plage simple, passage de minuit, textes qui ne sont pas des plages', () => {
  assert.deepEqual(parseWindow('14:00-19:00').segments, [[840, 1140]]);
  assert.deepEqual(parseWindow('22:00-04:00').segments, [[1320, 1440], [0, 240]]);
  assert.deepEqual(parseWindow('8:30 - 9:00').segments, [[510, 540]]);
  for (const bad of ['toutes les 30 min (tests 13-14 h, 19-22 h)', '', null, undefined, '09:00-09:00', '25:00-26:00', 'toujours']) assert.equal(parseWindow(bad), null, String(bad));
});

test('calendrier : trois plages reelles, minuit en deux segments, aucun chevauchement', () => {
  const m = calendarModel(REAL, at(14, 30));
  assert.equal(m.rows.length, 3);
  assert.equal(m.rows.find((r) => r.id === 'autopilote:gas-saver').segments.length, 2);
  assert.deepEqual(m.overlaps, []); assert.equal(m.nowMin, 870); assert.equal(m.nowText, '14:30');
});

test('calendrier : "dans la plage maintenant" suit l heure, y compris apres minuit', () => {
  const g = (d) => calendarModel(REAL, d).rows.find((r) => r.id === 'autopilote:gas-saver').inWindowNow;
  assert.equal(g(at(23, 0)), true); assert.equal(g(at(2, 0)), true); assert.equal(g(at(4, 0)), false); assert.equal(g(at(12, 0)), false);
});

test('calendrier : chevauchements detectes avec les heures exactes', () => {
  const m = calendarModel([{ id: 'a', label: 'A', status: 'resting', window: '10:00-14:00' }, { id: 'b', label: 'B', status: 'resting', window: '13:00-16:00' }, { id: 'c', label: 'C', status: 'resting', window: '23:00-02:00' }, { id: 'd', label: 'D', status: 'resting', window: '01:00-03:00' }], at(9));
  assert.equal(m.overlaps.length, 2);
  assert.ok(m.overlaps.some((o) => /A et B.*13:00 a 14:00/.test(o.text)));
  assert.ok(m.overlaps.some((o) => /C et D.*01:00 a 02:00/.test(o.text)));
});

test('calendrier : une boucle sans plage va dans "sans plage fixe", jamais inventee', () => {
  const m = calendarModel([{ id: 'porte-fusion', label: 'Porte de fusion', kind: 'script', status: 'resting', window: 'toutes les 30 min (tests 13-14 h, 19-22 h)' }], at(10));
  assert.equal(m.rows.length, 0); assert.equal(m.unscheduled.length, 1);
  assert.match(calendarHtml(m, esc), /Sans plage fixe/); assert.match(calendarHtml(m, esc), /Aucune plage horaire/);
});

test('calendrier : donnees absentes ou invalides ne plantent pas', () => {
  assert.deepEqual(calendarModel(null, at(1)).rows, []); assert.deepEqual(calendarModel([null, undefined, {}], at(1)).rows, []);
  assert.ok(calendarHtml(null, esc) === '');
});

test('KPI : valeurs et formules sur les boucles reelles', () => {
  const k = kpiModel({ loops: REAL, pilotSnaps: [], now: Date.now(), fresh: true });
  assert.equal(k.length, 4);
  assert.equal(k[0].value, '2'); assert.match(k[0].sub, /1 planifiee\(s\) \/ 1 en erreur/);
  assert.equal(k[1].value, '1'); assert.match(k[1].sub, /Boucle PleinSens/);
  for (const c of k) assert.ok(c.formula.length > 20, c.id + ' sans formule');
});

test('KPI : les services (script) ne comptent pas comme boucles', () => {
  const k = kpiModel({ loops: [...REAL, { id: 'porte-fusion', kind: 'script', status: 'working', label: 'Porte' }] });
  assert.equal(k[0].value, '2'); assert.equal(k[1].value, '1');
});

test('KPI travaux termines : seulement "completed" des dernieres 24 h', () => {
  const now = 1000 * 86400 * 20;
  const snaps = [{ history: [{ outcome: 'completed', at: now - 3600000 }, { outcome: 'completed', at: now - 90000000 }, { outcome: 'interrupted', at: now - 1000 }, { outcome: 'completed', at: now - 100 }] }, { history: [{ outcome: 'completed', at: now - 7200000 }] }];
  const k = kpiModel({ loops: REAL, pilotSnaps: snaps, now }); assert.equal(k[2].value, '3'); assert.equal(k[2].state, 'ok');
});

test('KPI sans source : "-" et non mesure, jamais 0', () => {
  const k = kpiModel({ loops: null, pilotSnaps: [] });
  assert.equal(k[0].value, '-'); assert.equal(k[1].value, '-'); assert.equal(k[2].value, '-'); assert.equal(k[0].state, 'unknown');
  assert.equal(k[3].value, '-'); assert.match(k[3].sub, /Non mesure/);
});

test('KPI : lecture perimee = etat stale, valeurs conservees', () => {
  const k = kpiModel({ loops: REAL, pilotSnaps: [], fresh: false });
  assert.equal(k[0].state, 'stale'); assert.equal(k[0].value, '2'); assert.match(kpiHtml(k, esc), /donnee perimee/);
});

test('rendu : echappe les noms, quatre cartes, tout est en ASCII', () => {
  const hostile = [{ id: 'x', kind: 'autopilot', label: '<img src=x onerror=1>', status: 'working', window: '09:00-10:00' }];
  const html = kpiHtml(kpiModel({ loops: hostile }), esc) + calendarHtml(calendarModel(hostile, at(9, 30)), esc);
  assert.ok(!html.includes('<img')); assert.equal((html.match(/class="apo-kpi"/g) || []).length, 4);
  assert.ok(/^[\x20-\x7E]*$/.test(html));
  assert.match(html, /apo-live/);
});

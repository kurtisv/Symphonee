'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const sym = require('./qwen-symbols');

// The worker calls the lookup AFTER the edit is on disk, so the written text is part of the working tree: mimic that.
function written(dir, text) { fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/edited.ts'), text); return text; }
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-sym-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  const g = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q'); g('add', '-f', '.'); g('commit', '-qm', 'init');
  return dir;
}
const STORE = {
  'src/storage.ts': 'export async function clearStoredQueue(key: string): Promise<void> {}\nexport async function getStoredQueue(key: string) { return [] }\n',
  'src/types.ts': 'export interface AnalyticsEventRecord {\n  name: string\n  at: number\n  props?: Record<string, string>\n}\n',
  'src/other.ts': 'export function unrelatedHelper() {}\n',
};

test('an invented call is flagged and the real, similar helper is shown with its signature', () => {
  const dir = repo(STORE);
  const items = sym.unknownCalls(dir, 'await setStoredQueue(eventQueue)\n', '', []);
  assert.deepStrictEqual(items.map((i) => i.name), ['setStoredQueue']);
  const note = sym.unknownCallsNote(items);
  assert.match(note, /NOWHERE else in the repository/);
  assert.match(note, /clearStoredQueue\s+\(src\/storage\.ts:1\)\s+export async function clearStoredQueue\(key: string\)/);
  assert.match(note, /getStoredQueue/);
  assert.doesNotMatch(note, /unrelatedHelper/);
});

test('real helpers, locals, parameters, methods, keywords and globals are NOT flagged', () => {
  const dir = repo(STORE);
  const w = 'function mine(a, cb) { cb(a); return other(a) }\nconst f = (x) => mine(x)\nif (ok) { console.log(JSON.stringify(f(1))); }\nawait clearStoredQueue("k"); arr.push(1); obj.someMethod(2); setTimeout(f, 1)\n';
  written(dir, w);
  assert.deepStrictEqual(sym.unknownCalls(dir, w, 'other(1)', []).map((i) => i.name), []);
});

test('a name the model did not write (already in the SEARCH text) is not flagged', () => {
  const dir = repo(STORE);
  assert.deepStrictEqual(sym.unknownCalls(dir, written(dir, 'legacyThing(1)\n'), 'legacyThing(1)\n', []), []);
});

test('a name defined only by the new text is not flagged, and a name used elsewhere in the repo is not flagged', () => {
  const dir = repo(Object.assign({ 'src/use.ts': 'export const v = sharedUtil(2)\n' }, STORE));
  assert.deepStrictEqual(sym.unknownCalls(dir, written(dir, 'function helperNew() {}\nhelperNew()\nsharedUtil(3)\n'), '', []), []);
});

test('no close match: the note says to GREP instead of inventing a suggestion', () => {
  const dir = repo(STORE);
  const note = sym.unknownCallsNote(sym.unknownCalls(dir, written(dir, 'zzqqWhatever(1)\n'), '', []));
  assert.match(note, /zzqqWhatever/);
  assert.match(note, /GREP/);
  assert.doesNotMatch(note, /Instead of/);
});

test('suggestions never come from a secret path', () => {
  const dir = repo(Object.assign({ 'secrets/keys.ts': 'export function setStoredKey() {}\n' }, STORE));
  const note = sym.unknownCallsNote(sym.unknownCalls(dir, written(dir, 'setStoredKeys(1)\n'), '', [/(^|\/)secrets\//]));
  assert.doesNotMatch(note, /secrets\//);
  assert.doesNotMatch(note, /setStoredKey\b/);
});

test('tsc: unknown name -> the real names that look like it; known-but-not-imported -> where it is defined', () => {
  const dir = repo(STORE);
  const a = sym.fromErrors(dir, "src/x.ts(291,15): error TS2304: Cannot find name 'setStoredQueue'.", []);
  assert.match(a, /WHAT REALLY EXISTS/);
  assert.match(a, /setStoredQueue does not exist/);
  assert.match(a, /clearStoredQueue\s+\(src\/storage\.ts:1\)/);
  const b = sym.fromErrors(dir, "src/x.ts(3,1): error TS2304: Cannot find name 'getStoredQueue'.", []);
  assert.match(b, /getStoredQueue EXISTS, it is only not imported/);
  assert.match(b, /src\/storage\.ts:2/);
});

test('tsc: a property that is not on the type shows the real definition of the type', () => {
  const dir = repo(STORE);
  const out = sym.fromErrors(dir, "src/x.ts(286,49): error TS2339: Property 'id' does not exist on type 'AnalyticsEventRecord'.", []);
  assert.match(out, /id is not a field of AnalyticsEventRecord/);
  assert.match(out, /name: string/);
  assert.match(out, /at: number/);
});

test('tsc output with nothing to look up gives no note; the redactor is applied to the whole note', () => {
  const dir = repo(STORE);
  assert.strictEqual(sym.fromErrors(dir, 'src/x.ts(1,1): error TS2322: Type string is not assignable to number.', []), '');
  const masked = sym.fromErrors(dir, "error TS2304: Cannot find name 'setStoredQueue'.", [], (x) => x.replace(/clearStoredQueue/g, '[REDACTED]'));
  assert.doesNotMatch(masked, /clearStoredQueue/);
});

test('similarity ranks the shared words first and ignores names with no shared word', () => {
  const dir = repo(STORE);
  const names = sym.similar(dir, 'setStoredQueue', []).map((s) => s.name);
  assert.ok(names.includes('clearStoredQueue') && names.includes('getStoredQueue'));
  assert.ok(!names.includes('unrelatedHelper'));
  assert.deepStrictEqual(sym.words('setStoredQueue'), ['set', 'stored', 'queue']);
});

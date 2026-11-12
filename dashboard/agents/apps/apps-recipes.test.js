'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = require('./apps-recipes');

const ID_RE = /^[a-zA-Z][\w-]{0,63}$/;
const XSS = '<img src=x onerror=alert(1)>';

function withApp(fn) {
  const app = 'zzrecipestest' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const file = path.join(R.DIR, R.normalizeApp(app) + '.json');
  try { return fn(app); } finally { try { fs.unlinkSync(file); } catch (_) {} }
}

test('actionsToSteps: pixel clicks map to click verbs with x,y target', () => {
  assert.deepStrictEqual(R.actionsToSteps([
    { name: 'click', args: { x: 10, y: 20 } },
    { name: 'click', args: { x: 1, y: 2, double: true } },
    { name: 'click', args: { x: 3, y: 4, button: 'right' } },
    { name: 'click', args: { x: 5, y: 6, button: 'middle' } },
  ]), [
    { verb: 'CLICK', target: '10,20' },
    { verb: 'DOUBLE_CLICK', target: '1,2' },
    { verb: 'RIGHT_CLICK', target: '3,4' },
    { verb: 'MIDDLE_CLICK', target: '5,6' },
  ]);
});

test('actionsToSteps: type, key, wait clamp, scroll defaults', () => {
  assert.deepStrictEqual(R.actionsToSteps([
    { name: 'type_text', args: { text: 'hi' } },
    { name: 'key', args: { combo: 'ctrl+s' } },
    { name: 'wait_ms', args: { ms: 120000 } },
    { name: 'wait_ms', args: { ms: -5 } },
    { name: 'scroll', args: {} },
    { name: 'scroll', args: { dy: -3 } },
  ]), [
    { verb: 'TYPE', text: 'hi' },
    { verb: 'PRESS', target: 'ctrl+s' },
    { verb: 'WAIT', target: '60000' },
    { verb: 'WAIT', target: '0' },
    { verb: 'SCROLL', target: '0,0' },
    { verb: 'SCROLL', target: '0,-3' },
  ]);
});

test('actionsToSteps: drag requires all four finite coordinates', () => {
  assert.deepStrictEqual(
    R.actionsToSteps([{ name: 'drag', args: { fromX: 1, fromY: 2, toX: 3, toY: 4 } }]),
    [{ verb: 'DRAG', target: '1,2', text: '3,4' }]);
  assert.deepStrictEqual(R.actionsToSteps([{ name: 'drag', args: { fromX: 1, fromY: 2 } }]), []);
  assert.deepStrictEqual(R.actionsToSteps([{ name: 'drag', args: {} }]), []);
  assert.deepStrictEqual(R.actionsToSteps([{ name: 'drag', args: { fromX: 1, fromY: 2, toX: NaN, toY: 4 } }]), []);
});

test('actionsToSteps: selector actions encode as uia: targets', () => {
  const selector = { id: 'btn1', name: 'Save', type: 'Button', class: 'Btn' };
  const t = 'uia:id=btn1|name=Save|type=Button|class=Btn';
  assert.deepStrictEqual(R.actionsToSteps([
    { name: 'click_element', args: { selector } },
    { name: 'type_into_element', args: { selector, text: 'abc' } },
    { name: 'wait_for_element', args: { selector } },
    { name: 'wait_for_element', args: { selector, timeoutMs: 900 } },
  ]), [
    { verb: 'CLICK', target: t, notes: 'UIA' },
    { verb: 'TYPE', target: t, text: 'abc', notes: 'UIA' },
    { verb: 'WAIT_UNTIL', target: t, notes: 'timeout 5000ms' },
    { verb: 'WAIT_UNTIL', target: t, notes: 'timeout 900ms' },
  ]);
});

test('actionsToSteps: malformed or unknown actions are dropped', () => {
  assert.deepStrictEqual(R.actionsToSteps([
    { name: 'explode', args: {} },
    { name: 'click', args: { x: 1 } },
    { name: 'click', args: { x: 'a', y: 2 } },
    { name: 'type_text', args: { text: 5 } },
    { name: 'key', args: {} },
    { name: 'wait_ms', args: { ms: Infinity } },
    { name: 'click_element', args: { selector: null } },
    { name: 'type_into_element', args: { selector: null, text: 'x' } },
    { name: 'wait_for_element', args: { selector: null } },
  ]), []);
  assert.deepStrictEqual(R.actionsToSteps(undefined), []);
});

test('saveRecipe: unsafe ids are replaced, safe ids kept', () => withApp((app) => {
  const r1 = R.saveRecipe(app, { id: XSS, name: 'A', steps: [{ id: XSS, verb: 'CLICK', target: '1,1' }, { id: 'my-step', verb: 'PRESS', target: 'a' }] }).recipe;
  assert.notStrictEqual(r1.id, XSS);
  assert.match(r1.id, ID_RE);
  assert.match(r1.steps[0].id, ID_RE);
  assert.notStrictEqual(r1.steps[0].id, XSS);
  assert.strictEqual(r1.steps[1].id, 'my-step');
  const r2 = R.saveRecipe(app, { id: 'my-recipe', name: 'B', steps: [] }).recipe;
  assert.strictEqual(r2.id, 'my-recipe');
  assert.strictEqual(R.getRecipe(app, 'my-recipe').name, 'B');
}));

test('saveRecipe: verb validation, uppercasing, REPEAT cap, truncation', () => withApp((app) => {
  assert.throws(() => R.saveRecipe(app, { name: 'x', steps: [{ verb: 'EXPLODE' }] }), /unknown verb/);
  assert.throws(() => R.saveRecipe(app, { steps: [] }), /name required/);
  assert.throws(() => R.saveRecipe(app, { name: '   ', steps: [] }), /name required/);
  const r = R.saveRecipe(app, {
    name: 'C',
    steps: [
      { verb: 'click', target: '1,1' },
      { verb: 'REPEAT', target: '999999' },
      { verb: 'REPEAT', target: '5' },
      { verb: 'TYPE', target: 't'.repeat(600), text: 'x'.repeat(2500), notes: 'n'.repeat(600) },
    ],
  }).recipe;
  assert.strictEqual(r.steps[0].verb, 'CLICK');
  assert.strictEqual(r.steps[1].target, '1000');
  assert.strictEqual(r.steps[2].target, '5');
  assert.strictEqual(r.steps[3].target.length, 500);
  assert.strictEqual(r.steps[3].text.length, 2000);
  assert.strictEqual(r.steps[3].notes.length, 500);
}));

test('importRecipes: fresh ids, never overwrites; deleteRecipe removes', () => withApp((app) => {
  const orig = R.saveRecipe(app, { id: 'orig-1', name: 'Original', steps: [{ verb: 'PRESS', target: 'a' }] }).recipe;
  const res = R.importRecipes(app, [{ id: 'orig-1', name: 'Imported', steps: [{ verb: 'PRESS', target: 'b' }] }, { noName: true }]);
  assert.deepStrictEqual(res, { ok: true, imported: 1 });
  const all = R.listRecipes(app).recipes;
  assert.strictEqual(all.length, 2);
  const imp = all.find(x => x.name === 'Imported');
  assert.ok(imp);
  assert.notStrictEqual(imp.id, 'orig-1');
  assert.match(imp.id, ID_RE);
  assert.deepStrictEqual(R.getRecipe(app, 'orig-1'), JSON.parse(JSON.stringify(orig)));
  assert.deepStrictEqual(R.deleteRecipe(app, 'orig-1'), { ok: true });
  assert.strictEqual(R.getRecipe(app, 'orig-1'), null);
  assert.deepStrictEqual(R.deleteRecipe(app, 'orig-1'), { ok: false, error: 'not found' });
}));

test('renderRecipeAsGoal', () => {
  assert.strictEqual(R.renderRecipeAsGoal(null), '');
  const out = R.renderRecipeAsGoal({
    name: 'Export',
    description: 'ctx',
    steps: [{ verb: 'CLICK', target: '1,2', notes: 'n' }, { verb: 'TYPE', text: 'hi' }],
  });
  assert.strictEqual(out, [
    'Run the "Export" automation. Follow these steps in order. Do NOT improvise or skip steps.',
    'Context: ctx',
    'Steps:',
    '1. CLICK 1,2   (n)',
    '2. TYPE -> "hi"',
    '',
    'When every step is done, call finish with a one-sentence confirmation.',
  ].join('\n'));
});

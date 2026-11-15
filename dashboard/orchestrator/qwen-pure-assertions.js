'use strict';

// Experimental deliberately narrow interpreter. User JavaScript is parsed,
// never evaluated as JavaScript. Unsupported syntax fails closed. This is not
// a general-purpose JS runtime and is not yet an authorization boundary.
//
// Subset (widened 2026-11-15 after the model evaluation: every correct
// solution by a 4B model used these): single-assignment `const` declarations,
// array indexing v[i] with an in-range integer, Math.abs(x), Math.max(a, b) and
// Math.min(a, b). Still refused: loops, reassignment, `let`/`var`, other calls,
// property access other than .length, spread and any global.
const assert = require('node:assert/strict');

function compile(source, exportName) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 16384) throw Error('Source limit');
  // In an object literal this key changes the prototype rather than creating
  // an own export, so interpreting it as a normal export would be unsound.
  // A top-level function named module also shadows CommonJS's module object.
  if (exportName === '__proto__' || exportName === 'module') throw Error('Unsupported export');
  let parser; try { parser = require('@babel/parser'); } catch { throw Error('Trusted parser unavailable'); }
  const ast = parser.parse(source, { sourceType: 'script', errorRecovery: false });
  const body = ast.program.body;
  if (ast.program.directives?.length || body.length !== 2 || body[0].type !== 'FunctionDeclaration' || body[0].async || body[0].generator || body[0].id?.name !== exportName || body[0].body.directives?.length) throw Error('Unsupported program');
  const fn = body[0];
  if (fn.params.some(p => p.type !== 'Identifier') || new Set(fn.params.map(p => p.name)).size !== fn.params.length) throw Error('Unsupported parameters');
  const exportExpr = body[1]?.expression;
  if (body[1].type !== 'ExpressionStatement' || exportExpr?.type !== 'AssignmentExpression' || exportExpr.operator !== '=' ||
      exportExpr.left?.type !== 'MemberExpression' || exportExpr.left.computed || exportExpr.left.object?.name !== 'module' || exportExpr.left.property?.name !== 'exports' ||
      exportExpr.right?.type !== 'ObjectExpression' || exportExpr.right.properties.length !== 1) throw Error('Unsupported exports');
  const prop = exportExpr.right.properties[0];
  if (prop.type !== 'ObjectProperty' || prop.computed || prop.method || prop.key?.name !== exportName || prop.value?.type !== 'Identifier' || prop.value.name !== exportName) throw Error('Unsupported exports');
  const scope = new Set(fn.params.map(p => p.name));
  const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'Math', 'undefined', 'NaN', 'Infinity']);
  if (fn.params.some(p => RESERVED.has(p.name))) throw Error('Unsupported parameters');
  const MATH = { abs: 1, max: 2, min: 2 };
  const binary = new Set(['+','-','*','/','%','===','!==','<','<=','>','>=']);
  function expression(n, names) {
    if (!n) throw Error('Unsupported expression');
    if (['NumericLiteral','BooleanLiteral','NullLiteral','StringLiteral'].includes(n.type)) return;
    if (n.type === 'Identifier') { if (!names.has(n.name)) throw Error('Unknown identifier'); return; }
    if (n.type === 'UnaryExpression' && ['!','-','+'].includes(n.operator)) return expression(n.argument,names);
    if ((n.type === 'BinaryExpression' && binary.has(n.operator)) || (n.type === 'LogicalExpression' && ['&&','||'].includes(n.operator))) { expression(n.left,names); expression(n.right,names); return; }
    if (n.type === 'ConditionalExpression') { expression(n.test,names); expression(n.consequent,names); expression(n.alternate,names); return; }
    if (n.type === 'MemberExpression' && !n.computed && n.property?.name === 'length') return expression(n.object,names);
    if (n.type === 'MemberExpression' && n.computed && !n.optional) { expression(n.object,names); expression(n.property,names); return; }
    if (n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && !n.callee.computed && n.callee.object?.type === 'Identifier' && n.callee.object.name === 'Math'
        && Object.hasOwn(MATH, n.callee.property?.name) && n.arguments.length === MATH[n.callee.property.name] && !n.optional) { n.arguments.forEach(a => expression(a,names)); return; }
    if (n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && !n.callee.computed && n.callee.property?.name === 'reduce' && n.arguments.length === 2) {
      expression(n.callee.object,names);
      const arrow=n.arguments[0];
      if (arrow?.type !== 'ArrowFunctionExpression' || arrow.async || arrow.params.length !== 2 || arrow.params.some(p => p.type !== 'Identifier') || arrow.params[0].name === arrow.params[1].name || arrow.body.type === 'BlockStatement') throw Error('Unsupported reduce callback');
      expression(arrow.body,new Set([...names,...arrow.params.map(p=>p.name)])); expression(n.arguments[1],names); return;
    }
    throw Error('Unsupported expression: ' + n.type);
  }
  function statement(n, names) {
    if (n.type === 'BlockStatement') { const inner = new Set(names); n.body.forEach(s=>statement(s,inner)); return; }
    if (n.type === 'VariableDeclaration') {
      const d = n.declarations[0];
      if (n.kind !== 'const' || n.declarations.length !== 1 || d.id?.type !== 'Identifier' || !d.init || names.has(d.id.name) || RESERVED.has(d.id.name)) throw Error('Unsupported statement: VariableDeclaration (only a new const with a value)');
      expression(d.init,names); names.add(d.id.name); return;
    }
    if (n.type === 'ReturnStatement' && n.argument) return expression(n.argument,names);
    if (n.type === 'IfStatement') { expression(n.test,names); statement(n.consequent,names); if(n.alternate) statement(n.alternate,names); return; }
    throw Error('Unsupported statement: ' + n.type);
  }
  statement(fn.body,scope);
  return fn;
}

function invoke(fn, args) {
  if (!Array.isArray(args) || args.length !== fn.params.length) throw Error('Argument mismatch');
  function safe(v, depth=0) {
    if (depth > 4) throw Error('Input limit');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string' && v.length <= 4096) return v;
    if (typeof v === 'number' && Number.isFinite(v) && !Object.is(v,-0)) return v;
    if (Array.isArray(v) && v.length <= 256) {
      const out=[];
      for(let i=0;i<v.length;i++) { if(!Object.hasOwn(v,i)) throw Error('Sparse arrays unsupported'); out.push(safe(v[i],depth+1)); }
      return out;
    }
    throw Error('Unsupported input');
  }
  const env = Object.create(null);
  fn.params.forEach((p,i)=>{env[p.name]=safe(args[i]);});
  let steps=0;
  function evalExpr(n,e) {
    if (++steps > 10000) throw Error('Evaluation limit');
    if (n.type === 'NullLiteral') return null;
    if (['NumericLiteral','BooleanLiteral','StringLiteral'].includes(n.type)) return n.value;
    if (n.type === 'Identifier') return e[n.name];
    if (n.type === 'UnaryExpression') { const v=evalExpr(n.argument,e); if (n.operator==='!') return !v; if(typeof v!=='number') throw Error('Numeric operand required'); return n.operator==='-' ? -v : +v; }
    if (n.type === 'ConditionalExpression') return evalExpr(n.test,e) ? evalExpr(n.consequent,e) : evalExpr(n.alternate,e);
    if (n.type === 'MemberExpression' && n.computed) {
      const arr=evalExpr(n.object,e), i=evalExpr(n.property,e);
      if (!Array.isArray(arr)) throw Error('Index requires an array');
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= arr.length) throw Error('Index out of range');
      return arr[i];
    }
    if (n.type === 'MemberExpression') { const v=evalExpr(n.object,e); if(!Array.isArray(v) && typeof v!=='string') throw Error('Length requires array or string'); return v.length; }
    if (n.type === 'CallExpression' && n.callee.object?.name === 'Math') {
      const a=n.arguments.map(x=>evalExpr(x,e));
      if (a.some(x=>typeof x!=='number')) throw Error('Numeric operand required');
      const name=n.callee.property.name;
      return name==='abs' ? Math.abs(a[0]) : name==='max' ? Math.max(a[0],a[1]) : Math.min(a[0],a[1]);
    }
    if (n.type === 'CallExpression') {
      const arr=evalExpr(n.callee.object,e); if(!Array.isArray(arr)) throw Error('Reduce requires array');
      const cb=n.arguments[0]; let acc=evalExpr(n.arguments[1],e);
      for(const item of arr) { const nested=Object.assign(Object.create(null),e); nested[cb.params[0].name]=acc; nested[cb.params[1].name]=item; acc=evalExpr(cb.body,nested); }
      return acc;
    }
    if (n.type === 'LogicalExpression') { const l=evalExpr(n.left,e); return n.operator==='&&' ? (l && evalExpr(n.right,e)) : (l || evalExpr(n.right,e)); }
    if (n.type === 'BinaryExpression') {
      const l=evalExpr(n.left,e), r=evalExpr(n.right,e);
      if (Array.isArray(l) || Array.isArray(r) || (l!==null && typeof l==='object') || (r!==null && typeof r==='object')) throw Error('Unsupported operand');
      switch(n.operator) {case '+':if ((typeof l==='string'||typeof r==='string') && String(l).length+String(r).length>8192) throw Error('String result limit');return l+r;case '-':return l-r;case '*':return l*r;case '/':return l/r;case '%':return l%r;case '===':return l===r;case '!==':return l!==r;case '<':return l<r;case '<=':return l<=r;case '>':return l>r;case '>=':return l>=r;default:throw Error('Unsupported operator');}
    }
    throw Error('Unsupported expression');
  }
  function execStmt(n,e) {
    if (++steps > 10000) throw Error('Evaluation limit');
    if(n.type==='ReturnStatement') return {returned:true,value:evalExpr(n.argument,e)};
    if(n.type==='IfStatement') { const branch=evalExpr(n.test,e)?n.consequent:n.alternate; return branch?execStmt(branch,e):null; }
    if(n.type==='VariableDeclaration') { const d=n.declarations[0]; e[d.id.name]=evalExpr(d.init,e); return null; }
    if(n.type==='BlockStatement') { const inner=Object.assign(Object.create(null),e); for(const s of n.body){const r=execStmt(s,inner);if(r?.returned)return r;} return null; }
    throw Error('Unsupported statement');
  }
  const result=execStmt(fn.body,env);
  if (!result?.returned || (typeof result.value==='number' && (!Number.isFinite(result.value) || Object.is(result.value,-0))) || result.value === undefined) throw Error('Unsupported result');
  return result.value;
}

function runPureAssertions(sources, cases) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 32) throw Error('Assertion manifest required');
  let count=0;
  for(const c of cases) {
    if(!Object.hasOwn(sources,c.file)) throw Error('Assertion source missing');
    const fn=compile(sources[c.file],c.export);
    assert.deepStrictEqual(invoke(fn,c.args),c.expected);
    count++;
  }
  return count;
}
module.exports = { compile, invoke, runPureAssertions };

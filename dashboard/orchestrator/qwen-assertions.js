'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { safeName } = require('./qwen-snapshot');

// The expectations remain in the host supervisor. Each case gets a fresh
// process in the isolated container; its exit code alone is never enough.
function isJsonSafe(v, seen = new Set(), depth = 0) {
  if (depth > 30) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0);
  if (typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  let ok;
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 300000 || Reflect.ownKeys(v).length !== v.length + 1) ok = false;
    else {
      ok = true;
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !d.enumerable || !Object.hasOwn(d, 'value') || !isJsonSafe(d.value, seen, depth + 1)) { ok = false; break; }
      }
    }
  }
  else ok = Object.getPrototypeOf(v) === Object.prototype && Reflect.ownKeys(v).every(k => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    return typeof k === 'string' && d.enumerable && Object.hasOwn(d, 'value') && isJsonSafe(d.value, seen, depth + 1);
  });
  seen.delete(v);
  return ok;
}
function validateAssertions(cases, editable) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 32) throw new Error('A fixed assertion manifest is required');
  return cases.map(c => {
    if (!c || typeof c !== 'object' || Object.keys(c).sort().join(',') !== 'args,expected,export,file' ||
        !editable.includes(safeName(c.file)) || !/^[A-Za-z_$][\w$]*$/.test(c.export) || !Array.isArray(c.args) || !isJsonSafe(c.args) || !isJsonSafe(c.expected)) throw new Error('Invalid assertion case');
    const text = JSON.stringify({ args: c.args, expected: c.expected });
    if (!text || text.length > 8192 || !Object.prototype.hasOwnProperty.call(c, 'expected')) throw new Error('Invalid assertion values');
    const value = JSON.parse(text);
    if (!Object.prototype.hasOwnProperty.call(value, 'expected')) throw new Error('Invalid expected value');
    return { file: c.file, export: c.export, args: value.args, expected: value.expected };
  });
}

const CHILD = `const [file,name,encoded,nonce]=process.argv.slice(1);const args=JSON.parse(Buffer.from(encoded,'base64'));function faithful(v,seen=new Set(),depth=0){if(depth>30)throw Error('depth');if(v===null||typeof v==='string'||typeof v==='boolean')return;if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0))throw Error('non-JSON number');return}if(typeof v!=='object'||seen.has(v))throw Error('non-JSON value');seen.add(v);if(Array.isArray(v)){for(let i=0;i<v.length;i++){if(!Object.hasOwn(v,i))throw Error('sparse');faithful(v[i],seen,depth+1)}}else{if(Object.getPrototypeOf(v)!==Object.prototype)throw Error('non-plain object');for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=='string'||!d.enumerable||!Object.hasOwn(d,'value'))throw Error('non-JSON property');faithful(d.value,seen,depth+1)}}seen.delete(v)}Promise.resolve().then(()=>require('/workspace/'+file)[name](...args)).then(v=>{faithful(v);process.stdout.write(JSON.stringify({nonce,value:v})+'\\n')}).catch(e=>{console.error(String(e));process.exitCode=1})`;

async function runAssertions(call, worker, cases) {
  // A module shares argv/stdout with CHILD and can forge its response. Never
  // expose this experimental protocol as trusted technical evidence.
  throw new Error('Independent assertion protocol is not secure');
  /* istanbul ignore next -- retained for security research, never executable */
  let executed = 0;
  for (const c of cases) {
    const nonce = crypto.randomBytes(24).toString('hex');
    const args = Buffer.from(JSON.stringify(c.args)).toString('base64');
    let output;
    try { output = await call(['exec', '--workdir', '/workspace', worker, 'node', '-e', CHILD, c.file, c.export, args, nonce], 10000); }
    catch (_) { throw new Error(`Assertion ${executed + 1} did not complete`); }
    let result;
    try { result = JSON.parse(output); } catch (_) { throw new Error(`Assertion ${executed + 1} returned no valid response`); }
    if (!result || result.nonce !== nonce || !Object.prototype.hasOwnProperty.call(result, 'value')) throw new Error(`Assertion ${executed + 1} returned an incomplete response`);
    try { assert.deepStrictEqual(result.value, c.expected); } catch (_) { throw new Error(`Assertion ${executed + 1} failed`); }
    executed++;
  }
  if (executed !== cases.length) throw new Error('Assertion count mismatch');
  return executed;
}
module.exports = { validateAssertions, runAssertions, isJsonSafe };

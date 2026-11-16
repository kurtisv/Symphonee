'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const path=require('node:path');
const {runPureAssertions}=require('./qwen-pure-assertions');
test.before(() => { require.resolve('@babel/parser'); });
const cases=[{file:'average.js',export:'average',args:[[]],expected:null},{file:'average.js',export:'average',args:[[1,2,3]],expected:2},{file:'average.js',export:'average',args:[[-2,2]],expected:0}];
const source='function average(v){if(v.length===0)return null;return v.reduce((a,b)=>a+b,0)/v.length}module.exports={average};';
test('interprets a bounded pure subset and counts all private cases',()=>assert.equal(runPureAssertions({'average.js':source},cases),3));
test('matches native Node for trusted sample inputs',()=>{
  const code=source+';process.stdout.write(JSON.stringify([average([]),average([1,2,3]),average([-2,2])]));';
  const child=cp.spawnSync(process.execPath,['-e',code],{encoding:'utf8',timeout:5000});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),cases.map(c=>runPureAssertions({'average.js':source},[c]) && c.expected));
});
test('a false expected value is rejected',()=>assert.throws(()=>runPureAssertions({'average.js':source},[{...cases[1],expected:3}])));
test('process exit, forged output, globals and hidden side effects are rejected',()=>{
  for(const bad of ["process.exit(0);function average(v){return null}module.exports={average};", "function average(v){console.log('fake');return null}module.exports={average};", "function average(v){if(false)process.exit(0);return null}module.exports={average};", "function average(v){return globalThis.process}module.exports={average};", "function average(v){return v['constructor']}module.exports={average};"]) assert.throws(()=>runPureAssertions({'average.js':bad},cases));
});
test('NaN is not equivalent to null',()=>assert.throws(()=>runPureAssertions({'average.js':'function average(v){return 0/0}module.exports={average};'},[cases[0]])));
test('string growth is bounded before concatenation',()=>{
  const src="function average(v){return v.reduce((a,b)=>a+a,'x')}module.exports={average};";
  assert.throws(()=>runPureAssertions({'average.js':src},[{...cases[0],args:[Array(32).fill(0)],expected:null}]),/String result limit/);
});
test('sparse arrays are rejected instead of changing reduce semantics',()=>{
  const src='function average(v){return v.reduce((a,b)=>a+1,0)}module.exports={average};';
  assert.throws(()=>runPureAssertions({'average.js':src},[{...cases[0],args:[Array(1)],expected:1}]),/Sparse arrays unsupported/);
});
test('rejects the special object-literal prototype key as an export',()=>{
  const src='function __proto__(v){return 42}module.exports={__proto__:__proto__};';
  assert.throws(()=>runPureAssertions({'prototype.js':src},[{file:'prototype.js',export:'__proto__',args:[0],expected:42}]),/Unsupported export/);
});
test('rejects a function that shadows the CommonJS module parameter',()=>{
  const src='function module(v){return 42}module.exports={module};';
  assert.throws(()=>runPureAssertions({'module.js':src},[{file:'module.js',export:'module',args:[0],expected:42}]),/Unsupported export/);
});
test('a separate trusted process executes and counts cases without loading source',()=>{
  const run = s => cp.spawnSync(process.execPath,['--max-old-space-size=64',path.join(__dirname,'qwen-pure-supervisor.js')],{input:JSON.stringify({sources:{'average.js':s},cases}),encoding:'utf8',timeout:5000});
  const ok=run(source); assert.equal(ok.status,0,ok.stderr); assert.deepEqual(JSON.parse(ok.stdout),{ok:true,expected:3,executed:3});
  const attack=run("console.log(JSON.stringify({nonce:process.argv[4],value:null}));process.exit(0)"); assert.notEqual(attack.status,0); assert.equal(attack.stdout,'');
  const wrong=run('function average(v){return null}module.exports={average};'); assert.notEqual(wrong.status,0);
});

// ── widened subset (2026-11-15): const, v[i], Math.abs/max/min ───────────────
const M = 1.7976931348623157e308;
const scaled = 'function average(v){if(v.length===0)return null;const s=v.reduce((m,x)=>Math.max(m,Math.abs(x)),0);if(s===0)return 0;const t=v.reduce((a,x)=>a+x/s,0);return Math.max(-1,Math.min(1,t/v.length))*s}module.exports={average};';
const one = (src, args, expected, name='average') => runPureAssertions({[name+'.js']:src},[{file:name+'.js',export:name,args,expected}]);
test('the widened subset runs the scaled average that real reviews accepted',()=>{
  for(const [args,expected] of [[[[]],null],[[[1,2,3]],2],[[[-2,2]],0],[[[M,M]],M],[[[M,M,M]],M],[[[-M,-M,-M]],-M],[[[0,0]],0],[[[4,6]],5]]) assert.equal(one(scaled,args,expected),1);
});
test('it agrees with real JavaScript on random inputs (soundness of the interpreter)',()=>{
  const real=new Function('module',scaled.replace('module.exports={average};','')+';module.exports={average};'); const mod={}; real(mod);
  let seed=7; const rnd=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648};
  for(let k=0;k<300;k++){
    const v=Array.from({length:1+Math.floor(rnd()*8)},()=>(rnd()*2-1)*(rnd()<0.3?M*0.9:1000)); const exp=mod.exports.average(v);
    if(Object.is(exp,-0)) continue; assert.equal(one(scaled,[v],exp),1);
  }
});
test('indexing, const scoping and Math work like JavaScript',()=>{
  const src='function first(v){if(v.length===0)return null;const a=v[0];const b=Math.abs(a);return Math.max(b,Math.min(v[v.length-1],10))}module.exports={first};';
  assert.equal(one(src,[[-3,1,2]],3,'first'),1); assert.equal(one(src,[[1,20]],10,'first'),1); assert.equal(one(src,[[]],null,'first'),1);
  const scoped='function f(x){if(x>0){const y=x*2;return y}return -1}module.exports={f};';
  assert.equal(one(scoped,[3],6,'f'),1); assert.equal(one(scoped,[-3],-1,'f'),1);
  assert.throws(()=>one('function f(x){if(x>0){const y=1;}return y}module.exports={f};',[1],1,'f'),/Unknown identifier/,'block scope');
  assert.throws(()=>one('function f(x){const y=y+1;return y}module.exports={f};',[1],1,'f'),/Unknown identifier/,'temporal dead zone');
});
test('everything outside the widened subset is still refused',()=>{
  const bad=[
    'function f(v){let s=0;return s}','function f(v){var s=0;return s}','function f(v){const s=0,t=1;return s}','function f(v){const s;return 1}',
    'function f(v){const [a]=v;return a}','function f(v){const {length}=v;return length}','function f(v){const v=1;return v}','function f(v){const s=1;const s=2;return s}',
    'function f(v){const Math=1;return Math}','function f(v){const __proto__=1;return 1}','function f(Math){return 1}',
    'function f(v){for(const x of v){return x}return 0}','function f(v){while(true){}}','function f(v){const s=1;s=2;return s}','function f(v){v[0]=1;return v}',
    'function f(v){return Math.floor(v[0])}','function f(v){return Math.max(v[0])}','function f(v){return Math.max(1,2,3)}','function f(v){return Math.abs(1,2)}',
    'function f(v){return Math["max"](1,2)}','function f(v){return Math.PI}','function f(v){return v.map(x=>x)}','function f(v){return v.constructor}',
    'function f(v){return Math.constructor}','function f(v){return [1]}','function f(v){return {a:1}}','function f(v){return `x`}','function f(v){return v?.length}',
    'function f(v){return (()=>1)()}','function f(v){return eval("1")}','function f(v){return new Array(1)}','function f(v){return typeof v}','function f(v){return v++}',
  ];
  for(const b of bad) assert.throws(()=>one(b+'module.exports={f};',[[1]],1,'f'),undefined,b);
  for(const [src,args] of [['function f(v){return v[1]}',[[1]]],['function f(v){return v[-1]}',[[1]]],['function f(v){return v[0.5]}',[[1]]],["function f(v){return v['constructor']}",[[1]]],['function f(v){return v[v.length]}',[[1]]],['function f(v){return v[null]}',[[1]]],['function f(v){return v[true]}',[[1]]]])
    assert.throws(()=>one(src+'module.exports={f};',args,1,'f'),/Index/,src);
  assert.throws(()=>one('function f(v){return Math.max("a",1)}module.exports={f};',[[1]],1,'f'),/Numeric operand/);
});
test('non-finite results are still refused, including through const and Math',()=>{
  assert.throws(()=>one('function f(v){const s=v[0]+v[1];return s}module.exports={f};',[[M,M]],M,'f'),/Unsupported result/);
  assert.throws(()=>one('function f(v){return Math.abs(v[0])/0}module.exports={f};',[[1]],1,'f'),/Unsupported result/);
  assert.throws(()=>one('function f(v){return Math.max(0*v[0],-0)}module.exports={f};',[[-1]],0,'f'),/Unsupported result/);
});

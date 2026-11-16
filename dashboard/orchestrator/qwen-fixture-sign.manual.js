'use strict';
// Fictional, text-only local Qwen experiment; the reviewer is simulated.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {runFixtureLoop}=require('./qwen-fixture-loop');
const {gitSnapshot,reconstructProposal}=require('./qwen-git-snapshot');
const {formatDiff}=require('./qwen-docker-adapter');
const {verifyFixture}=require('./qwen-pure-runner');
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sym-qwen-sign-fixture-'));
  try{
    const git=(...args)=>cp.execFileSync('git',['-C',root,...args],{windowsHide:true,stdio:'pipe'});
    git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
    const name='sign.js',initial='function sign(v){return 0}module.exports={sign};\n';
    fs.writeFileSync(path.join(root,name),initial);git('add',name);git('commit','-qm','fixture');
    const base=gitSnapshot(root,[name]);
    const cases=[{file:name,export:'sign',args:[-2],expected:-1},{file:name,export:'sign',args:[0],expected:0},{file:name,export:'sign',args:[7],expected:1}];
    let used=0,previous=initial;
    const dir=path.join(__dirname,'..','..','.ai-workspace','qwen-fixture-history');fs.mkdirSync(dir,{recursive:true});
    const historyFile=path.join(dir,crypto.randomBytes(12).toString('hex')+'.json');
    fs.writeFileSync(historyFile,JSON.stringify({scope:'simulation-only',history:[]}),{flag:'wx'});
    const result=await runFixtureLoop({budget:4000,deadlineMs:Date.now()+120000,usage:async()=>used,
      onHistory:async history=>fs.writeFileSync(historyFile,JSON.stringify({scope:'simulation-only',history,localTokens:used,lastProposal:previous},null,2)),
      generate:async ({feedback,signal})=>{
        const prompt='Return only CommonJS JavaScript source, no markdown. Implement function sign(v): return -1 when v is negative, 0 when v is zero, and 1 when v is positive. Export as module.exports={sign}. Source must be at most 64 bytes including the final newline. Only if, return, comparisons, arithmetic and ternary expressions are allowed; no variable declarations, built-ins, loops or other functions. Previous source:\n'+previous+'\nIndependent feedback:\n'+feedback.join('\n');
        const response=await fetch('http://127.0.0.1:1234/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'qwen3-4b-instruct-2507',messages:[{role:'user',content:prompt}],temperature:0,max_tokens:300,stream:false}),signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});
        if(!response.ok)throw Error('Local model unavailable');const json=await response.json();
        if(!Number.isFinite(json.usage?.total_tokens))throw Error('Unmeasured usage');used+=json.usage.total_tokens;
        const text=json.choices?.[0]?.message?.content;if(typeof text!=='string' || !text.trim())throw Error('No model output');
        previous=text.trim().replace(/^```(?:javascript|js)?\s*\n/i,'').replace(/\n```\s*$/,'')+'\n';
        return {diff:formatDiff([{path:name,content:Buffer.from(previous).toString('base64')}],base.files)};
      },
      verify:async ({diff})=>{
        const candidate=reconstructProposal(root,[name],diff,[name]);
        const source=Buffer.from(candidate.files[0].content,'base64').toString('utf8');let passed=0;const errors=[];
        for(let i=0;i<cases.length;i++){try{await verifyFixture({[name]:source},[cases[i]]);passed++;}catch(e){errors.push('Independent assertion '+(i+1)+': '+String(e.message||e).slice(0,160));}}
        return {passed,total:cases.length,errors};
      },
      review:async ()=>Buffer.byteLength(previous)>64?{decision:'fail',errors:['Source exceeds 64 bytes; preserve behavior while shortening it.']}:!previous.trim().endsWith(';')?{decision:'fail',errors:['Add a final semicolon after module.exports.']}:{decision:'pass',errors:[]},
    });
    if(fs.readFileSync(path.join(root,name),'utf8')!==initial || gitSnapshot(root,[name]).commit!==base.commit)throw Error('Source changed');
    fs.writeFileSync(historyFile,JSON.stringify({...result,model:'qwen3-4b-instruct-2507',reviewer:'simulated',lastProposal:previous},null,2));
    process.stdout.write(JSON.stringify({...result,historyFile},null,2)+'\n');
    if(result.status!=='fixture-validated')process.exitCode=2;
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(e=>{process.stderr.write(String(e.message||e)+'\n');process.exitCode=1;});

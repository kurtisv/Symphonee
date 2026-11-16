'use strict';
// Local text generation only: no tools, no real repository, no patch apply.
// The independent supervisor is simulated; this does not unlock Qwen agent.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {runFixtureLoop}=require('./qwen-fixture-loop');
const {gitSnapshot,reconstructProposal}=require('./qwen-git-snapshot');
const {formatDiff}=require('./qwen-docker-adapter');
const {verifyFixture}=require('./qwen-pure-runner');
const crypto=require('node:crypto');

async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sym-qwen-live-fixture-'));
  try {
    const git=(...args)=>cp.execFileSync('git',['-C',root,...args],{windowsHide:true,stdio:'pipe'});
    git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
    const name='average.js', initial='function average(v){return 0}module.exports={average};\n';
    fs.writeFileSync(path.join(root,name),initial);git('add',name);git('commit','-qm','fixture');
    const base=gitSnapshot(root,[name]);
    const cases=[{file:name,export:'average',args:[[]],expected:null},{file:name,export:'average',args:[[1,2,3]],expected:2},{file:name,export:'average',args:[[-2,2]],expected:0},{file:name,export:'average',args:[[1e308,1e308]],expected:1e308}];
    let used=0,previous=initial;
    const historyDir=path.join(__dirname,'..','..','.ai-workspace','qwen-fixture-history');
    fs.mkdirSync(historyDir,{recursive:true});
    const historyFile=path.join(historyDir,crypto.randomBytes(12).toString('hex')+'.json');
    fs.writeFileSync(historyFile,JSON.stringify({scope:'simulation-only',history:[]}),{flag:'wx'});
    const result=await runFixtureLoop({budget:5000,deadlineMs:Date.now()+180000,usage:async()=>used,
      onHistory:async history=>fs.writeFileSync(historyFile,JSON.stringify({scope:'simulation-only',history,localTokens:used,lastProposal:previous},null,2)),
      generate:async ({feedback,signal})=>{
        const prompt='Return only CommonJS JavaScript source, no markdown. Define function average(v), export as module.exports={average}. Return null for empty input; otherwise compute the arithmetic mean for finite input whenever the result is representable. The verifier rejects variable declarations (const, let, var), loops, calls other than reduce, and all other syntax. Function bodies must contain only if and return statements. An unrelated valid syntax example is: function sum(v){return v.reduce((a,b)=>a+b,0)}module.exports={sum};. Do not reuse a rejected proposal. Previous source:\n'+previous+'\nFeedback:\n'+feedback.join('\n');
        const response=await fetch('http://127.0.0.1:1234/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'qwen3-4b-instruct-2507',messages:[{role:'user',content:prompt}],temperature:0,max_tokens:600,stream:false}),signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
        if(!response.ok)throw Error('Local model unavailable');
        const json=await response.json(), tokens=json.usage?.total_tokens;
        if(!Number.isFinite(tokens) || tokens<0)throw Error('Unmeasured usage');
        used+=tokens;
        const text=json.choices?.[0]?.message?.content;
        if(typeof text!=='string' || !text.trim())throw Error('No model output');
        previous=text.trim().replace(/^```(?:javascript|js)?\s*\n/i,'').replace(/\n```\s*$/,'')+'\n';
        return {diff:formatDiff([{path:name,content:Buffer.from(previous).toString('base64')}],base.files)};
      },
      verify:async ({diff})=>{
        const candidate=reconstructProposal(root,[name],diff,[name]);
        const source=Buffer.from(candidate.files[0].content,'base64').toString('utf8');let passed=0;const errors=[];
        for(let i=0;i<cases.length;i++){try{await verifyFixture({[name]:source},[cases[i]]);passed++;}catch(e){errors.push('Independent assertion '+(i+1)+': '+String(e.message||e).slice(0,180));}}
        return {passed,total:cases.length,errors};
      },
      review:async ({technical})=>technical.passed===technical.total?{decision:'pass',errors:[]}:{decision:'fail',errors:['Fix all independent assertion failures; avoid intermediate overflow and use the supported syntax.']},
    });
    if(fs.readFileSync(path.join(root,name),'utf8')!==initial || gitSnapshot(root,[name]).commit!==base.commit)throw Error('Source changed');
    fs.writeFileSync(historyFile,JSON.stringify({...result,model:'qwen3-4b-instruct-2507',reviewer:'simulated',lastProposal:previous},null,2));
    process.stdout.write(JSON.stringify({...result,historyFile},null,2)+'\n');
    if(result.status!=='fixture-validated')process.exitCode=2;
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(e=>{process.stderr.write(String(e.message||e)+'\n');process.exitCode=1;});

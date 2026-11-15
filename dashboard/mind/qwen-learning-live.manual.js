'use strict';
// Two disposable fixture projects and their own temporary Mind graph. Qwen is
// text-only, the reviewer is simulated, and no promotion is performed.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {runFixtureLoop}=require('../orchestrator/qwen-fixture-loop');
const {gitSnapshot,reconstructProposal}=require('../orchestrator/qwen-git-snapshot');
const {formatDiff}=require('../orchestrator/qwen-docker-adapter');
const {verifyFixture}=require('../orchestrator/qwen-pure-runner');
const {makeFixtureController}=require('./qwen-learning-fixture');
async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sym-mind-qwen-live-'));
  try{
    const mindRoot=path.join(temp,'mind-host');fs.mkdirSync(mindRoot);
    const space='fixture_'+crypto.randomBytes(8).toString('hex'),queueDir=path.join(temp,'queue');
    const controller=makeFixtureController({repoRoot:mindRoot,space,queueDir});
    const cases=[{file:'sign.js',export:'sign',args:[-2],expected:-1},{file:'sign.js',export:'sign',args:[0],expected:0},{file:'sign.js',export:'sign',args:[7],expected:1}];
    async function task(project,example){
      const root=path.join(temp,project);fs.mkdirSync(root);
      const git=(...args)=>cp.execFileSync('git',['-C',root,...args],{windowsHide:true,stdio:'pipe'});
      git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
      const initial='function sign(v){return 0}module.exports={sign};\n',name='sign.js';fs.writeFileSync(path.join(root,name),initial);git('add',name);git('commit','-qm','fixture');
      const base=gitSnapshot(root,[name]),runId=crypto.randomBytes(16).toString('hex');let used=0,previous=initial,firstId;
      const lessons=controller.verifiedLessons();if(lessons.length)throw Error('Unexpected verified lesson');
      const result=await runFixtureLoop({budget:4000,deadlineMs:Date.now()+120000,usage:async()=>used,
        generate:async({feedback,signal})=>{
          const prompt='Return only CommonJS JavaScript source, no markdown. Implement function sign(v): return -1 when v is negative, 0 when v is zero, and 1 when v is positive. Export as module.exports={sign}. Source must be at most 64 bytes including the final newline. Only if, return, comparisons, arithmetic and ternary expressions are allowed; no variable declarations, built-ins, loops or other functions. Previous source:\n'+previous+'\nIndependent feedback:\n'+feedback.join('\n')+(example?'\nUnverified experimental example from a simulated review, not a validated lesson: '+example:'');
          const response=await fetch('http://127.0.0.1:1234/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'qwen3-4b-instruct-2507',messages:[{role:'user',content:prompt}],temperature:0,max_tokens:300,stream:false}),signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});
          if(!response.ok)throw Error('Local model unavailable');const json=await response.json();if(!Number.isInteger(json.usage?.total_tokens))throw Error('Usage unavailable');used+=json.usage.total_tokens;
          const text=json.choices?.[0]?.message?.content;if(typeof text!=='string' || !text.trim())throw Error('Empty output');
          previous=text.trim().replace(/^```(?:javascript|js)?\s*\n/i,'').replace(/\n```\s*$/,'')+'\n';
          return {diff:formatDiff([{path:name,content:Buffer.from(previous).toString('base64')}],base.files)};
        },
        verify:async({diff})=>{
          const proposal=reconstructProposal(root,[name],diff,[name]);const source=Buffer.from(proposal.files[0].content,'base64').toString('utf8');let passed=0;const errors=[],assertions=[];
          for(let i=0;i<cases.length;i++){try{await verifyFixture({[name]:source},[cases[i]]);passed++;assertions.push({case:i+1,expected:cases[i].expected,passed:true});}catch(e){errors.push('Assertion '+(i+1)+': '+String(e.message||e).slice(0,150));assertions.push({case:i+1,expected:cases[i].expected,passed:false});}}
          return {passed,total:cases.length,errors,assertions};
        },
        review:async()=>Buffer.byteLength(previous)>64?{decision:'fail',errors:['Source exceeds 64 bytes; preserve behavior while shortening it.']}:!previous.trim().endsWith(';')?{decision:'fail',errors:['Add a final semicolon after module.exports.']}:{decision:'pass',errors:[]},
        onAttempt:async event=>{
          const record={runId,attempt:event.attempt,problem:'Fictional '+project+' sign function',proposal:event.diff===null?'':previous,errors:[...(event.technical.errors || []),...(event.failure?[event.failure]:[])],correction:(event.review.errors || []).join('; '),assertions:event.technical.assertions || [],verdict:event.review.decision,supervisor:'simulated',tokens:event.tokens};
          const id=controller.enqueue(record);controller.flush(id);if(!firstId)firstId=id;
        },
      });
      if(fs.readFileSync(path.join(root,name),'utf8')!==initial || gitSnapshot(root,[name]).commit!==base.commit)throw Error('Source changed');
      return {result,firstId};
    }
    const a=await task('project-a',null);
    const restarted=makeFixtureController({repoRoot:mindRoot,space,queueDir});
    const recovered=restarted.findExperiment(a.firstId);
    if(!recovered || recovered.supervisor!=='simulated' || !recovered.correction)throw Error('Experimental observation unavailable');
    const b=await task('project-b',recovered.correction);
    if(restarted.verifiedLessons().length)throw Error('Simulated review promoted');
    const metric=x=>({status:x.status,reason:x.reason,successRate:x.status==='fixture-validated'?1:0,attempts:x.history.length,tokens:x.usage,repetitions:x.reason==='repeated-proposal'||x.reason==='persistent-blocker'?1:0});
    const report={classification:'experimental-only',observationRecovered:true,verifiedLessons:0,withoutMind:metric(a.result),withExperimentalExample:metric(b.result)};
    const reportDir=path.join(__dirname,'..','..','.ai-workspace','qwen-learning-reports');fs.mkdirSync(reportDir,{recursive:true});
    const reportPath=path.join(reportDir,crypto.randomBytes(12).toString('hex')+'.json');
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{flag:'wx'});
    process.stdout.write(JSON.stringify({...report,reportPath},null,2)+'\n');
    if(a.result.status!=='fixture-validated' || b.result.status!=='fixture-validated')process.exitCode=2;
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(e=>{process.stderr.write(String(e.message||e)+'\n');process.exitCode=1;});

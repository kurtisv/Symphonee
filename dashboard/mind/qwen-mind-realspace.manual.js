'use strict';
// Manual crash/concurrency probe on an explicitly supplied Symphonee root.
// It creates a unique fixture space and never reads or writes production spaces.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {promisify}=require('node:util');
const execFile=promisify(cp.execFile);
const {makeFixtureController}=require('./qwen-learning-fixture');
const store=require('./store');
async function main(){
  const root=fs.realpathSync(process.env.SYMPHONEE_FIXTURE_MIND_ROOT || '');
  if(!fs.existsSync(path.join(root,'dashboard','mind','store.js')))throw Error('Symphonee root required');
  const space='fixture_'+crypto.randomBytes(8).toString('hex');
  if(fs.existsSync(store.spaceDir(root,space)))throw Error('Fixture space already exists');
  const queue=path.join(root,'.ai-workspace','qwen-mind-isolated',space,'queue');
  const controller=makeFixtureController({repoRoot:root,space,queueDir:queue});
  const probe=path.join(__dirname,'qwen-learning-crash-probe.js');
  const make=(i)=>({runId:crypto.randomBytes(16).toString('hex'),attempt:1,problem:'Fictional isolated task '+i,proposal:'fixture-only proposal '+i,errors:['fixture-only error'],correction:'fixture-only correction',assertions:[{case:1,passed:false}],verdict:'fail',supervisor:'simulated',tokens:10});
  const crash=make('crash'),id=controller.enqueue(crash);
  const killed=cp.spawnSync(process.execPath,[probe,root,space,queue,id,'crash-after-write'],{encoding:'utf8',timeout:15000,windowsHide:true});
  if(killed.error || killed.status===0)throw Error('Crash was not observed');
  if(!controller.pending().includes(id))throw Error('Queue did not survive crash');
  const recovered=makeFixtureController({repoRoot:root,space,queueDir:queue});
  const retry=recovered.drain();
  if(!retry.some(x=>x.id===id && x.confirmed) || JSON.stringify(recovered.findExperiment(id))!==JSON.stringify(crash))throw Error('Crash recovery verification failed');
  cp.execFileSync(process.execPath,[probe,root,space,queue,id,'read'],{encoding:'utf8',timeout:15000,windowsHide:true});
  const events=Array.from({length:4},(_,i)=>make('concurrent-'+i));const ids=events.map(x=>recovered.enqueue(x));
  const outcomes=await Promise.all(ids.map(async x=>{try{await execFile(process.execPath,[probe,root,space,queue,x,'flush'],{timeout:15000,windowsHide:true});return 'completed';}catch{return 'blocked-or-failed';}}));
  const pendingBefore=recovered.pending();
  if(pendingBefore.length)recovered.drain();
  const graph=store.loadGraph(root,space), counts=[id,...ids].map(x=>graph.nodes.filter(n=>n.id===x).length);
  const report={space,scope:'experimental-isolated-space',crashObserved:true,queueRecovered:true,readAfterProcessRestart:true,concurrentOutcomes:outcomes,pendingBeforeRecovery:pendingBefore.length,oneNodePerId:counts.every(x=>x===1),verifiedLessons:recovered.verifiedLessons().length};
  const reportFile=path.join(root,'.ai-workspace','qwen-mind-isolated',space,'report.json');
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2),{flag:'wx'});
  process.stdout.write(JSON.stringify({...report,reportFile},null,2)+'\n');
  if(!report.oneNodePerId || report.verifiedLessons!==0)process.exitCode=2;
}
main().catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;});

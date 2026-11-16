'use strict';
// Child used only by the manual isolated-space storage probe.
const {makeFixtureController}=require('./qwen-learning-fixture');
const [root,space,queue,id,mode]=process.argv.slice(2);
try {
  const controller=makeFixtureController({repoRoot:root,space,queueDir:queue});
  if(mode==='crash-after-write') controller.flush(id,{afterWrite:()=>{process.kill(process.pid,'SIGKILL');}});
  else if(mode==='flush') controller.flush(id);
  else if(mode==='read') {if(!controller.findExperiment(id))throw Error('Observation not found');}
  else throw Error('Invalid fixture mode');
  process.stdout.write('ok\n');
} catch(e) {process.stderr.write(String(e.message||e)+'\n');process.exitCode=1;}

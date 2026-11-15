'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {verifyOfflineReviewContainer}=require('./qwen-docker-adapter');

test('Codex app-server initial request reaches offline fake upstream (no completed turn)', {skip:!process.env.SYMPHONEE_CODEX_OFFLINE_IMAGE,timeout:40000},()=>{
  const image=process.env.SYMPHONEE_CODEX_OFFLINE_IMAGE;
  const name='sym-codex-protocol-'+crypto.randomBytes(8).toString('hex');
  const call=(args,options={})=>cp.execFileSync('docker',args,{encoding:'utf8',timeout:30000,windowsHide:true,stdio:['pipe','pipe','pipe'],...options});
  let attempted=false;
  try {
    const imageId=call(['image','inspect',image,'--format','{{.Id}}']).trim(); attempted=true;
    call(['create','--pull','never','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','512m','--memory-swap','512m','--cpus','1','--shm-size','16m','--user','65534:65534','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=32m','--entrypoint','sh',image,'-c','sleep 35']);
    assert.equal(verifyOfflineReviewContainer(JSON.parse(call(['inspect',name]))[0],imageId).offline,true);
    call(['start',name]);
    const source=fs.readFileSync(path.join(__dirname,'qwen-appserver-probe.js'),'utf8');
    const result=JSON.parse(call(['exec','-i',name,'node'],{input:source}));
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.ok(result.requests.some(r=>r.method==='POST' && r.path==='/v1/responses'));
    const sent=result.requests.find(r=>r.method==='POST' && r.path==='/v1/responses');
    assert.deepEqual(sent.summary.toolNames,['request_user_input']);
    process.stdout.write('Fixture request metadata: '+JSON.stringify(result.requests)+'\n');
  } finally {
    if(attempted){try{call(['rm','-f',name]);}catch(_){}}
    assert.equal(call(['ps','-a','--filter','name=^/'+name+'$','--format','{{.Names}}']).trim(),'');
  }
});

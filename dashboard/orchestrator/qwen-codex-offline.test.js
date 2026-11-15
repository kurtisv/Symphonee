'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const {verifyOfflineReviewContainer}=require('./qwen-docker-adapter');

test('pinned Codex Linux binary starts in an inspected offline container', {skip:!process.env.SYMPHONEE_CODEX_OFFLINE_IMAGE,timeout:30000},()=>{
  const image=process.env.SYMPHONEE_CODEX_OFFLINE_IMAGE;
  const name='sym-codex-version-'+crypto.randomBytes(8).toString('hex');
  const call=(...args)=>cp.execFileSync('docker',args,{encoding:'utf8',timeout:15000,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let attempted=false;
  try {
    const imageId=call('image','inspect',image,'--format','{{.Id}}').trim();
    attempted=true;
    call('create','--pull','never','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','512m','--memory-swap','512m','--cpus','1','--shm-size','16m','--user','65534:65534','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=32m','--entrypoint','/usr/local/bin/codex',image,'--version');
    assert.equal(verifyOfflineReviewContainer(JSON.parse(call('inspect',name))[0],imageId).offline,true);
    assert.match(call('start','--attach',name),/^codex-cli 0\.169\.0\s*$/);
  } finally {
    if(attempted) { try { call('rm','-f',name); } catch (_) {} }
    assert.equal(call('ps','-a','--filter','name=^/'+name+'$','--format','{{.Names}}').trim(),'');
  }
});

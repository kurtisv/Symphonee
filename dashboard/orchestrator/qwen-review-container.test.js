'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {verifyOfflineReviewContainer}=require('./qwen-docker-adapter');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const fixture=()=>({Image:'sha256:fixture',Mounts:[],Config:{User:'65534:65534',Env:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/share/npm-global/bin','NODE_VERSION=22.23.2','YARN_VERSION=1.22.22','SANDBOX=qwen-code-sandbox','CLI_VERSION=0.27.3','NPM_CONFIG_PREFIX=/usr/local/share/npm-global']},NetworkSettings:{Networks:{none:{IPAddress:'',GlobalIPv6Address:''}}},HostConfig:{Binds:null,VolumesFrom:null,Privileged:false,ReadonlyRootfs:true,NetworkMode:'none',Memory:536870912,MemorySwap:536870912,NanoCpus:1000000000,PidsLimit:64,ShmSize:16777216,CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],Devices:[],Tmpfs:{'/tmp':'rw,nosuid,nodev,noexec,size=32m'}}});
test('offline review preflight fails closed on altered container permissions',()=>{
  const f=fixture(); assert.equal(verifyOfflineReviewContainer(f,'sha256:fixture').offline,true);
  for(const mutate of [x=>x.Mounts.push({Source:'/host'}),x=>x.HostConfig.Binds=['/var/run/docker.sock:/sock'],x=>x.HostConfig.Privileged=true,x=>x.HostConfig.NetworkMode='host',x=>x.HostConfig.NetworkMode='bridge',x=>x.HostConfig.CapDrop=[],x=>x.HostConfig.ReadonlyRootfs=false,x=>x.HostConfig.ShmSize=67108864,x=>x.HostConfig.Tmpfs['/other']='rw',x=>x.Config.User='root',x=>x.Image='different',x=>x.HostConfig.PidMode='container:other',x=>x.HostConfig.IpcMode='container:other',x=>x.HostConfig.SecurityOpt.push('seccomp=unconfined'),x=>x.HostConfig.DeviceRequests=[{}],x=>x.HostConfig.GroupAdd=['0'],x=>x.HostConfig.PortBindings={'80/tcp':[{}]},x=>x.HostConfig.Tmpfs['/tmp']+=',exec',x=>x.NetworkSettings.Networks.bridge={},x=>x.Config.Env=['OPENAI_API_KEY=secret'],x=>x.HostConfig.MemorySwap=-1]) {
    const bad=fixture(); mutate(bad); assert.throws(()=>verifyOfflineReviewContainer(bad,'sha256:fixture'));
  }
  for(const mutate of [x=>x.HostConfig.CgroupnsMode='host',x=>x.HostConfig.UsernsMode='host',x=>x.Config.Env.push('X=opaque')]) { const bad=fixture(); mutate(bad); assert.throws(()=>verifyOfflineReviewContainer(bad,'sha256:fixture')); }
});
test('real Docker container is inspected before an offline disposable probe', {timeout:30000}, ()=>{
  const name='sym-review-offline-'+crypto.randomBytes(8).toString('hex');
  const image='ghcr.io/qwenlm/qwen-code:0.27.3';
  const call=(...args)=>cp.execFileSync('docker',args,{encoding:'utf8',timeout:15000,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let createAttempted=false;
  try {
    const imageId=call('image','inspect',image,'--format','{{.Id}}').trim();
    createAttempted=true;
    const probe = `test ! -S /var/run/docker.sock && test ! -w /etc && test -w /tmp && test "$(id -u)" = 65534 && grep -Eq "^Seccomp:[[:space:]]+2$" /proc/self/status && grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status && grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status && awk '$5 == "/" { found=1; if ($6 !~ /^ro(,|$)/) exit 1 } END { if (!found) exit 1 }' /proc/self/mountinfo`;
    call('create','--pull','never','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','512m','--memory-swap','512m','--cpus','1','--shm-size','16m','--user','65534:65534','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=32m','--entrypoint','sh',image,'-c',probe);
    const info=JSON.parse(call('inspect',name))[0];
    assert.equal(verifyOfflineReviewContainer(info,imageId).offline,true);
    call('start','--attach',name);
    assert.equal(verifyOfflineReviewContainer(JSON.parse(call('inspect',name))[0],imageId).offline,true);
  } finally {
    if(createAttempted) { try { call('rm','-f',name); } catch (_) { /* check below; timeout remains a failing test */ } }
    const remaining=call('ps','-a','--filter','name=^/'+name+'$','--format','{{.Names}}').trim();
    assert.equal(remaining,'');
  }
});

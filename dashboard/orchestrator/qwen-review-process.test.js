'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { killProcessTree } = require('./local-providers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Windows tree termination stops a real parent and child process', { skip:process.platform !== 'win32', timeout:15000 }, async () => {
  const parent = cp.spawn(process.execPath, ['-e', "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)"], {windowsHide:true,stdio:['ignore','pipe','pipe']});
  let childPid;
  try {
    childPid = await new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(Error('child did not start')),5000);
      parent.once('error',reject);
      parent.stdout.once('data',data=>{clearTimeout(timer);resolve(Number(String(data).trim()));});
    });
    assert.ok(Number.isInteger(childPid) && childPid>0);
    const parentClosed=new Promise(resolve=>parent.once('close',resolve));
    killProcessTree(parent);
    await Promise.race([parentClosed,new Promise((_,reject)=>setTimeout(()=>reject(Error('parent survived')),5000))]);
    const output=cp.execFileSync('tasklist',['/FI',`PID eq ${childPid}`,'/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true,timeout:5000});
    assert.doesNotMatch(output,new RegExp('"'+childPid+'"'));
  } finally {
    try { if (parent.pid) cp.spawnSync('taskkill',['/PID',String(parent.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:3000}); } catch {}
    try { if (childPid) cp.spawnSync('taskkill',['/PID',String(childPid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:3000}); } catch {}
  }
});

test('orchestrator timeout kills a real review process tree and fails closed', { skip:process.platform !== 'win32', timeout:15000 }, async () => {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'sym-review-timeout-'));
  const {Orchestrator}=require('../orchestrator');
  const orch=new Orchestrator({terminals:new Map(),broadcast:()=>{},workspaceDir:workspace,getConfig:()=>({AiApiKeys:{}})});
  orch._pretrust=()=>{};
  orch._spawnImpl=()=>cp.spawn(process.execPath,['-e',"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)"],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let task, childPid;
  try {
    task=orch.spawnHeadless({cli:'codex',prompt:'fixture',cwd:workspace,readOnly:true,noRetry:true,noFallback:true,compactContext:true,cloudTimeoutMs:800,fixtureNoApiKeys:true});
    const proc=task._proc;
    childPid=await new Promise((resolve,reject)=>{proc.stdout.once('data',d=>resolve(Number(String(d).trim())));proc.once('error',reject);});
    assert.ok(Number.isInteger(childPid) && childPid>0);
    await Promise.race([new Promise(resolve=>proc.once('close',resolve)),new Promise((_,reject)=>setTimeout(()=>reject(Error('reviewer survived timeout')),5000))]);
    assert.equal(task.state,'timeout');
    const output=cp.execFileSync('tasklist',['/FI',`PID eq ${childPid}`,'/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true,timeout:5000});
    assert.doesNotMatch(output,new RegExp('"'+childPid+'"'));
  } finally {
    if(task?._timer) clearTimeout(task._timer);
    try { if(task?._proc?.pid) cp.spawnSync('taskkill',['/PID',String(task._proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:3000}); } catch {}
    try { if(childPid) cp.spawnSync('taskkill',['/PID',String(childPid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:3000}); } catch {}
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

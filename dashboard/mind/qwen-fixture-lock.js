'use strict';

// Fixture controllers only. Other Mind writers do not participate in this
// lock, so it is not a production Mind graph concurrency guarantee.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const store=require('./store');

function lockPath(root,space){store.ensureDirs(root,space);return path.join(store.spaceDir(root,space),'.qwen-fixture.lock');}
function acquireFixtureLock(root,space){
  const target=lockPath(root,space), candidate=target+'.'+crypto.randomBytes(12).toString('hex')+'.tmp';
  const token=crypto.randomBytes(24).toString('hex');
  const text=JSON.stringify({pid:process.pid,token});
  const fd=fs.openSync(candidate,'wx',0o600);
  try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try {fs.linkSync(candidate,target);} catch(e) {if(e.code==='EEXIST')throw Error('Fixture graph busy');throw e;}
  finally {fs.unlinkSync(candidate);}
  let released=false;
  return ()=>{
    if(released)return;
    if(fs.readFileSync(target,'utf8')!==text)throw Error('Fixture lock ownership changed');
    fs.unlinkSync(target);released=true;
  };
}
function recoverDeadFixtureLock(root,space){
  const target=lockPath(root,space),reaper=target+'.reaper';
  const fd=fs.openSync(reaper,'wx',0o600);
  try {
    let text;try{text=fs.readFileSync(target,'utf8');}catch(e){if(e.code==='ENOENT')return false;throw e;}
    let owner;try{owner=JSON.parse(text);}catch{throw Error('Fixture lock owner unknown');}
    if(!Number.isInteger(owner.pid) || owner.pid<=0 || !/^[a-f0-9]{48}$/.test(owner.token||''))throw Error('Fixture lock owner unknown');
    let alive=true;
    try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw Error('Fixture lock owner cannot be checked');}
    if(alive)throw Error('Fixture lock owner still alive');
    if(fs.readFileSync(target,'utf8')!==text)throw Error('Fixture lock changed');
    fs.unlinkSync(target);return true;
  } finally {fs.closeSync(fd);fs.unlinkSync(reaper);}
}
module.exports={acquireFixtureLock,recoverDeadFixtureLock};

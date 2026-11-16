'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {makeResourceJournal}=require('./qwen-resource-journal');

test('late Docker creation is detected after an empty observation and remains quarantined after restart', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sym-journal-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const journal=makeResourceJournal(dir), first=journal.begin(), second=journal.begin();
  assert.notEqual(first.id,second.id);
  journal.markUncertain(first.id);
  const recovered=makeResourceJournal(dir);
  assert.equal(recovered.load(first.id).state,'uncertain');
  const resources=new Map();
  const lookup=async (_kind,name)=>resources.get(name) || null;
  const remove=async (_kind,id)=>{for(const [name,r] of resources) if(r.id===id) resources.delete(name);};
  assert.deepEqual((await recovered.reconcile(first.id,lookup,remove)).removed,[]);
  resources.set(first.names.worker,{id:'a'.repeat(64),name:first.names.worker,labels:{'com.symphonee.review-id':first.id}});
  assert.deepEqual((await recovered.reconcile(first.id,lookup,remove)).removed,['worker']);
  assert.equal(recovered.load(first.id).state,'uncertain');
  assert.equal(recovered.pending().some(r=>r.id===first.id),true);
  assert.equal(recovered.markSettled,undefined);
});

test('reconciliation never removes an unrelated resource with the same name', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sym-journal-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const journal=makeResourceJournal(dir), r=journal.begin(); let removed=false;
  await assert.rejects(journal.reconcile(r.id,async (_kind,name)=>({name,id:'foreign',labels:{'com.symphonee.review-id':'other'}}),async()=>{removed=true;}),/identity mismatch/);
  assert.equal(removed,false);
  assert.equal(journal.pending()[0].id,r.id);
});

test('corrupt or forged journals and concurrent reconciliation fail closed', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sym-journal-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const journal=makeResourceJournal(dir), r=journal.begin();
  const filename=path.join(dir,r.id+'.json');
  fs.writeFileSync(filename,JSON.stringify({...r,state:'settled'}));
  assert.throws(()=>journal.pending(),/Invalid journal/);
  fs.writeFileSync(filename,JSON.stringify({...r,names:{...r.names,worker:'foreign'}}));
  assert.throws(()=>journal.pending(),/Invalid journal/);
  fs.writeFileSync(filename,'{');
  assert.throws(()=>journal.pending());
  fs.writeFileSync(filename,JSON.stringify(r));
  fs.writeFileSync(path.join(dir,r.id+'.lock'),'');
  assert.throws(()=>journal.pending(),/Uncertain/);
  assert.throws(()=>journal.markUncertain(r.id));
  await assert.rejects(journal.reconcile(r.id,async()=>null,async()=>{}));
});

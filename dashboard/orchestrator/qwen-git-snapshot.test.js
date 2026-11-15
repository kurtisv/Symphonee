'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { gitSnapshot, assertGitSnapshotUnchanged, reconstructProposal } = require('./qwen-git-snapshot');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-git-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const git = (...args) => cp.execFileSync('git', ['-C', root, ...args], { encoding:'utf8', windowsHide:true });
  git('init','-q'); git('config','user.email','fixture@example.invalid'); git('config','user.name','Fixture');
  fs.mkdirSync(path.join(root,'src')); fs.writeFileSync(path.join(root,'src','app.js'),'committed');
  git('add','src/app.js'); git('commit','-qm','fixture');
  return {root,git};
}

test('reconstructs exact canonical diff from committed blobs without changing the source', t => {
  const {root}=fixture(t); const base=gitSnapshot(root,['src/app.js']);
  const {formatDiff}=require('./qwen-docker-adapter');
  const change={path:'src/app.js',content:Buffer.from('changed\n').toString('base64')};
  const diff=formatDiff([change],base.files);
  const rebuilt=reconstructProposal(root,['src/app.js'],diff,['src/app.js']);
  assert.equal(rebuilt.baseCommit,base.commit);
  assert.equal(Buffer.from(rebuilt.files[0].content,'base64').toString(),'changed\n');
  assert.equal(fs.readFileSync(path.join(root,'src','app.js'),'utf8'),'committed');
  assert.throws(()=>reconstructProposal(root,['src/app.js'],diff.replaceAll('src/app.js','../escape.js'),['src/app.js']),/outside|Invalid/);
  assert.throws(()=>reconstructProposal(root,['src/app.js'],diff+'new file mode 120000\n',['src/app.js']),/metadata/);
  assert.throws(()=>reconstructProposal(root,['src/app.js'],diff.replace('-committed','-different'),['src/app.js']));
});

test('technical assertions run against reconstructed diff bytes and reject an incorrect proposal', async t => {
  const {root,git}=fixture(t);
  const name='src/app.js'; const file=path.join(root,'src','app.js');
  fs.writeFileSync(file,'function f(v){return 0}module.exports={f};\n');
  git('add',name); git('commit','-qm','javascript fixture');
  const base=gitSnapshot(root,[name]);
  const {formatDiff}=require('./qwen-docker-adapter');
  const {verifyReconstructedFixture,digest}=require('./qwen-supervision');
  const diff=content=>formatDiff([{path:name,content:Buffer.from(content).toString('base64')}],base.files);
  const good=diff('function f(v){return v+1}module.exports={f};\n');
  const manifest=[{file:name,export:'f',args:[2],expected:3}];
  const promise=verifyReconstructedFixture(root,[name],[name],good,manifest);
  manifest[0].expected=999;
  const evidence=await promise;
  assert.equal(evidence.assertionsHash,digest(JSON.stringify([{file:name,export:'f',args:[2],expected:3}])));
  manifest[0].expected=3;
  assert.equal(evidence.diffHash,digest(good)); assert.equal(evidence.executed,1);
  await assert.rejects(verifyReconstructedFixture(root,[name],[name],diff('function f(v){return v+2}module.exports={f};\n'),manifest));
  assert.equal(fs.readFileSync(file,'utf8'),'function f(v){return 0}module.exports={f};\n');
});

test('refuses changed protected files and modified files without assertions', async t => {
  const {root,git}=fixture(t);
  const names=['src/app.js','src/other.js'];
  for (const name of names) fs.writeFileSync(path.join(root,...name.split('/')),'function f(v){return 0}module.exports={f};\n');
  git('add',...names); git('commit','-qm','two-file fixture');
  const base=gitSnapshot(root,names); const {formatDiff}=require('./qwen-docker-adapter');
  const {verifyReconstructedFixture}=require('./qwen-supervision');
  const content=Buffer.from('function f(v){return v}module.exports={f};\n').toString('base64');
  const diff=formatDiff(names.map(name=>({path:name,content})),base.files);
  const cases=[{file:names[0],export:'f',args:[1],expected:1}];
  await assert.rejects(verifyReconstructedFixture(root,names,[names[0]],diff,cases),/outside allowed/);
  await assert.rejects(verifyReconstructedFixture(root,names,names,diff,cases),/Every changed file/);
});

test('arbitrary orchestrators and temporary roots are not exported as review entry points', () => {
  const entry=require('./qwen-supervision');
  assert.equal(entry.reviewReconstructedFixture,undefined);
  assert.equal(entry.runIsolatedFixtureReview,undefined);
  assert.equal(typeof entry.runInfinityFixtureReview,'function');
});

test('reads verified committed blob and rejects working changes', t => {
  const {root}=fixture(t); const snap=gitSnapshot(root,['src/app.js']);
  assert.equal(Buffer.from(snap.files[0].content,'base64').toString(),'committed');
  fs.writeFileSync(path.join(root,'src','app.js'),'uncommitted secret');
  assert.throws(()=>gitSnapshot(root,['src/app.js']), /clean/);
  assert.throws(()=>assertGitSnapshotUnchanged(snap), /clean|changed/);
});

test('replaced directory junction cannot supply bytes to the Git snapshot', t => {
  const {root}=fixture(t); const outside=fs.mkdtempSync(path.join(os.tmpdir(),'sym-git-outside-'));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'app.js'),'outside secret');
  fs.renameSync(path.join(root,'src'),path.join(root,'saved'));
  fs.symlinkSync(outside,path.join(root,'src'),'junction');
  assert.throws(()=>gitSnapshot(root,['src/app.js']));
  fs.rmSync(path.join(root,'src')); fs.renameSync(path.join(root,'saved'),path.join(root,'src'));
  assert.equal(Buffer.from(gitSnapshot(root,['src/app.js']).files[0].content,'base64').toString(),'committed');
});

test('Git environment redirection is ignored', t => {
  const {root}=fixture(t); const previous=process.env.GIT_DIR;
  t.after(()=>{ if(previous===undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR=previous; });
  process.env.GIT_DIR=path.join(root,'missing-git-dir');
  assert.equal(Buffer.from(gitSnapshot(root,['src/app.js']).files[0].content,'base64').toString(),'committed');
});

test('committed symbolic-link blobs are rejected', t => {
  const {root,git}=fixture(t);
  git('config','core.symlinks','false');
  fs.writeFileSync(path.join(root,'link.js'),'src/app.js');
  const oid=git('hash-object','-w','--','link.js').trim();
  git('update-index','--add','--cacheinfo',`120000,${oid},link.js`);
  git('commit','-qm','fixture symbolic link');
  assert.throws(()=>gitSnapshot(root,['link.js']), /Special|linked|clean/);
});

test('configured Git filters are refused before worktree status', t => {
  const {root,git}=fixture(t);
  git('config','filter.untrusted.clean','should-not-run');
  assert.throws(()=>gitSnapshot(root,['src/app.js']), /Git filters/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { formatDiff, runQwenDocker, cleanupResources, validateToolEvents, gitState } = require('./qwen-docker-adapter');

test('proposed diff records missing final newlines and passes git apply --check', t => {
  const b64 = s => Buffer.from(s).toString('base64');
  const diff = formatDiff([{ path: 'average.js', content: b64('new') }], [{ path: 'average.js', content: b64('old') }]);
  assert.match(diff, /--- a\/average\.js\n\+\+\+ b\/average\.js/);
  assert.equal((diff.match(/\\ No newline at end of file/g) || []).length, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-diff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'average.js'), 'old');
  const result = spawnSync('git', ['apply', '--check', '-'], { cwd: dir, input: diff, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'average.js'), 'utf8'), 'old');
});

test('an already-cancelled run fails before reading files or starting Docker', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(runQwenDocker({ signal: abort.signal }), /Cancelled/);
});

test('cleanup retries failed removals and verifies no containers or network remain', async () => {
  const containers = new Set(['worker', 'relay']); const networks = new Set(['net']); let failed = false;
  const fake = async args => {
    if (args[0] === 'rm') { if (!failed) { failed = true; throw Error('daemon restart'); } containers.delete(args[2]); return ''; }
    if (args[0] === 'network' && args[1] === 'rm') { if (containers.size) throw Error('in use'); networks.delete(args[2]); return ''; }
    if (args[0] === 'ps') return [...containers].join('\n');
    if (args[0] === 'network' && args[1] === 'ls') return [...networks].join('\n');
    throw Error('unexpected');
  };
  await cleanupResources(fake, 'worker', 'relay', 'net');
  assert.equal(containers.size, 0); assert.equal(networks.size, 0);
});

test('cleanup fails closed when daemon is unavailable or a resource survives', async () => {
  await assert.rejects(cleanupResources(async () => { throw Error('daemon down'); }, 'w', 'r', 'n'), /could not be verified/);
  const survivor = async args => args[0] === 'ps' ? 'w\n' : '';
  await assert.rejects(cleanupResources(survivor, 'w', 'r', 'n'), /resource remains/);
});

test('documents that exit code zero does not prove assertions ran', () => {
  const result = spawnSync(process.execPath, ['-e', "process.exit(0); require('node:assert/strict').fail('unreachable')"], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('selected unmerged Git files are refused', async () => {
  const fake = async (cmd, args) => args.includes('ls-files') ? '100644 conflict 1\tapp.js\n' : '/fixture\n';
  await assert.rejects(gitState('/fixture', ['app.js'], null, fake), /Git conflicts/);
});

test('Docker startup, network, timeout and crash failures remove every created resource', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-faults-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'app.js'), 'old'); fs.writeFileSync(path.join(dir, 'test.js'), 'test');
  for (const failure of ['network-create', 'relay-create', 'network-connect', 'worker-start', 'qwen-timeout', 'qwen-crash']) {
    const containers = new Set(), networks = new Set();
    const fake = async args => {
      if (args[0] === 'network' && args[1] === 'create') { networks.add(args[3]); if (failure === 'network-create') throw Error('network creation timeout'); return ''; }
      if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify([{ Internal:true }]);
      if (args[0] === 'create') { const n=args[args.indexOf('--name')+1]; containers.add(n); if (failure === 'relay-create' && n.endsWith('-relay')) throw Error('create lost response'); return ''; }
      if (args[0] === 'network' && args[1] === 'connect') { if (failure === 'network-connect') throw Error('network failure'); return ''; }
      if (args[0] === 'inspect') {
        const worker=args[1].endsWith('-worker'); const network=[...networks][0];
        return JSON.stringify([{ Mounts:[], Config:{User:'65534:65534'}, HostConfig:{Privileged:false,ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],CapAdd:[],Devices:[],Binds:[],PortBindings:{},NetworkMode:worker?network:'bridge',ShmSize:16777216,Memory:worker?1073741824:134217728,PidsLimit:worker?64:32,NanoCpus:2000000000,Tmpfs:worker?{'/workspace':'size=64m','/tmp':'size=32m'}:{}} }]);
      }
      if (args[0] === 'start') { if (failure === 'worker-start' && args[1].endsWith('-worker')) throw Error('startup failed'); return ''; }
      if (args[0] === 'exec') { if (args.includes('qwen')) throw Error(failure === 'qwen-timeout' ? 'timeout' : 'process crash'); return ''; }
      if (args[0] === 'rm') { containers.delete(args[2]); return ''; }
      if (args[0] === 'network' && args[1] === 'rm') { networks.delete(args[2]); return ''; }
      if (args[0] === 'ps') return [...containers].join('\n');
      if (args[0] === 'network' && args[1] === 'ls') return [...networks].join('\n');
      return '';
    };
    const run = async cmd => { if (cmd === 'git') { const e=Error('not a git repository'); e.stderr='not a git repository'; throw e; } return JSON.stringify({ engines:[{name:'vulkan',hardwareSurvey:{gpuSurveyResult:{result:{code:'success'},gpuInfo:[{}]}}}] }); };
    const fetch = async () => ({ok:true,json:async()=>({data:[{id:'qwen3-4b-instruct-2507',state:'loaded',loaded_context_length:12288}]})});
    const gitSnapshot = (root, files) => ({root, commit:'fixture', files:require('./qwen-snapshot').snapshotFiles(root, files)});
    const assertions = [{file:'app.js',export:'answer',args:[],expected:1}];
    await assert.rejects(runQwenDocker({root:dir,files:['app.js','test.js'],editable:['app.js'],assertions,prompt:'fix'}, {docker:fake,run,fetch,gitSnapshot,freemem:()=>8e9}), undefined, failure);
    assert.equal(containers.size, 0, failure); assert.equal(networks.size, 0, failure);
  }
});

test('tool audit rejects edits outside selection even if later restored', () => {
  const call = (id, name, input) => ({ message: { content: [{ type: 'tool_use', id, name, input }] } });
  const done = id => ({ message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false }] } });
  const events = [call('1','read_file',{file_path:'/workspace/app.js'}),done('1'),call('2','edit',{file_path:'/workspace/app.js'}),done('2'),call('3','run_shell_command',{command:'node test.js'}),done('3')];
  assert.deepEqual(validateToolEvents(events, ['app.js','test.js'], ['app.js']), ['read_file','edit','run_shell_command']);
  assert.throws(() => validateToolEvents([...events, call('4','edit',{file_path:'/workspace/test.js'}),done('4')], ['app.js','test.js'], ['app.js']), /outside its selection/);
  assert.throws(() => validateToolEvents([...events, call('5','run_shell_command',{command:'node other.js'}),done('5')], ['app.js','test.js'], ['app.js']), /Unexpected shell/);
});

test('a failed permitted call is tolerated, a failed forbidden call or a missing result is not', () => {
  const call = (id, name, input) => ({ message: { content: [{ type: 'tool_use', id, name, input }] } });
  const done = (id, is_error = false) => ({ message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });
  const ok = [call('1','read_file',{file_path:'/workspace/app.js'}),done('1'),call('2','edit',{file_path:'/workspace/app.js'}),done('2'),call('3','run_shell_command',{command:'node test.js'}),done('3')];
  assert.deepEqual(validateToolEvents([call('0','edit',{file_path:'/workspace/app.js'}),done('0',true),...ok], ['app.js','test.js'], ['app.js']).length, 4);
  assert.throws(() => validateToolEvents([call('0','edit',{file_path:'/workspace/test.js'}),done('0',true),...ok], ['app.js','test.js'], ['app.js']), /outside its selection/, 'a refused attempt outside the selection still voids the proposal');
  assert.throws(() => validateToolEvents([call('0','run_shell_command',{command:'cat /etc/passwd'}),done('0',true),...ok], ['app.js','test.js'], ['app.js']), /Unexpected shell/);
  assert.throws(() => validateToolEvents([...ok, call('4','read_file',{file_path:'/workspace/app.js'})], ['app.js','test.js'], ['app.js']), /no result/);
  const onlyFailedEdit = [call('1','read_file',{file_path:'/workspace/app.js'}),done('1'),call('2','edit',{file_path:'/workspace/app.js'}),done('2',true),call('3','run_shell_command',{command:'node test.js'}),done('3')];
  assert.throws(() => validateToolEvents(onlyFailedEdit, ['app.js','test.js'], ['app.js']), /successful read, edit and test/);
});

test('developer model comes from a fixed profile list; only the 9B relay sets reasoning_effort none', async t => {
  const vm = require('node:vm');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'app.js'), 'old'); fs.writeFileSync(path.join(dir, 'test.js'), 'test');
  const assertions = [{file:'app.js',export:'answer',args:[],expected:1}];
  const gitSnapshot = (root, files) => ({root, commit:'fixture', files:require('./qwen-snapshot').snapshotFiles(root, files)});
  await assert.rejects(runQwenDocker({root:dir,files:['app.js','test.js'],editable:['app.js'],assertions,prompt:'fix',model:'qwen/other'}, {gitSnapshot}), /Unsupported Qwen developer model/);
  for (const [model, ctx, effort, wall] of [['qwen3-4b-instruct-2507', 12288, false, '240s'], ['qwen/qwen3.5-9b', 16384, true, '480s']]) {
    let relayCode = null, qwenArgs = null;
    const fake = async args => {
      if (args[0] === 'create' && args.at(-2) === '-e') { relayCode = args.at(-1); throw Error('stop after relay create'); }
      if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify([{ Internal:true }]);
      return '';
    };
    const run = async () => JSON.stringify({ engines:[{name:'vulkan',hardwareSurvey:{gpuSurveyResult:{result:{code:'success'},gpuInfo:[{}]}}}] });
    const fetchSmall = async () => ({ok:true,json:async()=>({data:[{id:model,state:'loaded',loaded_context_length:ctx - 1}]})});
    await assert.rejects(runQwenDocker({root:dir,files:['app.js','test.js'],editable:['app.js'],assertions,prompt:'fix',model}, {docker:fake,run,fetch:fetchSmall,gitSnapshot,freemem:()=>8e9}), /context is not loaded/, model);
    const fetch = async () => ({ok:true,json:async()=>({data:[{id:model,state:'loaded',loaded_context_length:ctx}]})});
    await assert.rejects(runQwenDocker({root:dir,files:['app.js','test.js'],editable:['app.js'],assertions,prompt:'fix',model}, {docker:fake,run,fetch,gitSnapshot,freemem:()=>8e9}), /stop after relay/);
    new vm.Script(relayCode); // the generated relay is valid JavaScript
    assert.equal(/reasoning_effort=effort/.test(relayCode) && relayCode.includes('const effort="none"'), effort, model);
    assert.ok(relayCode.includes('2097152'), 'body size limit kept');
    void qwenArgs; void wall;
  }
});

'use strict';

// Experimental, opt-in Docker runner. It never mounts a host directory and
// returns proposals only. The caller must independently review any proposal.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { snapshotFiles, validateProposal, assertSourceUnchanged } = require('./qwen-snapshot');
const exec = promisify(execFile);
const IMAGE = 'ghcr.io/qwenlm/qwen-code:0.27.3';
const MODEL = 'qwen3-4b-instruct-2507';
const run = async (cmd, args, timeout = 20000, signal) => (await exec(cmd, args, { timeout, signal, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout;
const docker = (args, timeout, signal) => run('docker', args, timeout, signal);

async function gitState(root, files, signal, runGit = run) {
  try { await runGit('git', ['-C', root, 'rev-parse', '--show-toplevel'], 10000, signal); }
  catch (e) {
    if (!signal?.aborted && /not a git repository/i.test(String(e.stderr))) return null;
    throw new Error('Unable to verify Git state');
  }
  const unmerged = await runGit('git', ['-C', root, 'ls-files', '-u', '--', ...files], 10000, signal);
  if (unmerged.trim()) throw new Error('Selected files have Git conflicts');
  const head = await runGit('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], 10000, signal);
  const status = await runGit('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...files], 10000, signal);
  return JSON.stringify({ head, status });
}

async function cleanupResources(call, worker, relay, network) {
  // Removal can fail after a partial create, or while the daemon is unavailable.
  // Never report success unless absence has been verified for all three names.
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const name of [worker, relay]) { try { await call(['rm', '-f', name]); } catch (_) {} }
    try { await call(['network', 'rm', network]); } catch (_) {}
    let containers, networks;
    try {
      containers = (await call(['ps', '-a', '--format', '{{.Names}}'])).split(/\r?\n/);
      networks = (await call(['network', 'ls', '--format', '{{.Name}}'])).split(/\r?\n/);
    } catch (_) { throw new Error('Docker cleanup could not be verified'); }
    if (!containers.includes(worker) && !containers.includes(relay) && !networks.includes(network)) return;
  }
  throw new Error('Docker cleanup failed: a task resource remains');
}

function formatDiff(changes, snapshot) {
  return changes.map(c => {
    const before = Buffer.from(snapshot.find(x => x.path === c.path).content, 'base64').toString('utf8');
    const after = Buffer.from(c.content, 'base64').toString('utf8');
    const a = before.split('\n'); const b = after.split('\n');
    if (a.at(-1) === '') a.pop(); if (b.at(-1) === '') b.pop();
    const lines = a.map(x => '-' + x);
    if (a.length && !before.endsWith('\n')) lines.push('\\ No newline at end of file');
    lines.push(...b.map(x => '+' + x));
    if (b.length && !after.endsWith('\n')) lines.push('\\ No newline at end of file');
    return `--- a/${c.path}\n+++ b/${c.path}\n@@ -1,${a.length} +1,${b.length} @@\n` + lines.join('\n') + '\n';
  }).join('');
}

function validateToolEvents(events, files, editable) {
  if (!Array.isArray(events)) throw new Error('Qwen did not return auditable tool events');
  const items = events.flatMap(x => Array.isArray(x?.message?.content) ? x.message.content : []);
  const calls = items.filter(x => x.type === 'tool_use');
  const outcomes = new Map(items.filter(x => x.type === 'tool_result').map(x => [x.tool_use_id, x]));
  for (const call of calls) {
    if (!['read_file', 'edit', 'run_shell_command'].includes(call.name)) throw new Error('Unexpected Qwen tool');
    const outcome = outcomes.get(call.id);
    if (!outcome || outcome.is_error) throw new Error('Qwen tool failed or has no result');
    if (call.name === 'run_shell_command' && call.input?.command !== 'node test.js') throw new Error('Unexpected shell command');
    if (call.name === 'edit' || call.name === 'read_file') {
      const allowed = call.name === 'edit' ? editable : files;
      const input = call.input?.file_path;
      if (typeof input !== 'string' || !allowed.some(name => input === '/workspace/' + name)) throw new Error('Qwen accessed a file outside its selection');
    }
  }
  if (!calls.some(c => c.name === 'read_file') || !calls.some(c => c.name === 'edit') || !calls.some(c => c.name === 'run_shell_command')) throw new Error('Qwen did not demonstrate read, edit and test tools');
  return calls.map(c => c.name);
}

async function runQwenDocker({ root, files, editable, prompt, signal }, dependencies = {}) {
  const dockerRun = dependencies.docker || docker;
  const runProcess = dependencies.run || run;
  const fetchLocal = dependencies.fetch || fetch;
  if (signal?.aborted) throw new Error('Cancelled');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Invalid task');
  if (!Array.isArray(files) || !files.includes('test.js') || !Array.isArray(editable) || editable.includes('test.js')) throw new Error('A protected test.js and editable file selection are required');
  const snapshot = snapshotFiles(root, files);
  const sourceRoot = fs.realpathSync(root);
  const initialGit = await gitState(root, files, signal, runProcess);
  if (JSON.stringify(snapshot).length > 16000) throw new Error('Snapshot exceeds initial runner limit');
  if (!editable.length || editable.some(x => !files.includes(x))) throw new Error('Invalid editable selection');
  if (os.freemem() < 1024 * 1024 * 1024) throw new Error('Insufficient free RAM');
  const status = await fetchLocal('http://127.0.0.1:1234/api/v0/models', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  if (!status.ok) throw new Error('LM Studio unavailable');
  const models = await status.json();
  if (!models.data?.some(m => m.id === MODEL && m.state === 'loaded' && m.loaded_context_length >= 12288)) throw new Error('Qwen3 4B with 12288 context is not loaded');
  const lms = path.join(os.homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms');
  const survey = JSON.parse(await runProcess(lms, ['runtime', 'survey', '--json'], 20000, signal));
  if (!survey.engines?.some(e => /vulkan/i.test(e.name) && e.hardwareSurvey?.gpuSurveyResult?.result?.code === 'success' && e.hardwareSurvey.gpuSurveyResult.gpuInfo?.length)) throw new Error('Vulkan GPU is not verified');
  await dockerRun(['info', '--format', '{{.OSType}}'], 20000, signal);
  await dockerRun(['image', 'inspect', IMAGE], 20000, signal);

  const id = crypto.randomBytes(8).toString('hex');
  const relayToken = crypto.randomBytes(32).toString('hex');
  const step = (args, timeout) => dockerRun(args, timeout, signal);
  const network = `sym-qwen-${id}`; const relay = `${network}-relay`; const worker = `${network}-worker`;
  const common = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534'];
  const relayCode = `const h=require('http');h.createServer((q,s)=>{if(q.headers.authorization!=='Bearer ${relayToken}'||!((q.method==='GET'&&q.url==='/v1/models')||(q.method==='POST'&&q.url==='/v1/chat/completions'))){s.writeHead(403).end();return}if(Number(q.headers['content-length']||0)>2097152){s.writeHead(413).end();return}const p=h.request({host:'host.docker.internal',port:1234,path:q.url,method:q.method,headers:{'content-type':'application/json'}},r=>{s.writeHead(r.statusCode,{'content-type':r.headers['content-type']||'application/json'});r.pipe(s)});p.on('error',()=>{if(!s.headersSent)s.writeHead(502);s.end()});let n=0;q.on('data',c=>{n+=c.length;if(n>2097152){q.destroy();p.destroy()}else p.write(c)});q.on('end',()=>p.end())}).listen(18888,'0.0.0.0')`;
  const writer = `const fs=require('fs'),p=require('path');for(const x of JSON.parse(Buffer.from(process.argv[1],'base64'))){const f=p.join('/workspace',x.path);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(x.content,'base64'))}fs.mkdirSync('/workspace/.home',{recursive:true})`;
  const reader = `const fs=require('fs'),p=require('path');const list=JSON.parse(Buffer.from(process.argv[1],'base64'));const out=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name),r=p.relative('/workspace',f).split(p.sep).join('/');if(r==='.home')continue;if(e.isSymbolicLink())throw Error('links rejected');if(e.isDirectory())walk(f);else if(e.isFile()){if(!list.includes(r))throw Error('unexpected file: '+r);out.push({path:r,content:fs.readFileSync(f).toString('base64')})}else throw Error('unsupported file')}}walk('/workspace');process.stdout.write(JSON.stringify(out))`;
  try {
    await step(['network', 'create', '--internal', network]);
    const net = JSON.parse(await step(['network', 'inspect', network]))[0];
    if (!net.Internal) throw new Error('Docker internal network is not isolated');
    await step(['create', '--name', relay, '--pull', 'never', '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway', ...common, '--pids-limit', '32', '--memory', '128m', '--entrypoint', 'node', IMAGE, '-e', relayCode]);
    await step(['network', 'connect', network, relay]);
    await step(['create', '--name', worker, '--pull', 'never', '--network', network, ...common, '--pids-limit', '64', '--memory', '1g', '--cpus', '2', '--shm-size', '16m', '--tmpfs', '/workspace:rw,nosuid,nodev,noexec,size=64m,uid=65534,gid=65534', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534', '--workdir', '/workspace', '--env', 'HOME=/workspace/.home', '--env', 'TMPDIR=/tmp', '--entrypoint', 'sh', IMAGE, '-c', 'sleep 480']);
    for (const name of [worker, relay]) {
      const info = JSON.parse(await step(['inspect', name]))[0]; const hc = info.HostConfig;
      if (info.Mounts.length || hc.Privileged || !hc.ReadonlyRootfs || !hc.CapDrop?.includes('ALL') || !hc.SecurityOpt?.includes('no-new-privileges') || hc.CapAdd?.length || hc.Devices?.length || hc.Binds?.length || Object.keys(hc.PortBindings || {}).length || info.Config.User !== '65534:65534') throw new Error('Docker isolation inspection failed');
      if (name === worker && (hc.NetworkMode !== network || hc.ShmSize !== 16 * 1024 * 1024 || hc.Memory !== 1024 * 1024 * 1024 || hc.PidsLimit !== 64 || hc.NanoCpus !== 2000000000 || Object.keys(hc.Tmpfs || {}).sort().join(',') !== '/tmp,/workspace' || !hc.Tmpfs['/workspace'].includes('size=64m') || !hc.Tmpfs['/tmp'].includes('size=32m'))) throw new Error('Docker worker configuration mismatch');
      if (name === relay && (hc.Memory !== 128 * 1024 * 1024 || hc.PidsLimit !== 32)) throw new Error('Docker relay limits mismatch');
    }
    await step(['start', relay]); await step(['start', worker]);
    const probe = `const fs=require('fs');if(fs.existsSync('/var/run/docker.sock'))throw Error('docker socket exposed');try{fs.writeFileSync('/etc/qwen-boundary-probe','x');throw Error('root writable')}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e}fetch('http://${relay}:18888/v1/models',{headers:{authorization:'Bearer ${relayToken}'},signal:AbortSignal.timeout(7000)}).then(r=>{if(!r.ok)throw Error('relay unavailable')}).catch(e=>{console.error(e.message);process.exitCode=1})`;
    await step(['exec', worker, 'node', '-e', probe], 10000);
    const encoded = Buffer.from(JSON.stringify(snapshot)).toString('base64');
    await step(['exec', worker, 'node', '-e', writer, encoded]);
    const taskPrompt = `In the current directory discover the files, complete this task, then run node test.js. Do not modify test.js. Task: ${prompt}`;
    const output = await step(['exec', worker, 'qwen', '--bare', '--approval-mode', 'auto-edit', '--allowed-tools=run_shell_command(node test.js)', '--max-wall-time', '150s', '--max-tool-calls', '8', '--chat-recording', 'false', '--output-format', 'json', '--auth-type', 'openai', '--openai-base-url', `http://${relay}:18888/v1`, '--openai-api-key', relayToken, '-m', MODEL, '-p', taskPrompt], 170000);
    let agent; try { agent = JSON.parse(output); } catch { throw new Error('Invalid Qwen output'); }
    const tools = validateToolEvents(agent, files, editable);
    agent = agent.findLast(x => x && x.type === 'result') || { error: { message: 'missing result event' } };
    if (!agent || (typeof agent !== 'string' && (agent.is_error || agent.error || (agent.subtype !== 'success' && typeof agent.response !== 'string')))) {
      throw new Error(`Qwen task failed: ${agent.subtype || 'unknown'} ${agent.error?.message || ''} fields=${Object.keys(agent).join(',')}`);
    }
    const encodedFiles = Buffer.from(JSON.stringify(files)).toString('base64');
    const returned = JSON.parse(await step(['exec', worker, 'node', '-e', reader, encodedFiles]));
    const changes = validateProposal(snapshot, returned, editable);
    if (!changes.length) throw new Error('No permitted changes');
    await step(['exec', '--workdir', '/workspace', worker, 'node', 'test.js'], 30000);
    const afterTest = JSON.parse(await step(['exec', worker, 'node', '-e', reader, encodedFiles]));
    if (JSON.stringify(validateProposal(snapshot, afterTest, editable)) !== JSON.stringify(changes)) throw new Error('Files changed during validation');
    assertSourceUnchanged(root, snapshot, sourceRoot);
    if (await gitState(root, files, signal, runProcess) !== initialGit) throw new Error('Git state changed during task');
    return { diff: formatDiff(changes, snapshot), changes, test: 'node test.js passed', model: MODEL, tools, agentDurationMs: agent.duration_ms || null };
  } finally {
    await cleanupResources(dockerRun, worker, relay, network);
  }
}

module.exports = { runQwenDocker, formatDiff, cleanupResources, validateToolEvents, gitState };

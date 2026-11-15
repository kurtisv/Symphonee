'use strict';

// Experimental, opt-in Docker runner. It never mounts a host directory and
// returns proposals only. The caller must independently review any proposal.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { validateProposal } = require('./qwen-snapshot');
const { gitSnapshot, assertGitSnapshotUnchanged } = require('./qwen-git-snapshot');
// The in-container assertion protocol (runAssertions) is forgeable and is no
// longer called. Technical evidence comes only from the host's independent
// verifier, run on the diff reconstructed from the frozen Git snapshot.
const { validateAssertions } = require('./qwen-assertions');
const exec = promisify(execFile);
const IMAGE = 'ghcr.io/qwenlm/qwen-code:0.27.3';
const MODEL = 'qwen3-4b-instruct-2507';
// Fixed developer profiles; no caller-supplied model name reaches Docker.
// The 9B reasons by default (measured 2026-11-15: 1,443 reasoning tokens and no
// answer in 96 s); the relay sets reasoning_effort "none" on its requests.
const PROFILES = Object.freeze({
  'qwen3-4b-instruct-2507': Object.freeze({ mode: 'agent', minContext: 12288, wallSeconds: 240, reasoningEffort: null, maxToolCalls: 12 }),
  'qwen/qwen3.5-9b': Object.freeze({ mode: 'agent', minContext: 16384, wallSeconds: 480, reasoningEffort: 'none', maxToolCalls: 24 }),
  // The working developer model (evaluation 2026-11-15, 9 models): one direct
  // text call, about 4 s and 4.8 GB of RAM. Selected over the others for its
  // speed, memory and its fixes from checker and review feedback.
  'qwen/qwen3.5-4b': Object.freeze({ mode: 'text', minContext: 8192, wallSeconds: 120, reasoningEffort: 'none', maxToolCalls: 0 }),
});
const run = async (cmd, args, timeout = 20000, signal) => (await exec(cmd, args, { timeout, signal, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout;
const docker = (args, timeout, signal) => run('docker', args, timeout, signal);

// Preliminary no-network inspection for the experimental review container.
// This does not authorize inference: a separate, verified egress path and
// authentication are needed before any cloud reviewer can run.
function verifyOfflineReviewContainer(info, expectedImageId) {
  if (!info || !expectedImageId || info.Image !== expectedImageId) throw new Error('Unexpected review image');
  const h=info.HostConfig || {}, c=info.Config || {};
  if (!Array.isArray(info.Mounts) || info.Mounts.length || h.Binds?.length || h.VolumesFrom?.length ||
      h.Privileged !== false || h.ReadonlyRootfs !== true || h.NetworkMode !== 'none' ||
      !(h.Memory > 0 && h.Memory <= 536870912) || !(h.PidsLimit > 0 && h.PidsLimit <= 64) || !(h.ShmSize > 0 && h.ShmSize <= 16777216) ||
      !(h.NanoCpus > 0 && h.NanoCpus <= 1000000000) || h.MemorySwap !== h.Memory ||
      !['','private'].includes(h.PidMode || '') || !['','private','none'].includes(h.IpcMode || '') || !['','private'].includes(h.UTSMode || '') ||
      !['','private'].includes(h.CgroupnsMode || '') || h.UsernsMode === 'host' ||
      (h.Devices && h.Devices.length) || (h.DeviceRequests && h.DeviceRequests.length) || (h.DeviceCgroupRules && h.DeviceCgroupRules.length) ||
      (h.Mounts && h.Mounts.length) || (h.GroupAdd && h.GroupAdd.length) || (h.CapAdd && h.CapAdd.length) ||
      h.PublishAllPorts === true || Object.keys(h.PortBindings || {}).length ||
      !Array.isArray(h.CapDrop) || !h.CapDrop.includes('ALL') ||
      !Array.isArray(h.SecurityOpt) || h.SecurityOpt.length !== 1 || !['no-new-privileges','no-new-privileges:true'].includes(h.SecurityOpt[0]) ||
      !Array.isArray(c.Env) || c.Env.slice().sort().join('\n') !== [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/share/npm-global/bin',
        'NODE_VERSION=22.23.2','YARN_VERSION=1.22.22','SANDBOX=qwen-code-sandbox','CLI_VERSION=0.27.3',
        'NPM_CONFIG_PREFIX=/usr/local/share/npm-global',
      ].sort().join('\n') ||
      c.User !== '65534:65534') throw new Error('Review container isolation not verified');
  const tmpfs=h.Tmpfs || {};
  if (Object.keys(tmpfs).length !== 1 || typeof tmpfs['/tmp'] !== 'string' ||
      tmpfs['/tmp'].split(',').sort().join(',') !== ['rw','nosuid','nodev','noexec','size=32m'].sort().join(',')) throw new Error('Unexpected writable filesystem');
  const networks=info.NetworkSettings?.Networks;
  if (!networks || Object.keys(networks).sort().join(',') !== 'none' || networks.none?.IPAddress || networks.none?.GlobalIPv6Address) throw new Error('Unexpected network endpoint');
  return { offline:true, imageId:info.Image, mounts:0, scope:'declared-docker-configuration' };
}

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
  // A diff must describe the original bytes exactly; Buffer.toString replaces
  // malformed UTF-8 and could otherwise bind tests to a different file.
  const decode = content => {
    const bytes = Buffer.from(content, 'base64');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Diff requires valid UTF-8');
    return text;
  };
  return changes.map(c => {
    const before = decode(snapshot.find(x => x.path === c.path).content);
    const after = decode(c.content);
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
    // Every call needs a result. A failed but permitted call (e.g. an edit whose
    // text did not match) is not a breach: its name, path and command are still
    // checked below, and the final proposal is verified independently anyway.
    if (!outcomes.get(call.id)) throw new Error('Qwen tool has no result');
    if (call.name === 'run_shell_command' && call.input?.command !== 'node test.js') throw new Error('Unexpected shell command: ' + JSON.stringify(String(call.input?.command ?? '').slice(0, 80)) + ' (only "node test.js" is allowed)');
    if (call.name === 'edit' || call.name === 'read_file') {
      const allowed = call.name === 'edit' ? editable : files;
      const input = call.input?.file_path;
      if (typeof input !== 'string' || !allowed.some(name => input === '/workspace/' + name)) throw new Error('Qwen accessed a file outside its selection');
    }
  }
  const succeeded = name => calls.some(c => c.name === name && outcomes.get(c.id).is_error !== true);
  if (!succeeded('read_file') || !succeeded('edit') || !succeeded('run_shell_command')) throw new Error('Qwen did not demonstrate successful read, edit and test tools');
  return calls.map(c => c.name);
}

async function runQwenDocker({ root, files, editable, assertions, prompt, signal, model = MODEL }, dependencies = {}) {
  const profile = Object.hasOwn(PROFILES, model) ? PROFILES[model] : null;
  if (!profile) throw new Error('Unsupported Qwen developer model');
  if (profile.mode !== 'agent') throw new Error('This model runs in text-only mode, not in the Docker agent');
  const dockerRun = dependencies.docker || docker;
  const runProcess = dependencies.run || run;
  const fetchLocal = dependencies.fetch || fetch;
  const readGitSnapshot = dependencies.gitSnapshot || gitSnapshot;
  const verifyGitSnapshot = dependencies.assertGitSnapshotUnchanged || assertGitSnapshotUnchanged;
  if (signal?.aborted) throw new Error('Cancelled');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Invalid task');
  if (!Array.isArray(files) || !files.includes('test.js') || !Array.isArray(editable) || editable.includes('test.js')) throw new Error('A protected test.js and editable file selection are required');
  const manifest = validateAssertions(assertions, editable);
  const gitBase = readGitSnapshot(root, files);
  const snapshot = gitBase.files;
  if (JSON.stringify(snapshot).length > 16000) throw new Error('Snapshot exceeds initial runner limit');
  if (!editable.length || editable.some(x => !files.includes(x))) throw new Error('Invalid editable selection');
  if ((dependencies.freemem || os.freemem)() < 1024 * 1024 * 1024) throw new Error('Insufficient free RAM');
  const status = await fetchLocal('http://127.0.0.1:1234/api/v0/models', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  if (!status.ok) throw new Error('LM Studio unavailable');
  const models = await status.json();
  if (!models.data?.some(m => m.id === model && m.state === 'loaded' && m.loaded_context_length >= profile.minContext)) throw new Error(`${model} with ${profile.minContext} context is not loaded`);
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
  const relayCode = `const h=require('http');h.createServer((q,s)=>{if(q.headers.authorization!=='Bearer ${relayToken}'||!((q.method==='GET'&&q.url==='/v1/models')||(q.method==='POST'&&q.url==='/v1/chat/completions'))){s.writeHead(403).end();return}if(Number(q.headers['content-length']||0)>2097152){s.writeHead(413).end();return}const effort=${JSON.stringify(profile.reasoningEffort)};const b=[];let n=0;q.on('data',c=>{n+=c.length;if(n>2097152){q.destroy();return}b.push(c)});q.on('end',()=>{let body=Buffer.concat(b);if(effort&&q.method==='POST'){let j;try{j=JSON.parse(body)}catch{s.writeHead(400).end();return}if(!j||typeof j!=='object'||Array.isArray(j)){s.writeHead(400).end();return}j.reasoning_effort=effort;body=Buffer.from(JSON.stringify(j))}const p=h.request({host:'host.docker.internal',port:1234,path:q.url,method:q.method,headers:{'content-type':'application/json','content-length':body.length}},r=>{s.writeHead(r.statusCode,{'content-type':r.headers['content-type']||'application/json'});r.pipe(s)});p.on('error',()=>{if(!s.headersSent)s.writeHead(502);s.end()});p.end(body)})}).listen(18888,'0.0.0.0')`;
  const writer = `const fs=require('fs'),p=require('path');for(const x of JSON.parse(Buffer.from(process.argv[1],'base64'))){const f=p.join('/workspace',x.path);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(x.content,'base64'))}fs.mkdirSync('/workspace/.home',{recursive:true})`;
  const reader = `const fs=require('fs'),p=require('path');const list=JSON.parse(Buffer.from(process.argv[1],'base64'));const out=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name),r=p.relative('/workspace',f).split(p.sep).join('/');if(r==='.home')continue;if(e.isSymbolicLink())throw Error('links rejected');if(e.isDirectory())walk(f);else if(e.isFile()){if(!list.includes(r))throw Error('unexpected file: '+r);out.push({path:r,content:fs.readFileSync(f).toString('base64')})}else throw Error('unsupported file')}}walk('/workspace');process.stdout.write(JSON.stringify(out))`;
  try {
    await step(['network', 'create', '--internal', network]);
    const net = JSON.parse(await step(['network', 'inspect', network]))[0];
    if (!net.Internal) throw new Error('Docker internal network is not isolated');
    await step(['create', '--name', relay, '--pull', 'never', '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway', ...common, '--pids-limit', '32', '--memory', '128m', '--entrypoint', 'node', IMAGE, '-e', relayCode]);
    await step(['network', 'connect', network, relay]);
    await step(['create', '--name', worker, '--pull', 'never', '--network', network, ...common, '--pids-limit', '64', '--memory', '1g', '--cpus', '2', '--shm-size', '16m', '--tmpfs', '/workspace:rw,nosuid,nodev,noexec,size=64m,uid=65534,gid=65534', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534', '--workdir', '/workspace', '--env', 'HOME=/workspace/.home', '--env', 'TMPDIR=/tmp', '--entrypoint', 'sh', IMAGE, '-c', `sleep ${profile.wallSeconds + 330}`]);
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
    // Report the end of Qwen's own output, never the command line (it holds the relay token).
    const qwenStep = async (args, timeout) => {
      try { return await step(args, timeout); }
      catch (e) {
        if (signal?.aborted) throw e;
        const tail = x => String(x || '').split(relayToken).join('***').replace(/s+/g, ' ').trim().slice(-400);
        throw new Error(`Qwen run failed (${e.killed || e.signal ? 'killed/timeout' : 'exit ' + (e.code ?? '?')}): stderr: ${tail(e.stderr) || '-'} | stdout: ${tail(e.stdout) || '-'}`);
      }
    };
    const output = await qwenStep(['exec', worker, 'qwen', '--bare', '--approval-mode', 'auto-edit', '--allowed-tools=run_shell_command(node test.js)', '--max-wall-time', `${profile.wallSeconds}s`, '--max-tool-calls', String(profile.maxToolCalls), '--chat-recording', 'false', '--output-format', 'json', '--auth-type', 'openai', '--openai-base-url', `http://${relay}:18888/v1`, '--openai-api-key', relayToken, '-m', model, '-p', taskPrompt], (profile.wallSeconds + 20) * 1000);
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
    verifyGitSnapshot(gitBase);
    // Nothing here is a validation: the caller must verify the diff independently.
    return { diff: formatDiff(changes, snapshot), changes, test: `independent verification pending (${manifest.length} host assertions)`, baseCommit: gitBase.commit, model, tools, agentDurationMs: agent.duration_ms || null, agentUsage: agent.usage || null };
  } finally {
    await cleanupResources(dockerRun, worker, relay, network);
  }
}

module.exports = { PROFILES, runQwenDocker, formatDiff, cleanupResources, validateToolEvents, gitState, verifyOfflineReviewContainer };

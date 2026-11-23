const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

// OLLAMA_BASE is read at require time, so start the mock first.
let server;
let handler = (req, res) => { res.statusCode = 404; res.end(); };
let setup;
let prevUrl;

test.before(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(req, res));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  prevUrl = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  delete require.cache[require.resolve('./ollama-setup')];
  setup = require('./ollama-setup');
});

test.after(async () => {
  if (prevUrl === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = prevUrl;
  delete require.cache[require.resolve('./ollama-setup')];
  await new Promise(r => server.close(r));
});

function stream(body, status = 200) {
  handler = (req, res) => { res.statusCode = status; res.end(body); };
}

test('in-stream error chunk on HTTP 200 -> pull-failed', async () => {
  stream('{"status":"pulling"}\n{"error":"pull model manifest: file does not exist"}\n');
  const events = [];
  const r = await setup.ensureModel({ model: 'x', broadcast: e => events.push(e) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'pull-failed');
  assert.match(r.error, /file does not exist/);
  assert.ok(!events.some(e => e.payload.status === undefined), 'error chunk must not be broadcast');
});

test('error chunk fails without broadcast and even if success follows', async () => {
  // The error is the FIRST chunk, so the 250 ms broadcast throttle cannot be what hides it.
  stream('{"error":"disk full"}\n{"status":"success"}\n');
  const events = [];
  const r = await setup.ensureModel({ model: 'x', broadcast: e => events.push(e) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'disk full');
  // A forwarded error chunk would be broadcast first (throttle not armed yet) as a status-less event.
  assert.deepStrictEqual(events.map(e => e.payload.status), ['success'], 'only the success chunk is broadcast, never the error chunk');
});

test('error in final line without trailing newline', async () => {
  stream('{"status":"pulling"}\n{"error":"registry error"}');
  const r = await setup.ensureModel({ model: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'pull-failed');
  assert.strictEqual(r.error, 'registry error');
});

test('empty-string error chunk still fails', async () => {
  stream('{"status":"pulling"}\n{"error":""}\n{"status":"success"}\n');
  const r = await setup.ensureModel({ model: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'pull-failed');
  assert.strictEqual(r.error, '');
});

test('multi-byte UTF-8 split across network chunks is preserved', async () => {
  const buf = Buffer.from('{"error":"échec"}\n', 'utf8');
  const cut = buf.indexOf(0xC3) + 1; // split inside "é"
  handler = (req, res) => {
    res.statusCode = 200;
    res.write(buf.subarray(0, cut));
    setTimeout(() => res.end(buf.subarray(cut)), 30);
  };
  const r = await setup.ensureModel({ model: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'échec');
});

test('progress then success -> ok and broadcasts ollama-pull', async () => {
  stream('{"status":"pulling","completed":1,"total":2}\n{"status":"success"}\n');
  const events = [];
  const r = await setup.ensureModel({ model: 'x', broadcast: e => events.push(e) });
  assert.strictEqual(r.ok, true);
  assert.ok(events.length > 0);
  assert.ok(events.every(e => e.payload.kind === 'ollama-pull'));
});

test('stream without final success and without error stays ok', async () => {
  stream('{"status":"pulling"}\n');
  const r = await setup.ensureModel({ model: 'x' });
  assert.strictEqual(r.ok, true);
});

test('HTTP 500 -> pull-failed', async () => {
  stream('boom', 500);
  const r = await setup.ensureModel({ model: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'pull-failed');
});

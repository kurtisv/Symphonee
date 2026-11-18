'use strict';
// Chunked, non-blocking JSON writer for very large objects (the Mind graph is ~280 MB, the manifest ~110 MB).
//
// JSON.stringify of such an object plus writeFileSync is ONE synchronous call: for 10 to 30 seconds the process that
// also serves HTTP, WebSocket and the terminals answers nothing. This writer serializes the object in slices and yields
// to the event loop between slices, so the server stays responsive. The bytes written are IDENTICAL to
// JSON.stringify(value) (compact form), so every reader of the file keeps working unchanged.
//
// Layout handled: a plain object whose values are arrays or big plain objects (graph: nodes/edges arrays; manifest:
// { entries: {...} }). Everything else is stringified in one piece, exactly like JSON.stringify.

const fs = require('node:fs');

const SLICE = 1500; // elements per slice: a few milliseconds each
const tick = () => new Promise((r) => setImmediate(r));

// JSON.stringify semantics for one value inside an array (undefined/function/symbol -> null).
const elem = (v) => { const s = JSON.stringify(v); return s === undefined ? 'null' : s; };

async function writeAll(stream, text) {
  // No per-call error listener (they piled up): a stream error is observed once by the caller's race.
  if (!stream.write(text)) await new Promise((res) => stream.once('drain', res));
}

async function writeValue(stream, v, slice) {
  if (Array.isArray(v) && v.length > slice) {
    await writeAll(stream, '[');
    for (let i = 0; i < v.length; i += slice) {
      const part = v.slice(i, i + slice).map(elem).join(',');
      await writeAll(stream, (i ? ',' : '') + part);
      await tick();
    }
    await writeAll(stream, ']');
    return;
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.toJSON !== 'function' && !(v instanceof Map) && !(v instanceof Set)) {
    const keys = Object.keys(v);
    if (keys.length > slice) {
      await writeAll(stream, '{');
      let first = true;
      for (let i = 0; i < keys.length; i += slice) {
        const parts = [];
        for (const k of keys.slice(i, i + slice)) {
          const s = JSON.stringify(v[k]);
          if (s === undefined) continue; // same as JSON.stringify: undefined values are dropped
          parts.push(JSON.stringify(k) + ':' + s);
        }
        if (parts.length) { await writeAll(stream, (first ? '' : ',') + parts.join(',')); first = false; }
        await tick();
      }
      await writeAll(stream, '}');
      return;
    }
  }
  const s = JSON.stringify(v);
  await writeAll(stream, s === undefined ? 'null' : s);
}

// Writes `value` to filePath atomically (temp file + rename). Compact JSON, byte-identical to JSON.stringify(value).
async function writeJsonChunked(filePath, value, { slice = SLICE } = {}) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const stream = fs.createWriteStream(tmp, { encoding: 'utf8' });
  const failed = new Promise((_, rej) => stream.once('error', rej));
  failed.catch(() => {}); // a late stream error must never become an unhandled rejection
  try {
    const work = (async () => {
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.toJSON !== 'function') {
        await writeAll(stream, '{');
        let first = true;
        for (const k of Object.keys(value)) {
          const v = value[k];
          if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
          await writeAll(stream, (first ? '' : ',') + JSON.stringify(k) + ':');
          first = false;
          await writeValue(stream, v, slice);
        }
        await writeAll(stream, '}');
      } else {
        await writeValue(stream, value, slice);
      }
      await new Promise((res, rej) => { stream.end((e) => (e ? rej(e) : res())); });
    })();
    await Promise.race([work, failed]);
    await fs.promises.rename(tmp, filePath);
  } catch (e) {
    try { stream.destroy(); } catch (_) {}
    try { await fs.promises.rm(tmp, { force: true }); } catch (_) {}
    throw e;
  }
}

module.exports = { writeJsonChunked, SLICE };

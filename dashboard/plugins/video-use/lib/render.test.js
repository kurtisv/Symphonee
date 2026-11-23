'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { render, _internals } = require('./render');
const { _formatSrtTime, _wordsForSegment, _chunkWords, _buildSrt, _extractSegmentArgs } = _internals;

test('render is still exported', () => {
  assert.strictEqual(typeof render, 'function');
});

test('_formatSrtTime formats and carries correctly', () => {
  assert.strictEqual(_formatSrtTime(0), '00:00:00,000');
  assert.strictEqual(_formatSrtTime(-5), '00:00:00,000');
  assert.strictEqual(_formatSrtTime(1.001), '00:00:01,001');
  assert.strictEqual(_formatSrtTime(59.9996), '00:01:00,000');
  assert.strictEqual(_formatSrtTime(3661.5), '01:01:01,500');
});

test('_wordsForSegment clips, offsets and filters', () => {
  const json = {
    words: [
      { text: 'before', start: 0, end: 1 },
      { text: 'edge', start: 9, end: 12 },
      { text: 'inside', start: 11, end: 12 },
      { text: ' ', start: 11, end: 12 },
      { text: 'gap', type: 'spacing', start: 11, end: 12 },
      { text: 'noend', start: 13 },
      { text: 'after', start: 30, end: 31 },
    ],
  };
  const out = _wordsForSegment(json, 10, 20, 5);
  assert.deepStrictEqual(out, [
    { start: 5, end: 7, text: 'edge' },
    { start: 6, end: 7, text: 'inside' },
  ]);
  assert.deepStrictEqual(_wordsForSegment(null, 0, 1, 0), []);
});

test('_chunkWords groups by two and uppercases', () => {
  const w = ['a', 'b', 'c'].map((t, i) => ({ start: i, end: i + 1, text: t }));
  assert.deepStrictEqual(_chunkWords(w), [
    { start: 0, end: 2, text: 'A B' },
    { start: 2, end: 3, text: 'C' },
  ]);
});

test('_buildSrt numbers cues, accumulates offsets, skips missing/invalid transcripts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-test-'));
  try {
    const mk = (n) => ({ words: [{ text: 'hi', start: n, end: n + 1 }, { text: 'yo', start: n + 1, end: n + 2 }] });
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(mk(0)));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(mk(0)));
    const edl = {
      segments: [
        { source: 'a', in: 0, out: 2 },
        { source: 'missing', in: 0, out: 3 },
        { source: 'bad', in: 0, out: 1 },
        { source: 'c.json', in: 0, out: 2 }, // fallback: raw name, no extra .json
      ],
    };
    const srt = _buildSrt(edl, dir);
    assert.strictEqual(
      srt,
      '1\n00:00:00,000 --> 00:00:02,000\nHI YO\n\n' +
      '2\n00:00:06,000 --> 00:00:08,000\nHI YO\n'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_extractSegmentArgs orders -ss/-to before -i and clamps fade', () => {
  const args = _extractSegmentArgs({ in: 1, out: 1.01, sourcePath: 'src.mp4' }, 'o.mp4', 30);
  assert.ok(args.indexOf('-ss') < args.indexOf('-to'));
  assert.ok(args.indexOf('-to') < args.indexOf('-i'));
  assert.strictEqual(args[args.indexOf('-i') + 1], 'src.mp4');
  assert.strictEqual(args[args.indexOf('-vf') + 1], 'null');
  assert.match(args[args.indexOf('-af') + 1], /afade=t=out:st=0\.000:/);
  assert.strictEqual(args[args.length - 1], 'o.mp4');
  const long = _extractSegmentArgs({ in: 0, out: 10, sourcePath: 's' }, 'o', 30);
  assert.match(long[long.indexOf('-af') + 1], /st=9\.970/);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { build, buildMerge, deduplicateEdges } = require('./build');

test('deduplicateEdges collapses semantic duplicates and keeps the stronger edge', () => {
  const edges = deduplicateEdges([
    {
      source: 'a',
      target: 'b',
      relation: 'imports',
      confidence: 'INFERRED',
      confidenceScore: 0.5,
      weight: 0.5,
      createdAt: '2026-04-27T20:00:00.000Z',
    },
    {
      source: 'a',
      target: 'b',
      relation: 'imports',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      weight: 1,
      createdAt: '2026-04-27T20:01:00.000Z',
    },
  ]);

  assert.equal(edges.length, 1);
  assert.equal(edges[0].confidence, 'EXTRACTED');
  assert.equal(edges[0].confidenceScore, 1);
  assert.equal(edges[0].weight, 1);
});

test('buildMerge incremental path does not double-count mirrored cached edges', () => {
  const existing = {
    nodes: [
      { id: 'code_a', label: 'a.ts', kind: 'code' },
      { id: 'code_b', label: 'b.ts', kind: 'code' },
    ],
    edges: [
      {
        source: 'code_a',
        target: 'code_b',
        relation: 'imports',
        confidence: 'EXTRACTED',
        confidenceScore: 1,
        weight: 1,
        createdAt: '2026-04-27T20:00:00.000Z',
      },
    ],
  };

  const merged = buildMerge(existing, [{
    nodes: [
      { id: 'code_a', label: 'a.ts', kind: 'code' },
      { id: 'code_b', label: 'b.ts', kind: 'code' },
    ],
    edges: [
      {
        source: 'code_a',
        target: 'code_b',
        relation: 'imports',
        confidence: 'EXTRACTED',
        confidenceScore: 1,
        weight: 1,
        createdAt: '2026-04-27T20:05:00.000Z',
      },
    ],
  }]);

  assert.equal(merged.nodes.length, 2);
  assert.equal(merged.edges.length, 1);
});

test('build merges a whole-graph fragment too large to spread as call arguments', () => {
  // Regression: /api/mind/teach merges the full graph through build(); with
  // 126k edges, push(...ext.edges) threw "Maximum call stack size exceeded".
  const N = 300000;
  const nodes = [{ id: 'hub', label: 'hub' }, { id: 'leaf', label: 'leaf' }];
  const edges = [];
  for (let i = 0; i < N; i++) edges.push({ source: 'hub', target: 'leaf', relation: 'r' + i });
  const merged = build([{ nodes, edges }, { nodes: [{ id: 'memory_x', label: 'memory x', kind: 'memory' }], edges: [] }]);
  assert.equal(merged.nodes.length, 3);
  assert.ok(merged.edges.length > 0);
});

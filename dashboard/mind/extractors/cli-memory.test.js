const assert = require('node:assert');
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractCliMemory } = require('./cli-memory');

describe('extractCliMemory', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mem-test-'));
  });

  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(rel, body = '# Memory\n') {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  // A directory in place of a file: existsSync is true but readFileSync throws.
  function unreadable(rel) {
    fs.mkdirSync(path.join(tmpDir, rel), { recursive: true });
  }

  // Simulate a file without creating it on disk (scoped to one path).
  function mockFile(rel, body) {
    const target = path.join(tmpDir, rel);
    const origExists = fs.existsSync;
    const origRead = fs.readFileSync;
    mock.method(fs, 'existsSync', (p) => (p === target ? true : origExists(p)));
    mock.method(fs, 'readFileSync', function (p, ...rest) {
      return p === target ? body : origRead.call(fs, p, ...rest);
    });
  }

  // Headings that reached the graph from one CLI's memory node: proves WHICH file's content was extracted.
  const headingsOf = (edges, cli) => edges.filter((e) => e.source === 'climem_' + cli && e.relation === 'contains').map((e) => e.target).sort();

  it('first existing candidate wins; missing CLIs are not found', () => {
    mockFile('CLAUDE.md', '# Claude\n');
    write('.github/copilot-instructions.md', '# Copilot Github\n');
    write('COPILOT.md', '# Copilot Root\n');

    const { perCli, scanned, edges } = extractCliMemory({ repoRoot: tmpDir });

    assert.strictEqual(perCli.claude.path, 'CLAUDE.md');
    assert.strictEqual(perCli.copilot.path, '.github/copilot-instructions.md');
    assert.deepStrictEqual(headingsOf(edges, 'copilot'), ['heading_copilot_github'], 'content of the selected file only');
    assert.strictEqual(perCli.gemini.found, false);
    assert.strictEqual(scanned, 2);
  });

  it('the selected file content reaches the graph (its headings become nodes)', () => {
    write('CLAUDE.md', '# Claude Rules\n\n## Testing\n');
    write('AGENTS.md', '# Other\n');

    const { nodes, edges } = extractCliMemory({ repoRoot: tmpDir });
    const memoryNode = nodes.find(n => n.id === 'climem_claude');
    assert.ok(memoryNode, 'memory node should exist');
    assert.strictEqual(memoryNode.label, 'claude memory (CLAUDE.md)');
    const contained = edges.filter(e => e.source === 'climem_claude' && e.relation === 'contains').map(e => e.target).sort();
    assert.deepStrictEqual(contained, ['heading_claude_rules', 'heading_testing']);
    for (const id of contained) assert.strictEqual(nodes.find(n => n.id === id)?.kind, 'concept', id);
    // Another CLI's file content stays attached to that CLI only.
    assert.ok(!edges.some(e => e.source === 'climem_claude' && e.target === 'heading_other'));
  });

  it('extracts markdown links as edges', () => {
    const content = '# Claude\n- [Link](./scripts/Show-Diff.ps1)\n';
    write('CLAUDE.md', content);

    const { nodes, edges } = extractCliMemory({ repoRoot: tmpDir });
    const memoryNode = nodes.find(n => n.id === 'climem_claude');
    assert.ok(memoryNode, 'memory node should exist');

    // Check that edges were created for links
    const linkEdges = edges.filter(e => e.source === 'climem_claude' && e.relation === 'references');
    assert.ok(linkEdges.length > 0, 'should have reference edges');
    assert.deepStrictEqual(linkEdges.map(e => e.target), ['doc_scripts_show_diff_ps1']);
  });

  it('extracts source metadata and createdBy fields', () => {
    write('CLAUDE.md', '# Claude\n');

    const { nodes, edges } = extractCliMemory({ repoRoot: tmpDir, createdBy: 'symphonee/core' });
    const memoryNode = nodes.find(n => n.id === 'climem_claude');
    assert.ok(memoryNode, 'memory node should exist');

    // Check metadata fields
    assert.strictEqual(memoryNode.source.type, 'cli-memory');
    assert.strictEqual(memoryNode.source.ref, 'CLAUDE.md');
    assert.strictEqual(memoryNode.source.cli, 'claude');
    assert.strictEqual(memoryNode.source.file, path.join(tmpDir, 'CLAUDE.md'));
    assert.strictEqual(memoryNode.createdBy, 'symphonee/core');
    // createdBy also reaches the CLI tag node and its tagged_with edge.
    const tag = nodes.find(n => n.id === 'cli_claude');
    assert.deepStrictEqual({ kind: tag.kind, source: tag.source, createdBy: tag.createdBy }, { kind: 'tag', source: { type: 'cli', ref: 'claude' }, createdBy: 'symphonee/core' });
    const tagEdge = edges.find(e => e.source === 'climem_claude' && e.relation === 'tagged_with');
    assert.strictEqual(tagEdge.target, 'cli_claude');
    assert.strictEqual(tagEdge.createdBy, 'symphonee/core');
  });

  it('handles empty but readable memory file', () => {
    write('CLAUDE.md', '');

    const { nodes } = extractCliMemory({ repoRoot: tmpDir });
    const memoryNode = nodes.find(n => n.id === 'climem_claude');
    assert.ok(memoryNode, 'memory node should exist even for empty file');
    // Empty but readable: found (an empty string is not "unreadable"), and no heading node exists.
    const { perCli, scanned } = extractCliMemory({ repoRoot: tmpDir });
    assert.strictEqual(perCli.claude.found, true);
    assert.strictEqual(perCli.claude.path, 'CLAUDE.md');
    assert.strictEqual(scanned, 1);
    assert.deepStrictEqual(nodes.map(n => n.id).sort(), ['cli_claude', 'climem_claude']);
  });

  it('preference holds for cursor and zed, and the second alternative is used alone', () => {
    write('.cursorrules', '# Cursor Primary\n');
    write('.cursor/rules.md', '# Cursor Alt\n');
    write('.rules', '# Zed Primary\n');
    write('.zed/rules.md', '# Zed Alt\n');
    let r = extractCliMemory({ repoRoot: tmpDir });
    assert.strictEqual(r.perCli.cursor.path, '.cursorrules');
    assert.strictEqual(r.perCli.zed.path, '.rules');
    assert.deepStrictEqual(headingsOf(r.edges, 'cursor'), ['heading_cursor_primary']);
    assert.deepStrictEqual(headingsOf(r.edges, 'zed'), ['heading_zed_primary']);

    fs.rmSync(path.join(tmpDir, '.cursorrules'));
    fs.rmSync(path.join(tmpDir, '.rules'));
    r = extractCliMemory({ repoRoot: tmpDir });
    assert.strictEqual(r.perCli.cursor.path, '.cursor/rules.md');
    assert.strictEqual(r.perCli.zed.path, '.zed/rules.md');
    assert.deepStrictEqual(headingsOf(r.edges, 'cursor'), ['heading_cursor_alt']);
    assert.deepStrictEqual(headingsOf(r.edges, 'zed'), ['heading_zed_alt']);
    assert.strictEqual(r.scanned, 2);
  });

  it('builds the memory node, cli tag node and tagged_with edge', () => {
    mockFile('CLAUDE.md', '# Claude\n');
    const { nodes, edges } = extractCliMemory({ repoRoot: tmpDir });

    assert.ok(nodes.some((n) => n.id === 'climem_claude'));
    const tag = nodes.find((n) => n.id === 'cli_claude');
    assert.ok(tag);
    assert.strictEqual(tag.kind, 'tag');
    assert.ok(edges.some((e) => e.source === 'climem_claude' && e.target === 'cli_claude' && e.relation === 'tagged_with'));
  });

  it('every single-candidate CLI and the shared entry resolve to their own file', () => {
    const files = {
      codex: 'AGENTS.md',
      gemini: 'GEMINI.md',
      grok: 'GROK.md',
      qwen: 'QWEN.md',
      windsurf: '.windsurfrules',
      _shared: 'INSTRUCTIONS.base.md',
    };
    // Protected filenames are simulated, never written to disk.
    const targets = new Map(Object.values(files).map((rel) => [path.join(tmpDir, rel), '# Mem\n']));
    const origExists = fs.existsSync;
    const origRead = fs.readFileSync;
    mock.method(fs, 'existsSync', (p) => (targets.has(p) ? true : origExists(p)));
    mock.method(fs, 'readFileSync', function (p, ...rest) {
      return targets.has(p) ? targets.get(p) : origRead.call(fs, p, ...rest);
    });

    const { perCli, scanned } = extractCliMemory({ repoRoot: tmpDir });

    for (const [cli, rel] of Object.entries(files)) {
      assert.strictEqual(perCli[cli].found, true, cli);
      assert.strictEqual(perCli[cli].path, rel, cli);
    }
    assert.strictEqual(perCli.claude.found, false);
    assert.strictEqual(scanned, 6);
  });

  it('an empty repo gives scanned 0 and no nodes or edges', () => {
    const { perCli, scanned, nodes, edges } = extractCliMemory({ repoRoot: tmpDir });
    assert.strictEqual(scanned, 0);
    assert.deepStrictEqual(nodes, []);
    assert.deepStrictEqual(edges, []);
    assert.strictEqual(perCli.claude.found, false);
    assert.strictEqual(perCli.codex.found, false);
  });

  it('an unreadable candidate falls through to the next one and is counted', () => {
    unreadable('.github/copilot-instructions.md');
    write('COPILOT.md', '# Copilot Root\n');
    unreadable('.cursorrules');
    write('.cursor/rules.md', '# Cursor Alt\n');
    unreadable('.rules');
    write('.zed/rules.md', '# Zed Alt\n');

    const { perCli, scanned, edges } = extractCliMemory({ repoRoot: tmpDir });

    assert.strictEqual(perCli.copilot.path, 'COPILOT.md');
    assert.strictEqual(perCli.cursor.path, '.cursor/rules.md');
    assert.strictEqual(perCli.zed.path, '.zed/rules.md');
    assert.deepStrictEqual(headingsOf(edges, 'copilot'), ['heading_copilot_root']);
    assert.deepStrictEqual(headingsOf(edges, 'cursor'), ['heading_cursor_alt']);
    assert.deepStrictEqual(headingsOf(edges, 'zed'), ['heading_zed_alt']);
    assert.strictEqual(scanned, 3);
  });

  it('a CLI whose only candidate is unreadable is not found', () => {
    unreadable('COPILOT.md');
    unreadable('.github/copilot-instructions.md');
    const { perCli, scanned } = extractCliMemory({ repoRoot: tmpDir });
    assert.strictEqual(perCli.copilot.found, false);
    assert.strictEqual(scanned, 0);
  });
});

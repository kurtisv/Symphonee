/**
 * Mind storage layer.
 *
 * Canonical graph state lives at:
 *   <repoRoot>/.symphonee/mind/spaces/<space>/graph.json
 *
 * The file is human-readable JSON so it shows up in the Symphonee diff viewer
 * and can be hand-edited or grepped without a tool. Per-space partitioning
 * keeps any single graph from growing unbounded.
 *
 * Writes are atomic (write-to-temp + rename) so a crash mid-write cannot
 * corrupt the canonical file.
 */

const fs = require('fs');
const path = require('path');
const { emptyGraph, validateGraph, validateNode, validateEdge } = require('./schema');

function namespaceFromSpace(space) {
  if (!space) return '_global';
  return space.toString().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64) || '_global';
}

function mindRoot(repoRoot) {
  return path.join(repoRoot, '.symphonee', 'mind');
}

function spaceDir(repoRoot, space) {
  return path.join(mindRoot(repoRoot), 'spaces', namespaceFromSpace(space));
}

function graphPath(repoRoot, space) {
  return path.join(spaceDir(repoRoot, space), 'graph.json');
}

function cacheDir(repoRoot, space) {
  return path.join(spaceDir(repoRoot, space), 'cache');
}

function reportsDir(repoRoot, space) {
  return path.join(spaceDir(repoRoot, space), 'reports');
}

function ensureDirs(repoRoot, space) {
  const dirs = [spaceDir(repoRoot, space), cacheDir(repoRoot, space), reportsDir(repoRoot, space)];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadGraph(repoRoot, space) {
  const p = graphPath(repoRoot, space);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  try { return JSON.parse(raw); } catch (e) {
    throw new Error(`mind/store: graph.json for space "${space}" is corrupt: ${e.message}`);
  }
}

// ── Shared read-only view ────────────────────────────────────────────────────
// loadGraph() reads and parses the whole file on every call and hands back a
// private copy. That is the right contract for callers that mutate then save,
// but it is ruinous for readers once the graph is large: measured at 229 MB,
// one call costs about 1.4 s and 700 MB of heap, synchronously, on the event
// loop that also serves HTTP, WebSocket and the terminals. /api/bootstrap took
// 42 s that way.
//
// loadGraphShared() returns ONE parsed instance for as long as the file on
// disk is unchanged (mtime + size, so a write from another process is seen).
// Contract: the result is READ-ONLY. The top-level object and its nodes/edges
// arrays are frozen so an in-place push/sort/splice throws instead of leaking
// into every other reader. Callers that need to change the graph must keep
// using loadGraph().
//
// One entry only: a second space would otherwise pin another few hundred MB.
// Disable with SY_MIND_GRAPH_CACHE=0.
const SHARED_ENABLED = process.env.SY_MIND_GRAPH_CACHE !== '0';
let _shared = null; // { path, mtimeMs, size, graph }

function invalidateShared(repoRoot, space) {
  if (!_shared) return;
  if (repoRoot === undefined || _shared.path === graphPath(repoRoot, space)) _shared = null;
}

function loadGraphShared(repoRoot, space) {
  if (!SHARED_ENABLED) return loadGraph(repoRoot, space);
  const p = graphPath(repoRoot, space);
  let st;
  try { st = fs.statSync(p); } catch (_) {
    if (_shared && _shared.path === p) _shared = null;
    return null;
  }
  if (_shared && _shared.path === p && _shared.mtimeMs === st.mtimeMs && _shared.size === st.size) {
    return _shared.graph;
  }
  // Drop the stale instance BEFORE parsing so the two never coexist in memory.
  _shared = null;
  const graph = loadGraph(repoRoot, space); // throws on a corrupt file: nothing is cached
  if (!graph) return null;
  if (Array.isArray(graph.nodes)) Object.freeze(graph.nodes);
  if (Array.isArray(graph.edges)) Object.freeze(graph.edges);
  Object.freeze(graph);
  // The stat was taken before the read. If the file was replaced in between,
  // the next call sees a different stat and reloads: stale for one call at most.
  _shared = { path: p, mtimeMs: st.mtimeMs, size: st.size, graph };
  return graph;
}

// Above this many nodes + edges the file is written without indentation. The
// "human-readable, shows up in the diff viewer" intent only holds for small
// graphs; at 59k nodes / 481k edges indentation alone was 44 MB of 219 MB.
const COMPACT_THRESHOLD = 5000;

// Every build writes a report-<ts>.md. Nothing removed them: 28,855 files had
// accumulated. Keep the newest `keep`, leave any other file alone.
function pruneReports(repoRoot, space, keep = 50) {
  let names;
  try { names = fs.readdirSync(reportsDir(repoRoot, space)); } catch (_) { return 0; }
  const reports = names
    .map((f) => { const m = /^report-(\d+)\.md$/.exec(f); return m ? { f, ts: Number(m[1]) } : null; })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts);
  let removed = 0;
  for (const r of reports.slice(Math.max(0, keep))) {
    try { fs.rmSync(path.join(reportsDir(repoRoot, space), r.f)); removed++; } catch (_) { /* best effort */ }
  }
  return removed;
}

function repairGraph(graph, validationErrors) {
  const warnings = [];
  const out = {
    ...graph,
    nodes: [],
    edges: [],
    hyperedges: Array.isArray(graph.hyperedges) ? graph.hyperedges : [],
    communities: graph.communities && typeof graph.communities === 'object' ? graph.communities : {},
    gods: Array.isArray(graph.gods) ? graph.gods : [],
    surprises: Array.isArray(graph.surprises) ? graph.surprises : [],
    suggested: Array.isArray(graph.suggested) ? graph.suggested : [],
    stats: graph.stats && typeof graph.stats === 'object' ? { ...graph.stats } : {},
  };

  const ids = new Set();
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    const err = validateNode(node);
    if (err) {
      warnings.push('Dropped node: ' + err);
      continue;
    }
    if (ids.has(node.id)) {
      warnings.push('Dropped duplicate node id: ' + node.id);
      continue;
    }
    ids.add(node.id);
    out.nodes.push(node);
  }

  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    const err = validateEdge(edge, ids);
    if (err) {
      warnings.push('Dropped edge: ' + err);
      continue;
    }
    out.edges.push(edge);
  }

  const surviving = new Set(out.nodes.map(n => n.id));
  out.edges = out.edges.filter(edge => {
    const ok = surviving.has(edge.source) && surviving.has(edge.target);
    if (!ok) warnings.push(`Dropped dangling edge: ${edge.source || '?'} -> ${edge.target || '?'}`);
    return ok;
  });

  out.stats.validationErrors = validationErrors.slice(0, 20);
  out.stats.validationWarnings = warnings.slice(0, 50);
  out.stats.validationWarningCount = warnings.length;
  return out;
}

function saveGraph(repoRoot, space, graph) {
  ensureDirs(repoRoot, space);
  let errors = validateGraph(graph);
  if (errors.length) {
    graph = repairGraph(graph, errors);
    errors = validateGraph(graph);
    if (errors.length) {
      throw new Error(`mind/store: refusing to save invalid graph after repair: ${errors.slice(0, 3).join('; ')}`);
    }
  }
  graph.generatedAt = new Date().toISOString();
  // Preserve any additional stats fields the engine populated (sources,
  // buildMs, etc.) and only overlay the canonical counts.
  graph.stats = {
    ...(graph.stats || {}),
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    communities: Object.keys(graph.communities || {}).length,
    tokenCost: (graph.stats && graph.stats.tokenCost) || 0,
  };
  const large = graph.nodes.length + graph.edges.length > COMPACT_THRESHOLD;
  atomicWrite(graphPath(repoRoot, space), large ? JSON.stringify(graph) : JSON.stringify(graph, null, 2));
  // The caller keeps (and may keep mutating) `graph`, so it is not adopted as
  // the shared instance: the next shared read re-parses the file once.
  invalidateShared(repoRoot, space);
  return graph.stats;
}

function listSpaces(repoRoot) {
  const root = path.join(mindRoot(repoRoot), 'spaces');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(f => {
    try { return fs.statSync(path.join(root, f)).isDirectory(); } catch (_) { return false; }
  });
}

function statsFor(repoRoot, space) {
  const g = loadGraphShared(repoRoot, space);
  if (!g) return null;
  const lastBuildAt = g.generatedAt;
  return {
    nodes: g.stats?.nodes ?? g.nodes.length,
    edges: g.stats?.edges ?? g.edges.length,
    communities: g.stats?.communities ?? Object.keys(g.communities || {}).length,
    lastBuildAt,
    tokenCost: g.stats?.tokenCost ?? 0,
  };
}

module.exports = {
  namespaceFromSpace,
  mindRoot,
  spaceDir,
  graphPath,
  cacheDir,
  reportsDir,
  ensureDirs,
  loadGraph,
  loadGraphShared,
  invalidateShared,
  pruneReports,
  COMPACT_THRESHOLD,
  saveGraph,
  listSpaces,
  statsFor,
  emptyGraph,
};

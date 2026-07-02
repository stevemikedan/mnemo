import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { GraphStore } from '../src/graph/graph.js';
import { RecallEngine } from '../src/rag/recall.js';
import { __setConfig } from '../src/consolidation/config.js';

// No embedding provider → pure BM25, so these assert the lexical + scoping behavior.
beforeEach(() => __setConfig({ embeddings: { provider: 'none' } }));

function engine() {
  const store = new MemoryStore(':memory:');
  const graph = new GraphStore(store.db);
  return { store, graph, recall: new RecallEngine(store, graph) };
}

describe('RecallEngine.recall — scoping', () => {
  it('returns global + the queried project, and never another project', async () => {
    const { store, recall } = engine();
    store.create({ content: 'prefer tabs over spaces', type: 'user', scope: 'global' });
    store.create({ content: 'projA uses pnpm workspaces', scope: 'project:/a' });
    store.create({ content: 'projB uses npm workspaces', scope: 'project:/b' });

    const hits = await recall.recall({ query: 'pnpm workspaces', scope: 'project:/a' });
    expect(hits.map(h => h.memory.scope)).not.toContain('project:/b');
    expect(hits.some(h => h.memory.content.includes('projA'))).toBe(true);

    // Regression: a term unique to projB must not surface for a projA recall.
    const leak = await recall.recall({ query: 'npm', scope: 'project:/a' });
    expect(leak.some(h => h.memory.scope === 'project:/b')).toBe(false);
  });

  it('rebuilds the index per call — no stale index across equal-sized scopes', async () => {
    // Regression: index was cached by candidate count, so two different scopes
    // with the same count returned results from whichever was searched first.
    const { store, recall } = engine();
    store.create({ content: 'alpha apple', scope: 'project:/a' });
    store.create({ content: 'alpha apricot', scope: 'project:/a' });
    store.create({ content: 'beta banana', scope: 'project:/b' });
    store.create({ content: 'beta blueberry', scope: 'project:/b' });

    const a = await recall.recall({ query: 'apple', scope: 'project:/a' });
    expect(a[0]?.memory.content).toContain('apple');
    const b = await recall.recall({ query: 'banana', scope: 'project:/b' });
    expect(b[0]?.memory.content).toContain('banana');
    expect(b.some(h => h.memory.scope === 'project:/a')).toBe(false);
  });

  it('applies minImportance', async () => {
    const { store, recall } = engine();
    store.create({ content: 'important pnpm note', importance: 0.8, scope: 'global' });
    store.create({ content: 'trivial pnpm note', importance: 0.1, scope: 'global' });
    const hits = await recall.recall({ query: 'pnpm', scope: 'global', minImportance: 0.5 });
    expect(hits.map(h => h.memory.content)).toEqual(['important pnpm note']);
  });

  it('keeps related-expansion within scope despite a stray cross-scope edge', async () => {
    // Regression: neighbor expansion followed edges without a scope check, so a
    // legacy cross-scope edge (e.g. from a past global dream) bled another
    // project's memory into results.
    const { store, graph, recall } = engine();
    const a = store.create({ content: 'projA uses docker', scope: 'project:/a' });
    const b = store.create({ content: 'projB uses podman', scope: 'project:/b' });
    graph.addEdge(a.id, b.id, 'relates-to', 0.5);

    const hits = await recall.recall({ query: 'docker', scope: 'project:/a', includeRelated: true });
    const related = hits.flatMap(h => h.related ?? []);
    expect(related.some(r => r.scope === 'project:/b')).toBe(false);
  });
});

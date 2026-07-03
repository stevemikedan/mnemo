import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { GraphStore } from '../src/graph/graph.js';
import { runNREM, defaultMerge } from '../src/consolidation/nrem.js';
import { __setConfig } from '../src/consolidation/config.js';

// No LLM configured → defaultMerge uses the wordOverlap>0.65 heuristic.
beforeEach(() => __setConfig({ consolidation: { provider: 'none' } }));

function setup() {
  const store = new MemoryStore(':memory:');
  return { store, graph: new GraphStore(store.db) };
}

describe('runNREM (parameterized adjudicator)', () => {
  it('defaults to the heuristic and merges near-identical same-scope memories', async () => {
    const { store, graph } = setup();
    const a = store.create({ content: 'the project uses pnpm workspaces for the monorepo', importance: 0.6, scope: 'global' });
    const b = store.create({ content: 'the project uses pnpm workspaces for the monorepo', importance: 0.5, scope: 'global' });
    const stats = await runNREM(store, graph, store.query({}));
    expect(stats.merged).toBe(1);
    // Higher-importance survivor stays active; the other is expired.
    expect((store.db.prepare('SELECT state FROM memories WHERE id=?').get(b.id) as any).state).toBe('expired');
    expect((store.db.prepare('SELECT state FROM memories WHERE id=?').get(a.id) as any).state).toBe('active');
  });

  it('respects an injected adjudicator (SKIP → no merge)', async () => {
    const { store, graph } = setup();
    store.create({ content: 'the project uses pnpm workspaces for the monorepo', scope: 'global' });
    store.create({ content: 'the project uses pnpm workspaces for the monorepo', scope: 'global' });
    const stats = await runNREM(store, graph, store.query({}), async () => 'SKIP');
    expect(stats.merged).toBe(0);
  });

  it('never merges across scopes even when the adjudicator says MERGE', async () => {
    const { store, graph } = setup();
    store.create({ content: 'the project uses pnpm workspaces for the monorepo', scope: 'project:/a' });
    store.create({ content: 'the project uses pnpm workspaces for the monorepo', scope: 'project:/b' });
    const stats = await runNREM(store, graph, store.query({}), async () => 'MERGE');
    expect(stats.merged).toBe(0);
  });

  it('defaultMerge is exported and callable', async () => {
    const { store } = setup();
    const a = store.create({ content: 'alpha beta gamma delta epsilon zeta', scope: 'global' });
    const b = store.create({ content: 'alpha beta gamma delta epsilon zeta', scope: 'global' });
    expect(await defaultMerge(store.get(a.id)!, store.get(b.id)!)).toBe('MERGE'); // identical → heuristic MERGE
  });
});

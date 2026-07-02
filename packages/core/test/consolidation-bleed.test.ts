import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { GraphStore } from '../src/graph/graph.js';
import { runREM } from '../src/consolidation/rem.js';
import { __setConfig } from '../src/consolidation/config.js';

beforeEach(() => __setConfig({}));

describe('REM cross-linking — scope isolation', () => {
  it('never links memories in different scopes', () => {
    // Invariant: whatever pairs REM decides to link, both endpoints must share a
    // scope. Related content is spread across two projects; no edge may cross.
    const store = new MemoryStore(':memory:');
    const graph = new GraphStore(store.db);
    const contents = [
      'the deployment pipeline builds docker images and pushes them',
      'the deployment pipeline builds container images for release',
      'the deployment pipeline runs database migrations before release',
    ];
    for (const c of contents) {
      store.create({ content: c, type: 'project', scope: 'project:/a' });
      store.create({ content: c, type: 'project', scope: 'project:/b' });
    }

    runREM(store, graph, store.query({}));

    const scopeOf = (id: string) => (store.db.prepare('SELECT scope FROM memories WHERE id = ?').get(id) as any).scope;
    const edges = store.db.prepare('SELECT from_id, to_id FROM memory_edges').all() as any[];
    for (const e of edges) {
      expect(scopeOf(e.from_id)).toBe(scopeOf(e.to_id));
    }
  });

  it('does link related memories within the same scope', () => {
    const store = new MemoryStore(':memory:');
    const graph = new GraphStore(store.db);
    store.create({ content: 'the deployment pipeline builds docker images and pushes them to the registry', type: 'project', scope: 'global' });
    store.create({ content: 'the deployment pipeline builds container images and pushes releases to production', type: 'project', scope: 'global' });

    const stats = runREM(store, graph, store.query({}));
    // Related-but-not-duplicate content in the same scope should produce a link.
    expect(stats.linked).toBeGreaterThanOrEqual(1);
  });
});

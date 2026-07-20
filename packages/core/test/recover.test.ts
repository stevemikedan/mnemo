import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { GraphStore } from '../src/graph/graph.js';
import { runNREM } from '../src/consolidation/nrem.js';
import { runReconcile } from '../src/consolidation/reconcile.js';
import { listAudit, restoreMutation } from '../src/consolidation/recover.js';
import { __setConfig } from '../src/consolidation/config.js';

beforeEach(() => __setConfig({ embeddings: { provider: 'none' }, consolidation: { provider: 'none' } }));

function setup() {
  const store = new MemoryStore(':memory:');
  return { store, graph: new GraphStore(store.db) };
}

function setCreated(store: MemoryStore, id: string, iso: string) {
  store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(iso, id);
}

describe('dream recovery', () => {
  it('reverses an NREM merge: un-expires the candidate, reverts the survivor, drops the edge', async () => {
    const { store, graph } = setup();
    const a = store.create({ content: 'the api server listens on port three thousand', importance: 0.8, scope: 'global' });
    const b = store.create({ content: 'the api server listens on port three thousand indeed', importance: 0.3, scope: 'global' });
    await runNREM(store, graph, store.query({}), async () => 'MERGE');

    // Merged: survivor content appended, candidate expired, derived-from edge.
    expect(store.get(a.id)!.content).toContain('[Also:');
    expect(store.get(b.id)!.state).toBe('expired');
    expect((store.db.prepare("SELECT COUNT(*) n FROM memory_edges WHERE type='derived-from'").get() as any).n).toBe(1);

    const mutations = listAudit(store);
    expect(mutations).toHaveLength(1);
    expect(mutations[0].phase).toBe('nrem-merge');

    const result = restoreMutation(store, graph, mutations[0].mutationId);
    expect(result.restored).toBe(true);
    expect(store.get(a.id)!.content).toBe('the api server listens on port three thousand'); // reverted
    expect(store.get(b.id)!.state).toBe('active'); // un-expired
    expect((store.db.prepare("SELECT COUNT(*) n FROM memory_edges WHERE type='derived-from'").get() as any).n).toBe(0);

    // No longer reversible, and a second restore is a no-op.
    expect(listAudit(store)).toHaveLength(0);
    expect(restoreMutation(store, graph, mutations[0].mutationId).restored).toBe(false);
  });

  it('reverses a reconcile supersession: restores importance, clears superseded_by, drops the edge', async () => {
    const { store, graph } = setup();
    const older = store.create({ content: 'the project uses npm as its package manager', importance: 0.6, scope: 'global' });
    const newer = store.create({ content: 'the project uses pnpm as its package manager', importance: 0.6, scope: 'global' });
    setCreated(store, older.id, '2020-01-01T00:00:00.000Z');
    setCreated(store, newer.id, '2021-01-01T00:00:00.000Z');
    await runReconcile(store, graph, store.query({}), async () => 'SUPERSEDES');

    expect(store.get(older.id)!.superseded_by).toBe(newer.id);
    expect(store.get(older.id)!.importance).toBeLessThanOrEqual(0.15);

    const mutations = listAudit(store);
    expect(mutations).toHaveLength(1);
    expect(mutations[0].phase).toBe('reconcile-supersede');

    expect(restoreMutation(store, graph, mutations[0].mutationId).restored).toBe(true);
    const restored = store.get(older.id)!;
    expect(restored.superseded_by).toBeNull();
    expect(restored.importance).toBe(0.6);
    expect((store.db.prepare("SELECT COUNT(*) n FROM memory_edges WHERE type='supersedes'").get() as any).n).toBe(0);
  });

  it('returns not-restored for an unknown mutation_id', () => {
    const { store, graph } = setup();
    expect(restoreMutation(store, graph, 'nope').restored).toBe(false);
  });
});

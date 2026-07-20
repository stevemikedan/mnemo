import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { GraphStore } from '../src/graph/graph.js';
import { runNREM } from '../src/consolidation/nrem.js';
import { runReconcile } from '../src/consolidation/reconcile.js';
import { __setConfig } from '../src/consolidation/config.js';

beforeEach(() => __setConfig({ embeddings: { provider: 'none' }, consolidation: { provider: 'none' } }));

function auditRows(store: MemoryStore) {
  return store.db.prepare('SELECT phase, memory_id, before_state, note FROM dream_audit ORDER BY created_at').all() as
    { phase: string; memory_id: string; before_state: string; note: string | null }[];
}

describe('dream_audit trail', () => {
  it('NREM merge snapshots both memories before mutating them', async () => {
    const store = new MemoryStore(':memory:');
    const graph = new GraphStore(store.db);
    const a = store.create({ content: 'the api server listens on port three thousand', scope: 'global', importance: 0.8 });
    const b = store.create({ content: 'the api server listens on port three thousand today', scope: 'global', importance: 0.3 });

    await runNREM(store, graph, [a, b], async () => 'MERGE');

    const rows = auditRows(store);
    expect(rows.map(r => r.phase)).toEqual(['nrem-merge', 'nrem-merge']);
    const survivor = rows.find(r => r.memory_id === a.id)!;
    const casualty = rows.find(r => r.memory_id === b.id)!;
    // Snapshots hold the PRE-merge state: original content, no embedding blob.
    expect(JSON.parse(survivor.before_state).content).toBe('the api server listens on port three thousand');
    expect(JSON.parse(casualty.before_state).state).toBe('active');
    expect('embedding' in JSON.parse(survivor.before_state)).toBe(false);
    expect(casualty.note).toContain(a.id);
  });

  it('reconcile supersession snapshots the demoted memory; NONE/CONTRADICTS write nothing', async () => {
    const store = new MemoryStore(':memory:');
    const graph = new GraphStore(store.db);
    const older = store.create({ content: 'project deploys through the jenkins pipeline system', scope: 'global', importance: 0.7 });
    const newer = store.create({ content: 'project deploys through the github actions pipeline system', scope: 'global' });

    await runReconcile(store, graph, [older, newer], async () => 'CONTRADICTS');
    expect(auditRows(store)).toEqual([]);

    // Remove the contradicts edge so the pair is re-adjudicated.
    graph.removeEdge(newer.id, older.id);
    await runReconcile(store, graph, [older, newer], async () => 'SUPERSEDES');
    const rows = auditRows(store);
    expect(rows.length).toBe(1);
    expect(rows[0].phase).toBe('reconcile-supersede');
    expect(rows[0].memory_id).toBe(older.id);
    expect(JSON.parse(rows[0].before_state).importance).toBe(0.7); // pre-demotion
  });
});

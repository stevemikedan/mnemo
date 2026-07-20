import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { GraphStore } from '../src/graph/graph.js';
import { expandConflicts } from '../src/rag/conflicts.js';

function setup() {
  const store = new MemoryStore(':memory:');
  const graph = new GraphStore(store.db);
  return { store, graph };
}

describe('expandConflicts', () => {
  it('reports a conflict pair when both sides were retrieved', () => {
    const { store, graph } = setup();
    const a = store.create({ content: 'we use jest', scope: 'global' });
    const b = store.create({ content: 'we use vitest', scope: 'global' });
    graph.addEdge(b.id, a.id, 'contradicts');

    const { memories, conflicts } = expandConflicts(store, graph, [a, b]);
    expect(memories.length).toBe(2);
    expect(conflicts).toEqual([[0, 1]]);
  });

  it('pulls in a missing partner (either edge direction) and pairs it', () => {
    const { store, graph } = setup();
    const retrieved = store.create({ content: 'deploys via jenkins', scope: 'project:/a' });
    const partner = store.create({ content: 'deploys via github actions', scope: 'project:/a' });
    graph.addEdge(partner.id, retrieved.id, 'contradicts'); // incoming edge

    const { memories, conflicts } = expandConflicts(store, graph, [retrieved]);
    expect(memories.map(m => m.id)).toEqual([retrieved.id, partner.id]);
    expect(conflicts).toEqual([[0, 1]]);
  });

  it('never pulls in cross-scope, superseded, or non-active partners', () => {
    const { store, graph } = setup();
    const m = store.create({ content: 'base fact', scope: 'project:/a' });

    const crossScope = store.create({ content: 'other project fact', scope: 'project:/b' });
    const superseded = store.create({ content: 'old fact', scope: 'project:/a' });
    store.update(superseded.id, { superseded_by: 'x' });
    const archived = store.create({ content: 'archived fact', scope: 'project:/a' });
    store.update(archived.id, { state: 'archived' });
    for (const p of [crossScope, superseded, archived]) graph.addEdge(m.id, p.id, 'contradicts');

    const { memories, conflicts } = expandConflicts(store, graph, [m]);
    expect(memories.map(mm => mm.id)).toEqual([m.id]);
    expect(conflicts).toEqual([]);
  });

  it('ignores non-contradicts edges and caps additions', () => {
    const { store, graph } = setup();
    const m = store.create({ content: 'hub fact', scope: 'global' });
    const related = store.create({ content: 'related fact', scope: 'global' });
    graph.addEdge(m.id, related.id, 'relates-to');
    const partners = Array.from({ length: 4 }, (_, i) => {
      const p = store.create({ content: `conflicting fact ${i}`, scope: 'global' });
      graph.addEdge(m.id, p.id, 'contradicts');
      return p;
    });

    const { memories, conflicts } = expandConflicts(store, graph, [m], 2);
    expect(memories.length).toBe(3); // m + 2 of the 4 partners
    expect(conflicts.length).toBe(2);
    expect(memories.some(mm => mm.id === related.id)).toBe(false);
    expect(partners.length).toBe(4);
  });
});

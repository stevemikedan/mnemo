import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { GraphStore } from '../src/graph/graph.js';
import { __setConfig } from '../src/consolidation/config.js';

beforeEach(() => __setConfig({}));

function setup() {
  const store = new MemoryStore(':memory:');
  const graph = new GraphStore(store.db);
  const a = store.create({ content: 'a', scope: 'global' });
  const b = store.create({ content: 'b', scope: 'global' });
  return { store, graph, a, b };
}

describe('GraphStore', () => {
  it('getNeighbors returns neighbors with out/in direction', () => {
    // Regression: the direction literals were double-quoted ("out"/"in"), which
    // SQLite reads as column names — this threw "no such column: out" and broke
    // get_memory and recall(includeRelated) entirely.
    const { graph, a, b } = setup();
    graph.addEdge(a.id, b.id, 'relates-to', 0.5);
    expect(graph.getNeighbors(a.id)).toEqual([{ id: b.id, type: 'relates-to', direction: 'out' }]);
    expect(graph.getNeighbors(b.id)).toEqual([{ id: a.id, type: 'relates-to', direction: 'in' }]);
  });

  it('removeEdge deletes in either direction and reports the count', () => {
    const { graph, a, b } = setup();
    graph.addEdge(a.id, b.id, 'relates-to');
    expect(graph.removeEdge(b.id, a.id)).toBe(1); // reversed args still match
    expect(graph.removeEdge(a.id, b.id)).toBe(0);
    expect(graph.getNeighbors(a.id)).toEqual([]);
  });

  it('deleting a memory cascades its edges', () => {
    const { store, graph, a, b } = setup();
    graph.addEdge(a.id, b.id, 'relates-to');
    expect(store.delete(a.id)).toBe(true);
    expect(graph.getNeighbors(b.id)).toEqual([]);
  });
});

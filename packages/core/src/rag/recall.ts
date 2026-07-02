import { BM25Index, type SearchResult } from './bm25.js';
import type { MemoryStore, QueryOptions } from '../graph/store.js';
import type { GraphStore } from '../graph/graph.js';
import type { Memory } from '../graph/schema.js';

export interface RecallOptions extends QueryOptions {
  query: string;
  limit?: number;
  includeRelated?: boolean;
}

export interface RecallResult {
  memory: Memory;
  score: number;
  related?: Memory[];
}

export class RecallEngine {
  private index = new BM25Index();

  constructor(
    private store: MemoryStore,
    private graph: GraphStore,
  ) {}

  async recall(opts: RecallOptions): Promise<RecallResult[]> {
    const candidates = this.store.query({
      cwd: opts.cwd ?? opts.scope,
      types: opts.types,
      states: opts.states,
      tags: opts.tags,
    });

    // Rebuild the index on every recall. Keying on candidate count (the prior
    // approach) reused a stale index whenever a different scope or an edit
    // yielded the same count, returning wrong results with confident scores.
    this.index.build(candidates);

    const limit = opts.limit ?? 10;
    let results: SearchResult[];

    if (opts.query.trim()) {
      results = this.index.search(opts.query, 50);
    } else {
      // No query — return by importance
      results = candidates
        .sort((a, b) => b.importance - a.importance)
        .slice(0, limit)
        .map(m => ({ memory: m, score: m.importance }));
    }

    // Boost by importance
    results = results.map(r => ({
      ...r,
      score: r.score * (0.5 + r.memory.importance * 0.5),
    }));

    const top = results.slice(0, limit);

    // Reinforcement: recalling a memory strengthens it against decay.
    for (const r of top) this.store.recordAccess(r.memory.id);

    if (!opts.includeRelated) {
      return top.map(r => ({ memory: r.memory, score: r.score }));
    }

    // Graph expand: include 1-hop neighbors for top results, but only ones
    // within the visible scope. A stray cross-scope edge (e.g. from a past
    // global dream) must not bleed another project's memory into these results.
    const visibleIds = new Set(candidates.map(c => c.id));
    return Promise.all(top.map(async r => {
      const neighbors = this.graph.getNeighbors(r.memory.id, 1);
      const related = neighbors
        .filter(n => visibleIds.has(n.id))
        .map(n => this.store.get(n.id))
        .filter((m): m is Memory => m != null)
        .slice(0, 3);
      return { memory: r.memory, score: r.score, related };
    }));
  }
}

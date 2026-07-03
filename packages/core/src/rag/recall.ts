import { BM25Index, type SearchResult } from './bm25.js';
import { embedText, decodeVector, cosineSim } from './embedding.js';
import type { MemoryStore, QueryOptions } from '../graph/store.js';
import type { GraphStore } from '../graph/graph.js';
import type { Memory } from '../graph/schema.js';

const RRF_K = 60;

export interface RecallOptions extends QueryOptions {
  query: string;
  limit?: number;
  includeRelated?: boolean;
  /** Drop candidates below this importance before ranking. */
  minImportance?: number;
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
    let candidates = this.store.query({
      cwd: opts.cwd ?? opts.scope,
      types: opts.types,
      states: opts.states,
      tags: opts.tags,
    });
    if (opts.minImportance != null) {
      candidates = candidates.filter(c => c.importance >= opts.minImportance!);
    }

    // Rebuild the index on every recall. Keying on candidate count (the prior
    // approach) reused a stale index whenever a different scope or an edit
    // yielded the same count, returning wrong results with confident scores.
    this.index.build(candidates);

    const limit = opts.limit ?? 10;
    let results: SearchResult[];

    if (opts.query.trim()) {
      const bm25 = this.index.search(opts.query, 50);
      // Hybrid: fuse lexical (BM25) with semantic (vector cosine) rankings when
      // an embedding provider is configured; otherwise this is pure BM25.
      const queryVec = (await embedText([opts.query]))?.[0] ?? null;
      results = queryVec ? fuseRRF(candidates, bm25, queryVec) : bm25;
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

/**
 * Reciprocal Rank Fusion of a BM25 ranking and a vector-cosine ranking over the
 * same candidate set. RRF is scale-free, so it blends the two rankings without
 * normalizing their very different score magnitudes. Candidates without a
 * stored embedding simply contribute only their BM25 rank.
 */
export function fuseRRF(candidates: Memory[], bm25: SearchResult[], queryVec: number[]): SearchResult[] {
  const bm25Rank = new Map<string, number>();
  bm25.forEach((r, i) => bm25Rank.set(r.memory.id, i));

  // Raw lexical scores and cosine sims — normally discarded, kept here so a
  // future reranker can learn from them (see SearchResult.bm25/cosine).
  const bm25Score = new Map<string, number>();
  bm25.forEach(r => bm25Score.set(r.memory.id, r.score));
  const cosine = new Map<string, number>();

  const vecRank = new Map<string, number>();
  candidates
    .filter(c => c.embedding != null)
    .map(c => ({ id: c.id, sim: cosineSim(queryVec, decodeVector(c.embedding as Buffer)) }))
    .filter(v => v.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .forEach((v, i) => { vecRank.set(v.id, i); cosine.set(v.id, v.sim); });

  const byId = new Map(candidates.map(c => [c.id, c]));
  const ids = new Set<string>([...bm25Rank.keys(), ...vecRank.keys()]);

  return [...ids]
    .map(id => {
      const lex = bm25Rank.has(id) ? 1 / (RRF_K + bm25Rank.get(id)!) : 0;
      const sem = vecRank.has(id) ? 1 / (RRF_K + vecRank.get(id)!) : 0;
      return { memory: byId.get(id)!, score: lex + sem, bm25: bm25Score.get(id) ?? 0, cosine: cosine.get(id) ?? 0 };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Hybrid search over an explicit candidate set (already scope/state filtered by
 * the caller): BM25 fused with vector cosine when an embedding provider is
 * configured, else pure BM25. Used by the web dashboard, which manages its own
 * exact-scope candidate selection.
 */
export async function searchHybrid(candidates: Memory[], query: string, limit: number): Promise<SearchResult[]> {
  const index = new BM25Index();
  index.build(candidates);
  const bm25 = index.search(query, 50);
  const queryVec = (await embedText([query]))?.[0] ?? null;
  const ranked = queryVec ? fuseRRF(candidates, bm25, queryVec) : bm25;
  return ranked.slice(0, limit);
}

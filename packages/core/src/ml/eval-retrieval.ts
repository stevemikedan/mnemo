import { BM25Index } from '../rag/bm25.js';
import { fuseRRF } from '../rag/recall.js';
import { embedText } from '../rag/embedding.js';
import { applyReranker, edgeDegrees } from './reranker.js';
import type { MemoryStore } from '../graph/store.js';

/**
 * Retrieval eval harness over recall_feedback ground truth: each distinct
 * query's used memories are the relevant set. Compares the three ranking
 * variants side by side so "is hybrid/reranking actually helping?" is answered
 * with data from this store, not theory. The reranker variant force-applies the
 * trained model even when ml.rerank.enabled is off — measure before enabling.
 */

export interface VariantMetrics {
  /** Fraction of queries where a relevant memory appeared in the top 5. */
  recallAt5: number;
  /** Mean reciprocal rank of the first relevant memory. */
  mrr: number;
}

export interface RetrievalEvalReport {
  /** Distinct feedback queries evaluated (those whose used memories still exist). */
  queries: number;
  bm25: VariantMetrics;
  hybrid: VariantMetrics;
  reranked: VariantMetrics;
}

function score(rankings: string[][], relevant: Set<string>[]): VariantMetrics {
  let hits = 0, rrSum = 0;
  for (let i = 0; i < rankings.length; i++) {
    const rank = rankings[i].findIndex(id => relevant[i].has(id));
    if (rank >= 0 && rank < 5) hits++;
    if (rank >= 0) rrSum += 1 / (rank + 1);
  }
  const n = rankings.length || 1;
  return { recallAt5: hits / n, mrr: rrSum / n };
}

export async function evaluateRetrieval(store: MemoryStore): Promise<RetrievalEvalReport> {
  const rows = store.db.prepare(
    `SELECT query, memory_id FROM recall_feedback WHERE used = 1`,
  ).all() as { query: string; memory_id: string }[];

  const candidates = store.query({ states: ['active', 'dormant'] });
  const alive = new Set(candidates.map(c => c.id));

  const relevantByQuery = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!alive.has(r.memory_id)) continue; // memory since merged/expired
    if (!relevantByQuery.has(r.query)) relevantByQuery.set(r.query, new Set());
    relevantByQuery.get(r.query)!.add(r.memory_id);
  }

  const index = new BM25Index();
  index.build(candidates);
  const degrees = edgeDegrees(store);

  const bm25Rankings: string[][] = [];
  const hybridRankings: string[][] = [];
  const rerankedRankings: string[][] = [];
  const relevant: Set<string>[] = [];

  for (const [query, rel] of relevantByQuery) {
    const bm25 = index.search(query, 50);
    const queryVec = (await embedText([query]))?.[0] ?? null;
    const hybrid = queryVec ? fuseRRF(candidates, bm25, queryVec) : bm25;
    const reranked = applyReranker(hybrid, { force: true, degrees });

    bm25Rankings.push(bm25.map(r => r.memory.id));
    hybridRankings.push(hybrid.map(r => r.memory.id));
    rerankedRankings.push(reranked.map(r => r.memory.id));
    relevant.push(rel);
  }

  return {
    queries: relevant.length,
    bm25: score(bm25Rankings, relevant),
    hybrid: score(hybridRankings, relevant),
    reranked: score(rerankedRankings, relevant),
  };
}

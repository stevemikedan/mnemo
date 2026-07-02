import { llmComplete } from './llm.js';
import type { MemoryStore } from '../graph/store.js';
import type { GraphStore } from '../graph/graph.js';
import type { Memory } from '../graph/schema.js';

export interface ReconcileStats {
  /** Pairs actually sent to the adjudicator. */
  checked: number;
  contradictions: number;
  supersessions: number;
}

export type Verdict = 'SUPERSEDES' | 'CONTRADICTS' | 'NONE';
export type Adjudicator = (older: Memory, newer: Memory) => Promise<Verdict>;

/** Hard cap on adjudications per run to bound LLM cost. */
const MAX_PAIRS = 24;
/**
 * Minimum lexical overlap to consider a pair "about the same subject". No upper
 * bound: NREM has already merged true duplicates before this phase runs, so
 * even near-identical survivors (e.g. same sentence, one value changed — a
 * classic contradiction) are worth adjudicating.
 */
const MIN_OVERLAP = 0.2;

function wordOverlap(a: string, b: string): number {
  const A = new Set(a.toLowerCase().match(/\b\w{4,}\b/g) ?? []);
  const B = new Set(b.toLowerCase().match(/\b\w{4,}\b/g) ?? []);
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const w of A) if (B.has(w)) overlap++;
  return overlap / Math.max(A.size, B.size);
}

/** Default adjudicator: asks the configured LLM. Returns NONE when no LLM is available. */
export const llmAdjudicate: Adjudicator = async (older, newer) => {
  const resp = await llmComplete(
    `Memory A (older): "${older.content}"\nMemory B (newer): "${newer.content}"\n\n` +
      `How does B relate to A? Reply with exactly one word:\n` +
      `SUPERSEDES — B updates, replaces, or reverses A; A is now outdated.\n` +
      `CONTRADICTS — they conflict about the same subject but neither is clearly newer/authoritative.\n` +
      `NONE — they are compatible, or about different subjects.`,
    'You reconcile an AI assistant\'s stored memories. Be conservative: only answer SUPERSEDES or CONTRADICTS for a genuine conflict about the same subject.',
  );
  if (!resp) return 'NONE';
  const u = resp.trim().toUpperCase();
  if (u.includes('SUPERSEDE')) return 'SUPERSEDES';
  if (u.includes('CONTRADICT')) return 'CONTRADICTS';
  return 'NONE';
};

/**
 * Reconciliation phase: find same-scope, same-type memories that are about the
 * same subject but conflict, and record the relationship as a real edge.
 *  - SUPERSEDES: the newer memory overrides the older. Adds a `supersedes` edge
 *    (newer → older) and de-prioritizes the older (low importance + a
 *    superseded_by marker) so recall prefers the current fact.
 *  - CONTRADICTS: genuine conflict with no clear winner. Adds a `contradicts`
 *    edge so the tension is visible; neither memory is demoted.
 *
 * LLM-gated: with no consolidation provider configured the adjudicator returns
 * NONE and this is a no-op. Same-scope only (no cross-project reconciliation).
 */
export async function runReconcile(
  store: MemoryStore,
  graph: GraphStore,
  memories: Memory[],
  adjudicate: Adjudicator = llmAdjudicate,
): Promise<ReconcileStats> {
  const stats: ReconcileStats = { checked: 0, contradictions: 0, supersessions: 0 };

  const active = memories.filter(m => m.state !== 'expired');

  // Skip pairs that already share an edge.
  const existingPairs = new Set<string>();
  for (const m of active) {
    for (const e of graph.getEdges(m.id)) existingPairs.add([e.from_id, e.to_id].sort().join(':'));
  }

  const sample = active.slice(0, 100);
  const scored: Array<{ a: Memory; b: Memory; overlap: number }> = [];
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const a = sample[i];
      const b = sample[j];
      if (a.type !== b.type) continue;
      if (a.scope !== b.scope) continue; // same scope only — no cross-project bleed
      if (existingPairs.has([a.id, b.id].sort().join(':'))) continue;
      const overlap = wordOverlap(a.content, b.content);
      if (overlap < MIN_OVERLAP) continue;
      scored.push({ a, b, overlap });
    }
  }

  // Adjudicate the most topically-similar pairs first, then cap for cost.
  scored.sort((x, y) => y.overlap - x.overlap);

  for (const { a, b } of scored.slice(0, MAX_PAIRS)) {
    const older = a.created_at <= b.created_at ? a : b;
    const newer = older === a ? b : a;
    const verdict = await adjudicate(older, newer);
    stats.checked++;

    if (verdict === 'SUPERSEDES') {
      graph.addEdge(newer.id, older.id, 'supersedes', 1.0);
      store.update(older.id, {
        importance: Math.min(older.importance, 0.15),
        metadata: { ...older.metadata, superseded_by: newer.id },
      });
      stats.supersessions++;
    } else if (verdict === 'CONTRADICTS') {
      graph.addEdge(newer.id, older.id, 'contradicts', 1.0);
      stats.contradictions++;
    }
  }

  return stats;
}

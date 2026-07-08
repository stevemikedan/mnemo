import { embedText, cosineSim, decodeVector } from '../rag/embedding.js';
import { readConfig } from '../consolidation/config.js';
import type { MemoryStore } from '../graph/store.js';
import type { Memory } from '../graph/schema.js';

/**
 * Containment-normalized word overlap: shared ÷ the SMALLER set. Unlike
 * max-normalized overlap, this catches the subset case — new content that is a
 * prefix/excerpt of an existing longer memory scores ~1.0 (it IS a duplicate),
 * where max-normalization would dilute it below threshold.
 */
function containment(a: string, b: string): number {
  const A = new Set(a.toLowerCase().match(/\b\w{4,}\b/g) ?? []);
  const B = new Set(b.toLowerCase().match(/\b\w{4,}\b/g) ?? []);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

export interface DuplicateHit {
  memory: Memory;
  /** 0..1 — the strongest signal that fired. */
  similarity: number;
  /** Which signal detected it. */
  basis: 'embedding' | 'lexical';
}

/**
 * Write-time near-duplicate check: compare new content against existing
 * memories in the SAME scope (consistent with NREM's same-scope merge rule).
 *
 * Layered fallbacks — strongest available signal wins, and failure never
 * blocks a write:
 *  1. embedding cosine (when a provider is configured AND the candidate has a
 *     stored vector; dimension mismatch scores 0 and falls through)
 *  2. lexical word-overlap (always available)
 *  3. no signal → no warning; the write proceeds normally.
 *
 * Warn-only by design: callers decide what to do with hits. Disable via
 * ml.dedup.enabled=false.
 */
export async function findNearDuplicates(
  store: MemoryStore,
  content: string,
  scope: string,
): Promise<DuplicateHit[]> {
  const cfg = readConfig().ml?.dedup ?? {};
  if (cfg.enabled === false) return [];
  const overlapThreshold = cfg.overlapThreshold ?? 0.7;
  const cosineThreshold = cfg.cosineThreshold ?? 0.85;

  const candidates = store.query({ scope, states: ['active', 'dormant'] });
  if (candidates.length === 0) return [];

  let queryVec: number[] | null = null;
  try {
    queryVec = (await embedText([content]))?.[0] ?? null;
  } catch {
    queryVec = null; // embedding failure degrades to lexical
  }

  const hits: DuplicateHit[] = [];
  for (const c of candidates) {
    const cos = queryVec && c.embedding != null
      ? cosineSim(queryVec, decodeVector(c.embedding as Buffer))
      : 0;
    const overlap = containment(content, c.content);
    if (cos >= cosineThreshold) {
      hits.push({ memory: c, similarity: cos, basis: 'embedding' });
    } else if (overlap >= overlapThreshold) {
      hits.push({ memory: c, similarity: overlap, basis: 'lexical' });
    }
  }

  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}

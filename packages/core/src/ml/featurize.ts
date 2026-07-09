import { localEmbed, cosineSim, decodeVector } from '../rag/embedding.js';
import type { Memory } from '../graph/schema.js';

/** Dimension for the built-in local hashing embedder. */
export const TEXT_FEATURE_DIM = 256;

/** 256-dim local hashing features — sync, provider-independent. */
export function textFeatures(content: string): number[] {
  return localEmbed([content], TEXT_FEATURE_DIM)[0];
}

/**
 * Features for a stored Memory. Prefers the stored embedding blob (e.g. 768-dim
 * nomic vectors after encodeForDream) so the classifier can leverage the richer
 * transformer representation. Falls back to local 256-dim hashing when no blob
 * is present. Callers must ensure all samples in a training run use the same
 * path — use this function uniformly rather than mixing with textFeatures().
 */
export function textFeaturesFromMemory(m: Memory): number[] {
  if (m.embedding != null) {
    return Array.from(decodeVector(m.embedding as Buffer));
  }
  return localEmbed([m.content], TEXT_FEATURE_DIM)[0];
}

export function wordOverlap(a: string, b: string): number {
  const A = new Set(a.toLowerCase().match(/\b\w{4,}\b/g) ?? []);
  const B = new Set(b.toLowerCase().match(/\b\w{4,}\b/g) ?? []);
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const w of A) if (B.has(w)) overlap++;
  return overlap / Math.max(A.size, B.size);
}

const DAY = 86_400_000;

/**
 * Cheap, LLM-free features for a memory pair — used by the adjudication log and,
 * later, the consolidation pre-screener. Fixed length; pure; no I/O.
 */
export function pairFeatures(a: Memory, b: Memory): number[] {
  const bothEmb = a.embedding != null && b.embedding != null;
  const cos = bothEmb
    ? cosineSim(decodeVector(a.embedding as Buffer), decodeVector(b.embedding as Buffer))
    : 0;
  const ageDelta = Math.abs(Date.parse(a.created_at) - Date.parse(b.created_at)) / DAY;
  return [
    wordOverlap(a.content, b.content),
    cos,
    bothEmb ? 1 : 0,
    a.type === b.type ? 1 : 0,
    a.scope === b.scope ? 1 : 0,
    Math.abs(a.importance - b.importance),
    Math.min(1, ageDelta / 365),
    Math.min(1, Math.abs(a.content.length - b.content.length) / 500),
  ];
}

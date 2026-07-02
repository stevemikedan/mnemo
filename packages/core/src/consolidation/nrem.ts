import { llmComplete } from './llm.js';
import { BM25Index } from '../rag/bm25.js';
import type { MemoryStore } from '../graph/store.js';
import type { GraphStore } from '../graph/graph.js';
import type { Memory } from '../graph/schema.js';

export interface NREMStats {
  processed: number;
  merged: number;
  unchanged: number;
}

function wordOverlap(a: string, b: string): number {
  const aWords = new Set(a.toLowerCase().match(/\b\w{4,}\b/g) ?? []);
  const bWords = new Set(b.toLowerCase().match(/\b\w{4,}\b/g) ?? []);
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let overlap = 0;
  for (const w of aWords) if (bWords.has(w)) overlap++;
  return overlap / Math.max(aWords.size, bWords.size);
}

async function adjudicate(survivor: Memory, candidate: Memory): Promise<'MERGE' | 'SKIP'> {
  const response = await llmComplete(
    `Two memories may express the same fact. Should they be merged into one?\n\nMemory A: "${survivor.content}"\nMemory B: "${candidate.content}"\n\nReply with exactly one word: MERGE (same fact, consolidate) or SKIP (distinct, keep both).`,
    'You are a memory deduplication assistant. Be conservative — only merge if clearly the same fact.',
  );

  if (!response) {
    // Heuristic fallback: merge only if very high overlap
    return wordOverlap(survivor.content, candidate.content) > 0.65 ? 'MERGE' : 'SKIP';
  }

  return response.trim().toUpperCase().includes('MERGE') ? 'MERGE' : 'SKIP';
}

export async function runNREM(
  store: MemoryStore,
  graph: GraphStore,
  memories: Memory[],
): Promise<NREMStats> {
  const stats: NREMStats = { processed: 0, merged: 0, unchanged: 0 };
  const expired = new Set<string>();

  // Sort: higher importance survives merges
  const sorted = [...memories].sort((a, b) => b.importance - a.importance);

  const index = new BM25Index();
  index.build(sorted);

  for (const mem of sorted) {
    if (expired.has(mem.id)) continue;
    stats.processed++;

    // Same scope only: never merge one project's memory into another's (or a
    // project memory into a global one), which would silently expire data
    // across project boundaries.
    const hits = index.search(mem.content, 8)
      .filter(h => h.memory.id !== mem.id && !expired.has(h.memory.id)
        && h.memory.type === mem.type && h.memory.scope === mem.scope);

    // Only adjudicate candidates with meaningful word overlap
    const candidates = hits.filter(h => wordOverlap(mem.content, h.memory.content) > 0.38);

    let merged = false;
    for (const candidate of candidates.slice(0, 2)) {
      const action = await adjudicate(mem, candidate.memory);
      if (action === 'MERGE') {
        // mem survives (higher importance), candidate is expired
        const combined = `${mem.content}\n  [Also: ${candidate.memory.content}]`;
        store.update(mem.id, {
          content: combined,
          importance: Math.max(mem.importance, candidate.memory.importance),
        });
        store.update(candidate.memory.id, { state: 'expired' });
        graph.addEdge(candidate.memory.id, mem.id, 'supersedes');
        expired.add(candidate.memory.id);
        stats.merged++;
        merged = true;
        break;
      }
    }

    if (!merged) stats.unchanged++;
  }

  return stats;
}

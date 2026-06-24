import type { MemoryStore } from '../graph/store.js';
import type { GraphStore } from '../graph/graph.js';
import type { Memory } from '../graph/schema.js';

export interface REMStats {
  linked: number;
  promoted: number;
}

function cosineSim(a: string, b: string): number {
  const words = (s: string) => s.toLowerCase().match(/\b\w{4,}\b/g) ?? [];
  const aWords = words(a);
  const bWords = words(b);
  const aFreq = new Map<string, number>();
  const bFreq = new Map<string, number>();
  for (const w of aWords) aFreq.set(w, (aFreq.get(w) ?? 0) + 1);
  for (const w of bWords) bFreq.set(w, (bFreq.get(w) ?? 0) + 1);

  let dot = 0, aMag = 0, bMag = 0;
  for (const [w, f] of aFreq) { dot += f * (bFreq.get(w) ?? 0); aMag += f * f; }
  for (const [, f] of bFreq) bMag += f * f;
  if (aMag === 0 || bMag === 0) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

export function runREM(
  store: MemoryStore,
  graph: GraphStore,
  memories: Memory[],
  projectPath?: string,
): REMStats {
  const stats: REMStats = { linked: 0, promoted: 0 };

  // Cross-link: find pairs with meaningful-but-not-duplicate overlap
  const existingEdgePairs = new Set<string>();
  const existingEdges = memories.flatMap(m => graph.getEdges(m.id));
  for (const e of existingEdges) {
    existingEdgePairs.add([e.from_id, e.to_id].sort().join(':'));
  }

  const sample = memories.slice(0, 100); // cap to avoid O(n^2) blowup
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const a = sample[i];
      const b = sample[j];
      // Only link same-type memories
      if (a.type !== b.type) continue;
      const pairKey = [a.id, b.id].sort().join(':');
      if (existingEdgePairs.has(pairKey)) continue;

      const sim = cosineSim(a.content, b.content);
      // Related (0.25–0.65): not duplicates, not unrelated
      if (sim >= 0.25 && sim < 0.65) {
        graph.addEdge(a.id, b.id, 'relates-to', sim);
        existingEdgePairs.add(pairKey);
        stats.linked++;
      }
    }
  }

  // TiMem promotion: session-sourced memories with high importance → project scope
  // We track promotion via metadata since scope is write-once in current schema
  if (projectPath) {
    for (const mem of memories) {
      if (mem.source.startsWith('session:') && mem.importance >= 0.7 && !mem.metadata['promoted']) {
        store.update(mem.id, {
          metadata: { ...mem.metadata, promoted: true, promotedToProject: projectPath },
        });
        stats.promoted++;
      }
    }
  }

  return stats;
}

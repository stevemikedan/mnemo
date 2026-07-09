import lunr from 'lunr';
import type { Memory } from '../graph/schema.js';

export interface SearchResult {
  memory: Memory;
  score: number;
  /** Raw lexical (BM25/lunr) score, if known — exposed by fuseRRF for a future reranker. */
  bm25?: number;
  /** Raw vector cosine similarity, if known — exposed by fuseRRF for a future reranker. */
  cosine?: number;
}

export class BM25Index {
  private index: lunr.Index | null = null;
  private memoryMap: Map<string, Memory> = new Map();

  build(memories: Memory[]): void {
    this.memoryMap = new Map(memories.map(m => [m.id, m]));
    this.index = lunr(function () {
      this.field('content', { boost: 10 });
      this.field('tags');
      this.field('type');
      this.ref('id');
      for (const m of memories) {
        this.add({
          id: m.id,
          content: m.content,
          tags: m.tags.join(' '),
          type: m.type,
        });
      }
    });
  }

  search(query: string, limit = 50): SearchResult[] {
    if (!this.index || this.memoryMap.size === 0) return [];
    // Strip lunr query-syntax operators before parsing. Queries here are plain
    // text (often raw memory content), and lunr would interpret e.g. "~45" as
    // fuzzy-match-with-edit-distance-45 — which explodes the heap (real crash:
    // a memory containing "measured ~45 seconds" OOM'd every dream). Hyphens
    // are safe to space out (lunr's tokenizer already splits on them).
    const sanitized = query.replace(/[~^:*+\-]/g, ' ');
    try {
      const results = this.index.search(sanitized);
      return results
        .slice(0, limit)
        .map(r => ({ memory: this.memoryMap.get(r.ref)!, score: r.score }))
        .filter(r => r.memory != null);
    } catch {
      // lunr throws on empty/invalid queries
      return [];
    }
  }

  get size(): number {
    return this.memoryMap.size;
  }
}

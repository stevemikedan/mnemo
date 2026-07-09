import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { BM25Index } from '../src/rag/bm25.js';

describe('BM25Index query sanitization', () => {
  it('survives content containing lunr query operators (the "~45" OOM regression)', () => {
    // Real crash: NREM feeds raw memory content in as a query, and lunr parses
    // "~45" as fuzzy-match-with-edit-distance-45 → unbounded allocation → OOM.
    const store = new MemoryStore(':memory:');
    const killer = 'Ollama cold-loads a model into memory on the first call after idle — measured ~45 seconds for nomic-embed-text, while warm calls take under 1 second. Timeout raised from 10s to 90s.';
    store.create({ content: killer, scope: 'global' });
    store.create({ content: 'a completely unrelated note about deployment pipelines', scope: 'global' });

    const index = new BM25Index();
    index.build(store.query({}));

    // Must complete (not hang/OOM) and still find the memory by its own content.
    const hits = index.search(killer, 8);
    expect(hits.some(h => h.memory.content === killer)).toBe(true);

    // Other operator characters must be inert too.
    for (const q of ['foo~999999', 'field:value', 'boost^100', 'wild*card', '+required -prohibited']) {
      expect(() => index.search(q, 8)).not.toThrow();
    }
  });
});

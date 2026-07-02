import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { cosineSim, encodeVector, embedText, reindexEmbeddings, isEmbeddingConfigured } from '../src/rag/embedding.js';
import { fuseRRF } from '../src/rag/recall.js';
import { __setConfig } from '../src/consolidation/config.js';

describe('cosineSim', () => {
  it('is 1 for identical, 0 for orthogonal, and 0 for mismatched dimensions', () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSim([1, 0], [0, 1])).toBe(0);
    // Dimension guard: after a model change, old vectors of a different length
    // must not blow up — they score 0 (and degrade to BM25).
    expect(cosineSim([1, 2, 3], [1, 2])).toBe(0);
  });
});

describe('built-in local embedder', () => {
  beforeEach(() => __setConfig({ embeddings: { provider: 'local' } }));

  it('is configured, deterministic, and fixed-dimension', async () => {
    expect(isEmbeddingConfigured()).toBe(true);
    const a = await embedText(['hello world']);
    const b = await embedText(['hello world']);
    expect(a).not.toBeNull();
    expect(a![0]).toEqual(b![0]);
    expect(a![0].length).toBe(256);
  });

  it('places related text closer than unrelated text', async () => {
    const v = await embedText(['deploy docker containers', 'deploying docker container', 'the cat sat on the mat']);
    const [d1, d2, cat] = v!;
    expect(cosineSim(d1, d2)).toBeGreaterThan(cosineSim(d1, cat));
  });
});

describe('embedText with no provider', () => {
  beforeEach(() => __setConfig({ embeddings: { provider: 'none' } }));
  it('returns null so retrieval degrades to pure BM25', async () => {
    expect(isEmbeddingConfigured()).toBe(false);
    expect(await embedText(['x'])).toBeNull();
  });
});

describe('fuseRRF', () => {
  beforeEach(() => __setConfig({}));
  it('ranks a candidate present in both rankings above one present in only one', () => {
    const store = new MemoryStore(':memory:');
    const m1 = store.create({ content: 'alpha' });
    const m2 = store.create({ content: 'beta' });
    store.create({ content: 'gamma' });
    store.setEmbedding(m1.id, encodeVector([1, 0, 0]));
    store.setEmbedding(m2.id, encodeVector([0, 1, 0]));
    // gamma left with no embedding on purpose.
    const candidates = store.query({});
    const byContent = (c: string) => candidates.find(x => x.content === c)!;

    // BM25 ranks beta first, alpha second; query vector matches alpha.
    const bm25 = [
      { memory: byContent('beta'), score: 5 },
      { memory: byContent('alpha'), score: 3 },
    ];
    const fused = fuseRRF(candidates, bm25, [1, 0, 0]);
    expect(fused[0].memory.content).toBe('alpha'); // lexical + semantic beats lexical-only
    expect(fused.map(f => f.memory.content)).not.toContain('gamma'); // in neither ranking
  });
});

describe('reindexEmbeddings', () => {
  const encoded = (store: MemoryStore) =>
    (store.db.prepare('SELECT COUNT(*) n FROM memories WHERE embedding IS NOT NULL').get() as any).n;

  it('encodes the backlog and is idempotent (clear N, re-encode N)', async () => {
    __setConfig({ embeddings: { provider: 'local' } });
    const store = new MemoryStore(':memory:');
    ['a', 'b', 'c'].forEach(c => store.create({ content: c }));
    const r1 = await reindexEmbeddings(store);
    expect(r1.embedded).toBe(3);
    expect(encoded(store)).toBe(3);
    const r2 = await reindexEmbeddings(store);
    expect(r2.cleared).toBe(3);
    expect(r2.embedded).toBe(3);
  });

  it('does NOT clear existing vectors when no provider is configured', async () => {
    __setConfig({ embeddings: { provider: 'local' } });
    const store = new MemoryStore(':memory:');
    store.create({ content: 'a' });
    await reindexEmbeddings(store);
    expect(encoded(store)).toBe(1);

    __setConfig({ embeddings: { provider: 'none' } });
    const r = await reindexEmbeddings(store);
    expect(r.provider).toBe('none');
    expect(r.cleared).toBe(0);
    expect(encoded(store)).toBe(1); // untouched — a misconfigured call must not wipe vectors
  });
});

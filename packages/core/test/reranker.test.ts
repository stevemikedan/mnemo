import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore } from '../src/graph/store.js';
import { trainReranker, applyReranker } from '../src/ml/reranker.js';
import { searchHybrid } from '../src/rag/recall.js';
import { __setConfig } from '../src/consolidation/config.js';
import type { Memory } from '../src/graph/schema.js';

// Isolate model I/O (~/.mnemo/elm-reranker.json) into a temp home per test.
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'mnemo-rerank-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  __setConfig({ embeddings: { provider: 'none' }, ml: { rerank: { enabled: true } } });
});

const TOPICS = ['deploy', 'testing', 'database', 'authentication', 'logging', 'caching',
  'billing', 'onboarding', 'notifications', 'search', 'exports', 'migrations'];

/**
 * Per topic: one high-importance memory that gets used for the topic query and
 * three low-importance distractors sharing the topic word (so BM25 retrieves
 * them → they become real negatives). The learnable signal is importance.
 */
function seed(store: MemoryStore): Map<string, Memory> {
  const used = new Map<string, Memory>();
  for (const t of TOPICS) {
    const winner = store.create({ content: `${t} is handled by the primary ${t} service module`, scope: 'global', importance: 0.9 });
    used.set(`how does ${t} work here`, winner);
    for (let i = 0; i < 3; i++) {
      store.create({ content: `${t} side note number ${i} about minor ${t} trivia`, scope: 'global', importance: 0.1 });
    }
  }
  return used;
}

describe('learned reranker', () => {
  it('trains on recall_feedback and promotes the historically-used memory', async () => {
    const store = new MemoryStore(':memory:');
    const used = seed(store);
    for (const [query, m] of used) store.recordFeedback(query, m.id);

    const report = await trainReranker(store);
    expect(report.trained).toBe(true);

    // Equal fused scores → the model's P(used) must break the tie toward the
    // high-importance (historically used) memory.
    const candidates = store.query({});
    const winner = candidates.find(c => c.importance === 0.9)!;
    const loser = candidates.find(c => c.importance === 0.1)!;
    const reranked = applyReranker([
      { memory: loser, score: 1, bm25: 2, cosine: 0 },
      { memory: winner, score: 1, bm25: 2, cosine: 0 },
    ]);
    expect(reranked[0].memory.id).toBe(winner.id);
    expect(reranked[0].score).toBeGreaterThan(reranked[1].score);
  });

  it('reorders searchHybrid results end to end', async () => {
    const store = new MemoryStore(':memory:');
    const used = seed(store);
    for (const [query, m] of used) store.recordFeedback(query, m.id);
    await trainReranker(store);

    const hits = await searchHybrid(store.query({}), 'deploy', 4);
    expect(hits[0].memory.importance).toBe(0.9);
  });

  it('is a no-op when disabled or untrained', async () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'anything', scope: 'global' });
    const input = [{ memory: m, score: 0.5, bm25: 1, cosine: 0 }];

    // Untrained: no model file in this temp home.
    expect(applyReranker(input)).toEqual(input);

    const used = seed(store);
    for (const [query, mem] of used) store.recordFeedback(query, mem.id);
    await trainReranker(store);
    __setConfig({ embeddings: { provider: 'none' }, ml: { rerank: { enabled: false } } });
    expect(applyReranker(input)).toEqual(input);
  });

  it('trains from explicit used=0 impressions (which mining could never produce)', async () => {
    const store = new MemoryStore(':memory:');
    for (const t of TOPICS) {
      const winner = store.create({ content: `${t} is handled by the primary ${t} service module`, scope: 'global', importance: 0.9 });
      const query = `how does ${t} work here`;
      store.recordFeedback(query, winner.id, true);
      for (let i = 0; i < 3; i++) {
        // Shares no vocabulary with the query and has no embedding → train-time
        // mining would drop it (bm25=0, cosine=0). Only the explicit impression
        // row can make it a negative — so trained=true proves that path works.
        const shown = store.create({ content: `office plant watering rota item ${i} nothing relevant`, scope: 'global', importance: 0.1 });
        store.recordFeedback(query, shown.id, false);
      }
    }
    const report = await trainReranker(store);
    expect(report.trained).toBe(true);
  });

  it('cold start: no feedback → declines to train', async () => {
    const store = new MemoryStore(':memory:');
    seed(store);
    const report = await trainReranker(store);
    expect(report.trained).toBe(false);
  });
});

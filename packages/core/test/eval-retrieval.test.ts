import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore } from '../src/graph/store.js';
import { evaluateRetrieval } from '../src/ml/eval-retrieval.js';
import { __setConfig } from '../src/consolidation/config.js';

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'mnemo-eval-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  __setConfig({ embeddings: { provider: 'none' } });
});

describe('retrieval eval harness', () => {
  it('scores perfect recall/MRR when the used memory is the top lexical hit', async () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'deployment runs through github actions', scope: 'global' });
    store.create({ content: 'the office plant needs watering weekly', scope: 'global' });
    store.recordFeedback('github actions deployment', m.id);

    const report = await evaluateRetrieval(store);
    expect(report.queries).toBe(1);
    expect(report.bm25.recallAt5).toBe(1);
    expect(report.bm25.mrr).toBe(1);
    // No embeddings and no trained reranker → all variants identical.
    expect(report.hybrid).toEqual(report.bm25);
    expect(report.reranked).toEqual(report.bm25);
  });

  it('skips feedback pointing at memories that no longer exist', async () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'ephemeral fact', scope: 'global' });
    store.recordFeedback('ephemeral fact', m.id);
    store.delete(m.id);

    const report = await evaluateRetrieval(store);
    expect(report.queries).toBe(0);
  });
});

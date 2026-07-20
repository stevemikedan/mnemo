import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore } from '../src/graph/store.js';
import { logAdjudication } from '../src/ml/adjudication-log.js';
import { trainPrescreener, prescreenPair } from '../src/ml/prescreen.js';
import { __setConfig } from '../src/consolidation/config.js';

// Isolate model I/O (~/.mnemo/elm-prescreen-*.json) into a temp home per test.
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'mnemo-prescreen-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  __setConfig({ ml: { prescreen: { enabled: true, minMargin: 0 } } });
});

/** Synthetic pairFeatures rows: SKIP pairs have low lexical overlap, MERGE pairs high. */
function seedVerdicts(store: MemoryStore, n = 45) {
  for (let i = 0; i < n; i++) {
    const t = (i % 10) / 10;
    logAdjudication(store, {
      older_id: `s${i}`, newer_id: `s${i}x`, scope: 'global', phase: 'nrem',
      features: [0.02 + t * 0.15, 0, 0, 1, 1, 0.1, 0.05, 0.1], verdict: 'SKIP', source: 'llm', model: 'test/model',
    });
    logAdjudication(store, {
      older_id: `m${i}`, newer_id: `m${i}x`, scope: 'global', phase: 'nrem',
      features: [0.7 + t * 0.29, 0, 0, 1, 1, 0.1, 0.05, 0.1], verdict: 'MERGE', source: 'llm', model: 'test/model',
    });
  }
}

describe('consolidation pre-screener', () => {
  it('trains on logged verdicts and short-circuits an obvious non-duplicate to SKIP', () => {
    const store = new MemoryStore(':memory:');
    seedVerdicts(store);
    const report = trainPrescreener(store, 'nrem');
    expect(report.trained).toBe(true);

    const a = store.create({ content: 'the deploy pipeline uses github actions runners', scope: 'global' });
    const b = store.create({ content: 'coffee machine broken on the fourth floor', scope: 'global' });
    expect(prescreenPair('nrem', a, b)).toBe('SKIP');
  });

  it('never short-circuits a predicted positive — near-identical pairs go to the LLM', () => {
    const store = new MemoryStore(':memory:');
    seedVerdicts(store);
    trainPrescreener(store, 'nrem');

    const a = store.create({ content: 'the production database runs postgres fifteen', scope: 'global' });
    const b = store.create({ content: 'the production database runs postgres fifteen now', scope: 'global' });
    // High-overlap pair → model predicts MERGE → pre-screener must defer (null).
    expect(prescreenPair('nrem', a, b)).toBeNull();
  });

  it('returns null when disabled, untrained, or below the margin gate', () => {
    const store = new MemoryStore(':memory:');
    const a = store.create({ content: 'alpha topic entirely', scope: 'global' });
    const b = store.create({ content: 'unrelated beta subject', scope: 'global' });

    // Untrained (no model file in this temp home).
    expect(prescreenPair('nrem', a, b)).toBeNull();

    seedVerdicts(store);
    trainPrescreener(store, 'nrem');
    __setConfig({ ml: { prescreen: { enabled: false } } });
    expect(prescreenPair('nrem', a, b)).toBeNull();

    __setConfig({ ml: { prescreen: { enabled: true, minMargin: 0.999 } } });
    expect(prescreenPair('nrem', a, b)).toBeNull();
  });

  it('cold start: too few rows → declines to train', () => {
    const store = new MemoryStore(':memory:');
    seedVerdicts(store, 5); // 10 rows < minSamples 50
    const report = trainPrescreener(store, 'nrem');
    expect(report.trained).toBe(false);
  });

  it('excludes rows from models listed in excludeModels', () => {
    const store = new MemoryStore(':memory:');
    seedVerdicts(store);
    __setConfig({ ml: { prescreen: { enabled: true, excludeModels: ['test/model'] } } });
    const report = trainPrescreener(store, 'nrem');
    expect(report.trained).toBe(false); // every row excluded → nothing to train on
  });
});

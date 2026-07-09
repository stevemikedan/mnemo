import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore } from '../src/graph/store.js';
import { trainTypeClassifier, suggestType } from '../src/ml/type-classifier.js';
import { __setConfig } from '../src/consolidation/config.js';
import type { MemoryType } from '../src/graph/schema.js';

// Isolate model I/O (~/.mnemo/elm-type-classifier.json) into a temp home per test.
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'mnemo-ml-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  __setConfig({ ml: { typeSuggest: { enabled: true, minConfidence: 0, minMargin: 0 } } });
});

const FEEDBACK = ['always run the tests before committing', 'never force push to main branch', 'do not commit secrets to the repo', 'prefer small focused commits always'];
const REFERENCE = ['see the api docs at example website', 'the config lives in config json file', 'authentication handled inside auth module', 'the schema file defines database tables'];
const PROJECT = ['this project uses pnpm workspaces monorepo', 'the app deploys to production via pipeline', 'database migrations use the drizzle orm', 'the api server runs on port three thousand'];

function seed(store: MemoryStore) {
  for (let i = 0; i < 8; i++) {
    FEEDBACK.forEach(p => store.create({ content: `${p} ${i}`, type: 'feedback', scope: 'global' }));
    REFERENCE.forEach(p => store.create({ content: `${p} ${i}`, type: 'reference', scope: 'global' }));
    PROJECT.forEach(p => store.create({ content: `${p} ${i}`, type: 'project', scope: 'global' }));
  }
}

describe('type classifier', () => {
  it('trains on a type-distinct corpus, beats baseline, and suggests the right type', async () => {
    const store = new MemoryStore(':memory:');
    seed(store);
    const report = trainTypeClassifier(store);
    expect(report.trained).toBe(true);
    expect(report.accuracy!).toBeGreaterThan(report.baselineAccuracy!);
    // No stored embeddings in :memory: store → 256-dim local path (sync under the hood)
    const s = await suggestType('remember to run the tests before committing your changes');
    expect(s?.type).toBe<MemoryType>('feedback');
  });

  it('cold-start: tiny store → no model persisted, suggestType returns null', async () => {
    const store = new MemoryStore(':memory:');
    store.create({ content: 'one lonely memory', type: 'project', scope: 'global' });
    const report = trainTypeClassifier(store);
    expect(report.trained).toBe(false);
    expect(await suggestType('anything at all')).toBeNull();
  });

  it('respects the confidence/margin gate', async () => {
    const store = new MemoryStore(':memory:');
    seed(store);
    trainTypeClassifier(store);
    __setConfig({ ml: { typeSuggest: { enabled: true, minConfidence: 0.999, minMargin: 0.999 } } });
    expect(await suggestType('remember to run the tests before committing')).toBeNull();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { GraphStore } from '../src/graph/graph.js';
import { dream } from '../src/consolidation/dream.js';
import { logAdjudication } from '../src/ml/adjudication-log.js';
import { __setConfig } from '../src/consolidation/config.js';

function setup() {
  const store = new MemoryStore(':memory:');
  return { store, graph: new GraphStore(store.db) };
}

const rows = (store: MemoryStore) => store.db.prepare('SELECT * FROM adjudication_log').all() as any[];

describe('adjudication logging', () => {
  it('logAdjudication inserts a row with JSON features', () => {
    __setConfig({});
    const { store } = setup();
    logAdjudication(store, {
      older_id: 'a', newer_id: 'b', scope: 'global', phase: 'reconcile',
      features: [0.5, 0.2, 1, 1, 1, 0.1, 0, 0], verdict: 'SUPERSEDES', source: 'llm',
    });
    const r = rows(store);
    expect(r).toHaveLength(1);
    expect(JSON.parse(r[0].features)).toEqual([0.5, 0.2, 1, 1, 1, 0.1, 0, 0]);
    expect(r[0].verdict).toBe('SUPERSEDES');
    expect(r[0].source).toBe('llm');
    expect(r[0].phase).toBe('reconcile');
  });

  it('dream does NOT log when no consolidation LLM is configured', async () => {
    __setConfig({ consolidation: { provider: 'none' } });
    const { store, graph } = setup();
    // two near-duplicate + one conflicting pair
    store.create({ content: 'the api timeout should be thirty seconds', scope: 'global' });
    store.create({ content: 'the api timeout should be five seconds', scope: 'global' });
    await dream(store, graph, {});
    expect(rows(store)).toHaveLength(0);
  });

  it('dream logs verdicts when a consolidation LLM is configured', async () => {
    // Force an "LLM active" config, but stub the actual call by using the heuristic
    // path via 'none' would skip logging — so we assert the gate directly instead:
    // with a provider set, shouldLogAdjudications() is true and reconcile/nrem
    // wrappers log. We use a provider value that llmComplete treats as no-op
    // (returns null → verdict NONE/heuristic), but logging still fires.
    __setConfig({ consolidation: { provider: 'anthropic', apiKey: '' }, ml: { prescreen: { logging: true } } });
    const { store, graph } = setup();
    store.create({ content: 'the deployment uses docker compose for local postgres', scope: 'global' });
    store.create({ content: 'the deployment uses docker compose to run postgres locally', scope: 'global' });
    await dream(store, graph, {});
    // At least the NREM adjudication of the near-duplicate pair should be logged.
    const r = rows(store);
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(['nrem', 'reconcile']).toContain(r[0].phase);
    expect(JSON.parse(r[0].features).length).toBe(8);
  });
});

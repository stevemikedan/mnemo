import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  it('dream logs verdicts with HONEST provenance when the configured LLM cannot run', async () => {
    // Provider is set (so the logging gate is open) but the API key is empty, so
    // the anthropic call returns null and NREM's word-overlap heuristic actually
    // decides. The row must record that truthfully — source/model 'heuristic',
    // NOT the configured anthropic model — so the pre-screener never trains on a
    // heuristic verdict mislabeled as an LLM one.
    __setConfig({ consolidation: { provider: 'anthropic', apiKey: '' }, ml: { prescreen: { logging: true } } });
    const { store, graph } = setup();
    store.create({ content: 'the deployment uses docker compose for local postgres', scope: 'global' });
    store.create({ content: 'the deployment uses docker compose to run postgres locally', scope: 'global' });
    await dream(store, graph, {});
    const r = rows(store);
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(['nrem', 'reconcile']).toContain(r[0].phase);
    expect(JSON.parse(r[0].features).length).toBe(8);
    expect(r[0].model).toBe('heuristic');
    expect(r[0].source).toBe('heuristic');
  });

  it('logAdjudication stores an explicit model stamp', () => {
    __setConfig({});
    const { store } = setup();
    logAdjudication(store, {
      older_id: 'a', newer_id: 'b', scope: 'global', phase: 'nrem',
      features: [1, 0, 0, 1, 1, 0, 0, 0], verdict: 'MERGE', source: 'llm',
      model: 'ollama/llama3.2:3b',
    });
    expect(rows(store)[0].model).toBe('ollama/llama3.2:3b');
  });

  it('migrates a pre-model-column DB: adds the column, keeps old rows readable', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mnemo-mig-')), 'test.db');
    // Simulate a DB created before the model column existed.
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE adjudication_log (
      id TEXT PRIMARY KEY, older_id TEXT NOT NULL, newer_id TEXT NOT NULL,
      scope TEXT NOT NULL, phase TEXT NOT NULL, features TEXT NOT NULL,
      verdict TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    old.prepare(`INSERT INTO adjudication_log VALUES ('x','a','b','global','nrem','[]','MERGE','llm','2026-01-01T00:00:00Z')`).run();
    old.close();

    const store = new MemoryStore(dbPath); // constructor runs the migration
    const r = rows(store);
    expect(r).toHaveLength(1);
    expect(r[0].model).toBeNull(); // pre-migration rows: provenance unknown
    // And new inserts with a stamp work against the migrated table.
    logAdjudication(store, {
      older_id: 'c', newer_id: 'd', scope: 'global', phase: 'reconcile',
      features: [0, 0, 0, 0, 0, 0, 0, 0], verdict: 'NONE', source: 'llm', model: 'claude-cli/haiku',
    });
    expect(rows(store)).toHaveLength(2);
  });
});

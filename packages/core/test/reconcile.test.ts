import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { GraphStore } from '../src/graph/graph.js';
import { runReconcile, type Adjudicator } from '../src/consolidation/reconcile.js';
import { __setConfig } from '../src/consolidation/config.js';

beforeEach(() => __setConfig({}));

function setup() {
  const store = new MemoryStore(':memory:');
  const graph = new GraphStore(store.db);
  return { store, graph };
}

/** Force created_at so older/newer is deterministic regardless of wall-clock. */
function setCreated(store: MemoryStore, id: string, iso: string) {
  store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(iso, id);
}

const always = (v: Awaited<ReturnType<Adjudicator>>): Adjudicator => async () => v;

describe('runReconcile', () => {
  it('records newer-supersedes-older: supersedes edge + de-prioritizes the older', async () => {
    const { store, graph } = setup();
    const older = store.create({ content: 'the project uses npm as its package manager', importance: 0.6 });
    const newer = store.create({ content: 'the project uses pnpm as its package manager', importance: 0.6 });
    setCreated(store, older.id, '2020-01-01T00:00:00.000Z');
    setCreated(store, newer.id, '2021-01-01T00:00:00.000Z');

    const stats = await runReconcile(store, graph, store.query({}), always('SUPERSEDES'));
    expect(stats.supersessions).toBe(1);

    const edges = store.db.prepare('SELECT from_id, to_id, type FROM memory_edges').all();
    expect(edges).toContainEqual({ from_id: newer.id, to_id: older.id, type: 'supersedes' });

    const got = store.get(older.id)!;
    expect(got.importance).toBeLessThanOrEqual(0.15);
    expect(got.metadata.superseded_by).toBe(newer.id);
  });

  it('flags contradictions with an edge but does not demote either memory', async () => {
    const { store, graph } = setup();
    const a = store.create({ content: 'the api timeout should be thirty seconds', importance: 0.5 });
    const b = store.create({ content: 'the api timeout should be five seconds', importance: 0.5 });

    const stats = await runReconcile(store, graph, store.query({}), always('CONTRADICTS'));
    expect(stats.contradictions).toBe(1);
    expect(store.db.prepare("SELECT COUNT(*) n FROM memory_edges WHERE type='contradicts'").get()).toEqual({ n: 1 });
    expect(store.get(a.id)!.importance).toBe(0.5);
    expect(store.get(b.id)!.importance).toBe(0.5);
  });

  it('is a no-op when the adjudicator returns NONE', async () => {
    const { store, graph } = setup();
    store.create({ content: 'the project uses npm as its package manager' });
    store.create({ content: 'the project uses pnpm as its package manager' });
    const stats = await runReconcile(store, graph, store.query({}), always('NONE'));
    expect(stats).toMatchObject({ contradictions: 0, supersessions: 0 });
    expect(store.db.prepare('SELECT COUNT(*) n FROM memory_edges').get()).toEqual({ n: 0 });
  });

  it('never reconciles across scopes even when the adjudicator would', async () => {
    const { store, graph } = setup();
    store.create({ content: 'the project uses npm as its package manager', scope: 'project:/a' });
    store.create({ content: 'the project uses pnpm as its package manager', scope: 'project:/b' });
    const stats = await runReconcile(store, graph, store.query({}), always('SUPERSEDES'));
    expect(stats.supersessions).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) n FROM memory_edges').get()).toEqual({ n: 0 });
  });

  it('only adjudicates same-type pairs', async () => {
    const { store, graph } = setup();
    store.create({ content: 'the project uses npm as its package manager', type: 'project' });
    store.create({ content: 'the project uses pnpm as its package manager', type: 'user' });
    const stats = await runReconcile(store, graph, store.query({}), always('SUPERSEDES'));
    expect(stats.checked).toBe(0);
  });
});

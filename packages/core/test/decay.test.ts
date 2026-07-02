import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { runDecay, retentionOf } from '../src/consolidation/decay.js';
import { __setConfig } from '../src/consolidation/config.js';

// Empty config → decay uses its documented defaults (halfLife 30d, thresholds 0.5/0.2/0.05, protect 0.9).
beforeEach(() => __setConfig({}));

const DAY = 86_400_000;
const stateOf = (store: MemoryStore, id: string) =>
  (store.db.prepare('SELECT state FROM memories WHERE id = ?').get(id) as any).state;

describe('retentionOf', () => {
  it('is ~1 at age 0 and strictly decreases with age', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x', importance: 0.5 });
    const t0 = Date.parse(m.created_at);
    expect(retentionOf(m, t0)).toBeCloseTo(1, 5);
    const r30 = retentionOf(m, t0 + 30 * DAY);
    const r90 = retentionOf(m, t0 + 90 * DAY);
    expect(r30).toBeLessThan(1);
    expect(r90).toBeLessThan(r30);
    expect(r90).toBeGreaterThan(0);
  });

  it('higher importance decays more slowly', () => {
    const store = new MemoryStore(':memory:');
    const lo = store.create({ content: 'lo', importance: 0.2 });
    const hi = store.create({ content: 'hi', importance: 0.9 });
    const t = Date.parse(lo.created_at) + 60 * DAY;
    expect(retentionOf(hi, t)).toBeGreaterThan(retentionOf(lo, t));
  });
});

describe('runDecay lifecycle', () => {
  it('transitions active → dormant → archived → expired as retention falls', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x', importance: 0.5 });
    const t0 = Date.parse(m.created_at);
    const at = (d: number) => t0 + d * DAY;

    // For importance 0.5 with no accesses, stability = 30 days, so
    // retention = exp(-days/30). Bands: active ≥0.5 (≤~21d), dormant ≥0.2
    // (≤~48d), archived ≥0.05 (≤~90d), expired below.
    runDecay(store, { now: at(10) }); //  exp(-0.33) ≈ 0.72
    expect(stateOf(store, m.id)).toBe('active');
    runDecay(store, { now: at(45) }); //  exp(-1.5)  ≈ 0.22
    expect(stateOf(store, m.id)).toBe('dormant');
    runDecay(store, { now: at(70) }); //  exp(-2.33) ≈ 0.10
    expect(stateOf(store, m.id)).toBe('archived');
    runDecay(store, { now: at(200) }); // exp(-6.67) ≈ 0.001
    expect(stateOf(store, m.id)).toBe('expired');
  });

  it('pins high-importance memories at active regardless of age', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'pinned', importance: 0.95 });
    runDecay(store, { now: Date.parse(m.created_at) + 1000 * DAY });
    expect(stateOf(store, m.id)).toBe('active');
  });

  it('reinforcement (a recent access) reactivates a dormant memory', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x', importance: 0.5 });
    const t0 = Date.parse(m.created_at);
    runDecay(store, { now: t0 + 45 * DAY });
    expect(stateOf(store, m.id)).toBe('dormant');
    // Simulate a recall at day 45.
    store.db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?').run(new Date(t0 + 45 * DAY).toISOString(), m.id);
    const stats = runDecay(store, { now: t0 + 46 * DAY });
    expect(stateOf(store, m.id)).toBe('active');
    expect(stats.reactivated).toBe(1);
  });

  it('is idempotent for a fixed clock (no state changes on a second pass)', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x', importance: 0.5 });
    const now = Date.parse(m.created_at) + 45 * DAY;
    runDecay(store, { now });
    const second = runDecay(store, { now });
    expect(second).toEqual({ scanned: 1, toDormant: 0, toArchived: 0, expired: 0, reactivated: 0 });
  });

  it('is disabled when config sets decay.enabled = false', () => {
    __setConfig({ decay: { enabled: false } });
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x', importance: 0.5 });
    runDecay(store, { now: Date.parse(m.created_at) + 400 * DAY });
    expect(stateOf(store, m.id)).toBe('active'); // untouched
  });
});

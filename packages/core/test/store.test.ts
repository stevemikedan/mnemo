import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore } from '../src/graph/store.js';
import { __setConfig } from '../src/consolidation/config.js';

beforeEach(() => __setConfig({}));

describe('superseded_by migration', () => {
  it('backfills the column from legacy metadata and strips the duplicate pointer', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mnemo-sup-')), 'test.db');
    // Simulate a pre-column DB: memories table without superseded_by, pointer in metadata.
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'project',
      scope TEXT NOT NULL DEFAULT 'global', state TEXT NOT NULL DEFAULT 'active',
      importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      last_accessed TEXT, last_consolidated TEXT, embedding BLOB,
      tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'user',
      metadata TEXT NOT NULL DEFAULT '{}'
    )`);
    old.prepare(`INSERT INTO memories (id, content, created_at, metadata) VALUES ('old','stale fact','2026-01-01T00:00:00Z',?)`)
      .run(JSON.stringify({ superseded_by: 'newer', other: 'keep' }));
    old.close();

    const store = new MemoryStore(dbPath); // constructor runs the migration
    const m = store.get('old')!;
    expect(m.superseded_by).toBe('newer');          // promoted to the column
    expect(m.metadata['superseded_by']).toBeUndefined(); // stripped from metadata
    expect(m.metadata['other']).toBe('keep');       // other metadata preserved
  });
});

describe('MemoryStore.create', () => {
  it('applies sane defaults', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x' });
    expect(m.type).toBe('project');
    expect(m.scope).toBe('global');
    expect(m.state).toBe('active');
    expect(m.importance).toBe(0.5);
    expect(m.confidence).toBe(1.0);
    expect(m.access_count).toBe(0);
    expect(m.embedding).toBeNull();
    expect(m.tags).toEqual([]);
  });
});

describe('MemoryStore.update', () => {
  it('persists type AND scope', () => {
    // Regression: update() previously ignored type and scope (they were not in
    // the UPDATE set), so the dashboard Type editor was silently a no-op.
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x', type: 'project', scope: 'global' });
    expect(store.update(m.id, { type: 'feedback', scope: 'project:/p' })).toBe(true);
    const got = store.get(m.id)!;
    expect(got.type).toBe('feedback');
    expect(got.scope).toBe('project:/p');
  });

  it('updates content, state, importance, and tags', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x' });
    store.update(m.id, { content: 'y', state: 'dormant', importance: 0.9, tags: ['a', 'b'] });
    const got = store.get(m.id)!;
    expect(got.content).toBe('y');
    expect(got.state).toBe('dormant');
    expect(got.importance).toBe(0.9);
    expect(got.tags).toEqual(['a', 'b']);
  });

  it('returns false with no fields and for a missing id', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x' });
    expect(store.update(m.id, {})).toBe(false);
    expect(store.update('nope', { content: 'z' })).toBe(false);
  });
});

describe('MemoryStore access tracking', () => {
  it('get() increments access_count and sets last_accessed', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x' });
    store.get(m.id);
    const got = store.get(m.id)!;
    expect(got.access_count).toBeGreaterThanOrEqual(1);
    expect(got.last_accessed).not.toBeNull();
  });

  it('recordAccess bumps the counter without a read', () => {
    const store = new MemoryStore(':memory:');
    const m = store.create({ content: 'x' });
    store.recordAccess(m.id);
    const row = store.db.prepare('SELECT access_count, last_accessed FROM memories WHERE id = ?').get(m.id) as any;
    expect(row.access_count).toBe(1);
    expect(row.last_accessed).not.toBeNull();
  });
});

describe('MemoryStore.delete / listScopes', () => {
  it('delete removes the row and is reflected by listScopes', () => {
    const store = new MemoryStore(':memory:');
    const a = store.create({ content: 'a', scope: 'global' });
    store.create({ content: 'b', scope: 'project:/p' });
    expect(store.listScopes()).toEqual(['global', 'project:/p']);
    expect(store.delete(a.id)).toBe(true);
    expect(store.delete(a.id)).toBe(false);
    expect(store.listScopes()).toEqual(['project:/p']);
  });
});

describe('MemoryStore.query filters', () => {
  it('filters by type, tag, and limit', () => {
    const store = new MemoryStore(':memory:');
    store.create({ content: 'p1', type: 'project', tags: ['x'] });
    store.create({ content: 'u1', type: 'user', tags: ['y'] });
    store.create({ content: 'p2', type: 'project', tags: ['x'] });
    expect(store.query({ types: ['user'] }).map(m => m.content)).toEqual(['u1']);
    expect(store.query({ tags: ['x'] }).map(m => m.content).sort()).toEqual(['p1', 'p2']);
    expect(store.query({ limit: 1 })).toHaveLength(1);
  });

  it('defaults to active + dormant states, excluding archived/expired', () => {
    const store = new MemoryStore(':memory:');
    const a = store.create({ content: 'active' });
    const d = store.create({ content: 'dormant' });
    const ar = store.create({ content: 'archived' });
    store.update(d.id, { state: 'dormant' });
    store.update(ar.id, { state: 'archived' });
    expect(store.query({}).map(m => m.content).sort()).toEqual(['active', 'dormant']);
    expect(store.query({ states: ['archived'] }).map(m => m.content)).toEqual(['archived']);
  });
});

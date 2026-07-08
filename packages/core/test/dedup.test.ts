import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { findNearDuplicates } from '../src/ml/dedup.js';
import { encodeVector, localEmbed } from '../src/rag/embedding.js';
import { __setConfig } from '../src/consolidation/config.js';

describe('findNearDuplicates — lexical fallback (no embedding provider)', () => {
  beforeEach(() => __setConfig({ embeddings: { provider: 'none' } }));

  it('flags a near-identical memory in the same scope', async () => {
    const store = new MemoryStore(':memory:');
    const existing = store.create({ content: 'the project uses pnpm workspaces for the monorepo build', scope: 'global' });
    const hits = await findNearDuplicates(store, 'the project uses pnpm workspaces for monorepo builds', 'global');
    expect(hits).toHaveLength(1);
    expect(hits[0].memory.id).toBe(existing.id);
    expect(hits[0].basis).toBe('lexical');
    expect(hits[0].similarity).toBeGreaterThanOrEqual(0.6);
  });

  it('does not flag unrelated content', async () => {
    const store = new MemoryStore(':memory:');
    store.create({ content: 'the project uses pnpm workspaces for the monorepo build', scope: 'global' });
    const hits = await findNearDuplicates(store, 'the cat sat quietly on the warm windowsill', 'global');
    expect(hits).toHaveLength(0);
  });

  it('respects scope isolation — a dup in another scope is not flagged', async () => {
    const store = new MemoryStore(':memory:');
    store.create({ content: 'the project uses pnpm workspaces for the monorepo build', scope: 'project:/a' });
    const hits = await findNearDuplicates(store, 'the project uses pnpm workspaces for the monorepo build', 'project:/b');
    expect(hits).toHaveLength(0);
  });

  it('can be disabled via config', async () => {
    __setConfig({ ml: { dedup: { enabled: false } } });
    const store = new MemoryStore(':memory:');
    store.create({ content: 'the project uses pnpm workspaces for the monorepo build', scope: 'global' });
    const hits = await findNearDuplicates(store, 'the project uses pnpm workspaces for the monorepo build', 'global');
    expect(hits).toHaveLength(0);
  });
});

describe('findNearDuplicates — embedding basis', () => {
  it('uses embedding cosine when provider + stored vectors exist', async () => {
    __setConfig({ embeddings: { provider: 'local' } });
    const store = new MemoryStore(':memory:');
    const text = 'we deploy services with docker containers on the release pipeline';
    const m = store.create({ content: text, scope: 'global' });
    store.setEmbedding(m.id, encodeVector(localEmbed([text], 256)[0]));
    const hits = await findNearDuplicates(store, text, 'global');
    expect(hits).toHaveLength(1);
    expect(hits[0].basis).toBe('embedding');
    expect(hits[0].similarity).toBeGreaterThan(0.85);
  });
});

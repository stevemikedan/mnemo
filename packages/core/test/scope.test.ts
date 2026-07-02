import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { isScopeVisible } from '../src/access.js';
import { __setConfig } from '../src/consolidation/config.js';

beforeEach(() => __setConfig({ consolidation: { provider: 'none' }, embeddings: { provider: 'none' } }));

const contents = (ms: { content: string }[]) => ms.map(m => m.content).sort();

describe('isScopeVisible', () => {
  it('global is visible from anywhere', () => {
    expect(isScopeVisible('global', '/anywhere')).toBe(true);
  });

  it('a project is visible from its own dir and nested dirs', () => {
    expect(isScopeVisible('project:/home/s/projA', '/home/s/projA')).toBe(true);
    expect(isScopeVisible('project:/home/s/projA', '/home/s/projA/pkg/sub')).toBe(true);
  });

  it('a project is NOT visible from a sibling whose path shares a prefix', () => {
    // 'project:/home/s/proj' must not leak into '/home/s/projA'
    expect(isScopeVisible('project:/home/s/proj', '/home/s/projA')).toBe(false);
  });

  it('session scopes are never visible', () => {
    expect(isScopeVisible('session:xyz', '/home/s/projA')).toBe(false);
  });
});

describe('MemoryStore.query — scope resolution contract', () => {
  function seed() {
    const store = new MemoryStore(':memory:');
    store.create({ content: 'global fact', scope: 'global' });
    store.create({ content: 'projA fact', scope: 'project:/home/s/projA' });
    store.create({ content: 'projB fact', scope: 'project:/home/s/projB' });
    store.create({ content: 'sibling fact', scope: 'project:/home/s/proj' });
    return store;
  }

  it('exact scope returns only that scope (no global)', () => {
    const store = seed();
    expect(contents(store.query({ scope: 'project:/home/s/projA' }))).toEqual(['projA fact']);
  });

  it('exact scope "global" returns only global', () => {
    const store = seed();
    expect(contents(store.query({ scope: 'global' }))).toEqual(['global fact']);
  });

  it('cwd visibility returns global + that project, and excludes siblings/other projects', () => {
    const store = seed();
    // Regression: a "project:"-prefixed value must be normalized, and siblings excluded.
    expect(contents(store.query({ cwd: 'project:/home/s/projA' }))).toEqual(['global fact', 'projA fact']);
    expect(contents(store.query({ cwd: '/home/s/projA' }))).toEqual(['global fact', 'projA fact']);
  });

  it('no scope and no cwd returns all scopes', () => {
    const store = seed();
    expect(contents(store.query({}))).toEqual(['global fact', 'projA fact', 'projB fact', 'sibling fact']);
  });

  it('paths containing LIKE wildcards are matched literally, not as patterns', () => {
    const store = new MemoryStore(':memory:');
    store.create({ content: 'underscore proj', scope: 'project:/home/s/my_proj' });
    // '_' is a LIKE single-char wildcard; must not match 'myXproj'
    expect(contents(store.query({ cwd: '/home/s/myXproj' }))).toEqual([]);
    expect(contents(store.query({ cwd: '/home/s/my_proj' }))).toEqual(['underscore proj']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/graph/store.js';
import { suggestTags } from '../src/ml/tag-suggest.js';
import { __setConfig } from '../src/consolidation/config.js';

beforeEach(() => __setConfig({ ml: { tagSuggest: { enabled: true } } }));

function seeded() {
  const store = new MemoryStore(':memory:');
  // A cluster of build-tagged memories and a cluster of deploy-tagged ones.
  ['the build uses pnpm workspaces and turbo caching',
   'run pnpm install then pnpm build to compile the workspace',
   'the monorepo build pipeline compiles typescript packages'].forEach(c =>
    store.create({ content: c, tags: ['build'], scope: 'global' }));
  ['the deploy pipeline pushes docker images to the registry',
   'production deploys run through github actions with docker',
   'deployment requires the docker compose stack to be running'].forEach(c =>
    store.create({ content: c, tags: ['deploy', 'docker'], scope: 'global' }));
  return store;
}

describe('suggestTags (KNN vote)', () => {
  it('suggests the dominant tag of the nearest cluster', () => {
    const store = seeded();
    expect(suggestTags(store, 'compile the workspace with the pnpm build system')).toContain('build');
    const deployTags = suggestTags(store, 'push the docker image and deploy to production');
    expect(deployTags).toContain('deploy');
    expect(deployTags).toContain('docker');
  });

  it('returns [] for unrelated content (no neighbor clears minSim)', () => {
    const store = seeded();
    expect(suggestTags(store, 'the quick brown fox jumped over the lazy dog')).toEqual([]);
  });

  it('returns [] when disabled or when no tagged memories exist', () => {
    __setConfig({ ml: { tagSuggest: { enabled: false } } });
    expect(suggestTags(seeded(), 'compile the workspace with pnpm build')).toEqual([]);
    __setConfig({ ml: { tagSuggest: { enabled: true } } });
    const empty = new MemoryStore(':memory:');
    empty.create({ content: 'untagged memory about builds', scope: 'global' });
    expect(suggestTags(empty, 'compile the workspace with pnpm build')).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { distillSignals, extractSignals } from '../src/consolidation/session.js';

const transcript = 'User: we decided to use pnpm workspaces\nAssistant: got it';

describe('distillSignals (LLM capture)', () => {
  it('parses a clean JSON array of self-contained memories', async () => {
    const complete = async () => JSON.stringify([
      { content: 'The project uses pnpm workspaces for its monorepo.', type: 'project', importance: 0.8, tags: ['build'] },
    ]);
    const out = await distillSignals(transcript, complete);
    expect(out).toEqual([
      { content: 'The project uses pnpm workspaces for its monorepo.', type: 'project', importance: 0.8, tags: ['build'] },
    ]);
  });

  it('tolerates prose/code-fence wrapping around the JSON', async () => {
    const complete = async () => 'Here you go:\n```json\n[{"content":"User prefers tabs over spaces always.","type":"user","importance":0.7,"tags":[]}]\n```';
    const out = await distillSignals(transcript, complete);
    expect(out).toHaveLength(1);
    expect(out![0].type).toBe('user');
  });

  it('coerces a bad type to project and clamps a bad importance', async () => {
    const complete = async () => JSON.stringify([
      { content: 'Some durable fact stated plainly.', type: 'nonsense', importance: 5, tags: 'notarray' },
    ]);
    const out = await distillSignals(transcript, complete);
    expect(out![0].type).toBe('project');
    expect(out![0].importance).toBe(0.6);
    expect(out![0].tags).toEqual([]);
  });

  it('drops too-short items', async () => {
    const complete = async () => JSON.stringify([{ content: 'too short', type: 'project', importance: 0.5, tags: [] }]);
    expect(await distillSignals(transcript, complete)).toEqual([]);
  });

  it('returns null when no LLM (so the caller falls back to regex)', async () => {
    expect(await distillSignals(transcript, async () => null)).toBeNull();
  });

  it('returns null on unparseable output', async () => {
    expect(await distillSignals(transcript, async () => 'no json here at all')).toBeNull();
  });

  it('regex extractSignals remains the fallback and still works', () => {
    const signals = extractSignals('we decided to use pnpm workspaces for the whole monorepo');
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].type).toBe('project');
  });
});

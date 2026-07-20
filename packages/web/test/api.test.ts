import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'http';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore, GraphStore } from '@mnemo/core';
import { createApiHandler, recordCitationFeedback } from '../src-server/api.js';

// Drives the real /api/* handler over a live HTTP server against a :memory:
// store, so routing, body parsing, scope filtering, and serialization are all
// exercised end-to-end.

let server: Server;
let base: string;
let store: MemoryStore;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mnemo-web-'));
  writeFileSync(join(tmp, 'config.json'), JSON.stringify({ embeddings: { provider: 'none' }, consolidation: { provider: 'none' } }));
  process.env.MNEMO_CONFIG_PATH = join(tmp, 'config.json');

  store = new MemoryStore(':memory:');
  const graph = new GraphStore(store.db);
  const handler = createApiHandler(store, graph);
  server = createHttpServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end('{}'); }));
  await new Promise<void>(r => server.listen(0, r));
  const addr = server.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

const getJson = (p: string) => fetch(base + p).then(r => r.json());
async function post(p: string, body: unknown) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const remember = (content: string, extra: Record<string, unknown> = {}) =>
  post('/api/remember', { content, ...extra }).then(r => r.body.id as string);

describe('GET /api/status', () => {
  it('returns counts and an embeddings block', async () => {
    const s = await getJson('/api/status');
    expect(typeof s.total).toBe('number');
    expect(s.embeddings).toEqual({ provider: 'none', encoded: 0 });
  });
});

describe('remember + list + scopes', () => {
  it('stores a memory and lists it by scope', async () => {
    await remember('web dashboard uses vite', { scope: 'global', tags: ['ui'] });
    const list = await getJson('/api/memories?scope=global');
    expect(list.some((m: any) => m.content === 'web dashboard uses vite')).toBe(true);
    const scopes = await getJson('/api/scopes');
    expect(scopes).toContain('global');
  });

  it('scope filter is exact — one project does not return another (or global)', async () => {
    await remember('projA memory', { scope: 'project:/a' });
    await remember('projB memory', { scope: 'project:/b' });
    const a = await getJson('/api/memories?scope=' + encodeURIComponent('project:/a'));
    const scopes = a.map((m: any) => m.scope);
    expect(scopes).toContain('project:/a');
    expect(scopes).not.toContain('project:/b');
    expect(scopes).not.toContain('global');
  });

  it('search returns {memory,...} results', async () => {
    await remember('search me by keyword pineapple', { scope: 'global' });
    const results = await getJson('/api/memories?scope=global&query=pineapple');
    expect(results[0].memory.content).toContain('pineapple');
  });
});

describe('update / forget / delete / link / unlink', () => {
  it('update patches content, forget expires, delete removes', async () => {
    const id = await remember('lifecycle target', { scope: 'project:/life' });
    expect((await post('/api/update', { id, content: 'patched', importance: 0.9 })).status).toBe(200);
    let list = await getJson('/api/memories?scope=' + encodeURIComponent('project:/life'));
    expect(list.find((m: any) => m.id === id)?.content).toBe('patched');

    await post('/api/forget', { id });
    list = await getJson('/api/memories?scope=' + encodeURIComponent('project:/life'));
    expect(list.find((m: any) => m.id === id)).toBeUndefined(); // expired drops from default list

    expect((await post('/api/delete', { id })).body.success).toBe(true);
  });

  it('link then unlink', async () => {
    const a = await remember('link A', { scope: 'project:/lnk' });
    const b = await remember('link B', { scope: 'project:/lnk' });
    await post('/api/link', { from_id: a, to_id: b, relation_type: 'relates-to' });
    let graph = await getJson('/api/graph?scope=' + encodeURIComponent('project:/lnk'));
    expect(graph.edges.length).toBe(1);
    const un = await post('/api/unlink', { from_id: a, to_id: b });
    expect(un.body.count).toBe(1);
    graph = await getJson('/api/graph?scope=' + encodeURIComponent('project:/lnk'));
    expect(graph.edges.length).toBe(0);
  });
});

describe('GET /api/graph', () => {
  it('scopes nodes and never ships the embedding BLOB', async () => {
    const id = await remember('graph node with vector', { scope: 'project:/g' });
    // Give it an embedding directly; the API must strip it from responses.
    store.setEmbedding(id, Buffer.from(new Float32Array([1, 2, 3]).buffer));
    const graph = await getJson('/api/graph?scope=' + encodeURIComponent('project:/g'));
    const node = graph.nodes.find((n: any) => n.id === id);
    expect(node).toBeTruthy();
    expect('embedding' in node).toBe(false);
  });
});

describe('POST /api/reindex-embeddings', () => {
  it('is a safe no-op with no provider configured', async () => {
    const r = await post('/api/reindex-embeddings', {});
    expect(r.body).toEqual({ provider: 'none', cleared: 0, embedded: 0 });
  });
});

describe('citation feedback (reranker training signal)', () => {
  it('logs cited sources as positives and shown-but-uncited ones as negatives', () => {
    const a = store.create({ content: 'cited first', scope: 'global' });
    const b = store.create({ content: 'never cited', scope: 'global' });
    const c = store.create({ content: 'cited second', scope: 'global' });
    recordCitationFeedback(store, 'which sources?', 'Per [1] and [3], yes [3]. [9] is out of range.',
      [{ memory: a }, { memory: b }, { memory: c }]);
    const rows = store.db.prepare(
      `SELECT memory_id, used FROM recall_feedback WHERE query = 'which sources?'`,
    ).all() as { memory_id: string; used: number }[];
    const byId = new Map(rows.map(r => [r.memory_id, r.used]));
    expect(byId.get(a.id)).toBe(1);
    expect(byId.get(b.id)).toBe(0); // impression: shown, not cited → true negative
    expect(byId.get(c.id)).toBe(1);
    expect(rows.length).toBe(3);
  });

  it('records nothing when the answer is null or cites no sources at all', () => {
    const m = store.create({ content: 'x', scope: 'global' });
    recordCitationFeedback(store, 'q-null', null, [{ memory: m }]);
    recordCitationFeedback(store, 'q-uncited', 'No stored memory answers that.', [{ memory: m }]);
    const n = store.db.prepare(
      `SELECT COUNT(*) AS n FROM recall_feedback WHERE query IN ('q-null','q-uncited')`,
    ).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('POST /api/chat with no LLM returns null message and records no feedback', async () => {
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'anything at all' }] });
    expect(r.status).toBe(200);
    expect(r.body.message).toBeNull();
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM recall_feedback`).get() as { n: number };
    // Only the rows inserted by the direct unit tests above (2 cited + 1 impression).
    expect(n.n).toBe(3);
  });
});

describe('ML observability endpoints', () => {
  it('GET /api/ml-status reports models and training-data counts', async () => {
    const s = await getJson('/api/ml-status');
    expect(Object.keys(s.models).sort()).toEqual(['prescreenNrem', 'prescreenReconcile', 'reranker', 'typeClassifier']);
    expect(typeof s.trainingData.feedbackUsed).toBe('number');
    expect(typeof s.trainingData.feedbackSkipped).toBe('number');
    expect(s.llm).toHaveProperty('consolidationModel');
    expect(s.llm).toHaveProperty('reconcileModel');
    expect(typeof s.llm.lastDreamFallbacks).toBe('number');
  });

  it('POST /api/eval runs the retrieval eval (empty ground truth → 0 queries)', async () => {
    // recall_feedback rows exist from the citation tests, but chat feedback
    // memories may be deleted by then; either way the endpoint returns a report.
    const r = await post('/api/eval', {});
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('queries');
    expect(r.body).toHaveProperty('bm25');
    expect(r.body).toHaveProperty('reranked');
  });
});

describe('unknown routes', () => {
  it('404s an unknown /api path', async () => {
    const r = await fetch(base + '/api/nope');
    expect(r.status).toBe(404);
  });
});

describe('citation feedback decision-time snapshots', () => {
  it('persists features, rank, and fused score when retrieval context is supplied', () => {
    const a = store.create({ content: 'snap cited', scope: 'global', importance: 0.8 });
    const b = store.create({ content: 'snap shown only', scope: 'global', importance: 0.2 });
    const retrieval = new Map([
      [a.id, { bm25: 3, cosine: 0.7, score: 0.04 }],
      [b.id, { bm25: 1, cosine: 0.1, score: 0.02 }],
    ]);
    const degrees = new Map([[a.id, { support: 4, conflict: 1 }]]);
    recordCitationFeedback(store, 'snapshot query?', 'Yes, per [1].',
      [{ memory: a }, { memory: b }], retrieval, degrees);

    const rows = store.db.prepare(
      `SELECT memory_id, features, rank, fused_score, used FROM recall_feedback WHERE query = 'snapshot query?' ORDER BY rank`,
    ).all() as { memory_id: string; features: string | null; rank: number; fused_score: number; used: number }[];
    expect(rows).toHaveLength(2);

    expect(rows[0].memory_id).toBe(a.id);
    expect(rows[0].used).toBe(1);
    expect(rows[0].rank).toBe(1);
    expect(rows[0].fused_score).toBeCloseTo(0.04);
    const fa = JSON.parse(rows[0].features!);
    expect(fa).toHaveLength(10);
    expect(fa[0]).toBeCloseTo(3 / 4);   // squashed bm25
    expect(fa[1]).toBeCloseTo(0.7);     // cosine
    expect(fa[2]).toBeCloseTo(0.8);     // importance at decision time
    expect(fa[7]).toBeCloseTo(0.4);     // support degree 4 / 10
    expect(fa[8]).toBeCloseTo(0.2);     // conflict degree 1 / 5
    expect(fa[9]).toBe(1);              // confidence — unchallenged default

    expect(rows[1].memory_id).toBe(b.id);
    expect(rows[1].used).toBe(0);       // impression, with its own snapshot
    expect(rows[1].rank).toBe(2);
    const fb = JSON.parse(rows[1].features!);
    expect(fb[7]).toBe(0);              // absent from degree map → 0
  });

  it('conflict partners outside the retrieval map still get a snapshot with zero scores', () => {
    const shown = store.create({ content: 'partner pulled by expandConflicts', scope: 'global', importance: 0.6 });
    const cited = store.create({ content: 'the retrieved one', scope: 'global' });
    const retrieval = new Map([[cited.id, { bm25: 2, cosine: 0.5, score: 0.03 }]]);
    recordCitationFeedback(store, 'partner query?', 'See [1].',
      [{ memory: cited }, { memory: shown }], retrieval, new Map());

    const row = store.db.prepare(
      `SELECT features FROM recall_feedback WHERE query = 'partner query?' AND memory_id = ?`,
    ).get(shown.id) as { features: string | null };
    const f = JSON.parse(row.features!);
    expect(f[0]).toBe(0); // bm25 unknown → 0: retrieval genuinely didn't surface it
    expect(f[1]).toBe(0);
    expect(f[2]).toBeCloseTo(0.6); // but memory-side attributes are still captured
  });
});

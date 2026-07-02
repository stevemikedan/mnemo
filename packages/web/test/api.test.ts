import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'http';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryStore, GraphStore } from '@mnemo/core';
import { createApiHandler } from '../src-server/api.js';

// Drives the real /api/* handler over a live HTTP server against a :memory:
// store, so routing, body parsing, scope filtering, and serialization are all
// exercised end-to-end.

let server: Server;
let base: string;
let store: MemoryStore;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mnemo-web-'));
  writeFileSync(join(tmp, 'config.json'), JSON.stringify({ embeddings: { provider: 'none' } }));
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

describe('unknown routes', () => {
  it('404s an unknown /api path', async () => {
    const r = await fetch(base + '/api/nope');
    expect(r.status).toBe(404);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from '../src/server.js';

// Exercises the real MCP protocol (tool registration + zod validation + handler
// wiring) end-to-end over an in-memory transport, against a :memory: store.

let client: Client;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mnemo-mcp-'));
  writeFileSync(join(tmp, 'config.json'), JSON.stringify({
    consolidation: { provider: 'none' },
    embeddings: { provider: 'none' },
  }));
  process.env.MNEMO_CONFIG_PATH = join(tmp, 'config.json');

  const server = await createServer(':memory:');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const textOf = (r: any) => (r.content as any[]).map(c => c.text).join('\n');
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

async function remember(content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await call('remember', { content, ...extra });
  const id = textOf(r).match(/Stored memory (\S+)/)?.[1];
  expect(id).toBeTruthy();
  return id!;
}

describe('MCP tool surface', () => {
  it('registers the full tool set', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'consolidate_session', 'delete_memory', 'dream', 'forget', 'get_dream_log',
      'get_memory', 'get_status', 'link', 'list_memories', 'list_scopes',
      'recall', 'reindex_embeddings', 'remember', 'unlink', 'update',
    ]);
  });
});

describe('remember / recall / list / status', () => {
  it('stores and then finds a memory by keyword', async () => {
    await remember('the build uses pnpm workspaces', { scope: 'global', tags: ['build'] });
    const list = textOf(await call('list_memories', { scope: 'global' }));
    expect(list).toContain('pnpm workspaces');
    const recalled = textOf(await call('recall', { query: 'pnpm', scope: 'global' }));
    expect(recalled).toContain('pnpm workspaces');
  });

  it('reports status and scopes', async () => {
    await remember('scoped note', { scope: 'project:/proj' });
    const status = textOf(await call('get_status'));
    expect(status).toContain('Total memories:');
    const scopes = textOf(await call('list_scopes'));
    expect(scopes).toContain('project:/proj');
    expect(scopes).toContain('global');
  });
});

describe('update / forget / delete', () => {
  it('update changes content and type, visible via get_memory', async () => {
    const id = await remember('original text', { type: 'project' });
    await call('update', { memory_id: id, content: 'updated text', type: 'feedback' });
    const got = textOf(await call('get_memory', { memory_id: id }));
    expect(got).toContain('updated text');
    expect(got).toContain('feedback');
  });

  it('forget expires a memory so it drops out of the default list', async () => {
    const id = await remember('forget me', { scope: 'project:/forget' });
    await call('forget', { memory_id: id });
    const list = textOf(await call('list_memories', { scope: 'project:/forget' }));
    expect(list).not.toContain('forget me');
  });

  it('delete_memory removes it entirely', async () => {
    const id = await remember('delete me', { scope: 'project:/del' });
    await call('delete_memory', { memory_id: id });
    const got = textOf(await call('get_memory', { memory_id: id }));
    expect(got).toContain('not found');
  });

  it('get_memory reports not found for an unknown id', async () => {
    const got = textOf(await call('get_memory', { memory_id: 'does-not-exist' }));
    expect(got).toContain('not found');
  });
});

describe('link / unlink', () => {
  it('links two memories and then removes the link', async () => {
    const a = await remember('memory A for linking', { scope: 'project:/link' });
    const b = await remember('memory B for linking', { scope: 'project:/link' });
    await call('link', { from_id: a, to_id: b, relation_type: 'relates-to' });
    expect(textOf(await call('get_memory', { memory_id: a }))).toContain(b);
    const unlinked = textOf(await call('unlink', { from_id: a, to_id: b }));
    expect(unlinked).toMatch(/Removed 1 edge/);
    expect(textOf(await call('get_memory', { memory_id: a }))).not.toContain('Graph connections');
  });
});

describe('input validation', () => {
  it('rejects an invalid remember call (missing content)', async () => {
    let errored = false;
    try {
      const r: any = await call('remember', {});
      errored = !!r?.isError;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
  });

  it('rejects out-of-range importance', async () => {
    let errored = false;
    try {
      const r: any = await call('remember', { content: 'x', importance: 5 });
      errored = !!r?.isError;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
  });
});

describe('reindex_embeddings with no provider', () => {
  it('is a safe no-op', async () => {
    const r = textOf(await call('reindex_embeddings'));
    expect(r).toContain('No embedding provider configured');
  });
});

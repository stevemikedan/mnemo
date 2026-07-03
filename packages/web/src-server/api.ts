import type { ViteDevServer } from 'vite';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { MemoryStore, GraphStore, dream, searchHybrid, readConfig, reloadConfig, reindexEmbeddings, answerFromMemories } from '@mnemo/core';
import type { MemoryType, EdgeType, MemoryState } from '@mnemo/core';

/** Drop the vector BLOB before serializing a memory to the client. */
function stripEmb(m: any): any {
  const { embedding, ...rest } = m;
  return rest;
}

// Helper to parse JSON body from Node.js IncomingMessage
function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: any) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err: any) => reject(err));
  });
}

/**
 * Build the /api/* request handler over a given store. Exported so it can be
 * driven directly in tests (and reused by the Vite plugin below).
 */
export function createApiHandler(store: MemoryStore, graph: GraphStore) {
  return async (req: any, res: any, next: () => void) => {
        // Only handle requests targeting /api/*
        if (!req.url || !req.url.startsWith('/api/')) {
          return next();
        }

        res.setHeader('Content-Type', 'application/json');
        // Enable CORS for local development
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.statusCode = 200;
          res.end();
          return;
        }

        try {
          const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const path = url.pathname;

          // GET /api/status - Get database statistics + embedding status
          if (req.method === 'GET' && path === '/api/status') {
            const status = store.getStatus();
            const provider = readConfig().embeddings?.provider ?? 'none';
            const encoded = (store.db.prepare('SELECT COUNT(*) n FROM memories WHERE embedding IS NOT NULL').get() as { n: number }).n;
            res.statusCode = 200;
            res.end(JSON.stringify({ ...status, embeddings: { provider, encoded } }));
            return;
          }

          // GET /api/config - current config (API key redacted)
          if (req.method === 'GET' && path === '/api/config') {
            const cfg = readConfig();
            res.statusCode = 200;
            res.end(JSON.stringify({
              embeddings: {
                provider: cfg.embeddings?.provider ?? 'none',
                model: cfg.embeddings?.model ?? '',
                baseUrl: cfg.embeddings?.baseUrl ?? '',
              },
              consolidation: {
                provider: cfg.consolidation?.provider ?? 'none',
                model: cfg.consolidation?.model ?? '',
                hasApiKey: !!cfg.consolidation?.apiKey,
              },
            }));
            return;
          }

          // GET /api/scopes - Get all unique project scopes in the database
          if (req.method === 'GET' && path === '/api/scopes') {
            const rows = store.db.prepare(`
              SELECT DISTINCT scope FROM memories
              ORDER BY scope ASC
            `).all() as { scope: string }[];
            const scopes = rows.map(r => r.scope);
            res.statusCode = 200;
            res.end(JSON.stringify(scopes));
            return;
          }

          // GET /api/memories - Get list or search memories
          if (req.method === 'GET' && path === '/api/memories') {
            const query = url.searchParams.get('query') || '';
            const scope = url.searchParams.get('scope') || undefined;
            const typesStr = url.searchParams.get('types');
            const statesStr = url.searchParams.get('states');
            const tagsStr = url.searchParams.get('tags');
            const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;

            const types = typesStr ? (typesStr.split(',') as MemoryType[]) : undefined;
            const states = statesStr ? (statesStr.split(',') as MemoryState[]) : undefined;
            const tags = tagsStr ? tagsStr.split(',') : undefined;

            // Scope filtering: 'all' (or empty) applies no scope restriction;
            // any other value is an exact-match against the stored scope string
            // (e.g. 'global' or 'project:/abs/path'). This is deliberately NOT
            // store.query()'s cwd-prefix resolution, which expects a raw working
            // directory rather than a full 'project:'-prefixed scope.
            const scopeFilter = (!scope || scope === 'all') ? undefined : scope;

            const activeStates = states || ['active', 'dormant'];
            const stateList = activeStates.map(() => '?').join(',');
            const queryParams: any[] = [...activeStates];

            let sql = `SELECT * FROM memories WHERE state IN (${stateList})`;
            if (scopeFilter) {
              sql += ` AND scope = ?`;
              queryParams.push(scopeFilter);
            }
            if (types && types.length > 0) {
              const typeList = types.map(() => '?').join(',');
              sql += ` AND type IN (${typeList})`;
              queryParams.push(...types);
            }

            sql += ` ORDER BY importance DESC, created_at DESC`;

            const rows = store.db.prepare(sql).all(...queryParams) as any[];
            // Keep the embedding BLOB here for hybrid ranking; strip it only
            // when serializing to the client (via stripEmb).
            let parsed = rows.map(r => ({
              ...r,
              tags: JSON.parse(r.tags),
              metadata: JSON.parse(r.metadata)
            }));

            if (tags && tags.length > 0) {
              parsed = parsed.filter(m => tags.some(t => m.tags.includes(t)));
            }

            if (query) {
              // Hybrid search (BM25 + vector cosine) over the scoped candidates.
              // Falls back to pure BM25 when no embedding provider is configured.
              const top = await searchHybrid(parsed, query, limit || 20);

              // Expand graph neighbors
              const formattedResults = await Promise.all(top.map(async r => {
                const neighbors = graph.getNeighbors(r.memory.id, 1);
                const related = neighbors
                  .map(n => store.get(n.id))
                  .filter((m): m is any => m != null)
                  .slice(0, 3)
                  .map(stripEmb);
                return { memory: stripEmb(r.memory), score: r.score, related };
              }));

              res.statusCode = 200;
              res.end(JSON.stringify(formattedResults));
            } else {
              if (limit) {
                parsed = parsed.slice(0, limit);
              }
              res.statusCode = 200;
              res.end(JSON.stringify(parsed.map(stripEmb)));
            }
            return;
          }

          // GET /api/graph - Get nodes (memories) and edges, optionally scoped.
          // ?scope=all (or omitted) returns everything; otherwise only nodes in
          // that exact scope and the edges whose both endpoints are in it, so
          // the graph reflects a single project instead of every project at once.
          if (req.method === 'GET' && path === '/api/graph') {
            const scope = url.searchParams.get('scope');
            const scopeFilter = (!scope || scope === 'all') ? undefined : scope;

            const nodes = store.db.prepare('SELECT * FROM memories').all() as any[];
            let parsedNodes = nodes.map(n => ({
              ...n,
              embedding: undefined, // never ship the vector BLOB to the client
              tags: JSON.parse(n.tags),
              metadata: JSON.parse(n.metadata),
            }));
            if (scopeFilter) {
              parsedNodes = parsedNodes.filter(n => n.scope === scopeFilter);
            }

            let edges = store.db.prepare('SELECT * FROM memory_edges').all() as any[];
            if (scopeFilter) {
              const nodeIds = new Set(parsedNodes.map(n => n.id));
              edges = edges.filter(e => nodeIds.has(e.from_id) && nodeIds.has(e.to_id));
            }

            res.statusCode = 200;
            res.end(JSON.stringify({ nodes: parsedNodes, edges }));
            return;
          }

          // GET /api/dream-log - Get consolidation logs
          if (req.method === 'GET' && path === '/api/dream-log') {
            const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 10;
            const logs = store.db.prepare(`
              SELECT * FROM consolidation_log
              ORDER BY started_at DESC
              LIMIT ?
            `).all(limit) as any[];

            const parsedLogs = logs.map(l => ({
              ...l,
              stats: JSON.parse(l.stats)
            }));

            res.statusCode = 200;
            res.end(JSON.stringify(parsedLogs));
            return;
          }

          // POST requests
          if (req.method === 'POST') {
            const body = await parseBody(req);

            if (path === '/api/remember') {
              const memory = store.create({
                content: body.content,
                type: body.type as MemoryType,
                scope: body.scope || 'global',
                tags: body.tags || [],
                importance: typeof body.importance === 'number' ? body.importance : 0.5,
                source: body.source || 'user'
              });
              res.statusCode = 201;
              res.end(JSON.stringify(memory));
              return;
            }

            if (path === '/api/update') {
              const { id, ...patch } = body;
              if (!id) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing memory ID' }));
                return;
              }
              const success = store.update(id, patch);
              res.statusCode = success ? 200 : 404;
              res.end(JSON.stringify({ success }));
              return;
            }

            if (path === '/api/forget') {
              const { id } = body;
              if (!id) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing memory ID' }));
                return;
              }
              const success = store.update(id, { state: 'expired' });
              res.statusCode = success ? 200 : 404;
              res.end(JSON.stringify({ success }));
              return;
            }

            if (path === '/api/delete') {
              const { id } = body;
              if (!id) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing memory ID' }));
                return;
              }
              const result = store.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
              res.statusCode = result.changes > 0 ? 200 : 404;
              res.end(JSON.stringify({ success: result.changes > 0 }));
              return;
            }

            if (path === '/api/link') {
              const { from_id, to_id, relation_type, weight } = body;
              if (!from_id || !to_id || !relation_type) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing from_id, to_id, or relation_type' }));
                return;
              }
              const edge = graph.addEdge(from_id, to_id, relation_type as EdgeType, weight ?? 1.0);
              res.statusCode = 201;
              res.end(JSON.stringify(edge));
              return;
            }

            if (path === '/api/unlink') {
              const { from_id, to_id } = body;
              if (!from_id || !to_id) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing from_id or to_id' }));
                return;
              }
              const result = store.db.prepare(`
                DELETE FROM memory_edges
                WHERE (from_id = ? AND to_id = ?)
                   OR (from_id = ? AND to_id = ?)
              `).run(from_id, to_id, to_id, from_id);
              res.statusCode = 200;
              res.end(JSON.stringify({ success: result.changes > 0, count: result.changes }));
              return;
            }

            if (path === '/api/dream') {
              const stats = await dream(store, graph, {
                scope: body.scope,
                cwd: body.cwd
              });
              res.statusCode = 200;
              res.end(JSON.stringify(stats));
              return;
            }

            if (path === '/api/reindex-embeddings') {
              const result = await reindexEmbeddings(store);
              res.statusCode = 200;
              res.end(JSON.stringify(result));
              return;
            }

            // POST /api/config - write config.json and apply live (no restart)
            if (path === '/api/config') {
              const current = readConfig();
              const next: any = {
                ...current,
                embeddings: { ...current.embeddings, ...(body.embeddings || {}) },
                consolidation: { ...current.consolidation, ...(body.consolidation || {}) },
              };
              // Preserve an existing key if the UI left the field blank.
              if (!body.consolidation || body.consolidation.apiKey === undefined || body.consolidation.apiKey === '') {
                if (current.consolidation?.apiKey) next.consolidation.apiKey = current.consolidation.apiKey;
                else delete next.consolidation.apiKey;
              }
              // Drop empty optional fields for a clean file.
              for (const section of ['embeddings', 'consolidation'] as const) {
                for (const k of Object.keys(next[section])) {
                  if (next[section][k] === '' || next[section][k] === undefined) delete next[section][k];
                }
              }
              mkdirSync(join(homedir(), '.mnemo'), { recursive: true });
              writeFileSync(join(homedir(), '.mnemo', 'config.json'), JSON.stringify(next, null, 2));
              reloadConfig();
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true }));
              return;
            }

            // POST /api/ask - retrieve (scoped, hybrid) + synthesize a plain-language answer
            if (path === '/api/ask') {
              const query = (body.query || '').trim();
              const scope = body.scope;
              if (!query) {
                res.statusCode = 200;
                res.end(JSON.stringify({ answer: null, sources: [] }));
                return;
              }
              const scopeFilter = (!scope || scope === 'all') ? undefined : scope;
              let sql = `SELECT * FROM memories WHERE state IN ('active','dormant')`;
              const qp: any[] = [];
              if (scopeFilter) { sql += ' AND scope = ?'; qp.push(scopeFilter); }
              const rows = store.db.prepare(sql).all(...qp) as any[];
              const parsed = rows.map(r => ({ ...r, tags: JSON.parse(r.tags), metadata: JSON.parse(r.metadata) }));
              const top = await searchHybrid(parsed, query, 6);
              const answer = await answerFromMemories(query, top.map(t => t.memory));
              res.statusCode = 200;
              res.end(JSON.stringify({ answer, sources: top.map(t => stripEmb(t.memory)) }));
              return;
            }
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ error: `Not Found: ${req.method} ${path}` }));
        } catch (err: any) {
          console.error('[API Error]', err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
        }
  };
}

export function apiPlugin() {
  return {
    name: 'mnemo-api',
    configureServer(server: ViteDevServer) {
      const store = new MemoryStore(process.env.MNEMO_DB_PATH);
      const graph = new GraphStore(store.db);
      server.middlewares.use(createApiHandler(store, graph));
    },
  };
}

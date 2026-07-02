import type { ViteDevServer } from 'vite';
import { MemoryStore, GraphStore, dream, BM25Index } from '@mnemo/core';
import type { MemoryType, EdgeType, MemoryState } from '@mnemo/core';

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

export function apiPlugin() {
  return {
    name: 'mnemo-api',
    configureServer(server: ViteDevServer) {
      // Connect to SQLite store
      const store = new MemoryStore(process.env.MNEMO_DB_PATH);
      const graph = new GraphStore(store.db);

      server.middlewares.use(async (req, res, next) => {
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

          // GET /api/status - Get database statistics
          if (req.method === 'GET' && path === '/api/status') {
            const status = store.getStatus();
            res.statusCode = 200;
            res.end(JSON.stringify(status));
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
            let parsed = rows.map(r => ({
              ...r,
              tags: JSON.parse(r.tags),
              metadata: JSON.parse(r.metadata)
            }));

            if (tags && tags.length > 0) {
              parsed = parsed.filter(m => tags.some(t => m.tags.includes(t)));
            }

            if (query) {
              // Search within the current scope selection using BM25
              const index = new BM25Index();
              index.build(parsed);

              let results = index.search(query, 50);
              results = results.map(r => ({
                ...r,
                score: r.score * (0.5 + r.memory.importance * 0.5),
              }));

              const top = results.slice(0, limit || 20);

              // Expand graph neighbors
              const formattedResults = await Promise.all(top.map(async r => {
                const neighbors = graph.getNeighbors(r.memory.id, 1);
                const related = neighbors
                  .map(n => store.get(n.id))
                  .filter((m): m is any => m != null)
                  .slice(0, 3);
                return { memory: r.memory, score: r.score, related };
              }));

              res.statusCode = 200;
              res.end(JSON.stringify(formattedResults));
            } else {
              if (limit) {
                parsed = parsed.slice(0, limit);
              }
              res.statusCode = 200;
              res.end(JSON.stringify(parsed));
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
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ error: `Not Found: ${req.method} ${path}` }));
        } catch (err: any) {
          console.error('[API Error]', err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
        }
      });
    }
  };
}

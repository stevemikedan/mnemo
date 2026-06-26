import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePath = pathToFileURL(join(__dirname, '..', 'packages', 'core', 'dist', 'public.js')).href;

const { MemoryStore, GraphStore, dream } = await import(corePath);

const store = new MemoryStore();
const graph = new GraphStore(store.db);

const MNEMO = 'project:C:\\Users\\steve\\dev\\mnemo';
const NDX   = 'project:C:\\Users\\steve\\dev\\n-dx';

const memories = [
  {
    content: "I prefer vendor-agnostic solutions that work with any LLM, not just Claude — avoid tying tooling to a single provider.",
    type: 'user', scope: 'global', importance: 0.85, tags: ['preference', 'vendor-agnostic'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "mnemo is at C:\\Users\\steve\\dev\\mnemo — vendor-agnostic AI memory MCP server. pnpm monorepo with @mnemo/core (SQLite+BM25+consolidation) and @mnemo/mcp-server (stdio). DB at ~/.mnemo/memory.db.",
    type: 'project', scope: MNEMO, importance: 0.9, tags: ['architecture', 'overview'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "mnemo Phase 1 (SQLite store + BM25 + 10 MCP tools) and Phase 2 (NREM dedup + REM cross-linking consolidation) are complete and committed. Phase 3 = Ollama embeddings + semantic reranking. Phase 4 = HTTP transport + CLI.",
    type: 'project', scope: MNEMO, importance: 0.8, tags: ['roadmap', 'phases'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "mnemo registered as user-scoped MCP in Claude Code (~/.claude.json), available in all sessions. MCP tools: remember, forget, link, recall, get_memory, list_memories, get_status, dream, consolidate_session, get_dream_log.",
    type: 'reference', scope: MNEMO, importance: 0.85, tags: ['mcp', 'registration', 'tools'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "mnemo slash commands installed at ~/.claude/commands/: /dream (consolidate), /remember (store), /recall (search). Active in all Claude Code sessions.",
    type: 'reference', scope: MNEMO, importance: 0.75, tags: ['commands', 'claude-code'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "mnemo consolidation LLM auto-detects ANTHROPIC_API_KEY, uses claude-haiku-4-5-20251001 for NREM adjudication by default. Falls back to word-overlap heuristics (no LLM) when key absent. Config overrides at ~/.mnemo/config.json.",
    type: 'project', scope: MNEMO, importance: 0.75, tags: ['consolidation', 'llm', 'config'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "mnemo Stop hook lives at scripts/stop-hook.js. Configure in Claude Code settings.json under hooks.Stop to auto-extract memory signals at session end.",
    type: 'reference', scope: MNEMO, importance: 0.7, tags: ['hooks', 'automation'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "tsconfig.base.json must NOT set outDir — it resolves relative to the base file (repo root). Every package must declare outDir: 'dist' in its own tsconfig.json.",
    type: 'feedback', scope: MNEMO, importance: 0.8, tags: ['typescript', 'build', 'gotcha'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "better-sqlite3 requires native bindings — add it to pnpm.onlyBuiltDependencies in root package.json or pnpm skips its build and it won't load.",
    type: 'feedback', scope: MNEMO, importance: 0.8, tags: ['pnpm', 'better-sqlite3', 'native'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "@modelcontextprotocol/sdk v1.29.0 requires zod v4 as a peer dep — add zod: '^4.0.0' explicitly to mcp-server/package.json.",
    type: 'feedback', scope: MNEMO, importance: 0.75, tags: ['mcp-sdk', 'zod', 'dependencies'],
    source: 'session:mnemo-build-2026-06-24',
  },
  {
    content: "n-dx GitHub issues created 2026-06-24: #272 smart context injection for hench agents (composable sourcevision briefs), #273 auto-sync sourcevision after hench task completion, #274 architecture-awareness RFC catalog (13 improvements).",
    type: 'reference', scope: NDX, importance: 0.75, tags: ['issues', 'github', 'hench', 'sourcevision'],
    source: 'session:mnemo-build-2026-06-24',
  },
];

for (const m of memories) {
  store.create(m);
}
console.log(`Saved ${memories.length} memories.`);

const stats = await dream(store, graph, { cwd: 'C:\\Users\\steve\\dev\\mnemo' });
console.log('Dream stats:', JSON.stringify(stats, null, 2));
store.close();

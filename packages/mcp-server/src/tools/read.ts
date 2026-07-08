import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { answerFromMemories } from '@mnemo/core';
import type { MemoryStore } from '@mnemo/core';
import type { GraphStore } from '@mnemo/core';
import type { RecallEngine } from '@mnemo/core';
import type { MemoryType, MemoryState } from '@mnemo/core';

function formatMemory(m: { id: string; content: string; type: string; scope: string; importance: number; tags: string[]; created_at: string }, score?: number): string {
  const scoreStr = score !== undefined ? ` [score: ${score.toFixed(3)}]` : '';
  return `**[${m.id}]**${scoreStr} *(${m.type}, ${m.scope})*\n${m.content}\nTags: ${m.tags.join(', ') || 'none'} | Importance: ${m.importance} | Created: ${m.created_at}`;
}

export function registerReadTools(server: McpServer, store: MemoryStore, graph: GraphStore, recall: RecallEngine): void {
  server.registerTool('recall', {
    description: 'Search memories using BM25 keyword search with scope filtering. Returns ranked results.',
    inputSchema: z.object({
      query: z.string().describe('Search query (BM25 keyword search)'),
      scope: z.string().optional().describe('Your project scope (e.g. project:/path/to/repo). Returns global memories plus that project\'s. Omit to search across all scopes.'),
      cwd: z.string().optional().describe('Current working directory (absolute path) — resolves to global + any ancestor project scope. Alternative to passing scope.'),
      types: z.array(z.enum(['user', 'feedback', 'project', 'reference', 'episodic', 'semantic'])).optional(),
      tags: z.array(z.string()).optional().describe('Only include memories carrying at least one of these tags.'),
      states: z.array(z.enum(['active', 'dormant', 'archived', 'expired'])).optional().describe('Memory states to include. Defaults to active + dormant.'),
      min_importance: z.number().min(0).max(1).optional().describe('Drop memories below this importance.'),
      limit: z.number().int().min(1).max(50).optional().default(10),
      include_related: z.boolean().optional().default(false),
    }),
  }, async ({ query, scope, cwd, types, tags, states, min_importance, limit, include_related }) => {
    const results = await recall.recall({
      query,
      scope,
      cwd,
      types: types as MemoryType[] | undefined,
      tags,
      states: states as MemoryState[] | undefined,
      minImportance: min_importance,
      limit,
      includeRelated: include_related,
    });

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memories found matching your query.' }] };
    }

    const lines = results.map(r => {
      let text = formatMemory(r.memory, r.score);
      if (r.related?.length) {
        text += `\n  Related: ${r.related.map(rm => `[${rm.id}] ${rm.content.slice(0, 60)}...`).join('; ')}`;
      }
      return text;
    });

    return {
      content: [{ type: 'text' as const, text: `Found ${results.length} memories:\n\n${lines.join('\n\n---\n\n')}` }],
    };
  });

  server.registerTool('get_memory', {
    description: 'Retrieve a specific memory by ID, with its graph neighborhood.',
    inputSchema: z.object({
      memory_id: z.string(),
      depth: z.number().int().min(0).max(3).optional().default(1),
    }),
  }, async ({ memory_id, depth }) => {
    const memory = store.get(memory_id);
    if (!memory) {
      return { content: [{ type: 'text' as const, text: `Memory ${memory_id} not found.` }] };
    }
    const neighbors = graph.getNeighbors(memory_id, depth);
    const neighborMemories = neighbors
      .map(n => ({ neighbor: n, memory: store.get(n.id) }))
      .filter(n => n.memory != null);

    let text = formatMemory(memory);
    if (neighborMemories.length) {
      text += `\n\n**Graph connections (${depth}-hop):**\n`;
      text += neighborMemories.map(n => `- [${n.neighbor.direction}] ${n.neighbor.type}: ${formatMemory(n.memory!)}`).join('\n');
    }
    return { content: [{ type: 'text' as const, text }] };
  });

  server.registerTool('list_memories', {
    description: 'List memories with optional filters. No semantic ranking — use recall for search.',
    inputSchema: z.object({
      scope: z.string().optional().describe('Exact scope match, e.g. "global" or "project:/abs/path". Omit to list across all scopes.'),
      types: z.array(z.enum(['user', 'feedback', 'project', 'reference', 'episodic', 'semantic'])).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional().default(20),
    }),
  }, async ({ scope, types, tags, limit }) => {
    const memories = store.query({ scope, types: types as MemoryType[] | undefined, tags, limit });
    if (memories.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
    }
    const text = memories.map(m => formatMemory(m)).join('\n\n---\n\n');
    return { content: [{ type: 'text' as const, text: `${memories.length} memories:\n\n${text}` }] };
  });

  server.registerTool('get_status', {
    description: 'Get memory store statistics: counts by state, type, and scope.',
    inputSchema: z.object({}),
  }, async () => {
    const status = store.getStatus();
    const text = [
      `**Mnemo Memory Status**`,
      `Total memories: ${status.total}`,
      `By state: ${JSON.stringify(status.byState)}`,
      `By type: ${JSON.stringify(status.byType)}`,
      `Distinct scopes: ${status.byScope}`,
    ].join('\n');
    return { content: [{ type: 'text' as const, text }] };
  });

  server.registerTool('ask_memory', {
    description: 'Ask a plain-language question and get a short synthesized answer grounded ONLY in stored memories (with the sources). Needs a consolidation LLM configured; without one, falls back to returning the top matching memories.',
    inputSchema: z.object({
      question: z.string().describe('A natural-language question, e.g. "how do we deploy this project?"'),
      scope: z.string().optional().describe('Your project scope (e.g. project:/path). Searches global + that project. Omit for all scopes.'),
      cwd: z.string().optional().describe('Current working directory — alternative to scope.'),
    }),
  }, async ({ question, scope, cwd }) => {
    const hits = await recall.recall({ query: question, scope, cwd, limit: 6, includeRelated: false });
    if (hits.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No stored memories match that question.' }] };
    }
    const answer = await answerFromMemories(question, hits.map(h => h.memory));
    const sources = hits.map((h, i) => `[${i + 1}] (${h.memory.type}) ${h.memory.content.slice(0, 100)}`).join('\n');
    if (answer) {
      return { content: [{ type: 'text' as const, text: `${answer}\n\nSources:\n${sources}` }] };
    }
    // Fallback: no consolidation LLM — still useful, return the matches.
    return {
      content: [{ type: 'text' as const, text: `(No LLM configured for synthesis — top matching memories:)\n${sources}` }],
    };
  });

  server.registerTool('list_scopes', {
    description: 'List the distinct scopes present in the store (e.g. "global", "project:/abs/path"). Use these exact strings for the scope arguments of recall/list_memories/remember.',
    inputSchema: z.object({}),
  }, async () => {
    const scopes = store.listScopes();
    if (scopes.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No scopes yet — the store is empty.' }] };
    }
    return { content: [{ type: 'text' as const, text: `Scopes (${scopes.length}):\n${scopes.map(s => `- ${s}`).join('\n')}` }] };
  });
}

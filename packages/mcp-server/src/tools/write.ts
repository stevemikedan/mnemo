import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from '@mnemo/core';
import type { GraphStore } from '@mnemo/core';
import type { MemoryType, EdgeType } from '@mnemo/core';

export function registerWriteTools(server: McpServer, store: MemoryStore, graph: GraphStore): void {
  server.registerTool('remember', {
    description: 'Store a new memory. Use scope="global" for cross-project preferences, or scope="project:{abs_path}" for project-specific context.',
    inputSchema: z.object({
      content: z.string().describe('The memory content to store'),
      type: z.enum(['user', 'feedback', 'project', 'reference', 'episodic', 'semantic']).optional().default('project'),
      scope: z.string().optional().default('global').describe('global | project:{abs_path}'),
      tags: z.array(z.string()).optional().default([]),
      importance: z.number().min(0).max(1).optional().default(0.5),
    }),
  }, async ({ content, type, scope, tags, importance }) => {
    const memory = store.create({
      content,
      type: type as MemoryType,
      scope,
      tags,
      importance,
      source: 'user',
    });
    return {
      content: [{ type: 'text' as const, text: `Stored memory ${memory.id}\nContent: ${memory.content}\nScope: ${memory.scope}\nType: ${memory.type}` }],
    };
  });

  server.registerTool('forget', {
    description: 'Mark a memory as expired (soft delete).',
    inputSchema: z.object({
      memory_id: z.string().describe('The ID of the memory to expire'),
    }),
  }, async ({ memory_id }) => {
    const ok = store.update(memory_id, { state: 'expired' });
    return {
      content: [{ type: 'text' as const, text: ok ? `Memory ${memory_id} marked as expired.` : `Memory ${memory_id} not found.` }],
    };
  });

  server.registerTool('link', {
    description: 'Create an explicit relationship between two memories.',
    inputSchema: z.object({
      from_id: z.string(),
      to_id: z.string(),
      relation_type: z.enum(['relates-to', 'contradicts', 'supersedes', 'derived-from', 'co-occurred']).default('relates-to'),
      weight: z.number().min(0).max(1).optional().default(1.0),
    }),
  }, async ({ from_id, to_id, relation_type, weight }) => {
    const edge = graph.addEdge(from_id, to_id, relation_type as EdgeType, weight);
    return {
      content: [{ type: 'text' as const, text: `Linked ${from_id} → ${to_id} (${relation_type})` }],
    };
  });
}

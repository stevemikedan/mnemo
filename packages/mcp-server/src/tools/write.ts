import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readConfig, suggestType, suggestTags, findNearDuplicates } from '@mnemo/core';
import type { MemoryStore } from '@mnemo/core';
import type { GraphStore } from '@mnemo/core';
import type { MemoryType, EdgeType } from '@mnemo/core';

export function registerWriteTools(server: McpServer, store: MemoryStore, graph: GraphStore): void {
  server.registerTool('remember', {
    description: 'Store a new memory. Use scope="global" for cross-project preferences, or scope="project:{abs_path}" for project-specific context.',
    inputSchema: z.object({
      content: z.string().describe('The memory content to store'),
      type: z.enum(['user', 'feedback', 'project', 'reference', 'episodic', 'semantic']).optional().describe('Omit to let mnemo infer it (when ELM type suggestion is enabled); otherwise defaults to project.'),
      scope: z.string().optional().default('global').describe('global | project:{abs_path}'),
      tags: z.array(z.string()).optional().default([]),
      importance: z.number().min(0).max(1).optional().default(0.5),
      skip_if_duplicate: z.boolean().optional().default(false).describe('If a near-duplicate already exists in this scope, do not store; return the existing memory instead.'),
    }),
  }, async ({ content, type, scope, tags, importance, skip_if_duplicate }) => {
    let note = '';
    const metadata: Record<string, unknown> = {};

    // Near-duplicate check (warn-only unless skip_if_duplicate). Any failure in
    // the check must never block the write.
    try {
      const dups = await findNearDuplicates(store, content, scope);
      if (dups.length > 0) {
        const d = dups[0];
        const pct = Math.round(d.similarity * 100);
        if (skip_if_duplicate) {
          return {
            content: [{ type: 'text' as const, text: `Not stored — near-duplicate (${pct}% similar, ${d.basis}) of existing memory ${d.memory.id}:\n"${d.memory.content.slice(0, 120)}"\nUse \`update\` on it instead, or call remember without skip_if_duplicate to store anyway.` }],
          };
        }
        note += `\n⚠ Possible duplicate of ${d.memory.id} (${pct}% similar, ${d.basis}): "${d.memory.content.slice(0, 80)}" — consider \`update\`/\`delete_memory\` if redundant.`;
        metadata.possible_duplicate_of = d.memory.id;
      }
    } catch { /* dedup must never block a write */ }

    let finalType = type as MemoryType | undefined;
    if (!finalType) {
      const suggested = readConfig().ml?.typeSuggest?.enabled ? await suggestType(content) : null;
      if (suggested) {
        finalType = suggested.type;
        note += `\nType inferred as \`${suggested.type}\` (confidence ${suggested.confidence.toFixed(2)}, margin ${suggested.margin.toFixed(2)}) — pass \`type\` to override.`;
        metadata.type_suggested_by = 'elm';
        metadata.type_confidence = suggested.confidence;
      } else {
        finalType = 'project';
      }
    }

    let finalTags = tags;
    if (finalTags.length === 0) {
      try {
        const suggested = suggestTags(store, content);
        if (suggested.length > 0) {
          finalTags = suggested;
          note += `\nTags suggested: ${suggested.map(t => `#${t}`).join(' ')} — pass \`tags\` to override.`;
          metadata.tags_suggested_by = 'knn';
        }
      } catch { /* tag suggestion must never block a write */ }
    }

    const memory = store.create({
      content, type: finalType, scope, tags: finalTags, importance, source: 'user',
      metadata: Object.keys(metadata).length ? metadata : undefined,
    });
    return {
      content: [{ type: 'text' as const, text: `Stored memory ${memory.id}\nContent: ${memory.content}\nScope: ${memory.scope}\nType: ${memory.type}${note}` }],
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
    graph.addEdge(from_id, to_id, relation_type as EdgeType, weight);
    return {
      content: [{ type: 'text' as const, text: `Linked ${from_id} → ${to_id} (${relation_type})` }],
    };
  });

  server.registerTool('update', {
    description: 'Edit an existing memory. Only the fields you pass are changed; the rest are left as-is.',
    inputSchema: z.object({
      memory_id: z.string().describe('The ID of the memory to update'),
      content: z.string().optional(),
      type: z.enum(['user', 'feedback', 'project', 'reference', 'episodic', 'semantic']).optional(),
      scope: z.string().optional().describe('global | project:{abs_path}'),
      state: z.enum(['active', 'dormant', 'archived', 'expired']).optional(),
      importance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
    }),
  }, async ({ memory_id, content, type, scope, state, importance, tags }) => {
    const patch: Record<string, unknown> = {};
    if (content !== undefined) patch.content = content;
    if (type !== undefined) patch.type = type;
    if (scope !== undefined) patch.scope = scope;
    if (state !== undefined) patch.state = state;
    if (importance !== undefined) patch.importance = importance;
    if (tags !== undefined) patch.tags = tags;
    const ok = store.update(memory_id, patch as any);
    const changed = Object.keys(patch).join(', ') || 'nothing';
    return {
      content: [{ type: 'text' as const, text: ok ? `Updated memory ${memory_id} (${changed}).` : `Memory ${memory_id} not found, or no fields to update.` }],
    };
  });

  server.registerTool('unlink', {
    description: 'Remove the relationship(s) between two memories (in either direction).',
    inputSchema: z.object({
      from_id: z.string(),
      to_id: z.string(),
    }),
  }, async ({ from_id, to_id }) => {
    const n = graph.removeEdge(from_id, to_id);
    return {
      content: [{ type: 'text' as const, text: n > 0 ? `Removed ${n} edge(s) between ${from_id} and ${to_id}.` : `No edges found between ${from_id} and ${to_id}.` }],
    };
  });

  server.registerTool('record_use', {
    description: 'Record that a recalled memory was actually useful for a query — implicit feedback that will improve future ranking. Optional: call after you act on a specific recall result.',
    inputSchema: z.object({
      memory_id: z.string().describe('The memory that was used'),
      query: z.string().describe('The query/question it was used for'),
    }),
  }, async ({ memory_id, query }) => {
    store.recordFeedback(query, memory_id);
    return {
      content: [{ type: 'text' as const, text: `Recorded use of ${memory_id}.` }],
    };
  });

  server.registerTool('delete_memory', {
    description: 'Permanently delete a memory and its edges. Irreversible — prefer `forget` (soft delete) unless you truly want it gone.',
    inputSchema: z.object({
      memory_id: z.string().describe('The ID of the memory to permanently delete'),
    }),
  }, async ({ memory_id }) => {
    const ok = store.delete(memory_id);
    return {
      content: [{ type: 'text' as const, text: ok ? `Permanently deleted memory ${memory_id}.` : `Memory ${memory_id} not found.` }],
    };
  });
}

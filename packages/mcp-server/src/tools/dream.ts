import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from '@mnemo/core';
import type { GraphStore } from '@mnemo/core';
import { dream, consolidateSession, getDreamLog } from '@mnemo/core';

export function registerDreamTools(server: McpServer, store: MemoryStore, graph: GraphStore): void {
  server.registerTool('dream', {
    description: 'Run memory consolidation: NREM dedup (merge near-duplicates) + REM cross-linking. Call after a work session to keep the memory store healthy.',
    inputSchema: z.object({
      scope: z.string().optional().describe('Exact scope to consolidate, e.g. "project:/path/to/repo". Defaults to all active memories.'),
      cwd: z.string().optional().describe('Current working directory — used as project path for TiMem promotions'),
    }),
  }, async ({ scope, cwd }) => {
    const stats = await dream(store, graph, { scope, cwd });
    const lines = [
      '**Dream complete**',
      `- Memories processed: ${stats.total_processed}`,
      `- Merged (deduplicated): ${stats.merged}`,
      `- Left unchanged: ${stats.unchanged}`,
      `- Cross-links added: ${stats.linked}`,
      `- Promoted (TiMem): ${stats.promoted}`,
      `- Decayed → dormant/archived/expired: ${stats.decayed_dormant}/${stats.decayed_archived}/${stats.decayed_expired}`,
      `- Reactivated (reinforced): ${stats.reactivated}`,
      `- Superseded (newer overrides older): ${stats.superseded}`,
      `- Contradictions flagged: ${stats.contradicted}`,
      `- Duration: ${stats.duration_ms}ms`,
    ];
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });

  server.registerTool('consolidate_session', {
    description: 'Extract memories from a raw session transcript and integrate them into the store. Runs signal extraction (regex), saves new memories, then deduplicates against existing ones.',
    inputSchema: z.object({
      transcript: z.string().describe('Raw session transcript text to extract memories from'),
      session_id: z.string().describe('Unique session identifier'),
      project_path: z.string().optional().describe('Absolute path to the project directory — memories are scoped here. Omit for global scope.'),
    }),
  }, async ({ transcript, session_id, project_path }) => {
    const result = await consolidateSession(store, graph, transcript, session_id, project_path);
    const lines = [
      '**Session consolidated**',
      `- Signals extracted: ${result.extracted}`,
      `- New memories saved: ${result.saved}`,
      `- Merged with existing: ${result.merged}`,
    ];
    if (result.extracted === 0) {
      lines.push('\nNo memory signals detected. The transcript may not contain explicit preferences, decisions, or corrections.');
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });

  server.registerTool('get_dream_log', {
    description: 'List recent consolidation runs with stats (merged, linked, promoted, duration).',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional().default(10),
    }),
  }, async ({ limit }) => {
    const entries = getDreamLog(store, limit);
    if (entries.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No consolidation runs recorded yet. Use the `dream` tool to run consolidation.' }] };
    }
    const lines = entries.map(e => {
      const stats = Object.entries(e.stats).map(([k, v]) => `${k}: ${v}`).join(', ');
      return `**${e.started_at}** | scope: ${e.scope} | phase: ${e.phase}\n  ${stats}`;
    });
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
  });
}

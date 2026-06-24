import { v4 as uuidv4 } from 'uuid';
import type { MemoryStore } from '../graph/store.js';
import type { GraphStore } from '../graph/graph.js';
import { extractSignals } from './session.js';
import { runNREM } from './nrem.js';
import { runREM } from './rem.js';

export interface DreamOptions {
  /** Exact scope to consolidate, e.g. 'project:/path/to/repo' or 'global'. Defaults to all active memories. */
  scope?: string;
  /** Current working directory — used as project path for promotions */
  cwd?: string;
}

export interface DreamStats {
  merged: number;
  unchanged: number;
  linked: number;
  promoted: number;
  total_processed: number;
  duration_ms: number;
}

export interface ConsolidateSessionResult {
  extracted: number;
  merged: number;
  saved: number;
}

export async function dream(store: MemoryStore, graph: GraphStore, opts: DreamOptions = {}): Promise<DreamStats> {
  const startMs = Date.now();

  // Fetch memories to consolidate
  let memories = store.query({ states: ['active', 'dormant'] });
  if (opts.scope && opts.scope !== 'global') {
    // Filter to exact scope (e.g. just one project)
    memories = memories.filter(m => m.scope === opts.scope || m.scope === 'global');
  }

  const nrem = await runNREM(store, graph, memories);
  const rem = runREM(store, graph, memories, opts.cwd);

  const duration_ms = Date.now() - startMs;

  // Write to consolidation_log
  store.db.prepare(`
    INSERT INTO consolidation_log (id, scope, phase, started_at, finished_at, stats)
    VALUES (?, ?, 'full', ?, ?, ?)
  `).run(
    uuidv4(),
    opts.scope ?? 'all',
    new Date(Date.now() - duration_ms).toISOString(),
    new Date().toISOString(),
    JSON.stringify({ ...nrem, ...rem, duration_ms }),
  );

  return {
    merged: nrem.merged,
    unchanged: nrem.unchanged,
    linked: rem.linked,
    promoted: rem.promoted,
    total_processed: nrem.processed,
    duration_ms,
  };
}

export async function consolidateSession(
  store: MemoryStore,
  graph: GraphStore,
  transcript: string,
  sessionId: string,
  projectPath?: string,
): Promise<ConsolidateSessionResult> {
  const signals = extractSignals(transcript);
  if (signals.length === 0) return { extracted: 0, merged: 0, saved: 0 };

  const scope = projectPath ? `project:${projectPath}` : 'global';
  const sessionSource = `session:${sessionId}`;

  // Save new memories
  const saved: string[] = [];
  for (const signal of signals) {
    const mem = store.create({
      content: signal.content,
      type: signal.type,
      scope,
      tags: signal.tags,
      importance: signal.importance,
      source: sessionSource,
    });
    saved.push(mem.id);
  }

  // NREM: deduplicate the new memories against existing scope memories
  const existing = store.query({ cwd: projectPath ?? 'global', states: ['active', 'dormant'] });
  const newMems = saved.map(id => store.get(id)).filter((m): m is NonNullable<typeof m> => m !== null);
  const nrem = await runNREM(store, graph, [...existing.filter(m => !saved.includes(m.id)), ...newMems]);

  return {
    extracted: signals.length,
    merged: nrem.merged,
    saved: saved.length - nrem.merged,
  };
}

export function getDreamLog(store: MemoryStore, limit = 10): {
  id: string; scope: string; phase: string; started_at: string; finished_at: string | null; stats: Record<string, number>;
}[] {
  return (store.db.prepare(
    'SELECT * FROM consolidation_log ORDER BY started_at DESC LIMIT ?'
  ).all(limit) as { id: string; scope: string; phase: string; started_at: string; finished_at: string | null; stats: string }[])
    .map(r => ({ ...r, stats: JSON.parse(r.stats) as Record<string, number> }));
}

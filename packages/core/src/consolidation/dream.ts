import { v4 as uuidv4 } from 'uuid';
import type { MemoryStore } from '../graph/store.js';
import type { GraphStore } from '../graph/graph.js';
import { extractSignals } from './session.js';
import { runNREM, defaultMerge } from './nrem.js';
import { runREM } from './rem.js';
import { runDecay } from './decay.js';
import { runReconcile, llmAdjudicate } from './reconcile.js';
import { encodeForDream } from '../rag/embedding.js';
import { readConfig } from './config.js';
import { trainTypeClassifier } from '../ml/type-classifier.js';
import { pairFeatures } from '../ml/featurize.js';
import { logAdjudication } from '../ml/adjudication-log.js';

/** Is a consolidation LLM actually adjudicating (so its verdicts are worth logging)? */
function consolidationLlmActive(): boolean {
  const p = readConfig().consolidation?.provider ?? (process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : 'none');
  return p !== 'none';
}
function shouldLogAdjudications(): boolean {
  return consolidationLlmActive() && readConfig().ml?.prescreen?.logging !== false;
}

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
  /** Memories moved active→dormant this pass. */
  decayed_dormant: number;
  /** Memories moved to archived this pass. */
  decayed_archived: number;
  /** Memories expired by decay this pass. */
  decayed_expired: number;
  /** Memories promoted back up (reinforced) this pass. */
  reactivated: number;
  /** Newer-supersedes-older relationships found this pass. */
  superseded: number;
  /** Genuine contradictions found this pass. */
  contradicted: number;
  duration_ms: number;
}

export interface ConsolidateSessionResult {
  extracted: number;
  merged: number;
  saved: number;
}

export async function dream(store: MemoryStore, graph: GraphStore, opts: DreamOptions = {}): Promise<DreamStats> {
  const startMs = Date.now();

  // Fetch memories to consolidate — resolve CWD for scope-aware query
  const queryCwd = opts.cwd ?? opts.scope;
  let memories = store.query({ states: ['active', 'dormant'], cwd: queryCwd });
  // If an exact scope was requested, filter down further
  if (opts.scope && opts.scope !== 'global') {
    memories = memories.filter(m => m.scope === opts.scope || m.scope === 'global');
  }

  // Encode: compute embeddings (no-op unless an embedding provider is
  // configured). Done first so NREM/recall can use them.
  await encodeForDream(store, memories);

  // ML: (re)train the type classifier over the whole store — persists only if it
  // beats the naive baseline on held-out data. Off unless ml.typeSuggest.enabled.
  const typeReport = readConfig().ml?.typeSuggest?.enabled ? trainTypeClassifier(store) : undefined;

  // NREM with a logging wrapper — captures each MERGE/SKIP verdict + features as
  // pre-screener training data (only when an LLM is really adjudicating).
  const nrem = await runNREM(store, graph, memories, async (survivor, candidate) => {
    const verdict = await defaultMerge(survivor, candidate);
    if (shouldLogAdjudications()) {
      logAdjudication(store, { older_id: survivor.id, newer_id: candidate.id, scope: survivor.scope, phase: 'nrem', features: pairFeatures(survivor, candidate), verdict, source: 'llm' });
    }
    return verdict;
  });
  const rem = runREM(store, graph, memories, opts.cwd);
  // Decay/lifecycle over the same scope (active/dormant/archived). Runs after
  // dedup/linking so merges register as recent activity first.
  const decay = runDecay(store, { scope: opts.scope, cwd: queryCwd });

  // Reconcile: detect newer-supersedes-older and genuine contradictions among
  // same-scope memories. Re-query fresh (post NREM/decay) rather than reuse the
  // stale snapshot. LLM-gated — a no-op without a consolidation provider.
  let reconcileSet = store.query({ states: ['active', 'dormant'], cwd: queryCwd });
  if (opts.scope && opts.scope !== 'global') {
    reconcileSet = reconcileSet.filter(m => m.scope === opts.scope || m.scope === 'global');
  }
  const reconcile = await runReconcile(store, graph, reconcileSet, async (older, newer) => {
    const verdict = await llmAdjudicate(older, newer);
    if (shouldLogAdjudications()) {
      logAdjudication(store, { older_id: older.id, newer_id: newer.id, scope: older.scope, phase: 'reconcile', features: pairFeatures(older, newer), verdict, source: 'llm' });
    }
    return verdict;
  });

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
    JSON.stringify({
      ...nrem, ...rem, ...decay, ...reconcile,
      ...(typeReport ? { type_model_trained: typeReport.trained ? 1 : 0, type_model_accuracy: Math.round((typeReport.accuracy ?? 0) * 100) / 100 } : {}),
      duration_ms,
    }),
  );

  return {
    merged: nrem.merged,
    unchanged: nrem.unchanged,
    linked: rem.linked,
    promoted: rem.promoted,
    total_processed: nrem.processed,
    decayed_dormant: decay.toDormant,
    decayed_archived: decay.toArchived,
    decayed_expired: decay.expired,
    reactivated: decay.reactivated,
    superseded: reconcile.supersessions,
    contradicted: reconcile.contradictions,
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

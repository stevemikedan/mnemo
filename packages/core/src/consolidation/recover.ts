import type { MemoryStore } from '../graph/store.js';
import type { GraphStore } from '../graph/graph.js';
import type { Memory } from '../graph/schema.js';

/**
 * Reverse destructive consolidation mutations from their dream_audit snapshots.
 * NREM merges and reconcile supersessions are the only mutations that discard or
 * demote a memory; both snapshot the before-state (grouped by mutation_id) so a
 * bad LLM verdict can be undone — the recovery half of the audit trail.
 */

interface AuditRow {
  id: string;
  mutation_id: string | null;
  phase: string;
  memory_id: string;
  before_state: string;
  note: string | null;
  restored_at: string | null;
  created_at: string;
}

export interface ReversibleMutation {
  mutationId: string;
  phase: 'nrem-merge' | 'reconcile-supersede';
  createdAt: string;
  restoredAt: string | null;
  /** One-line human summary for a list/undo UI. */
  description: string;
  /** IDs of the memories this mutation touched. */
  memoryIds: string[];
}

export interface RestoreResult {
  restored: boolean;
  reason?: string;
  memoryIds: string[];
}

/** Fields we can safely re-apply from a snapshot (mirrors store.update's patch). */
const RESTORABLE = ['content', 'type', 'scope', 'state', 'importance', 'confidence', 'tags', 'metadata', 'superseded_by'] as const;

function parseSnapshot(json: string): Partial<Memory> | null {
  try {
    return JSON.parse(json) as Partial<Memory>;
  } catch {
    return null;
  }
}

function preview(text: string, n = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function describe(rows: AuditRow[]): string {
  const phase = rows[0].phase;
  if (phase === 'nrem-merge') {
    const survivor = rows.find(r => r.note?.startsWith('absorbed ')) ?? rows[0];
    const snap = parseSnapshot(survivor.before_state);
    return `Merged "${preview(snap?.content ?? '?')}" — absorbed ${rows.length - 1} other`;
  }
  const snap = parseSnapshot(rows[0].before_state);
  return `Superseded "${preview(snap?.content ?? '?')}"`;
}

/**
 * Recent reversible mutations, newest first, grouped by mutation_id. Excludes
 * already-restored ones unless includeRestored is set.
 */
export function listAudit(store: MemoryStore, opts: { limit?: number; includeRestored?: boolean } = {}): ReversibleMutation[] {
  const limit = opts.limit ?? 20;
  const where = opts.includeRestored ? '' : 'WHERE restored_at IS NULL';
  const rows = store.db.prepare(
    `SELECT * FROM dream_audit ${where} ORDER BY created_at DESC`,
  ).all() as AuditRow[];

  const groups = new Map<string, AuditRow[]>();
  for (const r of rows) {
    const key = r.mutation_id ?? r.id; // pre-grouping rows stand alone
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const mutations: ReversibleMutation[] = [];
  for (const [mutationId, group] of groups) {
    mutations.push({
      mutationId,
      phase: group[0].phase as ReversibleMutation['phase'],
      createdAt: group[0].created_at,
      restoredAt: group[0].restored_at,
      description: describe(group),
      memoryIds: group.map(r => r.memory_id),
    });
    if (mutations.length >= limit) break;
  }
  return mutations;
}

/**
 * Reverse one mutation: re-apply each snapshot (un-expiring a merged memory,
 * reverting the survivor's content, restoring a demoted memory's importance and
 * clearing its superseded_by) and drop the edge the mutation added. Idempotent —
 * an already-restored or unknown mutation_id is a no-op.
 *
 * Best-effort: if a memory was mutated again after the audit, the snapshot still
 * applies (last-write-wins). Edges are removed in either direction.
 */
export function restoreMutation(store: MemoryStore, graph: GraphStore, mutationId: string): RestoreResult {
  const rows = store.db.prepare(
    'SELECT * FROM dream_audit WHERE mutation_id = ? AND restored_at IS NULL',
  ).all(mutationId) as AuditRow[];
  if (rows.length === 0) return { restored: false, reason: 'not found or already restored', memoryIds: [] };

  const restoredIds: string[] = [];
  for (const row of rows) {
    const snap = parseSnapshot(row.before_state);
    if (!snap) continue;
    const patch: Record<string, unknown> = {};
    for (const k of RESTORABLE) {
      if (snap[k] !== undefined) patch[k] = snap[k];
    }
    store.update(row.memory_id, patch);
    restoredIds.push(row.memory_id);
  }

  // Drop the edge this mutation introduced.
  if (rows[0].phase === 'nrem-merge' && rows.length >= 2) {
    graph.removeEdge(rows[0].memory_id, rows[1].memory_id); // derived-from, either direction
  } else if (rows[0].phase === 'reconcile-supersede') {
    const newerId = rows[0].note?.replace(/^superseded by /, '').trim();
    if (newerId) graph.removeEdge(rows[0].memory_id, newerId); // supersedes
  }

  store.db.prepare('UPDATE dream_audit SET restored_at = ? WHERE mutation_id = ?')
    .run(new Date().toISOString(), mutationId);

  return { restored: true, memoryIds: restoredIds };
}

import { v4 as uuidv4 } from 'uuid';
import type { MemoryStore } from '../graph/store.js';

export type AdjudicationSource = 'llm' | 'elm' | 'heuristic';

export interface AdjudicationRow {
  older_id: string;
  newer_id: string;
  scope: string;
  phase: 'reconcile' | 'nrem';
  features: number[];
  verdict: string;
  source: AdjudicationSource;
}

/** Append one pairwise verdict + its features to adjudication_log (pre-screener training data). */
export function logAdjudication(store: MemoryStore, row: AdjudicationRow): void {
  store.db.prepare(
    `INSERT INTO adjudication_log (id, older_id, newer_id, scope, phase, features, verdict, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv4(), row.older_id, row.newer_id, row.scope, row.phase,
    JSON.stringify(row.features), row.verdict, row.source, new Date().toISOString(),
  );
}

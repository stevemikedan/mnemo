import { statSync, existsSync } from 'fs';
import { modelPath, loadJSON } from './persist.js';
import { readConfig } from '../consolidation/config.js';
import { describeConsolidationModel, describeReconcileModel } from '../consolidation/llm.js';
import type { ValidationReport } from './trainer.js';
import type { MemoryStore } from '../graph/store.js';

/**
 * One dashboard-friendly snapshot of the ML subsystem: which models exist,
 * how they validated when last trained, and how much training data has
 * accumulated for the ones still waiting to go live.
 */

export interface ModelStatus {
  /** null = never persisted (untrained or has never beaten its baseline). */
  report: ValidationReport | null;
  /** File mtime of the persisted model, ISO — when it last (re)trained. */
  updatedAt: string | null;
  enabled: boolean;
}

export interface MlStatus {
  models: {
    typeClassifier: ModelStatus;
    prescreenNrem: ModelStatus;
    prescreenReconcile: ModelStatus;
    reranker: ModelStatus;
  };
  trainingData: {
    /** adjudication_log rows by source — 'llm' rows are trainable labels. */
    adjudicationsBySource: Record<string, number>;
    /** recall_feedback rows: used=1 positives vs used=0 impressions. */
    feedbackUsed: number;
    feedbackSkipped: number;
  };
  /** Consolidation LLM routing — the configured primary models and how often
   * the most recent dream fell through to a fallback provider. */
  llm: {
    consolidationModel: string;
    reconcileModel: string;
    lastDreamFallbacks: number;
  };
}

function modelStatus(file: string, enabled: boolean): ModelStatus {
  const path = modelPath(file);
  const persisted = loadJSON<{ report: ValidationReport }>(path);
  return {
    report: persisted?.report ?? null,
    updatedAt: persisted && existsSync(path) ? statSync(path).mtime.toISOString() : null,
    enabled,
  };
}

export function getMlStatus(store: MemoryStore): MlStatus {
  const ml = readConfig().ml ?? {};
  const adjRows = store.db.prepare(
    'SELECT source, COUNT(*) AS n FROM adjudication_log GROUP BY source',
  ).all() as { source: string; n: number }[];
  const fb = store.db.prepare(
    'SELECT used, COUNT(*) AS n FROM recall_feedback GROUP BY used',
  ).all() as { used: number; n: number }[];
  const lastLog = store.db.prepare(
    "SELECT stats FROM consolidation_log ORDER BY started_at DESC LIMIT 1",
  ).get() as { stats: string } | undefined;
  let lastDreamFallbacks = 0;
  try { lastDreamFallbacks = (JSON.parse(lastLog?.stats ?? '{}').llm_fallback_calls as number) ?? 0; } catch { /* keep 0 */ }

  return {
    models: {
      typeClassifier: modelStatus('elm-type-classifier.json', ml.typeSuggest?.enabled === true),
      prescreenNrem: modelStatus('elm-prescreen-nrem.json', ml.prescreen?.enabled === true),
      prescreenReconcile: modelStatus('elm-prescreen-reconcile.json', ml.prescreen?.enabled === true),
      reranker: modelStatus('elm-reranker.json', ml.rerank?.enabled === true),
    },
    trainingData: {
      adjudicationsBySource: Object.fromEntries(adjRows.map(r => [r.source, r.n])),
      feedbackUsed: fb.find(r => r.used === 1)?.n ?? 0,
      feedbackSkipped: fb.find(r => r.used === 0)?.n ?? 0,
    },
    llm: {
      consolidationModel: describeConsolidationModel(),
      reconcileModel: describeReconcileModel(),
      lastDreamFallbacks,
    },
  };
}

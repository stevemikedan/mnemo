import { modelPath, loadJSON, saveJSON } from './persist.js';
import { pairFeatures } from './featurize.js';
import { trainAndValidate, type ValidationReport } from './trainer.js';
import { loadElmClassifier, type ElmClassifier } from './elm-classifier.js';
import { readConfig } from '../consolidation/config.js';
import type { MemoryStore } from '../graph/store.js';
import type { Memory } from '../graph/schema.js';

/**
 * Consolidation pre-screener: ELMs trained on the adjudication_log to predict
 * pairwise verdicts from the cheap pairFeatures, so obvious non-conflicts skip
 * the LLM entirely.
 *
 * Safety asymmetry, by design: the pre-screener may only short-circuit the
 * NEGATIVE verdict of each phase (SKIP for NREM, NONE for reconcile) — a wrong
 * negative just defers a merge/supersession to a later dream, while a wrong
 * positive would destroy or demote a memory. Predicted positives are always
 * confirmed by the LLM.
 */

export type PrescreenPhase = 'nrem' | 'reconcile';

const NREM_VERDICTS = ['MERGE', 'SKIP'] as const;
const RECONCILE_VERDICTS = ['SUPERSEDES', 'CONTRADICTS', 'NONE'] as const;
const NEGATIVE: Record<PrescreenPhase, string> = { nrem: 'SKIP', reconcile: 'NONE' };

function fileFor(phase: PrescreenPhase): string {
  return modelPath(`elm-prescreen-${phase}.json`);
}

interface PersistedPrescreenModel {
  json: string;
  report: ValidationReport;
}

const cache: Partial<Record<PrescreenPhase, { key: string; clf: ElmClassifier | null }>> = {};

/**
 * Train the pre-screener for one phase from adjudication_log. Only rows with
 * source='llm' are labels (never learn from our own past predictions), and
 * models listed in ml.prescreen.excludeModels are dropped so a weak local
 * adjudicator's mistakes don't get distilled. Persists only when the model
 * beats the majority baseline on held-out rows (trainAndValidate gate).
 */
export function trainPrescreener(store: MemoryStore, phase: PrescreenPhase): ValidationReport {
  const exclude = new Set(readConfig().ml?.prescreen?.excludeModels ?? []);
  const rows = store.db.prepare(
    `SELECT features, verdict, model FROM adjudication_log WHERE phase = ? AND source = 'llm'`,
  ).all(phase) as { features: string; verdict: string; model: string | null }[];

  const categories = phase === 'nrem' ? [...NREM_VERDICTS] : [...RECONCILE_VERDICTS];
  const samples: { x: number[]; y: string }[] = [];
  let dim = 0;
  for (const r of rows) {
    if (r.model && exclude.has(r.model)) continue;
    if (!categories.includes(r.verdict as never)) continue;
    let x: number[];
    try {
      x = JSON.parse(r.features);
    } catch {
      continue;
    }
    if (!Array.isArray(x) || x.length === 0) continue;
    if (dim === 0) dim = x.length;
    if (x.length !== dim) continue; // feature schema changed — keep the majority dimension
    samples.push({ x, y: r.verdict });
  }

  const { model, report } = trainAndValidate(categories, samples, {
    seed: 1, minSamples: 50, minPerClass: 5, minEdge: 0.05, hiddenUnits: 32,
  });
  if (model) {
    saveJSON(fileFor(phase), { json: model.toJSON(), report } satisfies PersistedPrescreenModel);
    cache[phase] = undefined as never; // invalidate
  }
  return report;
}

function loadModel(phase: PrescreenPhase): ElmClassifier | null {
  const persisted = loadJSON<PersistedPrescreenModel>(fileFor(phase));
  const key = persisted?.json ?? '';
  const c = cache[phase];
  if (c && c.key === key) return c.clf;
  const clf = persisted?.json ? loadElmClassifier(persisted.json) : null;
  cache[phase] = { key, clf };
  return clf;
}

/**
 * Pre-screen a pair before LLM adjudication. Returns the phase's negative
 * verdict ('SKIP' / 'NONE') when the trained model predicts it above the
 * configured margin — meaning the LLM call can be skipped — or null when the
 * pair needs real adjudication (no model, low margin, or predicted positive).
 */
export function prescreenPair(phase: PrescreenPhase, a: Memory, b: Memory): string | null {
  const cfg = readConfig().ml?.prescreen;
  if (!cfg?.enabled) return null;
  const clf = loadModel(phase);
  if (!clf) return null;

  const x = pairFeatures(a, b);
  if (clf.inputSize > 0 && x.length !== clf.inputSize) return null;
  const p = clf.predict(x);
  if (!p) return null;

  // Margin gate mirrors suggestType: ELM softmax is underconfident, so margin
  // (top − runner-up) is the calibrated signal. Default is stricter than
  // typeSuggest because a false SKIP/NONE delays consolidation for a whole
  // dream cycle.
  const minMargin = cfg.minMargin ?? 0.2;
  if (p.label !== NEGATIVE[phase] || p.margin < minMargin) return null;
  return p.label;
}

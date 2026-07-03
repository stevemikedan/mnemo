import { modelPath, loadJSON, saveJSON } from './persist.js';
import { textFeatures } from './featurize.js';
import { trainAndValidate, type ValidationReport } from './trainer.js';
import { loadElmClassifier, type ElmClassifier } from './elm-classifier.js';
import { readConfig } from '../consolidation/config.js';
import type { MemoryStore } from '../graph/store.js';
import type { MemoryType } from '../graph/schema.js';

const MODEL_FILE = 'elm-type-classifier.json';
const TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference', 'episodic', 'semantic'];

interface PersistedTypeModel {
  json: string;
  report: ValidationReport<MemoryType>;
}

let cache: { key: string; clf: ElmClassifier<MemoryType> | null } | null = null;

/**
 * Train the type classifier on the whole store and persist it ONLY if it beats
 * the always-'project' baseline on held-out data. Returns the validation report
 * (also when it declines to train). Intended to run during dream().
 */
export function trainTypeClassifier(store: MemoryStore): ValidationReport<MemoryType> {
  const memories = store.query({ states: ['active', 'dormant', 'archived'] });
  const samples = memories.map(m => ({ x: textFeatures(m.content), y: m.type }));
  const { model, report } = trainAndValidate(TYPES, samples, {
    seed: 1, minSamples: 40, minPerClass: 4, minEdge: 0.05,
  });
  if (model) {
    saveJSON(modelPath(MODEL_FILE), { json: model.toJSON(), report });
    cache = null; // invalidate so the next suggestType loads the fresh model
  }
  return report;
}

function loadModel(): ElmClassifier<MemoryType> | null {
  const persisted = loadJSON<PersistedTypeModel>(modelPath(MODEL_FILE));
  const key = persisted?.json ?? '';
  if (cache && cache.key === key) return cache.clf;
  const clf = persisted?.json ? loadElmClassifier<MemoryType>(persisted.json) : null;
  cache = { key, clf };
  return clf;
}

/**
 * Suggest a memory type for new content, or null when there's no trained model,
 * the prediction is below the configured confidence/margin gate, or the feature
 * dims mismatch. Suggest-only — callers keep their own default when this is null.
 */
export function suggestType(content: string): { type: MemoryType; confidence: number } | null {
  const clf = loadModel();
  if (!clf) return null;
  const p = clf.predict(textFeatures(content));
  if (!p) return null;
  const cfg = readConfig().ml?.typeSuggest;
  const minConfidence = cfg?.minConfidence ?? 0.75;
  const minMargin = cfg?.minMargin ?? 0.15;
  if (p.confidence < minConfidence || p.margin < minMargin) return null;
  return { type: p.label, confidence: p.confidence };
}

import { modelPath, loadJSON, saveJSON } from './persist.js';
import { textFeatures, TEXT_FEATURE_DIM } from './featurize.js';
import { trainAndValidate, type ValidationReport } from './trainer.js';
import { loadElmClassifier, type ElmClassifier } from './elm-classifier.js';
import { embedText, decodeVector } from '../rag/embedding.js';
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
 *
 * Prefers stored 768-dim nomic embeddings (written by encodeForDream) when at
 * least 30 memories have them. Falls back to 256-dim local hashing otherwise.
 * Never mixes dimensions in one training run — consistent inputSize is required
 * by the ELM weight matrix.
 */
export function trainTypeClassifier(store: MemoryStore): ValidationReport<MemoryType> {
  const memories = store.query({ states: ['active', 'dormant', 'archived'] });

  const withEmb = memories.filter(m => m.embedding != null);
  const useStored = withEmb.length >= 30;
  const pool = useStored ? withEmb : memories;

  const samples = pool.map(m => ({
    x: useStored
      ? Array.from(decodeVector(m.embedding as Buffer))
      : textFeatures(m.content),
    y: m.type,
  }));

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
 *
 * Async because 768-dim models call the configured embedder (e.g. Ollama). When
 * the model was trained on 256-dim local features, the path stays synchronous
 * under the hood and never touches the network.
 */
export async function suggestType(content: string): Promise<{ type: MemoryType; confidence: number; margin: number } | null> {
  const clf = loadModel();
  if (!clf) return null;

  // Match the feature dimension the model was trained on. 256 → sync local
  // hashing; anything else (768 nomic) → call the configured embedder async.
  // If the embedder is unavailable the call returns null, and predict() would
  // dim-mismatch anyway, so returning null here is correct.
  let vec: number[];
  if (clf.inputSize === TEXT_FEATURE_DIM) {
    vec = textFeatures(content);
  } else {
    const vecs = await embedText([content]);
    if (!vecs) return null;
    vec = vecs[0];
  }

  const p = clf.predict(vec);
  if (!p) return null;
  // ELM softmax is systematically underconfident (top prob ~0.3 even at 98%
  // accuracy), so the gate is margin-based (top − runner-up), which is
  // well-calibrated for this model.
  const cfg = readConfig().ml?.typeSuggest;
  const minConfidence = cfg?.minConfidence ?? 0.0;
  const minMargin = cfg?.minMargin ?? 0.1;
  if (p.confidence < minConfidence || p.margin < minMargin) return null;
  return { type: p.label, confidence: p.confidence, margin: p.margin };
}

import { ELM } from '@astermind/astermind-elm';
import { silenced } from './persist.js';

export interface Prediction<L extends string = string> {
  label: L;
  /** Top softmax probability. */
  confidence: number;
  /** Top probability minus the runner-up (calibration for near-ties). */
  margin: number;
  proba: Record<L, number>;
}

export interface ElmClassifier<L extends string = string> {
  categories: L[];
  /** Feature-vector dimension the model was trained on. Used to choose the right embedder at predict time. */
  inputSize: number;
  /** Predict from a numeric feature vector, or null if untrained / dim-mismatch. */
  predict(vec: number[]): Prediction<L> | null;
  /** Serialize to a JSON string (round-trips via loadElmClassifier). */
  toJSON(): string;
}

export interface ElmTrainConfig<L extends string> {
  categories: L[];
  inputSize: number;
  hiddenUnits?: number;
  ridgeLambda?: number;
  seed?: number;
}

function makeNumericConfig<L extends string>(categories: L[], inputSize: number, hiddenUnits: number, ridgeLambda: number, seed: number) {
  // Numeric mode (useTokenizer:false) — we control featurization so train↔predict
  // dims stay consistent. No `metrics` thresholds, so trainFromData auto-populates
  // savedModelJSON (the "no metrics — always save" path).
  return {
    categories: categories as string[],
    inputSize,
    useTokenizer: false as const,
    hiddenUnits,
    activation: 'tanh' as const,
    ridgeLambda,
    seed,
  };
}

function wrap<L extends string>(elm: ELM, categories: L[], inputSize: number): ElmClassifier<L> {
  return {
    categories,
    inputSize,
    predict(vec: number[]): Prediction<L> | null {
      if (!elm.model) return null;
      if (inputSize > 0 && vec.length !== inputSize) return null;
      let proba: number[];
      try {
        proba = silenced(() => elm.predictProbaFromVector(vec));
      } catch {
        return null;
      }
      if (!Array.isArray(proba) || proba.length !== categories.length) return null;

      let top = 0;
      for (let i = 1; i < proba.length; i++) if (proba[i] > proba[top]) top = i;
      let second = -1;
      for (let i = 0; i < proba.length; i++) {
        if (i === top) continue;
        if (second < 0 || proba[i] > proba[second]) second = i;
      }
      const confidence = proba[top];
      const margin = second >= 0 ? confidence - proba[second] : confidence;
      const probaMap = {} as Record<L, number>;
      categories.forEach((c, i) => { probaMap[c] = proba[i]; });
      return { label: categories[top], confidence, margin, proba: probaMap };
    },
    toJSON(): string {
      return elm.savedModelJSON ?? '';
    },
  };
}

/** Train a classifier from feature vectors X and their labels (one label per row). */
export function trainElmClassifier<L extends string>(cfg: ElmTrainConfig<L>, X: number[][], labels: L[]): ElmClassifier<L> {
  const elm = silenced(() => new ELM(makeNumericConfig(
    cfg.categories, cfg.inputSize, cfg.hiddenUnits ?? 64, cfg.ridgeLambda ?? 1e-2, cfg.seed ?? 1,
  )));
  // One-hot targets (unambiguous vs numeric regression targets).
  const Y = labels.map(l => {
    const oh = new Array(cfg.categories.length).fill(0);
    oh[cfg.categories.indexOf(l)] = 1;
    return oh;
  });
  silenced(() => elm.trainFromData(X, Y));
  return wrap(elm, cfg.categories, cfg.inputSize);
}

/** Rehydrate a classifier from a JSON string. Returns null if the JSON is empty/invalid. */
export function loadElmClassifier<L extends string>(json: string): ElmClassifier<L> | null {
  if (!json) return null;
  const elm = silenced(() => new ELM(makeNumericConfig([] as L[], 1, 1, 1e-2, 1)));
  silenced(() => elm.loadModelFromJSON(json));
  if (!elm.model) return null;
  const categories = (elm.categories ?? []) as L[];
  if (categories.length === 0) return null;
  const inputSize = ((elm.config as { inputSize?: number }).inputSize) ?? (elm.model.W?.length ?? 0);
  return wrap(elm, categories, inputSize);
}

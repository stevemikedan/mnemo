import { trainElmClassifier, type ElmClassifier } from './elm-classifier.js';

export interface Sample<L extends string> {
  x: number[];
  y: L;
}

export interface ValidationReport<L extends string = string> {
  trained: boolean;
  reason?: string;
  n: number;
  heldOut: number;
  accuracy?: number;
  baselineAccuracy?: number;
  macroF1?: number;
  perClassRecall?: Partial<Record<L, number>>;
}

export interface TrainAndValidateOptions {
  holdout?: number;      // default 0.2
  minSamples?: number;   // default 30
  minPerClass?: number;  // default 3
  seed?: number;
  hiddenUnits?: number;
  ridgeLambda?: number;
  /** ELM holdout accuracy must beat the majority-class baseline by at least this. Default 0.05. */
  minEdge?: number;
}

/** Deterministic PRNG (mulberry32) for reproducible shuffles. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Train an ELM classifier and validate it on a held-out split. Returns a model
 * ONLY if there is enough data AND it beats the majority-class baseline by
 * `minEdge`; otherwise returns `{ model: null, report }` (cold-start / not-worth-it
 * are first-class outcomes — the caller keeps its existing behavior).
 */
export function trainAndValidate<L extends string>(
  categories: L[],
  samples: Sample<L>[],
  opts: TrainAndValidateOptions = {},
): { model: ElmClassifier<L> | null; report: ValidationReport<L> } {
  const minSamples = opts.minSamples ?? 30;
  const minPerClass = opts.minPerClass ?? 3;
  const holdout = opts.holdout ?? 0.2;
  const minEdge = opts.minEdge ?? 0.05;
  const seed = opts.seed ?? 1;
  const n = samples.length;

  if (n < minSamples) {
    return { model: null, report: { trained: false, reason: `too few samples (${n} < ${minSamples})`, n, heldOut: 0 } };
  }
  const counts: Partial<Record<L, number>> = {};
  for (const s of samples) counts[s.y] = (counts[s.y] ?? 0) + 1;
  const usableClasses = categories.filter(c => (counts[c] ?? 0) >= minPerClass);
  if (usableClasses.length < 2) {
    return { model: null, report: { trained: false, reason: 'need ≥2 classes with enough examples', n, heldOut: 0 } };
  }

  // Deterministic shuffle → holdout split.
  const idx = samples.map((_, i) => i);
  const rand = mulberry32(seed);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const cut = Math.max(1, Math.floor(n * holdout));
  const testIdx = idx.slice(0, cut);
  const trainIdx = idx.slice(cut);

  const inputSize = samples[0].x.length;
  const model = trainElmClassifier(
    { categories, inputSize, hiddenUnits: opts.hiddenUnits, ridgeLambda: opts.ridgeLambda, seed },
    trainIdx.map(i => samples[i].x),
    trainIdx.map(i => samples[i].y),
  );

  // Majority-class baseline from the training split.
  const trainCounts: Partial<Record<L, number>> = {};
  for (const i of trainIdx) trainCounts[samples[i].y] = (trainCounts[samples[i].y] ?? 0) + 1;
  let majority = categories[0];
  for (const c of categories) if ((trainCounts[c] ?? 0) > (trainCounts[majority] ?? 0)) majority = c;

  // Held-out confusion counts.
  const tp: Partial<Record<L, number>> = {}, fp: Partial<Record<L, number>> = {}, fn: Partial<Record<L, number>> = {};
  const total: Partial<Record<L, number>> = {};
  let correct = 0, baselineCorrect = 0;
  for (const i of testIdx) {
    const s = samples[i];
    total[s.y] = (total[s.y] ?? 0) + 1;
    if (s.y === majority) baselineCorrect++;
    const p = model.predict(s.x);
    if (p && p.label === s.y) { correct++; tp[s.y] = (tp[s.y] ?? 0) + 1; }
    else if (p) { fp[p.label as L] = (fp[p.label as L] ?? 0) + 1; fn[s.y] = (fn[s.y] ?? 0) + 1; }
    else { fn[s.y] = (fn[s.y] ?? 0) + 1; }
  }

  const accuracy = correct / testIdx.length;
  const baselineAccuracy = baselineCorrect / testIdx.length;
  const perClassRecall: Partial<Record<L, number>> = {};
  const f1s: number[] = [];
  for (const c of categories) {
    if (!total[c]) continue;
    const recall = (tp[c] ?? 0) / (total[c] ?? 1);
    const prec = (tp[c] ?? 0) / (((tp[c] ?? 0) + (fp[c] ?? 0)) || 1);
    perClassRecall[c] = recall;
    f1s.push(prec + recall > 0 ? (2 * prec * recall) / (prec + recall) : 0);
  }
  const macroF1 = f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0;

  const trained = accuracy >= baselineAccuracy + minEdge;
  return {
    model: trained ? model : null,
    report: {
      trained,
      reason: trained ? undefined : `accuracy ${accuracy.toFixed(2)} did not beat baseline ${baselineAccuracy.toFixed(2)} + ${minEdge}`,
      n, heldOut: testIdx.length, accuracy, baselineAccuracy, macroF1, perClassRecall,
    },
  };
}

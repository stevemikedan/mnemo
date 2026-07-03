import { describe, it, expect, vi } from 'vitest';
import { trainElmClassifier, loadElmClassifier } from '../src/ml/elm-classifier.js';

// A deterministic, linearly separable 2-class set in 8 dims (no RNG).
function samples() {
  const X: number[][] = [];
  const y: ('a' | 'b')[] = [];
  for (let i = 0; i < 24; i++) {
    X.push([1, 1, 1, 1, 0, 0, 0, 0].map((v, k) => v + ((i + k) % 3) * 0.04));
    y.push('a');
    X.push([0, 0, 0, 0, 1, 1, 1, 1].map((v, k) => v + ((i + k) % 3) * 0.04));
    y.push('b');
  }
  return { X, y };
}

describe('ElmClassifier', () => {
  it('trains a separable set and predicts the right class with high confidence', () => {
    const { X, y } = samples();
    const clf = trainElmClassifier({ categories: ['a', 'b'], inputSize: 8, seed: 1 }, X, y);
    const pa = clf.predict([1, 1, 1, 1, 0, 0, 0, 0]);
    const pb = clf.predict([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(pa?.label).toBe('a');
    expect(pb?.label).toBe('b');
    expect(pa!.confidence).toBeGreaterThan(0.7);
    expect(pa!.margin).toBeGreaterThan(0);
    expect(pa!.proba.a + pa!.proba.b).toBeCloseTo(1, 3);
  });

  it('round-trips through JSON to identical predictions', () => {
    const { X, y } = samples();
    const clf = trainElmClassifier({ categories: ['a', 'b'], inputSize: 8, seed: 1 }, X, y);
    const json = clf.toJSON();
    expect(json).toBeTruthy();
    const loaded = loadElmClassifier<'a' | 'b'>(json);
    expect(loaded).not.toBeNull();
    const v = [1, 1, 1, 1, 0, 0, 0, 0];
    expect(loaded!.predict(v)?.label).toBe(clf.predict(v)?.label);
    expect(loaded!.predict(v)!.confidence).toBeCloseTo(clf.predict(v)!.confidence, 5);
  });

  it('returns null on a dimension mismatch', () => {
    const { X, y } = samples();
    const clf = trainElmClassifier({ categories: ['a', 'b'], inputSize: 8 }, X, y);
    expect(clf.predict([1, 2, 3])).toBeNull();
  });

  it('loadElmClassifier returns null on empty/garbage input', () => {
    expect(loadElmClassifier('')).toBeNull();
    expect(loadElmClassifier('not json')).toBeNull();
  });

  it('silences AsterMind console output during train and predict', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Note: the real console.log is captured by the spy; silenced() swaps console.log,
    // so if silencing works the spy records nothing from the library.
    spy.mockClear();
    const { X, y } = samples();
    const clf = trainElmClassifier({ categories: ['a', 'b'], inputSize: 8 }, X, y);
    clf.predict([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

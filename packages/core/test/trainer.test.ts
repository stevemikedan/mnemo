import { describe, it, expect } from 'vitest';
import { trainAndValidate, type Sample } from '../src/ml/trainer.js';

const cats = ['a', 'b'] as const;
type L = (typeof cats)[number];

// Separable samples in 8 dims (deterministic).
function separable(nPer: number): Sample<L>[] {
  const out: Sample<L>[] = [];
  for (let i = 0; i < nPer; i++) {
    out.push({ x: [1, 1, 1, 1, 0, 0, 0, 0].map((v, k) => v + ((i + k) % 3) * 0.03), y: 'a' });
    out.push({ x: [0, 0, 0, 0, 1, 1, 1, 1].map((v, k) => v + ((i + k) % 3) * 0.03), y: 'b' });
  }
  return out;
}

describe('trainAndValidate', () => {
  it('cold-start: returns null below minSamples', () => {
    const { model, report } = trainAndValidate([...cats], separable(3), { minSamples: 30 });
    expect(model).toBeNull();
    expect(report.trained).toBe(false);
    expect(report.reason).toMatch(/too few/);
  });

  it('single-class: returns null (needs ≥2 usable classes)', () => {
    const oneClass: Sample<L>[] = Array.from({ length: 40 }, () => ({ x: [1, 0, 1, 0], y: 'a' }));
    const { model, report } = trainAndValidate([...cats], oneClass);
    expect(model).toBeNull();
    expect(report.trained).toBe(false);
  });

  it('trains and beats the baseline on a separable set', () => {
    const { model, report } = trainAndValidate([...cats], separable(40), { seed: 1, minEdge: 0.05 });
    expect(model).not.toBeNull();
    expect(report.trained).toBe(true);
    expect(report.accuracy!).toBeGreaterThan(report.baselineAccuracy!);
    expect(report.macroF1!).toBeGreaterThan(0.5);
  });

  it('refuses a model that cannot beat the baseline (pure noise)', () => {
    // Labels independent of features → ELM cannot beat majority baseline by minEdge.
    const noise: Sample<L>[] = Array.from({ length: 80 }, (_, i) => ({
      x: [((i * 7) % 5) / 5, ((i * 3) % 4) / 4, ((i * 11) % 3) / 3, ((i * 2) % 6) / 6],
      y: (i % 2 === 0 ? 'a' : 'b'),
    }));
    const { model, report } = trainAndValidate([...cats], noise, { seed: 1, minEdge: 0.15 });
    expect(model).toBeNull();
    expect(report.trained).toBe(false);
    expect(report.reason).toMatch(/baseline/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  adaptiveWeights,
  applyCalibration,
  buildCalibration,
  defaultModelWeights,
  type ModelPerformance,
} from './adaptive';

const syntheticPerformance = (
  totals: number,
  ewmaAccuracy: Record<'signal' | 'drift' | 'regime', number>,
): ModelPerformance => ({
  halfLifeSamples: 100,
  horizons: [
    {
      horizon: 1,
      models: {
        signal: {
          hits: Math.round(totals * ewmaAccuracy.signal),
          total: totals,
          accuracy: ewmaAccuracy.signal,
          decayedHits: ewmaAccuracy.signal * totals,
          decayedTotal: totals,
          ewmaAccuracy: ewmaAccuracy.signal,
        },
        drift: {
          hits: Math.round(totals * ewmaAccuracy.drift),
          total: totals,
          accuracy: ewmaAccuracy.drift,
          decayedHits: ewmaAccuracy.drift * totals,
          decayedTotal: totals,
          ewmaAccuracy: ewmaAccuracy.drift,
        },
        regime: {
          hits: Math.round(totals * ewmaAccuracy.regime),
          total: totals,
          accuracy: ewmaAccuracy.regime,
          decayedHits: ewmaAccuracy.regime * totals,
          decayedTotal: totals,
          ewmaAccuracy: ewmaAccuracy.regime,
        },
      },
    },
  ],
});

describe('adaptive learning', () => {
  it('moves EWA weights toward the only consistently correct model', () => {
    const result = adaptiveWeights(
      syntheticPerformance(120, {
        signal: 0,
        drift: 1,
        regime: 0,
      }),
    );

    const weights = result.horizons[0].weights;
    expect(result.horizons[0].fallback).toBe(false);
    expect(weights.drift).toBeGreaterThan(0.99);
    expect(weights.drift).toBeGreaterThan(weights.signal);
    expect(weights.drift).toBeGreaterThan(weights.regime);
  });

  it('calibrates overconfident 0.9 forecasts toward observed frequency', () => {
    const predictions = Array.from({ length: 100 }, () => 0.9);
    const outcomes = Array.from({ length: 100 }, (_, index) => index < 60);
    const table = buildCalibration(predictions, outcomes);

    expect(applyCalibration(0.9, table)).toBeGreaterThan(0.56);
    expect(applyCalibration(0.9, table)).toBeLessThan(0.64);
  });

  it('keeps the calibration mapping monotonic', () => {
    const predictions = [
      ...Array.from({ length: 40 }, () => 0.15),
      ...Array.from({ length: 40 }, () => 0.45),
      ...Array.from({ length: 40 }, () => 0.75),
    ];
    const outcomes = [
      ...Array.from({ length: 40 }, (_, index) => index < 30),
      ...Array.from({ length: 40 }, (_, index) => index < 8),
      ...Array.from({ length: 40 }, (_, index) => index < 22),
    ];
    const table = buildCalibration(predictions, outcomes);
    const mapped = Array.from({ length: 19 }, (_, index) => applyCalibration((index + 1) / 20, table));

    for (let index = 1; index < mapped.length; index += 1) {
      expect(mapped[index]).toBeGreaterThanOrEqual(mapped[index - 1]);
    }
  });

  it('falls back to fixed weights when samples are insufficient', () => {
    const result = adaptiveWeights(
      syntheticPerformance(12, {
        signal: 1,
        drift: 0,
        regime: 0,
      }),
    );

    expect(result.horizons[0].fallback).toBe(true);
    expect(result.horizons[0].weights).toEqual(defaultModelWeights);
  });
});

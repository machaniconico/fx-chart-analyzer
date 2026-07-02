import { describe, expect, it } from 'vitest';
import {
  predict,
  predictionHorizons,
  walkForwardAccuracy,
  walkForwardAccuracyAsync,
} from './predict';
import { modelProbabilitiesForBars, type AdaptiveStats, type ModelWeights } from './adaptive';
import type { Bar } from '../types';

const trendBars = (length: number, start: number, step: number): Bar[] =>
  Array.from({ length }, (_, index) => {
    const close = start + step * index;
    const open = index === 0 ? close : start + step * (index - 1);
    const spread = Math.max(Math.abs(step) * 2, 0.15);
    return {
      t: index * 3600,
      o: open,
      h: Math.max(open, close) + spread,
      l: Math.min(open, close) - spread,
      c: close,
      v: 1000 + index,
    };
  });

const adaptiveStatsWithWeights = (weights: ModelWeights): AdaptiveStats => ({
  version: 1,
  generatedAt: new Date(0).toISOString(),
  sampleCount: 120,
  horizons: [...predictionHorizons],
  performance: {
    halfLifeSamples: 100,
    horizons: [],
  },
  weights: {
    temperature: 0.18,
    minSamples: 30,
    horizons: predictionHorizons.map((horizon) => ({
      horizon,
      sampleCount: 120,
      fallback: false,
      weights,
    })),
  },
  calibration: {
    horizons: [],
  },
});

describe('predict', () => {
  it('returns probabilities inside the 0-1 range for all horizons', () => {
    const result = predict(trendBars(180, 100, 0.05), { includeWalkForward: false });

    expect(result.horizons.map((item) => item.horizon)).toEqual([...predictionHorizons]);
    for (const horizon of result.horizons) {
      expect(horizon.probabilityUp).toBeGreaterThanOrEqual(0);
      expect(horizon.probabilityUp).toBeLessThanOrEqual(1);
      expect(horizon.range68.low).toBeLessThan(horizon.range68.high);
      expect(horizon.range95.low).toBeLessThan(horizon.range95.high);
    }
  });

  it('widens ATR-based ranges as the horizon grows', () => {
    const result = predict(trendBars(180, 100, 0.03), { includeWalkForward: false });
    const widths68 = result.horizons.map((item) => item.range68.high - item.range68.low);
    const widths95 = result.horizons.map((item) => item.range95.high - item.range95.low);

    expect(widths68[1]).toBeGreaterThan(widths68[0]);
    expect(widths68[2]).toBeGreaterThan(widths68[1]);
    expect(widths95[0]).toBeGreaterThan(widths68[0]);
    expect(widths95[2]).toBeGreaterThan(widths68[2]);
  });

  it('leans bullish on a known uptrend and bearish on a known downtrend', () => {
    const uptrend = predict(trendBars(220, 100, 0.08), { includeWalkForward: false });
    const downtrend = predict(trendBars(220, 140, -0.08), { includeWalkForward: false });

    expect(uptrend.horizons[0].probabilityUp).toBeGreaterThan(0.5);
    expect(downtrend.horizons[0].probabilityUp).toBeLessThan(0.5);
  });

  it('uses adaptive-core model probabilities for the latest bar at every horizon', () => {
    const bars = trendBars(240, 100, 0.06);
    const result = predict(bars, { includeWalkForward: false });

    for (const prediction of result.horizons) {
      const expected = modelProbabilitiesForBars(bars, prediction.horizon);

      expect(prediction.modelProbabilities.signal).toBeCloseTo(expected.signal, 12);
      expect(prediction.modelProbabilities.drift).toBeCloseTo(expected.drift, 12);
      expect(prediction.modelProbabilities.regime).toBeCloseTo(expected.regime, 12);
    }
  });

  it('does not reuse directional adaptive weights for expected price magnitude', () => {
    const bars = trendBars(240, 100, 0.06);
    const fixedWeights = predict(bars, { includeWalkForward: false });
    const directionalWeights = predict(bars, {
      includeWalkForward: false,
      adaptiveStats: adaptiveStatsWithWeights({ signal: 1, drift: 0, regime: 0 }),
    });

    expect(
      directionalWeights.horizons.some(
        (prediction, index) =>
          Math.abs(prediction.rawProbabilityUp - fixedWeights.horizons[index].rawProbabilityUp) > 0.000001,
      ),
    ).toBe(true);
    for (let index = 0; index < fixedWeights.horizons.length; index += 1) {
      expect(directionalWeights.horizons[index].expectedPrice).toBeCloseTo(
        fixedWeights.horizons[index].expectedPrice,
        12,
      );
    }
  });

  it('does not calculate walk-forward accuracy by default', () => {
    const result = predict(trendBars(220, 100, 0.08));

    expect(result.walkForward).toBeNull();
  });

  it('self-calculates walk-forward directional accuracy over the recent sample', () => {
    const result = walkForwardAccuracy(trendBars(420, 100, 0.04), { walkForwardLookback: 300 });
    const oneBar = result.horizons.find((item) => item.horizon === 1);

    expect(oneBar).toBeDefined();
    expect(oneBar?.total).toBeGreaterThan(0);
    expect(oneBar?.total).toBeLessThanOrEqual(300);
    expect(oneBar?.accuracy).not.toBeNull();
    expect(oneBar?.accuracy as number).toBeGreaterThanOrEqual(0);
    expect(oneBar?.accuracy as number).toBeLessThanOrEqual(1);
    expect(oneBar?.accuracy as number).toBeGreaterThan(0.6);
  });

  it('calculates walk-forward accuracy asynchronously in chunks', async () => {
    const result = await walkForwardAccuracyAsync(trendBars(420, 100, 0.04), {
      walkForwardLookback: 300,
      walkForwardChunkSize: 25,
    });
    const oneBar = result.horizons.find((item) => item.horizon === 1);

    expect(oneBar).toBeDefined();
    expect(oneBar?.total).toBeGreaterThan(0);
    expect(oneBar?.accuracy).not.toBeNull();
  });
});

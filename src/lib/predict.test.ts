import { describe, expect, it } from 'vitest';
import { predict, predictionHorizons, walkForwardAccuracy } from './predict';
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
});

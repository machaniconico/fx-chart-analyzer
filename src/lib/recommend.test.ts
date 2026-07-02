import { describe, expect, it } from 'vitest';
import { calculateExpectation, recommendationScoreThreshold, scanPair } from './recommend';
import type { Bar } from '../types';

const barsFromCloses = (closes: readonly number[]): Bar[] =>
  closes.map((close, index) => ({
    t: index * 1800,
    o: index === 0 ? close : closes[index - 1],
    h: Math.max(close, index === 0 ? close : closes[index - 1]) + 0.25,
    l: Math.min(close, index === 0 ? close : closes[index - 1]) - 0.25,
    c: close,
    v: 1000,
  }));

const buyBars = (): Bar[] =>
  barsFromCloses([
    ...Array(40).fill(100),
    ...Array(19).fill(99),
    130,
  ]);

const sellBars = (): Bar[] =>
  barsFromCloses([
    ...Array(40).fill(100),
    ...Array(19).fill(101),
    70,
  ]);

describe('recommend', () => {
  it('classifies expectation as high only at the conservative absolute boundary', () => {
    expect(calculateExpectation({
      score: 70,
      calibratedDirectionalProbability: 0.57,
      walkForwardAccuracy: 0.52,
      environmentAligned: true,
    }).tier).toBe('high');

    expect(calculateExpectation({
      score: 69.9,
      calibratedDirectionalProbability: 0.57,
      walkForwardAccuracy: 0.52,
      environmentAligned: true,
    }).tier).toBe('medium');

    expect(calculateExpectation({
      score: 70,
      calibratedDirectionalProbability: 0.569,
      walkForwardAccuracy: 0.52,
      environmentAligned: true,
    }).tier).toBe('medium');

    expect(calculateExpectation({
      score: 70,
      calibratedDirectionalProbability: 0.57,
      walkForwardAccuracy: 0.52,
      environmentAligned: false,
    }).tier).toBe('medium');
  });

  it('classifies expectation as medium when only some absolute conditions are met', () => {
    const result = calculateExpectation({
      score: 58,
      calibratedDirectionalProbability: 0.54,
      walkForwardAccuracy: null,
      environmentAligned: false,
    });

    expect(result.tier).toBe('medium');
    expect(result.label).toBe('中');
    expect(result.detail).toBe('一定の優位性はありますが過信は禁物です');
  });

  it('classifies expectation as low below the medium boundary', () => {
    const result = calculateExpectation({
      score: 57.9,
      calibratedDirectionalProbability: 0.539,
      walkForwardAccuracy: 0.509,
      environmentAligned: false,
    });

    expect(result.tier).toBe('low');
    expect(result.label).toBe('低');
    expect(result.detail).toBe('統計的な優位性は弱めです。見送りも有効な選択です');
  });

  it('does not classify expectation as high when calibrated probability is unavailable', () => {
    expect(calculateExpectation({
      score: 100,
      calibratedDirectionalProbability: null,
      walkForwardAccuracy: null,
      environmentAligned: true,
    }).tier).not.toBe('high');

    expect(calculateExpectation({
      score: 100,
      calibratedDirectionalProbability: 0.7,
      walkForwardAccuracy: null,
      environmentAligned: true,
    }).tier).not.toBe('high');
  });

  it('uses available walk-forward accuracy to avoid high expectation on weak stats', () => {
    expect(calculateExpectation({
      score: 70,
      calibratedDirectionalProbability: 0.57,
      walkForwardAccuracy: 0.519,
      environmentAligned: true,
    }).tier).toBe('medium');
  });

  it('generates a buy recommendation from aligned execution and environment signals', () => {
    const result = scanPair({
      pair: 'USDJPY',
      style: 'daytrade',
      executionBars: buyBars(),
      environmentBars: buyBars(),
      executionUpdatedAt: '2026-07-02T01:00:00.000Z',
      environmentUpdatedAt: '2026-07-02T00:30:00.000Z',
    });

    expect(result).not.toBeNull();
    expect(result?.direction).toBe('買い');
    expect(result?.style).toBe('デイトレ');
    expect(result?.score).toBeGreaterThanOrEqual(recommendationScoreThreshold);
    expect(result?.expectation.tier).not.toBe('high');
    expect(result?.riskReward).toBeGreaterThanOrEqual(1.2);
    expect(result?.dataUpdatedAt).toBe('2026-07-02T01:00:00.000Z');
  });

  it('generates a sell recommendation from aligned execution and environment signals', () => {
    const result = scanPair({
      pair: 'EURUSD',
      style: 'swing',
      executionBars: sellBars(),
      environmentBars: sellBars(),
    });

    expect(result).not.toBeNull();
    expect(result?.direction).toBe('売り');
    expect(result?.style).toBe('スイング');
    expect(result?.tpPrice).toBeLessThan(result?.entry.price ?? Number.POSITIVE_INFINITY);
    expect(result?.slPrice).toBeGreaterThan(result?.entry.price ?? 0);
  });

  it('returns null when no pair meets the minimum score', () => {
    const flatBars = barsFromCloses(Array(80).fill(100));

    expect(scanPair({
      pair: 'GBPJPY',
      style: 'daytrade',
      executionBars: flatBars,
      environmentBars: flatBars,
    })).toBeNull();
  });

  it('rejects a setup when the next resistance makes risk reward too small', () => {
    const bars = buyBars();
    bars[52] = {
      ...bars[52],
      h: 101.05,
      l: 98.95,
      c: 99.2,
    };

    expect(scanPair({
      pair: 'USDJPY',
      style: 'daytrade',
      executionBars: bars,
      environmentBars: buyBars(),
    })).toBeNull();
  });

  it('places the stop outside the nearest support or resistance buffer', () => {
    const bars = buyBars();
    bars[52] = {
      ...bars[52],
      h: 99.3,
      l: 98.8,
      c: 99.1,
    };

    const result = scanPair({
      pair: 'USDJPY',
      style: 'daytrade',
      executionBars: bars,
      environmentBars: buyBars(),
    });

    expect(result).not.toBeNull();
    expect(result?.direction).toBe('買い');
    expect(result?.slPrice).toBeLessThan(98.8);
  });
});

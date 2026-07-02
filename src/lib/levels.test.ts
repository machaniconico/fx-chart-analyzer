import { describe, expect, it } from 'vitest';
import { detectSupportResistanceLevels, findFractalSwings } from './levels';
import type { Bar } from '../types';

const flatBars = (length: number, close = 105): Bar[] =>
  Array.from({ length }, (_, index) => ({
    t: index * 3600,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: 1000,
  }));

const setSwingHigh = (bars: Bar[], index: number, price: number): void => {
  bars[index] = {
    ...bars[index],
    o: price - 1,
    h: price,
    l: price - 2,
    c: price - 0.8,
  };
};

const setSwingLow = (bars: Bar[], index: number, price: number): void => {
  bars[index] = {
    ...bars[index],
    o: price + 1,
    h: price + 2,
    l: price,
    c: price + 0.8,
  };
};

describe('levels', () => {
  it('detects fractal swing highs and lows', () => {
    const bars = flatBars(24);
    setSwingLow(bars, 8, 99.9);
    setSwingHigh(bars, 14, 110.1);

    const swings = findFractalSwings(bars, { pivotStrength: 2 });

    expect(swings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'low', index: 8, price: 99.9 }),
        expect.objectContaining({ kind: 'high', index: 14, price: 110.1 }),
      ]),
    );
  });

  it('clusters repeated swing points into known support and resistance levels', () => {
    const bars = flatBars(130, 105);
    [30, 60, 90].forEach((index, offset) => setSwingLow(bars, index, 99.96 + offset * 0.03));
    [40, 70, 100].forEach((index, offset) => setSwingHigh(bars, index, 110.04 - offset * 0.04));
    bars[129] = { ...bars[129], o: 105, h: 106, l: 104, c: 105.2 };

    const levels = detectSupportResistanceLevels(bars, {
      lookback: 120,
      pivotStrength: 2,
      toleranceAtrMultiplier: 0.7,
    });
    const support = levels.find((level) => level.direction === 'support' && Math.abs(level.price - 100) < 0.2);
    const resistance = levels.find((level) => level.direction === 'resistance' && Math.abs(level.price - 110) < 0.2);

    expect(support).toBeDefined();
    expect(support?.touches).toBe(3);
    expect(resistance).toBeDefined();
    expect(resistance?.touches).toBe(3);
  });

  it('scores equally touched recent levels above older levels', () => {
    const bars = flatBars(120, 105);
    [10, 24].forEach((index) => setSwingLow(bars, index, 100));
    [82, 98].forEach((index) => setSwingLow(bars, index, 98.1));

    const levels = detectSupportResistanceLevels(bars, {
      lookback: 120,
      pivotStrength: 2,
      toleranceAtrMultiplier: 0.5,
    });

    expect(levels[0].direction).toBe('support');
    expect(levels[0].price).toBeCloseTo(98.1, 1);
    expect(levels[0].strength).toBeGreaterThan(levels[1].strength);
  });

  it('returns at most the requested number of strongest levels', () => {
    const bars = flatBars(180, 105);
    for (let index = 20; index < 150; index += 10) {
      if (index % 20 === 0) {
        setSwingLow(bars, index, 95 + index / 20);
      } else {
        setSwingHigh(bars, index, 108 + index / 20);
      }
    }

    const levels = detectSupportResistanceLevels(bars, { maxLevels: 4, toleranceAtrMultiplier: 0.25 });

    expect(levels).toHaveLength(4);
  });
});

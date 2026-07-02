import { describe, expect, it } from 'vitest';
import { detectPatterns } from './patterns';
import type { Bar } from '../types';

const makeBar = (index: number, o: number, h: number, l: number, c: number): Bar => ({
  t: index * 3600,
  o,
  h,
  l,
  c,
  v: 1000,
});

const flatBars = (length: number, close = 105): Bar[] =>
  Array.from({ length }, (_, index) => makeBar(index, close - 0.3, close + 1, close - 1, close));

const ids = (bars: readonly Bar[]): string[] => detectPatterns(bars).map((pattern) => pattern.id);

const hasPattern = (bars: readonly Bar[], idBase: string): boolean =>
  ids(bars).some((id) => id.startsWith(idBase));

const setSwingHigh = (bars: Bar[], index: number, price: number): void => {
  bars[index] = makeBar(index, price - 1, price, price - 2, price - 0.8);
};

const setSwingLow = (bars: Bar[], index: number, price: number): void => {
  bars[index] = makeBar(index, price + 1, price + 2, price, price + 0.8);
};

describe('patterns candle detection', () => {
  it('detects bullish and bearish pin bars but ignores ordinary candles', () => {
    const bullish = flatBars(20);
    bullish[19] = makeBar(19, 101, 101.7, 98.4, 101.45);
    const bearish = flatBars(20);
    bearish[19] = makeBar(19, 101, 103.6, 100.8, 101.15);
    const ordinary = flatBars(20);
    ordinary[19] = makeBar(19, 101, 102, 100, 101.4);

    expect(hasPattern(bullish, 'pinbar-bullish')).toBe(true);
    expect(hasPattern(bearish, 'pinbar-bearish')).toBe(true);
    expect(hasPattern(ordinary, 'pinbar-')).toBe(false);
  });

  it('detects bullish and bearish engulfing candles but rejects non-engulfing bodies', () => {
    const bullish = flatBars(20);
    bullish[18] = makeBar(18, 102, 102.2, 100.8, 101);
    bullish[19] = makeBar(19, 100.7, 102.5, 100.5, 102.35);
    const bearish = flatBars(20);
    bearish[18] = makeBar(18, 101, 102.2, 100.8, 102);
    bearish[19] = makeBar(19, 102.3, 102.5, 100.5, 100.65);
    const rejected = flatBars(20);
    rejected[18] = makeBar(18, 102, 102.2, 100.8, 101);
    rejected[19] = makeBar(19, 101.2, 102.1, 101, 101.8);

    expect(hasPattern(bullish, 'engulfing-bullish')).toBe(true);
    expect(hasPattern(bearish, 'engulfing-bearish')).toBe(true);
    expect(hasPattern(rejected, 'engulfing-')).toBe(false);
  });

  it('detects doji candles but ignores larger real bodies', () => {
    const doji = flatBars(20);
    doji[19] = makeBar(19, 100, 101, 99, 100.03);
    const ordinary = flatBars(20);
    ordinary[19] = makeBar(19, 100, 101, 99, 100.6);

    expect(hasPattern(doji, 'doji')).toBe(true);
    expect(hasPattern(ordinary, 'doji')).toBe(false);
  });

  it('detects morning and evening stars but rejects incomplete reversals', () => {
    const morning = flatBars(24);
    morning[21] = makeBar(21, 105, 105.5, 99.5, 100);
    morning[22] = makeBar(22, 99.8, 100.5, 99.4, 100);
    morning[23] = makeBar(23, 100.2, 103.6, 100, 103.2);
    const evening = flatBars(24);
    evening[21] = makeBar(21, 100, 105.5, 99.5, 105);
    evening[22] = makeBar(22, 105.2, 105.7, 104.7, 105);
    evening[23] = makeBar(23, 104.8, 105, 101.4, 101.8);
    const rejected = flatBars(24);
    rejected[21] = makeBar(21, 105, 105.5, 99.5, 100);
    rejected[22] = makeBar(22, 99.8, 100.5, 99.4, 100);
    rejected[23] = makeBar(23, 100.2, 101.6, 100, 101.2);

    expect(hasPattern(morning, 'morning-star')).toBe(true);
    expect(hasPattern(evening, 'evening-star')).toBe(true);
    expect(hasPattern(rejected, 'morning-star')).toBe(false);
    expect(hasPattern(rejected, 'evening-star')).toBe(false);
  });

  it('only scans the configured recent window', () => {
    const bars = flatBars(160);
    bars[20] = makeBar(20, 101, 101.7, 98.4, 101.45);

    expect(detectPatterns(bars, { lookback: 40 }).some((pattern) => pattern.id.startsWith('pinbar-bullish'))).toBe(false);
  });
});

describe('patterns chart detection', () => {
  it('detects double tops and bottoms but rejects mismatched peaks', () => {
    const top = flatBars(50);
    setSwingHigh(top, 12, 110);
    setSwingLow(top, 18, 102);
    setSwingHigh(top, 25, 110.4);
    const bottom = flatBars(50);
    setSwingLow(bottom, 12, 100);
    setSwingHigh(bottom, 18, 108);
    setSwingLow(bottom, 25, 100.3);
    const rejected = flatBars(50);
    setSwingHigh(rejected, 12, 110);
    setSwingLow(rejected, 18, 102);
    setSwingHigh(rejected, 25, 114);

    expect(hasPattern(top, 'double-top')).toBe(true);
    expect(hasPattern(bottom, 'double-bottom')).toBe(true);
    expect(hasPattern(rejected, 'double-top')).toBe(false);
  });

  it('detects head-and-shoulders and inverse head-and-shoulders but rejects shallow heads', () => {
    const bearish = flatBars(60);
    setSwingHigh(bearish, 10, 110);
    setSwingLow(bearish, 16, 102);
    setSwingHigh(bearish, 22, 114);
    setSwingLow(bearish, 28, 102.4);
    setSwingHigh(bearish, 34, 110.5);
    const bullish = flatBars(60);
    setSwingLow(bullish, 10, 100);
    setSwingHigh(bullish, 16, 108);
    setSwingLow(bullish, 22, 96);
    setSwingHigh(bullish, 28, 107.7);
    setSwingLow(bullish, 34, 100.4);
    const rejected = flatBars(60);
    setSwingHigh(rejected, 10, 110);
    setSwingLow(rejected, 16, 102);
    setSwingHigh(rejected, 22, 111);
    setSwingLow(rejected, 28, 102.4);
    setSwingHigh(rejected, 34, 110.5);

    expect(hasPattern(bearish, 'head-shoulders')).toBe(true);
    expect(hasPattern(bullish, 'inverse-head-shoulders')).toBe(true);
    expect(hasPattern(rejected, 'head-shoulders')).toBe(false);
  });
});

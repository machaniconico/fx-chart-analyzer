import { describe, expect, it } from 'vitest';
import {
  atr,
  bollingerBands,
  donchian,
  ema,
  ichimoku,
  keltnerChannel,
  macd,
  rsi,
  sma,
  stochastic,
} from './indicators';

const expectNullableCloseTo = (
  actual: number | null,
  expected: number | null,
  precision = 5,
): void => {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  expect(actual as number).toBeCloseTo(expected, precision);
};

describe('indicators', () => {
  it('calculates SMA using a trailing window', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('calculates EMA seeded with the first SMA', () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('calculates Bollinger Bands with population standard deviation', () => {
    const bands = bollingerBands([1, 2, 3, 4, 5], 3, 2);
    expect(bands.middle).toEqual([null, null, 2, 3, 4]);
    const deviation = Math.sqrt(2 / 3) * 2;
    expectNullableCloseTo(bands.upper[2], 2 + deviation);
    expectNullableCloseTo(bands.lower[2], 2 - deviation);
    expectNullableCloseTo(bands.upper[4], 4 + deviation);
    expectNullableCloseTo(bands.lower[4], 4 - deviation);
  });

  it('calculates MT4/MT5-compatible ATR as a trailing SMA of True Range', () => {
    const highs = [11, 14, 13, 18, 16];
    const lows = [9, 11, 10, 13, 12];
    const closes = [10, 12, 11, 15, 14];
    const values = atr(highs, lows, closes, 3);

    expect(values.slice(0, 3)).toEqual([null, null, null]);
    expectNullableCloseTo(values[3], (4 + 3 + 7) / 3);
    expectNullableCloseTo(values[4], (3 + 7 + 4) / 3);
  });

  it('builds Keltner channels from the existing EMA and ATR implementations', () => {
    const highs = [11, 14, 13, 18, 16];
    const lows = [9, 11, 10, 13, 12];
    const closes = [10, 12, 11, 15, 14];
    const channel = keltnerChannel(highs, lows, closes, 3, 3, 2);

    expect(channel.middle.slice(0, 2)).toEqual([null, null]);
    expectNullableCloseTo(channel.middle[2], 11);
    expectNullableCloseTo(channel.middle[3], 13);
    expectNullableCloseTo(channel.upper[3], 13 + (14 / 3) * 2);
    expectNullableCloseTo(channel.lower[3], 13 - (14 / 3) * 2);
    expectNullableCloseTo(channel.upper[4], 13.5 + (14 / 3) * 2);
    expectNullableCloseTo(channel.lower[4], 13.5 - (14 / 3) * 2);
  });

  it('calculates Wilder RSI against published worksheet values', () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89,
      46.03, 45.61, 46.28, 46.28, 46, 46.03, 46.41, 46.22, 45.64, 46.21,
    ];
    const values = rsi(closes, 14);
    expectNullableCloseTo(values[14], 70.46, 2);
    expectNullableCloseTo(values[15], 66.25, 2);
    expectNullableCloseTo(values[16], 66.48, 2);
    expectNullableCloseTo(values[17], 69.35, 2);
    expectNullableCloseTo(values[18], 66.29, 2);
    expectNullableCloseTo(values[19], 57.92, 2);
    expectNullableCloseTo(values[20], 62.88, 2);
  });

  it('calculates MACD line, signal, and histogram', () => {
    const result = macd([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, 6, 3);
    expectNullableCloseTo(result.macd[5], 1.5);
    expectNullableCloseTo(result.macd[6], 1.5);
    expectNullableCloseTo(result.signal[7], 1.5);
    expectNullableCloseTo(result.histogram[7], 0);
  });

  it('calculates Donchian channels from the preceding bars only', () => {
    const result = donchian([10, 12, 11, 15, 14], [5, 7, 6, 8, 9], 2);

    expect(result.upper).toEqual([null, null, 12, 12, 15]);
    expect(result.lower).toEqual([null, null, 5, 6, 6]);
  });

  it('calculates slow stochastic %K and %D with numeric values', () => {
    const result = stochastic(
      [10, 10, 12, 12, 12],
      [0, 0, 0, 0, 0],
      [5, 5, 12, 0, 6],
      2,
      2,
      2,
    );

    expect(result.k).toEqual([null, null, 75, 50, 25]);
    expect(result.d).toEqual([null, null, null, 62.5, 37.5]);
  });

  it('uses 50 for flat stochastic ranges without producing NaN', () => {
    const result = stochastic([10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10], 2, 2, 1);

    expect(result.k).toEqual([null, 50, 50, 50]);
    expect(result.d).toEqual([null, null, 50, 50]);
    expect([...result.k, ...result.d].every((value) => value === null || Number.isFinite(value))).toBe(true);
  });

  it('calculates Ichimoku components with forward-displaced cloud spans', () => {
    const highs = Array.from({ length: 60 }, (_, index) => index + 1);
    const lows = Array.from({ length: 60 }, (_, index) => index);
    const result = ichimoku(highs, lows);

    expectNullableCloseTo(result.conversion[8], 4.5);
    expectNullableCloseTo(result.base[25], 13);
    expectNullableCloseTo(result.leadingSpanA[51], 17.25);
    expectNullableCloseTo(result.leadingSpanB[77], 26);
  });

  it('keeps a displaced cloud value independent from later bars', () => {
    const highs = Array.from({ length: 20 }, (_, index) => index + 11);
    const lows = highs.map((value) => value - 2);
    const options = {
      conversionPeriod: 2,
      basePeriod: 3,
      spanBPeriod: 4,
      displacement: 2,
    };
    const result = ichimoku(highs, lows, options);
    const changedLaterHighs = highs.map((value, index) => (index >= 9 ? value + 10_000 : value));
    const changedLaterLows = lows.map((value, index) => (index >= 9 ? value - 10_000 : value));
    const changedResult = ichimoku(changedLaterHighs, changedLaterLows, options);

    expect(changedResult.leadingSpanA[10]).toBe(result.leadingSpanA[10]);
    expect(changedResult.leadingSpanB[10]).toBe(result.leadingSpanB[10]);
  });
});

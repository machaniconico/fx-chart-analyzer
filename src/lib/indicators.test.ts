import { describe, expect, it } from 'vitest';
import { bollingerBands, ema, ichimoku, macd, rsi, sma } from './indicators';

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

  it('calculates Ichimoku components with forward-displaced cloud spans', () => {
    const highs = Array.from({ length: 60 }, (_, index) => index + 1);
    const lows = Array.from({ length: 60 }, (_, index) => index);
    const result = ichimoku(highs, lows);

    expectNullableCloseTo(result.conversion[8], 4.5);
    expectNullableCloseTo(result.base[25], 13);
    expectNullableCloseTo(result.leadingSpanA[51], 17.25);
    expectNullableCloseTo(result.leadingSpanB[77], 26);
  });
});

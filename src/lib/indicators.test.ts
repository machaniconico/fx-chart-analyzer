import { describe, expect, it } from 'vitest';
import {
  adx,
  atr,
  bollingerBands,
  cci,
  donchian,
  ema,
  ichimoku,
  keltnerChannel,
  macd,
  momentum,
  parabolicSar,
  rvi,
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

const makeSarNumericFixture = (): { highs: number[]; lows: number[] } => ({
  // Reversals at 2 and 3; the first-reversal-plus-100 exposure boundary is 102.
  highs: [
    10,
    11,
    12,
    13,
    ...Array.from({ length: 98 }, () => 13),
    30,
    32,
    34,
    35,
  ],
  lows: [
    8,
    9,
    10,
    8,
    ...Array.from({ length: 98 }, () => 10),
    15,
    16,
    17,
    18,
  ],
});

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

  it('calculates Lambert CCI from Typical Price and returns zero for flat windows', () => {
    const values = cci(
      [1, 2, 3, 6, 8],
      [1, 2, 3, 6, 8],
      [1, 2, 3, 6, 8],
      4,
    );

    expect(values.slice(0, 3)).toEqual([null, null, null]);
    expectNullableCloseTo(values[3], 133.33333333333334);
    expectNullableCloseTo(cci([10, 10, 10], [10, 10, 10], [10, 10, 10], 3)[2], 0);
  });

  it('calculates MetaTrader iMomentum values with a fail-closed warm-up', () => {
    const values = momentum([10, 11, 12, 8, 15, 20], 2);

    expect(values[0]).toBeNull();
    expect(values[1]).toBeNull();
    // Fixed measured doubles: keep the exact values to catch arithmetic drift.
    expect(values[2]).toBe(120);
    expect(values[3]).toBe(72.72727272727273);
    expect(values[4]).toBe(125);
    expect(values[5]).toBe(250);
  });

  it('fails closed for zero/non-finite momentum inputs and stays look-ahead invariant', () => {
    const closes = [0, 11, 12, Number.NaN, 15, 30];
    const values = momentum(closes, 2);
    expect(values[2]).toBeNull();
    expect(values[3]).toBeNull();
    expect(values[4]).toBe(125);
    expect(values[5]).toBeNull();

    // 入力は有限だが商が非有限になる経路 (1 / 5e-324 = Infinity) も null。
    expect(momentum([Number.MIN_VALUE, 1], 1)[1]).toBeNull();

    // 現在 close が 0 以下(欠損バー相当)は null =生成 MQL の close>0.0 ガードと対称。
    expect(momentum([10, 10, 0], 1)[2]).toBeNull();
    expect(momentum([10, 10, -5], 1)[2]).toBeNull();

    const base = momentum([10, 11, 12, 8, 15], 2);
    const withFuture = momentum([10, 11, 12, 8, 15, 1_000], 2);
    expect(withFuture.slice(0, base.length)).toEqual(base);
  });

  it('calculates MetaTrader RVI and signal values with exact weighted arithmetic', () => {
    const opens = [10, 10, 10, 10, 10, 10, 10, 10, 10];
    const highs = Array.from({ length: 9 }, () => 15);
    const lows = Array.from({ length: 9 }, () => 5);
    const closes = [10, 11, 9, 12, 10, 13, 11, 14, 12];
    const values = rvi(opens, highs, lows, closes, 2);

    // The explicit MT5 exposure boundary is period+3 for RVI and period+6
    // for the signal line; earlier internally-computable SWMAs stay hidden.
    expect(values.rvi.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(values.rvi[5]).toBe(0.075);
    expect(values.rvi[6]).toBe(0.125);
    expect(values.rvi[7]).toBe(0.175);
    expect(values.rvi[8]).toBe(0.225);
    expect(values.signal.slice(0, 8)).toEqual([null, null, null, null, null, null, null, null]);
    expect(values.signal[8]).toBe(0.15);
  });

  it('fails closed for RVI non-finite bars, zero range sums, and future data', () => {
    const opens = [10, 10, 10, 10, 10, 10, 10, 10, 10];
    const highs = Array.from({ length: 9 }, () => 15);
    const lows = Array.from({ length: 9 }, () => 5);
    const closes = [10, 11, 9, 12, 10, 13, 11, 14, 12];
    const base = rvi(opens, highs, lows, closes, 2);

    const invalidCloses = [...closes];
    invalidCloses[4] = Number.NaN;
    const invalid = rvi(opens, highs, lows, invalidCloses, 2);
    expect(invalid.rvi[5]).toBeNull();
    expect(invalid.signal[8]).toBeNull();

    const flat = rvi(opens, Array(9).fill(10), Array(9).fill(10), closes, 2);
    expect(flat.rvi[5]).toBeNull();
    expect(flat.rvi[8]).toBeNull();
    expect(flat.signal[8]).toBeNull();

    // A future shock points down so an implementation that reads past the
    // evaluated bar would be tempted to reverse the earlier result.
    // 未来バーの high/low は既存バーと異なる値にする: 分母(range)が全バー定数だと
    // highs/lows 側の look-ahead(highs[i+1] 参照など)が結果に現れず素通りする
    // (レビュー実測: 定数 highs では覗いても rvi[8] 同値、未来 high=60 で分岐)。
    const withFuture = rvi(
      [...opens, 10],
      [...highs, 60],
      [...lows, 4],
      [...closes, -90],
      2,
    );
    expect(withFuture.rvi.slice(0, base.rvi.length)).toEqual(base.rvi);
    expect(withFuture.signal.slice(0, base.signal.length)).toEqual(base.signal);
  });

  it('calculates MetaTrader iADX EMA buffers with staged warm-up and safe zero divisions', () => {
    const result = adx(
      [10, 9, 10, 9, 10],
      [10, 9, 10, 9, 10],
      [10, 9, 10, 9, 10],
      2,
    );

    expect(result.plusDi.slice(0, 2)).toEqual([null, null]);
    expect(result.minusDi.slice(0, 2)).toEqual([null, null]);
    expect(result.adx.slice(0, 4)).toEqual([null, null, null, null]);
    expectNullableCloseTo(result.plusDi[2], 200 / 3);
    expectNullableCloseTo(result.plusDi[3], 200 / 9);
    expectNullableCloseTo(result.minusDi[3], 2000 / 27);
    expect(result.adx[4]).toBe(51.47198480531814);

    const flat = adx([10, 10, 10], [10, 10, 10], [10, 10, 10], 1);
    expect(flat.plusDi).toEqual([null, 0, 0]);
    expect(flat.minusDi).toEqual([null, 0, 0]);
    expect(flat.adx).toEqual([null, null, 0]);
  });

  it('calculates MetaTrader iSAR flips with AF acceleration and the two-bar EP clamp', () => {
    const { highs, lows } = makeSarNumericFixture();
    const result = parabolicSar(highs, lows, 0.1, 0.3);

    // The seed and first two reversals stay fail-closed. The first exposed bar
    // is index 102: first reversal 2 + 100 bars, with two reversals observed.
    expect(result.sar[101]).toBeNull();
    expect(result.isLong[101]).toBeNull();
    expect(result.isLong[102]).toBe(true);
    expect(result.sar[102]).toBe(8);

    // At 103 the raw 10.2 is clamped to min(Low[102], Low[101]) = 10.
    // High[103] is a new EP, so AF accelerates to 0.2 and SAR[104] is 14.4.
    // The next AF step reaches 0.3; raw SAR[105]=20.28 is clamped to
    // min(Low[104], Low[103]) = 16.
    expect(result.sar[103]).toBe(10);
    expect(result.sar[104]).toBe(14.4);
    expect(result.sar[105]).toBe(16);

    // High[1] equals the initial SHORT SAR, so strict '<' must not reverse at
    // index 1. A '<=' mutation shifts the first reversal to index 3 and keeps
    // the boundary at index 102 null, killing the equality-boundary mutation.
    // maximum===step is valid because only maximum<step is invalid.
    expect(highs[1]).toBe(11);
    expect(result.sar[102]).toBe(8);
    expect(parabolicSar(highs, lows, 0.1, 0.1).sar[102]).toBe(8);
  });

  it('requires two reversals and the full 100-bar conservative warm-up', () => {
    const oneReversalHighs = Array.from({ length: 106 }, (_, index) => 10 + index);
    const oneReversalLows = Array.from({ length: 106 }, () => 8);
    const oneReversal = parabolicSar(oneReversalHighs, oneReversalLows, 0.1, 0.3);
    expect(oneReversal.sar.every((value) => value === null)).toBe(true);
    expect(oneReversal.isLong.every((value) => value === null)).toBe(true);

    const lateSecondHighs = Array.from({ length: 125 }, (_, index) => 10 + index);
    const lateSecondLows = Array.from({ length: 125 }, () => 8);
    lateSecondLows[120] = 0;
    const lateSecond = parabolicSar(lateSecondHighs, lateSecondLows, 0.1, 0.3);
    expect(lateSecond.sar[101]).toBeNull();
    expect(lateSecond.sar[102]).toBeNull();
    expect(lateSecond.sar[119]).toBeNull();
    expect(lateSecond.sar[120]).not.toBeNull();
    expect(lateSecond.isLong[120]).toBe(false);
  });

  it('keeps the complete SAR prefix unchanged when future bars are appended', () => {
    const { highs, lows } = makeSarNumericFixture();
    const base = parabolicSar(highs, lows, 0.1, 0.3);
    const withFuture = parabolicSar(
      [...highs, 1_000],
      [...lows, -1_000],
      0.1,
      0.3,
    );

    expect(withFuture.sar.slice(0, highs.length)).toEqual(base.sar);
    expect(withFuture.isLong.slice(0, highs.length)).toEqual(base.isLong);
  });

  it('fails closed for invalid iSAR parameters, non-finite prices, and short input', () => {
    const highs = [10, 11, 12, 13];
    const lows = [8, 9, 10, 11];
    const allNull = (values: readonly (number | boolean | null)[]): boolean =>
      values.every((value) => value === null);

    for (const [step, maximum] of [
      [0, 0.2],
      [-0.1, 0.2],
      [Number.NaN, 0.2],
      [0.2, 0.1],
      [0.1, Number.POSITIVE_INFINITY],
    ]) {
      const result = parabolicSar(highs, lows, step, maximum);
      expect(allNull(result.sar)).toBe(true);
      expect(allNull(result.isLong)).toBe(true);
    }

    const invalidPriceResult = parabolicSar([10, Number.NaN, 12, 13], lows, 0.1, 0.2);
    expect(allNull(invalidPriceResult.sar)).toBe(true);
    expect(allNull(invalidPriceResult.isLong)).toBe(true);
    const { highs: validHighs, lows: validLows } = makeSarNumericFixture();
    const invalidFutureHighs = [...validHighs];
    invalidFutureHighs[105] = Number.NaN;
    const invalidFutureResult = parabolicSar(invalidFutureHighs, validLows, 0.1, 0.3);
    expect(invalidFutureResult.sar[102]).toBe(8);
    expect(invalidFutureResult.sar[104]).toBe(14.4);
    expect(invalidFutureResult.sar[105]).toBeNull();
    expect(parabolicSar([10, 11], [8, 9], 0.1, 0.2).sar).toEqual([null, null]);
    expect(() => parabolicSar([1, 2], [1], 0.1, 0.2)).toThrow(
      'highs and lows must have the same length',
    );
  });

  it('rejects ADX input arrays with different lengths', () => {
    expect(() => adx([1, 2], [1], [1, 2], 2)).toThrow(
      'highs, lows, and closes must have the same length',
    );
  });

  it('rejects CCI input arrays with different lengths', () => {
    expect(() => cci([1, 2], [1], [1, 2], 2)).toThrow(
      'highs, lows, and closes must have the same length',
    );
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

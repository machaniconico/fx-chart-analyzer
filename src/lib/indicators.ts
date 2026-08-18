export type IndicatorPoint = number | null;

export interface BollingerBands {
  middle: IndicatorPoint[];
  upper: IndicatorPoint[];
  lower: IndicatorPoint[];
}

export interface KeltnerChannel {
  middle: IndicatorPoint[];
  upper: IndicatorPoint[];
  lower: IndicatorPoint[];
}

export interface MacdResult {
  macd: IndicatorPoint[];
  signal: IndicatorPoint[];
  histogram: IndicatorPoint[];
}

export interface DonchianResult {
  upper: IndicatorPoint[];
  lower: IndicatorPoint[];
}

export interface StochasticResult {
  k: IndicatorPoint[];
  d: IndicatorPoint[];
}

export interface AdxResult {
  plusDi: IndicatorPoint[];
  minusDi: IndicatorPoint[];
  adx: IndicatorPoint[];
}

export interface ParabolicSarResult {
  sar: IndicatorPoint[];
  isLong: Array<boolean | null>;
}

export interface IchimokuResult {
  conversion: IndicatorPoint[];
  base: IndicatorPoint[];
  leadingSpanA: IndicatorPoint[];
  leadingSpanB: IndicatorPoint[];
}

export interface IchimokuOptions {
  conversionPeriod?: number;
  basePeriod?: number;
  spanBPeriod?: number;
  displacement?: number;
}

const assertPeriod = (period: number): void => {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`period must be a positive integer: ${period}`);
  }
};

export const sma = (values: readonly number[], period: number): IndicatorPoint[] => {
  assertPeriod(period);
  const result: IndicatorPoint[] = Array(values.length).fill(null);
  let sum = 0;

  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
    }
    if (i >= period - 1) {
      result[i] = sum / period;
    }
  }

  return result;
};

export const ema = (values: readonly number[], period: number): IndicatorPoint[] => {
  assertPeriod(period);
  const result: IndicatorPoint[] = Array(values.length).fill(null);
  if (values.length < period) {
    return result;
  }

  const alpha = 2 / (period + 1);
  let previous = 0;
  for (let i = 0; i < period; i += 1) {
    previous += values[i];
  }
  previous /= period;
  result[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    previous = values[i] * alpha + previous * (1 - alpha);
    result[i] = previous;
  }

  return result;
};

const emaFromNullable = (values: readonly IndicatorPoint[], period: number): IndicatorPoint[] => {
  assertPeriod(period);
  const result: IndicatorPoint[] = Array(values.length).fill(null);
  const alpha = 2 / (period + 1);
  const seed: number[] = [];
  let previous: number | null = null;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === null) {
      continue;
    }

    if (previous === null) {
      seed.push(value);
      if (seed.length === period) {
        previous = seed.reduce((sum, item) => sum + item, 0) / period;
        result[i] = previous;
      }
      continue;
    }

    previous = value * alpha + previous * (1 - alpha);
    result[i] = previous;
  }

  return result;
};

const smaFromNullable = (values: readonly IndicatorPoint[], period: number): IndicatorPoint[] => {
  assertPeriod(period);
  const result: IndicatorPoint[] = Array(values.length).fill(null);
  const window: number[] = [];
  let sum = 0;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === null) {
      window.length = 0;
      sum = 0;
      continue;
    }

    window.push(value);
    sum += value;
    if (window.length > period) {
      sum -= window.shift() as number;
    }
    if (window.length === period) {
      result[i] = sum / period;
    }
  }

  return result;
};

export const bollingerBands = (
  values: readonly number[],
  period: number,
  multiplier = 2,
): BollingerBands => {
  assertPeriod(period);
  const middle = sma(values, period);
  const upper: IndicatorPoint[] = Array(values.length).fill(null);
  const lower: IndicatorPoint[] = Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i += 1) {
    const mean = middle[i];
    if (mean === null) {
      continue;
    }
    let variance = 0;
    for (let offset = i - period + 1; offset <= i; offset += 1) {
      variance += (values[offset] - mean) ** 2;
    }
    const deviation = Math.sqrt(variance / period);
    upper[i] = mean + multiplier * deviation;
    lower[i] = mean - multiplier * deviation;
  }

  return { middle, upper, lower };
};

/**
 * MT4/MT5 iATR parity: calculate True Range from the current high/low and
 * previous close, then apply a trailing Simple Moving Average. MetaQuotes'
 * official MQL5 ATR article explicitly defines ATR as SMA(TR), and the MT4
 * standard ATR.mq4 / MetaQuotes MT5 standard ATR source use the same
 * rolling-SMA recurrence; this is intentionally not Wilder/SMMA smoothing.
 * References: https://www.mql5.com/en/articles/16931,
 * https://www.mql5.com/en/docs/indicators/iatr,
 * https://www.mql5.com/en/code/42407 (states the built-in ATR averages TR
 * with a simple moving average, which is why a separate Wilder variant exists)
 *
 * The first bar has no previous close, so the first ready ATR is at index
 * `period` (matches the MT5 standard ATR seed; MT4's ATR.mq4 seeds the oldest
 * bar's TR as High-Low, so it becomes ready one bar earlier with a slightly
 * different value inside the oldest `period` bars only).
 */
export const atr = (
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period: number,
): IndicatorPoint[] => {
  assertPeriod(period);
  if (highs.length !== lows.length || highs.length !== closes.length) {
    throw new Error('highs, lows, and closes must have the same length');
  }

  const trueRanges: IndicatorPoint[] = Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i += 1) {
    const high = highs[i];
    const low = lows[i];
    const previousClose = closes[i - 1];
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(previousClose)) {
      continue;
    }
    trueRanges[i] = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose),
    );
  }

  return smaFromNullable(trueRanges, period);
};

// バンド式の単一定義。keltnerChannel と strategy 側のメモ化評価器の両方がここを
// 通ることで、middle ± multiplier*ATR の式が二重実装ドリフトしないようにする。
export const keltnerBandsFrom = (
  middle: readonly IndicatorPoint[],
  atrValues: readonly IndicatorPoint[],
  multiplier: number,
): KeltnerChannel => {
  const length = middle.length;
  const upper: IndicatorPoint[] = Array(length).fill(null);
  const lower: IndicatorPoint[] = Array(length).fill(null);

  if (!Number.isFinite(multiplier)) {
    return { middle: [...middle], upper, lower };
  }

  for (let i = 0; i < length; i += 1) {
    const middleValue = middle[i];
    const atrValue = atrValues[i];
    if (
      typeof middleValue !== 'number' ||
      !Number.isFinite(middleValue) ||
      typeof atrValue !== 'number' ||
      !Number.isFinite(atrValue)
    ) {
      continue;
    }
    upper[i] = middleValue + multiplier * atrValue;
    lower[i] = middleValue - multiplier * atrValue;
  }

  return { middle: [...middle], upper, lower };
};

export const keltnerChannel = (
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  emaPeriod: number,
  atrPeriod: number,
  multiplier = 2,
): KeltnerChannel => {
  const middle = ema(closes, emaPeriod);
  const volatility = atr(highs, lows, closes, atrPeriod);
  return keltnerBandsFrom(middle, volatility, multiplier);
};

export const rsi = (values: readonly number[], period = 14): IndicatorPoint[] => {
  assertPeriod(period);
  const result: IndicatorPoint[] = Array(values.length).fill(null);
  if (values.length <= period) {
    return result;
  }

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  const toRsi = (): number => {
    if (averageLoss === 0 && averageGain === 0) {
      return 50;
    }
    if (averageLoss === 0) {
      return 100;
    }
    const relativeStrength = averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
  };

  result[period] = toRsi();

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    result[i] = toRsi();
  }

  return result;
};

/**
 * MetaTrader iMomentum parity: Momentum[i] = Close[i] / Close[i-period] * 100.
 * Primary source (MetaTrader 5 terminal help, verbatim: "MOMENTUM = CLOSE (i)
 * / CLOSE (i - n) * 100" / "CLOSE (i - n) — close price n bars ago"):
 * https://www.metatrader5.com/en/terminal/help/indicators/oscillators/momentum
 * (the MQL5 iMomentum API reference documents only the function signature,
 * not the formula.)
 *
 * The first `period` bars are null as a fail-closed warm-up. A zero or
 * non-finite denominator/current close also produces null. Unlike path-
 * dependent SAR, there is no state to converge: once warmed up, full-history
 * and backtest-window calculations agree immediately.
 */
export const momentum = (closes: readonly number[], period: number): IndicatorPoint[] => {
  assertPeriod(period);
  const result: IndicatorPoint[] = Array(closes.length).fill(null);

  for (let i = period; i < closes.length; i += 1) {
    const close = closes[i];
    const previousClose = closes[i - period];
    // 生成 MQL の `close > 0.0 && previousClose > 0.0` データギャップガードと
    // 同一意味論(close<=0 で TS だけがシグナルを出す非対称を防ぐ)。
    if (
      !Number.isFinite(close) ||
      !Number.isFinite(previousClose) ||
      close <= 0 ||
      previousClose <= 0
    ) {
      continue;
    }

    const value = (close / previousClose) * 100;
    if (Number.isFinite(value)) {
      result[i] = value;
    }
  }

  return result;
};

/**
 * Lambert CCI using Typical Price, an SMA of Typical Price, and the mean
 * absolute deviation from that same current-bar SMA.
 *
 * MetaQuotes' official CCI reference documents Typical Price, SMA, mean
 * absolute deviation, and Lambert's 0.015 factor. A zero mean-deviation
 * window is represented as 0.0 as a parity design choice for MT5 built-in
 * behavior; positive levels therefore keep flat windows fail-closed.
 * Reference: https://www.mql5.com/en/code/18
 */
export const cci = (
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period: number,
): IndicatorPoint[] => {
  assertPeriod(period);
  if (highs.length !== lows.length || highs.length !== closes.length) {
    throw new Error('highs, lows, and closes must have the same length');
  }

  const result: IndicatorPoint[] = Array(closes.length).fill(null);
  const typicalPrices: IndicatorPoint[] = closes.map((_, index) => {
    const high = highs[index];
    const low = lows[index];
    const close = closes[index];
    return Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close)
      ? (high + low + close) / 3
      : null;
  });

  for (let i = period - 1; i < closes.length; i += 1) {
    const start = i - period + 1;
    let sum = 0;
    let current: number | null = null;
    let validWindow = true;

    for (let j = start; j <= i; j += 1) {
      const value = typicalPrices[j];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        validWindow = false;
        break;
      }
      sum += value;
      if (j === i) {
        current = value;
      }
    }

    if (!validWindow || current === null) {
      continue;
    }

    const mean = sum / period;
    let deviationSum = 0;
    for (let j = start; j <= i; j += 1) {
      deviationSum += Math.abs((typicalPrices[j] as number) - mean);
    }
    const meanDeviation = deviationSum / period;
    result[i] = meanDeviation === 0 ? 0 : (current - mean) / (0.015 * meanDeviation);
  }

  return result;
};

/**
 * MetaTrader 5 iADX parity (intentionally not iADXWilder).
 *
 * This follows MetaQuotes' official MQL5 CodeBase ADX.mq5 reference
 * implementation: +DM/-DM are first normalized by the current True Range,
 * +DI and -DI are then EMA-smoothed with alpha=2/(period+1), and ADX is an
 * EMA of DX = 100 * abs((+DI - -DI) / (+DI + -DI)). The reference's tie rule
 * discards both directional movements when +DM and -DM are equal. This is
 * different from the official iADXWilder reference, which uses SMMA for the
 * directional movements, ATR/DI values, and ADX. See:
 * https://www.mql5.com/en/docs/indicators/iadx
 * https://www.mql5.com/en/code/7
 * https://www.mql5.com/en/code/8
 *
 * The EMA state is seeded with zero as in ADX.mq5. MetaTrader's
 * PLOT_DRAW_BEGIN is a chart-drawing setting; it does not make CopyBuffer
 * return null, so the null warm-up below is an intentional fail-closed
 * deviation made by this project. We expose DI from index `period` and ADX
 * from index `period * 2` so the evaluator never consumes an un-warmed value.
 * If TR or +DI+-DI is zero, the corresponding normalized value is defined as
 * 0.0 (safe-side behavior, matching the project's other indicators instead
 * of emitting NaN/Infinity). Invalid input starts a fresh finite segment and
 * remains null until that segment has warmed up again.
 */
export const adx = (
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period: number,
): AdxResult => {
  assertPeriod(period);
  if (highs.length !== lows.length || highs.length !== closes.length) {
    throw new Error('highs, lows, and closes must have the same length');
  }

  const plusDi: IndicatorPoint[] = Array(closes.length).fill(null);
  const minusDi: IndicatorPoint[] = Array(closes.length).fill(null);
  const adxValues: IndicatorPoint[] = Array(closes.length).fill(null);
  const alpha = 2 / (period + 1);
  const decay = 1 - alpha;
  let previousPlusDi = 0;
  let previousMinusDi = 0;
  let previousAdx = 0;
  let validBars = 0;

  for (let i = 1; i < closes.length; i += 1) {
    const high = highs[i];
    const previousHigh = highs[i - 1];
    const low = lows[i];
    const previousLow = lows[i - 1];
    const close = closes[i];
    const previousClose = closes[i - 1];
    if (
      !Number.isFinite(high) ||
      !Number.isFinite(previousHigh) ||
      !Number.isFinite(low) ||
      !Number.isFinite(previousLow) ||
      !Number.isFinite(close) ||
      !Number.isFinite(previousClose)
    ) {
      previousPlusDi = 0;
      previousMinusDi = 0;
      previousAdx = 0;
      validBars = 0;
      continue;
    }

    let positiveMovement = high - previousHigh;
    let negativeMovement = previousLow - low;
    if (!Number.isFinite(positiveMovement) || !Number.isFinite(negativeMovement)) {
      previousPlusDi = 0;
      previousMinusDi = 0;
      previousAdx = 0;
      validBars = 0;
      continue;
    }
    positiveMovement = Math.max(positiveMovement, 0);
    negativeMovement = Math.max(negativeMovement, 0);
    if (positiveMovement > negativeMovement) {
      negativeMovement = 0;
    } else if (negativeMovement > positiveMovement) {
      positiveMovement = 0;
    } else {
      positiveMovement = 0;
      negativeMovement = 0;
    }

    const trueRange = Math.max(
      Math.abs(high - low),
      Math.abs(high - previousClose),
      Math.abs(low - previousClose),
    );
    if (!Number.isFinite(trueRange)) {
      previousPlusDi = 0;
      previousMinusDi = 0;
      previousAdx = 0;
      validBars = 0;
      continue;
    }

    // MetaTrader's reference sets both normalized movements to zero for TR=0.
    const rawPlusDi = trueRange === 0 ? 0 : (100 * positiveMovement) / trueRange;
    const rawMinusDi = trueRange === 0 ? 0 : (100 * negativeMovement) / trueRange;
    const currentPlusDi = rawPlusDi * alpha + previousPlusDi * decay;
    const currentMinusDi = rawMinusDi * alpha + previousMinusDi * decay;
    const diSum = currentPlusDi + currentMinusDi;
    // A zero DI sum is a non-directional bar; define DX as 0 instead of NaN.
    const dx = diSum === 0 ? 0 : 100 * Math.abs((currentPlusDi - currentMinusDi) / diSum);
    const currentAdx = dx * alpha + previousAdx * decay;
    if (
      !Number.isFinite(rawPlusDi) ||
      !Number.isFinite(rawMinusDi) ||
      !Number.isFinite(currentPlusDi) ||
      !Number.isFinite(currentMinusDi) ||
      !Number.isFinite(dx) ||
      !Number.isFinite(currentAdx)
    ) {
      previousPlusDi = 0;
      previousMinusDi = 0;
      previousAdx = 0;
      validBars = 0;
      continue;
    }

    validBars += 1;
    if (validBars >= period) {
      plusDi[i] = currentPlusDi;
      minusDi[i] = currentMinusDi;
    }
    if (validBars >= period * 2) {
      adxValues[i] = currentAdx;
    }
    previousPlusDi = currentPlusDi;
    previousMinusDi = currentMinusDi;
    previousAdx = currentAdx;
  }

  return { plusDi, minusDi, adx: adxValues };
};

/**
 * MetaTrader 5 iSAR parity, based on MetaQuotes' ParabolicSAR.mq5 reference
 * implementation in the MQL5 CodeBase (https://www.mql5.com/en/code/43).
 *
 * The reference seeds the first pass as SHORT, with SAR[0]=High[0],
 * SAR[1]=max(High[0], High[1]), EP[0..1]=Low[1], and AF[0..1]=step. On each
 * bar it checks reversal before updating EP/AF; a reversal replaces SAR with
 * the extreme since the previous reversal and resets EP/AF. A new EP then
 * increases AF by step up to maximum. The next SAR is clamped to the most
 * recent two lows in a long trend (or highs in a short trend). Those ordering
 * details are the MT5 parity points that differ from many textbook PSAR
 * implementations. The reference's source contains GetHigh/GetLow for the
 * reversal seed and the two-bar clamp at lines 241-315 of that file.
 *
 * SAR is path-dependent: a short backtest window and an EA seeded from full
 * history can diverge in their prefix. A reversal reduces that divergence, but
 * the reversal value itself uses the window from the previous reversal, whose
 * position is also path-dependent; convergence is therefore empirical and
 * asymptotic, not a deterministic synchronization point. Measured on this
 * repo's real market data (6 pairs x 5 timeframes, truncated windows vs full
 * history, first-reversal exposure), the permanent-convergence tail was
 * p50=7, p99=103, max=240 bars; a synthetic 500-series probe gave p99=63,
 * max=109. The warm-up below targets roughly the real-data p99, NOT the
 * observed maximum: with the gate, the residual false-signal rate is 0.0067%
 * overall (0.0028% at the default 0.02/0.2, worst 0.0577% at slow-AF
 * 0.01/0.1 - residual risk grows as step shrinks, hence the registration-time
 * step floor in the pipeline validator).
 * We consequently expose a point only after at least two observed reversals
 * and SAR_CONVERGENCE_WARMUP_BARS bars from the first reversal (fail-closed
 * warm-up). A final-bar
 * reversal is processed causally here so appending future bars cannot revise an
 * earlier signal.
 * Invalid parameters return all-null output. A non-finite price at the seed
 * returns all-null; one later in the series terminates output at that bar, so
 * an invalid future cannot erase an already observed finite signal.
 */
// 実データ計測の恒久収束 p99≒103 バーを狙った保守値(max=240 はカバーしない=詳細は上記docコメント)
export const SAR_CONVERGENCE_WARMUP_BARS = 100;

// 実データ計測で step=0.01 は既定値 step=0.02 の20倍の誤シグナル率だった(step が
// 小さいほどウォームアップ後の残存乖離が増え、直上の SAR_CONVERGENCE_WARMUP_BARS
// の前提が崩れる)ため、登録時の下限を一元化する。
export const SAR_MIN_STEP = 0.02;

export const parabolicSar = (
  highs: readonly number[],
  lows: readonly number[],
  step: number,
  maximum: number,
): ParabolicSarResult => {
  if (highs.length !== lows.length) {
    throw new Error('highs and lows must have the same length');
  }

  const sar: IndicatorPoint[] = Array(highs.length).fill(null);
  const isLong: Array<boolean | null> = Array(highs.length).fill(null);
  if (
    !Number.isFinite(step) ||
    step <= 0 ||
    !Number.isFinite(maximum) ||
    maximum < step
  ) {
    return { sar, isLong };
  }

  if (highs.length < 3) {
    return { sar, isLong };
  }
  if (
    !Number.isFinite(highs[0]) ||
    !Number.isFinite(lows[0]) ||
    !Number.isFinite(highs[1]) ||
    !Number.isFinite(lows[1])
  ) {
    return { sar, isLong };
  }

  const rawSar = Array<number>(highs.length).fill(0);
  const rawIsLong = Array<boolean>(highs.length).fill(false);
  const extremePoint = Array<number>(highs.length).fill(0);
  const accelerationFactor = Array<number>(highs.length).fill(0);

  const highestSince = (start: number, end: number): number => {
    let result = highs[start];
    for (let i = start + 1; i <= end; i += 1) {
      if (highs[i] > result) {
        result = highs[i];
      }
    }
    return result;
  };

  const lowestSince = (start: number, end: number): number => {
    let result = lows[start];
    for (let i = start + 1; i <= end; i += 1) {
      if (lows[i] < result) {
        result = lows[i];
      }
    }
    return result;
  };

  // Match the first-pass state in MetaQuotes' reference source.
  let directionLong = false;
  let lastReversalPosition = 0;
  let firstReversalPosition: number | null = null;
  let secondReversalPosition: number | null = null;
  let lastCalculablePosition = highs.length - 1;
  accelerationFactor[0] = step;
  accelerationFactor[1] = step;
  rawSar[0] = highs[0];
  rawSar[1] = highestSince(0, 1);
  extremePoint[0] = lows[1];
  extremePoint[1] = lows[1];
  rawIsLong[0] = false;
  rawIsLong[1] = false;

  for (let i = 1; i < highs.length; i += 1) {
    if (!Number.isFinite(highs[i]) || !Number.isFinite(lows[i])) {
      lastCalculablePosition = i - 1;
      break;
    }

    // Reversal is deliberately checked before EP/AF updates, as in MQL5.
    if (directionLong && rawSar[i] > lows[i]) {
      directionLong = false;
      rawSar[i] = highestSince(lastReversalPosition, i);
      extremePoint[i] = lows[i];
      lastReversalPosition = i;
      accelerationFactor[i] = step;
      if (firstReversalPosition === null) {
        firstReversalPosition = i;
      } else {
        secondReversalPosition ??= i;
      }
    } else if (!directionLong && rawSar[i] < highs[i]) {
      directionLong = true;
      rawSar[i] = lowestSince(lastReversalPosition, i);
      extremePoint[i] = highs[i];
      lastReversalPosition = i;
      accelerationFactor[i] = step;
      if (firstReversalPosition === null) {
        firstReversalPosition = i;
      } else {
        secondReversalPosition ??= i;
      }
    }

    rawIsLong[i] = directionLong;
    if (directionLong) {
      if (highs[i] > extremePoint[i - 1] && i !== lastReversalPosition) {
        extremePoint[i] = highs[i];
        accelerationFactor[i] = Math.min(
          accelerationFactor[i - 1] + step,
          maximum,
        );
      } else if (i !== lastReversalPosition) {
        extremePoint[i] = extremePoint[i - 1];
        accelerationFactor[i] = accelerationFactor[i - 1];
      }

      if (i + 1 < highs.length) {
        rawSar[i + 1] =
          rawSar[i] + accelerationFactor[i] * (extremePoint[i] - rawSar[i]);
        if (rawSar[i + 1] > lows[i] || rawSar[i + 1] > lows[i - 1]) {
          rawSar[i + 1] = Math.min(lows[i], lows[i - 1]);
        }
      }
    } else {
      if (lows[i] < extremePoint[i - 1] && i !== lastReversalPosition) {
        extremePoint[i] = lows[i];
        accelerationFactor[i] = Math.min(
          accelerationFactor[i - 1] + step,
          maximum,
        );
      } else if (i !== lastReversalPosition) {
        extremePoint[i] = extremePoint[i - 1];
        accelerationFactor[i] = accelerationFactor[i - 1];
      }

      if (i + 1 < highs.length) {
        rawSar[i + 1] =
          rawSar[i] + accelerationFactor[i] * (extremePoint[i] - rawSar[i]);
        if (rawSar[i + 1] < highs[i] || rawSar[i + 1] < highs[i - 1]) {
          rawSar[i + 1] = Math.max(highs[i], highs[i - 1]);
        }
      }
    }
  }

  if (firstReversalPosition === null || secondReversalPosition === null) {
    return { sar, isLong };
  }
  const exposureStart = Math.max(
    firstReversalPosition + SAR_CONVERGENCE_WARMUP_BARS,
    secondReversalPosition,
  );
  for (let i = exposureStart; i <= lastCalculablePosition; i += 1) {
    sar[i] = rawSar[i];
    isLong[i] = rawIsLong[i];
  }
  return { sar, isLong };
};

export const macd = (
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult => {
  assertPeriod(fastPeriod);
  assertPeriod(slowPeriod);
  assertPeriod(signalPeriod);
  if (fastPeriod >= slowPeriod) {
    throw new Error('fastPeriod must be smaller than slowPeriod');
  }

  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdLine: IndicatorPoint[] = values.map((_, index) => {
    const fastValue = fast[index];
    const slowValue = slow[index];
    return fastValue === null || slowValue === null ? null : fastValue - slowValue;
  });
  const signal = emaFromNullable(macdLine, signalPeriod);
  const histogram = macdLine.map((value, index) => {
    const signalValue = signal[index];
    return value === null || signalValue === null ? null : value - signalValue;
  });

  return { macd: macdLine, signal, histogram };
};

export const donchian = (
  highs: readonly number[],
  lows: readonly number[],
  period: number,
): DonchianResult => {
  assertPeriod(period);
  if (highs.length !== lows.length) {
    throw new Error('highs and lows must have the same length');
  }

  const upper: IndicatorPoint[] = Array(highs.length).fill(null);
  const lower: IndicatorPoint[] = Array(highs.length).fill(null);
  for (let i = period; i < highs.length; i += 1) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let offset = i - period; offset < i; offset += 1) {
      highest = Math.max(highest, highs[offset]);
      lowest = Math.min(lowest, lows[offset]);
    }
    upper[i] = highest;
    lower[i] = lowest;
  }

  return { upper, lower };
};

export const stochastic = (
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  kPeriod: number,
  dPeriod: number,
  smoothing: number,
): StochasticResult => {
  assertPeriod(kPeriod);
  assertPeriod(dPeriod);
  assertPeriod(smoothing);
  if (highs.length !== lows.length || highs.length !== closes.length) {
    throw new Error('highs, lows, and closes must have the same length');
  }

  const rawK: IndicatorPoint[] = Array(closes.length).fill(null);
  for (let i = kPeriod - 1; i < closes.length; i += 1) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let offset = i - kPeriod + 1; offset <= i; offset += 1) {
      highest = Math.max(highest, highs[offset]);
      lowest = Math.min(lowest, lows[offset]);
    }

    const range = highest - lowest;
    rawK[i] = range === 0 ? 50 : ((closes[i] - lowest) / range) * 100;
  }

  const k = smaFromNullable(rawK, smoothing);
  const d = smaFromNullable(k, dPeriod);
  return { k, d };
};

const midpoint = (
  highs: readonly number[],
  lows: readonly number[],
  endIndex: number,
  period: number,
): number | null => {
  if (endIndex < period - 1) {
    return null;
  }
  let high = -Infinity;
  let low = Infinity;
  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    high = Math.max(high, highs[i]);
    low = Math.min(low, lows[i]);
  }
  return (high + low) / 2;
};

export const ichimoku = (
  highs: readonly number[],
  lows: readonly number[],
  options: IchimokuOptions = {},
): IchimokuResult => {
  if (highs.length !== lows.length) {
    throw new Error('highs and lows must have the same length');
  }

  const conversionPeriod = options.conversionPeriod ?? 9;
  const basePeriod = options.basePeriod ?? 26;
  const spanBPeriod = options.spanBPeriod ?? 52;
  const displacement = options.displacement ?? 26;
  [conversionPeriod, basePeriod, spanBPeriod, displacement].forEach(assertPeriod);

  const length = highs.length;
  const conversion: IndicatorPoint[] = Array(length).fill(null);
  const base: IndicatorPoint[] = Array(length).fill(null);
  const leadingSpanA: IndicatorPoint[] = Array(length + displacement).fill(null);
  const leadingSpanB: IndicatorPoint[] = Array(length + displacement).fill(null);

  for (let i = 0; i < length; i += 1) {
    conversion[i] = midpoint(highs, lows, i, conversionPeriod);
    base[i] = midpoint(highs, lows, i, basePeriod);

    if (conversion[i] !== null && base[i] !== null) {
      leadingSpanA[i + displacement] = ((conversion[i] as number) + (base[i] as number)) / 2;
    }

    const spanB = midpoint(highs, lows, i, spanBPeriod);
    if (spanB !== null) {
      leadingSpanB[i + displacement] = spanB;
    }
  }

  return { conversion, base, leadingSpanA, leadingSpanB };
};

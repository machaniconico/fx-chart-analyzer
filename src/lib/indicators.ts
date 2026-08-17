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
    if (![high, low, previousClose].every(Number.isFinite)) {
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

import {
  adx,
  ao,
  atr,
  bollingerBands,
  cci,
  demarker,
  donchian,
  ema,
  envelope,
  ichimoku,
  keltnerBandsFrom,
  macd,
  momentum,
  parabolicSar,
  rvi,
  rsi,
  sma,
  stochastic,
} from './indicators';
import type {
  AdxResult,
  BollingerBands,
  DonchianResult,
  EnvelopeBands,
  IndicatorPoint,
  IchimokuResult,
  KeltnerChannel,
  MacdResult,
  ParabolicSarResult,
  RviResult,
  StochasticResult,
} from './indicators';
import type { Bar, Pair } from '../types';

export type StrategyDirection = 'long' | 'short';
export type MovingAverageType = 'sma' | 'ema';
export type RsiComparison = 'below' | 'above' | 'crossBelow' | 'crossAbove';
export type BollingerConditionMode = 'touch' | 'break';
export type BollingerBandSide = 'lower' | 'upper';

export interface MaCrossCondition {
  type: 'maCross';
  fastType: MovingAverageType;
  fastPeriod: number;
  slowType: MovingAverageType;
  slowPeriod: number;
}

export interface RsiCondition {
  type: 'rsi';
  period: number;
  threshold: number;
  comparison: RsiComparison;
}

export interface DeMarkerCondition {
  type: 'demarker';
  period: number;
  threshold: number;
  comparison: RsiComparison;
}

export interface BollingerCondition {
  type: 'bollinger';
  period: number;
  multiplier: number;
  mode: BollingerConditionMode;
  band: BollingerBandSide;
}

export interface EnvelopeCondition {
  type: 'envelope';
  period: number;
  deviation: number;
}

export interface MacdCrossCondition {
  type: 'macdCross';
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export interface IchimokuCrossCondition {
  type: 'ichimokuCross';
  conversionPeriod: number;
  basePeriod: number;
  spanBPeriod: number;
  displacement: number;
  requireCloudFilter: boolean;
}

export interface DonchianBreakCondition {
  type: 'donchianBreak';
  period: number;
}

export interface KeltnerBreakCondition {
  type: 'keltnerBreak';
  emaPeriod: number;
  atrPeriod: number;
  multiplier: number;
}

export interface CciBreakCondition {
  type: 'cciBreak';
  period: number;
  level: number;
}

export interface AdxTrendCondition {
  type: 'adxTrend';
  period: number;
  threshold: number;
}

export interface ParabolicSarCondition {
  type: 'parabolicSar';
  step: number;
  maximum: number;
}

export interface MomentumCondition {
  type: 'momentum';
  period: number;
}

export interface AoCondition {
  type: 'ao';
  fastPeriod: number;
  slowPeriod: number;
}

export interface RviCondition {
  type: 'rvi';
  period: number;
}

export interface StochasticCondition {
  type: 'stochastic';
  kPeriod: number;
  dPeriod: number;
  smoothing: number;
  threshold: number;
  comparison: RsiComparison;
}

/**
 * StochCross gives the first signal meaning to the `%D(dPeriod)` series that
 * the existing `stochastic()` already calculates but the legacy
 * `stochastic` condition deliberately leaves unused. It is a different signal
 * geometry on the same indicator (%K/%D two-series cross versus threshold
 * re-cross), so its firing frequency and market regime are different.
 * Rejected alternatives: AO - SMA(AO, 5) has the same rejection relationship
 * as OsMA ≈ macdCross; Bears Power and Bulls Power depend on an EMA path and
 * have high parity cost (already rejected); a Fractals breakout materially
 * overlaps Donchian; and MFI, Force, and OBV are volume-based with uncertain
 * cross-source parity.
 *
 * The evaluator deliberately does not consume `stochastic()` at all. Both of
 * that legacy function's smoothed series (`k` and `d`) come from the sliding
 * `smaFromNullable` recurrence, whose accumulated rounding drift (~1e-13)
 * breaks the exact `%K === %D` tie contract that this cross archetype's
 * equality edges depend on. StochCross recomputes raw %K with the identical
 * per-window highest/lowest expressions and then applies fresh, deterministic
 * per-window sums for both the smoothed %K and %D, matching the generated MQL
 * operation order exactly. The US-2201 review harnesses measured 0 mismatches
 * once both series are fresh, while keeping either series on the sliding
 * recurrence produced 1-ULP tie breaks and phantom crosses on real data.
 */
export interface StochCrossCondition {
  type: 'stochCross';
  kPeriod: number;
  dPeriod: number;
  smoothing: number;
}

/**
 * Alligator is the 18th archetype because it has a signal geometry that none
 * of the existing 17 conditions provide: three independently-smoothed SMMA
 * series, each read through a forward display shift, must align around a
 * Lips/Teeth cross before the Teeth/Jaw ordering filter accepts the entry.
 * The lines use median price and therefore expose both multi-series alignment
 * and displaced causal history rather than another one-series threshold.
 *
 * Rejected alternatives: WPR is the affine transform `WPR = %K - 100` of the
 * stochastic rawK and is therefore the same indicator family as the existing
 * stochastic condition; Gator Oscillator is a derived Alligator histogram
 * and duplicates this archetype; OsMA approximately duplicates macdCross;
 * Bears Power, Bulls Power, and Fractals are already rejected overlaps; and
 * MFI, Force, and OBV are volume-based candidates with the same parity cost
 * as the previously rejected volume family.
 */
export interface AlligatorCondition {
  type: 'alligator';
  jawPeriod: number;
  teethPeriod: number;
  lipsPeriod: number;
  jawShift: number;
  teethShift: number;
  lipsShift: number;
}

export type EntryCondition =
  | MaCrossCondition
  | RsiCondition
  | DeMarkerCondition
  | BollingerCondition
  | EnvelopeCondition
  | MacdCrossCondition
  | IchimokuCrossCondition
  | DonchianBreakCondition
  | StochasticCondition
  | StochCrossCondition
  | KeltnerBreakCondition
  | CciBreakCondition
  | AdxTrendCondition
  | ParabolicSarCondition
  | MomentumCondition
  | AoCondition
  | RviCondition
  | AlligatorCondition;

export interface ExitRules {
  stopLossPips: number;
  takeProfitPips: number;
  trailingStopPips?: number | null;
  closeOnOppositeSignal: boolean;
}

export interface SessionFilter {
  enabled: boolean;
  start: string;
  end: string;
  serverUtcOffsetMinutes: number;
}

export interface NewsFilter {
  enabled: boolean;
  blockMinutes: number;
}

export type LotSizingMode = 'fixedLot' | 'fixedRisk' | 'compound';

export interface MoneyManagementSettings {
  initialBalanceYen: number;
  lotSizingMode: LotSizingMode;
  fixedLot: number;
  riskPercent: number;
  maxLot: number;
}

export const defaultMoneyManagement = (fixedLot = 0.1): MoneyManagementSettings => ({
  initialBalanceYen: 1_000_000,
  lotSizingMode: 'fixedLot',
  fixedLot,
  riskPercent: 1,
  maxLot: 100,
});

export interface StrategyDefinition {
  id: string;
  name: string;
  description?: string;
  direction: StrategyDirection;
  entryDirections?: StrategyDirection[];
  entryConditions: EntryCondition[];
  exit: ExitRules;
  sessionFilter: SessionFilter;
  newsFilter: NewsFilter;
  lotSize: number;
  moneyManagement?: MoneyManagementSettings;
  magicNumber: number;
}

export interface StrategyEvaluator {
  isEntrySignal: (
    strategy: StrategyDefinition,
    index: number,
    direction?: StrategyDirection,
  ) => boolean;
}

const isNumber = (value: IndicatorPoint | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const crossedAbove = (
  previousFast: IndicatorPoint,
  previousSlow: IndicatorPoint,
  currentFast: IndicatorPoint,
  currentSlow: IndicatorPoint,
): boolean =>
  isNumber(previousFast) &&
  isNumber(previousSlow) &&
  isNumber(currentFast) &&
  isNumber(currentSlow) &&
  previousFast <= previousSlow &&
  currentFast > currentSlow;

const crossedBelow = (
  previousFast: IndicatorPoint,
  previousSlow: IndicatorPoint,
  currentFast: IndicatorPoint,
  currentSlow: IndicatorPoint,
): boolean =>
  isNumber(previousFast) &&
  isNumber(previousSlow) &&
  isNumber(currentFast) &&
  isNumber(currentSlow) &&
  previousFast >= previousSlow &&
  currentFast < currentSlow;

export const pipSize = (pair: Pair): number => (pair.endsWith('JPY') ? 0.01 : 0.0001);

export const pipsToPrice = (pair: Pair, pips: number): number => pips * pipSize(pair);

export const priceToPips = (pair: Pair, priceDistance: number): number =>
  priceDistance / pipSize(pair);

const hhmmPattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const hhmmToMinutes = (value: string): number | null => {
  const match = hhmmPattern.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
};

export const isWithinTradingSession = (
  timestamp: number,
  filter: SessionFilter,
): boolean => {
  if (!filter.enabled) {
    return true;
  }
  const start = hhmmToMinutes(filter.start);
  const end = hhmmToMinutes(filter.end);
  if (start === null || end === null || start === end) {
    return true;
  }
  const date = new Date((timestamp + filter.serverUtcOffsetMinutes * 60) * 1000);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
};

const normalizePeriod = (value: number): number => Math.max(1, Math.round(value));

const parabolicSarKey = (step: number, maximum: number): string =>
  `${step}:${maximum}`;

const alligatorKey = (condition: AlligatorCondition): string =>
  `${condition.jawPeriod}:${condition.teethPeriod}:${condition.lipsPeriod}`;

const maKey = (type: MovingAverageType, period: number): string =>
  `${type}:${normalizePeriod(period)}`;

export const movingAverageLabel = (type: MovingAverageType): string =>
  type === 'sma' ? 'SMA' : 'EMA';

export const conditionLabel = (condition: EntryCondition): string => {
  switch (condition.type) {
    case 'maCross':
      return `${movingAverageLabel(condition.fastType)}${condition.fastPeriod} x ${movingAverageLabel(condition.slowType)}${condition.slowPeriod}`;
    case 'rsi':
      return `RSI${condition.period} ${condition.comparison} ${condition.threshold}`;
    case 'demarker':
      return `DeMarker${condition.period} ${condition.comparison} ${condition.threshold}`;
    case 'bollinger':
      return `BB${condition.period}/${condition.multiplier} ${condition.band} ${condition.mode}`;
    case 'envelope':
      return `Envelope${condition.period}/${condition.deviation}% ブレイク`;
    case 'macdCross':
      return `MACD ${condition.fastPeriod}/${condition.slowPeriod}/${condition.signalPeriod} クロス`;
    case 'ichimokuCross':
      return `一目${condition.conversionPeriod}/${condition.basePeriod}/${condition.spanBPeriod} クロス${condition.requireCloudFilter ? '(雲フィルタ)' : ''}`;
    case 'donchianBreak':
      return `Donchian${condition.period} ブレイク`;
    case 'keltnerBreak':
      return `Keltner${condition.emaPeriod}/${condition.atrPeriod} x${condition.multiplier} ブレイク`;
    case 'stochastic':
      return `Stoch${condition.kPeriod}/${condition.dPeriod}/${condition.smoothing} ${condition.comparison} ${condition.threshold}`;
    case 'stochCross':
      return `Stoch${condition.kPeriod}/${condition.dPeriod}/${condition.smoothing} %K/%D クロス`;
    case 'cciBreak':
      return `CCI${condition.period} ±${condition.level} ブレイク`;
    case 'adxTrend':
      return `ADX${condition.period}/${condition.threshold} DIクロス`;
    case 'parabolicSar':
      return `SAR${condition.step}/${condition.maximum} フリップ`;
    case 'momentum':
      return `Momentum${condition.period} 100クロス`;
    case 'ao':
      return `AO${condition.fastPeriod}/${condition.slowPeriod} ゼロラインクロス`;
    case 'rvi':
      return `RVI${condition.period} シグナルクロス`;
    case 'alligator':
      return `Alligator ${condition.jawPeriod}/${condition.teethPeriod}/${condition.lipsPeriod} (${condition.jawShift}/${condition.teethShift}/${condition.lipsShift}) クロス`;
  }
};

const mirroredComparison = (comparison: RsiComparison): RsiComparison => {
  switch (comparison) {
    case 'below':
      return 'above';
    case 'above':
      return 'below';
    case 'crossBelow':
      return 'crossAbove';
    case 'crossAbove':
      return 'crossBelow';
  }
};

const mirroredBand = (band: BollingerBandSide): BollingerBandSide =>
  band === 'lower' ? 'upper' : 'lower';

const compareRsi = (
  previous: IndicatorPoint,
  current: IndicatorPoint,
  comparison: RsiComparison,
  threshold: number,
): boolean => {
  if (!isNumber(current)) {
    return false;
  }

  switch (comparison) {
    case 'below':
      return current <= threshold;
    case 'above':
      return current >= threshold;
    case 'crossBelow':
      return isNumber(previous) && previous > threshold && current <= threshold;
    case 'crossAbove':
      return isNumber(previous) && previous < threshold && current >= threshold;
  }
};

type CachedIndicatorValues = readonly IndicatorPoint[];

type ReadonlyIndicatorResult<T> = {
  readonly [Key in keyof T]: T[Key] extends readonly (infer Value)[] ? readonly Value[] : T[Key];
};

type CachedBollingerBands = ReadonlyIndicatorResult<BollingerBands>;
type CachedEnvelopeBands = ReadonlyIndicatorResult<EnvelopeBands>;
type CachedMacdResult = ReadonlyIndicatorResult<MacdResult>;
type CachedIchimokuResult = ReadonlyIndicatorResult<IchimokuResult>;
type CachedDonchianResult = ReadonlyIndicatorResult<DonchianResult>;
type CachedKeltnerChannel = ReadonlyIndicatorResult<KeltnerChannel>;
type CachedStochasticResult = ReadonlyIndicatorResult<StochasticResult>;
type CachedAdxResult = ReadonlyIndicatorResult<AdxResult>;
type CachedParabolicSarResult = ReadonlyIndicatorResult<ParabolicSarResult>;
type CachedRviResult = ReadonlyIndicatorResult<RviResult>;

type CachedStochCrossResult = {
  readonly k: readonly IndicatorPoint[];
  readonly d: readonly IndicatorPoint[];
};

type CachedAlligatorSeries = {
  readonly jaw: readonly IndicatorPoint[];
  readonly teeth: readonly IndicatorPoint[];
  readonly lips: readonly IndicatorPoint[];
};

type KeltnerEvaluation = {
  readonly channel: CachedKeltnerChannel;
  readonly atrValues: CachedIndicatorValues;
};

/**
 * Calculate one SMA window from scratch for every output bar. This is kept
 * separate from indicators.ts so the existing stochastic() output remains
 * byte-stable; the fresh oldest-to-newest sum is the StochCross parity
 * contract for both the smoothed %K and %D series.
 */
const freshWindowSmaFromNullable = (
  values: readonly IndicatorPoint[],
  period: number,
): IndicatorPoint[] => {
  const result: IndicatorPoint[] = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    let sum = 0;
    let complete = true;
    for (let offset = index - period + 1; offset <= index; offset += 1) {
      const value = values[offset];
      if (!isNumber(value)) {
        complete = false;
        break;
      }
      sum += value;
    }
    if (!complete || !Number.isFinite(sum)) {
      continue;
    }
    const average = sum / period;
    if (Number.isFinite(average)) {
      result[index] = average;
    }
  }
  return result;
};

/**
 * StochCross series contract, exported for bit-level parity tests. Do not
 * consume stochastic() here: its smoothed %K also comes from the sliding
 * smaFromNullable recurrence, and the ~1e-13 drift on either series breaks
 * the exact %K === %D ties this cross archetype needs. Raw %K uses the
 * identical per-window expressions as indicators.ts stochastic() (so with
 * smoothing=1 the two %K series are bit-identical), then both smoothed
 * series come from fresh per-window sums matching the generated MQL
 * operation order.
 */
export const computeStochCrossSeries = (
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  kPeriod: number,
  dPeriod: number,
  smoothing: number,
): { k: IndicatorPoint[]; d: IndicatorPoint[] } => {
  const rawK: (number | null)[] = Array(closes.length).fill(null);
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
  const freshK = freshWindowSmaFromNullable(rawK, smoothing);
  return {
    k: freshK,
    d: freshWindowSmaFromNullable(freshK, dPeriod),
  };
};

export interface AlligatorSeries {
  jaw: IndicatorPoint[];
  teeth: IndicatorPoint[];
  lips: IndicatorPoint[];
}

const validAlligatorPeriod = (period: number): boolean =>
  Number.isInteger(period) && period >= 2 && period <= 1000;

const smmaFromMedian = (
  medians: readonly IndicatorPoint[],
  period: number,
): IndicatorPoint[] => {
  const result: IndicatorPoint[] = Array(medians.length).fill(null);
  if (!validAlligatorPeriod(period)) {
    return result;
  }

  let previous: number | null = null;
  let seedCount = 0;
  let seedSum = 0;
  for (let index = 0; index < medians.length; index += 1) {
    const median = medians[index];
    if (!isNumber(median)) {
      // TS-only recovery: after a non-finite median, restart a fresh seed at
      // the next finite run. MQL aborts the whole history walk instead; this
      // re-seed asymmetry is reachable only with non-finite input. MQL
      // additionally rejects non-positive OHLC (see the mql.ts alligator
      // parity comment), which TS accepts.
      previous = null;
      seedCount = 0;
      seedSum = 0;
      continue;
    }

    if (previous === null) {
      // The seed is intentionally a fresh oldest-to-newest sum. Do not
      // replace this with the sliding SMA recurrence used by indicators.ts.
      seedSum += median;
      seedCount += 1;
      if (seedCount < period) {
        continue;
      }
      const seed = seedSum / period;
      if (!Number.isFinite(seed)) {
        seedCount = 0;
        seedSum = 0;
        continue;
      }
      previous = seed;
      result[index] = seed;
      continue;
    }

    const current: number = (previous * (period - 1) + median) / period;
    if (!Number.isFinite(current)) {
      previous = null;
      seedCount = 0;
      seedSum = 0;
      continue;
    }
    previous = current;
    result[index] = current;
  }

  return result;
};

/**
 * Compute Alligator's three raw SMMA lines from the complete oldest-to-newest
 * OHLC sequence. Median price is `(high + low) / 2`; each line seeds with a
 * fresh SMA of its first period medians and then uses the official recursive
 * SMMA formula. Display shifts are applied by the evaluator, not here, so the
 * exported series remains a deterministic causal source for both the
 * evaluator and parity tests. This function deliberately does not consume
 * any helper from indicators.ts.
 */
export const computeAlligatorSeries = (
  highs: readonly number[],
  lows: readonly number[],
  jawPeriod: number,
  teethPeriod: number,
  lipsPeriod: number,
): AlligatorSeries => {
  if (highs.length !== lows.length) {
    throw new Error('highs and lows must have the same length');
  }

  const medians: IndicatorPoint[] = Array(highs.length).fill(null);
  for (let index = 0; index < highs.length; index += 1) {
    const high = highs[index];
    const low = lows[index];
    if (!Number.isFinite(high) || !Number.isFinite(low)) {
      continue;
    }
    const median = (high + low) / 2;
    if (Number.isFinite(median)) {
      medians[index] = median;
    }
  }

  return {
    jaw: smmaFromMedian(medians, jawPeriod),
    teeth: smmaFromMedian(medians, teethPeriod),
    lips: smmaFromMedian(medians, lipsPeriod),
  };
};

const shiftedAlligatorValue = (
  series: readonly IndicatorPoint[],
  index: number,
  period: number,
  shift: number,
): IndicatorPoint => {
  const sourceIndex = index - shift;
  // Keep the shifted warm-up boundary explicit before reading the series. A
  // null/undefined value must never be allowed to participate in relational
  // coercion and accidentally turn an incomplete line into a signal.
  // The period check is redundant with SMMA's null prefix, but remains a
  // defensive fail-closed guard at this shifted access boundary.
  if (sourceIndex < period - 1 || sourceIndex < 0 || sourceIndex >= series.length) {
    return null;
  }
  return series[sourceIndex];
};

export const createStrategyEvaluator = (bars: readonly Bar[]): StrategyEvaluator => {
  const opens = bars.map((bar) => bar.o);
  const closes = bars.map((bar) => bar.c);
  const highs = bars.map((bar) => bar.h);
  const lows = bars.map((bar) => bar.l);
  const maCache = new Map<string, CachedIndicatorValues>();
  const rsiCache = new Map<number, CachedIndicatorValues>();
  const demarkerCache = new Map<number, CachedIndicatorValues>();
  const cciCache = new Map<number, CachedIndicatorValues>();
  const atrCache = new Map<number, CachedIndicatorValues>();
  const bbCache = new Map<string, CachedBollingerBands>();
  const envelopeCache = new Map<string, CachedEnvelopeBands>();
  const macdCache = new Map<string, CachedMacdResult>();
  const ichimokuCache = new Map<string, CachedIchimokuResult>();
  const donchianCache = new Map<number, CachedDonchianResult>();
  const keltnerCache = new Map<string, KeltnerEvaluation>();
  const stochasticCache = new Map<string, CachedStochasticResult>();
  const stochCrossCache = new Map<string, CachedStochCrossResult>();
  const adxCache = new Map<number, CachedAdxResult>();
  const parabolicSarCache = new Map<string, CachedParabolicSarResult>();
  const momentumCache = new Map<number, CachedIndicatorValues>();
  const aoCache = new Map<string, CachedIndicatorValues>();
  const rviCache = new Map<number, CachedRviResult>();
  const alligatorCache = new Map<string, CachedAlligatorSeries>();

  const getMa = (type: MovingAverageType, period: number): CachedIndicatorValues => {
    const normalizedPeriod = normalizePeriod(period);
    const key = maKey(type, normalizedPeriod);
    const cached = maCache.get(key);
    if (cached) {
      return cached;
    }
    const values = type === 'sma' ? sma(closes, normalizedPeriod) : ema(closes, normalizedPeriod);
    maCache.set(key, values);
    return values;
  };

  const getRsi = (period: number): CachedIndicatorValues => {
    const normalizedPeriod = normalizePeriod(period);
    const cached = rsiCache.get(normalizedPeriod);
    if (cached) {
      return cached;
    }
    const values = rsi(closes, normalizedPeriod);
    rsiCache.set(normalizedPeriod, values);
    return values;
  };

  const getDemarker = (period: number): CachedIndicatorValues => {
    // DeMarker keeps the raw period; the case 'demarker' guard in evaluateCondition is its normalization contract.
    const cached = demarkerCache.get(period);
    if (cached) {
      return cached;
    }
    const values = demarker(highs, lows, period);
    demarkerCache.set(period, values);
    return values;
  };

  const getCci = (period: number): CachedIndicatorValues => {
    const normalizedPeriod = normalizePeriod(period);
    const cached = cciCache.get(normalizedPeriod);
    if (cached) {
      return cached;
    }
    const values = cci(highs, lows, closes, normalizedPeriod);
    cciCache.set(normalizedPeriod, values);
    return values;
  };

  const getAtr = (period: number): CachedIndicatorValues => {
    const normalizedPeriod = normalizePeriod(period);
    const cached = atrCache.get(normalizedPeriod);
    if (cached) {
      return cached;
    }
    const values = atr(highs, lows, closes, normalizedPeriod);
    atrCache.set(normalizedPeriod, values);
    return values;
  };

  const getBands = (period: number, multiplier: number): CachedBollingerBands => {
    const normalizedPeriod = normalizePeriod(period);
    const key = `${normalizedPeriod}:${multiplier}`;
    const cached = bbCache.get(key);
    if (cached) {
      return cached;
    }
    const values = bollingerBands(closes, normalizedPeriod, multiplier);
    bbCache.set(key, values);
    return values;
  };

  const getEnvelope = (period: number, deviation: number): CachedEnvelopeBands => {
    const key = `${period}:${deviation}`;
    const cached = envelopeCache.get(key);
    if (cached) {
      return cached;
    }
    const values = envelope(bars, period, deviation);
    envelopeCache.set(key, values);
    return values;
  };

  const getMacd = (
    fastPeriod: number,
    slowPeriod: number,
    signalPeriod: number,
  ): CachedMacdResult => {
    const fast = normalizePeriod(fastPeriod);
    const slow = normalizePeriod(slowPeriod);
    const signal = normalizePeriod(signalPeriod);
    const key = `${fast}:${slow}:${signal}`;
    const cached = macdCache.get(key);
    if (cached) {
      return cached;
    }
    if (fast >= slow) {
      const empty = {
        macd: Array(closes.length).fill(null),
        signal: Array(closes.length).fill(null),
        histogram: Array(closes.length).fill(null),
      };
      macdCache.set(key, empty);
      return empty;
    }
    const values = macd(closes, fast, slow, signal);
    macdCache.set(key, values);
    return values;
  };

  const getIchimoku = (
    conversionPeriod: number,
    basePeriod: number,
    spanBPeriod: number,
    displacement: number,
  ): CachedIchimokuResult => {
    const normalizedConversionPeriod = normalizePeriod(conversionPeriod);
    const normalizedBasePeriod = normalizePeriod(basePeriod);
    const normalizedSpanBPeriod = normalizePeriod(spanBPeriod);
    const normalizedDisplacement = normalizePeriod(displacement);
    const key = `${normalizedConversionPeriod}:${normalizedBasePeriod}:${normalizedSpanBPeriod}:${normalizedDisplacement}`;
    const cached = ichimokuCache.get(key);
    if (cached) {
      return cached;
    }
    const values = ichimoku(highs, lows, {
      conversionPeriod: normalizedConversionPeriod,
      basePeriod: normalizedBasePeriod,
      spanBPeriod: normalizedSpanBPeriod,
      displacement: normalizedDisplacement,
    });
    ichimokuCache.set(key, values);
    return values;
  };

  const getDonchian = (period: number): CachedDonchianResult => {
    const normalizedPeriod = normalizePeriod(period);
    const cached = donchianCache.get(normalizedPeriod);
    if (cached) {
      return cached;
    }
    const values = donchian(highs, lows, normalizedPeriod);
    donchianCache.set(normalizedPeriod, values);
    return values;
  };

  const getKeltner = (
    emaPeriod: number,
    atrPeriod: number,
    multiplier: number,
  ): KeltnerEvaluation => {
    const normalizedEmaPeriod = normalizePeriod(emaPeriod);
    const normalizedAtrPeriod = normalizePeriod(atrPeriod);
    const key = `${normalizedEmaPeriod}:${normalizedAtrPeriod}:${multiplier}`;
    const cached = keltnerCache.get(key);
    if (cached) {
      return cached;
    }
    // keltnerChannel() recalculates ATR internally; build the bands from the
    // shared period caches so multiple Keltner conditions scan ATR only once.
    // バンド式そのものは keltnerBandsFrom(indicators.ts)の単一定義を使う。
    const middle = getMa('ema', normalizedEmaPeriod);
    const atrValues = getAtr(normalizedAtrPeriod);
    const values = {
      channel: keltnerBandsFrom(middle, atrValues, multiplier),
      atrValues,
    };
    keltnerCache.set(key, values);
    return values;
  };

  const getStochastic = (
    kPeriod: number,
    dPeriod: number,
    smoothing: number,
  ): CachedStochasticResult => {
    const normalizedKPeriod = normalizePeriod(kPeriod);
    const normalizedDPeriod = normalizePeriod(dPeriod);
    const normalizedSmoothing = normalizePeriod(smoothing);
    const key = `${normalizedKPeriod}:${normalizedDPeriod}:${normalizedSmoothing}`;
    const cached = stochasticCache.get(key);
    if (cached) {
      return cached;
    }
    const values = stochastic(
      highs,
      lows,
      closes,
      normalizedKPeriod,
      normalizedDPeriod,
      normalizedSmoothing,
    );
    stochasticCache.set(key, values);
    return values;
  };

  const getStochCross = (
    kPeriod: number,
    dPeriod: number,
    smoothing: number,
  ): CachedStochCrossResult => {
    const normalizedKPeriod = normalizePeriod(kPeriod);
    const normalizedDPeriod = normalizePeriod(dPeriod);
    const normalizedSmoothing = normalizePeriod(smoothing);
    const key = `${normalizedKPeriod}:${normalizedDPeriod}:${normalizedSmoothing}`;
    const cached = stochCrossCache.get(key);
    if (cached) {
      return cached;
    }

    const values = computeStochCrossSeries(
      highs,
      lows,
      closes,
      normalizedKPeriod,
      normalizedDPeriod,
      normalizedSmoothing,
    );
    stochCrossCache.set(key, values);
    return values;
  };

  const getAdx = (period: number): CachedAdxResult => {
    const normalizedPeriod = normalizePeriod(period);
    const cached = adxCache.get(normalizedPeriod);
    if (cached) {
      return cached;
    }
    const values = adx(highs, lows, closes, normalizedPeriod);
    adxCache.set(normalizedPeriod, values);
    return values;
  };

  const getParabolicSar = (step: number, maximum: number): CachedParabolicSarResult => {
    const key = parabolicSarKey(step, maximum);
    const cached = parabolicSarCache.get(key);
    if (cached) {
      return cached;
    }
    const values = parabolicSar(highs, lows, step, maximum);
    parabolicSarCache.set(key, values);
    return values;
  };

  const getMomentum = (period: number): CachedIndicatorValues => {
    const normalizedPeriod = normalizePeriod(period);
    const cached = momentumCache.get(normalizedPeriod);
    if (cached) {
      return cached;
    }
    const values = momentum(closes, normalizedPeriod);
    momentumCache.set(normalizedPeriod, values);
    return values;
  };

  const getAo = (fastPeriod: number, slowPeriod: number): CachedIndicatorValues => {
    const key = `${fastPeriod}:${slowPeriod}`;
    const cached = aoCache.get(key);
    if (cached) {
      return cached;
    }
    const values = ao(highs, lows, fastPeriod, slowPeriod);
    aoCache.set(key, values);
    return values;
  };

  const getRvi = (period: number): CachedRviResult => {
    const cached = rviCache.get(period);
    if (cached) {
      return cached;
    }
    const values = rvi(opens, highs, lows, closes, period);
    rviCache.set(period, values);
    return values;
  };

  const getAlligator = (condition: AlligatorCondition): CachedAlligatorSeries => {
    const key = alligatorKey(condition);
    const cached = alligatorCache.get(key);
    if (cached) {
      return cached;
    }
    const values = computeAlligatorSeries(
      highs,
      lows,
      condition.jawPeriod,
      condition.teethPeriod,
      condition.lipsPeriod,
    );
    alligatorCache.set(key, values);
    return values;
  };

  const evaluateCondition = (
    condition: EntryCondition,
    index: number,
    direction: StrategyDirection,
  ): boolean => {
    if (index <= 0 || index >= bars.length) {
      return false;
    }
    const isShort = direction === 'short';

    switch (condition.type) {
      case 'maCross': {
        const fast = getMa(condition.fastType, condition.fastPeriod);
        const slow = getMa(condition.slowType, condition.slowPeriod);
        return isShort
          ? crossedBelow(fast[index - 1], slow[index - 1], fast[index], slow[index])
          : crossedAbove(fast[index - 1], slow[index - 1], fast[index], slow[index]);
      }
      case 'rsi': {
        // RSI preserves legacy unvalidated thresholds; DeMarker needs 0..1 for its 1-threshold mirror.
        const values = getRsi(condition.period);
        const comparison = isShort ? mirroredComparison(condition.comparison) : condition.comparison;
        const threshold = isShort ? 100 - condition.threshold : condition.threshold;
        return compareRsi(values[index - 1], values[index], comparison, threshold);
      }
      case 'demarker': {
        if (
          !Number.isInteger(condition.period) ||
          condition.period < 1 ||
          !Number.isFinite(condition.threshold) ||
          condition.threshold < 0 ||
          condition.threshold > 1
        ) {
          return false;
        }
        const values = getDemarker(condition.period);
        const comparison = isShort ? mirroredComparison(condition.comparison) : condition.comparison;
        const threshold = isShort ? 1 - condition.threshold : condition.threshold;
        return compareRsi(values[index - 1], values[index], comparison, threshold);
      }
      case 'bollinger': {
        const bands = getBands(condition.period, condition.multiplier);
        const band = isShort ? mirroredBand(condition.band) : condition.band;
        const bandValue = band === 'upper' ? bands.upper[index] : bands.lower[index];
        if (!isNumber(bandValue)) {
          return false;
        }
        if (band === 'upper') {
          return condition.mode === 'touch' ? highs[index] >= bandValue : closes[index] >= bandValue;
        }
        return condition.mode === 'touch' ? lows[index] <= bandValue : closes[index] <= bandValue;
      }
      case 'envelope': {
        if (
          !Number.isInteger(condition.period) ||
          condition.period < 2 ||
          condition.period > 1000 ||
          !Number.isFinite(condition.deviation) ||
          condition.deviation <= 0
        ) {
          return false;
        }
        const bands = getEnvelope(condition.period, condition.deviation);
        const previousUpper = bands.upper[index - 1];
        const currentUpper = bands.upper[index];
        const previousLower = bands.lower[index - 1];
        const currentLower = bands.lower[index];
        const previousClose = closes[index - 1];
        const currentClose = closes[index];
        if (
          !isNumber(previousUpper) ||
          !isNumber(currentUpper) ||
          !isNumber(previousLower) ||
          !isNumber(currentLower) ||
          !isNumber(previousClose) ||
          !isNumber(currentClose)
        ) {
          return false;
        }
        return isShort
          ? previousClose >= previousLower && currentClose < currentLower
          : previousClose <= previousUpper && currentClose > currentUpper;
      }
      case 'macdCross': {
        const values = getMacd(condition.fastPeriod, condition.slowPeriod, condition.signalPeriod);
        return isShort
          ? crossedBelow(values.macd[index - 1], values.signal[index - 1], values.macd[index], values.signal[index])
          : crossedAbove(values.macd[index - 1], values.signal[index - 1], values.macd[index], values.signal[index]);
      }
      case 'ichimokuCross': {
        const values = getIchimoku(
          condition.conversionPeriod,
          condition.basePeriod,
          condition.spanBPeriod,
          condition.displacement,
        );
        const crossed = isShort
          ? crossedBelow(values.conversion[index - 1], values.base[index - 1], values.conversion[index], values.base[index])
          : crossedAbove(values.conversion[index - 1], values.base[index - 1], values.conversion[index], values.base[index]);
        if (!crossed || !condition.requireCloudFilter) {
          return crossed;
        }
        const spanA = values.leadingSpanA[index];
        const spanB = values.leadingSpanB[index];
        if (!isNumber(spanA) || !isNumber(spanB)) {
          return false;
        }
        return isShort
          ? closes[index] < Math.min(spanA, spanB)
          : closes[index] > Math.max(spanA, spanB);
      }
      case 'donchianBreak': {
        const channels = getDonchian(condition.period);
        const boundary = isShort ? channels.lower[index] : channels.upper[index];
        return isNumber(boundary) && (isShort ? closes[index] < boundary : closes[index] > boundary);
      }
      case 'keltnerBreak': {
        const { channel, atrValues } = getKeltner(
          condition.emaPeriod,
          condition.atrPeriod,
          condition.multiplier,
        );
        const upper = channel.upper[index];
        const lower = channel.lower[index];
        const atrValue = atrValues[index];
        if (
          !isNumber(atrValue) ||
          atrValue <= 0 ||
          !isNumber(upper) ||
          !isNumber(lower) ||
          !Number.isFinite(closes[index])
        ) {
          return false;
        }
        return isShort ? closes[index] <= lower : closes[index] >= upper;
      }
      case 'cciBreak': {
        const values = getCci(condition.period);
        const current = values[index];
        if (!isNumber(current) || !Number.isFinite(condition.level) || condition.level <= 0) {
          return false;
        }
        return isShort ? current <= -condition.level : current >= condition.level;
      }
      case 'adxTrend': {
        const normalizedPeriod = normalizePeriod(condition.period);
        if (
          !Number.isFinite(normalizedPeriod) ||
          normalizedPeriod < 2 ||
          !Number.isFinite(condition.threshold) ||
          condition.threshold <= 0 ||
          condition.threshold >= 100
        ) {
          return false;
        }
        const values = getAdx(condition.period);
        const currentAdx = values.adx[index];
        if (!isNumber(currentAdx) || currentAdx < condition.threshold) {
          return false;
        }
        // 平坦相場(両DI=0)後の初動バーはクロスとして扱う。MQLミラーと同じ
        // 2点比較を維持する意図的な契約であり、DI合計>0のガードは追加しない。
        // period>=2 検証とプロファイル固定の period=14 により period=1 の
        // アーティファクトは到達不能である。
        return isShort
          ? crossedBelow(
              values.plusDi[index - 1],
              values.minusDi[index - 1],
              values.plusDi[index],
              values.minusDi[index],
            )
          : crossedAbove(
              values.plusDi[index - 1],
              values.minusDi[index - 1],
              values.plusDi[index],
              values.minusDi[index],
            );
      }
      case 'parabolicSar': {
        if (
          !Number.isFinite(condition.step) ||
          condition.step <= 0 ||
          !Number.isFinite(condition.maximum) ||
          condition.maximum < condition.step
        ) {
          return false;
        }
        const values = getParabolicSar(condition.step, condition.maximum);
        const previousSar = values.sar[index - 1];
        const currentSar = values.sar[index];
        const previousIsLong = values.isLong[index - 1];
        const currentIsLong = values.isLong[index];
        if (
          !isNumber(previousSar) ||
          !isNumber(currentSar) ||
          typeof previousIsLong !== 'boolean' ||
          typeof currentIsLong !== 'boolean'
        ) {
          return false;
        }
        return isShort
          ? previousIsLong && !currentIsLong
          : !previousIsLong && currentIsLong;
      }
      case 'momentum': {
        if (!Number.isInteger(condition.period) || condition.period < 1) {
          return false;
        }
        const values = getMomentum(condition.period);
        const previous = values[index - 1];
        const current = values[index];
        if (!isNumber(previous) || !isNumber(current)) {
          return false;
        }
        // MQL mirror: include equality on the prior bar (<=/>=), but require
        // a strict move away from the 100 line on the signal bar (>/<).
        return isShort ? previous >= 100 && current < 100 : previous <= 100 && current > 100;
      }
      case 'ao': {
        if (
          !Number.isInteger(condition.fastPeriod) ||
          condition.fastPeriod < 1 ||
          !Number.isInteger(condition.slowPeriod) ||
          condition.slowPeriod < 1 ||
          condition.fastPeriod >= condition.slowPeriod
        ) {
          return false;
        }
        const values = getAo(condition.fastPeriod, condition.slowPeriod);
        const previous = values[index - 1];
        const current = values[index];
        if (!isNumber(previous) || !isNumber(current)) {
          return false;
        }
        return isShort ? previous >= 0 && current < 0 : previous <= 0 && current > 0;
      }
      case 'rvi': {
        if (!Number.isInteger(condition.period) || condition.period < 1) {
          return false;
        }
        const values = getRvi(condition.period);
        const previousRvi = values.rvi[index - 1];
        const previousSignal = values.signal[index - 1];
        const currentRvi = values.rvi[index];
        const currentSignal = values.signal[index];
        if (
          !isNumber(previousRvi) ||
          !isNumber(previousSignal) ||
          !isNumber(currentRvi) ||
          !isNumber(currentSignal)
        ) {
          return false;
        }
        // Signal-line cross boundary: equality is allowed on the prior bar
        // (<=/>=), while the signal bar must move strictly across (>/<).
        return isShort
          ? previousRvi >= previousSignal && currentRvi < currentSignal
          : previousRvi <= previousSignal && currentRvi > currentSignal;
      }
      case 'stochastic': {
        const values = getStochastic(
          condition.kPeriod,
          condition.dPeriod,
          condition.smoothing,
        );
        const comparison = isShort ? mirroredComparison(condition.comparison) : condition.comparison;
        const threshold = isShort ? 100 - condition.threshold : condition.threshold;
        return compareRsi(values.k[index - 1], values.k[index], comparison, threshold);
      }
      case 'stochCross': {
        // This archetype has a deliberate 2..1000 K/D domain. The legacy
        // stochastic condition keeps its dPeriod >= 1 contract unchanged;
        // dPeriod=1 makes %D identical to %K and therefore cannot cross.
        if (
          !Number.isInteger(condition.kPeriod) ||
          condition.kPeriod < 2 ||
          condition.kPeriod > 1000 ||
          !Number.isInteger(condition.dPeriod) ||
          condition.dPeriod < 2 ||
          condition.dPeriod > 1000 ||
          !Number.isInteger(condition.smoothing) ||
          condition.smoothing < 1
        ) {
          return false;
        }
        const values = getStochCross(
          condition.kPeriod,
          condition.dPeriod,
          condition.smoothing,
        );
        const previousK = values.k[index - 1];
        const previousD = values.d[index - 1];
        const currentK = values.k[index];
        const currentD = values.d[index];
        if (
          !isNumber(previousK) ||
          !isNumber(previousD) ||
          !isNumber(currentK) ||
          !isNumber(currentD)
        ) {
          return false;
        }
        return isShort
          ? previousK >= previousD && currentK < currentD
          : previousK <= previousD && currentK > currentD;
      }
      case 'alligator': {
        if (
          !validAlligatorPeriod(condition.jawPeriod) ||
          !validAlligatorPeriod(condition.teethPeriod) ||
          !validAlligatorPeriod(condition.lipsPeriod) ||
          condition.jawPeriod <= condition.teethPeriod ||
          condition.teethPeriod <= condition.lipsPeriod ||
          !Number.isInteger(condition.jawShift) ||
          condition.jawShift < 0 ||
          condition.jawShift > 500 ||
          !Number.isInteger(condition.teethShift) ||
          condition.teethShift < 0 ||
          condition.teethShift > 500 ||
          !Number.isInteger(condition.lipsShift) ||
          condition.lipsShift < 0 ||
          condition.lipsShift > 500 ||
          condition.jawShift <= condition.teethShift ||
          condition.teethShift <= condition.lipsShift
        ) {
          return false;
        }

        const values = getAlligator(condition);
        // Resolve every shifted line explicitly, including the previous
        // Lips/Teeth edge and the current Teeth/Jaw filter, before evaluating
        // any relation. This is the fail-closed warm-up contract.
        const previousLips = shiftedAlligatorValue(
          values.lips,
          index - 1,
          condition.lipsPeriod,
          condition.lipsShift,
        );
        const previousTeeth = shiftedAlligatorValue(
          values.teeth,
          index - 1,
          condition.teethPeriod,
          condition.teethShift,
        );
        const currentLips = shiftedAlligatorValue(
          values.lips,
          index,
          condition.lipsPeriod,
          condition.lipsShift,
        );
        const currentTeeth = shiftedAlligatorValue(
          values.teeth,
          index,
          condition.teethPeriod,
          condition.teethShift,
        );
        const currentJaw = shiftedAlligatorValue(
          values.jaw,
          index,
          condition.jawPeriod,
          condition.jawShift,
        );
        if (
          !isNumber(previousLips) ||
          !isNumber(previousTeeth) ||
          !isNumber(currentLips) ||
          !isNumber(currentTeeth) ||
          !isNumber(currentJaw)
        ) {
          return false;
        }
        return isShort
          ? previousLips >= previousTeeth && currentLips < currentTeeth && currentTeeth < currentJaw
          : previousLips <= previousTeeth && currentLips > currentTeeth && currentTeeth > currentJaw;
      }
    }
  };

  return {
    isEntrySignal: (
      strategy: StrategyDefinition,
      index: number,
      direction: StrategyDirection = strategy.direction,
    ): boolean =>
      strategy.entryConditions.length > 0 &&
      strategy.entryConditions.every((condition) => evaluateCondition(condition, index, direction)),
  };
};

export const defaultStrategies: StrategyDefinition[] = [
  {
    id: 'ma-cross-trend',
    name: 'MAクロス順張り',
    description: 'EMA20がEMA50を上抜けた方向へ入り、反対クロスで早めに撤退します。',
    direction: 'long',
    entryConditions: [
      {
        type: 'maCross',
        fastType: 'ema',
        fastPeriod: 20,
        slowType: 'ema',
        slowPeriod: 50,
      },
    ],
    exit: {
      stopLossPips: 30,
      takeProfitPips: 60,
      trailingStopPips: 25,
      closeOnOppositeSignal: true,
    },
    sessionFilter: {
      enabled: false,
      start: '00:00',
      end: '23:59',
      serverUtcOffsetMinutes: 0,
    },
    newsFilter: {
      enabled: false,
      blockMinutes: 30,
    },
    lotSize: 0.1,
    moneyManagement: defaultMoneyManagement(0.1),
    magicNumber: 20260701,
  },
  {
    id: 'rsi-bb-reversal',
    name: 'RSI逆張り',
    description: 'RSI30割れとボリンジャー下限タッチを待つ平均回帰型です。',
    direction: 'long',
    entryConditions: [
      {
        type: 'rsi',
        period: 14,
        threshold: 30,
        comparison: 'below',
      },
      {
        type: 'bollinger',
        period: 20,
        multiplier: 2,
        mode: 'touch',
        band: 'lower',
      },
    ],
    exit: {
      stopLossPips: 25,
      takeProfitPips: 35,
      trailingStopPips: null,
      closeOnOppositeSignal: false,
    },
    sessionFilter: {
      enabled: false,
      start: '00:00',
      end: '23:59',
      serverUtcOffsetMinutes: 0,
    },
    newsFilter: {
      enabled: false,
      blockMinutes: 30,
    },
    lotSize: 0.1,
    moneyManagement: defaultMoneyManagement(0.1),
    magicNumber: 20260702,
  },
  {
    id: 'bb-macd-breakout',
    name: 'BBブレイク+MACD',
    description: '上限ブレイクとMACD強気クロスが重なった時だけ入るブレイク型です。',
    direction: 'long',
    entryConditions: [
      {
        type: 'bollinger',
        period: 20,
        multiplier: 2,
        mode: 'break',
        band: 'upper',
      },
      {
        type: 'macdCross',
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
      },
    ],
    exit: {
      stopLossPips: 35,
      takeProfitPips: 70,
      trailingStopPips: 30,
      closeOnOppositeSignal: true,
    },
    sessionFilter: {
      enabled: false,
      start: '00:00',
      end: '23:59',
      serverUtcOffsetMinutes: 0,
    },
    newsFilter: {
      enabled: false,
      blockMinutes: 30,
    },
    lotSize: 0.1,
    moneyManagement: defaultMoneyManagement(0.1),
    magicNumber: 20260703,
  },
];

import {
  bollingerBands,
  donchian,
  ema,
  ichimoku,
  macd,
  rsi,
  sma,
  stochastic,
} from './indicators';
import type {
  BollingerBands,
  DonchianResult,
  IndicatorPoint,
  IchimokuResult,
  MacdResult,
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

export interface BollingerCondition {
  type: 'bollinger';
  period: number;
  multiplier: number;
  mode: BollingerConditionMode;
  band: BollingerBandSide;
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

export interface StochasticCondition {
  type: 'stochastic';
  kPeriod: number;
  dPeriod: number;
  smoothing: number;
  threshold: number;
  comparison: RsiComparison;
}

export type EntryCondition =
  | MaCrossCondition
  | RsiCondition
  | BollingerCondition
  | MacdCrossCondition
  | IchimokuCrossCondition
  | DonchianBreakCondition
  | StochasticCondition;

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
    case 'bollinger':
      return `BB${condition.period}/${condition.multiplier} ${condition.band} ${condition.mode}`;
    case 'macdCross':
      return `MACD ${condition.fastPeriod}/${condition.slowPeriod}/${condition.signalPeriod} クロス`;
    case 'ichimokuCross':
      return `一目${condition.conversionPeriod}/${condition.basePeriod}/${condition.spanBPeriod} クロス${condition.requireCloudFilter ? '(雲フィルタ)' : ''}`;
    case 'donchianBreak':
      return `Donchian${condition.period} ブレイク`;
    case 'stochastic':
      return `Stoch${condition.kPeriod}/${condition.dPeriod}/${condition.smoothing} ${condition.comparison} ${condition.threshold}`;
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

export const createStrategyEvaluator = (bars: readonly Bar[]): StrategyEvaluator => {
  const closes = bars.map((bar) => bar.c);
  const highs = bars.map((bar) => bar.h);
  const lows = bars.map((bar) => bar.l);
  const maCache = new Map<string, IndicatorPoint[]>();
  const rsiCache = new Map<number, IndicatorPoint[]>();
  const bbCache = new Map<string, BollingerBands>();
  const macdCache = new Map<string, MacdResult>();
  const ichimokuCache = new Map<string, IchimokuResult>();
  const donchianCache = new Map<number, DonchianResult>();
  const stochasticCache = new Map<string, StochasticResult>();

  const getMa = (type: MovingAverageType, period: number): IndicatorPoint[] => {
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

  const getRsi = (period: number): IndicatorPoint[] => {
    const normalizedPeriod = normalizePeriod(period);
    const cached = rsiCache.get(normalizedPeriod);
    if (cached) {
      return cached;
    }
    const values = rsi(closes, normalizedPeriod);
    rsiCache.set(normalizedPeriod, values);
    return values;
  };

  const getBands = (period: number, multiplier: number): BollingerBands => {
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

  const getMacd = (fastPeriod: number, slowPeriod: number, signalPeriod: number): MacdResult => {
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
  ): IchimokuResult => {
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

  const getDonchian = (period: number): DonchianResult => {
    const normalizedPeriod = normalizePeriod(period);
    const cached = donchianCache.get(normalizedPeriod);
    if (cached) {
      return cached;
    }
    const values = donchian(highs, lows, normalizedPeriod);
    donchianCache.set(normalizedPeriod, values);
    return values;
  };

  const getStochastic = (
    kPeriod: number,
    dPeriod: number,
    smoothing: number,
  ): StochasticResult => {
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
        const values = getRsi(condition.period);
        const comparison = isShort ? mirroredComparison(condition.comparison) : condition.comparison;
        const threshold = isShort ? 100 - condition.threshold : condition.threshold;
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

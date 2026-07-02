import { analyzeSignals, type SignalAnalysis } from './signals';
import type { Bar } from '../types';

export const predictionHorizons = [1, 5, 20] as const;
export type PredictionHorizon = (typeof predictionHorizons)[number];

export interface PredictionRange {
  low: number;
  high: number;
}

export interface HorizonPrediction {
  horizon: PredictionHorizon;
  probabilityUp: number;
  expectedPrice: number;
  range68: PredictionRange;
  range95: PredictionRange;
  modelProbabilities: {
    signal: number;
    drift: number;
    regime: number;
  };
}

export interface WalkForwardHorizonAccuracy {
  horizon: PredictionHorizon;
  hits: number;
  total: number;
  accuracy: number | null;
}

export interface WalkForwardAccuracy {
  lookbackBars: number;
  sampleStartIndex: number | null;
  sampleEndIndex: number | null;
  horizons: WalkForwardHorizonAccuracy[];
}

export interface PredictionResult {
  generatedAt: number;
  lastClose: number;
  atr: number;
  signalAnalysis: SignalAnalysis;
  autocorrelation: number;
  driftPerBar: number;
  horizons: HorizonPrediction[];
  reasons: string[];
  walkForward: WalkForwardAccuracy | null;
}

export interface PredictionOptions {
  regressionLookback?: number;
  volatilityLookback?: number;
  includeWalkForward?: boolean;
  walkForwardLookback?: number;
  walkForwardChunkSize?: number;
}

interface CorePredictionInputs {
  closes: number[];
  returns: number[];
  lastClose: number;
  atr: number;
  signalAnalysis: SignalAnalysis;
  driftPerBar: number;
  volatility: number;
  autocorrelation: number;
  regimeReturnPerBar: number;
}

interface IdleDeadlineLike {
  didTimeout: boolean;
  timeRemaining: () => number;
}

interface IdleSchedulerWindow {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const createAbortError = (): Error => {
  const error = new Error('Walk-forward calculation was cancelled');
  error.name = 'AbortError';
  return error;
};

const scheduleChunk = (callback: (deadline?: IdleDeadlineLike) => void): (() => void) => {
  if (typeof window !== 'undefined') {
    const schedulerWindow = window as unknown as IdleSchedulerWindow;
    if (typeof schedulerWindow.requestIdleCallback === 'function') {
      const handle = schedulerWindow.requestIdleCallback(callback, { timeout: 80 });
      return () => schedulerWindow.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(() => callback(), 0);
    return () => window.clearTimeout(handle);
  }

  const handle = setTimeout(() => callback(), 0);
  return () => clearTimeout(handle);
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

const standardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const erf = (value: number): number => {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x));
  return sign * y;
};

const normalCdf = (value: number): number => 0.5 * (1 + erf(value / Math.SQRT2));

const logReturns = (closes: readonly number[]): number[] => {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  return returns;
};

const calculateAtr = (bars: readonly Bar[], period = 14): number => {
  if (bars.length < 2) {
    return Math.max(Math.abs(bars[0]?.c ?? 1) * 0.001, 0.00001);
  }

  const start = Math.max(1, bars.length - period);
  const ranges: number[] = [];
  for (let i = start; i < bars.length; i += 1) {
    const previousClose = bars[i - 1].c;
    ranges.push(
      Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - previousClose),
        Math.abs(bars[i].l - previousClose),
      ),
    );
  }

  const averageRange = mean(ranges);
  const fallback = Math.max(Math.abs(bars[bars.length - 1].c) * 0.001, 0.00001);
  return averageRange > 0 && Number.isFinite(averageRange) ? averageRange : fallback;
};

const linearRegressionDrift = (returns: readonly number[]): number => {
  if (returns.length === 0) {
    return 0;
  }
  if (returns.length < 3) {
    return mean(returns);
  }

  const n = returns.length;
  const meanX = (n - 1) / 2;
  const meanY = mean(returns);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (i - meanX) * (returns[i] - meanY);
    denominator += (i - meanX) ** 2;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  return intercept + slope * n;
};

const lagOneAutocorrelation = (returns: readonly number[]): number => {
  if (returns.length < 3) {
    return 0;
  }

  const lagged = returns.slice(0, -1);
  const current = returns.slice(1);
  const laggedMean = mean(lagged);
  const currentMean = mean(current);
  let numerator = 0;
  let laggedVariance = 0;
  let currentVariance = 0;
  for (let i = 0; i < current.length; i += 1) {
    const laggedDiff = lagged[i] - laggedMean;
    const currentDiff = current[i] - currentMean;
    numerator += laggedDiff * currentDiff;
    laggedVariance += laggedDiff ** 2;
    currentVariance += currentDiff ** 2;
  }

  const denominator = Math.sqrt(laggedVariance * currentVariance);
  return denominator === 0 ? 0 : clamp(numerator / denominator, -1, 1);
};

const probabilityFromLogMove = (
  expectedLogMove: number,
  volatility: number,
  horizon: number,
): number => {
  const denominator = Math.max(volatility * Math.sqrt(horizon), 0.000001);
  return clamp(normalCdf(expectedLogMove / denominator), 0.02, 0.98);
};

const prepareInputs = (bars: readonly Bar[], options: PredictionOptions): CorePredictionInputs => {
  const closes = bars.map((bar) => bar.c);
  const lastClose = closes[closes.length - 1] ?? 1;
  const returns = logReturns(closes);
  const regressionLookback = options.regressionLookback ?? 80;
  const volatilityLookback = options.volatilityLookback ?? 80;
  const recentReturns = returns.slice(-regressionLookback);
  const volatilityReturns = returns.slice(-volatilityLookback);
  const volatility = Math.max(standardDeviation(volatilityReturns), Math.abs(mean(volatilityReturns)), 0.000001);
  const driftPerBar = linearRegressionDrift(recentReturns);
  const autocorrelation = lagOneAutocorrelation(recentReturns);
  const lastReturn = recentReturns[recentReturns.length - 1] ?? 0;
  const regimeStrength = Math.min(Math.abs(autocorrelation), 1);
  const regimeReturnPerBar =
    autocorrelation >= 0 ? lastReturn * regimeStrength : -lastReturn * regimeStrength;

  return {
    closes,
    returns,
    lastClose,
    atr: calculateAtr(bars, 14),
    signalAnalysis: analyzeSignals(bars),
    driftPerBar,
    volatility,
    autocorrelation,
    regimeReturnPerBar,
  };
};

const buildCorePrediction = (bars: readonly Bar[], options: PredictionOptions = {}): Omit<PredictionResult, 'walkForward'> => {
  const inputs = prepareInputs(bars, options);
  const signalBias = clamp(inputs.signalAnalysis.score / 8, -1, 1);

  const horizons = predictionHorizons.map<HorizonPrediction>((horizon) => {
    const signalProbability = clamp(0.5 + (signalBias * 0.24) / Math.sqrt(horizon), 0.05, 0.95);
    const driftMove = inputs.driftPerBar * horizon;
    const driftProbability = probabilityFromLogMove(driftMove, inputs.volatility, horizon);
    const regimeHorizon = Math.min(horizon, 5);
    const regimeMove = inputs.regimeReturnPerBar * regimeHorizon;
    const regimeProbability = probabilityFromLogMove(regimeMove, inputs.volatility, regimeHorizon);
    const probabilityUp = clamp(
      signalProbability * 0.4 + driftProbability * 0.35 + regimeProbability * 0.25,
      0.02,
      0.98,
    );
    const signalMove = (signalProbability - 0.5) * 2 * inputs.volatility * Math.sqrt(horizon);
    const expectedLogMove = signalMove * 0.25 + driftMove * 0.45 + regimeMove * 0.3;
    const expectedPrice = inputs.lastClose * Math.exp(expectedLogMove);
    const range68Move = inputs.atr * Math.sqrt(horizon);
    const range95Move = range68Move * 2;

    return {
      horizon,
      probabilityUp,
      expectedPrice,
      range68: {
        low: Math.max(0, expectedPrice - range68Move),
        high: expectedPrice + range68Move,
      },
      range95: {
        low: Math.max(0, expectedPrice - range95Move),
        high: expectedPrice + range95Move,
      },
      modelProbabilities: {
        signal: signalProbability,
        drift: driftProbability,
        regime: regimeProbability,
      },
    };
  });

  const regimeLabel = inputs.autocorrelation >= 0 ? 'モメンタム寄り' : '平均回帰寄り';
  const driftPct = inputs.driftPerBar * 100;
  const reasons = [
    `シグナル投票は「${inputs.signalAnalysis.rating.label}」(スコア ${inputs.signalAnalysis.score})。`,
    `対数リターン回帰の推定ドリフトは1本あたり ${driftPct.toFixed(3)}%。`,
    `直近リターンの自己相関は ${inputs.autocorrelation.toFixed(2)} で、統計モデルは${regimeLabel}に切替。`,
    `予測レンジはATR ${inputs.atr.toFixed(5)} を基準に、時間平方根で拡大。`,
  ];

  return {
    generatedAt: Date.now(),
    lastClose: inputs.lastClose,
    atr: inputs.atr,
    signalAnalysis: inputs.signalAnalysis,
    autocorrelation: inputs.autocorrelation,
    driftPerBar: inputs.driftPerBar,
    horizons,
    reasons,
  };
};

export const walkForwardAccuracy = (
  bars: readonly Bar[],
  options: PredictionOptions = {},
): WalkForwardAccuracy => {
  const lookbackBars = options.walkForwardLookback ?? 300;
  const minTrainingBars = Math.max(options.regressionLookback ?? 80, options.volatilityLookback ?? 80, 80);
  const totals = predictionHorizons.map<WalkForwardHorizonAccuracy>((horizon) => ({
    horizon,
    hits: 0,
    total: 0,
    accuracy: null,
  }));

  if (bars.length <= minTrainingBars + 1) {
    return {
      lookbackBars,
      sampleStartIndex: null,
      sampleEndIndex: null,
      horizons: totals,
    };
  }

  const lastCutoff = bars.length - 2;
  const firstCutoff = Math.max(minTrainingBars, bars.length - 1 - lookbackBars);

  for (let cutoff = firstCutoff; cutoff <= lastCutoff; cutoff += 1) {
    const prediction = buildCorePrediction(bars.slice(0, cutoff + 1), options);
    for (const total of totals) {
      const futureIndex = cutoff + total.horizon;
      if (futureIndex >= bars.length) {
        continue;
      }
      const forecast = prediction.horizons.find((item) => item.horizon === total.horizon);
      if (!forecast) {
        continue;
      }
      const predictedUp = forecast.probabilityUp >= 0.5;
      const actualUp = bars[futureIndex].c > bars[cutoff].c;
      if (predictedUp === actualUp) {
        total.hits += 1;
      }
      total.total += 1;
    }
  }

  return {
    lookbackBars,
    sampleStartIndex: firstCutoff,
    sampleEndIndex: lastCutoff,
    horizons: totals.map((total) => ({
      ...total,
      accuracy: total.total > 0 ? total.hits / total.total : null,
    })),
  };
};

export const walkForwardAccuracyAsync = (
  bars: readonly Bar[],
  options: PredictionOptions = {},
  signal?: AbortSignal,
): Promise<WalkForwardAccuracy> => {
  const lookbackBars = options.walkForwardLookback ?? 300;
  const minTrainingBars = Math.max(options.regressionLookback ?? 80, options.volatilityLookback ?? 80, 80);
  const totals = predictionHorizons.map<WalkForwardHorizonAccuracy>((horizon) => ({
    horizon,
    hits: 0,
    total: 0,
    accuracy: null,
  }));

  if (bars.length <= minTrainingBars + 1) {
    return Promise.resolve({
      lookbackBars,
      sampleStartIndex: null,
      sampleEndIndex: null,
      horizons: totals,
    });
  }

  const lastCutoff = bars.length - 2;
  const firstCutoff = Math.max(minTrainingBars, bars.length - 1 - lookbackBars);
  const chunkSize = Math.max(1, Math.round(options.walkForwardChunkSize ?? 8));
  let cutoff = firstCutoff;
  let cancelScheduled: (() => void) | null = null;

  return new Promise<WalkForwardAccuracy>((resolve, reject) => {
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort);
      cancelScheduled = null;
    };

    const finish = (): void => {
      cleanup();
      resolve({
        lookbackBars,
        sampleStartIndex: firstCutoff,
        sampleEndIndex: lastCutoff,
        horizons: totals.map((total) => ({
          ...total,
          accuracy: total.total > 0 ? total.hits / total.total : null,
        })),
      });
    };

    const abort = (): void => {
      cancelScheduled?.();
      cleanup();
      reject(createAbortError());
    };

    const processChunk = (deadline?: IdleDeadlineLike): void => {
      cancelScheduled = null;
      if (signal?.aborted) {
        abort();
        return;
      }

      let processed = 0;
      while (cutoff <= lastCutoff) {
        const prediction = buildCorePrediction(bars.slice(0, cutoff + 1), options);
        for (const total of totals) {
          const futureIndex = cutoff + total.horizon;
          if (futureIndex >= bars.length) {
            continue;
          }
          const forecast = prediction.horizons.find((item) => item.horizon === total.horizon);
          if (!forecast) {
            continue;
          }
          const predictedUp = forecast.probabilityUp >= 0.5;
          const actualUp = bars[futureIndex].c > bars[cutoff].c;
          if (predictedUp === actualUp) {
            total.hits += 1;
          }
          total.total += 1;
        }

        cutoff += 1;
        processed += 1;
        if (processed >= chunkSize) {
          break;
        }
        if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 4) {
          break;
        }
      }

      if (signal?.aborted) {
        abort();
        return;
      }
      if (cutoff > lastCutoff) {
        finish();
        return;
      }
      cancelScheduled = scheduleChunk(processChunk);
    };

    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    signal?.addEventListener('abort', abort, { once: true });
    cancelScheduled = scheduleChunk(processChunk);
  });
};

export const predict = (bars: readonly Bar[], options: PredictionOptions = {}): PredictionResult => {
  const core = buildCorePrediction(bars, options);
  const includeWalkForward = options.includeWalkForward ?? false;
  return {
    ...core,
    walkForward: includeWalkForward ? walkForwardAccuracy(bars, options) : null,
  };
};

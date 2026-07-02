import { runBacktest } from './backtest';
import type { BacktestOptions, BacktestResult } from './backtest';
import type { StrategyDefinition } from './strategy';
import type { Bar, Pair } from '../types';

export interface OptimizationRange {
  min: number;
  max: number;
  step: number;
}

export interface OptimizationRanges {
  stopLossPips: OptimizationRange;
  takeProfitPips: OptimizationRange;
  trailingStopPips?: OptimizationRange | null;
}

export interface OptimizationParameters {
  stopLossPips: number;
  takeProfitPips: number;
  trailingStopPips: number | null;
}

export interface OptimizationScore {
  netProfitYen: number;
  profitFactor: number;
  maxDrawdownYen: number;
  maxDrawdownPct: number;
  tradeCount: number;
  winRate: number;
}

export interface OptimizationResultRow {
  parameters: OptimizationParameters;
  optimization: OptimizationScore;
  validation: OptimizationScore;
  validationToOptimizationRatio: number;
  overfitWarning: boolean;
}

export interface OptimizationCancelToken {
  aborted: boolean;
}

export interface OptimizationProgress {
  completed: number;
  total: number;
  percent: number;
  cancelled: boolean;
}

export interface OptimizationRunResult {
  rows: OptimizationResultRow[];
  completed: number;
  total: number;
  cancelled: boolean;
}

export interface RunGridSearchOptimizationOptions extends BacktestOptions {
  chunkSize?: number;
  cancelToken?: OptimizationCancelToken;
  maxCombinations?: number;
  onProgress?: (progress: OptimizationProgress) => void;
  optimizationRatio?: number;
}

export const createOptimizationCancelToken = (): OptimizationCancelToken => ({ aborted: false });

const roundParameter = (value: number): number => Math.round(value * 10) / 10;

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

export const valuesFromRange = (range: OptimizationRange): number[] => {
  const min = finiteOr(range.min, 1);
  const max = finiteOr(range.max, min);
  const step = Math.abs(finiteOr(range.step, 1)) || 1;
  const start = Math.min(min, max);
  const end = Math.max(min, max);
  const values: number[] = [];
  for (let value = start; value <= end + step / 1000; value += step) {
    values.push(roundParameter(value));
  }
  return [...new Set(values)];
};

export const estimateCombinationCount = (ranges: OptimizationRanges): number =>
  valuesFromRange(ranges.stopLossPips).length *
  valuesFromRange(ranges.takeProfitPips).length *
  (ranges.trailingStopPips ? valuesFromRange(ranges.trailingStopPips).length : 1);

export const generateParameterCombinations = (
  ranges: OptimizationRanges,
): OptimizationParameters[] => {
  const stopLossValues = valuesFromRange(ranges.stopLossPips);
  const takeProfitValues = valuesFromRange(ranges.takeProfitPips);
  const trailingValues = ranges.trailingStopPips
    ? valuesFromRange(ranges.trailingStopPips)
    : [null];
  const combinations: OptimizationParameters[] = [];

  for (const stopLossPips of stopLossValues) {
    for (const takeProfitPips of takeProfitValues) {
      for (const trailingStopPips of trailingValues) {
        combinations.push({
          stopLossPips,
          takeProfitPips,
          trailingStopPips,
        });
      }
    }
  }

  return combinations;
};

export const splitOptimizationBars = <T>(
  bars: readonly T[],
  optimizationRatio = 0.7,
): { optimizationBars: T[]; validationBars: T[] } => {
  if (bars.length <= 1) {
    return { optimizationBars: [...bars], validationBars: [] };
  }
  const ratio = Math.min(0.95, Math.max(0.05, optimizationRatio));
  const splitIndex = Math.min(bars.length - 1, Math.max(1, Math.floor(bars.length * ratio)));
  return {
    optimizationBars: bars.slice(0, splitIndex),
    validationBars: bars.slice(splitIndex),
  };
};

export const scoreBacktestResult = (result: BacktestResult): OptimizationScore => ({
  netProfitYen: result.netProfitYen,
  profitFactor: result.profitFactor,
  maxDrawdownYen: result.maxDrawdownYen,
  maxDrawdownPct: result.maxDrawdownPct,
  tradeCount: result.tradeCount,
  winRate: result.winRate,
});

export const validationToOptimizationRatio = (
  optimization: OptimizationScore,
  validation: OptimizationScore,
): number => {
  if (optimization.netProfitYen <= 0) {
    return validation.netProfitYen >= optimization.netProfitYen ? 1 : 0;
  }
  return validation.netProfitYen / optimization.netProfitYen;
};

export const isOverfitSuspect = (
  optimization: OptimizationScore,
  validation: OptimizationScore,
): boolean => {
  if (optimization.netProfitYen <= 0) {
    return false;
  }
  const ratio = validationToOptimizationRatio(optimization, validation);
  const drawdownDiverged =
    optimization.maxDrawdownPct > 0 &&
    validation.maxDrawdownPct > optimization.maxDrawdownPct * 2 + 5;
  return ratio < 0.35 || drawdownDiverged;
};

const strategyWithParameters = (
  strategy: StrategyDefinition,
  parameters: OptimizationParameters,
): StrategyDefinition => ({
  ...strategy,
  exit: {
    ...strategy.exit,
    stopLossPips: parameters.stopLossPips,
    takeProfitPips: parameters.takeProfitPips,
    trailingStopPips: parameters.trailingStopPips,
  },
});

const rankRows = (rows: readonly OptimizationResultRow[]): OptimizationResultRow[] =>
  [...rows].sort((left, right) => {
    const netProfitDiff = right.optimization.netProfitYen - left.optimization.netProfitYen;
    if (netProfitDiff !== 0) {
      return netProfitDiff;
    }
    return left.optimization.maxDrawdownYen - right.optimization.maxDrawdownYen;
  });

export const runGridSearchOptimization = (
  bars: readonly Bar[],
  strategy: StrategyDefinition,
  pair: Pair,
  ranges: OptimizationRanges,
  options: RunGridSearchOptimizationOptions = {},
): Promise<OptimizationRunResult> => {
  const estimatedTotal = estimateCombinationCount(ranges);
  const maxCombinations = Math.max(1, Math.round(options.maxCombinations ?? 5000));
  if (estimatedTotal > maxCombinations) {
    return Promise.reject(
      new Error(`最適化の組合せが多すぎます。${maxCombinations}件以下になるよう範囲か刻みを調整してください。`),
    );
  }

  const combinations = generateParameterCombinations(ranges);
  const total = combinations.length;
  const rows: OptimizationResultRow[] = [];
  const chunkSize = Math.max(1, Math.round(options.chunkSize ?? 12));
  const cancelToken = options.cancelToken;
  const { optimizationBars, validationBars } = splitOptimizationBars(
    bars,
    options.optimizationRatio ?? 0.7,
  );
  let completed = 0;

  const notify = (cancelled: boolean): void => {
    options.onProgress?.({
      completed,
      total,
      percent: total === 0 ? 100 : (completed / total) * 100,
      cancelled,
    });
  };

  return new Promise((resolve) => {
    if (total === 0) {
      notify(false);
      resolve({ rows: [], completed: 0, total: 0, cancelled: false });
      return;
    }

    const runChunk = (): void => {
      if (cancelToken?.aborted) {
        notify(true);
        resolve({ rows: rankRows(rows), completed, total, cancelled: true });
        return;
      }

      const chunkEnd = Math.min(total, completed + chunkSize);
      for (; completed < chunkEnd; completed += 1) {
        const parameters = combinations[completed];
        const candidate = strategyWithParameters(strategy, parameters);
        const optimization = scoreBacktestResult(
          runBacktest(optimizationBars, candidate, pair, options),
        );
        const validation = scoreBacktestResult(
          runBacktest(validationBars, candidate, pair, options),
        );
        const ratio = validationToOptimizationRatio(optimization, validation);
        rows.push({
          parameters,
          optimization,
          validation,
          validationToOptimizationRatio: ratio,
          overfitWarning: isOverfitSuspect(optimization, validation),
        });
      }

      notify(false);
      if (completed >= total) {
        resolve({ rows: rankRows(rows), completed, total, cancelled: false });
        return;
      }
      globalThis.setTimeout(runChunk, 0);
    };

    globalThis.setTimeout(runChunk, 0);
  });
};

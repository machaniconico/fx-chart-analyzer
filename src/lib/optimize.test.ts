import { describe, expect, it } from 'vitest';
import {
  estimateCombinationCount,
  generateParameterCombinations,
  isOverfitSuspect,
  scoreBacktestResult,
  splitOptimizationBars,
  validationToOptimizationRatio,
} from './optimize';
import type { BacktestResult } from './backtest';
import type { Bar } from '../types';

const bar = (index: number): Bar => ({
  t: index * 3600,
  o: 100,
  h: 101,
  l: 99,
  c: 100,
  v: 1000,
});

const result = (overrides: Partial<BacktestResult>): BacktestResult => ({
  pair: 'USDJPY',
  spreadPips: 0.9,
  moneyManagement: {
    initialBalanceYen: 1_000_000,
    lotSizingMode: 'fixedLot',
    fixedLot: 0.1,
    riskPercent: 1,
    maxLot: 100,
  },
  conversionNote: '',
  winRate: 50,
  profitFactor: 1.5,
  maxDrawdownPips: 10,
  maxDrawdownYen: 10_000,
  maxDrawdownPct: 1,
  tradeCount: 10,
  netPips: 50,
  netProfitYen: 50_000,
  grossProfitPips: 100,
  grossLossPips: -50,
  grossProfitYen: 100_000,
  grossLossYen: -50_000,
  riskRewardRatio: 2,
  averageWinYen: 10_000,
  averageLossYen: -5_000,
  maxConsecutiveWins: 3,
  maxConsecutiveLosses: 2,
  trades: [],
  equityCurve: [],
  ...overrides,
});

describe('optimize pure functions', () => {
  it('generates SL/TP/trailing grid combinations', () => {
    const combinations = generateParameterCombinations({
      stopLossPips: { min: 10, max: 20, step: 10 },
      takeProfitPips: { min: 20, max: 40, step: 20 },
      trailingStopPips: { min: 5, max: 10, step: 5 },
    });

    expect(combinations).toHaveLength(8);
    expect(combinations[0]).toEqual({
      stopLossPips: 10,
      takeProfitPips: 20,
      trailingStopPips: 5,
    });
    expect(combinations[7]).toEqual({
      stopLossPips: 20,
      takeProfitPips: 40,
      trailingStopPips: 10,
    });
  });

  it('estimates combination count without materializing rows', () => {
    expect(
      estimateCombinationCount({
        stopLossPips: { min: 1, max: 1000, step: 1 },
        takeProfitPips: { min: 1, max: 1000, step: 1 },
        trailingStopPips: { min: 1, max: 10, step: 1 },
      }),
    ).toBe(10_000_000);
  });

  it('estimates combination count from the actual rounded range values', () => {
    const ranges = {
      stopLossPips: { min: 0, max: 0.3, step: 0.1 },
      takeProfitPips: { min: 1, max: 1.3, step: 0.1 },
      trailingStopPips: { min: 2, max: 2.3, step: 0.1 },
    };

    expect(estimateCombinationCount(ranges)).toBe(generateParameterCombinations(ranges).length);
  });

  it('uses null trailing stop when trailing range is omitted', () => {
    expect(
      generateParameterCombinations({
        stopLossPips: { min: 10, max: 10, step: 10 },
        takeProfitPips: { min: 20, max: 20, step: 20 },
      }),
    ).toEqual([
      {
        stopLossPips: 10,
        takeProfitPips: 20,
        trailingStopPips: null,
      },
    ]);
  });

  it('splits bars into 70 percent optimization and 30 percent validation', () => {
    const bars = Array.from({ length: 10 }, (_, index) => bar(index));
    const split = splitOptimizationBars(bars);

    expect(split.optimizationBars).toHaveLength(7);
    expect(split.validationBars).toHaveLength(3);
    expect(split.validationBars[0].t).toBe(7 * 3600);
  });

  it('scores backtest results with money-based metrics', () => {
    expect(
      scoreBacktestResult(
        result({
          netProfitYen: 123_000,
          profitFactor: 2.4,
          maxDrawdownYen: 18_000,
          maxDrawdownPct: 1.8,
          tradeCount: 12,
          winRate: 58,
        }),
      ),
    ).toEqual({
      netProfitYen: 123_000,
      profitFactor: 2.4,
      maxDrawdownYen: 18_000,
      maxDrawdownPct: 1.8,
      tradeCount: 12,
      winRate: 58,
    });
  });

  it('flags large validation divergence as overfitting suspicion', () => {
    const optimization = scoreBacktestResult(result({ netProfitYen: 100_000 }));
    const validation = scoreBacktestResult(result({ netProfitYen: 20_000 }));

    expect(validationToOptimizationRatio(optimization, validation)).toBe(0.2);
    expect(isOverfitSuspect(optimization, validation)).toBe(true);
  });
});

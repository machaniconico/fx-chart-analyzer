import { describe, expect, it } from 'vitest';
import { isEligible, rankRows } from './tune-virtual-strategies.mjs';

const row = ({
  optNet,
  optDd = 10_000,
  optPf = 1.5,
  valNet = optNet,
  valTrades = 20,
  ratio = valNet / Math.max(optNet, 1),
  overfitWarning = false,
}) => ({
  parameters: { stopLossPips: 30, takeProfitPips: 60, trailingStopPips: null },
  optimization: {
    netProfitYen: optNet,
    profitFactor: optPf,
    maxDrawdownYen: optDd,
    maxDrawdownPct: 1,
    tradeCount: 40,
    winRate: 50,
  },
  validation: {
    netProfitYen: valNet,
    profitFactor: 1.2,
    maxDrawdownYen: 5_000,
    maxDrawdownPct: 1,
    tradeCount: valTrades,
    winRate: 50,
  },
  validationToOptimizationRatio: ratio,
  overfitWarning,
});

describe('tune-virtual-strategies ranking', () => {
  it('ranks by the optimization window, not the validation window', () => {
    const strongOptimization = row({ optNet: 100_000, valNet: 5_000 });
    const strongValidation = row({ optNet: 50_000, valNet: 90_000 });

    const ranked = rankRows([strongValidation, strongOptimization]);

    // Under the old validation-first ordering strongValidation ranked first; the
    // corrected ordering puts the higher in-sample profit on top.
    expect(ranked[0]).toBe(strongOptimization);
    expect(ranked[1]).toBe(strongValidation);
  });

  it('breaks optimization ties by the smaller in-sample drawdown', () => {
    const deepDrawdown = row({ optNet: 100_000, optDd: 20_000 });
    const shallowDrawdown = row({ optNet: 100_000, optDd: 5_000 });

    expect(rankRows([deepDrawdown, shallowDrawdown])[0]).toBe(shallowDrawdown);
  });

  it('accepts a row that is profitable in and out of sample without overfit warning', () => {
    expect(isEligible(row({ optNet: 100_000, valNet: 60_000 }))).toBe(true);
  });

  it('rejects rows flagged as overfit even when both windows are green', () => {
    expect(isEligible(row({ optNet: 100_000, valNet: 60_000, overfitWarning: true }))).toBe(false);
  });

  it('rejects rows whose validation keeps less than 35 percent of in-sample profit', () => {
    expect(isEligible(row({ optNet: 100_000, valNet: 20_000, ratio: 0.2 }))).toBe(false);
  });

  it('rejects rows with fewer than ten validation trades', () => {
    expect(isEligible(row({ optNet: 100_000, valNet: 60_000, valTrades: 9 }))).toBe(false);
  });

  it('rejects rows that lose money in the optimization window', () => {
    expect(isEligible(row({ optNet: -10_000, valNet: 60_000 }))).toBe(false);
  });
});

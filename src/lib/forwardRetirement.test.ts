import { describe, expect, it } from 'vitest';
import {
  evaluateForwardRetirement,
  type ForwardRetirementInput,
} from './forwardRetirement';
import {
  hasOperationStatus,
  type ForwardMetrics,
  type ForwardResultsFile,
  type ForwardStrategyResult,
} from './forward-test';

const baseInput: ForwardRetirementInput = {
  profitFactor: 1.1,
  tradeCount: 10,
  confirmedDayCount: 44,
  netProfitYen: 1_000,
};

const evaluate = (overrides: Partial<ForwardRetirementInput>) =>
  evaluateForwardRetirement({ ...baseInput, ...overrides });

describe('evaluateForwardRetirement', () => {
  it('keeps fewer than 10 trades active as an explicitly insufficient sample', () => {
    const result = evaluate({
      profitFactor: 0.1,
      tradeCount: 9,
      confirmedDayCount: 100,
      netProfitYen: -100_000,
    });

    expect(result).toEqual({
      status: 'active',
      reason: 'サンプル不足（取引10件未満）のためactive: PF=0.10、取引数=9件、確定日数=100日',
    });
  });

  it.each([
    {
      name: 'retires at exactly 20 trades when PF is below 0.9',
      input: { profitFactor: 0.899, tradeCount: 20 },
      expected: 'retire_candidate',
    },
    {
      name: 'retires above the 20-trade boundary when PF is below 0.9',
      input: { profitFactor: 0.899, tradeCount: 21 },
      expected: 'retire_candidate',
    },
    {
      name: 'does not use the first rule below 20 trades',
      input: { profitFactor: 0.899, tradeCount: 19 },
      expected: 'probation',
    },
    {
      name: 'does not use the first rule when PF is exactly 0.9',
      input: { profitFactor: 0.9, tradeCount: 20 },
      expected: 'probation',
    },
  ])('$name', ({ input, expected }) => {
    const result = evaluate(input);
    expect(result.status).toBe(expected);
    expect(result.reason).toContain(`PF=${input.profitFactor.toFixed(2)}`);
  });

  it.each([
    {
      name: 'retires at exactly 45 confirmed days with 10 trades and a loss',
      input: {
        profitFactor: 1.1,
        tradeCount: 10,
        confirmedDayCount: 45,
        netProfitYen: -1,
      },
      expected: 'retire_candidate',
    },
    {
      name: 'does not use the loss rule at 44 confirmed days',
      input: {
        profitFactor: 1.1,
        tradeCount: 10,
        confirmedDayCount: 44,
        netProfitYen: -1,
      },
      expected: 'active',
    },
    {
      name: 'does not use the loss rule below 10 trades',
      input: {
        profitFactor: 1.1,
        tradeCount: 9,
        confirmedDayCount: 45,
        netProfitYen: -1,
      },
      expected: 'active',
    },
    {
      name: 'does not use the loss rule at zero cumulative profit',
      input: {
        profitFactor: 1.1,
        tradeCount: 10,
        confirmedDayCount: 45,
        netProfitYen: 0,
      },
      expected: 'active',
    },
    {
      name: 'retires above the confirmed-day boundary',
      input: {
        profitFactor: 1.1,
        tradeCount: 10,
        confirmedDayCount: 46,
        netProfitYen: -1,
      },
      expected: 'retire_candidate',
    },
    {
      name: 'retires above the trade-count boundary for the confirmed loss rule',
      input: {
        profitFactor: 1.1,
        tradeCount: 11,
        confirmedDayCount: 45,
        netProfitYen: -1,
      },
      expected: 'retire_candidate',
    },
    {
      name: 'does not treat unavailable cumulative profit as a loss',
      input: {
        profitFactor: 1.1,
        tradeCount: 10,
        confirmedDayCount: 45,
        netProfitYen: null,
      },
      expected: 'active',
    },
  ])('$name', ({ input, expected }) => {
    expect(evaluate(input).status).toBe(expected);
  });

  it('prioritizes the 20-trade PF rule over the confirmed-loss rule', () => {
    const result = evaluate({
      profitFactor: 0.8,
      tradeCount: 20,
      confirmedDayCount: 45,
      netProfitYen: -1,
    });

    expect(result.status).toBe('retire_candidate');
    expect(result.reason).toContain('取引20件以上かつPF 0.9未満');
  });

  it('prioritizes the confirmed-loss rule over probation', () => {
    const result = evaluate({
      profitFactor: 0.99,
      tradeCount: 10,
      confirmedDayCount: 45,
      netProfitYen: -1_234_567,
    });

    expect(result).toEqual({
      status: 'retire_candidate',
      reason: '確定45日以上・取引10件以上・累積損益-1,234,567円: PF=0.99、取引数=10件、確定日数=45日',
    });
  });

  it.each([
    { profitFactor: 0.999, expected: 'probation' },
    { profitFactor: 1, expected: 'active' },
  ])('evaluates the PF 1.0 boundary at $profitFactor', ({ profitFactor, expected }) => {
    const result = evaluate({ profitFactor, tradeCount: 10 });
    expect(result.status).toBe(expected);
    expect(result.reason).toContain(`PF=${profitFactor.toFixed(2)}`);
  });

  it('keeps a sufficient, non-triggering result active and reports all values', () => {
    const result = evaluate({
      profitFactor: 1.2,
      tradeCount: 12,
      confirmedDayCount: 46,
      netProfitYen: 500,
    });

    expect(result).toEqual({
      status: 'active',
      reason: '淘汰・probation条件に該当せずactive: PF=1.20、取引数=12件、確定日数=46日',
    });
  });

  it.each([
    { profitFactor: null, displayedProfitFactor: '∞（損失0）' },
    { profitFactor: Number.POSITIVE_INFINITY, displayedProfitFactor: '∞' },
  ])(
    'keeps PF=$displayedProfitFactor active with 20 trades and positive cumulative profit',
    ({ profitFactor, displayedProfitFactor }) => {
      const result = evaluate({
        profitFactor,
        tradeCount: 20,
        confirmedDayCount: 45,
        netProfitYen: 100_000,
      });

      expect(result).toEqual({
        status: 'active',
        reason: `淘汰・probation条件に該当せずactive: PF=${displayedProfitFactor}、取引数=20件、確定日数=45日`,
      });
    },
  );
});

const emptyMetrics: ForwardMetrics = {
  spreadPips: null,
  winRate: null,
  profitFactor: null,
  maxDrawdownPips: null,
  maxDrawdownYen: null,
  maxDrawdownPct: null,
  tradeCount: 0,
  netPips: null,
  netProfitYen: null,
  grossProfitPips: null,
  grossLossPips: null,
  grossProfitYen: null,
  grossLossYen: null,
  riskRewardRatio: null,
  averageWinYen: null,
  averageLossYen: null,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
};

const legacyStrategyResult: ForwardStrategyResult = {
  meta: {
    id: 'legacy-v2',
    name: '旧形式',
    version: 1,
    pair: 'USDJPY',
    timeframe: 'h1',
    registeredAt: 0,
  },
  forward: {
    metrics: emptyMetrics,
    trades: [],
    equityCurve: [],
  },
  backtestReference: emptyMetrics,
  barsEvaluated: 0,
};

describe('forward results backward compatibility', () => {
  it('accepts schema v2 without operationStatus and narrows valid v3 status at runtime', () => {
    const legacyFile: ForwardResultsFile = {
      schemaVersion: 2,
      computedAt: '2026-08-17T00:00:00.000Z',
      strategies: [legacyStrategyResult],
    };
    const currentResult: ForwardStrategyResult = {
      ...legacyStrategyResult,
      operationStatus: {
        status: 'active',
        reason: 'サンプル不足',
      },
    };

    expect(legacyFile.schemaVersion).toBe(2);
    expect(hasOperationStatus(legacyStrategyResult)).toBe(false);
    expect(hasOperationStatus(currentResult)).toBe(true);
    if (hasOperationStatus(currentResult)) {
      expect(currentResult.operationStatus.reason).toBe('サンプル不足');
    }
  });

  it('rejects malformed operationStatus values during runtime narrowing', () => {
    const malformedResult = {
      ...legacyStrategyResult,
      operationStatus: {
        status: 'paused',
        reason: 123,
      },
    } as unknown as ForwardStrategyResult;

    expect(hasOperationStatus(malformedResult)).toBe(false);
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildStrategyReport,
  splitBarsByRegistration,
  TWO_YEARS_SECONDS,
} from './run-forward-test.mjs';

const registeredAt = 1782996300;

const bar = (time) => ({
  t: time,
  o: 100,
  h: 101,
  l: 99,
  c: 100,
  v: 1000,
});

const strategy = {
  meta: {
    id: 'virtual-test-v1',
    name: '仮想テスト',
    version: 1,
    pair: 'USDJPY',
    timeframe: 'h1',
    registeredAt,
  },
  id: 'virtual-test-v1',
  name: '仮想テスト',
  direction: 'long',
  entryDirections: ['long', 'short'],
  entryConditions: [
    {
      type: 'maCross',
      fastType: 'ema',
      fastPeriod: 10,
      slowType: 'ema',
      slowPeriod: 20,
    },
  ],
  exit: {
    stopLossPips: 10,
    takeProfitPips: 20,
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
  moneyManagement: {
    initialBalanceYen: 1_000_000,
    lotSizingMode: 'fixedRisk',
    fixedLot: 0.1,
    riskPercent: 1,
    maxLot: 100,
  },
  magicNumber: 1,
};

const emptyBacktestResult = (bars) => ({
  pair: 'USDJPY',
  spreadPips: 0.9,
  moneyManagement: strategy.moneyManagement,
  conversionNote: '',
  winRate: 0,
  profitFactor: 0,
  maxDrawdownPips: 0,
  maxDrawdownYen: 0,
  maxDrawdownPct: 0,
  tradeCount: 0,
  netPips: 0,
  netProfitYen: 0,
  grossProfitPips: 0,
  grossLossPips: 0,
  grossProfitYen: 0,
  grossLossYen: 0,
  riskRewardRatio: 0,
  averageWinYen: 0,
  averageLossYen: 0,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
  trades: [],
  equityCurve: bars.map((item) => ({
    time: item.t,
    equityPips: 0,
    drawdownPips: 0,
    equityYen: 1_000_000,
    netProfitYen: 0,
    drawdownYen: 0,
    drawdownPct: 0,
  })),
});

describe('forward test runner', () => {
  it('filters forward bars to registeredAt or later', () => {
    const bars = [
      bar(registeredAt - TWO_YEARS_SECONDS - 60),
      bar(registeredAt - 60),
      bar(registeredAt),
      bar(registeredAt + 60),
    ];

    const split = splitBarsByRegistration(bars, registeredAt);

    expect(split.forwardBars.map((item) => item.t)).toEqual([registeredAt, registeredAt + 60]);
    expect(split.referenceBars.map((item) => item.t)).toEqual([registeredAt - 60]);
  });

  it('does not pass pre-registration bars into the forward backtest', () => {
    const calls = [];
    const report = buildStrategyReport({
      strategy,
      bars: [bar(registeredAt - 60), bar(registeredAt), bar(registeredAt + 60)],
      usdJpyBars: [bar(registeredAt - 30), bar(registeredAt + 30)],
      runBacktest: (bars) => {
        calls.push(bars);
        return emptyBacktestResult(bars);
      },
    });

    expect(calls[0].every((item) => item.t >= registeredAt)).toBe(true);
    expect(calls[1].every((item) => item.t < registeredAt)).toBe(true);
    expect(report.barsEvaluated).toBe(2);
  });

  it('keeps the expected zero-trade schema', () => {
    const report = buildStrategyReport({
      strategy,
      bars: [bar(registeredAt - 60)],
      usdJpyBars: [bar(registeredAt - 60)],
      runBacktest: emptyBacktestResult,
    });

    expect(report).toMatchObject({
      meta: strategy.meta,
      forward: {
        metrics: {
          tradeCount: 0,
          winRate: 0,
          netProfitYen: 0,
          maxDrawdownYen: 0,
        },
        trades: [],
        equityCurve: [],
      },
      barsEvaluated: 0,
    });
  });

  it('rejects invalid virtual strategy JSON before running backtests', () => {
    const cases = [
      {
        id: 'invalid-stop-v1',
        patch: {
          exit: {
            ...strategy.exit,
            stopLossPips: 0,
          },
        },
        expected: /invalid-stop-v1: exit\.stopLossPips must be a positive finite number/,
      },
      {
        id: 'invalid-take-v1',
        patch: {
          exit: {
            ...strategy.exit,
            takeProfitPips: null,
          },
        },
        expected: /invalid-take-v1: exit\.takeProfitPips must be a positive finite number/,
      },
      {
        id: 'invalid-empty-conditions-v1',
        patch: {
          entryConditions: [],
        },
        expected: /invalid-empty-conditions-v1: entryConditions must be a non-empty array/,
      },
      {
        id: 'invalid-condition-type-v1',
        patch: {
          entryConditions: [
            {
              type: 'macd',
            },
          ],
        },
        expected: /invalid-condition-type-v1: entryConditions\[0\]\.type must be one of maCross, rsi, bollinger, macdCross/,
      },
    ];

    for (const { id, patch, expected } of cases) {
      const invalidStrategy = JSON.parse(JSON.stringify({
        ...strategy,
        ...patch,
        meta: {
          ...strategy.meta,
          id,
        },
        id,
      }));

      expect(() =>
        buildStrategyReport({
          strategy: invalidStrategy,
          bars: [bar(registeredAt)],
          usdJpyBars: [bar(registeredAt)],
          runBacktest: emptyBacktestResult,
        }),
      ).toThrow(expected);
    }
  });

  it('validates the generated public results schema', async () => {
    const payload = JSON.parse(await readFile('public/data/forward/results.json', 'utf8'));

    expect(typeof payload.computedAt).toBe('string');
    expect(payload.strategies).toHaveLength(3);

    for (const item of payload.strategies) {
      expect(item.meta).toEqual({
        id: expect.any(String),
        name: expect.any(String),
        version: 1,
        pair: expect.any(String),
        timeframe: expect.any(String),
        registeredAt,
      });
      expect(item.forward.metrics.tradeCount).toEqual(expect.any(Number));
      expect(Array.isArray(item.forward.trades)).toBe(true);
      expect(Array.isArray(item.forward.equityCurve)).toBe(true);
      expect(item.backtestReference.tradeCount).toEqual(expect.any(Number));
      expect(item.barsEvaluated).toEqual(expect.any(Number));
      expect(item.forward.trades.every((trade) => trade.entryTime >= registeredAt)).toBe(true);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { runBacktest } from './backtest';
import type { StrategyDefinition } from './strategy';
import type { Bar } from '../types';

const bar = (
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Bar => ({
  t: index * 3600,
  o: open,
  h: high,
  l: low,
  c: close,
  v: 1000,
});

const crossSetupBars = (entryBar: Bar, extraBars: Bar[] = []): Bar[] => [
  bar(0, 100.0, 100.02, 99.98, 100.0),
  bar(1, 100.0, 100.02, 99.88, 99.9),
  bar(2, 99.9, 99.92, 99.78, 99.8),
  bar(3, 99.8, 99.92, 99.78, 99.9),
  bar(4, 99.9, 100.22, 99.88, 100.2),
  entryBar,
  ...extraBars,
];

const baseStrategy = (overrides: Partial<StrategyDefinition['exit']> = {}): StrategyDefinition => ({
  id: 'test-ma-cross',
  name: 'Test MA Cross',
  direction: 'long',
  entryConditions: [
    {
      type: 'maCross',
      fastType: 'sma',
      fastPeriod: 2,
      slowType: 'sma',
      slowPeriod: 3,
    },
  ],
  exit: {
    stopLossPips: 10,
    takeProfitPips: 20,
    trailingStopPips: null,
    closeOnOppositeSignal: false,
    ...overrides,
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
    lotSizingMode: 'fixedLot',
    fixedLot: 0.1,
    riskPercent: 1,
    maxLot: 100,
  },
  magicNumber: 12345,
});

const alwaysEntryStrategy = (
  overrides: Partial<StrategyDefinition['exit']> = {},
  moneyManagement: StrategyDefinition['moneyManagement'] = {
    initialBalanceYen: 1_000_000,
    lotSizingMode: 'fixedLot',
    fixedLot: 1,
    riskPercent: 1,
    maxLot: 100,
  },
): StrategyDefinition => ({
  ...baseStrategy({
    stopLossPips: 10,
    takeProfitPips: 10,
    trailingStopPips: null,
    closeOnOppositeSignal: false,
    ...overrides,
  }),
  id: 'always-entry',
  entryConditions: [
    {
      type: 'bollinger',
      period: 1,
      multiplier: 2,
      mode: 'touch',
      band: 'lower',
    },
  ],
  lotSize: moneyManagement?.fixedLot ?? 1,
  moneyManagement,
});

describe('backtest', () => {
  it('enters on the next bar open and exits at take profit', () => {
    const result = runBacktest(
      crossSetupBars(bar(5, 100.2, 100.45, 100.15, 100.3)),
      baseStrategy(),
      'USDJPY',
    );

    expect(result.tradeCount).toBe(1);
    expect(result.winRate).toBe(100);
    expect(result.netPips).toBeCloseTo(19.1);
    expect(result.netProfitYen).toBe(1910);
    expect(result.profitFactor).toBe(Number.POSITIVE_INFINITY);
    expect(result.riskRewardRatio).toBe(Number.POSITIVE_INFINITY);
    expect(result.averageWinYen).toBe(1910);
    expect(result.trades[0]).toMatchObject({
      entryTime: 5 * 3600,
      exitReason: 'take_profit',
      grossPips: 20,
      spreadPips: 0.9,
      netPips: 19.1,
      lotSize: 0.1,
      netProfitYen: 1910,
    });
    expect(result.trades[0].entryPrice).toBeCloseTo(100.2);
    expect(result.trades[0].exitPrice).toBeCloseTo(100.4);
  });

  it('uses the pessimistic stop-loss path when stop and target are both touched', () => {
    const result = runBacktest(
      crossSetupBars(bar(5, 100.2, 100.45, 100.05, 100.25)),
      baseStrategy(),
      'USDJPY',
    );

    expect(result.tradeCount).toBe(1);
    expect(result.winRate).toBe(0);
    expect(result.netPips).toBeCloseTo(-10.9);
    expect(result.maxDrawdownPips).toBeCloseTo(10.9);
    expect(result.netProfitYen).toBe(-1090);
    expect(result.maxDrawdownYen).toBe(1090);
    expect(result.maxDrawdownPct).toBeCloseTo(0.109);
    expect(result.trades[0].exitReason).toBe('stop_loss');
    expect(result.trades[0].grossPips).toBe(-10);
    expect(result.trades[0].exitPrice).toBeCloseTo(100.1);
  });

  it('moves the trailing stop after a favorable bar and exits on the next bar', () => {
    const result = runBacktest(
      crossSetupBars(
        bar(5, 100.2, 100.35, 100.18, 100.31),
        [bar(6, 100.31, 100.32, 100.24, 100.26)],
      ),
      baseStrategy({ stopLossPips: 50, takeProfitPips: 100, trailingStopPips: 10 }),
      'USDJPY',
    );

    expect(result.tradeCount).toBe(1);
    expect(result.netPips).toBeCloseTo(4.1);
    expect(result.netProfitYen).toBe(410);
    expect(result.trades[0].exitReason).toBe('trailing_stop');
    expect(result.trades[0].grossPips).toBe(5);
    expect(result.trades[0].exitPrice).toBeCloseTo(100.25);
  });

  it('blocks new entries outside the configured server-time session', () => {
    const result = runBacktest(
      crossSetupBars(bar(5, 100.2, 100.45, 100.15, 100.3)),
      {
        ...baseStrategy(),
        sessionFilter: {
          enabled: true,
          start: '06:00',
          end: '08:00',
          serverUtcOffsetMinutes: 0,
        },
      },
      'USDJPY',
    );

    expect(result.tradeCount).toBe(0);
    expect(result.netPips).toBe(0);
  });

  it('applies the configured server UTC offset to session filtering', () => {
    const result = runBacktest(
      crossSetupBars(bar(5, 100.2, 100.45, 100.15, 100.3)),
      {
        ...baseStrategy(),
        sessionFilter: {
          enabled: true,
          start: '07:00',
          end: '08:00',
          serverUtcOffsetMinutes: 120,
        },
      },
      'USDJPY',
    );

    expect(result.tradeCount).toBe(1);
  });

  it('sizes fixed risk percent lots from stop-loss distance', () => {
    const result = runBacktest(
      crossSetupBars(bar(5, 100.2, 100.45, 100.15, 100.3)),
      {
        ...baseStrategy(),
        moneyManagement: {
          initialBalanceYen: 1_000_000,
          lotSizingMode: 'fixedRisk',
          fixedLot: 0.1,
          riskPercent: 1,
          maxLot: 100,
        },
      },
      'USDJPY',
    );

    expect(result.trades[0].lotSize).toBe(0.92);
    expect(result.trades[0].netProfitYen).toBe(17_572);
    expect(result.netProfitYen).toBe(17_572);
  });

  it('caps fixed risk percent lots at the configured maximum', () => {
    const result = runBacktest(
      crossSetupBars(bar(5, 100.2, 100.45, 100.15, 100.3)),
      {
        ...baseStrategy({ stopLossPips: 1 }),
        moneyManagement: {
          initialBalanceYen: 1_000_000,
          lotSizingMode: 'fixedRisk',
          fixedLot: 0.1,
          riskPercent: 100,
          maxLot: 3,
        },
      },
      'USDJPY',
    );

    expect(result.trades[0].lotSize).toBe(3);
  });

  it('compounds lot size from the current balance', () => {
    const result = runBacktest(
      [
        bar(0, 100.0, 100.02, 99.98, 100.0),
        bar(1, 100.0, 100.02, 99.98, 100.0),
        bar(2, 100.1, 100.22, 100.08, 100.15),
        bar(3, 100.2, 100.32, 100.18, 100.25),
      ],
      alwaysEntryStrategy(
        {},
        {
          initialBalanceYen: 1_000_000,
          lotSizingMode: 'compound',
          fixedLot: 1,
          riskPercent: 1,
          maxLot: 100,
        },
      ),
      'USDJPY',
      { spreadPips: 0 },
    );

    expect(result.tradeCount).toBe(2);
    expect(result.trades.map((trade) => trade.lotSize)).toEqual([1, 1.01]);
    expect(result.trades.map((trade) => trade.netProfitYen)).toEqual([10_000, 10_100]);
    expect(result.netProfitYen).toBe(20_100);
    expect(result.equityCurve[result.equityCurve.length - 1]?.equityYen).toBe(1_020_100);
  });

  it('caps compound lot size at the configured maximum', () => {
    const result = runBacktest(
      [
        bar(0, 100.0, 100.02, 99.98, 100.0),
        bar(1, 100.0, 100.02, 99.98, 100.0),
        bar(2, 100.1, 100.22, 100.08, 100.15),
        bar(3, 100.2, 100.32, 100.18, 100.25),
      ],
      alwaysEntryStrategy(
        {},
        {
          initialBalanceYen: 1_000_000,
          lotSizingMode: 'compound',
          fixedLot: 2,
          riskPercent: 1,
          maxLot: 1.5,
        },
      ),
      'USDJPY',
      { spreadPips: 0 },
    );

    expect(result.trades.map((trade) => trade.lotSize)).toEqual([1.5, 1.5]);
  });

  it('converts non-JPY quote pips through synchronized USDJPY bars', () => {
    const result = runBacktest(
      [
        bar(0, 1.1, 1.1002, 1.0998, 1.1),
        bar(1, 1.1, 1.1002, 1.0998, 1.1),
        bar(2, 1.1, 1.1012, 1.0998, 1.1005),
      ],
      alwaysEntryStrategy(),
      'EURUSD',
      {
        spreadPips: 0,
        usdJpyBars: [bar(2, 140, 140.1, 139.9, 140)],
      },
    );

    expect(result.tradeCount).toBe(1);
    expect(result.trades[0].pipValueYenPerLot).toBe(1400);
    expect(result.trades[0].netProfitYen).toBe(14_000);
    expect(result.conversionNote).toContain('同時刻近傍');
  });

  it('falls back to a fixed USDJPY rate for non-JPY conversion without USDJPY bars', () => {
    const result = runBacktest(
      [
        bar(0, 1.1, 1.1002, 1.0998, 1.1),
        bar(1, 1.1, 1.1002, 1.0998, 1.1),
        bar(2, 1.1, 1.1012, 1.0998, 1.1005),
      ],
      alwaysEntryStrategy(),
      'EURUSD',
      { spreadPips: 0 },
    );

    expect(result.trades[0].pipValueYenPerLot).toBe(1500);
    expect(result.trades[0].netProfitYen).toBe(15_000);
    expect(result.conversionNote).toContain('USDJPY=150円');
  });

  it('counts maximum consecutive losses from yen results', () => {
    const result = runBacktest(
      [
        bar(0, 100.0, 100.02, 99.98, 100.0),
        bar(1, 100.0, 100.02, 99.98, 100.0),
        bar(2, 100.1, 100.12, 99.99, 100.02),
        bar(3, 100.2, 100.22, 100.09, 100.12),
        bar(4, 100.3, 100.32, 100.19, 100.22),
      ],
      alwaysEntryStrategy({ takeProfitPips: 100 }),
      'USDJPY',
      { spreadPips: 0 },
    );

    expect(result.tradeCount).toBe(3);
    expect(result.maxConsecutiveWins).toBe(0);
    expect(result.maxConsecutiveLosses).toBe(3);
    expect(result.netProfitYen).toBe(-30_000);
  });

  it('fills a gapped stop at the bar open instead of the stop price', () => {
    const result = runBacktest(
      crossSetupBars(
        bar(5, 100.2, 100.35, 100.18, 100.31),
        [bar(6, 99.0, 99.1, 98.9, 99.0)],
      ),
      baseStrategy({ stopLossPips: 50, takeProfitPips: 100 }),
      'USDJPY',
    );

    expect(result.tradeCount).toBe(1);
    expect(result.trades[0].exitReason).toBe('stop_loss');
    // Stop sits at 99.70 but the bar gaps open to 99.00, so the fill is the open,
    // not the stop price (-120 pips, far worse than the naive -50 pip stop).
    expect(result.trades[0].exitPrice).toBeCloseTo(99.0);
    expect(result.trades[0].grossPips).toBe(-120);
    expect(result.netPips).toBeCloseTo(-120.9);
  });

  it('records floating drawdown while a position is held, not just realized losses', () => {
    const result = runBacktest(
      [
        bar(0, 100.0, 100.05, 99.95, 100.0),
        bar(1, 100.0, 100.05, 99.95, 100.0),
        bar(2, 100.0, 100.05, 99.95, 100.0),
        bar(3, 99.9, 99.95, 99.1, 99.5),
        bar(4, 99.6, 100.6, 99.55, 100.5),
      ],
      alwaysEntryStrategy({ stopLossPips: 200, takeProfitPips: 50 }),
      'USDJPY',
      { spreadPips: 0 },
    );

    expect(result.tradeCount).toBe(1);
    expect(result.trades[0].exitReason).toBe('take_profit');
    expect(result.netProfitYen).toBe(50_000);
    // The position sank to -90 pips (bar 3 low 99.10 vs entry 100.00) before the
    // take profit, so drawdown reflects the floating loss, not the winning close.
    expect(result.maxDrawdownPips).toBeCloseTo(90);
    expect(result.maxDrawdownYen).toBe(90_000);
    expect(result.maxDrawdownPct).toBeCloseTo(9);
  });

  it('can evaluate long and short entries from one strategy definition', () => {
    const result = runBacktest(
      [
        bar(0, 100.0, 100.02, 99.98, 100.0),
        bar(1, 100.0, 100.02, 99.88, 99.9),
        bar(2, 99.9, 99.92, 99.78, 99.8),
        bar(3, 99.8, 99.92, 99.78, 99.9),
        bar(4, 99.9, 100.22, 99.88, 100.2),
        bar(5, 100.2, 100.45, 100.15, 100.3),
        bar(6, 100.3, 100.32, 100.18, 100.2),
        bar(7, 100.2, 100.22, 100.08, 100.1),
        bar(8, 100.1, 100.12, 99.88, 99.9),
        bar(9, 99.9, 99.95, 99.55, 99.7),
      ],
      {
        ...baseStrategy(),
        entryDirections: ['long', 'short'],
      },
      'USDJPY',
    );

    expect(result.tradeCount).toBe(2);
    expect(result.trades.map((trade) => trade.direction)).toEqual(['long', 'short']);
    expect(result.trades.map((trade) => trade.exitReason)).toEqual(['take_profit', 'take_profit']);
  });
});

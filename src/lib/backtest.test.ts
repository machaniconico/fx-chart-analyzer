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
  lotSize: 0.1,
  magicNumber: 12345,
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
    expect(result.profitFactor).toBe(Number.POSITIVE_INFINITY);
    expect(result.trades[0]).toMatchObject({
      entryTime: 5 * 3600,
      exitReason: 'take_profit',
      grossPips: 20,
      spreadPips: 0.9,
      netPips: 19.1,
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
    expect(result.trades[0].exitReason).toBe('trailing_stop');
    expect(result.trades[0].grossPips).toBe(5);
    expect(result.trades[0].exitPrice).toBeCloseTo(100.25);
  });
});

import { describe, expect, it } from 'vitest';
import type { Bar } from '../types';
import {
  conditionLabel,
  createStrategyEvaluator,
  type EntryCondition,
  type StrategyDefinition,
} from './strategy';

const bar = (index: number, high: number, low: number, close: number): Bar => ({
  t: index * 60,
  o: close,
  h: high,
  l: low,
  c: close,
  v: 1,
});

const strategyFor = (
  condition: EntryCondition,
  direction: 'long' | 'short' = 'long',
): StrategyDefinition => ({
  id: 'strategy-test',
  name: 'Strategy test',
  direction,
  entryConditions: [condition],
  exit: {
    stopLossPips: 10,
    takeProfitPips: 20,
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
  magicNumber: 1,
});

describe('strategy evaluator', () => {
  it('evaluates Donchian breaks without including the current bar', () => {
    const bars = [
      bar(0, 10, 5, 7),
      bar(1, 12, 6, 8),
      bar(2, 20, 7, 13),
    ];
    const strategy = strategyFor({ type: 'donchianBreak', period: 2 });
    const evaluator = createStrategyEvaluator(bars);

    expect(evaluator.isEntrySignal(strategy, 1)).toBe(false);
    expect(evaluator.isEntrySignal(strategy, 2)).toBe(true);
    expect(evaluator.isEntrySignal(strategy, 2, 'short')).toBe(false);
  });

  it('mirrors Donchian breaks for short entries', () => {
    const bars = [
      bar(0, 10, 5, 7),
      bar(1, 12, 6, 8),
      bar(2, 13, 0, 4),
    ];
    const strategy = strategyFor({ type: 'donchianBreak', period: 2 }, 'short');
    const evaluator = createStrategyEvaluator(bars);

    expect(evaluator.isEntrySignal(strategy, 2)).toBe(true);
    expect(evaluator.isEntrySignal(strategy, 2, 'long')).toBe(false);
  });

  it('detects stochastic crossAbove for long and the mirrored crossBelow for short', () => {
    const condition = {
      type: 'stochastic' as const,
      kPeriod: 2,
      dPeriod: 1,
      smoothing: 1,
      threshold: 50,
      comparison: 'crossAbove' as const,
    };
    const longBars = [bar(0, 10, 0, 1), bar(1, 10, 0, 0), bar(2, 10, 0, 10)];
    const longStrategy = strategyFor(condition);
    const longEvaluator = createStrategyEvaluator(longBars);
    expect(longEvaluator.isEntrySignal(longStrategy, 2)).toBe(true);

    const shortBars = [bar(0, 10, 0, 1), bar(1, 10, 0, 10), bar(2, 10, 0, 0)];
    const crossBelowCondition = { ...condition, comparison: 'crossBelow' as const };
    const crossBelowStrategy = strategyFor(crossBelowCondition);
    const crossBelowEvaluator = createStrategyEvaluator(shortBars);
    expect(crossBelowEvaluator.isEntrySignal(crossBelowStrategy, 2)).toBe(true);

    // しきい値は非対称値(20)で固定する: 50 だと 100-threshold=50 の自己同値になり、
    // ミラー規則の欠落を検出できない。%K 90→50 なのでミラー後の crossBelow 80 のみ true
    // (ミラー欠落だと crossBelow 20 となり 50≤20 が成立せず false)。
    const shortStrategy = strategyFor({ ...condition, threshold: 20 }, 'short');
    const mirroredBars = [bar(0, 10, 0, 1), bar(1, 10, 0, 9), bar(2, 10, 0, 5)];
    const shortEvaluator = createStrategyEvaluator(mirroredBars);
    expect(shortEvaluator.isEntrySignal(shortStrategy, 2)).toBe(true);
  });

  it('labels the new strategy conditions', () => {
    expect(conditionLabel({ type: 'donchianBreak', period: 20 })).toBe('Donchian20 ブレイク');
    expect(
      conditionLabel({
        type: 'stochastic',
        kPeriod: 14,
        dPeriod: 3,
        smoothing: 3,
        threshold: 20,
        comparison: 'crossAbove',
      }),
    ).toBe('Stoch14/3/3 crossAbove 20');
  });
});

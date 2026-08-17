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

  it('evaluates Keltner breaks long/short with a close boundary and no look-ahead', () => {
    const condition = {
      type: 'keltnerBreak' as const,
      emaPeriod: 2,
      atrPeriod: 2,
      multiplier: 0.1,
    };
    const longBars = [
      bar(0, 10.5, 9.5, 10),
      bar(1, 10.5, 9.5, 10),
      bar(2, 20, 20, 20),
    ];
    const shortBars = [
      bar(0, 10.5, 9.5, 10),
      bar(1, 10.5, 9.5, 10),
      bar(2, 0, 0, 0),
    ];

    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition), 2)).toBe(true);
    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition, 'short'), 2)).toBe(
      false,
    );
    expect(createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition, 'short'), 2)).toBe(
      true,
    );
    expect(createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition), 2)).toBe(false);

    const withFuture = [...longBars, bar(3, 1_000, -1_000, 500)];
    expect(createStrategyEvaluator(withFuture).isEntrySignal(strategyFor(condition), 2)).toBe(true);
  });

  it('accepts exact Keltner boundaries and fails closed for non-finite bands', () => {
    const boundaryCondition = {
      type: 'keltnerBreak' as const,
      emaPeriod: 2,
      atrPeriod: 2,
      multiplier: 2,
    };
    const flatBars = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 10, 10, 10)];
    const flatEvaluator = createStrategyEvaluator(flatBars);
    expect(flatEvaluator.isEntrySignal(strategyFor(boundaryCondition), 2)).toBe(true);
    expect(flatEvaluator.isEntrySignal(strategyFor(boundaryCondition, 'short'), 2)).toBe(true);

    const nonFiniteBars = [
      bar(0, 10.5, 9.5, 10),
      bar(1, 10.5, 9.5, 10),
      bar(2, 10, 10, Number.NaN),
    ];
    const nonFiniteEvaluator = createStrategyEvaluator(nonFiniteBars);
    expect(nonFiniteEvaluator.isEntrySignal(strategyFor(boundaryCondition), 2)).toBe(false);
    expect(nonFiniteEvaluator.isEntrySignal(strategyFor(boundaryCondition, 'short'), 2)).toBe(false);
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

  it('requires an Ichimoku cross and the displaced cloud filter for long entries', () => {
    const bars = [
      bar(0, 11, 9, 10),
      bar(1, 11, 9, 10),
      bar(2, 11, 9, 10),
      bar(3, 1, -1, 0),
      bar(4, 11, 9, 10),
      bar(5, 16, 14, 15),
    ];
    const condition = {
      type: 'ichimokuCross' as const,
      conversionPeriod: 2,
      basePeriod: 3,
      spanBPeriod: 4,
      displacement: 1,
      requireCloudFilter: true,
    };
    const evaluator = createStrategyEvaluator(bars);

    expect(evaluator.isEntrySignal(strategyFor(condition), 4)).toBe(false);
    expect(evaluator.isEntrySignal(strategyFor(condition), 5)).toBe(true);
    expect(conditionLabel({
      type: 'ichimokuCross',
      conversionPeriod: 9,
      basePeriod: 26,
      spanBPeriod: 52,
      displacement: 26,
      requireCloudFilter: true,
    })).toBe('一目9/26/52 クロス(雲フィルタ)');
  });

  it('mirrors Ichimoku crosses and cloud filters for short entries', () => {
    const bars = [
      bar(0, 21, 19, 20),
      bar(1, 21, 19, 20),
      bar(2, 21, 19, 20),
      bar(3, 31, 29, 30),
      bar(4, 21, 19, 20),
      bar(5, 16, 14, 15),
    ];
    const condition = {
      type: 'ichimokuCross' as const,
      conversionPeriod: 2,
      basePeriod: 3,
      spanBPeriod: 4,
      displacement: 1,
      requireCloudFilter: true,
    };
    const evaluator = createStrategyEvaluator(bars);

    expect(evaluator.isEntrySignal(strategyFor(condition, 'short'), 5)).toBe(true);
    expect(evaluator.isEntrySignal(strategyFor(condition), 5)).toBe(false);
  });

  it('fails closed when the Ichimoku cloud is incomplete and allows a cross without the filter', () => {
    const bars = [
      bar(0, 11, 9, 10),
      bar(1, 11, 9, 10),
      bar(2, 11, 9, 10),
      bar(3, 1, -1, 0),
      bar(4, 11, 9, 10),
      bar(5, 16, 14, 15),
    ];
    const filtered = strategyFor({
      type: 'ichimokuCross',
      conversionPeriod: 2,
      basePeriod: 3,
      spanBPeriod: 10,
      displacement: 1,
      requireCloudFilter: true,
    });
    const unfiltered = strategyFor({
      type: 'ichimokuCross',
      conversionPeriod: 2,
      basePeriod: 3,
      spanBPeriod: 10,
      displacement: 1,
      requireCloudFilter: false,
    });
    const evaluator = createStrategyEvaluator(bars);

    expect(evaluator.isEntrySignal(filtered, 5)).toBe(false);
    expect(evaluator.isEntrySignal(unfiltered, 5)).toBe(true);
  });

  it('keeps the Ichimoku cloud anchored to displaced (past) data at the evaluation index', () => {
    // 評価器が leadingSpan[index] でなく [index+displacement](=信号バー自身のデータ由来の雲)を
    // 読む退行を殺す: 正しい雲(バー4由来)=5 で close 15 は雲上だが、
    // 変異後の雲(バー5由来)は高値40により22となり close 15 が雲下に落ちて判定が反転する。
    const bars = [
      bar(0, 11, 9, 10),
      bar(1, 11, 9, 10),
      bar(2, 11, 9, 10),
      bar(3, 1, -1, 0),
      bar(4, 11, 9, 10),
      bar(5, 40, 14, 15),
    ];
    const condition = {
      type: 'ichimokuCross' as const,
      conversionPeriod: 2,
      basePeriod: 3,
      spanBPeriod: 4,
      displacement: 1,
      requireCloudFilter: true,
    };
    expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 5)).toBe(true);

    // 対象 index より後のバーを大きく動かしても判定は不変(未来参照なし)
    const withFuture = [...bars, bar(6, 1000, -1000, 500)];
    expect(createStrategyEvaluator(withFuture).isEntrySignal(strategyFor(condition), 5)).toBe(true);
  });

  it('rejects entries while price sits inside a non-degenerate Ichimoku cloud', () => {
    // spanA と spanB が異なる雲を用意し、終値が雲の内側にある時は long/short とも false を固定する。
    // long は max(spanA,spanB) 超え・short は min(spanA,spanB) 割れが要件なので、
    // max↔min を取り違える変異はどちらもここで落ちる。
    const condition = {
      type: 'ichimokuCross' as const,
      conversionPeriod: 2,
      basePeriod: 3,
      spanBPeriod: 4,
      displacement: 1,
      requireCloudFilter: true,
    };

    // long: クロス成立(conv 14→18 が base 14 を上抜け)、雲=[14,19]、close 16 は雲の内側 → false
    const longBars = [
      bar(0, 21, 19, 20),
      bar(1, 31, 19, 20),
      bar(2, 21, 19, 20),
      bar(3, 9, 7, 8),
      bar(4, 21, 19, 20),
      bar(5, 17, 15, 16),
    ];
    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition), 5)).toBe(false);

    // short: クロス成立(conv 26→22 が base 26 を下抜け)、雲=[22,26]、close 24 は雲の内側 → false
    const shortBars = [
      bar(0, 21, 19, 20),
      bar(1, 21, 11, 20),
      bar(2, 21, 19, 20),
      bar(3, 33, 31, 32),
      bar(4, 21, 19, 20),
      bar(5, 25, 23, 24),
    ];
    expect(
      createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition, 'short'), 5),
    ).toBe(false);
  });

  it('labels the new strategy conditions', () => {
    expect(conditionLabel({ type: 'donchianBreak', period: 20 })).toBe('Donchian20 ブレイク');
    expect(
      conditionLabel({ type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: 2 }),
    ).toBe('Keltner20/10 x2 ブレイク');
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

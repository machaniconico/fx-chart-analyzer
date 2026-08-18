import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../types';
import * as indicators from './indicators';
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

const barsFrom = (
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
): Bar[] => highs.map((high, index) => bar(index, high, lows[index], closes[index]));

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

  it('memoizes ATR by period across Keltner conditions', () => {
    const atrSpy = vi.spyOn(indicators, 'atr');
    const firstCondition = {
      type: 'keltnerBreak' as const,
      emaPeriod: 2,
      atrPeriod: 2,
      multiplier: 0.1,
    };
    const secondCondition = {
      ...firstCondition,
      emaPeriod: 3,
      multiplier: 0.2,
    };
    const strategy = {
      ...strategyFor(firstCondition),
      entryConditions: [firstCondition, secondCondition],
    };
    const bars = [
      bar(0, 10.5, 9.5, 10),
      bar(1, 10.5, 9.5, 10),
      bar(2, 20, 20, 20),
    ];

    try {
      expect(createStrategyEvaluator(bars).isEntrySignal(strategy, 2)).toBe(true);
      expect(atrSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('accepts exact Keltner band touches while ATR is positive (>= / <= inclusivity)', () => {
    // 二進小数のみで構成し、close が帯と厳密一致するケースを固定する。
    // emaPeriod 3 (alpha=0.5)・atrPeriod 1・multiplier 0.5:
    //   long: ema=0.5*8+0.5*4=6, TR=4 → upper=6+2=8 === close
    //   short: ema=0.5*2+0.5*4=3, TR=2 → lower=3-1=2 === close
    // TS が排他不等号(>/<)に退行すると MQL 側(>=/<=)とのパリティが崩れるため、
    // ATR>0 での等号成立を true として固定する。
    const condition = {
      type: 'keltnerBreak' as const,
      emaPeriod: 3,
      atrPeriod: 1,
      multiplier: 0.5,
    };
    const longBars = [bar(0, 4, 4, 4), bar(1, 4, 4, 4), bar(2, 4, 4, 4), bar(3, 8, 4, 8)];
    const shortBars = [bar(0, 4, 4, 4), bar(1, 4, 4, 4), bar(2, 4, 4, 4), bar(3, 4, 2, 2)];

    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition), 3)).toBe(true);
    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition, 'short'), 3)).toBe(
      false,
    );
    expect(
      createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition, 'short'), 3),
    ).toBe(true);
    expect(createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition), 3)).toBe(false);
  });

  it('requires a positive Keltner ATR and fails closed for non-finite bands', () => {
    const boundaryCondition = {
      type: 'keltnerBreak' as const,
      emaPeriod: 2,
      atrPeriod: 2,
      multiplier: 2,
    };
    const flatBars = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 10, 10, 10)];
    const flatEvaluator = createStrategyEvaluator(flatBars);
    expect(flatEvaluator.isEntrySignal(strategyFor(boundaryCondition), 2)).toBe(false);
    expect(flatEvaluator.isEntrySignal(strategyFor(boundaryCondition, 'short'), 2)).toBe(false);

    const nonFiniteBars = [
      bar(0, 10.5, 9.5, 10),
      bar(1, 10.5, 9.5, 10),
      bar(2, 10, 10, Number.NaN),
    ];
    const nonFiniteEvaluator = createStrategyEvaluator(nonFiniteBars);
    expect(nonFiniteEvaluator.isEntrySignal(strategyFor(boundaryCondition), 2)).toBe(false);
    expect(nonFiniteEvaluator.isEntrySignal(strategyFor(boundaryCondition, 'short'), 2)).toBe(false);
  });

  it('evaluates CCI breaks with inclusive level boundaries and fails closed on flat or invalid data', () => {
    // period=3, TP=[1,1,8] gives CCI=100 exactly; TP=[5,6,1] gives -100 exactly.
    // The equality cases pin the state condition to >= / <=; a mutation to strict
    // inequalities makes both deterministic boundary entries fail.
    const condition = { type: 'cciBreak' as const, period: 3, level: 100 };
    const longBars = [bar(0, 1, 1, 1), bar(1, 1, 1, 1), bar(2, 8, 8, 8)];
    const shortBars = [bar(0, 5, 5, 5), bar(1, 6, 6, 6), bar(2, 1, 1, 1)];

    expect(indicators.cci([1, 1, 8], [1, 1, 8], [1, 1, 8], 3)[2]).toBe(100);
    expect(indicators.cci([5, 6, 1], [5, 6, 1], [5, 6, 1], 3)[2]).toBe(-100);

    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition), 2)).toBe(true);
    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition, 'short'), 2)).toBe(
      false,
    );
    expect(createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition, 'short'), 2)).toBe(
      true,
    );
    expect(createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition), 2)).toBe(false);

    const flatBars = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 10, 10, 10)];
    const flatEvaluator = createStrategyEvaluator(flatBars);
    expect(flatEvaluator.isEntrySignal(strategyFor(condition), 2)).toBe(false);
    expect(flatEvaluator.isEntrySignal(strategyFor(condition, 'short'), 2)).toBe(false);

    const zeroLevelCondition = { ...condition, level: 0 };
    expect(flatEvaluator.isEntrySignal(strategyFor(zeroLevelCondition), 2)).toBe(false);
    expect(flatEvaluator.isEntrySignal(strategyFor(zeroLevelCondition, 'short'), 2)).toBe(false);
    const negativeLevelCondition = { ...condition, level: -100 };
    expect(flatEvaluator.isEntrySignal(strategyFor(negativeLevelCondition), 2)).toBe(false);
    expect(flatEvaluator.isEntrySignal(strategyFor(negativeLevelCondition, 'short'), 2)).toBe(false);

    const invalidEvaluator = createStrategyEvaluator([
      bar(0, 10, 10, 10),
      bar(1, 10, 10, 10),
      bar(2, 10, 10, Number.NaN),
    ]);
    expect(invalidEvaluator.isEntrySignal(strategyFor(condition), 2)).toBe(false);
    expect(
      createStrategyEvaluator(longBars).isEntrySignal(
        strategyFor({ ...condition, level: Number.NaN }),
        2,
      ),
    ).toBe(false);
  });

  it('memoizes CCI values by normalized period', () => {
    const cciSpy = vi.spyOn(indicators, 'cci');
    const firstCondition = { type: 'cciBreak' as const, period: 3, level: 100 };
    const secondCondition = { ...firstCondition, level: 50 };
    const strategy = {
      ...strategyFor(firstCondition),
      entryConditions: [firstCondition, secondCondition],
    };
    const bars = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 13, 13, 13)];

    try {
      expect(createStrategyEvaluator(bars).isEntrySignal(strategy, 2)).toBe(true);
      expect(cciSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('evaluates ADX DI crosses in both directions with an inclusive ADX threshold', () => {
    const condition = {
      type: 'adxTrend' as const,
      period: 2,
      threshold: 51.47198480531814,
    };
    const longBars = [
      bar(0, 10, 10, 10),
      bar(1, 9, 9, 9),
      bar(2, 10, 10, 10),
      bar(3, 9, 9, 9),
      bar(4, 10, 10, 10),
    ];
    const shortBars = [
      bar(0, 10, 10, 10),
      bar(1, 11, 11, 11),
      bar(2, 10, 10, 10),
      bar(3, 11, 11, 11),
      bar(4, 10, 10, 10),
    ];

    const longValues = indicators.adx(
      longBars.map((item) => item.h),
      longBars.map((item) => item.l),
      longBars.map((item) => item.c),
      2,
    );
    const shortValues = indicators.adx(
      shortBars.map((item) => item.h),
      shortBars.map((item) => item.l),
      shortBars.map((item) => item.c),
      2,
    );
    // This threshold is the measured double at the signal bar, not a rounded value.
    expect(longValues.adx[4]).toBe(51.47198480531814);
    expect(shortValues.adx[4]).toBe(51.47198480531814);

    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition), 4)).toBe(true);
    expect(
      createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition, 'short'), 4),
    ).toBe(false);
    expect(
      createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition, 'short'), 4),
    ).toBe(true);
    expect(createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition), 4)).toBe(false);

    const noCrossBars = [
      bar(0, 10, 10, 10),
      bar(1, 11, 11, 11),
      bar(2, 12, 12, 12),
      bar(3, 13, 13, 13),
      bar(4, 14, 14, 14),
    ];
    expect(createStrategyEvaluator(noCrossBars).isEntrySignal(strategyFor(condition), 4)).toBe(
      false,
    );
  });

  it('treats the first upward bar after flat DI as a long cross', () => {
    const condition = { type: 'adxTrend' as const, period: 2, threshold: 1 };
    const longBars = barsFrom(
      [10, 10, 10, 10, 10, 10, 11],
      [10, 10, 10, 10, 10, 10, 10],
      [10, 10, 10, 10, 10, 10, 11],
    );
    const longValues = indicators.adx(
      longBars.map((item) => item.h),
      longBars.map((item) => item.l),
      longBars.map((item) => item.c),
      condition.period,
    );
    expect(longValues.plusDi[5]).toBe(0);
    expect(longValues.minusDi[5]).toBe(0);
    expect(longValues.adx[6]).toBeGreaterThanOrEqual(condition.threshold);
    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition), 6)).toBe(true);
  });

  it('treats the first downward bar after flat DI as a short cross', () => {
    const condition = { type: 'adxTrend' as const, period: 2, threshold: 1 };
    const shortBars = barsFrom(
      [10, 10, 10, 10, 10, 10, 10],
      [10, 10, 10, 10, 10, 10, 9],
      [10, 10, 10, 10, 10, 10, 9],
    );
    const shortValues = indicators.adx(
      shortBars.map((item) => item.h),
      shortBars.map((item) => item.l),
      shortBars.map((item) => item.c),
      condition.period,
    );
    expect(shortValues.plusDi[5]).toBe(0);
    expect(shortValues.minusDi[5]).toBe(0);
    expect(shortValues.adx[6]).toBeGreaterThanOrEqual(condition.threshold);
    expect(
      createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition, 'short'), 6),
    ).toBe(true);
  });

  it('keeps an ADX trend signal unchanged when future bars are appended', () => {
    const condition = { type: 'adxTrend' as const, period: 2, threshold: 1 };
    const bars = [
      bar(0, 10, 10, 10),
      bar(1, 10, 10, 10),
      bar(2, 10, 10, 10),
      bar(3, 10, 10, 10),
      bar(4, 10, 10, 10),
      bar(5, 10, 10, 10),
      bar(6, 11, 10, 11),
    ];
    const withFuture = [...bars, bar(7, 1_000, -1_000, 500)];

    expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 6)).toBe(true);
    expect(createStrategyEvaluator(withFuture).isEntrySignal(strategyFor(condition), 6)).toBe(true);
  });

  it('rejects ADX entries below the threshold, at invalid thresholds, and during warm-up', () => {
    const bars = [
      bar(0, 10, 10, 10),
      bar(1, 9, 9, 9),
      bar(2, 10, 10, 10),
      bar(3, 9, 9, 9),
      bar(4, 10, 10, 10),
    ];
    const evaluator = createStrategyEvaluator(bars);
    expect(
      evaluator.isEntrySignal(
        strategyFor({ type: 'adxTrend', period: 2, threshold: 51.47198480531815 }),
        4,
      ),
    ).toBe(false);

    for (const threshold of [0, -1, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        evaluator.isEntrySignal(strategyFor({ type: 'adxTrend', period: 2, threshold }), 4),
      ).toBe(false);
    }
    expect(
      evaluator.isEntrySignal(strategyFor({ type: 'adxTrend', period: 1, threshold: 1 }), 4),
    ).toBe(false);

    const warmupBars = Array.from({ length: 6 }, (_, index) =>
      bar(index, 10 + index, 10, 10 + index),
    );
    const warmupValues = indicators.adx(
      warmupBars.map((item) => item.h),
      warmupBars.map((item) => item.l),
      warmupBars.map((item) => item.c),
      3,
    );
    expect(warmupValues.plusDi.slice(0, 3)).toEqual([null, null, null]);
    expect(warmupValues.minusDi.slice(0, 3)).toEqual([null, null, null]);
    expect(warmupValues.adx.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(
      createStrategyEvaluator(warmupBars).isEntrySignal(
        strategyFor({ type: 'adxTrend', period: 3, threshold: 25 }),
        5,
      ),
    ).toBe(false);
  });

  it('memoizes ADX values by normalized period', () => {
    const adxSpy = vi.spyOn(indicators, 'adx');
    const firstCondition = { type: 'adxTrend' as const, period: 2, threshold: 50 };
    const secondCondition = { ...firstCondition, period: 2.4, threshold: 25 };
    const strategy = {
      ...strategyFor(firstCondition),
      entryConditions: [firstCondition, secondCondition],
    };
    const bars = [
      bar(0, 10, 10, 10),
      bar(1, 9, 9, 9),
      bar(2, 10, 10, 10),
      bar(3, 9, 9, 9),
      bar(4, 10, 10, 10),
    ];

    try {
      expect(createStrategyEvaluator(bars).isEntrySignal(strategy, 4)).toBe(true);
      expect(adxSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
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
    expect(conditionLabel({ type: 'cciBreak', period: 14, level: 100 })).toBe(
      'CCI14 ±100 ブレイク',
    );
    expect(conditionLabel({ type: 'adxTrend', period: 14, threshold: 25 })).toBe(
      'ADX14/25 DIクロス',
    );
  });
});

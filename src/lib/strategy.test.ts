import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../types';
import * as indicators from './indicators';
import {
  computeAlligatorSeries,
  computeStochCrossSeries,
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

const rviBar = (
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Bar => ({
  t: index * 60,
  o: open,
  h: high,
  l: low,
  c: close,
  v: 1,
});

const rviBarsFromDeltas = (deltas: readonly number[]): Bar[] =>
  deltas.map((delta, index) => rviBar(index, 10, 15, 5, 10 + delta));

const barsFrom = (
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
): Bar[] => highs.map((high, index) => bar(index, high, lows[index], closes[index]));

const makeSarStrategyBars = (): Bar[] => {
  const highs = [
    10,
    11,
    12,
    13,
    ...Array.from({ length: 98 }, () => 13),
    30,
    32,
    34,
    35,
    36,
    36,
    36,
    36,
    40,
  ];
  const lows = [
    8,
    9,
    10,
    8,
    ...Array.from({ length: 98 }, () => 10),
    15,
    16,
    17,
    18,
    0,
    5,
    5,
    5,
    6,
  ];
  return barsFrom(highs, lows, highs);
};

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

const alligatorBarsFromMedians = (medians: readonly number[]): Bar[] =>
  barsFrom(medians, medians, medians);

const alligatorBoundaryCondition = {
  type: 'alligator' as const,
  jawPeriod: 4,
  teethPeriod: 3,
  lipsPeriod: 2,
  jawShift: 2,
  teethShift: 1,
  lipsShift: 0,
};

describe('strategy evaluator', () => {
  it('evaluates DeMarker threshold re-crosses with exact boundaries and short mirroring', () => {
    const condition = {
      type: 'demarker' as const,
      period: 1,
      threshold: 0.25,
      comparison: 'crossAbove' as const,
    };
    const longBars = [
      bar(0, 10, 10, 10),
      bar(1, 10, 9, 10),
      bar(2, 11, 6, 11),
    ];
    const longValues = indicators.demarker(
      longBars.map((item) => item.h),
      longBars.map((item) => item.l),
      condition.period,
    );
    expect(longValues[1]).toBe(0);
    expect(longValues[2]).toBe(0.25);
    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition), 1)).toBe(false);
    // current === threshold is included by compareRsi's crossAbove boundary.
    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition), 2)).toBe(true);
    expect(
      createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition, 'short'), 2),
    ).toBe(false);

    // Short uses mirrored crossBelow with 1-threshold=.75.  The current bar
    // is exactly .75, so this catches both the comparison and threshold mirror.
    const shortBars = [
      bar(0, 10, 10, 10),
      bar(1, 11, 10, 11),
      bar(2, 14, 9, 14),
    ];
    const shortValues = indicators.demarker(
      shortBars.map((item) => item.h),
      shortBars.map((item) => item.l),
      condition.period,
    );
    expect(shortValues[1]).toBe(1);
    expect(shortValues[2]).toBe(0.75);
    expect(
      createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition, 'short'), 2),
    ).toBe(true);
    expect(createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition), 2)).toBe(false);
  });

  it('keeps DeMarker signals look-ahead-safe in the reversal direction', () => {
    const condition = {
      type: 'demarker' as const,
      period: 1,
      threshold: 0.25,
      comparison: 'crossAbove' as const,
    };
    const bars = [
      bar(0, 10, 10, 10),
      bar(1, 10, 9, 10),
      bar(2, 11, 6, 11),
    ];
    const withFuture = [...bars, bar(3, 11, 5, 11)];

    expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 2)).toBe(true);
    // The future bar is a downward DeMarker shock (0 instead of .25).  If
    // the evaluator reads it while judging index 2, the true cross reverses
    // to false; appending it must leave the signal unchanged.
    expect(createStrategyEvaluator(withFuture).isEntrySignal(strategyFor(condition), 2)).toBe(true);
  });

  it('fails closed for DeMarker flat/invalid windows and invalid periods', () => {
    const condition = {
      type: 'demarker' as const,
      period: 1,
      threshold: 0.5,
      comparison: 'below' as const,
    };
    const flatBars = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 10, 10, 10)];
    const flatValues = indicators.demarker(
      flatBars.map((item) => item.h),
      flatBars.map((item) => item.l),
      condition.period,
    );
    expect(flatValues[2]).toBeNull();
    // If the zero denominator were relaxed to a numeric zero, `below .5`
    // would be true here.  Null must fail closed in the evaluator as well.
    expect(createStrategyEvaluator(flatBars).isEntrySignal(strategyFor(condition), 2)).toBe(false);

    const nonFiniteBars = [
      bar(0, 10, 10, 10),
      bar(1, 10, 8, 10),
      bar(2, 13, Number.NaN, 13),
    ];
    // The NaN sits only on the low side while the high side still rises: if
    // the per-bar finite guard were relaxed, NaN < previousLow is false, so
    // DeMin[2] = 0 and DeMarker[2] = 3 / (3 + 0) = 1.0, flipping this
    // `above 0.5` check to true. The guard must keep the window null.
    expect(
      createStrategyEvaluator(nonFiniteBars).isEntrySignal(
        strategyFor({ ...condition, comparison: 'above' as const }),
        2,
      ),
    ).toBe(false);

    const validSignalBars = [bar(0, 10, 10, 10), bar(1, 10, 9, 10), bar(2, 11, 6, 11)];
    const validEvaluator = createStrategyEvaluator(validSignalBars);
    expect(validEvaluator.isEntrySignal(strategyFor(condition), 2)).toBe(true);
    for (const period of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        validEvaluator.isEntrySignal(strategyFor({ ...condition, period }), 2),
      ).toBe(false);
    }
    // A negative threshold with `below` is not mutation-sensitive because a
    // finite DeMarker value is always >= 0. Use `above -0.1` in both
    // directions instead: without the range guard, long sees .25 >= -.1 and
    // short's mirrored comparison sees .25 <= 1.1, so both would turn true.
    const negativeThreshold = -0.1;
    expect(
      validEvaluator.isEntrySignal(
        strategyFor({ ...condition, comparison: 'above' as const, threshold: negativeThreshold }),
        2,
      ),
    ).toBe(false);
    expect(
      validEvaluator.isEntrySignal(
        strategyFor(
          { ...condition, comparison: 'above' as const, threshold: negativeThreshold },
          'short',
        ),
        2,
      ),
    ).toBe(false);

    // NaN is not observable through isEntrySignal alone: both relational
    // comparisons are false. Keep the case as a documented fail-closed check;
    // the explicit !Number.isFinite(condition.threshold) guard is the
    // white-box source of truth for this threshold range validation.
    for (const threshold of [1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        validEvaluator.isEntrySignal(strategyFor({ ...condition, threshold }), 2),
      ).toBe(false);
      expect(
        validEvaluator.isEntrySignal(
          strategyFor({ ...condition, comparison: 'above' as const, threshold }),
          2,
        ),
      ).toBe(false);
    }
  });

  it('memoizes DeMarker values by period', () => {
    const demarkerSpy = vi.spyOn(indicators, 'demarker');
    const firstCondition = {
      type: 'demarker' as const,
      period: 1,
      threshold: 0.25,
      comparison: 'crossAbove' as const,
    };
    const secondCondition = {
      ...firstCondition,
      threshold: 0,
      comparison: 'above' as const,
    };
    const thirdCondition = {
      ...firstCondition,
      period: 2,
      threshold: 0.1,
      comparison: 'above' as const,
    };
    const bars = [
      bar(0, 10, 10, 10),
      bar(1, 10, 9, 10),
      bar(2, 11, 6, 11),
    ];
    const strategy = {
      ...strategyFor(firstCondition),
      entryConditions: [firstCondition, secondCondition, thirdCondition],
    };

    try {
      expect(createStrategyEvaluator(bars).isEntrySignal(strategy, 2)).toBe(true);
      expect(demarkerSpy).toHaveBeenCalledTimes(2);
      expect(demarkerSpy).toHaveBeenCalledWith([10, 10, 11], [10, 9, 6], 1);
      expect(demarkerSpy).toHaveBeenCalledWith([10, 10, 11], [10, 9, 6], 2);
    } finally {
      vi.restoreAllMocks();
    }
  });

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

  it('evaluates Envelope band breaks with all four inclusive/exclusive cross edges', () => {
    const condition = { type: 'envelope' as const, period: 2, deviation: 50 };

    // Upper factor is 1.5. At index 2, SMA(120,360) * 1.5 is exactly 360;
    // at index 3, SMA(360,1081) * 1.5 is exactly 1080.75.
    const longPreviousEquality = barsFrom(
      [40, 120, 360, 1081],
      [40, 120, 360, 1081],
      [40, 120, 360, 1081],
    );
    expect(createStrategyEvaluator(longPreviousEquality).isEntrySignal(strategyFor(condition), 3)).toBe(
      true,
    );

    // The current close is exactly the upper band, so current `>` is required.
    const longCurrentEquality = barsFrom(
      [40, 120, 360, 1080],
      [40, 120, 360, 1080],
      [40, 120, 360, 1080],
    );
    expect(createStrategyEvaluator(longCurrentEquality).isEntrySignal(strategyFor(condition), 3)).toBe(
      false,
    );

    // Lower factor is 0.5. At index 2, SMA(12,4) * 0.5 is exactly 4;
    // at index 3, SMA(4,1) * 0.5 is 1.25.
    const shortPreviousEquality = barsFrom(
      [36, 12, 4, 1],
      [36, 12, 4, 1],
      [36, 12, 4, 1],
    );
    expect(
      createStrategyEvaluator(shortPreviousEquality).isEntrySignal(
        strategyFor(condition, 'short'),
        3,
      ),
    ).toBe(true);

    // The current close is exactly the lower band, so current `<` is required.
    const shortCurrentEquality = barsFrom(
      [108, 36, 12, 4],
      [108, 36, 12, 4],
      [108, 36, 12, 4],
    );
    expect(
      createStrategyEvaluator(shortCurrentEquality).isEntrySignal(
        strategyFor(condition, 'short'),
        3,
      ),
    ).toBe(false);
  });

  it('keeps Envelope crosses look-ahead-safe in the reversal direction', () => {
    const condition = { type: 'envelope' as const, period: 2, deviation: 50 };
    const bars = barsFrom(
      [40, 120, 360, 1081],
      [40, 120, 360, 1081],
      [40, 120, 360, 1081],
    );
    const withFuture = [...bars, bar(4, 1_000_000, 1_000_000, 1_000_000)];

    // The signal at index 3 must remain true. A future close included in the
    // current SMA would raise the upper band and reverse this fixture to false.
    expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 3)).toBe(true);
    expect(createStrategyEvaluator(withFuture).isEntrySignal(strategyFor(condition), 3)).toBe(true);
  });

  it('fails closed for Envelope warm-up, invalid domains, and non-finite close guards', () => {
    const condition = { type: 'envelope' as const, period: 2, deviation: 50 };
    const warmupBars = barsFrom([40, 120], [40, 120], [40, 120]);
    expect(createStrategyEvaluator(warmupBars).isEntrySignal(strategyFor(condition), 1)).toBe(false);
    expect(
      createStrategyEvaluator(
        barsFrom([40, 120, 360], [40, 120, 360], [40, 120, Number.NaN]),
      ).isEntrySignal(strategyFor(condition), 2),
    ).toBe(false);

    const validBars = barsFrom(
      [40, 120, 360, 1081],
      [40, 120, 360, 1081],
      [40, 120, 360, 1081],
    );
    const boundaryValues = indicators.envelope(validBars, condition.period, condition.deviation);
    expect(boundaryValues.middle[1]).toBeNull();
    // At index=period the current band exists but the previous band is still
    // warm-up null; index=period+1 is the first index that can form a cross.
    const boundaryEvaluator = createStrategyEvaluator(validBars);
    expect(boundaryEvaluator.isEntrySignal(strategyFor(condition), condition.period)).toBe(false);
    expect(boundaryEvaluator.isEntrySignal(strategyFor(condition), condition.period + 1)).toBe(true);

    const finiteBands = {
      middle: [null, null, 400, 400],
      upper: [null, null, 400, 400],
      lower: [null, null, -400, -400],
    };
    const envelopeSpy = vi.spyOn(indicators, 'envelope').mockReturnValue(finiteBands);
    try {
      const nonFiniteLongCloseBars = [
        ...validBars.slice(0, 3),
        bar(3, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
      ];
      // Without the current-close guard, previousClose=360 <= previousUpper=400
      // and currentClose=+Infinity > currentUpper=400 would satisfy this break.
      expect(
        createStrategyEvaluator(nonFiniteLongCloseBars).isEntrySignal(strategyFor(condition), 3),
      ).toBe(false);

      const nonFiniteShortCloseBars = [
        ...validBars.slice(0, 3),
        bar(3, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY),
      ];
      // The short mirror also reaches the comparison: previousClose=360 >=
      // previousLower=-400 and currentClose=-Infinity < currentLower=-400.
      expect(
        createStrategyEvaluator(nonFiniteShortCloseBars).isEntrySignal(
          strategyFor(condition, 'short'),
          3,
        ),
      ).toBe(false);
    } finally {
      envelopeSpy.mockRestore();
    }

    const evaluator = createStrategyEvaluator(validBars);
    for (const invalidCondition of [
      { type: 'envelope' as const, period: 1, deviation: 50 },
      { type: 'envelope' as const, period: 1001, deviation: 50 },
      { type: 'envelope' as const, period: 2.5, deviation: 50 },
      { type: 'envelope' as const, period: 2, deviation: 0 },
      { type: 'envelope' as const, period: 2, deviation: Number.NaN },
    ]) {
      expect(evaluator.isEntrySignal(strategyFor(invalidCondition), 3)).toBe(false);
    }
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

  it('evaluates Momentum 100 crosses with exact equality boundaries and mirrored directions', () => {
    const condition = { type: 'momentum' as const, period: 1 };
    const longCross = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 11, 11, 11)];
    const shortCross = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 9, 9, 9)];
    const flatAt100 = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 10, 10, 10)];

    // prev === 100 is included, while current === 100 is not: these fixtures
    // pin <=/> for long and >=/< for short independently.
    expect(createStrategyEvaluator(longCross).isEntrySignal(strategyFor(condition), 2)).toBe(true);
    expect(
      createStrategyEvaluator(longCross).isEntrySignal(strategyFor(condition, 'short'), 2),
    ).toBe(false);
    expect(
      createStrategyEvaluator(shortCross).isEntrySignal(strategyFor(condition, 'short'), 2),
    ).toBe(true);
    expect(createStrategyEvaluator(shortCross).isEntrySignal(strategyFor(condition), 2)).toBe(false);
    expect(createStrategyEvaluator(flatAt100).isEntrySignal(strategyFor(condition), 2)).toBe(false);
    expect(
      createStrategyEvaluator(flatAt100).isEntrySignal(strategyFor(condition, 'short'), 2),
    ).toBe(false);
  });

  it('fails closed for Momentum warm-up, invalid periods, and non-finite prices', () => {
    // period ガードが緩んで period 1 にフォールバックすると momentum 100→110 で
    // ロング true になる形の fixture(false 断言が偶然通らないようにする)。
    const bars = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 11, 11, 11)];
    const evaluator = createStrategyEvaluator(bars);
    expect(evaluator.isEntrySignal(strategyFor({ type: 'momentum', period: 1 }), 0)).toBe(false);

    for (const period of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluator.isEntrySignal(strategyFor({ type: 'momentum', period }), 2)).toBe(false);
    }

    const invalidValues = [
      bar(0, 10, 10, 10),
      bar(1, 10, 10, 0),
      bar(2, 12, 12, 12),
      bar(3, 13, 13, Number.NaN),
    ];
    const invalidEvaluator = createStrategyEvaluator(invalidValues);
    expect(invalidEvaluator.isEntrySignal(strategyFor({ type: 'momentum', period: 2 }), 2)).toBe(
      false,
    );
    expect(invalidEvaluator.isEntrySignal(strategyFor({ type: 'momentum', period: 1 }), 3)).toBe(
      false,
    );
  });

  it('keeps Momentum signals unchanged when future bars are appended and memoizes by period', () => {
    const momentumSpy = vi.spyOn(indicators, 'momentum');
    const condition = { type: 'momentum' as const, period: 1 };
    const secondCondition = { ...condition };
    const bars = [bar(0, 10, 10, 10), bar(1, 10, 10, 10), bar(2, 11, 11, 11)];
    const strategy = {
      ...strategyFor(condition),
      entryConditions: [condition, secondCondition],
    };

    try {
      expect(createStrategyEvaluator(bars).isEntrySignal(strategy, 2)).toBe(true);
      expect(momentumSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }

    // 追加バーは「覗いたら判定が反転する向き」(momentum 9/11*100=81.8<100) にする。
    // 上昇方向の未来バーだと look-ahead 実装でも true のままでテストが素通りする。
    const withFuture = [...bars, bar(3, 9, 9, 9)];
    expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 2)).toBe(true);
    expect(createStrategyEvaluator(withFuture).isEntrySignal(strategyFor(condition), 2)).toBe(true);
  });

  it('evaluates AO zero-line crosses with exact zero boundaries and short mirroring', () => {
    const condition = { type: 'ao' as const, fastPeriod: 2, slowPeriod: 3 };
    const bars = barsFrom([2, 1, 3, 4, 0], [2, 1, 3, 4, 0], [2, 1, 3, 4, 0]);
    const evaluator = createStrategyEvaluator(bars);

    // AO[2]===0 is allowed on the previous bar; AO[3]>0 is the long cross.
    expect(evaluator.isEntrySignal(strategyFor(condition), 3)).toBe(true);
    expect(evaluator.isEntrySignal(strategyFor(condition, 'short'), 3)).toBe(false);
    // AO[3]>0 followed by AO[4]<0 is the mirrored short cross.
    expect(evaluator.isEntrySignal(strategyFor(condition, 'short'), 4)).toBe(true);
    expect(evaluator.isEntrySignal(strategyFor(condition), 4)).toBe(false);

    // Pin the remaining three equality edges (momentum flatAt100 precedent):
    // each fixture lands AO exactly on 0 on the side whose strictness is
    // being pinned, so relaxing that comparison flips the expectation.
    // m=[3,1,3,-1] -> AO[2]=-1/3, AO[3]===0: current must be strictly >0
    // for the long cross, so a `current >= 0` relaxation would fire here.
    const flatAtZeroLong = createStrategyEvaluator(
      barsFrom([3, 1, 3, -1], [3, 1, 3, -1], [3, 1, 3, -1]),
    );
    expect(flatAtZeroLong.isEntrySignal(strategyFor(condition), 3)).toBe(false);
    // m=[1,3,1,5] -> AO[2]=+1/3, AO[3]===0: current must be strictly <0
    // for the short cross, so a `current <= 0` relaxation would fire here.
    const flatAtZeroShort = createStrategyEvaluator(
      barsFrom([1, 3, 1, 5], [1, 3, 1, 5], [1, 3, 1, 5]),
    );
    expect(flatAtZeroShort.isEntrySignal(strategyFor(condition, 'short'), 3)).toBe(false);
    // m=[2,2,2,0] -> AO[2]===0, AO[3]=-1/3: previous===0 must count for the
    // short cross (>=), so a `previous > 0` tightening would drop this entry.
    const shortFromZero = createStrategyEvaluator(
      barsFrom([2, 2, 2, 0], [2, 2, 2, 0], [2, 2, 2, 0]),
    );
    expect(shortFromZero.isEntrySignal(strategyFor(condition, 'short'), 3)).toBe(true);
  });

  it('keeps AO signals look-ahead-safe in the reversal direction', () => {
    const condition = { type: 'ao' as const, fastPeriod: 2, slowPeriod: 3 };
    const bars = barsFrom([2, 1, 3, 4], [2, 1, 3, 4], [2, 1, 3, 4]);
    const withFuture = [
      ...bars,
      // This future median makes AO[4] negative.  If index 3 reads the
      // future bar, the true AO[2]===0 -> AO[3]>0 signal would reverse false.
      bar(4, 0, 0, 0),
    ];

    expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 3)).toBe(true);
    expect(createStrategyEvaluator(withFuture).isEntrySignal(strategyFor(condition), 3)).toBe(true);
  });

  it('fails closed for AO warm-up, invalid periods, and non-finite windows', () => {
    const condition = { type: 'ao' as const, fastPeriod: 2, slowPeriod: 3 };
    const warmupBars = barsFrom([2, 1, 3, 4], [2, 1, 3, 4], [2, 1, 3, 4]);
    const warmupEvaluator = createStrategyEvaluator(warmupBars);
    expect(warmupEvaluator.isEntrySignal(strategyFor(condition), 1)).toBe(false);
    expect(warmupEvaluator.isEntrySignal(strategyFor(condition), 2)).toBe(false);

    // With m=[3,1,3,NaN], AO[2] is -1/3.  If the invalid current bar were
    // relaxed to zero/ignored in the fixed-period sums, AO[3] would be +1/6
    // and this fixture would incorrectly turn the long cross true.  Keeping
    // the NaN at the current bar makes the mutation sensitive instead of
    // letting a NaN comparison pass accidentally as false.
    const invalidBars = barsFrom(
      [3, 1, 3, Number.NaN],
      [3, 1, 3, 4],
      [3, 1, 3, 4],
    );
    expect(
      createStrategyEvaluator(invalidBars).isEntrySignal(strategyFor(condition), 3),
    ).toBe(false);

    const validBars = barsFrom([3, 1, 3, 4], [3, 1, 3, 4], [3, 1, 3, 4]);
    const evaluator = createStrategyEvaluator(validBars);
    for (const invalidCondition of [
      { type: 'ao' as const, fastPeriod: 0, slowPeriod: 3 },
      { type: 'ao' as const, fastPeriod: -1, slowPeriod: 3 },
      { type: 'ao' as const, fastPeriod: 1.5, slowPeriod: 3 },
      { type: 'ao' as const, fastPeriod: Number.NaN, slowPeriod: 3 },
      { type: 'ao' as const, fastPeriod: 2, slowPeriod: 2 },
      { type: 'ao' as const, fastPeriod: 3, slowPeriod: 2 },
      { type: 'ao' as const, fastPeriod: 2, slowPeriod: 3.5 },
      { type: 'ao' as const, fastPeriod: 2, slowPeriod: Number.POSITIVE_INFINITY },
    ]) {
      expect(evaluator.isEntrySignal(strategyFor(invalidCondition), 3)).toBe(false);
    }
  });

  it('memoizes AO values by the fastPeriod:slowPeriod pair', () => {
    const aoSpy = vi.spyOn(indicators, 'ao');
    const firstCondition = { type: 'ao' as const, fastPeriod: 2, slowPeriod: 3 };
    const samePair = { ...firstCondition };
    const differentPair = { type: 'ao' as const, fastPeriod: 1, slowPeriod: 3 };
    const bars = barsFrom([5, 1, 2, 4], [5, 1, 2, 4], [5, 1, 2, 4]);
    const strategy = {
      ...strategyFor(firstCondition),
      entryConditions: [firstCondition, samePair, differentPair],
    };

    try {
      expect(createStrategyEvaluator(bars).isEntrySignal(strategy, 3)).toBe(true);
      expect(aoSpy).toHaveBeenCalledTimes(2);
      expect(aoSpy).toHaveBeenCalledWith([5, 1, 2, 4], [5, 1, 2, 4], 2, 3);
      expect(aoSpy).toHaveBeenCalledWith([5, 1, 2, 4], [5, 1, 2, 4], 1, 3);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('evaluates RVI signal-line crosses with exact equality boundaries and mirror directions', () => {
    const condition = { type: 'rvi' as const, period: 1 };
    const longBars = rviBarsFromDeltas([...Array(8).fill(0), 2]);
    const shortBars = rviBarsFromDeltas([...Array(8).fill(0), -2]);
    const flatBars = rviBarsFromDeltas(Array(9).fill(0));

    const longValues = indicators.rvi(
      longBars.map((item) => item.o),
      longBars.map((item) => item.h),
      longBars.map((item) => item.l),
      longBars.map((item) => item.c),
      condition.period,
    );
    expect(longValues.rvi[7]).toBe(0);
    expect(longValues.signal[7]).toBe(0);
    expect(longValues.rvi[8]).toBeGreaterThan(longValues.signal[8] as number);
    expect(createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition), 8)).toBe(true);
    expect(
      createStrategyEvaluator(longBars).isEntrySignal(strategyFor(condition, 'short'), 8),
    ).toBe(false);

    const shortValues = indicators.rvi(
      shortBars.map((item) => item.o),
      shortBars.map((item) => item.h),
      shortBars.map((item) => item.l),
      shortBars.map((item) => item.c),
      condition.period,
    );
    expect(shortValues.rvi[7]).toBe(0);
    expect(shortValues.signal[7]).toBe(0);
    expect(shortValues.rvi[8]).toBeLessThan(shortValues.signal[8] as number);
    expect(
      createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition, 'short'), 8),
    ).toBe(true);
    expect(createStrategyEvaluator(shortBars).isEntrySignal(strategyFor(condition), 8)).toBe(false);

    const flatValues = indicators.rvi(
      flatBars.map((item) => item.o),
      flatBars.map((item) => item.h),
      flatBars.map((item) => item.l),
      flatBars.map((item) => item.c),
      condition.period,
    );
    // Both lines are exactly equal at the signal bar: strict current-bar
    // comparison must keep this from firing in either direction.
    expect(flatValues.rvi[8]).toBe(flatValues.signal[8]);
    expect(createStrategyEvaluator(flatBars).isEntrySignal(strategyFor(condition), 8)).toBe(false);
    expect(
      createStrategyEvaluator(flatBars).isEntrySignal(strategyFor(condition, 'short'), 8),
    ).toBe(false);
  });

  it('fails closed for RVI warm-up, invalid periods, non-finite inputs, and zero ranges', () => {
    const condition = { type: 'rvi' as const, period: 1 };
    const warmupBars = rviBarsFromDeltas(Array(8).fill(0));
    const warmupValues = indicators.rvi(
      warmupBars.map((item) => item.o),
      warmupBars.map((item) => item.h),
      warmupBars.map((item) => item.l),
      warmupBars.map((item) => item.c),
      condition.period,
    );
    expect(warmupValues.rvi[condition.period + 2]).toBeNull();
    expect(warmupValues.rvi[condition.period + 3]).toBe(0);
    expect(warmupValues.signal[condition.period + 5]).toBeNull();
    expect(warmupValues.signal[condition.period + 6]).toBe(0);
    expect(createStrategyEvaluator(warmupBars).isEntrySignal(strategyFor(condition), 7)).toBe(false);

    // All invalid values would cross at index 9 if the guard fell back to a
    // rounded/normalized period, so every false assertion exercises the guard.
    const periodGuardBars = rviBarsFromDeltas([...Array(9).fill(0), 2]);
    const periodGuardEvaluator = createStrategyEvaluator(periodGuardBars);
    expect(
      periodGuardEvaluator.isEntrySignal(strategyFor({ type: 'rvi', period: 1 }), 9),
    ).toBe(true);
    for (const period of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        periodGuardEvaluator.isEntrySignal(strategyFor({ type: 'rvi', period }), 9),
      ).toBe(false);
    }

    const nonFiniteBars = rviBarsFromDeltas([...Array(8).fill(0), 2]);
    nonFiniteBars[8] = rviBar(8, Number.NaN, 15, 5, 12);
    expect(createStrategyEvaluator(nonFiniteBars).isEntrySignal(strategyFor(condition), 8)).toBe(
      false,
    );

    const zeroRangeBars = rviBarsFromDeltas([...Array(8).fill(0), 2]).map((item) => ({
      ...item,
      h: 10,
      l: 10,
    }));
    expect(createStrategyEvaluator(zeroRangeBars).isEntrySignal(strategyFor(condition), 8)).toBe(
      false,
    );
  });

  it('memoizes RVI by period and ignores a future shock at the evaluated bar', () => {
    const rviSpy = vi.spyOn(indicators, 'rvi');
    const condition = { type: 'rvi' as const, period: 1 };
    const secondCondition = { ...condition };
    const bars = rviBarsFromDeltas([...Array(8).fill(0), 2]);
    const strategy = {
      ...strategyFor(condition),
      entryConditions: [condition, secondCondition],
    };

    try {
      expect(createStrategyEvaluator(bars).isEntrySignal(strategy, 8)).toBe(true);
      expect(rviSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }

    // The future close is a strong downward shock: a look-ahead implementation
    // using bar 9 while judging bar 8 would reverse this long cross.
    const withFuture = [...bars, rviBar(9, 10, 15, 5, -90)];
    expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 8)).toBe(true);
    expect(createStrategyEvaluator(withFuture).isEntrySignal(strategyFor(condition), 8)).toBe(true);

    // RVI は look-ahead 可能な系列(rvi と signal)を2本比較する型なので、
    // ショックは両方向必要: 下方向は rvi 側の覗きを暴くが signal 側の覗きを
    // 隠す(実測: 未来close -90 では signal 覗きが不可視、+90/+100 で false に
    // 反転し検出可能)。上方向ショックで signal 側の look-ahead を固定する。
    const withFutureUp = [...bars, rviBar(9, 10, 15, 5, 100)];
    expect(createStrategyEvaluator(withFutureUp).isEntrySignal(strategyFor(condition), 8)).toBe(true);
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

  it('evaluates exposed Parabolic SAR flips in both directions and keeps warm-up closed', () => {
    const condition = { type: 'parabolicSar' as const, step: 0.1, maximum: 0.3 };
    const bars = makeSarStrategyBars();
    const evaluator = createStrategyEvaluator(bars);

    // Reversals at 2 and 3 are below the conservative exposure boundary 102.
    expect(evaluator.isEntrySignal(strategyFor(condition), 2)).toBe(false);
    expect(evaluator.isEntrySignal(strategyFor(condition), 3)).toBe(false);

    // The exposed short flip at 106 and long flip at 110 are mirrored exactly.
    expect(evaluator.isEntrySignal(strategyFor(condition, 'short'), 106)).toBe(true);
    expect(evaluator.isEntrySignal(strategyFor(condition), 106)).toBe(false);
    expect(evaluator.isEntrySignal(strategyFor(condition), 110)).toBe(true);
    expect(evaluator.isEntrySignal(strategyFor(condition, 'short'), 110)).toBe(false);
  });

  it('rejects invalid Parabolic SAR parameters and non-finite inputs fail closed', () => {
    const bars = makeSarStrategyBars();
    const evaluator = createStrategyEvaluator(bars);
    for (const [step, maximum] of [
      [0, 0.2],
      [-0.1, 0.2],
      [Number.NaN, 0.2],
      [0.2, 0.1],
      [0.1, Number.NaN],
      [Number.POSITIVE_INFINITY, 1],
      [0.1, Number.NEGATIVE_INFINITY],
    ]) {
      const condition = { type: 'parabolicSar' as const, step, maximum };
      expect(evaluator.isEntrySignal(strategyFor(condition), 110)).toBe(false);
      expect(evaluator.isEntrySignal(strategyFor(condition, 'short'), 110)).toBe(false);
    }

    const invalidBars = [...bars.slice(0, 110), bar(110, Number.NaN, 6, 40)];
    expect(
      createStrategyEvaluator(invalidBars).isEntrySignal(
        strategyFor({ type: 'parabolicSar', step: 0.1, maximum: 0.3 }),
        110,
      ),
    ).toBe(false);
  });

  it('memoizes Parabolic SAR by its step:maximum cache key', () => {
    const sarSpy = vi.spyOn(indicators, 'parabolicSar');
    // 同一パラメータの2条件がキャッシュを共有すること(メモ化)を断言する
    const firstCondition = { type: 'parabolicSar' as const, step: 0.1, maximum: 0.3 };
    const secondCondition = { type: 'parabolicSar' as const, step: 0.1, maximum: 0.3 };
    const bars = makeSarStrategyBars();
    const strategy = {
      ...strategyFor(firstCondition),
      entryConditions: [firstCondition, secondCondition],
    };

    try {
      expect(createStrategyEvaluator(bars).isEntrySignal(strategy, 110)).toBe(true);
      expect(sarSpy).toHaveBeenCalledTimes(1);
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

  it('detects stochCross with all four equality boundaries and mirrored directions', () => {
    const condition = { type: 'stochCross' as const, kPeriod: 2, dPeriod: 2, smoothing: 1 };
    const makeBars = (
      highs: readonly number[],
      lows: readonly number[],
      closes: readonly number[],
    ): Bar[] => barsFrom(highs, lows, closes);

    // With K=2, D=2, smoothing=1, these are hand-calculated exact values:
    // flat previous windows give K=[50, 50, 100], D[2]=50, D[3]=75. This
    // pins previous K===D and current K>D without relying on a 1-ULP coincidence.
    const longPreviousEquality = makeBars(
      [10, 10, 10, 20],
      [10, 10, 10, 0],
      [10, 10, 10, 20],
    );
    const longPreviousK = indicators.stochastic(
      longPreviousEquality.map((item) => item.h),
      longPreviousEquality.map((item) => item.l),
      longPreviousEquality.map((item) => item.c),
      2,
      2,
      1,
    );
    expect(longPreviousK.k[2]).toBe(50);
    expect(longPreviousK.k[3]).toBe(100);
    // StochCross's fresh D windows are (50 + 50) / 2 = 50 and
    // (50 + 100) / 2 = 75. These are hand-calculated values, not a
    // 1-ULP equality borrowed from the legacy sliding D series.
    expect((longPreviousK.k[1]! + longPreviousK.k[2]!) / 2).toBe(50);
    expect((longPreviousK.k[2]! + longPreviousK.k[3]!) / 2).toBe(75);
    expect(
      createStrategyEvaluator(longPreviousEquality).isEntrySignal(
        strategyFor(condition),
        3,
      ),
    ).toBe(true);

    // The current window is flat, so K===D exactly. Previous K<D, but current
    // equality must not satisfy the strict `>` boundary.
    const longCurrentEquality = makeBars(
      [20, 20, 10, 10],
      [0, 0, 10, 10],
      [0, 20, 10, 10],
    );
    expect(
      createStrategyEvaluator(longCurrentEquality).isEntrySignal(strategyFor(condition), 3),
    ).toBe(false);

    // Previous K===D and current K<D: the short mirror accepts previous `>=`
    // and current strict `<`.
    const shortPreviousEquality = makeBars(
      [10, 10, 10, 20],
      [10, 10, 10, 0],
      [10, 10, 10, 0],
    );
    expect(
      createStrategyEvaluator(shortPreviousEquality).isEntrySignal(
        strategyFor(condition, 'short'),
        3,
      ),
    ).toBe(true);

    // The current window is flat, so K===D exactly. Previous K>D, but current
    // equality must not satisfy the strict `<` boundary.
    const shortCurrentEquality = makeBars(
      [20, 20, 10, 10],
      [0, 0, 10, 10],
      [20, 0, 10, 10],
    );
    expect(
      createStrategyEvaluator(shortCurrentEquality).isEntrySignal(
        strategyFor(condition, 'short'),
        3,
      ),
    ).toBe(false);
  });

  it('builds StochCross %K and %D fresh without consuming stochastic() at all', () => {
    const condition = { type: 'stochCross' as const, kPeriod: 2, dPeriod: 2, smoothing: 1 };
    const bars = barsFrom([10, 10, 10, 10], [0, 0, 0, 0], [5, 5, 5, 10]);
    // If the evaluator consumed either sliding series from stochastic(), this
    // poisoned mock would corrupt the otherwise-valid fresh-window cross.
    const stochasticSpy = vi.spyOn(indicators, 'stochastic').mockReturnValue({
      k: [null, 0, 0, 0],
      d: [null, 0, 0, 0],
    });
    try {
      expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 3)).toBe(true);
      expect(stochasticSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('pins the raw %K operation order bit-for-bit against an in-test oracle', () => {
    // With smoothing=1 the fresh per-window SMA is exact (sum of one value,
    // divided by 1), so computeStochCrossSeries().k equals raw %K bit for
    // bit. The oracle below intentionally duplicates the canonical
    // ((close - lowest) / range) * 100 expression: on drift-prone
    // non-terminating-binary floats, rewriting the production side as
    // ((close - lowest) * 100) / range is algebraically equal but
    // floating-point different, which is exactly the 1-ULP phantom-cross
    // defect class from the US-2201 reviews. (indicators.stochastic() cannot
    // serve as the oracle: its sliding smaFromNullable drifts even at
    // period 1 because it adds before subtracting.)
    const kPeriod = 14;
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const mid = 0.66 + Math.sin(i) * 0.01;
      const span = 0.005 + Math.cos(i * 1.7) ** 2 * 0.003;
      highs.push(mid + span);
      lows.push(mid - span);
      closes.push(mid + Math.sin(i * 2.3) * span * 0.9);
    }
    const oracle: (number | null)[] = Array(closes.length).fill(null);
    for (let i = kPeriod - 1; i < closes.length; i += 1) {
      let highest = -Infinity;
      let lowest = Infinity;
      for (let offset = i - kPeriod + 1; offset <= i; offset += 1) {
        highest = Math.max(highest, highs[offset]);
        lowest = Math.min(lowest, lows[offset]);
      }
      const range = highest - lowest;
      oracle[i] = range === 0 ? 50 : ((closes[i] - lowest) / range) * 100;
    }
    const fresh = computeStochCrossSeries(highs, lows, closes, kPeriod, 2, 1).k;
    expect(fresh).toHaveLength(oracle.length);
    for (let index = 0; index < fresh.length; index += 1) {
      expect(Object.is(fresh[index], oracle[index])).toBe(true);
    }
  });

  it('keeps exact %K === %D ties on flat windows built from drift-prone floats', () => {
    // Regression fixture minimized from real GBPJPY data by the US-2201
    // re-review: one moving bar followed by five identical float bars. The
    // sliding smaFromNullable recurrence carries ~1e-13 residue into the flat
    // region (k=49.999999999999986 while a fresh window gives exactly 50), so
    // an implementation that consumes either sliding series fires a phantom
    // cross here while the generated MQL (fresh per-window sums) stays quiet.
    const flatFloat = 0.662467425714624;
    const bars = [
      bar(0, 0.6632641447645959, 0.6528053803111171, 0.6599011045281127),
      bar(1, flatFloat, flatFloat, flatFloat),
      bar(2, flatFloat, flatFloat, flatFloat),
      bar(3, flatFloat, flatFloat, flatFloat),
      bar(4, flatFloat, flatFloat, flatFloat),
      bar(5, flatFloat, flatFloat, flatFloat),
    ];
    const condition = { type: 'stochCross' as const, kPeriod: 2, dPeriod: 3, smoothing: 1 };
    const evaluator = createStrategyEvaluator(bars);
    // Inside the flat region %K and %D are exact ties, so neither direction
    // may fire on any bar of the tail.
    for (const index of [3, 4, 5]) {
      expect(evaluator.isEntrySignal(strategyFor(condition), index)).toBe(false);
      expect(evaluator.isEntrySignal(strategyFor(condition, 'short'), index)).toBe(false);
    }
  });

  it('keeps stochCross look-ahead-safe against K-side and D-side shocks', () => {
    const condition = { type: 'stochCross' as const, kPeriod: 2, dPeriod: 2, smoothing: 1 };
    const bars = barsFrom([10, 10, 10, 10], [0, 0, 0, 0], [5, 5, 5, 10]);
    const futureDownShock = bar(4, 20, 0, 0);
    const futureUpShock = bar(4, 20, 0, 20);

    expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 3)).toBe(true);
    // A downward future shock changes the future %K side. If %K at the signal
    // bar accidentally reads index+1, it reverses the long cross to false.
    expect(
      createStrategyEvaluator([...bars, futureDownShock]).isEntrySignal(
        strategyFor(condition),
        3,
      ),
    ).toBe(true);
    // An upward future shock changes the future %D side. The denominator high
    // and low are intentionally different from the existing bars, so a
    // look-ahead in the range cannot hide behind a constant high-low window.
    expect(
      createStrategyEvaluator([...bars, futureUpShock]).isEntrySignal(
        strategyFor(condition),
        3,
      ),
    ).toBe(true);
  });

  it('keeps the previous %D window independent from the current %D window', () => {
    const condition = { type: 'stochCross' as const, kPeriod: 2, dPeriod: 3, smoothing: 1 };
    const bars = barsFrom(
      [10, 10, 10, 10, 10],
      [0, 0, 0, 0, 0],
      [10, 10, 0, 5, 7],
    );
    const values = indicators.stochastic(
      bars.map((item) => item.h),
      bars.map((item) => item.l),
      bars.map((item) => item.c),
      condition.kPeriod,
      condition.dPeriod,
      condition.smoothing,
    );
    expect(values.k.slice(1)).toEqual([100, 0, 50, 70]);
    // At index 4, previous K/D are 50/50 and current K/D are 70/40.
    // A look-ahead mutation from values.d[index - 1] to values.d[index]
    // would compare 50 <= 40 and make this otherwise-valid long cross false.
    expect((values.k[1]! + values.k[2]! + values.k[3]!) / 3).toBe(50);
    expect((values.k[2]! + values.k[3]! + values.k[4]!) / 3).toBe(40);
    expect(createStrategyEvaluator(bars).isEntrySignal(strategyFor(condition), 4)).toBe(true);
  });

  it('fails closed for stochCross warm-up, flat windows, and invalid domains', () => {
    const condition = { type: 'stochCross' as const, kPeriod: 2, dPeriod: 2, smoothing: 1 };
    const warmupBars = barsFrom([10, 10], [0, 0], [5, 9]);
    // At index 1, %K is 90 while both previous %K/%D and current %D are null.
    // If the four-value finite guard is removed, JavaScript's relational
    // coercion makes null <= null and 90 > null true; the real evaluator must
    // fail closed before evaluating either cross edge.
    expect(createStrategyEvaluator(warmupBars).isEntrySignal(strategyFor(condition), 1)).toBe(
      false,
    );

    const flatBars = barsFrom([10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10]);
    const flatValues = indicators.stochastic(
      flatBars.map((item) => item.h),
      flatBars.map((item) => item.l),
      flatBars.map((item) => item.c),
      2,
      2,
      1,
    );
    expect(flatValues.k[2]).toBe(50);
    expect(flatValues.d[2]).toBe(50);
    expect(createStrategyEvaluator(flatBars).isEntrySignal(strategyFor(condition), 3)).toBe(
      false,
    );

    const signalBars = barsFrom([10, 10, 10, 10], [0, 0, 0, 0], [5, 5, 5, 10]);
    const evaluator = createStrategyEvaluator(signalBars);
    // Each invalid assertion is mutation-sensitive: removing the smoothing
    // guard or the K-period guard would normalize the value and make this
    // otherwise-valid long cross true. dPeriod=1 is separately rejected as a
    // %D===%K degeneracy even though that exact degeneration cannot cross.
    expect(
      evaluator.isEntrySignal(
        strategyFor({ ...condition, smoothing: 0 }),
        3,
      ),
    ).toBe(false);
    expect(
      evaluator.isEntrySignal(
        strategyFor({ ...condition, kPeriod: 1 }),
        3,
      ),
    ).toBe(false);
    for (const invalidCondition of [
      { ...condition, kPeriod: 1001 },
      { ...condition, dPeriod: 1 },
      { ...condition, dPeriod: 1001 },
      { ...condition, smoothing: 1.5 },
      { ...condition, smoothing: Number.NaN },
    ]) {
      expect(evaluator.isEntrySignal(strategyFor(invalidCondition), 3)).toBe(false);
    }
  });

  it('separates stochCross memoization keys by dPeriod', () => {
    const firstCondition = { type: 'stochCross' as const, kPeriod: 2, dPeriod: 2, smoothing: 1 };
    const differentDPeriod = { ...firstCondition, dPeriod: 3 };
    const bars = barsFrom([10, 10, 10, 10], [0, 0, 0, 0], [5, 5, 5, 10]);
    const evaluator = createStrategyEvaluator(bars);

    // Evaluate dPeriod=2 first so its series lands in the cache. dPeriod=2
    // fires the long cross at index 3, while dPeriod=3 must fail closed there
    // (its previous %D needs %K at index 0, which is still null). If the
    // memoization key ignored dPeriod, the second call would reuse the
    // dPeriod=2 series and flip this assertion to true.
    expect(evaluator.isEntrySignal(strategyFor(firstCondition), 3)).toBe(true);
    expect(evaluator.isEntrySignal(strategyFor(differentDPeriod), 3)).toBe(false);
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

  it('computes median-price SMMA with a fresh oldest-to-newest seed and exact recurrence', () => {
    const highs = [3, 7, 11, 15, 19];
    const lows = [1, 3, 7, 9, 11];
    const series = computeAlligatorSeries(highs, lows, 4, 3, 2);
    const seededTeeth = (2 + 5 + 9) / 3;
    const nextTeeth = (seededTeeth * (3 - 1) + 12) / 3;
    const finalTeeth = (nextTeeth * (3 - 1) + 15) / 3;

    expect(series.jaw).toEqual([null, null, null, 7, 9]);
    expect(series.teeth).toEqual([null, null, seededTeeth, nextTeeth, finalTeeth]);
    expect(series.lips).toEqual([null, 3.5, 6.25, 9.125, 12.0625]);
    expect(() => computeAlligatorSeries([1], [], 4, 3, 2)).toThrow(
      'highs and lows must have the same length',
    );
  });

  it('fixes all six Alligator equality edges with mutation-sensitive fixtures', () => {
    const fixtures = [
      {
        name: 'long previous Lips <= Teeth boundary',
        direction: 'long' as const,
        medians: [-2, -2, -3, 2, 2, -1, 0, 2, 0.09655778463648823, 1.2445273205304068],
        expected: true,
        edge: 'previous' as const,
        mutateAt: 8,
        delta: 0.5,
      },
      {
        name: 'long current Lips > Teeth boundary',
        direction: 'long' as const,
        medians: [-2, -2, -3, 2, 2, -1, 0, 2, 0, 0.22843435642432552],
        expected: false,
        edge: 'lips' as const,
        mutateAt: 9,
        delta: 0.5,
      },
      {
        name: 'long current Teeth > Jaw boundary',
        direction: 'long' as const,
        medians: [-2, -2, -3, 2, 2, -1, 0, 2, -0.5565187221364882, 1.135681236068244],
        expected: false,
        edge: 'jaw' as const,
        mutateAt: 7,
        delta: -0.5,
      },
      {
        name: 'short previous Lips >= Teeth boundary',
        direction: 'short' as const,
        medians: [2, 0, -1, 3, -1, -3, -3, 0, -0.8431498628257887, -1.8849165523548241],
        expected: true,
        edge: 'previous' as const,
        mutateAt: 7,
        delta: 0.5,
      },
      {
        name: 'short current Lips < Teeth boundary',
        direction: 'short' as const,
        medians: [1, 3, 1, 3, 3, -4, -2, -2, 0, -0.48459290695016],
        expected: false,
        edge: 'lips' as const,
        mutateAt: 9,
        delta: -0.5,
      },
      {
        name: 'short current Teeth < Jaw boundary',
        direction: 'short' as const,
        medians: [2, 0, -1, 3, -1, -3, -3, 0, -0.38341263717421126, -1.8082936814128945],
        expected: false,
        edge: 'jaw' as const,
        mutateAt: 7,
        delta: 0.5,
      },
    ];

    for (const fixture of fixtures) {
      const bars = alligatorBarsFromMedians(fixture.medians);
      const series = computeAlligatorSeries(
        fixture.medians,
        fixture.medians,
        alligatorBoundaryCondition.jawPeriod,
        alligatorBoundaryCondition.teethPeriod,
        alligatorBoundaryCondition.lipsPeriod,
      );
      const equalLines =
        fixture.edge === 'previous'
          ? [series.lips[8], series.teeth[7]]
          : fixture.edge === 'lips'
            ? [series.lips[9], series.teeth[8]]
            : [series.teeth[8], series.jaw[7]];
      expect(equalLines[0], fixture.name).toBe(equalLines[1]);
      expect(
        createStrategyEvaluator(bars).isEntrySignal(
          strategyFor(alligatorBoundaryCondition, fixture.direction),
          9,
        ),
        fixture.name,
      ).toBe(fixture.expected);

      const mutatedMedians = [...fixture.medians];
      mutatedMedians[fixture.mutateAt] += fixture.delta;
      expect(
        createStrategyEvaluator(alligatorBarsFromMedians(mutatedMedians)).isEntrySignal(
          strategyFor(alligatorBoundaryCondition, fixture.direction),
          9,
        ),
        `${fixture.name} mutation`,
      ).toBe(!fixture.expected);
    }
  });

  it('keeps Alligator flat windows closed and never consumes indicators.ts helpers', () => {
    const flatBars = alligatorBarsFromMedians(Array.from({ length: 12 }, () => 5));
    const flatSeries = computeAlligatorSeries(
      flatBars.map((item) => item.h),
      flatBars.map((item) => item.l),
      4,
      3,
      2,
    );
    expect(flatSeries.jaw[11]).toBe(5);
    expect(flatSeries.teeth[11]).toBe(5);
    expect(flatSeries.lips[11]).toBe(5);
    const flatEvaluator = createStrategyEvaluator(flatBars);
    expect(flatEvaluator.isEntrySignal(strategyFor(alligatorBoundaryCondition), 11)).toBe(false);
    expect(
      flatEvaluator.isEntrySignal(strategyFor(alligatorBoundaryCondition, 'short'), 11),
    ).toBe(false);

    const smaSpy = vi.spyOn(indicators, 'sma').mockImplementation(() => {
      throw new Error('Alligator must not consume indicators.sma');
    });
    const emaSpy = vi.spyOn(indicators, 'ema').mockImplementation(() => {
      throw new Error('Alligator must not consume indicators.ema');
    });
    try {
      const signalBars = alligatorBarsFromMedians([
        -2,
        -2,
        -3,
        2,
        2,
        -1,
        0,
        2,
        0.09655778463648823,
        1.2445273205304068,
      ]);
      expect(
        createStrategyEvaluator(signalBars).isEntrySignal(
          strategyFor(alligatorBoundaryCondition),
          9,
        ),
      ).toBe(true);
      expect(smaSpy).not.toHaveBeenCalled();
      expect(emaSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('pins shifted Alligator warm-up one bar before and after the boundary', () => {
    const medians = [-5.5, -3, -9, 1, -5, 0.5];
    const series = computeAlligatorSeries(medians, medians, 4, 3, 2);
    expect(series.jaw[2]).toBeNull();
    expect(series.jaw[3]).toBe(-4.125);

    const evaluator = createStrategyEvaluator(alligatorBarsFromMedians(medians));
    expect(evaluator.isEntrySignal(strategyFor(alligatorBoundaryCondition), 4)).toBe(false);
    expect(evaluator.isEntrySignal(strategyFor(alligatorBoundaryCondition), 5)).toBe(true);
  });

  it('keeps Alligator signals causal in both directions and separates cache keys', () => {
    const longMedians = [
      -2,
      -2,
      -3,
      2,
      2,
      -1,
      0,
      2,
      0.09655778463648823,
      1.2445273205304068,
    ];
    const shortMedians = [
      2,
      0,
      -1,
      3,
      -1,
      -3,
      -3,
      0,
      -0.8431498628257887,
      -1.8849165523548241,
    ];
    const longCondition = alligatorBoundaryCondition;
    const differentPeriodCondition = {
      ...longCondition,
      jawPeriod: 5,
      teethPeriod: 4,
    } as const;
    const cachedEvaluator = createStrategyEvaluator(alligatorBarsFromMedians(longMedians));
    expect(cachedEvaluator.isEntrySignal(strategyFor(longCondition), 9)).toBe(true);
    expect(cachedEvaluator.isEntrySignal(strategyFor(differentPeriodCondition), 9)).toBe(false);

    const futureShock = [bar(10, 1_000_000, -1_000_000, 1_000_000)];
    expect(
      createStrategyEvaluator([
        ...alligatorBarsFromMedians(longMedians),
        ...futureShock,
      ]).isEntrySignal(strategyFor(longCondition), 9),
    ).toBe(true);
    expect(
      createStrategyEvaluator([
        ...alligatorBarsFromMedians(shortMedians),
        ...futureShock,
      ]).isEntrySignal(strategyFor({ ...longCondition }, 'short'), 9),
    ).toBe(true);

    const falseMedians = [-3, 0, 1, 0, 3, 2, -2, -3, 3, 0];
    expect(
      createStrategyEvaluator(alligatorBarsFromMedians(falseMedians)).isEntrySignal(
        strategyFor(longCondition),
        9,
      ),
    ).toBe(false);
    expect(
      createStrategyEvaluator([
        ...alligatorBarsFromMedians(falseMedians),
        bar(10, 1_000_000, 1_000_000, 1_000_000),
      ]).isEntrySignal(strategyFor(longCondition), 9),
    ).toBe(false);
  });

  it('fails closed for invalid Alligator domains and non-finite median data', () => {
    const bars = alligatorBarsFromMedians([
      -2,
      -2,
      -3,
      2,
      2,
      -1,
      0,
      2,
      0.09655778463648823,
      1.2445273205304068,
    ]);
    const evaluator = createStrategyEvaluator(bars);
    const invalidConditions: EntryCondition[] = [
      { ...alligatorBoundaryCondition, jawPeriod: 1 },
      { ...alligatorBoundaryCondition, teethPeriod: 1001 },
      { ...alligatorBoundaryCondition, lipsPeriod: 2.5 },
      { ...alligatorBoundaryCondition, jawPeriod: 4, teethPeriod: 4 },
      { ...alligatorBoundaryCondition, jawPeriod: 4, teethPeriod: 5 },
      { ...alligatorBoundaryCondition, jawPeriod: 4, teethPeriod: 3, lipsPeriod: 3 },
      { ...alligatorBoundaryCondition, jawShift: -1 },
      { ...alligatorBoundaryCondition, teethShift: 501 },
      { ...alligatorBoundaryCondition, lipsShift: 1.5 },
      { ...alligatorBoundaryCondition, jawShift: 2, teethShift: 2 },
      { ...alligatorBoundaryCondition, jawShift: 1, teethShift: 2 },
      { ...alligatorBoundaryCondition, jawShift: 8, teethShift: 3, lipsShift: 3 },
    ];
    for (const condition of invalidConditions) {
      expect(evaluator.isEntrySignal(strategyFor(condition), 9)).toBe(false);
    }

    // These use enough history to distinguish each ordering/shift guard from
    // the independent SMMA warm-up null path. Each corresponding unguarded
    // mutant produces a signal at the specified index.
    const domainGuardFixtures: Array<{
      name: string;
      medians: readonly number[];
      condition: EntryCondition;
      direction: 'long' | 'short';
      index: number;
    }> = [
      {
        name: 'teeth and lips periods must be strictly ordered',
        medians: [-2, -2, -3, 2, 2, -1, 0, 2, 0.09655778463648823, 1.2445273205304068],
        condition: { ...alligatorBoundaryCondition, teethPeriod: 3, lipsPeriod: 3 },
        direction: 'long',
        index: 9,
      },
      {
        name: 'teeth and lips shifts must be strictly ordered',
        medians: [-2, 2, -1, 2, 1, -3, 1, 3, -3, 1, -1, 2, 3, 0],
        condition: { ...alligatorBoundaryCondition, jawShift: 2, teethShift: 1, lipsShift: 1 },
        direction: 'long',
        index: 7,
      },
      {
        name: 'jaw and teeth shifts must be strictly ordered',
        medians: [0, -1, 3, -1, 3, -2, 2, -2, 1, -1],
        condition: { ...alligatorBoundaryCondition, jawShift: 1, teethShift: 1, lipsShift: 0 },
        direction: 'short',
        index: 9,
      },
      {
        name: 'jaw and teeth periods must be strictly ordered',
        medians: [0, 0, 3, -3, 0, -2, 2, 0, 0, 1, -1, 0, 3],
        condition: { ...alligatorBoundaryCondition, jawPeriod: 3, teethPeriod: 3, lipsPeriod: 2 },
        direction: 'long',
        index: 12,
      },
      {
        name: 'negative shifts must fail closed instead of looking ahead',
        medians: [-3, -3, -3, 3, -2, -1, -3, -1, 2, 0, -3, 0, 2, 2],
        condition: { ...alligatorBoundaryCondition, jawShift: -1, teethShift: -2, lipsShift: -3 },
        direction: 'long',
        index: 2,
      },
    ];
    for (const fixture of domainGuardFixtures) {
      expect(
        createStrategyEvaluator(alligatorBarsFromMedians(fixture.medians)).isEntrySignal(
          strategyFor(fixture.condition, fixture.direction),
          fixture.index,
        ),
        fixture.name,
      ).toBe(false);
    }

    const nonFiniteBars = alligatorBarsFromMedians([
      -2,
      -2,
      -3,
      2,
      2,
      -1,
      0,
      2,
      Number.NaN,
      1.2445273205304068,
    ]);
    const nonFiniteSeries = computeAlligatorSeries(
      nonFiniteBars.map((item) => item.h),
      nonFiniteBars.map((item) => item.l),
      4,
      3,
      2,
    );
    expect(nonFiniteSeries.jaw[8]).toBeNull();
    expect(
      createStrategyEvaluator(nonFiniteBars).isEntrySignal(
        strategyFor(alligatorBoundaryCondition),
        9,
      ),
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
    expect(
      conditionLabel({ type: 'stochCross', kPeriod: 14, dPeriod: 3, smoothing: 3 }),
    ).toBe('Stoch14/3/3 %K/%D クロス');
    expect(conditionLabel({ type: 'cciBreak', period: 14, level: 100 })).toBe(
      'CCI14 ±100 ブレイク',
    );
    expect(conditionLabel({ type: 'adxTrend', period: 14, threshold: 25 })).toBe(
      'ADX14/25 DIクロス',
    );
    expect(conditionLabel({ type: 'parabolicSar', step: 0.02, maximum: 0.2 })).toBe(
      'SAR0.02/0.2 フリップ',
    );
    expect(conditionLabel({ type: 'momentum', period: 14 })).toBe('Momentum14 100クロス');
    expect(conditionLabel({ type: 'rvi', period: 10 })).toBe('RVI10 シグナルクロス');
    expect(conditionLabel({ type: 'envelope', period: 14, deviation: 0.1 })).toBe(
      'Envelope14/0.1% ブレイク',
    );
    expect(
      conditionLabel({ type: 'demarker', period: 14, threshold: 0.5, comparison: 'above' }),
    ).toBe('DeMarker14 above 0.5');
    expect(
      conditionLabel({
        type: 'alligator',
        jawPeriod: 13,
        teethPeriod: 8,
        lipsPeriod: 5,
        jawShift: 8,
        teethShift: 5,
        lipsShift: 3,
      }),
    ).toBe('Alligator 13/8/5 (8/5/3) クロス');
  });
});

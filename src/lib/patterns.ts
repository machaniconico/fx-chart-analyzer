import { calculateAtr, findFractalSwings, type SwingPoint } from './levels';
import type { Bar } from '../types';

export type PatternKind = 'candle' | 'chart';
export type PatternDirection = 'bullish' | 'bearish' | 'neutral';
export type PatternStrength = 1 | 2 | 3;

export interface PatternTimeRange {
  from: number;
  to: number;
}

export interface DetectedPattern {
  id: string;
  label: string;
  kind: PatternKind;
  direction: PatternDirection;
  barIndex: number;
  barTimeRange: PatternTimeRange;
  strength: PatternStrength;
  detail: string;
}

export interface PatternDetectionOptions {
  lookback?: number;
  pivotStrength?: number;
}

interface CandleShape {
  body: number;
  range: number;
  upperWick: number;
  lowerWick: number;
  bodyRatio: number;
  bullish: boolean;
  bearish: boolean;
}

const minTick = 0.0000001;

const formatPrice = (value: number): string => value.toFixed(Math.abs(value) >= 10 ? 3 : 5);

const candleShape = (bar: Bar): CandleShape => {
  const body = Math.abs(bar.c - bar.o);
  const range = Math.max(bar.h - bar.l, minTick);
  return {
    body,
    range,
    upperWick: bar.h - Math.max(bar.o, bar.c),
    lowerWick: Math.min(bar.o, bar.c) - bar.l,
    bodyRatio: body / range,
    bullish: bar.c > bar.o,
    bearish: bar.c < bar.o,
  };
};

const addPattern = (
  patterns: DetectedPattern[],
  bars: readonly Bar[],
  idBase: string,
  label: string,
  kind: PatternKind,
  direction: PatternDirection,
  firstIndex: number,
  lastIndex: number,
  strength: PatternStrength,
  detail: string,
): void => {
  patterns.push({
    id: `${idBase}-${lastIndex}`,
    label,
    kind,
    direction,
    barIndex: lastIndex,
    barTimeRange: {
      from: bars[firstIndex].t,
      to: bars[lastIndex].t,
    },
    strength,
    detail,
  });
};

const detectCandlePatterns = (
  bars: readonly Bar[],
  startIndex: number,
  patterns: DetectedPattern[],
): void => {
  for (let index = startIndex; index < bars.length; index += 1) {
    const current = bars[index];
    const currentShape = candleShape(current);

    if (currentShape.range > minTick) {
      const bullishPin =
        currentShape.lowerWick >= Math.max(currentShape.body * 2.2, currentShape.range * 0.52) &&
        currentShape.upperWick <= currentShape.range * 0.28 &&
        current.c >= current.l + currentShape.range * 0.55;
      const bearishPin =
        currentShape.upperWick >= Math.max(currentShape.body * 2.2, currentShape.range * 0.52) &&
        currentShape.lowerWick <= currentShape.range * 0.28 &&
        current.c <= current.h - currentShape.range * 0.55;

      if (bullishPin) {
        addPattern(
          patterns,
          bars,
          'pinbar-bullish',
          'ピンバー（下ヒゲ）',
          'candle',
          'bullish',
          index,
          index,
          currentShape.lowerWick >= currentShape.range * 0.68 ? 3 : 2,
          `長い下ヒゲが反発を示唆。下ヒゲ比率 ${(currentShape.lowerWick / currentShape.range * 100).toFixed(0)}%。`,
        );
      } else if (bearishPin) {
        addPattern(
          patterns,
          bars,
          'pinbar-bearish',
          'ピンバー（上ヒゲ）',
          'candle',
          'bearish',
          index,
          index,
          currentShape.upperWick >= currentShape.range * 0.68 ? 3 : 2,
          `長い上ヒゲが反落を示唆。上ヒゲ比率 ${(currentShape.upperWick / currentShape.range * 100).toFixed(0)}%。`,
        );
      }

      if (currentShape.bodyRatio <= 0.1) {
        addPattern(
          patterns,
          bars,
          'doji',
          '同時線',
          'candle',
          'neutral',
          index,
          index,
          1,
          `実体がレンジの ${(currentShape.bodyRatio * 100).toFixed(1)}%。迷いが強い足。`,
        );
      }
    }

    if (index >= 1) {
      const previous = bars[index - 1];
      const previousShape = candleShape(previous);
      const currentBodyHigh = Math.max(current.o, current.c);
      const currentBodyLow = Math.min(current.o, current.c);
      const previousBodyHigh = Math.max(previous.o, previous.c);
      const previousBodyLow = Math.min(previous.o, previous.c);
      const bodyEngulfsPrevious = currentBodyHigh >= previousBodyHigh && currentBodyLow <= previousBodyLow;

      if (previousShape.bearish && currentShape.bullish && bodyEngulfsPrevious && currentShape.body > previousShape.body * 0.9) {
        addPattern(
          patterns,
          bars,
          'engulfing-bullish',
          '包み足（陽線）',
          'candle',
          'bullish',
          index - 1,
          index,
          currentShape.body > previousShape.body * 1.35 ? 3 : 2,
          '前の陰線実体を陽線実体が包み込み。',
        );
      } else if (
        previousShape.bullish &&
        currentShape.bearish &&
        bodyEngulfsPrevious &&
        currentShape.body > previousShape.body * 0.9
      ) {
        addPattern(
          patterns,
          bars,
          'engulfing-bearish',
          '包み足（陰線）',
          'candle',
          'bearish',
          index - 1,
          index,
          currentShape.body > previousShape.body * 1.35 ? 3 : 2,
          '前の陽線実体を陰線実体が包み込み。',
        );
      }
    }

    if (index >= 2) {
      const first = bars[index - 2];
      const middle = bars[index - 1];
      const third = bars[index];
      const firstShape = candleShape(first);
      const middleShape = candleShape(middle);
      const thirdShape = candleShape(third);
      const firstMidpoint = (first.o + first.c) / 2;
      const firstBodyLarge = firstShape.bodyRatio >= 0.48;
      const middleSmall = middleShape.bodyRatio <= 0.32 && middleShape.body < firstShape.body * 0.75;
      const thirdLarge = thirdShape.bodyRatio >= 0.42;

      if (
        firstShape.bearish &&
        firstBodyLarge &&
        middleSmall &&
        thirdShape.bullish &&
        thirdLarge &&
        third.c > firstMidpoint
      ) {
        addPattern(
          patterns,
          bars,
          'morning-star',
          '明けの明星',
          'candle',
          'bullish',
          index - 2,
          index,
          third.c >= first.o ? 3 : 2,
          '大陰線、小実体、切り返しの陽線で反転候補。',
        );
      } else if (
        firstShape.bullish &&
        firstBodyLarge &&
        middleSmall &&
        thirdShape.bearish &&
        thirdLarge &&
        third.c < firstMidpoint
      ) {
        addPattern(
          patterns,
          bars,
          'evening-star',
          '宵の明星',
          'candle',
          'bearish',
          index - 2,
          index,
          third.c <= first.o ? 3 : 2,
          '大陽線、小実体、切り返しの陰線で反転候補。',
        );
      }
    }
  }
};

const normalizeSwings = (swings: readonly SwingPoint[]): SwingPoint[] => {
  const normalized: SwingPoint[] = [];
  for (const point of swings) {
    const last = normalized[normalized.length - 1];
    if (!last || last.kind !== point.kind) {
      normalized.push(point);
      continue;
    }
    const moreExtreme =
      point.kind === 'high' ? point.price > last.price : point.price < last.price;
    if (moreExtreme) {
      normalized[normalized.length - 1] = point;
    }
  }
  return normalized;
};

const similar = (a: number, b: number, tolerance: number): boolean =>
  Math.abs(a - b) <= tolerance;

const detectChartPatterns = (
  bars: readonly Bar[],
  startIndex: number,
  pivotStrength: number,
  patterns: DetectedPattern[],
): void => {
  const swings = normalizeSwings(findFractalSwings(bars, {
    lookback: bars.length - startIndex,
    pivotStrength,
  }));
  const currentClose = bars[bars.length - 1].c;
  const atr = calculateAtr(bars.slice(startIndex), 14);
  const tolerance = Math.max(atr ? atr * 0.8 : 0, Math.abs(currentClose) * 0.0012, 0.00001);

  for (let index = 0; index <= swings.length - 3; index += 1) {
    const first = swings[index];
    const middle = swings[index + 1];
    const second = swings[index + 2];

    if (
      first.kind === 'high' &&
      middle.kind === 'low' &&
      second.kind === 'high' &&
      similar(first.price, second.price, tolerance) &&
      Math.min(first.price, second.price) - middle.price >= tolerance * 1.25
    ) {
      addPattern(
        patterns,
        bars,
        'double-top',
        'ダブルトップ',
        'chart',
        'bearish',
        first.index,
        second.index,
        Math.min(first.price, second.price) - middle.price >= tolerance * 2.5 ? 3 : 2,
        `2つの高値 ${formatPrice(first.price)} / ${formatPrice(second.price)} が近接。`,
      );
    } else if (
      first.kind === 'low' &&
      middle.kind === 'high' &&
      second.kind === 'low' &&
      similar(first.price, second.price, tolerance) &&
      middle.price - Math.max(first.price, second.price) >= tolerance * 1.25
    ) {
      addPattern(
        patterns,
        bars,
        'double-bottom',
        'ダブルボトム',
        'chart',
        'bullish',
        first.index,
        second.index,
        middle.price - Math.max(first.price, second.price) >= tolerance * 2.5 ? 3 : 2,
        `2つの安値 ${formatPrice(first.price)} / ${formatPrice(second.price)} が近接。`,
      );
    }
  }

  for (let index = 0; index <= swings.length - 5; index += 1) {
    const leftShoulder = swings[index];
    const leftNeck = swings[index + 1];
    const head = swings[index + 2];
    const rightNeck = swings[index + 3];
    const rightShoulder = swings[index + 4];

    if (
      leftShoulder.kind === 'high' &&
      leftNeck.kind === 'low' &&
      head.kind === 'high' &&
      rightNeck.kind === 'low' &&
      rightShoulder.kind === 'high' &&
      head.price - Math.max(leftShoulder.price, rightShoulder.price) >= tolerance &&
      similar(leftShoulder.price, rightShoulder.price, tolerance * 1.8) &&
      similar(leftNeck.price, rightNeck.price, tolerance * 2.5)
    ) {
      addPattern(
        patterns,
        bars,
        'head-shoulders',
        '三尊（ヘッド&ショルダーズ）',
        'chart',
        'bearish',
        leftShoulder.index,
        rightShoulder.index,
        head.price - Math.max(leftShoulder.price, rightShoulder.price) >= tolerance * 2 ? 3 : 2,
        `頭 ${formatPrice(head.price)} が両肩を上回り、ネックラインが近接。`,
      );
    } else if (
      leftShoulder.kind === 'low' &&
      leftNeck.kind === 'high' &&
      head.kind === 'low' &&
      rightNeck.kind === 'high' &&
      rightShoulder.kind === 'low' &&
      Math.min(leftShoulder.price, rightShoulder.price) - head.price >= tolerance &&
      similar(leftShoulder.price, rightShoulder.price, tolerance * 1.8) &&
      similar(leftNeck.price, rightNeck.price, tolerance * 2.5)
    ) {
      addPattern(
        patterns,
        bars,
        'inverse-head-shoulders',
        '逆三尊',
        'chart',
        'bullish',
        leftShoulder.index,
        rightShoulder.index,
        Math.min(leftShoulder.price, rightShoulder.price) - head.price >= tolerance * 2 ? 3 : 2,
        `頭 ${formatPrice(head.price)} が両肩を下回り、ネックラインが近接。`,
      );
    }
  }
};

export const detectPatterns = (
  bars: readonly Bar[],
  options: PatternDetectionOptions = {},
): DetectedPattern[] => {
  if (bars.length === 0) {
    return [];
  }

  const lookback = options.lookback ?? 120;
  const pivotStrength = options.pivotStrength ?? 2;
  const startIndex = Math.max(0, bars.length - lookback);
  const patterns: DetectedPattern[] = [];

  detectCandlePatterns(bars, startIndex, patterns);
  detectChartPatterns(bars, startIndex, pivotStrength, patterns);

  const unique = new Map<string, DetectedPattern>();
  for (const pattern of patterns) {
    unique.set(pattern.id, pattern);
  }

  return [...unique.values()].sort((a, b) => b.barIndex - a.barIndex || b.strength - a.strength);
};

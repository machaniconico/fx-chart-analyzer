import { bollingerBands, ichimoku, macd, rsi, sma } from './indicators';
import { findFractalSwings } from './levels';
import type { Bar } from '../types';

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';

export interface Signal {
  id: string;
  label: string;
  direction: SignalDirection;
  weight: -2 | -1 | 0 | 1 | 2;
  detail: string;
}

export type SignalRatingId = 'strong_sell' | 'sell' | 'neutral' | 'buy' | 'strong_buy';

export interface SignalRating {
  id: SignalRatingId;
  label: string;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface SignalAnalysis {
  signals: Signal[];
  score: number;
  maxAbsScore: number;
  scoreRatio: number;
  rating: SignalRating;
}

interface SwingLevel {
  price: number;
  distancePct: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const isNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const crossedAbove = (
  previousFast: number | null,
  previousSlow: number | null,
  currentFast: number | null,
  currentSlow: number | null,
): boolean =>
  isNumber(previousFast) &&
  isNumber(previousSlow) &&
  isNumber(currentFast) &&
  isNumber(currentSlow) &&
  previousFast <= previousSlow &&
  currentFast > currentSlow;

const crossedBelow = (
  previousFast: number | null,
  previousSlow: number | null,
  currentFast: number | null,
  currentSlow: number | null,
): boolean =>
  isNumber(previousFast) &&
  isNumber(previousSlow) &&
  isNumber(currentFast) &&
  isNumber(currentSlow) &&
  previousFast >= previousSlow &&
  currentFast < currentSlow;

const formatPriceLike = (value: number): string => {
  const digits = Math.abs(value) >= 10 ? 3 : 5;
  return value.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const formatPercent = (value: number): string => `${(value * 100).toFixed(2)}%`;

export const judgeSignalScore = (score: number): SignalRating => {
  if (score <= -4) {
    return { id: 'strong_sell', label: '強い売り', level: 0 };
  }
  if (score <= -1) {
    return { id: 'sell', label: '売り', level: 1 };
  }
  if (score < 1) {
    return { id: 'neutral', label: '中立', level: 2 };
  }
  if (score < 4) {
    return { id: 'buy', label: '買い', level: 3 };
  }
  return { id: 'strong_buy', label: '強い買い', level: 4 };
};

const latestAtr = (bars: readonly Bar[], period = 14): number | null => {
  if (bars.length < 2) {
    return null;
  }

  const start = Math.max(1, bars.length - period);
  let total = 0;
  let count = 0;
  for (let i = start; i < bars.length; i += 1) {
    const previousClose = bars[i - 1].c;
    const trueRange = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - previousClose),
      Math.abs(bars[i].l - previousClose),
    );
    total += trueRange;
    count += 1;
  }

  return count > 0 ? total / count : null;
};

const findSwingLevels = (
  bars: readonly Bar[],
  lookback = 120,
  pivotStrength = 2,
): { support: SwingLevel | null; resistance: SwingLevel | null; thresholdPct: number } => {
  const latest = bars[bars.length - 1];
  const currentClose = latest.c;
  const start = Math.max(0, bars.length - lookback);
  const swings = findFractalSwings(bars, { lookback, pivotStrength });
  const pivotHighs = swings.filter((point) => point.kind === 'high').map((point) => point.price);
  const pivotLows = swings.filter((point) => point.kind === 'low').map((point) => point.price);

  const fallback = bars.slice(start, Math.max(start + 1, bars.length - 1));
  if (pivotHighs.length === 0 && fallback.length > 0) {
    pivotHighs.push(Math.max(...fallback.map((bar) => bar.h)));
  }
  if (pivotLows.length === 0 && fallback.length > 0) {
    pivotLows.push(Math.min(...fallback.map((bar) => bar.l)));
  }

  const supportPrice = [...pivotLows].reverse().find((price) => price <= currentClose) ?? null;
  const resistancePrice = [...pivotHighs].reverse().find((price) => price >= currentClose) ?? null;
  const atr = latestAtr(bars, 14);
  const atrPct = atr && currentClose !== 0 ? Math.abs(atr / currentClose) : 0.002;
  const thresholdPct = clamp(Math.max(0.0015, atrPct * 0.75), 0.0015, 0.012);

  return {
    support:
      supportPrice === null
        ? null
        : { price: supportPrice, distancePct: Math.abs(currentClose - supportPrice) / Math.abs(currentClose) },
    resistance:
      resistancePrice === null
        ? null
        : { price: resistancePrice, distancePct: Math.abs(resistancePrice - currentClose) / Math.abs(currentClose) },
    thresholdPct,
  };
};

// Keep these scoring rules aligned with adaptive-core.js scoreSignalSeries.
export const analyzeSignals = (bars: readonly Bar[]): SignalAnalysis => {
  const signals: Signal[] = [];
  if (bars.length < 2) {
    return {
      signals,
      score: 0,
      maxAbsScore: 1,
      scoreRatio: 0,
      rating: judgeSignalScore(0),
    };
  }

  const closes = bars.map((bar) => bar.c);
  const highs = bars.map((bar) => bar.h);
  const lows = bars.map((bar) => bar.l);
  const latestIndex = bars.length - 1;
  const previousIndex = latestIndex - 1;
  const latestClose = closes[latestIndex];

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  if (crossedAbove(sma20[previousIndex], sma50[previousIndex], sma20[latestIndex], sma50[latestIndex])) {
    signals.push({
      id: 'sma-golden-cross',
      label: 'SMA20×50 ゴールデンクロス',
      direction: 'bullish',
      weight: 2,
      detail: `SMA20がSMA50を上抜け。短期平均 ${formatPriceLike(sma20[latestIndex] as number)} / 中期平均 ${formatPriceLike(sma50[latestIndex] as number)}`,
    });
  } else if (crossedBelow(sma20[previousIndex], sma50[previousIndex], sma20[latestIndex], sma50[latestIndex])) {
    signals.push({
      id: 'sma-dead-cross',
      label: 'SMA20×50 デッドクロス',
      direction: 'bearish',
      weight: -2,
      detail: `SMA20がSMA50を下抜け。短期平均 ${formatPriceLike(sma20[latestIndex] as number)} / 中期平均 ${formatPriceLike(sma50[latestIndex] as number)}`,
    });
  }

  const rsi14 = rsi(closes, 14);
  const latestRsi = rsi14[latestIndex];
  if (isNumber(latestRsi) && latestRsi <= 30) {
    signals.push({
      id: 'rsi-oversold',
      label: 'RSI 30割れ',
      direction: 'bullish',
      weight: 1,
      detail: `RSI14は${latestRsi.toFixed(1)}。売られ過ぎからの反発候補。`,
    });
  } else if (isNumber(latestRsi) && latestRsi >= 70) {
    signals.push({
      id: 'rsi-overbought',
      label: 'RSI 70超え',
      direction: 'bearish',
      weight: -1,
      detail: `RSI14は${latestRsi.toFixed(1)}。買われ過ぎによる反落警戒。`,
    });
  }

  const macdResult = macd(closes, 12, 26, 9);
  if (
    crossedAbove(
      macdResult.macd[previousIndex],
      macdResult.signal[previousIndex],
      macdResult.macd[latestIndex],
      macdResult.signal[latestIndex],
    )
  ) {
    signals.push({
      id: 'macd-bullish-cross',
      label: 'MACD 強気クロス',
      direction: 'bullish',
      weight: 1,
      detail: 'MACDラインがシグナルラインを上抜け。',
    });
  } else if (
    crossedBelow(
      macdResult.macd[previousIndex],
      macdResult.signal[previousIndex],
      macdResult.macd[latestIndex],
      macdResult.signal[latestIndex],
    )
  ) {
    signals.push({
      id: 'macd-bearish-cross',
      label: 'MACD 弱気クロス',
      direction: 'bearish',
      weight: -1,
      detail: 'MACDラインがシグナルラインを下抜け。',
    });
  }

  const bands = bollingerBands(closes, 20, 2);
  const upperBand = bands.upper[latestIndex];
  const lowerBand = bands.lower[latestIndex];
  if (isNumber(upperBand) && latestClose > upperBand) {
    signals.push({
      id: 'bb-upper-break',
      label: 'ボリンジャー上限ブレイク',
      direction: 'bullish',
      weight: 1,
      detail: `終値が+2σを上抜け。終値 ${formatPriceLike(latestClose)} / 上限 ${formatPriceLike(upperBand)}`,
    });
  } else if (isNumber(lowerBand) && latestClose < lowerBand) {
    signals.push({
      id: 'bb-lower-break',
      label: 'ボリンジャー下限ブレイク',
      direction: 'bearish',
      weight: -1,
      detail: `終値が-2σを下抜け。終値 ${formatPriceLike(latestClose)} / 下限 ${formatPriceLike(lowerBand)}`,
    });
  }

  const ichimokuResult = ichimoku(highs, lows);
  const spanA = ichimokuResult.leadingSpanA[latestIndex];
  const spanB = ichimokuResult.leadingSpanB[latestIndex];
  if (isNumber(spanA) && isNumber(spanB)) {
    const cloudTop = Math.max(spanA, spanB);
    const cloudBottom = Math.min(spanA, spanB);
    if (latestClose > cloudTop) {
      signals.push({
        id: 'ichimoku-above-cloud',
        label: '一目均衡表 雲上',
        direction: 'bullish',
        weight: 1,
        detail: `現在値が雲上限 ${formatPriceLike(cloudTop)} を上回る。`,
      });
    } else if (latestClose < cloudBottom) {
      signals.push({
        id: 'ichimoku-below-cloud',
        label: '一目均衡表 雲下',
        direction: 'bearish',
        weight: -1,
        detail: `現在値が雲下限 ${formatPriceLike(cloudBottom)} を下回る。`,
      });
    }
  }

  if (bars.length >= 12) {
    const swing = findSwingLevels(bars);
    if (swing.support && swing.support.distancePct <= swing.thresholdPct) {
      signals.push({
        id: 'support-near',
        label: '直近サポート接近',
        direction: 'bullish',
        weight: 1,
        detail: `直近スイングロー ${formatPriceLike(swing.support.price)} まで ${formatPercent(swing.support.distancePct)}。`,
      });
    }
    if (swing.resistance && swing.resistance.distancePct <= swing.thresholdPct) {
      signals.push({
        id: 'resistance-near',
        label: '直近レジスタンス接近',
        direction: 'bearish',
        weight: -1,
        detail: `直近スイングハイ ${formatPriceLike(swing.resistance.price)} まで ${formatPercent(swing.resistance.distancePct)}。`,
      });
    }
  }

  const score = signals.reduce((total, signal) => total + signal.weight, 0);
  const maxAbsScore = Math.max(1, signals.reduce((total, signal) => total + Math.abs(signal.weight), 0));
  const scoreRatio = clamp(score / Math.max(4, maxAbsScore), -1, 1);

  return {
    signals,
    score,
    maxAbsScore,
    scoreRatio,
    rating: judgeSignalScore(score),
  };
};

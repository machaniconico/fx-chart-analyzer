import { sma } from './indicators';
import { calculateAtr, detectSupportResistanceLevels, findFractalSwings, type SupportResistanceLevel } from './levels';
import { evaluateMtfAlignment } from './mtf';
import { detectPatterns, type DetectedPattern } from './patterns';
import { predict, type PredictionHorizon } from './predict';
import { analyzeSignals, signalDirectionFromScore } from './signals';
import { adaptiveModelIds, weightsForHorizon, type AdaptiveStats } from './adaptive';
import type { Bar, Pair, Timeframe } from '../types';

export type RecommendationStyle = 'daytrade' | 'swing';
export type RecommendationStyleLabel = 'デイトレ' | 'スイング';
export type RecommendationDirection = '買い' | '売り';
export type RecommendationExpectationTier = 'high' | 'medium' | 'low';

export interface RecommendationExpectation {
  tier: RecommendationExpectationTier;
  label: '高' | '中' | '低';
  detail: string;
}

export interface RecommendationExpectationInput {
  score: number;
  calibratedDirectionalProbability?: number | null;
  walkForwardAccuracy?: number | null;
  environmentAligned: boolean;
}

export interface RecommendationStyleDefinition {
  label: RecommendationStyleLabel;
  executionTimeframe: Timeframe;
  environmentTimeframe: Timeframe;
  predictionHorizon: PredictionHorizon;
}

export const recommendationStyles: Record<RecommendationStyle, RecommendationStyleDefinition> = {
  daytrade: {
    label: 'デイトレ',
    executionTimeframe: 'm30',
    environmentTimeframe: 'h4',
    predictionHorizon: 5,
  },
  swing: {
    label: 'スイング',
    executionTimeframe: 'h4',
    environmentTimeframe: 'd1',
    predictionHorizon: 20,
  },
};

export interface RecommendationEntry {
  type: 'market' | 'pullback';
  price: number;
  zone?: {
    low: number;
    high: number;
  };
}

export interface PairRecommendation {
  pair: Pair;
  style: RecommendationStyleLabel;
  direction: RecommendationDirection;
  score: number;
  expectation: RecommendationExpectation;
  entry: RecommendationEntry;
  slPips: number;
  tpPips: number;
  slPrice: number;
  tpPrice: number;
  riskReward: number;
  reasons: string[];
  dataUpdatedAt: string;
}

export interface ScanPairInput {
  pair: Pair;
  style: RecommendationStyle;
  executionBars: readonly Bar[];
  environmentBars: readonly Bar[];
  adaptiveStats?: AdaptiveStats | null;
  executionUpdatedAt?: string;
  environmentUpdatedAt?: string;
  scoreThreshold?: number;
}

interface LevelAnchor {
  price: number;
  label: string;
}

const scoreThresholdDefault = 48;
const minRiskReward = 1.2;
const expectationScoreHighThreshold = 70;
const expectationScoreMediumThreshold = 58;
const expectationProbabilityHighThreshold = 0.57;
const expectationProbabilityMediumThreshold = 0.54;
const expectationWalkForwardHighFloor = 0.52;
const expectationWalkForwardMediumThreshold = 0.51;

export const recommendationScoreThreshold = scoreThresholdDefault;

const expectationDetails: Record<RecommendationExpectationTier, RecommendationExpectation> = {
  high: {
    tier: 'high',
    label: '高',
    detail: '比較的条件が揃っていますが、損切りの徹底が前提です',
  },
  medium: {
    tier: 'medium',
    label: '中',
    detail: '一定の優位性はありますが過信は禁物です',
  },
  low: {
    tier: 'low',
    label: '低',
    detail: '統計的な優位性は弱めです。見送りも有効な選択です',
  },
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const calculateExpectation = ({
  score,
  calibratedDirectionalProbability = null,
  walkForwardAccuracy = null,
  environmentAligned,
}: RecommendationExpectationInput): RecommendationExpectation => {
  const absoluteScore = clamp(Math.abs(score), 0, 100);
  const probability = isFiniteNumber(calibratedDirectionalProbability)
    ? clamp(calibratedDirectionalProbability, 0, 1)
    : null;
  const walkForward = isFiniteNumber(walkForwardAccuracy)
    ? clamp(walkForwardAccuracy, 0, 1)
    : null;

  const scoreIsStrong = absoluteScore >= expectationScoreHighThreshold;
  const probabilityIsStrong = probability !== null && probability >= expectationProbabilityHighThreshold;
  const walkForwardIsStrong =
    walkForward !== null && walkForward >= expectationWalkForwardHighFloor;

  if (scoreIsStrong && probabilityIsStrong && environmentAligned && walkForwardIsStrong) {
    return expectationDetails.high;
  }

  const scoreIsMedium = absoluteScore >= expectationScoreMediumThreshold;
  const probabilityIsMedium = probability !== null && probability >= expectationProbabilityMediumThreshold;
  const walkForwardIsMedium =
    walkForward !== null && walkForward >= expectationWalkForwardMediumThreshold;
  const mediumSignals = [
    scoreIsMedium,
    probabilityIsMedium,
    environmentAligned,
    walkForwardIsMedium,
  ].filter(Boolean).length;

  if (mediumSignals >= 2 && (scoreIsMedium || probabilityIsMedium)) {
    return expectationDetails.medium;
  }

  return expectationDetails.low;
};

const pipSize = (pair: Pair): number => (pair.endsWith('JPY') ? 0.01 : 0.0001);

const pipsFromDistance = (pair: Pair, distance: number): number =>
  Number((Math.abs(distance) / pipSize(pair)).toFixed(1));

const directionFromScore = (score: number): RecommendationDirection | null => {
  const signalDirection = signalDirectionFromScore(score);
  if (signalDirection === 'bullish') {
    return '買い';
  }
  if (signalDirection === 'bearish') {
    return '売り';
  }
  return null;
};

const directionMatchesPattern = (
  direction: RecommendationDirection,
  pattern: DetectedPattern,
): boolean =>
  (direction === '買い' && pattern.direction === 'bullish') ||
  (direction === '売り' && pattern.direction === 'bearish');

const directionOpposesPattern = (
  direction: RecommendationDirection,
  pattern: DetectedPattern,
): boolean =>
  (direction === '買い' && pattern.direction === 'bearish') ||
  (direction === '売り' && pattern.direction === 'bullish');

const newestIso = (fallbackSeconds: number, ...values: Array<string | undefined>): string => {
  const dated = values
    .map((value) => (value ? { value, time: Date.parse(value) } : null))
    .filter((item): item is { value: string; time: number } => item !== null && Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time);
  return dated[0]?.value ?? new Date(fallbackSeconds * 1000).toISOString();
};

const walkForwardAccuracyFromStats = (
  adaptiveStats: AdaptiveStats | null | undefined,
  horizon: PredictionHorizon,
): number | null => {
  const performance = adaptiveStats?.performance.horizons.find((item) => item.horizon === horizon);
  if (!performance) {
    return null;
  }

  const weights = weightsForHorizon(adaptiveStats?.weights, horizon);
  let weightedAccuracy = 0;
  let weightTotal = 0;
  for (const modelId of adaptiveModelIds) {
    const metric = performance.models[modelId];
    const accuracy = metric.ewmaAccuracy ?? metric.accuracy;
    const weight = weights[modelId];
    if (!isFiniteNumber(accuracy) || !isFiniteNumber(weight) || weight <= 0) {
      continue;
    }
    weightedAccuracy += accuracy * weight;
    weightTotal += weight;
  }

  return weightTotal > 0 ? clamp(weightedAccuracy / weightTotal, 0, 1) : null;
};

const findNearestLevelBelow = (
  levels: readonly SupportResistanceLevel[],
  price: number,
): LevelAnchor | null => {
  const level = [...levels]
    .filter((item) => item.price < price)
    .sort((a, b) => b.price - a.price || b.strength - a.strength)[0];
  return level ? { price: level.price, label: level.direction === 'support' ? '直近サポート' : '直近レベル' } : null;
};

const findNearestLevelAbove = (
  levels: readonly SupportResistanceLevel[],
  price: number,
): LevelAnchor | null => {
  const level = [...levels]
    .filter((item) => item.price > price)
    .sort((a, b) => a.price - b.price || b.strength - a.strength)[0];
  return level ? { price: level.price, label: level.direction === 'resistance' ? '直近レジスタンス' : '直近レベル' } : null;
};

const fallbackSwingBelow = (bars: readonly Bar[], price: number): LevelAnchor | null => {
  const swing = [...findFractalSwings(bars, { lookback: 160, pivotStrength: 2 })]
    .reverse()
    .find((point) => point.kind === 'low' && point.price < price);
  return swing ? { price: swing.price, label: '直近スイングロー' } : null;
};

const fallbackSwingAbove = (bars: readonly Bar[], price: number): LevelAnchor | null => {
  const swing = [...findFractalSwings(bars, { lookback: 160, pivotStrength: 2 })]
    .reverse()
    .find((point) => point.kind === 'high' && point.price > price);
  return swing ? { price: swing.price, label: '直近スイングハイ' } : null;
};

const supportBelow = (
  bars: readonly Bar[],
  levels: readonly SupportResistanceLevel[],
  price: number,
): LevelAnchor | null =>
  findNearestLevelBelow(levels, price) ?? fallbackSwingBelow(bars, price);

const resistanceAbove = (
  bars: readonly Bar[],
  levels: readonly SupportResistanceLevel[],
  price: number,
): LevelAnchor | null =>
  findNearestLevelAbove(levels, price) ?? fallbackSwingAbove(bars, price);

const latestSma20 = (bars: readonly Bar[]): number | null => {
  const closes = bars.map((bar) => bar.c);
  return sma(closes, 20)[bars.length - 1] ?? null;
};

const buildEntry = (
  direction: RecommendationDirection,
  bars: readonly Bar[],
  levels: readonly SupportResistanceLevel[],
  atr: number,
  strongSignal: boolean,
): { entry: RecommendationEntry; reason: string } => {
  const latest = bars[bars.length - 1];
  const close = latest.c;
  const sma20 = latestSma20(bars);
  const divergenceAtr = isFiniteNumber(sma20) ? Math.abs(close - sma20) / Math.max(atr, 0.0000001) : 0;
  const currentSignalIsActionable = strongSignal && divergenceAtr <= 1.1;

  if (currentSignalIsActionable) {
    return {
      entry: { type: 'market', price: close },
      reason: '実行足シグナルが現在点灯中で、SMA20からの乖離も許容範囲です。',
    };
  }

  const level =
    direction === '買い'
      ? supportBelow(bars, levels, close)
      : resistanceAbove(bars, levels, close);
  const rawPullback = isFiniteNumber(sma20)
    ? sma20
    : level?.price ?? close;
  const pullbackPrice =
    direction === '買い'
      ? Math.min(close, rawPullback)
      : Math.max(close, rawPullback);
  const zoneBuffer = Math.max(atr * 0.25, Math.abs(close) * 0.00008, 0.00001);

  return {
    entry: {
      type: 'pullback',
      price: pullbackPrice,
      zone: {
        low: pullbackPrice - zoneBuffer,
        high: pullbackPrice + zoneBuffer,
      },
    },
    reason: isFiniteNumber(sma20)
      ? '点灯が弱い、またはSMA20からの乖離が大きいため、SMA20付近までの押し目/戻りを待つ想定です。'
      : '点灯が弱いため、直近レベル付近への押し目/戻りを待つ想定です。',
  };
};

const buildStops = (
  pair: Pair,
  direction: RecommendationDirection,
  bars: readonly Bar[],
  levels: readonly SupportResistanceLevel[],
  entryPrice: number,
  atr: number,
): {
  slPips: number;
  tpPips: number;
  slPrice: number;
  tpPrice: number;
  riskReward: number;
  slReason: string;
  tpReason: string;
} | null => {
  const protectiveLevel =
    direction === '買い'
      ? supportBelow(bars, levels, entryPrice)
      : resistanceAbove(bars, levels, entryPrice);
  const targetLevel =
    direction === '買い'
      ? resistanceAbove(bars, levels, entryPrice)
      : supportBelow(bars, levels, entryPrice);

  const protectiveDistance = protectiveLevel
    ? Math.max(
        direction === '買い'
          ? entryPrice - protectiveLevel.price
          : protectiveLevel.price - entryPrice,
        0,
      ) + atr * 0.3
    : 0;
  const slDistance = Math.max(atr * 1.5, protectiveDistance);

  const targetDistance = targetLevel
    ? Math.max(
        direction === '買い'
          ? targetLevel.price - entryPrice
          : entryPrice - targetLevel.price,
        0,
      )
    : atr * 3;
  const tpDistance = Math.min(targetDistance, atr * 3);

  if (slDistance <= 0 || tpDistance <= 0) {
    return null;
  }

  const riskReward = tpDistance / slDistance;
  if (riskReward < minRiskReward) {
    return null;
  }

  const slPrice = direction === '買い' ? entryPrice - slDistance : entryPrice + slDistance;
  const tpPrice = direction === '買い' ? entryPrice + tpDistance : entryPrice - tpDistance;

  return {
    slPips: pipsFromDistance(pair, slDistance),
    tpPips: pipsFromDistance(pair, tpDistance),
    slPrice,
    tpPrice,
    riskReward: Number(riskReward.toFixed(2)),
    slReason: protectiveLevel
      ? `SLは1.5×ATRと${protectiveLevel.label}外側+0.3×ATRを比較して遠い方を採用。`
      : 'SLは直近レベル未検出のため1.5×ATRを採用。',
    tpReason: targetLevel
      ? `TPは次の${targetLevel.label}までを基準に、3×ATRを上限に設定。`
      : 'TPは次の反対レベル未検出のため3×ATRを上限目安に設定。',
  };
};

export const scanPair = ({
  pair,
  style,
  executionBars,
  environmentBars,
  adaptiveStats = null,
  executionUpdatedAt,
  environmentUpdatedAt,
  scoreThreshold = scoreThresholdDefault,
}: ScanPairInput): PairRecommendation | null => {
  const styleDefinition = recommendationStyles[style];
  const latest = executionBars[executionBars.length - 1];
  if (!latest || environmentBars.length < 2 || executionBars.length < 50) {
    return null;
  }

  const executionAnalysis = analyzeSignals(executionBars);
  const direction = directionFromScore(executionAnalysis.score);
  if (!direction) {
    return null;
  }

  const environmentAnalysis = analyzeSignals(environmentBars);
  const mtf = evaluateMtfAlignment({
    mainTimeframe: styleDefinition.executionTimeframe,
    secondaryTimeframe: styleDefinition.environmentTimeframe,
    mainScore: executionAnalysis.score,
    secondaryScore: environmentAnalysis.score,
  });

  const scoreParts: number[] = [
    Math.abs(executionAnalysis.scoreRatio) * 56,
  ];
  const reasons: string[] = [
    `実行足${styleDefinition.executionTimeframe.toUpperCase()}のシグナルは「${executionAnalysis.rating.label}」(スコア ${executionAnalysis.score})。`,
    mtf.summary,
  ];
  let calibratedDirectionalProbability: number | null = null;
  const walkForwardAccuracy = walkForwardAccuracyFromStats(adaptiveStats, styleDefinition.predictionHorizon);

  if (mtf.status === 'aligned') {
    scoreParts.push(22);
  } else if (mtf.status === 'neutral') {
    scoreParts.push(6);
  } else {
    scoreParts.push(-18);
  }

  const latestIndex = executionBars.length - 1;
  const recentPatterns = detectPatterns(executionBars, { lookback: 120 })
    .filter((pattern) => latestIndex - pattern.barIndex <= 5 && pattern.direction !== 'neutral');
  const matchingPattern = recentPatterns.find((pattern) => directionMatchesPattern(direction, pattern));
  const opposingPattern = recentPatterns.find((pattern) => directionOpposesPattern(direction, pattern));
  if (matchingPattern) {
    scoreParts.push(matchingPattern.strength * 5);
    reasons.push(`直近パターン「${matchingPattern.label}」が${direction}方向を補強。`);
  } else if (opposingPattern) {
    scoreParts.push(-8);
    reasons.push(`直近パターン「${opposingPattern.label}」は逆方向のため減点。`);
  }

  if (adaptiveStats) {
    const prediction = predict(executionBars, { includeWalkForward: false, adaptiveStats });
    const horizonPrediction = prediction.horizons.find((item) => item.horizon === styleDefinition.predictionHorizon);
    if (horizonPrediction) {
      const directionalProbability =
        direction === '買い' ? horizonPrediction.probabilityUp : 1 - horizonPrediction.probabilityUp;
      if (horizonPrediction.calibrationApplied) {
        calibratedDirectionalProbability = directionalProbability;
      }
      const predictionScore = clamp((directionalProbability - 0.5) * 2, -1, 1) * 16;
      scoreParts.push(predictionScore);
      reasons.push(
        `適応学習予測は${styleDefinition.predictionHorizon}本先の${direction}方向確率 ${(directionalProbability * 100).toFixed(1)}%。`,
      );
    }
  }

  const score = Number(clamp(scoreParts.reduce((total, value) => total + value, 0), 0, 100).toFixed(1));
  if (score < scoreThreshold) {
    return null;
  }
  const expectation = calculateExpectation({
    score,
    calibratedDirectionalProbability,
    walkForwardAccuracy,
    environmentAligned: mtf.status === 'aligned',
  });

  const atr = calculateAtr(executionBars, 14);
  if (!atr) {
    return null;
  }

  const levels = detectSupportResistanceLevels(executionBars, {
    lookback: 240,
    maxLevels: 12,
    toleranceAtrMultiplier: 0.65,
  });
  const { entry, reason: entryReason } = buildEntry(
    direction,
    executionBars,
    levels,
    atr,
    Math.abs(executionAnalysis.score) >= 3 && mtf.status !== 'diverged',
  );
  const stops = buildStops(pair, direction, executionBars, levels, entry.price, atr);
  if (!stops) {
    return null;
  }

  return {
    pair,
    style: styleDefinition.label,
    direction,
    score,
    expectation,
    entry,
    slPips: stops.slPips,
    tpPips: stops.tpPips,
    slPrice: stops.slPrice,
    tpPrice: stops.tpPrice,
    riskReward: stops.riskReward,
    reasons: [
      ...reasons,
      entryReason,
      stops.slReason,
      stops.tpReason,
    ].slice(0, 7),
    dataUpdatedAt: newestIso(latest.t, executionUpdatedAt, environmentUpdatedAt),
  };
};

export const scanRecommendations = (
  items: readonly ScanPairInput[],
): PairRecommendation[] =>
  items
    .map((item) => scanPair(item))
    .filter((item): item is PairRecommendation => item !== null)
    .sort((a, b) => b.score - a.score || a.pair.localeCompare(b.pair));

import type { Bar } from '../types';

export type AdaptiveModelId = 'signal' | 'drift' | 'regime';
export type ModelWeights = Record<AdaptiveModelId, number>;

export interface ModelPerformanceMetric {
  hits: number;
  total: number;
  accuracy: number | null;
  decayedHits: number;
  decayedTotal: number;
  ewmaAccuracy: number | null;
}

export interface HorizonModelPerformance {
  horizon: number;
  models: Record<AdaptiveModelId, ModelPerformanceMetric>;
}

export interface ModelPerformance {
  halfLifeSamples: number;
  horizons: HorizonModelPerformance[];
}

export interface HorizonAdaptiveWeights {
  horizon: number;
  sampleCount: number;
  fallback: boolean;
  weights: ModelWeights;
}

export interface AdaptiveWeightsResult {
  temperature: number;
  minSamples: number;
  horizons: HorizonAdaptiveWeights[];
}

export interface CalibrationBin {
  index: number;
  lower: number;
  upper: number;
  midpoint: number;
  count: number;
  positives: number;
  averagePrediction: number;
  observedFrequency: number;
  calibratedProbability: number;
}

export interface CalibrationTable {
  binCount: number;
  alpha: number;
  sampleCount: number;
  bins: CalibrationBin[];
}

export interface HorizonCalibration {
  horizon: number;
  table: CalibrationTable;
}

export interface AdaptiveStats {
  version: number;
  generatedAt: string;
  sampleCount: number;
  horizons: number[];
  performance: ModelPerformance;
  weights: AdaptiveWeightsResult;
  calibration: {
    horizons: HorizonCalibration[];
  };
}

export interface AdaptiveOptions {
  regressionLookback?: number;
  volatilityLookback?: number;
  halfLifeSamples?: number;
  minSamples?: number;
  temperature?: number;
  binCount?: number;
  alpha?: number;
  signalScore?: number;
}

export interface ModelStats {
  volatility: number;
  driftPerBar: number;
  autocorrelation: number;
  regimeReturnPerBar: number;
  signalScore: number;
  signalBias: number;
}

export const adaptiveModelIds: AdaptiveModelId[];
export const defaultModelWeights: ModelWeights;
export const defaultPredictionHorizons: number[];
export const scoreSignalsForBars: (bars: readonly Bar[]) => number;
export const modelStatsForBars: (
  bars: readonly Bar[],
  options?: AdaptiveOptions,
) => ModelStats;
export const modelProbabilitiesForBars: (
  bars: readonly Bar[],
  horizon: number,
  options?: AdaptiveOptions,
) => Record<AdaptiveModelId, number>;
export const weightedProbability: (
  modelProbabilities: Record<AdaptiveModelId, number>,
  weights?: ModelWeights,
) => number;
export const computeModelPerformance: (
  bars: readonly Bar[],
  horizons?: readonly number[],
  options?: AdaptiveOptions,
) => ModelPerformance;
export const adaptiveWeights: (
  performance: ModelPerformance,
  options?: AdaptiveOptions,
) => AdaptiveWeightsResult;
export const buildCalibration: (
  predictions: readonly number[],
  outcomes: readonly boolean[],
  options?: AdaptiveOptions,
) => CalibrationTable;
export const applyCalibration: (probability: number, table?: CalibrationTable | null) => number;
export const weightsForHorizon: (
  weightsResult: AdaptiveWeightsResult | null | undefined,
  horizon: number,
) => ModelWeights;
export const calibrationForHorizon: (
  stats: AdaptiveStats | null | undefined,
  horizon: number,
) => CalibrationTable | null;
export const collectCalibrationSamples: (
  bars: readonly Bar[],
  horizons: readonly number[],
  weightsResult: AdaptiveWeightsResult,
  options?: AdaptiveOptions,
) => Record<number, { predictions: number[]; outcomes: boolean[] }>;
export const buildAdaptiveStats: (
  bars: readonly Bar[],
  horizons?: readonly number[],
  options?: AdaptiveOptions,
) => AdaptiveStats;

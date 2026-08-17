import type { BacktestTrade, EquityPoint } from './backtest';
import type { ForwardOperationStatusResult } from './forwardRetirement';
import { PAIRS, TIMEFRAMES, type Pair, type Timeframe } from '../types';

export interface ForwardStrategyMeta {
  id: string;
  name: string;
  version: 1;
  pair: Pair;
  timeframe: Timeframe;
  registeredAt: number;
}

export interface ForwardMetrics {
  spreadPips: number | null;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownPips: number | null;
  maxDrawdownYen: number | null;
  maxDrawdownPct: number | null;
  tradeCount: number;
  netPips: number | null;
  netProfitYen: number | null;
  grossProfitPips: number | null;
  grossLossPips: number | null;
  grossProfitYen: number | null;
  grossLossYen: number | null;
  riskRewardRatio: number | null;
  averageWinYen: number | null;
  averageLossYen: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
}

export interface ForwardStrategyResult {
  meta: ForwardStrategyMeta;
  operationStatus?: ForwardOperationStatusResult;
  forward: {
    metrics: ForwardMetrics;
    trades: BacktestTrade[];
    equityCurve: EquityPoint[];
  };
  backtestReference: ForwardMetrics;
  barsEvaluated: number;
}

export interface ForwardResultsFile {
  schemaVersion: number;
  computedAt: string;
  strategies: ForwardStrategyResult[];
}

export interface RetiredForwardStrategy {
  strategyId: string;
  meta: ForwardStrategyMeta;
  retiredAt: string;
  reason: string;
  finalSnapshot: {
    tradeCount: number;
    profitFactor: number | null;
    cumulativeProfitYen: number;
    operationPeriod: {
      registeredAt: number;
      firstConfirmedDate: string | null;
      confirmedThrough: string | null;
      confirmedDayCount: number;
    };
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

export const isRetiredForwardStrategy = (value: unknown): value is RetiredForwardStrategy => {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.finalSnapshot)) {
    return false;
  }

  const { meta, finalSnapshot } = value;
  if (!isRecord(finalSnapshot.operationPeriod)) {
    return false;
  }
  const { operationPeriod } = finalSnapshot;

  return typeof value.strategyId === 'string'
    && typeof value.retiredAt === 'string'
    && Number.isFinite(Date.parse(value.retiredAt))
    && typeof value.reason === 'string'
    && typeof meta.id === 'string'
    && meta.id === value.strategyId
    && typeof meta.name === 'string'
    && meta.version === 1
    && PAIRS.some((pair) => pair === meta.pair)
    && TIMEFRAMES.some((timeframe) => timeframe === meta.timeframe)
    && typeof meta.registeredAt === 'number'
    && Number.isInteger(meta.registeredAt)
    && typeof finalSnapshot.tradeCount === 'number'
    && Number.isInteger(finalSnapshot.tradeCount)
    && finalSnapshot.tradeCount >= 0
    && (
      finalSnapshot.profitFactor === null
      || (
        typeof finalSnapshot.profitFactor === 'number'
        && Number.isFinite(finalSnapshot.profitFactor)
      )
    )
    && typeof finalSnapshot.cumulativeProfitYen === 'number'
    && Number.isFinite(finalSnapshot.cumulativeProfitYen)
    && typeof operationPeriod.registeredAt === 'number'
    && Number.isInteger(operationPeriod.registeredAt)
    && operationPeriod.registeredAt === meta.registeredAt
    && isNullableString(operationPeriod.firstConfirmedDate)
    && isNullableString(operationPeriod.confirmedThrough)
    && typeof operationPeriod.confirmedDayCount === 'number'
    && Number.isInteger(operationPeriod.confirmedDayCount)
    && operationPeriod.confirmedDayCount >= 0;
};

const isForwardResultsFile = (value: unknown): value is ForwardResultsFile =>
  isRecord(value)
  && typeof value.schemaVersion === 'number'
  && Number.isFinite(value.schemaVersion)
  && typeof value.computedAt === 'string'
  && Array.isArray(value.strategies)
  && value.strategies.every(
    (strategy) =>
      isRecord(strategy)
      && isRecord(strategy.meta)
      && isRecord(strategy.forward),
  );

export const hasOperationStatus = (
  strategy: ForwardStrategyResult,
): strategy is ForwardStrategyResult & { operationStatus: ForwardOperationStatusResult } => {
  const operationStatus = strategy.operationStatus as Partial<ForwardOperationStatusResult>
    | null
    | undefined;
  return operationStatus !== null
    && operationStatus !== undefined
    && (
      operationStatus.status === 'active'
      || operationStatus.status === 'probation'
      || operationStatus.status === 'retire_candidate'
    )
    && typeof operationStatus.reason === 'string';
};

export const loadForwardResults = async (): Promise<ForwardResultsFile> => {
  const response = await fetch('/data/forward/results.json', { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error('フォワードテスト結果を読み込めませんでした');
  }
  const payload: unknown = await response.json();
  if (!isForwardResultsFile(payload)) {
    throw new Error('フォワードテスト結果の形式が不正です');
  }
  return payload;
};

export const loadRetiredForwardStrategies = async (): Promise<RetiredForwardStrategy[]> => {
  const response = await fetch('/data/forward/retired.json', { cache: 'no-cache' });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error('退役EAの記録を読み込めませんでした');
  }

  const payload: unknown = await response.json();
  if (
    !isRecord(payload)
    || payload.schemaVersion !== 1
    || !isRecord(payload.strategies)
  ) {
    return [];
  }

  const seenGenerations = new Set<string>();
  return Object.entries(payload.strategies).flatMap(([ledgerKey, strategy]) => {
    if (!isRetiredForwardStrategy(strategy)) {
      // 台帳スキーマの将来変更で退役セクションが無言で消えるのを検知可能にする
      console.warn('退役EAエントリを表示対象から除外しました(スキーマ不一致):', ledgerKey);
      return [];
    }
    const generationKey = `${strategy.strategyId}@${strategy.meta.registeredAt}`;
    if (ledgerKey !== strategy.strategyId && ledgerKey !== generationKey) {
      console.warn('退役EAエントリを表示対象から除外しました(キー不一致):', ledgerKey);
      return [];
    }
    // 旧キー(strategyId単独)と複合キーが同一世代で共存した場合の重複表示を防ぐ
    if (seenGenerations.has(generationKey)) {
      return [];
    }
    seenGenerations.add(generationKey);
    return [strategy];
  });
};

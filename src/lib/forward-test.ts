import type { BacktestTrade, EquityPoint } from './backtest';
import type { ForwardOperationStatusResult } from './forwardRetirement';
import type { Pair, Timeframe } from '../types';

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
  return (await response.json()) as ForwardResultsFile;
};

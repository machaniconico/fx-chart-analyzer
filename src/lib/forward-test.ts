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

export interface MonthlySummaryMetrics {
  netProfitYen: number;
  netPips: number;
  tradeCount: number;
}

export interface MonthlyStrategySummary extends MonthlySummaryMetrics {
  id: string;
  name: string;
  confirmedDays: number;
  retired: boolean;
}

export interface MonthlySummaryMonth {
  month: string;
  total: MonthlySummaryMetrics;
  strategies: MonthlyStrategySummary[];
  confirmedDays: number;
  complete: boolean;
}

export interface MonthlySummary {
  months: MonthlySummaryMonth[];
}

export interface QuarterlyStability {
  positive: number;
  total: number;
}

export interface SelectionEvidence {
  adoptedAt: string;
  reportId: string;
  reportLabel?: string;
  candidatePool: number;
  passedCount?: number;
  inSampleRank?: number;
  rankNote?: string;
  optimization: {
    netProfitYen: number;
    profitFactor: number;
    tradeCount: number;
  };
  validation: {
    netProfitYen: number;
    profitFactor: number;
  };
  quarterlyStability: QuarterlyStability | null;
  reservations: string[];
}

export interface ForwardStrategyResult {
  meta: ForwardStrategyMeta;
  operationStatus?: ForwardOperationStatusResult;
  selectionEvidence?: SelectionEvidence;
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
  monthlySummary?: MonthlySummary;
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

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isDateOnly = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

const isMonthKey = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 12;
};

const parseMonthlyMetrics = (value: unknown): MonthlySummaryMetrics | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    !isFiniteNumber(value.netProfitYen)
    || !isFiniteNumber(value.netPips)
    || !isNonNegativeInteger(value.tradeCount)
  ) {
    return undefined;
  }
  return {
    netProfitYen: value.netProfitYen,
    netPips: value.netPips,
    tradeCount: value.tradeCount,
  };
};

/** Parse the optional monthly section without making the whole results file unusable. */
export const parseMonthlySummary = (value: unknown): MonthlySummary | undefined => {
  if (!isRecord(value) || !Array.isArray(value.months)) {
    return undefined;
  }

  const months: MonthlySummaryMonth[] = [];
  const seenMonths = new Set<string>();
  for (const monthValue of value.months) {
    if (!isRecord(monthValue) || !isMonthKey(monthValue.month)) {
      return undefined;
    }
    if (seenMonths.has(monthValue.month)) {
      return undefined;
    }
    seenMonths.add(monthValue.month);

    const total = parseMonthlyMetrics(monthValue.total);
    if (
      total === undefined
      || !Array.isArray(monthValue.strategies)
      || !isNonNegativeInteger(monthValue.confirmedDays)
      || typeof monthValue.complete !== 'boolean'
    ) {
      return undefined;
    }

    const strategies: MonthlyStrategySummary[] = [];
    const seenStrategies = new Set<string>();
    for (const strategyValue of monthValue.strategies) {
      if (
        !isRecord(strategyValue)
        || !isNonEmptyString(strategyValue.id)
        || !isNonEmptyString(strategyValue.name)
        || !isNonNegativeInteger(strategyValue.confirmedDays)
        || typeof strategyValue.retired !== 'boolean'
      ) {
        return undefined;
      }
      if (seenStrategies.has(strategyValue.id)) {
        return undefined;
      }
      seenStrategies.add(strategyValue.id);
      const metrics = parseMonthlyMetrics(strategyValue);
      if (metrics === undefined) {
        return undefined;
      }
      strategies.push({
        id: strategyValue.id,
        name: strategyValue.name,
        ...metrics,
        confirmedDays: strategyValue.confirmedDays,
        retired: strategyValue.retired,
      });
    }

    months.push({
      month: monthValue.month,
      total,
      strategies,
      confirmedDays: monthValue.confirmedDays,
      complete: monthValue.complete,
    });
  }

  return { months };
};

export const formatQuarterlyStability = (quarterlyStability: QuarterlyStability | null): string => {
  if (quarterlyStability === null) {
    return '未検査';
  }
  const { positive, total } = quarterlyStability;
  if (positive === total) {
    return `${positive}/${total}全四半期プラス`;
  }
  return `${positive}/${total}四半期プラス(${total - positive}四半期マイナス)`;
};

const rankNumberFormatter = new Intl.NumberFormat('ja-JP');

// 順位の分母は「合格件数」(ランキングは合格候補内で付く)。passedCount がある場合は
// 「96候補中2位」と誤読されない語順で分母を明示する。
export const selectionRankLabel = (evidence: {
  candidatePool: number;
  passedCount?: number;
  inSampleRank?: number;
}): string => {
  const pool = `${rankNumberFormatter.format(evidence.candidatePool)}候補`;
  if (evidence.passedCount === undefined) {
    return evidence.inSampleRank === undefined
      ? pool
      : `${pool}中 in-sample ${rankNumberFormatter.format(evidence.inSampleRank)}位`;
  }
  const passed = `合格${rankNumberFormatter.format(evidence.passedCount)}件`;
  return evidence.inSampleRank === undefined
    ? `${pool}(${passed})`
    : `${pool}中の${passed}で in-sample ${rankNumberFormatter.format(evidence.inSampleRank)}位`;
};

// selectionEvidence のフィールドを追加・変更するときは、scripts/run-forward-test.mjs の検証と
// scripts/run-forward-test.test.mjs / src/lib/forward-test.test.ts の両テストも同時に更新する。
export const parseSelectionEvidence = (value: unknown): SelectionEvidence | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const adoptedAt = value.adoptedAt;
  const reportId = value.reportId;
  const candidatePool = value.candidatePool;
  if (!isDateOnly(adoptedAt) || !isNonEmptyString(reportId) || !isPositiveInteger(candidatePool)) {
    return undefined;
  }
  let passedCount: number | undefined;
  if (hasOwn(value, 'passedCount')) {
    if (!isNonNegativeInteger(value.passedCount) || value.passedCount > candidatePool) {
      return undefined;
    }
    passedCount = value.passedCount;
  }
  let reportLabel: string | undefined;
  if (hasOwn(value, 'reportLabel')) {
    if (!isNonEmptyString(value.reportLabel)) {
      return undefined;
    }
    reportLabel = value.reportLabel;
  }

  const hasInSampleRank = hasOwn(value, 'inSampleRank');
  const hasRankNote = hasOwn(value, 'rankNote');
  if (!hasInSampleRank && !hasRankNote) {
    return undefined;
  }

  let inSampleRank: number | undefined;
  if (hasInSampleRank) {
    if (!isPositiveInteger(value.inSampleRank)) {
      return undefined;
    }
    inSampleRank = value.inSampleRank;
  }

  let rankNote: string | undefined;
  if (hasRankNote) {
    if (!isNonEmptyString(value.rankNote)) {
      return undefined;
    }
    rankNote = value.rankNote;
  }

  const optimization = value.optimization;
  if (
    !isRecord(optimization)
    || !isFiniteNumber(optimization.netProfitYen)
    || !isFiniteNumber(optimization.profitFactor)
    || !isNonNegativeInteger(optimization.tradeCount)
  ) {
    return undefined;
  }

  const validation = value.validation;
  if (
    !isRecord(validation)
    || !isFiniteNumber(validation.netProfitYen)
    || !isFiniteNumber(validation.profitFactor)
  ) {
    return undefined;
  }

  if (!hasOwn(value, 'quarterlyStability')) {
    return undefined;
  }
  let quarterlyStability: SelectionEvidence['quarterlyStability'];
  if (value.quarterlyStability === null) {
    quarterlyStability = null;
  } else {
    const stability = value.quarterlyStability;
    if (
      !isRecord(stability)
      || !isNonNegativeInteger(stability.positive)
      || !isPositiveInteger(stability.total)
      || stability.positive > stability.total
    ) {
      return undefined;
    }
    quarterlyStability = {
      positive: stability.positive,
      total: stability.total,
    };
  }

  const reservations = value.reservations;
  if (!Array.isArray(reservations) || !reservations.every((item) => typeof item === 'string')) {
    return undefined;
  }

  const selectionEvidence: SelectionEvidence = {
    adoptedAt,
    reportId,
    candidatePool,
    optimization: {
      netProfitYen: optimization.netProfitYen,
      profitFactor: optimization.profitFactor,
      tradeCount: optimization.tradeCount,
    },
    validation: {
      netProfitYen: validation.netProfitYen,
      profitFactor: validation.profitFactor,
    },
    quarterlyStability,
    reservations,
  };
  if (passedCount !== undefined) {
    selectionEvidence.passedCount = passedCount;
  }
  if (reportLabel !== undefined) {
    selectionEvidence.reportLabel = reportLabel;
  }
  if (inSampleRank !== undefined) {
    selectionEvidence.inSampleRank = inSampleRank;
  }
  if (rankNote !== undefined) {
    selectionEvidence.rankNote = rankNote;
  }
  return selectionEvidence;
};

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

const normalizeForwardResults = (payload: ForwardResultsFile): ForwardResultsFile => {
  const monthlySummary = parseMonthlySummary(payload.monthlySummary);
  const { monthlySummary: _ignoredMonthlySummary, ...payloadWithoutMonthlySummary } = payload;
  return {
    ...payloadWithoutMonthlySummary,
    ...(monthlySummary === undefined ? {} : { monthlySummary }),
    strategies: payload.strategies.map((strategy) => {
      const selectionEvidence = parseSelectionEvidence(strategy.selectionEvidence);
      if (selectionEvidence === undefined) {
        if (!hasOwn(strategy, 'selectionEvidence')) {
          return strategy;
        }
        const { selectionEvidence: _ignored, ...legacyStrategy } = strategy;
        return legacyStrategy;
      }
      return { ...strategy, selectionEvidence };
    }),
  };
};

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
  return normalizeForwardResults(payload);
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

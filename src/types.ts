export type Pair = 'USDJPY' | 'EURUSD' | 'GBPJPY' | 'EURJPY' | 'AUDJPY' | 'GBPUSD';
export type Timeframe = 'm15' | 'm30' | 'h1' | 'h4' | 'd1';

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface DataFile {
  pair: Pair;
  tf: Timeframe;
  updatedAt: string;
  source?: 'dukascopy' | 'yahoo-fallback';
  bars: Bar[];
}

export const PAIRS: Pair[] = ['USDJPY', 'EURUSD', 'GBPJPY', 'EURJPY', 'AUDJPY', 'GBPUSD'];
export const TIMEFRAMES: Timeframe[] = ['m15', 'm30', 'h1', 'h4', 'd1'];

export const timeframeLabels: Record<Timeframe, string> = {
  m15: '15分',
  m30: '30分',
  h1: '1時間',
  h4: '4時間',
  d1: '日足',
};

export type DataSource = NonNullable<DataFile['source']>;

/**
 * データ鮮度の許容上限(時間)。
 * CI の scripts/check-data-freshness.mjs の FRESHNESS_LIMIT_HOURS と必ず同値に保つこと。
 */
export const FRESHNESS_LIMIT_HOURS = 96;

export interface FreshnessStatus {
  /** 最新バーからの経過時間(時間)。データが無い場合は 0。 */
  ageHours: number;
  /** 経過時間(日)。 */
  ageDays: number;
  /** 許容上限を超えているか。データが無い場合は false。 */
  isStale: boolean;
}

/**
 * 最新バー時刻(秒)と現在時刻(秒)から鮮度を評価する。
 * latestBarTimeSec が null / 非数のときは警告を出さない(isStale=false)。
 */
export const evaluateFreshness = (
  latestBarTimeSec: number | null,
  nowSec: number,
  limitHours: number = FRESHNESS_LIMIT_HOURS,
): FreshnessStatus => {
  if (latestBarTimeSec === null || !Number.isFinite(latestBarTimeSec)) {
    return { ageHours: 0, ageDays: 0, isStale: false };
  }
  const ageHours = Math.max(0, (nowSec - latestBarTimeSec) / 3600);
  return {
    ageHours,
    ageDays: ageHours / 24,
    isStale: ageHours > limitHours,
  };
};

/** 鮮度超過時の警告メッセージ。App のバナーと RecommendationPanel で共通利用する。 */
export const stalenessWarningMessage = (ageDays: number): string =>
  `⚠ データが約${Math.max(1, Math.round(ageDays))}日間更新されていません。表示中の価格・分析は最新の相場を反映していません`;

/** データ源の表示名。source 未指定(旧データ)は一次ソース扱いにする。 */
export const dataSourceLabel = (source: DataFile['source']): string =>
  source === 'yahoo-fallback' ? 'Yahoo(代替)' : 'Dukascopy';

/** フォールバック(代替)ソースか。 */
export const isFallbackSource = (source: DataFile['source']): boolean =>
  source === 'yahoo-fallback';

/** 渡したソースのいずれかがフォールバックか。 */
export const anyFallbackSource = (sources: ReadonlyArray<DataFile['source']>): boolean =>
  sources.some(isFallbackSource);

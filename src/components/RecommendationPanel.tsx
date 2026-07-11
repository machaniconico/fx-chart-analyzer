import { useEffect, useMemo, useState } from 'react';
import { formatPrice, lastBar, loadAdaptiveStats, loadBars, loadScannerStats, type AdaptiveStatsFile } from '../lib/chart-data';
import {
  recommendationStyles,
  scannerMinimumSampleSize,
  scanRecommendations,
  type PairRecommendation,
  type ScannerMonthlySimulation,
  type ScannerStats,
  type RecommendationStyle,
} from '../lib/recommend';
import {
  PAIRS,
  anyFallbackSource,
  evaluateFreshness,
  stalenessWarningMessage,
  type DataFile,
  type Pair,
} from '../types';

interface PairScannerData {
  pair: Pair;
  m30: DataFile;
  h4: DataFile;
  d1: DataFile;
  m30Stats: AdaptiveStatsFile | null;
  h4Stats: AdaptiveStatsFile | null;
}

interface RecommendationSectionData {
  style: RecommendationStyle;
  updatedAt: string | null;
  recommendations: PairRecommendation[];
  /** この部門の使用データに yahoo-fallback が含まれるペア。 */
  fallbackPairs: Set<Pair>;
}

type SimulationMode = 'mediumOrHigher' | 'highOnly';

const sectionOrder: RecommendationStyle[] = ['daytrade', 'swing'];
const simulationModeLabels: Record<SimulationMode, string> = {
  mediumOrHigher: '中以上',
  highOnly: '高のみ',
};

const latestUpdatedAt = (values: readonly string[]): string | null => {
  const newest = values
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time)[0];
  return newest?.value ?? null;
};

const formatJstUpdatedAt = (value: string | null | undefined): string => {
  if (!value) {
    return '未取得';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '未取得';
  }
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('month')}/${part('day')} ${part('hour')}:${part('minute')}(JST)`;
};

const loadPairScannerData = async (pair: Pair): Promise<PairScannerData> => {
  const [m30, h4, d1, m30Stats, h4Stats] = await Promise.all([
    loadBars(pair, 'm30'),
    loadBars(pair, 'h4'),
    loadBars(pair, 'd1'),
    loadAdaptiveStats(pair, 'm30').catch(() => null),
    loadAdaptiveStats(pair, 'h4').catch(() => null),
  ]);

  return {
    pair,
    m30,
    h4,
    d1,
    m30Stats,
    h4Stats,
  };
};

const buildSections = (
  items: readonly PairScannerData[],
  scannerStats: ScannerStats | null,
): RecommendationSectionData[] => {
  const daytrade = scanRecommendations(
    items.map((item) => ({
      pair: item.pair,
      style: 'daytrade',
      executionBars: item.m30.bars,
      environmentBars: item.h4.bars,
      adaptiveStats: item.m30Stats,
      scannerStats,
      executionUpdatedAt: item.m30.updatedAt,
      environmentUpdatedAt: item.h4.updatedAt,
    })),
  ).slice(0, 3);

  const swing = scanRecommendations(
    items.map((item) => ({
      pair: item.pair,
      style: 'swing',
      executionBars: item.h4.bars,
      environmentBars: item.d1.bars,
      adaptiveStats: item.h4Stats,
      scannerStats,
      executionUpdatedAt: item.h4.updatedAt,
      environmentUpdatedAt: item.d1.updatedAt,
    })),
  ).slice(0, 3);

  const daytradeFallbackPairs = new Set<Pair>(
    items
      .filter((item) => anyFallbackSource([item.m30.source, item.h4.source]))
      .map((item) => item.pair),
  );
  const swingFallbackPairs = new Set<Pair>(
    items
      .filter((item) => anyFallbackSource([item.h4.source, item.d1.source]))
      .map((item) => item.pair),
  );

  return [
    {
      style: 'daytrade',
      updatedAt: latestUpdatedAt(items.flatMap((item) => [item.m30.updatedAt, item.h4.updatedAt])),
      recommendations: daytrade,
      fallbackPairs: daytradeFallbackPairs,
    },
    {
      style: 'swing',
      updatedAt: latestUpdatedAt(items.flatMap((item) => [item.h4.updatedAt, item.d1.updatedAt])),
      recommendations: swing,
      fallbackPairs: swingFallbackPairs,
    },
  ];
};

const entryLabel = (recommendation: PairRecommendation): string => {
  if (recommendation.entry.type === 'market') {
    return `成行 ${formatPrice(recommendation.pair, recommendation.entry.price)}`;
  }
  const zone = recommendation.entry.zone;
  if (!zone) {
    return `押し目/戻り ${formatPrice(recommendation.pair, recommendation.entry.price)}`;
  }
  return `押し目/戻り ${formatPrice(recommendation.pair, zone.low)} - ${formatPrice(recommendation.pair, zone.high)}`;
};

const formatPercent = (value: number | null | undefined, digits = 0): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(digits)}%`
    : '--';

const formatYen = (value: number): string =>
  `${value >= 0 ? '+' : '-'}${Math.abs(value).toLocaleString('ja-JP')}円`;

const formatMonth = (month: string): string => {
  const [year, rawMonth] = month.split('-');
  return `${year}/${Number(rawMonth)}`;
};

function RecommendationCard({
  recommendation,
  usesFallbackSource,
}: {
  recommendation: PairRecommendation;
  usesFallbackSource: boolean;
}) {
  const directionClass = recommendation.direction === '買い' ? 'recommendation-buy' : 'recommendation-sell';
  const expectationClass = `recommendation-expectation-${recommendation.expectation.tier}`;

  return (
    <article className="recommendation-card">
      <div className="recommendation-card-heading">
        <div>
          <span className="recommendation-pair">{recommendation.pair}</span>
          <small>データ最終更新: {formatJstUpdatedAt(recommendation.dataUpdatedAt)}</small>
          {usesFallbackSource ? (
            <span className="source-badge source-badge-fallback recommendation-source-badge">
              代替データ源使用中
            </span>
          ) : null}
        </div>
        <div className={`recommendation-direction ${directionClass}`}>
          {recommendation.direction}
        </div>
      </div>

      <div className="recommendation-score-row">
        <span>総合スコア</span>
        <strong>{recommendation.score.toFixed(1)}</strong>
      </div>

      <div className="recommendation-expectation">
        <span className={`recommendation-expectation-badge ${expectationClass}`}>
          期待度 {recommendation.expectation.label}
        </span>
        <p>{recommendation.expectation.detail}</p>
        {recommendation.historicalPerformance ? (
          <p className="recommendation-history-line">
            {recommendation.historicalPerformance.recommendations < scannerMinimumSampleSize
              ? `サンプル不足(${recommendation.historicalPerformance.recommendations.toLocaleString('ja-JP')}回)`
              : `この型の過去成績: 勝率 ${formatPercent(recommendation.historicalPerformance.winRate)}(${recommendation.historicalPerformance.recommendations.toLocaleString('ja-JP')}回)`}
          </p>
        ) : null}
      </div>

      <dl className="recommendation-trade-grid">
        <div>
          <dt>エントリー目安</dt>
          <dd>{entryLabel(recommendation)}</dd>
        </div>
        <div>
          <dt>SL</dt>
          <dd>
            -{recommendation.slPips.toFixed(1)}pips @
            {formatPrice(recommendation.pair, recommendation.slPrice)}
          </dd>
        </div>
        <div>
          <dt>TP</dt>
          <dd>
            +{recommendation.tpPips.toFixed(1)}pips @
            {formatPrice(recommendation.pair, recommendation.tpPrice)}
          </dd>
        </div>
        <div>
          <dt>RR</dt>
          <dd>{recommendation.riskReward.toFixed(2)}</dd>
        </div>
      </dl>

      <ul className="recommendation-reasons">
        {recommendation.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      <p className="recommendation-mini-disclaimer">
        投資助言ではありません。当日時点のデータ分析として確認してください。
      </p>
    </article>
  );
}

function RecommendationSkeleton() {
  return (
    <div className="recommendation-skeleton-grid" aria-label="おすすめを読み込み中">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="recommendation-skeleton-card">
          <span />
          <strong />
          <i />
          <i />
          <i />
        </div>
      ))}
    </div>
  );
}

function EmptyRecommendationState() {
  return (
    <div className="recommendation-empty">
      <strong>本日は条件を満たすペアなし=見送り推奨</strong>
      <p>総合スコア、MTF一致、SL/TPのRR条件を同時に満たす候補がありません。</p>
    </div>
  );
}

function SimulationSummary({ simulation }: { simulation: ScannerMonthlySimulation }) {
  const { summary } = simulation;
  const period =
    summary.periodStartMonth && summary.periodEndMonth
      ? `${formatMonth(summary.periodStartMonth)}-${formatMonth(summary.periodEndMonth)}`
      : '--';
  return (
    <div className="recommendation-simulation-summary">
      <div>
        <span>対象期間</span>
        <strong>{period}</strong>
      </div>
      <div>
        <span>稼働月</span>
        <strong>{summary.activeMonths.toLocaleString('ja-JP')}ヶ月</strong>
      </div>
      <div>
        <span>プラス月</span>
        <strong>{formatPercent(summary.plusMonthRate)}</strong>
      </div>
      <div>
        <span>最高月</span>
        <strong>{summary.bestMonth ? `${formatMonth(summary.bestMonth.month)} ${formatYen(summary.bestMonth.pnlYen)}` : '--'}</strong>
      </div>
      <div>
        <span>最悪月</span>
        <strong>{summary.worstMonth ? `${formatMonth(summary.worstMonth.month)} ${formatYen(summary.worstMonth.pnlYen)}` : '--'}</strong>
      </div>
      <div>
        <span>月平均</span>
        <strong>{formatYen(summary.averageMonthlyPnlYen)}</strong>
      </div>
    </div>
  );
}

function ScannerSimulationSection({ scannerStats }: { scannerStats: ScannerStats | null }) {
  const [mode, setMode] = useState<SimulationMode>('mediumOrHigher');
  const simulation = scannerStats?.monthlySimulation?.[mode] ?? null;
  const rows = simulation?.months ?? [];
  const hasActiveMonths = (simulation?.summary.activeMonths ?? 0) > 0;

  return (
    <section className="recommendation-simulation-section">
      <div className="recommendation-simulation-heading">
        <div>
          <h2>この戦略に従った場合の過去成績(シミュレーション)</h2>
          <p>初期100万円、1回の固定リスク1%で月別に再計算</p>
        </div>
        <div className="recommendation-simulation-toggle" role="group" aria-label="シミュレーション条件">
          {(Object.keys(simulationModeLabels) as SimulationMode[]).map((item) => (
            <button
              key={item}
              type="button"
              className={item === mode ? 'segment segment-active' : 'segment'}
              onClick={() => setMode(item)}
            >
              {simulationModeLabels[item]}
            </button>
          ))}
        </div>
      </div>

      {!simulation ? (
        <div className="recommendation-empty">
          <strong>シミュレーション統計は未生成です</strong>
          <p>scanner.json がない場合も、今日のおすすめ判定は従来通り表示されます。</p>
        </div>
      ) : !hasActiveMonths ? (
        <div className="recommendation-empty">
          <strong>この条件では期間中に該当シグナルがありませんでした</strong>
          <p>{simulationModeLabels[mode]}の条件で約定まで到達したシグナルはありません。</p>
        </div>
      ) : (
        <>
          <SimulationSummary simulation={simulation} />
          <div className="recommendation-simulation-table-wrap">
            <table className="recommendation-simulation-table">
              <thead>
                <tr>
                  <th>月</th>
                  <th>損益円</th>
                  <th>勝敗</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.month}>
                    <td>{formatMonth(row.month)}</td>
                    <td className={row.pnlYen >= 0 ? 'profit-positive' : 'profit-negative'}>{formatYen(row.pnlYen)}</td>
                    <td>{row.wins}勝 {row.losses}敗</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="recommendation-simulation-disclaimer">
        過去データへの遡及シミュレーションであり将来の収益を保証しません。全取引は固定リスク1%、初期資金100万円、固定スプレッド考慮済み・スリッページ未考慮の前提です。
      </p>
    </section>
  );
}

function RecommendationSection({ section }: { section: RecommendationSectionData }) {
  const styleDefinition = recommendationStyles[section.style];
  const allCandidatesAreLow =
    section.recommendations.length > 0 &&
    section.recommendations.every((recommendation) => recommendation.expectation.tier === 'low');

  return (
    <section className="recommendation-section">
      <div className="recommendation-section-heading">
        <div>
          <h2>{styleDefinition.label}部門</h2>
          <p>
            実行足 {styleDefinition.executionTimeframe.toUpperCase()} / 環境足 {styleDefinition.environmentTimeframe.toUpperCase()}
          </p>
          {allCandidatesAreLow ? (
            <p className="recommendation-section-caution">
              本日は期待度の高い候補がありません。無理にエントリーしない選択も有効です
            </p>
          ) : null}
        </div>
        <span>データ最終更新: {formatJstUpdatedAt(section.updatedAt)}</span>
      </div>

      {section.recommendations.length > 0 ? (
        <div className="recommendation-card-grid">
          {section.recommendations.map((recommendation) => (
            <RecommendationCard
              key={`${recommendation.style}-${recommendation.pair}-${recommendation.direction}`}
              recommendation={recommendation}
              usesFallbackSource={section.fallbackPairs.has(recommendation.pair)}
            />
          ))}
        </div>
      ) : (
        <EmptyRecommendationState />
      )}
    </section>
  );
}

export function RecommendationPanel({ now }: { now?: number } = {}) {
  const [scannerData, setScannerData] = useState<PairScannerData[] | null>(null);
  const [scannerStats, setScannerStats] = useState<ScannerStats | null>(null);
  const [failedPairCount, setFailedPairCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setScannerData(null);
    setScannerStats(null);
    setFailedPairCount(0);

    Promise.all([
      Promise.allSettled(PAIRS.map((pair) => loadPairScannerData(pair))),
      loadScannerStats().catch(() => null),
    ])
      .then(([results, stats]) => {
        if (disposed) {
          return;
        }

        const items = results
          .filter((result): result is PromiseFulfilledResult<PairScannerData> => result.status === 'fulfilled')
          .map((result) => result.value);
        const rejectedResults = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );

        if (items.length === 0) {
          const firstReason = rejectedResults[0]?.reason;
          const message = firstReason instanceof Error ? firstReason.message : 'おすすめデータを読み込めませんでした';
          setError(`${message}。オフラインの可能性があります。`);
          return;
        }

        setScannerData(items);
        setScannerStats(stats);
        setFailedPairCount(rejectedResults.length);
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  const sections = useMemo(
    () => (scannerData ? buildSections(scannerData, scannerStats) : []),
    [scannerData, scannerStats],
  );

  const latestBarTimeSec = useMemo(() => {
    if (!scannerData) {
      return null;
    }
    let latest: number | null = null;
    for (const item of scannerData) {
      for (const file of [item.m30, item.h4, item.d1]) {
        const bar = lastBar(file.bars);
        if (bar && (latest === null || bar.t > latest)) {
          latest = bar.t;
        }
      }
    }
    return latest;
  }, [scannerData]);

  const nowSec = now ?? Math.floor(Date.now() / 1000);
  const freshness = evaluateFreshness(latestBarTimeSec, nowSec);

  return (
    <div className="recommendation-panel">
      <section className="recommendation-overview">
        <div>
          <p className="eyebrow">おすすめ通貨ペアスキャナー</p>
          <h2>今日の候補をデイトレ/スイングで自動選別</h2>
        </div>
        {freshness.isStale ? (
          <p className="recommendation-overview-warning" role="alert">
            {stalenessWarningMessage(freshness.ageDays)}
          </p>
        ) : (
          <p>
            ページを開くたびに6通貨ペアのM30/H4/D1最新データを読み込み、当日時点で再計算します。投資助言ではなく、毎日更新データに基づく分析です。
          </p>
        )}
      </section>

      {loading && <RecommendationSkeleton />}
      {error && <div className="state-message state-error">{error}</div>}
      {!loading && !error && failedPairCount > 0 ? (
        <p className="recommendation-load-note">
          一部ペアの読み込みに失敗しました({failedPairCount}件)
        </p>
      ) : null}
      {!loading && !error && sectionOrder.map((style) => {
        const section = sections.find((item) => item.style === style);
        return section ? <RecommendationSection key={style} section={section} /> : null;
      })}
      {!loading && !error ? <ScannerSimulationSection scannerStats={scannerStats} /> : null}
    </div>
  );
}

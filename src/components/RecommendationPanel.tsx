import { useEffect, useMemo, useState } from 'react';
import { formatPrice, loadAdaptiveStats, loadBars, type AdaptiveStatsFile } from '../lib/chart-data';
import {
  recommendationStyles,
  scanRecommendations,
  type PairRecommendation,
  type RecommendationStyle,
} from '../lib/recommend';
import { PAIRS, type DataFile, type Pair } from '../types';

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
}

const sectionOrder: RecommendationStyle[] = ['daytrade', 'swing'];

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

const buildSections = (items: readonly PairScannerData[]): RecommendationSectionData[] => {
  const daytrade = scanRecommendations(
    items.map((item) => ({
      pair: item.pair,
      style: 'daytrade',
      executionBars: item.m30.bars,
      environmentBars: item.h4.bars,
      adaptiveStats: item.m30Stats,
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
      executionUpdatedAt: item.h4.updatedAt,
      environmentUpdatedAt: item.d1.updatedAt,
    })),
  ).slice(0, 3);

  return [
    {
      style: 'daytrade',
      updatedAt: latestUpdatedAt(items.flatMap((item) => [item.m30.updatedAt, item.h4.updatedAt])),
      recommendations: daytrade,
    },
    {
      style: 'swing',
      updatedAt: latestUpdatedAt(items.flatMap((item) => [item.h4.updatedAt, item.d1.updatedAt])),
      recommendations: swing,
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

function RecommendationCard({ recommendation }: { recommendation: PairRecommendation }) {
  const directionClass = recommendation.direction === '買い' ? 'recommendation-buy' : 'recommendation-sell';
  const expectationClass = `recommendation-expectation-${recommendation.expectation.tier}`;

  return (
    <article className="recommendation-card">
      <div className="recommendation-card-heading">
        <div>
          <span className="recommendation-pair">{recommendation.pair}</span>
          <small>データ最終更新: {formatJstUpdatedAt(recommendation.dataUpdatedAt)}</small>
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
            />
          ))}
        </div>
      ) : (
        <EmptyRecommendationState />
      )}
    </section>
  );
}

export function RecommendationPanel() {
  const [scannerData, setScannerData] = useState<PairScannerData[] | null>(null);
  const [failedPairCount, setFailedPairCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setScannerData(null);
    setFailedPairCount(0);

    Promise.allSettled(PAIRS.map((pair) => loadPairScannerData(pair)))
      .then((results) => {
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
    () => (scannerData ? buildSections(scannerData) : []),
    [scannerData],
  );

  return (
    <div className="recommendation-panel">
      <section className="recommendation-overview">
        <div>
          <p className="eyebrow">おすすめ通貨ペアスキャナー</p>
          <h2>今日の候補をデイトレ/スイングで自動選別</h2>
        </div>
        <p>
          ページを開くたびに6通貨ペアのM30/H4/D1最新データを読み込み、当日時点で再計算します。投資助言ではなく、毎日更新データに基づく分析です。
        </p>
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
    </div>
  );
}

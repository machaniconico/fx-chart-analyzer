import {
  ColorType,
  createChart,
  IChartApi,
  LineData,
  Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatPrice } from '../lib/chart-data';
import {
  loadForwardResults,
  type ForwardMetrics,
  type ForwardResultsFile,
  type ForwardStrategyResult,
} from '../lib/forward-test';
import type { BacktestTrade } from '../lib/backtest';
import {
  timeframeLabels,
  type BacktestReferenceCoverage,
  type ForwardHistoryCoverage,
} from '../types';

interface ForwardTestPanelProps {
  now: number;
}

type ForwardPerformanceWithHistory = ForwardStrategyResult['forward']
  & Partial<ForwardHistoryCoverage>;

type ForwardStrategyResultWithHistory = Omit<ForwardStrategyResult, 'forward'> & {
  forward: ForwardPerformanceWithHistory;
  backtestReferenceCoverage?: BacktestReferenceCoverage;
};

type ForwardResultsFileWithHistory = Omit<ForwardResultsFile, 'strategies'> & {
  schemaVersion?: number;
  strategies: ForwardStrategyResultWithHistory[];
};

const yenFormatter = new Intl.NumberFormat('ja-JP', {
  style: 'currency',
  currency: 'JPY',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('ja-JP');

const formatYen = (value: number | null): string =>
  value === null ? '-' : yenFormatter.format(Math.round(value));

const formatPercent = (value: number | null): string =>
  value === null ? '-' : `${value.toFixed(1)}%`;

const formatPips = (value: number | null): string =>
  value === null ? '-' : `${value.toFixed(1)} pips`;

const dateLabel = (timestamp: number): string =>
  new Date(timestamp * 1000).toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const registeredDayLabel = (registeredAt: number, now: number): string => {
  if (now < registeredAt) {
    return '登録前';
  }
  return `${Math.floor((now - registeredAt) / 86_400) + 1}日目`;
};

const statusLabel = (strategy: ForwardStrategyResultWithHistory): string => {
  if (strategy.forward.metrics.tradeCount === 0) {
    return 'シグナル待ち';
  }
  return (strategy.forward.metrics.netProfitYen ?? 0) >= 0 ? '累積プラス' : '累積マイナス';
};

const isConfirmedHistory = (
  forward: ForwardPerformanceWithHistory,
): forward is ForwardStrategyResult['forward'] & ForwardHistoryCoverage => {
  const coverage = forward as Partial<ForwardHistoryCoverage>;
  return coverage.source === 'confirmed-history'
    && (coverage.firstConfirmedDate === null || typeof coverage.firstConfirmedDate === 'string')
    && (coverage.confirmedThrough === null || typeof coverage.confirmedThrough === 'string')
    && Number.isInteger(coverage.confirmedDayCount)
    && (coverage.confirmedDayCount ?? -1) >= 0;
};

const referenceCoverageLabel = (coverage?: BacktestReferenceCoverage): string => {
  if (!coverage) {
    return '旧形式・範囲情報なし';
  }
  if (coverage.firstBarAt === null || coverage.lastBarAt === null) {
    return 'データなし';
  }
  return `${dateLabel(coverage.firstBarAt)}〜${dateLabel(coverage.lastBarAt)}`;
};

const exitReasonLabels: Record<BacktestTrade['exitReason'], string> = {
  stop_loss: 'SL',
  take_profit: 'TP',
  trailing_stop: 'トレーリング',
  opposite_signal: '反対シグナル',
  end: '最終バー',
};

const createForwardChart = (container: HTMLDivElement): IChartApi =>
  createChart(container, {
    height: 220,
    layout: {
      background: { type: ColorType.Solid, color: '#10151f' },
      textColor: '#b9c2d0',
      fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(142,155,179,0.12)' },
      horzLines: { color: 'rgba(142,155,179,0.12)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(142,155,179,0.24)',
    },
    timeScale: {
      borderColor: 'rgba(142,155,179,0.24)',
      timeVisible: true,
      secondsVisible: false,
    },
  });

function ForwardEquityCurve({ strategy }: { strategy: ForwardStrategyResultWithHistory }) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const confirmed = isConfirmedHistory(strategy.forward);
  const actualLabel = confirmed ? '確定実績' : '登録後の再計算値';
  const points = useMemo(
    () => strategy.forward.equityCurve.filter((point) => Number.isFinite(point.equityYen)),
    [strategy.forward.equityCurve],
  );

  useEffect(() => {
    if (!chartRef.current || points.length < 2) {
      return;
    }

    const chart = createForwardChart(chartRef.current);
    const resizeObserver = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (width > 0) {
        chart.applyOptions({ width });
      }
    });
    resizeObserver.observe(chartRef.current);

    const line = chart.addLineSeries({
      color: (strategy.forward.metrics.netProfitYen ?? 0) >= 0 ? '#20c997' : '#ff5b78',
      lineWidth: 2,
      title: `${actualLabel}残高`,
    });
    line.setData(
      points.map<LineData>((point) => ({
        time: point.time as Time,
        value: point.equityYen,
      })),
    );
    chart.timeScale().fitContent();

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [actualLabel, points, strategy.forward.metrics.netProfitYen]);

  if (points.length < 2) {
    return (
      <div className="forward-empty-curve">
        {confirmed ? '確定日次履歴' : '登録後データ'}が増えたら資産曲線を表示します
      </div>
    );
  }

  return (
    <div
      ref={chartRef}
      className="forward-equity-chart"
      role="img"
      aria-label={`${strategy.meta.name}の${actualLabel}累積資産曲線`}
    />
  );
}

function MetricComparison({
  label,
  forward,
  reference,
  formatter,
  actualLabel,
  emphasizeProfit = false,
}: {
  label: string;
  forward: number | null;
  reference: number | null;
  formatter: (value: number | null) => string;
  actualLabel: string;
  emphasizeProfit?: boolean;
}) {
  const profitClass =
    emphasizeProfit && forward !== null
      ? forward >= 0
        ? 'metric-up'
        : 'metric-down'
      : '';

  return (
    <div className="forward-comparison-row">
      <span>{label}</span>
      <strong className={profitClass}>{actualLabel}: {formatter(forward)}</strong>
      <small>参考BT（現行窓）: {formatter(reference)}</small>
    </div>
  );
}

function StrategyCard({ strategy, now }: { strategy: ForwardStrategyResultWithHistory; now: number }) {
  const { meta, forward, backtestReference } = strategy;
  const hasNoTrades = forward.metrics.tradeCount === 0;
  const confirmed = isConfirmedHistory(forward);
  const actualLabel = confirmed ? '確定実績' : '再計算値';
  const referenceAvailable = !strategy.backtestReferenceCoverage
    || strategy.backtestReferenceCoverage.barsEvaluated > 0;
  const tradeCountFormatter = (value: number | null): string =>
    value === null ? '-' : numberFormatter.format(value);

  return (
    <article className="forward-strategy-card">
      <header className="forward-strategy-heading">
        <div>
          <p className="eyebrow">{meta.pair} / {timeframeLabels[meta.timeframe]}</p>
          <h3>{meta.name}</h3>
        </div>
        <div className="forward-status-block">
          <span>
            {confirmed
              ? forward.confirmedThrough === null
                ? '確定待ち'
                : `${forward.confirmedThrough}まで確定`
              : registeredDayLabel(meta.registeredAt, now)}
          </span>
          <strong>{statusLabel(strategy)}</strong>
        </div>
      </header>

      <div className="forward-waiting-message">
        {confirmed ? (
          <>
            <strong>確定実績（仮想）</strong>は日次履歴から累積し、過去日を再計算で変更しません。
            参考BTは現在保持しているデータ窓で毎回再計算されます。
          </>
        ) : (
          <strong>履歴永続化前の再計算値です。確定実績としては扱いません。</strong>
        )}
      </div>

      {hasNoTrades && (
        <div className="forward-waiting-message">
          {actualLabel}の取引はありません。シグナル待ち
        </div>
      )}

      <div className="forward-comparison-grid">
        <MetricComparison
          label="トレード数"
          forward={forward.metrics.tradeCount}
          reference={referenceAvailable ? backtestReference.tradeCount : null}
          formatter={tradeCountFormatter}
          actualLabel={actualLabel}
        />
        <MetricComparison
          label="勝率"
          forward={forward.metrics.winRate}
          reference={referenceAvailable ? backtestReference.winRate : null}
          formatter={formatPercent}
          actualLabel={actualLabel}
        />
        <MetricComparison
          label="純損益"
          forward={forward.metrics.netProfitYen}
          reference={referenceAvailable ? backtestReference.netProfitYen : null}
          formatter={formatYen}
          actualLabel={actualLabel}
          emphasizeProfit
        />
        <MetricComparison
          label="最大DD"
          forward={forward.metrics.maxDrawdownYen}
          reference={referenceAvailable ? backtestReference.maxDrawdownYen : null}
          formatter={formatYen}
          actualLabel={actualLabel}
        />
      </div>

      <dl className="forward-detail-grid">
        <div>
          <dt>{confirmed ? '確定期間' : '再計算期間'}</dt>
          <dd>
            {confirmed && forward.firstConfirmedDate && forward.confirmedThrough
              ? `${forward.firstConfirmedDate}〜${forward.confirmedThrough}`
              : '-'}
          </dd>
        </div>
        <div>
          <dt>{confirmed ? '確定日数' : '再計算日数'}</dt>
          <dd>{confirmed ? `${forward.confirmedDayCount.toLocaleString('ja-JP')}日` : '-'}</dd>
        </div>
        <div>
          <dt>{actualLabel}pips</dt>
          <dd>{formatPips(forward.metrics.netPips)}</dd>
        </div>
        <div>
          <dt>参考PF</dt>
          <dd>
            {!referenceAvailable
              ? '-'
              : backtestReference.profitFactor === null
                ? '∞'
                : backtestReference.profitFactor.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt>参考BTの評価バー</dt>
          <dd>
            {strategy.backtestReferenceCoverage && referenceAvailable
              ? `${strategy.backtestReferenceCoverage.barsEvaluated.toLocaleString('ja-JP')}本`
              : '-'}
          </dd>
        </div>
        <div>
          <dt>参考BTの現行窓</dt>
          <dd>{referenceCoverageLabel(strategy.backtestReferenceCoverage)}</dd>
        </div>
      </dl>

      <section className="chart-card forward-chart-card">
        <div className="chart-heading">
          <span>{actualLabel}の累積資産</span>
          <span>{confirmed ? '日次確定履歴から集計' : '現行窓から再計算'}</span>
        </div>
        <ForwardEquityCurve strategy={strategy} />
      </section>

      <section className="trade-table-card forward-trades-card">
        <div className="chart-heading">
          <span>{actualLabel}の直近トレード</span>
          <span>{forward.trades.length}件（最大50件）</span>
        </div>
        {forward.trades.length === 0 ? (
          <p className="empty-copy">まだ約定はありません。</p>
        ) : (
          <div className="trade-table-wrap">
            <table className="trade-table forward-trade-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>方向</th>
                  <th>エントリー</th>
                  <th>決済</th>
                  <th>損益(円)</th>
                  <th>損益(pips)</th>
                  <th>理由</th>
                </tr>
              </thead>
              <tbody>
                {forward.trades.map((trade) => (
                  <tr key={`${trade.entryTime}-${trade.exitTime}-${trade.direction}-${trade.id}`}>
                    <td>{trade.id}</td>
                    <td>{trade.direction === 'long' ? '買い' : '売り'}</td>
                    <td>{dateLabel(trade.entryTime)} / {formatPrice(meta.pair, trade.entryPrice)}</td>
                    <td>{dateLabel(trade.exitTime)} / {formatPrice(meta.pair, trade.exitPrice)}</td>
                    <td className={trade.netProfitYen >= 0 ? 'metric-up' : 'metric-down'}>
                      {formatYen(trade.netProfitYen)}
                    </td>
                    <td className={trade.netPips >= 0 ? 'metric-up' : 'metric-down'}>
                      {formatPips(trade.netPips)}
                    </td>
                    <td>{exitReasonLabels[trade.exitReason]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </article>
  );
}

export function ForwardTestPanel({ now }: ForwardTestPanelProps) {
  const [results, setResults] = useState<ForwardResultsFileWithHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    loadForwardResults()
      .then((payload) => {
        if (!disposed) {
          setResults(payload as ForwardResultsFileWithHistory);
        }
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : 'フォワードテスト結果を読み込めませんでした');
          setResults(null);
        }
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

  if (loading) {
    return <div className="state-message">フォワードテスト結果を読み込んでいます...</div>;
  }

  if (error) {
    return <div className="state-message state-error">{error}</div>;
  }

  if (!results) {
    return <div className="state-message">フォワードテスト結果がありません。</div>;
  }

  return (
    <div className="forward-test-stack">
      <section className="forward-overview">
        <div>
          <p className="eyebrow">EAフォワードテスト</p>
          <h2>仮想運用モニター</h2>
        </div>
        <div className="forward-overview-copy">
          <p>確定実績は日次で追記保存し、参考バックテストは現行データ窓で再計算します。</p>
          <small>最終計算: {new Date(results.computedAt).toLocaleString('ja-JP')}</small>
        </div>
      </section>

      <div className="forward-strategy-grid">
        {results.strategies.map((strategy) => (
          <StrategyCard key={strategy.meta.id} strategy={strategy} now={now} />
        ))}
      </div>

      <p className="forward-disclaimer">
        確定実績は登録済みルールを日次データへ適用して保存した仮想運用結果であり、実口座の取引履歴ではありません。
        参考バックテストは現在保持しているデータ窓で再計算されるため、値が変動します。
        約定価格、スリッページ、取引コスト、運用停止条件は実口座と一致しない場合があります。
        本画面の情報は投資助言ではありません。
      </p>
    </div>
  );
}

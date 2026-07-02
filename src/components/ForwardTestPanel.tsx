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
import { timeframeLabels } from '../types';

interface ForwardTestPanelProps {
  now: number;
}

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

const statusLabel = (strategy: ForwardStrategyResult): string => {
  if (strategy.forward.metrics.tradeCount === 0) {
    return 'シグナル待ち';
  }
  return (strategy.forward.metrics.netProfitYen ?? 0) >= 0 ? '運用中' : 'ドローダウン中';
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

function ForwardEquityCurve({ strategy }: { strategy: ForwardStrategyResult }) {
  const chartRef = useRef<HTMLDivElement | null>(null);
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
      title: 'フォワード残高',
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
  }, [points, strategy.forward.metrics.netProfitYen]);

  if (points.length < 2) {
    return (
      <div className="forward-empty-curve">
        資産曲線はフォワードデータが増えたら表示されます
      </div>
    );
  }

  return <div ref={chartRef} className="forward-equity-chart" />;
}

function MetricComparison({
  label,
  forward,
  reference,
  formatter,
  emphasizeProfit = false,
}: {
  label: string;
  forward: number | null;
  reference: number | null;
  formatter: (value: number | null) => string;
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
      <strong className={profitClass}>{formatter(forward)}</strong>
      <small>参考: {formatter(reference)}</small>
    </div>
  );
}

function StrategyCard({ strategy, now }: { strategy: ForwardStrategyResult; now: number }) {
  const { meta, forward, backtestReference } = strategy;
  const hasNoTrades = forward.metrics.tradeCount === 0;
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
          <span>{registeredDayLabel(meta.registeredAt, now)}</span>
          <strong>{statusLabel(strategy)}</strong>
        </div>
      </header>

      {hasNoTrades && (
        <div className="forward-waiting-message">
          運用開始直後です。シグナル待ち
        </div>
      )}

      <div className="forward-comparison-grid">
        <MetricComparison
          label="トレード数"
          forward={forward.metrics.tradeCount}
          reference={backtestReference.tradeCount}
          formatter={tradeCountFormatter}
        />
        <MetricComparison
          label="勝率"
          forward={forward.metrics.winRate}
          reference={backtestReference.winRate}
          formatter={formatPercent}
        />
        <MetricComparison
          label="純損益"
          forward={forward.metrics.netProfitYen}
          reference={backtestReference.netProfitYen}
          formatter={formatYen}
          emphasizeProfit
        />
        <MetricComparison
          label="最大DD"
          forward={forward.metrics.maxDrawdownYen}
          reference={backtestReference.maxDrawdownYen}
          formatter={formatYen}
        />
      </div>

      <dl className="forward-detail-grid">
        <div>
          <dt>評価バー</dt>
          <dd>{strategy.barsEvaluated.toLocaleString('ja-JP')}本</dd>
        </div>
        <div>
          <dt>フォワードpips</dt>
          <dd>{formatPips(forward.metrics.netPips)}</dd>
        </div>
        <div>
          <dt>参考PF</dt>
          <dd>{backtestReference.profitFactor === null ? '∞' : backtestReference.profitFactor.toFixed(2)}</dd>
        </div>
      </dl>

      <section className="chart-card forward-chart-card">
        <div className="chart-heading">
          <span>資産曲線</span>
          <span>フォワード</span>
        </div>
        <ForwardEquityCurve strategy={strategy} />
      </section>

      <section className="trade-table-card forward-trades-card">
        <div className="chart-heading">
          <span>直近トレード</span>
          <span>{forward.trades.length}件</span>
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
                  <tr key={trade.id}>
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
  const [results, setResults] = useState<ForwardResultsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    loadForwardResults()
      .then((payload) => {
        if (!disposed) {
          setResults(payload);
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
          <p>毎朝のデータ更新時に自動でシミュレーションが進みます。</p>
          <small>最終計算: {new Date(results.computedAt).toLocaleString('ja-JP')}</small>
        </div>
      </section>

      <div className="forward-strategy-grid">
        {results.strategies.map((strategy) => (
          <StrategyCard key={strategy.meta.id} strategy={strategy} now={now} />
        ))}
      </div>

      <p className="forward-disclaimer">
        フォワードテストは過去に登録したルールを最新バーへ機械的に適用する仮想運用です。
        約定価格、スリッページ、取引コスト、運用停止条件は実口座と一致しない場合があります。
        本画面の情報は投資助言ではありません。
      </p>
    </div>
  );
}

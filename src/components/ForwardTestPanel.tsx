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
  hasOperationStatus,
  loadForwardResults,
  loadRetiredForwardStrategies,
  type ForwardMetrics,
  type ForwardResultsFile,
  type ForwardStrategyResult,
  type RetiredForwardStrategy,
} from '../lib/forward-test';
import { evaluateForwardStatus } from '../lib/forwardStatus';
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

const formatProfitFactor = (value: number | null): string =>
  value === null ? '∞（損失0）' : value.toFixed(2);

const operationStatusLabels: Record<
  NonNullable<ForwardStrategyResult['operationStatus']>['status'],
  string
> = {
  active: '運用中',
  probation: '要注意',
  retire_candidate: '退役候補',
};

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
  const forwardStatus = evaluateForwardStatus(forward.metrics);
  let operationStatus: ForwardStrategyResult['operationStatus'];
  if (hasOperationStatus(strategy)) {
    operationStatus = strategy.operationStatus;
  }
  // 「運用非推奨」の重複解消は、赤の運用非推奨ボックスが実際に出る
  // retire_candidate のときだけ行う。probation では成績バッジ側の警告文言を
  // 残さないと、PF0.9未満(取引10〜19件)の助言が従来より弱まる。
  const performanceStatusLabel = operationStatus?.status === 'retire_candidate'
    ? forwardStatus.label.replace('(この設定での運用は非推奨)', '')
    : forwardStatus.label;
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
          <span className="forward-status-period">
            {confirmed
              ? forward.confirmedThrough === null
                ? '確定待ち'
                : `${forward.confirmedThrough}まで確定`
              : registeredDayLabel(meta.registeredAt, now)}
          </span>
          <div className="forward-status-badges">
            <strong className={`forward-status-badge forward-status-${forwardStatus.tone}`}>
              成績: {performanceStatusLabel}
            </strong>
            {operationStatus && (
              <strong
                className={`forward-operation-badge forward-operation-${operationStatus.status}`}
              >
                運用状態: {operationStatusLabels[operationStatus.status]}
                <span className="forward-operation-reason-sr">
                  。判定理由: {operationStatus.reason}
                </span>
              </strong>
            )}
          </div>
          <small className="forward-status-detail">{forwardStatus.detail}</small>
        </div>
      </header>

      {operationStatus?.status === 'probation' && (
        <div className="forward-operation-alert forward-operation-alert-probation" role="note">
          <strong>注意して経過観察</strong>
          <span>運用判断を保留し、確定実績を継続して監視してください。</span>
        </div>
      )}

      {operationStatus?.status === 'retire_candidate' && (
        <div className="forward-operation-alert forward-operation-alert-retire" role="note">
          <strong>運用非推奨</strong>
          <span>フォワード実績により退役候補と判定されています。</span>
        </div>
      )}

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

const retiredDateLabel = (value: string | number): string => {
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('ja-JP');
};

const retiredOperationPeriodLabel = (strategy: RetiredForwardStrategy): string => {
  const { operationPeriod } = strategy.finalSnapshot;
  const start = operationPeriod.firstConfirmedDate
    ?? retiredDateLabel(operationPeriod.registeredAt);
  const end = operationPeriod.confirmedThrough
    ?? retiredDateLabel(strategy.retiredAt);
  return `${start}〜${end}（確定${operationPeriod.confirmedDayCount.toLocaleString('ja-JP')}日）`;
};

function RetiredStrategyArchive({ strategies }: { strategies: RetiredForwardStrategy[] }) {
  return (
    <section className="forward-retired-archive" aria-labelledby="forward-retired-title">
      <header className="forward-retired-heading">
        <div>
          <p className="eyebrow">退役実績アーカイブ</p>
          <h2 id="forward-retired-title">退役したEA</h2>
        </div>
        <p>最終確定成績と退役判断を記録したまま公開しています。</p>
      </header>

      <div className="forward-retired-grid">
        {strategies.map((strategy) => {
          const { finalSnapshot, meta } = strategy;
          return (
            <article
              className="forward-retired-card"
              key={`${strategy.strategyId}@${strategy.meta.registeredAt}`}
            >
              <header>
                <div>
                  <p className="eyebrow">{meta.pair} / {timeframeLabels[meta.timeframe]}</p>
                  <h3>{meta.name}</h3>
                </div>
                <span className="forward-retired-date">
                  退役日 {retiredDateLabel(strategy.retiredAt)}
                </span>
              </header>

              <dl className="forward-retired-metrics">
                <div>
                  <dt>最終累積損益</dt>
                  <dd className={finalSnapshot.cumulativeProfitYen >= 0 ? 'metric-up' : 'metric-down'}>
                    {formatYen(finalSnapshot.cumulativeProfitYen)}
                  </dd>
                </div>
                <div>
                  <dt>最終取引数</dt>
                  <dd>{finalSnapshot.tradeCount.toLocaleString('ja-JP')}件</dd>
                </div>
                <div>
                  <dt>最終PF</dt>
                  <dd>
                    {finalSnapshot.tradeCount === 0
                      ? '—（取引なし）'
                      : formatProfitFactor(finalSnapshot.profitFactor)}
                  </dd>
                </div>
              </dl>

              <div className="forward-retired-period">
                <strong>運用期間</strong>
                <span>{retiredOperationPeriodLabel(strategy)}</span>
              </div>

              <div className="forward-retired-reason">
                <strong>退役理由</strong>
                <p>{strategy.reason}</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function ForwardTestPanel({ now }: ForwardTestPanelProps) {
  const [results, setResults] = useState<ForwardResultsFileWithHistory | null>(null);
  const [retiredStrategies, setRetiredStrategies] = useState<RetiredForwardStrategy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setRetiredStrategies([]);
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

    loadRetiredForwardStrategies()
      .then((retired) => {
        if (!disposed) {
          setRetiredStrategies(
            [...retired].sort((left, right) => right.retiredAt.localeCompare(left.retiredAt)),
          );
        }
      })
      .catch(() => {
        if (!disposed) {
          setRetiredStrategies([]);
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

      {retiredStrategies.length > 0 && (
        <RetiredStrategyArchive strategies={retiredStrategies} />
      )}

      <p className="forward-disclaimer">
        確定実績は登録済みルールを日次データへ適用して保存した仮想運用結果であり、実口座の取引履歴ではありません。
        参考バックテストは現在保持しているデータ窓で再計算されるため、値が変動します。
        約定価格、スリッページ、取引コスト、運用停止条件は実口座と一致しない場合があります。
        本画面の情報は投資助言ではありません。
      </p>
    </div>
  );
}

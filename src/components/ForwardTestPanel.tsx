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
  formatQuarterlyStability,
  selectionRankLabel,
  loadForwardResults,
  loadRetiredForwardStrategies,
  type ForwardMetrics,
  type ForwardResultsFile,
  type ForwardStrategyResult,
  type MonthlySummary,
  type RetiredForwardStrategy,
  type SelectionEvidence,
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

const formatEvidenceMetrics = (
  netProfitYen: number,
  profitFactor: number,
  tradeCount?: number,
): string => `${formatYen(netProfitYen)} / PF ${profitFactor.toFixed(2)}${
  tradeCount === undefined ? '' : ` / ${numberFormatter.format(tradeCount)}件`
}`;

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

export function SelectionEvidenceDetails({ evidence }: { evidence: SelectionEvidence }) {
  const rankLabel = selectionRankLabel(evidence);

  return (
    <details className="forward-operation-details forward-selection-evidence-details">
      <summary>採用時の選定根拠</summary>
      <div className="forward-selection-evidence-content">
        <dl className="forward-selection-evidence-list">
          <div>
            <dt>採用日</dt>
            <dd>{evidence.adoptedAt}</dd>
          </div>
          <div>
            <dt>候補母数と順位</dt>
            <dd>{rankLabel}</dd>
          </div>
          {evidence.rankNote && (
            <div>
              <dt>順位メモ</dt>
              <dd>{evidence.rankNote}</dd>
            </div>
          )}
          <div>
            <dt>選定レポート</dt>
            <dd>
              {evidence.reportLabel && (
                <>
                  <span>{evidence.reportLabel}</span>
                  <span aria-hidden="true"> / </span>
                </>
              )}
              <span>{evidence.reportId}</span>
            </dd>
          </div>
          <div>
            <dt>最適化期間成績</dt>
            <dd>
              {formatEvidenceMetrics(
                evidence.optimization.netProfitYen,
                evidence.optimization.profitFactor,
                evidence.optimization.tradeCount,
              )}
            </dd>
          </div>
          <div>
            <dt>検証期間成績</dt>
            <dd>
              {formatEvidenceMetrics(
                evidence.validation.netProfitYen,
                evidence.validation.profitFactor,
              )}
            </dd>
          </div>
          <div>
            <dt>四半期安定性</dt>
            <dd>{formatQuarterlyStability(evidence.quarterlyStability)}</dd>
          </div>
          {evidence.reservations.length > 0 && (
            <div>
              <dt>留保</dt>
              <dd>
                <ul>
                  {evidence.reservations.map((reservation, index) => (
                    <li key={`${index}-${reservation}`}>{reservation}</li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
        <p className="forward-selection-evidence-note" role="note">
          スプレッド固定・滑りなしの理想化バックテストによる採用時点の根拠であり、上のフォワード実績とは別物です
        </p>
      </div>
    </details>
  );
}

export function MonthlySummarySection({ summary }: { summary: MonthlySummary }) {
  return (
    <section className="forward-monthly-summary" aria-labelledby="forward-monthly-title">
      <header className="forward-monthly-heading">
        <div>
          <p className="eyebrow">確定日次の月別集計</p>
          <h2 id="forward-monthly-title">月次実績(確定分のみ)</h2>
        </div>
        <p>退役EAを含む全ストラテジーの確定実績を月別に集計し、合算とEA別の内訳を追えます。</p>
      </header>

      <p className="forward-monthly-note" role="note">
        確定した日次のみの集計です。取引中ポジションの含み損益は含みません。過去に運用し退役したEAの実績も含みます。内訳には確定日次があるEAのみ表示されます。pipsはペア間で価値が異なるため参考値です(損益円が正)。
      </p>

      {summary.months.length === 0 ? (
        <p className="empty-copy">確定日次がある月はまだありません。</p>
      ) : (
        <div className="forward-monthly-list">
          {summary.months.map((month) => (
            <article
              className={`forward-monthly-row${month.complete ? '' : ' forward-monthly-row-pending'}`}
              key={month.month}
            >
              <div className="forward-monthly-month">
                <span>月</span>
                <strong>{month.month}</strong>
                <span className={`forward-monthly-status${month.complete ? '' : ' forward-monthly-status-pending'}`}>
                  {month.complete ? '確定' : '集計中'}
                </span>
              </div>
              <div className="forward-monthly-metric">
                <span>合算損益</span>
                <strong className={month.total.netProfitYen >= 0 ? 'metric-up' : 'metric-down'}>
                  {formatYen(month.total.netProfitYen)}
                </strong>
              </div>
              <div className="forward-monthly-metric">
                <span>取引数</span>
                <strong>{numberFormatter.format(month.total.tradeCount)}件</strong>
              </div>
              <div className="forward-monthly-metric">
                <span>確定日数</span>
                <strong>{numberFormatter.format(month.confirmedDays)}日</strong>
              </div>
              <details className="forward-monthly-details">
                <summary>EA別内訳（{numberFormatter.format(month.strategies.length)}EA）</summary>
                {month.strategies.length === 0 ? (
                  <p className="empty-copy">この月のEA別確定実績はありません。</p>
                ) : (
                  <div className="forward-monthly-strategy-list">
                    {month.strategies.map((strategy) => (
                      <div className="forward-monthly-strategy-row" key={strategy.id}>
                        <div className="forward-monthly-strategy-name">
                          <strong>{strategy.name}</strong>
                          <small>{strategy.id}</small>
                        </div>
                        <span className="forward-monthly-retired-slot">
                          {strategy.retired ? (
                            <span className="forward-monthly-retired-badge">退役済み</span>
                          ) : null}
                        </span>
                        <div className="forward-monthly-strategy-metric">
                          <span>損益</span>
                          <strong className={strategy.netProfitYen >= 0 ? 'metric-up' : 'metric-down'}>
                            {formatYen(strategy.netProfitYen)}
                          </strong>
                        </div>
                        <div className="forward-monthly-strategy-metric">
                          <span>pips</span>
                          <strong className={strategy.netPips >= 0 ? 'metric-up' : 'metric-down'}>
                            {formatPips(strategy.netPips)}
                          </strong>
                        </div>
                        <div className="forward-monthly-strategy-metric">
                          <span>取引</span>
                          <strong>{numberFormatter.format(strategy.tradeCount)}件</strong>
                        </div>
                        <div className="forward-monthly-strategy-metric">
                          <span>確定日数</span>
                          <strong>{numberFormatter.format(strategy.confirmedDays)}日</strong>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
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
  // retire_candidate のときだけ行う。現在成績は既定表示に残し、
  // 運用状態の判定条件と根拠は折りたたみ内で補足する。
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
              </strong>
            )}
          </div>
          <small className="forward-status-detail">
            現在成績: {forwardStatus.detail}
          </small>
          {operationStatus && (
            <details className="forward-operation-details">
              <summary title={`判定理由: ${operationStatus.reason}`}>
                運用状態の判定根拠
              </summary>
              <p>{operationStatus.reason}</p>
            </details>
          )}
          {strategy.selectionEvidence && (
            <SelectionEvidenceDetails evidence={strategy.selectionEvidence} />
          )}
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
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      return `${dateOnly[1]}/${dateOnly[2]}/${dateOnly[3]}`;
    }
  }
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  // date-only経路(ゼロ埋め YYYY/MM/DD)と書式を揃える
  return Number.isNaN(date.getTime())
    ? '-'
    : new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
};

const retiredOperationPeriodLabel = (strategy: RetiredForwardStrategy): string => {
  const { operationPeriod } = strategy.finalSnapshot;
  const start = retiredDateLabel(
    operationPeriod.firstConfirmedDate ?? operationPeriod.registeredAt,
  );
  const end = retiredDateLabel(
    operationPeriod.confirmedThrough ?? strategy.retiredAt,
  );
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

      {results.monthlySummary && <MonthlySummarySection summary={results.monthlySummary} />}

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

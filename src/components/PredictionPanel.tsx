import {
  CandlestickData,
  ColorType,
  createChart,
  IChartApi,
  LineData,
  Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  formatCalendarTimeJst,
  upcomingEventsWithin,
  type CalendarEvent,
} from '../lib/calendar';
import { formatPrice, type AdaptiveStatsFile } from '../lib/chart-data';
import { adaptiveModelIds, type AdaptiveModelId } from '../lib/adaptive';
import {
  updatePredictionJournalForDisplay,
  type PredictionJournalSummary,
} from '../lib/journal';
import {
  predict,
  walkForwardAccuracyAsync,
  type HorizonPrediction,
  type WalkForwardAccuracy,
} from '../lib/predict';
import type { Bar, Pair, Timeframe } from '../types';
import { timeframeLabels } from '../types';

interface PredictionPanelProps {
  bars: Bar[];
  pair: Pair;
  timeframe: Timeframe;
  adaptiveStats?: AdaptiveStatsFile | null;
  calendarEvents?: CalendarEvent[];
  now?: number;
}

const timeframeSeconds: Record<Timeframe, number> = {
  h1: 60 * 60,
  h4: 60 * 60 * 4,
  d1: 60 * 60 * 24,
};

const createPredictionChart = (container: HTMLDivElement): IChartApi =>
  createChart(container, {
    height: 520,
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

const probabilityLabel = (value: number): string => `${(value * 100).toFixed(1)}%`;

const modelLabels: Record<AdaptiveModelId, string> = {
  signal: 'シグナル',
  drift: 'ドリフト',
  regime: 'レジーム',
};

const emptyJournalSummary: PredictionJournalSummary = {
  total: 0,
  resolved: 0,
  pending: 0,
  hits: 0,
  misses: 0,
  accuracy: null,
};

const formatStatsTime = (value: string | undefined): string => {
  if (!value) {
    return '未取得';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未取得' : date.toLocaleString('ja-JP');
};

const gaugeStyle = (probability: number): CSSProperties => {
  const color = probability >= 0.5 ? '#20c997' : '#ff5b78';
  return {
    background: `conic-gradient(${color} ${probability * 360}deg, rgba(142,155,179,0.18) 0deg)`,
  };
};

const fanLine = (
  bars: readonly Bar[],
  timeframe: Timeframe,
  predictions: readonly HorizonPrediction[],
  valueOf: (prediction: HorizonPrediction) => number,
): LineData[] => {
  const last = bars[bars.length - 1];
  const stepSeconds = timeframeSeconds[timeframe];
  return [
    { time: last.t as Time, value: last.c },
    ...predictions.map<LineData>((prediction) => ({
      time: (last.t + stepSeconds * prediction.horizon) as Time,
      value: valueOf(prediction),
    })),
  ];
};

export function PredictionPanel({
  bars,
  pair,
  timeframe,
  adaptiveStats = null,
  calendarEvents = [],
  now = Math.floor(Date.now() / 1000),
}: PredictionPanelProps) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const result = useMemo(
    () => predict(bars, { includeWalkForward: false, adaptiveStats }),
    [adaptiveStats, bars],
  );
  const displayBars = useMemo(() => bars.slice(-260), [bars]);
  const [walkForward, setWalkForward] = useState<WalkForwardAccuracy | null>(null);
  const [walkForwardStatus, setWalkForwardStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [journalSummary, setJournalSummary] = useState<PredictionJournalSummary>(emptyJournalSummary);
  const highImpactUpcoming = useMemo(
    () =>
      upcomingEventsWithin(calendarEvents, pair, 24 * 60 * 60, now).filter(
        (event) => event.impact === 'high',
      ),
    [calendarEvents, now, pair],
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const { summary } = updatePredictionJournalForDisplay(
      window.localStorage,
      pair,
      timeframe,
      bars,
      result.horizons.map((prediction) => ({
        horizon: prediction.horizon,
        probabilityUp: prediction.probabilityUp,
      })),
    );
    setJournalSummary(summary);
  }, [bars, pair, result.horizons, timeframe]);

  useEffect(() => {
    const controller = new AbortController();
    setWalkForward(null);
    setWalkForwardStatus('loading');

    walkForwardAccuracyAsync(bars, {}, controller.signal)
      .then((accuracy) => {
        if (controller.signal.aborted) {
          return;
        }
        setWalkForward(accuracy);
        setWalkForwardStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setWalkForwardStatus('unavailable');
      });

    return () => {
      controller.abort();
    };
  }, [bars, pair, timeframe]);

  useEffect(() => {
    if (!chartRef.current || bars.length === 0) {
      return;
    }

    const chart = createPredictionChart(chartRef.current);
    const resizeObserver = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (width > 0) {
        chart.applyOptions({ width });
      }
    });
    resizeObserver.observe(chartRef.current);

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#20c997',
      downColor: '#ff5b78',
      borderUpColor: '#20c997',
      borderDownColor: '#ff5b78',
      wickUpColor: '#20c997',
      wickDownColor: '#ff5b78',
      priceFormat: {
        type: 'price',
        precision: pair.endsWith('JPY') ? 3 : 5,
        minMove: pair.endsWith('JPY') ? 0.001 : 0.00001,
      },
    });
    candleSeries.setData(
      displayBars.map<CandlestickData>((bar) => ({
        time: bar.t as Time,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
      })),
    );

    const expected = chart.addLineSeries({
      color: '#f5ce62',
      lineWidth: 2,
      lineStyle: 2,
      title: '期待値',
    });
    expected.setData(fanLine(bars, timeframe, result.horizons, (item) => item.expectedPrice));

    const upper68 = chart.addLineSeries({ color: 'rgba(32,201,151,0.86)', lineWidth: 2, title: '68%上限' });
    upper68.setData(fanLine(bars, timeframe, result.horizons, (item) => item.range68.high));
    const lower68 = chart.addLineSeries({ color: 'rgba(32,201,151,0.86)', lineWidth: 2, title: '68%下限' });
    lower68.setData(fanLine(bars, timeframe, result.horizons, (item) => item.range68.low));

    const upper95 = chart.addLineSeries({
      color: 'rgba(89,214,255,0.58)',
      lineWidth: 1,
      lineStyle: 2,
      title: '95%上限',
    });
    upper95.setData(fanLine(bars, timeframe, result.horizons, (item) => item.range95.high));
    const lower95 = chart.addLineSeries({
      color: 'rgba(89,214,255,0.58)',
      lineWidth: 1,
      lineStyle: 2,
      title: '95%下限',
    });
    lower95.setData(fanLine(bars, timeframe, result.horizons, (item) => item.range95.low));

    chart.timeScale().fitContent();

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [bars, displayBars, pair, result, timeframe]);

  return (
    <div className="prediction-stack">
      {highImpactUpcoming.length > 0 && (
        <div className="warning-banner" role="alert">
          <strong>⚠️ 高インパクト指標が近いため統計予測の信頼性が低下します</strong>
          <span>
            {highImpactUpcoming
              .slice(0, 3)
              .map((event) => `${formatCalendarTimeJst(event.time)} ${event.currency} ${event.title}`)
              .join(' / ')}
          </span>
        </div>
      )}

      <section className="prediction-summary">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">予測</p>
            <h2>{pair} / {timeframeLabels[timeframe]}</h2>
          </div>
          <div className={`rating-badge rating-${result.signalAnalysis.rating.id}`}>
            {result.signalAnalysis.rating.label}
          </div>
        </div>

        <div className="probability-grid">
          {result.horizons.map((prediction) => (
            <article key={prediction.horizon} className="probability-card">
              <div className="probability-gauge" style={gaugeStyle(prediction.probabilityUp)}>
                <span>{probabilityLabel(prediction.probabilityUp)}</span>
              </div>
              <div>
                <strong>{prediction.horizon}本先</strong>
                <span>上昇確率</span>
                <small>
                  68%帯 {formatPrice(pair, prediction.range68.low)} - {formatPrice(pair, prediction.range68.high)}
                </small>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="learning-status">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">適応学習</p>
            <h2>学習ステータス</h2>
          </div>
          <div className="rating-badge">
            {adaptiveStats ? '統計適用中' : '固定重み'}
          </div>
        </div>

        <div className="learning-grid">
          <div className="learning-card learning-card-wide">
            <h3>現在のモデル重み</h3>
            <div className="weight-horizon-list">
              {result.horizons.map((prediction) => (
                <div key={prediction.horizon} className="weight-horizon">
                  <strong>{prediction.horizon}本先</strong>
                  <div className="weight-bars">
                    {adaptiveModelIds.map((modelId) => (
                      <div key={modelId} className="weight-row">
                        <span>{modelLabels[modelId]}</span>
                        <div className="weight-track">
                          <i style={{ width: `${Math.round(prediction.modelWeights[modelId] * 100)}%` }} />
                        </div>
                        <small>{probabilityLabel(prediction.modelWeights[modelId])}</small>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="learning-card">
            <h3>確率補正</h3>
            <div className="calibration-list">
              {result.horizons.map((prediction) => (
                <div key={prediction.horizon} className="calibration-row">
                  <span>{prediction.horizon}本先</span>
                  <strong>
                    {probabilityLabel(prediction.rawProbabilityUp)} → {probabilityLabel(prediction.calibratedProbabilityUp)}
                  </strong>
                  <small>{prediction.calibrationApplied ? 'キャリブレーション済み' : '未補正'}</small>
                </div>
              ))}
            </div>
          </div>

          <div className="learning-card">
            <h3>この端末の台帳実績</h3>
            <div className="journal-metrics">
              <div>
                <span>記録件数</span>
                <strong>{journalSummary.total.toLocaleString('ja-JP')}</strong>
              </div>
              <div>
                <span>答え合わせ済み</span>
                <strong>{journalSummary.resolved.toLocaleString('ja-JP')}</strong>
              </div>
              <div>
                <span>的中率</span>
                <strong>{journalSummary.accuracy === null ? '未算出' : probabilityLabel(journalSummary.accuracy)}</strong>
              </div>
            </div>
            <p className="disclaimer-copy">
              未確定 {journalSummary.pending.toLocaleString('ja-JP')} 件 / 的中 {journalSummary.hits.toLocaleString('ja-JP')} 件
            </p>
          </div>

          <div className="learning-card">
            <h3>統計の最終更新</h3>
            <p className="learning-timestamp">{formatStatsTime(adaptiveStats?.generatedAt)}</p>
            <p className="disclaimer-copy">
              生成サンプル数: {adaptiveStats ? adaptiveStats.sampleCount.toLocaleString('ja-JP') : '未取得'}
            </p>
          </div>
        </div>
      </section>

      <section className="chart-card">
        <div className="chart-heading">
          <span>ファンチャート</span>
          <span>黄色: 期待値 / 緑: 68% / 青: 95%</span>
        </div>
        <p className="disclaimer-copy">確率は方向、レンジ中心は期待値で別物です。</p>
        <div ref={chartRef} className="chart-area chart-area-main" />
      </section>

      <section className="prediction-details">
        <div className="detail-card">
          <h3>根拠</h3>
          <ul className="reason-list">
            {result.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
            {result.signalAnalysis.signals.slice(0, 5).map((signal) => (
              <li key={signal.id}>{signal.label}: {signal.detail}</li>
            ))}
          </ul>
        </div>

        <div className="detail-card">
          <h3>ウォークフォワード的中率</h3>
          <div className="accuracy-table">
            {walkForwardStatus === 'loading' ? (
              <div className="accuracy-row">
                <span>方向一致率</span>
                <strong>計算中…</strong>
                <small>履歴サンプルを分割して集計しています</small>
              </div>
            ) : null}
            {walkForwardStatus !== 'loading' && walkForward?.horizons.map((item) => (
              <div key={item.horizon} className="accuracy-row">
                <span>{item.horizon}本先</span>
                <strong>{item.accuracy === null ? '算出不可' : probabilityLabel(item.accuracy)}</strong>
                <small>{item.total}件中 {item.hits}件一致</small>
              </div>
            ))}
            {walkForwardStatus === 'unavailable' ? (
              <div className="accuracy-row">
                <span>方向一致率</span>
                <strong>算出不可</strong>
                <small>計算を完了できませんでした</small>
              </div>
            ) : null}
          </div>
          <p className="disclaimer-copy">
            過去データ上の方向一致率です。将来の収益や値動きを保証するものではありません。
          </p>
        </div>
      </section>
    </div>
  );
}

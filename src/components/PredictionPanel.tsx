import {
  CandlestickData,
  ColorType,
  createChart,
  IChartApi,
  LineData,
  Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { formatPrice } from '../lib/chart-data';
import { predict, type HorizonPrediction } from '../lib/predict';
import type { Bar, Pair, Timeframe } from '../types';
import { timeframeLabels } from '../types';

interface PredictionPanelProps {
  bars: Bar[];
  pair: Pair;
  timeframe: Timeframe;
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

export function PredictionPanel({ bars, pair, timeframe }: PredictionPanelProps) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const result = useMemo(() => predict(bars), [bars]);
  const displayBars = useMemo(() => bars.slice(-260), [bars]);

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
      title: '予測中央値',
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

      <section className="chart-card">
        <div className="chart-heading">
          <span>ファンチャート</span>
          <span>黄色: 中央 / 緑: 68% / 青: 95%</span>
        </div>
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
            {result.walkForward?.horizons.map((item) => (
              <div key={item.horizon} className="accuracy-row">
                <span>{item.horizon}本先</span>
                <strong>{item.accuracy === null ? '算出不可' : probabilityLabel(item.accuracy)}</strong>
                <small>{item.total}件中 {item.hits}件一致</small>
              </div>
            ))}
          </div>
          <p className="disclaimer-copy">
            過去データ上の方向一致率です。将来の収益や値動きを保証するものではありません。
          </p>
        </div>
      </section>
    </div>
  );
}

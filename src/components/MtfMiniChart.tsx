import { AreaData, CandlestickData, Time } from 'lightweight-charts';
import { useEffect, useMemo, useRef } from 'react';
import {
  chartLineColors as lineColors,
  createBaseChart,
  createSupportResistancePriceLineOptions,
  timeframeSeconds,
  toFutureLineData,
  toLineData,
} from '../lib/chart-rendering';
import { formatPrice } from '../lib/chart-data';
import { ichimoku, sma } from '../lib/indicators';
import { detectSupportResistanceLevels } from '../lib/levels';
import { evaluateMtfAlignment } from '../lib/mtf';
import type { SignalAnalysis } from '../lib/signals';
import type { Bar, Pair, Timeframe } from '../types';
import { timeframeLabels } from '../types';

interface MtfMiniChartProps {
  bars: Bar[];
  pair: Pair;
  timeframe: Timeframe;
  mainTimeframe: Timeframe;
  analysis: SignalAnalysis;
  mainAnalysis: SignalAnalysis;
}

const meterLabels = ['強い売り', '売り', '中立', '買い', '強い買い'];

const signedScore = (score: number): string => `${score > 0 ? '+' : ''}${score}`;

export function MtfMiniChart({
  bars,
  pair,
  timeframe,
  mainTimeframe,
  analysis,
  mainAnalysis,
}: MtfMiniChartProps) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const computed = useMemo(() => {
    const closes = bars.map((bar) => bar.c);
    const highs = bars.map((bar) => bar.h);
    const lows = bars.map((bar) => bar.l);
    return {
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      ichimoku: ichimoku(highs, lows),
    };
  }, [bars]);
  const levels = useMemo(
    () => detectSupportResistanceLevels(bars, { lookback: 240, maxLevels: 8 }),
    [bars],
  );
  const alignment = useMemo(
    () =>
      evaluateMtfAlignment({
        mainTimeframe,
        secondaryTimeframe: timeframe,
        mainScore: mainAnalysis.score,
        secondaryScore: analysis.score,
      }),
    [analysis.score, mainAnalysis.score, mainTimeframe, timeframe],
  );
  const latestBar = bars[bars.length - 1] ?? null;

  useEffect(() => {
    if (!chartRef.current || bars.length === 0) {
      return;
    }

    const chart = createBaseChart(chartRef.current, 312);
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
      bars.map<CandlestickData>((bar) => ({
        time: bar.t as Time,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
      })),
    );

    const sma20 = chart.addLineSeries({ color: lineColors.sma20, lineWidth: 2, title: 'SMA20' });
    sma20.setData(toLineData(bars, computed.sma20));
    const sma50 = chart.addLineSeries({ color: lineColors.sma50, lineWidth: 2, title: 'SMA50' });
    sma50.setData(toLineData(bars, computed.sma50));

    const stepSeconds = timeframeSeconds[timeframe];
    const conversion = chart.addLineSeries({ color: lineColors.tenkan, lineWidth: 1, title: '転換線' });
    conversion.setData(toLineData(bars, computed.ichimoku.conversion));
    const base = chart.addLineSeries({ color: lineColors.kijun, lineWidth: 1, title: '基準線' });
    base.setData(toLineData(bars, computed.ichimoku.base));
    const spanA = chart.addAreaSeries({
      topColor: lineColors.spanA,
      bottomColor: 'rgba(57, 210, 143, 0.02)',
      lineColor: 'rgba(57, 210, 143, 0.68)',
      lineWidth: 1,
      title: '先行スパンA',
    });
    spanA.setData(toFutureLineData(bars, computed.ichimoku.leadingSpanA, stepSeconds) as AreaData[]);
    const spanB = chart.addAreaSeries({
      topColor: lineColors.spanB,
      bottomColor: 'rgba(255, 91, 120, 0.02)',
      lineColor: 'rgba(255, 91, 120, 0.68)',
      lineWidth: 1,
      title: '先行スパンB',
    });
    spanB.setData(toFutureLineData(bars, computed.ichimoku.leadingSpanB, stepSeconds) as AreaData[]);

    levels.forEach((level) => {
      candleSeries.createPriceLine(createSupportResistancePriceLineOptions(pair, level));
    });
    chart.timeScale().fitContent();

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [bars, computed, levels, pair, timeframe]);

  return (
    <div className="chart-card mtf-card">
      <div className="chart-heading">
        <span>MTF表示</span>
        <span>{pair} / {timeframe.toUpperCase()}</span>
      </div>
      <div className="mtf-signal-panel">
        <div className="mtf-signal-topline">
          <div>
            <p className="eyebrow">{timeframeLabels[timeframe]}シグナル</p>
            <strong>{analysis.rating.label}</strong>
          </div>
          <div className={`rating-badge rating-${analysis.rating.id}`}>
            {signedScore(analysis.score)}
          </div>
        </div>
        <div className="signal-meter signal-meter-compact" aria-label={`${timeframeLabels[timeframe]}判定: ${analysis.rating.label}`}>
          {meterLabels.map((label, index) => (
            <div
              key={label}
              className={index === analysis.rating.level ? 'meter-step meter-step-active' : 'meter-step'}
            >
              <span />
              <small>{label}</small>
            </div>
          ))}
        </div>
        <p className={`mtf-alignment mtf-alignment-${alignment.status}`}>{alignment.summary}</p>
        {latestBar && (
          <p className="mtf-latest-price">
            終値 {formatPrice(pair, latestBar.c)} / サポレジ {levels.length}本
          </p>
        )}
      </div>
      <div ref={chartRef} className="chart-area chart-area-mtf" />
    </div>
  );
}

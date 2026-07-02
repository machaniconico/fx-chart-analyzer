import {
  AreaData,
  CandlestickData,
  ColorType,
  createChart,
  HistogramData,
  IChartApi,
  ISeriesApi,
  LineData,
  SeriesMarker,
  Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  calendarImpactLabels,
  formatCalendarTimeJst,
  relevantChartEvents,
  upcomingEventsWithin,
  type CalendarEvent,
} from '../lib/calendar';
import { bollingerBands, ema, ichimoku, macd, rsi, sma } from '../lib/indicators';
import type { Bar, Pair, Timeframe } from '../types';

export interface IndicatorToggles {
  sma20: boolean;
  sma50: boolean;
  sma200: boolean;
  ema12: boolean;
  ema26: boolean;
  bb: boolean;
  ichimoku: boolean;
}

interface ChartPanelProps {
  bars: Bar[];
  pair: Pair;
  timeframe: Timeframe;
  toggles: IndicatorToggles;
  calendarEvents?: CalendarEvent[];
  now?: number;
}

const lineColors = {
  sma20: '#f8d66d',
  sma50: '#59d6ff',
  sma200: '#ff6b8a',
  ema12: '#a4ff7a',
  ema26: '#d88bff',
  bb: '#8e9bb3',
  tenkan: '#ff8a3d',
  kijun: '#6bdcff',
  spanA: 'rgba(57, 210, 143, 0.22)',
  spanB: 'rgba(255, 91, 120, 0.20)',
  rsi: '#f5ce62',
  macd: '#61dafb',
  signal: '#ff9f43',
};

const timeframeSeconds: Record<Timeframe, number> = {
  h1: 60 * 60,
  h4: 60 * 60 * 4,
  d1: 60 * 60 * 24,
};

const impactMarkerColors: Record<'high' | 'medium', string> = {
  high: '#ff5b78',
  medium: '#ff9f43',
};

const emptyCalendarEvents: CalendarEvent[] = [];

const toLineData = (bars: readonly Bar[], values: readonly (number | null)[]): LineData[] =>
  values.flatMap((value, index) =>
    value === null || index >= bars.length ? [] : [{ time: bars[index].t as Time, value }],
  );

const toFutureLineData = (
  bars: readonly Bar[],
  values: readonly (number | null)[],
  stepSeconds: number,
): LineData[] =>
  values.flatMap((value, index) => {
    if (value === null) {
      return [];
    }
    const baseTime = index < bars.length ? bars[index].t : bars[bars.length - 1].t + stepSeconds * (index - bars.length + 1);
    return [{ time: baseTime as Time, value }];
  });

const createBaseChart = (container: HTMLDivElement, height: number): IChartApi =>
  createChart(container, {
    height,
    layout: {
      background: { type: ColorType.Solid, color: '#10151f' },
      textColor: '#b9c2d0',
      fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(142,155,179,0.12)' },
      horzLines: { color: 'rgba(142,155,179,0.12)' },
    },
    crosshair: {
      mode: 1,
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

const markerBarTime = (bars: readonly Bar[], eventTime: number): number | null => {
  if (bars.length === 0 || eventTime < bars[0].t || eventTime > bars[bars.length - 1].t) {
    return null;
  }
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].t <= eventTime) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return bars[Math.max(0, high)].t;
};

const shortenMarkerTitle = (title: string): string =>
  title.length > 28 ? `${title.slice(0, 28)}...` : title;

export function ChartPanel({
  bars,
  pair,
  timeframe,
  toggles,
  calendarEvents = emptyCalendarEvents,
  now = Math.floor(Date.now() / 1000),
}: ChartPanelProps) {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const rsiRef = useRef<HTMLDivElement | null>(null);
  const macdRef = useRef<HTMLDivElement | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [markerTargetVersion, setMarkerTargetVersion] = useState(0);

  const computed = useMemo(() => {
    const closes = bars.map((bar) => bar.c);
    const highs = bars.map((bar) => bar.h);
    const lows = bars.map((bar) => bar.l);
    return {
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      sma200: sma(closes, 200),
      ema12: ema(closes, 12),
      ema26: ema(closes, 26),
      bb: bollingerBands(closes, 20, 2),
      ichimoku: ichimoku(highs, lows),
      rsi: rsi(closes, 14),
      macd: macd(closes, 12, 26, 9),
    };
  }, [bars]);
  const lastBarTime = bars.length > 0 ? bars[bars.length - 1].t : null;
  const chartEvents = useMemo(
    () => relevantChartEvents(calendarEvents, pair),
    [calendarEvents, pair],
  );
  const upcomingNews = useMemo(
    () => upcomingEventsWithin(chartEvents, pair, 24 * 60 * 60, now),
    [chartEvents, now, pair],
  );
  const markerEvents = useMemo(() => {
    if (lastBarTime === null) {
      return emptyCalendarEvents;
    }
    return chartEvents.filter((event) => event.time <= lastBarTime);
  }, [chartEvents, lastBarTime]);
  const newsMarkers = useMemo(
    () =>
      markerEvents.flatMap<SeriesMarker<Time>>((event) => {
        const time = markerBarTime(bars, event.time);
        if (time === null || (event.impact !== 'high' && event.impact !== 'medium')) {
          return [];
        }
        return [
          {
            id: `${event.currency}-${event.time}-${event.title}`,
            time: time as Time,
            position: 'aboveBar',
            shape: 'circle',
            color: impactMarkerColors[event.impact],
            text: `⚠ ${event.currency} ${shortenMarkerTitle(event.title)}`,
            size: event.impact === 'high' ? 1.6 : 1.25,
          },
        ];
      }),
    [bars, markerEvents],
  );

  useEffect(() => {
    if (!mainRef.current || !rsiRef.current || !macdRef.current || bars.length === 0) {
      return;
    }

    const mainChart = createBaseChart(mainRef.current, 520);
    const rsiChart = createBaseChart(rsiRef.current, 170);
    const macdChart = createBaseChart(macdRef.current, 190);
    const charts = [mainChart, rsiChart, macdChart];
    const resizeObserver = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (width > 0) {
        charts.forEach((chart) => chart.applyOptions({ width }));
      }
    });
    resizeObserver.observe(mainRef.current);

    const candleSeries = mainChart.addCandlestickSeries({
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
    candleSeriesRef.current = candleSeries;
    setMarkerTargetVersion((currentVersion) => currentVersion + 1);

    const addLine = (
      visible: boolean,
      values: readonly (number | null)[],
      color: string,
      title: string,
      chart: IChartApi = mainChart,
    ): ISeriesApi<'Line'> | null => {
      if (!visible) {
        return null;
      }
      const series = chart.addLineSeries({ color, lineWidth: 2, title });
      series.setData(toLineData(bars, values));
      return series;
    };

    addLine(toggles.sma20, computed.sma20, lineColors.sma20, 'SMA20');
    addLine(toggles.sma50, computed.sma50, lineColors.sma50, 'SMA50');
    addLine(toggles.sma200, computed.sma200, lineColors.sma200, 'SMA200');
    addLine(toggles.ema12, computed.ema12, lineColors.ema12, 'EMA12');
    addLine(toggles.ema26, computed.ema26, lineColors.ema26, 'EMA26');

    if (toggles.bb) {
      addLine(true, computed.bb.upper, lineColors.bb, 'BB上限');
      addLine(true, computed.bb.middle, 'rgba(142,155,179,0.55)', 'BB中央');
      addLine(true, computed.bb.lower, lineColors.bb, 'BB下限');
    }

    if (toggles.ichimoku) {
      const stepSeconds = timeframeSeconds[timeframe];
      addLine(true, computed.ichimoku.conversion, lineColors.tenkan, '転換線');
      addLine(true, computed.ichimoku.base, lineColors.kijun, '基準線');
      const spanA = mainChart.addAreaSeries({
        topColor: lineColors.spanA,
        bottomColor: 'rgba(57, 210, 143, 0.02)',
        lineColor: 'rgba(57, 210, 143, 0.68)',
        lineWidth: 1,
        title: '先行スパンA',
      });
      spanA.setData(toFutureLineData(bars, computed.ichimoku.leadingSpanA, stepSeconds) as AreaData[]);
      const spanB = mainChart.addAreaSeries({
        topColor: lineColors.spanB,
        bottomColor: 'rgba(255, 91, 120, 0.02)',
        lineColor: 'rgba(255, 91, 120, 0.68)',
        lineWidth: 1,
        title: '先行スパンB',
      });
      spanB.setData(toFutureLineData(bars, computed.ichimoku.leadingSpanB, stepSeconds) as AreaData[]);
    }

    const volumeSeries = mainChart.addHistogramSeries({
      color: 'rgba(117, 134, 160, 0.28)',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    mainChart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    volumeSeries.setData(
      bars.map<HistogramData>((bar) => ({
        time: bar.t as Time,
        value: bar.v,
        color: bar.c >= bar.o ? 'rgba(32,201,151,0.24)' : 'rgba(255,91,120,0.24)',
      })),
    );

    const rsiSeries = rsiChart.addLineSeries({ color: lineColors.rsi, lineWidth: 2, title: 'RSI14' });
    rsiSeries.setData(toLineData(bars, computed.rsi));
    [70, 30].forEach((level) => {
      const marker = rsiChart.addLineSeries({
        color: 'rgba(185,194,208,0.28)',
        lineWidth: 1,
        lineStyle: 2,
      });
      marker.setData(bars.map<LineData>((bar) => ({ time: bar.t as Time, value: level })));
    });

    const macdLine = macdChart.addLineSeries({ color: lineColors.macd, lineWidth: 2, title: 'MACD' });
    macdLine.setData(toLineData(bars, computed.macd.macd));
    const signalLine = macdChart.addLineSeries({ color: lineColors.signal, lineWidth: 2, title: 'シグナル' });
    signalLine.setData(toLineData(bars, computed.macd.signal));
    const histogram = macdChart.addHistogramSeries({ priceFormat: { type: 'price' }, priceScaleId: '' });
    histogram.setData(
      computed.macd.histogram.flatMap<HistogramData>((value, index) =>
        value === null
          ? []
          : [
              {
                time: bars[index].t as Time,
                value,
                color: value >= 0 ? 'rgba(32,201,151,0.55)' : 'rgba(255,91,120,0.55)',
              },
            ],
      ),
    );

    charts.forEach((chart) => chart.timeScale().fitContent());

    return () => {
      candleSeriesRef.current = null;
      resizeObserver.disconnect();
      charts.forEach((chart) => chart.remove());
    };
  }, [bars, computed, pair, timeframe, toggles]);

  useEffect(() => {
    candleSeriesRef.current?.setMarkers(newsMarkers);
  }, [markerTargetVersion, newsMarkers]);

  return (
    <div className="chart-stack">
      <div className="chart-card">
        <div className="chart-heading">
          <span>ローソク足</span>
          <span>{pair} / {timeframe.toUpperCase()}</span>
        </div>
        {upcomingNews.length > 0 && (
          <div className="news-banner">
            <strong>今後24時間の指標</strong>
            <div className="news-banner-list">
              {upcomingNews.slice(0, 4).map((event) => (
                <span key={`${event.currency}-${event.time}-${event.title}`}>
                  <i className={`impact-dot impact-${event.impact}`} />
                  {formatCalendarTimeJst(event.time)} {event.currency} {calendarImpactLabels[event.impact]} {event.title}
                </span>
              ))}
              {upcomingNews.length > 4 && <span>他 {upcomingNews.length - 4} 件</span>}
            </div>
          </div>
        )}
        <div ref={mainRef} className="chart-area chart-area-main" />
      </div>
      <div className="subcharts">
        <div className="chart-card">
          <div className="chart-heading">
            <span>RSI</span>
            <span>14期間</span>
          </div>
          <div ref={rsiRef} className="chart-area chart-area-sub" />
        </div>
        <div className="chart-card">
          <div className="chart-heading">
            <span>MACD</span>
            <span>12 / 26 / 9</span>
          </div>
          <div ref={macdRef} className="chart-area chart-area-sub" />
        </div>
      </div>
    </div>
  );
}

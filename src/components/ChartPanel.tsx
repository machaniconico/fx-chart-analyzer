import {
  AreaData,
  CandlestickData,
  HistogramData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineData,
  SeriesMarker,
  Time,
} from 'lightweight-charts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DrawingOverlay, type DrawingOverlayClick } from './DrawingOverlay';
import { MtfMiniChart } from './MtfMiniChart';
import {
  calendarImpactLabels,
  formatCalendarTimeJst,
  relevantChartEvents,
  upcomingEventsWithin,
  type CalendarEvent,
} from '../lib/calendar';
import {
  chartLineColors as lineColors,
  createBaseChart,
  createSupportResistancePriceLineOptions,
  hiddenOverlayPriceAxisOptions,
  overlayLineWidth,
  timeframeSeconds,
  toFutureLineData,
  toLineData,
  visibleSupportResistanceLevels,
} from '../lib/chart-rendering';
import { bollingerBands, ema, ichimoku, macd, rsi, sma } from '../lib/indicators';
import { detectSupportResistanceLevels } from '../lib/levels';
import { detectPatterns, type DetectedPattern, type PatternDirection } from '../lib/patterns';
import type { SignalAnalysis } from '../lib/signals';
import {
  createDrawingId,
  drawingStorageKey,
  loadStoredDrawings,
  removeStoredDrawings,
  saveStoredDrawings,
  type Drawing,
  type DrawingPoint,
} from '../lib/drawings';
import type { Bar, Pair, Timeframe } from '../types';

export interface IndicatorToggles {
  sma20: boolean;
  sma50: boolean;
  sma200: boolean;
  ema12: boolean;
  ema26: boolean;
  bb: boolean;
  ichimoku: boolean;
  supportResistance: boolean;
}

interface ChartPanelProps {
  bars: Bar[];
  pair: Pair;
  timeframe: Timeframe;
  toggles: IndicatorToggles;
  calendarEvents?: CalendarEvent[];
  mainSignalAnalysis?: SignalAnalysis | null;
  mtf?: MtfChartState;
  now?: number;
}

export interface MtfChartState {
  enabled: boolean;
  timeframe: Timeframe;
  bars: Bar[] | null;
  analysis: SignalAnalysis | null;
  loading: boolean;
  error: string | null;
}

type DrawingTool = 'select' | 'trendline' | 'horizontal' | 'fibonacci';

interface MainChartContext {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  version: number;
}

interface DrawingState {
  key: string;
  items: Drawing[];
}

interface OverlayLegendItem {
  key: string;
  label: string;
  color: string;
}

const impactMarkerColors: Record<'high' | 'medium', string> = {
  high: '#ff5b78',
  medium: '#ff9f43',
};

const patternDirectionLabels: Record<PatternDirection, string> = {
  bullish: '買い',
  bearish: '売り',
  neutral: '中立',
};

const patternMarkerColors: Record<PatternDirection, string> = {
  bullish: '#20c997',
  bearish: '#ff5b78',
  neutral: '#b9c2d0',
};

const emptyCalendarEvents: CalendarEvent[] = [];
const bbMiddleLineColor = 'rgba(142,155,179,0.48)';

const drawingToolOptions: {
  tool: DrawingTool;
  label: string;
  icon: string;
  title: string;
}[] = [
  {
    tool: 'select',
    label: '選択',
    icon: 'SEL',
    title: '選択: 描画をクリックして選択します',
  },
  {
    tool: 'trendline',
    label: 'トレンド',
    icon: '/',
    title: 'トレンドライン: 2点をクリックして線を引きます',
  },
  {
    tool: 'horizontal',
    label: '水平線',
    icon: '-',
    title: '水平線: 価格位置をクリックして水平線を引きます',
  },
  {
    tool: 'fibonacci',
    label: 'フィボ',
    icon: 'FIB',
    title: 'フィボリトレースメント: 高値と安値の2点をクリックします',
  },
];

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

const patternMarker = (pattern: DetectedPattern): SeriesMarker<Time> => ({
  id: pattern.id,
  time: pattern.barTimeRange.to as Time,
  position:
    pattern.direction === 'bullish'
      ? 'belowBar'
      : pattern.direction === 'bearish'
        ? 'aboveBar'
        : 'inBar',
  shape:
    pattern.direction === 'bullish'
      ? 'arrowUp'
      : pattern.direction === 'bearish'
        ? 'arrowDown'
        : 'circle',
  color: patternMarkerColors[pattern.direction],
  text: shortenMarkerTitle(pattern.label),
  size: pattern.strength === 3 ? 1.6 : 1.25,
});

export function ChartPanel({
  bars,
  pair,
  timeframe,
  toggles,
  calendarEvents = emptyCalendarEvents,
  mainSignalAnalysis = null,
  mtf,
  now = Math.floor(Date.now() / 1000),
}: ChartPanelProps) {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const rsiRef = useRef<HTMLDivElement | null>(null);
  const macdRef = useRef<HTMLDivElement | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLineRefs = useRef<IPriceLine[]>([]);
  const chartContextVersionRef = useRef(0);
  const drawingScopeKey = useMemo(
    () => drawingStorageKey(pair, timeframe),
    [pair, timeframe],
  );
  const [chartContext, setChartContext] = useState<MainChartContext | null>(null);
  const [drawingState, setDrawingState] = useState<DrawingState>(() => ({
    key: drawingScopeKey,
    items: loadStoredDrawings(pair, timeframe),
  }));
  const [activeDrawingTool, setActiveDrawingTool] = useState<DrawingTool>('select');
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [pendingDrawingPoint, setPendingDrawingPoint] = useState<DrawingPoint | null>(null);
  const [markerTargetVersion, setMarkerTargetVersion] = useState(0);
  const drawings = drawingState.key === drawingScopeKey ? drawingState.items : [];

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
  const levels = useMemo(
    () => detectSupportResistanceLevels(bars, { lookback: 240, maxLevels: 8 }),
    [bars],
  );
  const displayedLevels = useMemo(
    () => visibleSupportResistanceLevels(levels),
    [levels],
  );
  const activeOverlayLegendItems = useMemo(() => {
    const items: OverlayLegendItem[] = [];
    if (toggles.sma20) {
      items.push({ key: 'sma20', label: 'SMA20', color: lineColors.sma20 });
    }
    if (toggles.sma50) {
      items.push({ key: 'sma50', label: 'SMA50', color: lineColors.sma50 });
    }
    if (toggles.sma200) {
      items.push({ key: 'sma200', label: 'SMA200', color: lineColors.sma200 });
    }
    if (toggles.ema12) {
      items.push({ key: 'ema12', label: 'EMA12', color: lineColors.ema12 });
    }
    if (toggles.ema26) {
      items.push({ key: 'ema26', label: 'EMA26', color: lineColors.ema26 });
    }
    if (toggles.bb) {
      items.push(
        { key: 'bb-upper', label: 'BB上', color: lineColors.bb },
        { key: 'bb-middle', label: 'BB中', color: bbMiddleLineColor },
        { key: 'bb-lower', label: 'BB下', color: lineColors.bb },
      );
    }
    if (toggles.ichimoku) {
      items.push(
        { key: 'tenkan', label: '転換', color: lineColors.tenkan },
        { key: 'kijun', label: '基準', color: lineColors.kijun },
        { key: 'span-a', label: '雲A', color: lineColors.spanA },
        { key: 'span-b', label: '雲B', color: lineColors.spanB },
      );
    }
    if (toggles.supportResistance && displayedLevels.length > 0) {
      items.push({ key: 'support-resistance', label: 'サポレジ', color: 'rgba(142,155,179,0.72)' });
    }
    return items;
  }, [
    displayedLevels.length,
    toggles.bb,
    toggles.ema12,
    toggles.ema26,
    toggles.ichimoku,
    toggles.sma20,
    toggles.sma200,
    toggles.sma50,
    toggles.supportResistance,
  ]);
  const patterns = useMemo(
    () => detectPatterns(bars, { lookback: 120 }),
    [bars],
  );
  const visiblePatterns = useMemo(
    () => patterns.slice(0, 10),
    [patterns],
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
  const patternMarkers = useMemo(
    () => visiblePatterns.map(patternMarker),
    [visiblePatterns],
  );
  const allMarkers = useMemo(
    () =>
      [...newsMarkers, ...patternMarkers].sort(
        (a, b) => Number(a.time) - Number(b.time),
      ),
    [newsMarkers, patternMarkers],
  );
  const selectedDrawingExists = useMemo(
    () => drawings.some((drawing) => drawing.id === selectedDrawingId),
    [drawings, selectedDrawingId],
  );
  const drawingStatus = useMemo(() => {
    if (activeDrawingTool === 'select') {
      return selectedDrawingExists
        ? '選択中の描画を削除できます'
        : '描画をクリックして選択';
    }
    if (activeDrawingTool === 'horizontal') {
      return '水平線を置く価格をクリック';
    }
    return pendingDrawingPoint ? '2点目をクリック' : '1点目をクリック';
  }, [activeDrawingTool, pendingDrawingPoint, selectedDrawingExists]);

  const updateCurrentDrawings = useCallback(
    (updater: (items: Drawing[]) => Drawing[]) => {
      setDrawingState((currentState) =>
        currentState.key === drawingScopeKey
          ? { ...currentState, items: updater(currentState.items) }
          : currentState,
      );
    },
    [drawingScopeKey],
  );

  const handleDrawingToolChange = useCallback((tool: DrawingTool) => {
    setActiveDrawingTool(tool);
    setPendingDrawingPoint(null);
    if (tool !== 'select') {
      setSelectedDrawingId(null);
    }
  }, []);

  const handleDrawingOverlayClick = useCallback(
    (event: DrawingOverlayClick) => {
      if (activeDrawingTool === 'select') {
        setSelectedDrawingId(event.hitDrawingId);
        setPendingDrawingPoint(null);
        return;
      }

      const clickedPoint: DrawingPoint = {
        barTime: event.barTime,
        price: event.price,
      };

      if (activeDrawingTool === 'horizontal') {
        const id = createDrawingId('horizontal');
        const drawing: Drawing = {
          id,
          pair,
          tf: timeframe,
          createdAt: Date.now(),
          type: 'horizontal',
          price: event.price,
        };
        updateCurrentDrawings((items) => [...items, drawing]);
        setSelectedDrawingId(id);
        setPendingDrawingPoint(null);
        return;
      }

      if (!pendingDrawingPoint) {
        setPendingDrawingPoint(clickedPoint);
        setSelectedDrawingId(null);
        return;
      }

      const id = createDrawingId(activeDrawingTool);
      const drawing: Drawing = {
        id,
        pair,
        tf: timeframe,
        createdAt: Date.now(),
        type: activeDrawingTool,
        points: [pendingDrawingPoint, clickedPoint],
      };
      updateCurrentDrawings((items) => [...items, drawing]);
      setSelectedDrawingId(id);
      setPendingDrawingPoint(null);
    },
    [activeDrawingTool, pair, pendingDrawingPoint, timeframe, updateCurrentDrawings],
  );

  const handleDeleteSelectedDrawing = useCallback(() => {
    if (!selectedDrawingId) {
      return;
    }
    updateCurrentDrawings((items) => items.filter((drawing) => drawing.id !== selectedDrawingId));
    setSelectedDrawingId(null);
    setPendingDrawingPoint(null);
  }, [selectedDrawingId, updateCurrentDrawings]);

  const handleClearDrawings = useCallback(() => {
    updateCurrentDrawings(() => []);
    removeStoredDrawings(pair, timeframe);
    setSelectedDrawingId(null);
    setPendingDrawingPoint(null);
  }, [pair, timeframe, updateCurrentDrawings]);

  useEffect(() => {
    setDrawingState({
      key: drawingScopeKey,
      items: loadStoredDrawings(pair, timeframe),
    });
    setSelectedDrawingId(null);
    setPendingDrawingPoint(null);
    setActiveDrawingTool('select');
  }, [drawingScopeKey, pair, timeframe]);

  useEffect(() => {
    if (drawingState.key !== drawingScopeKey) {
      return;
    }
    saveStoredDrawings(pair, timeframe, drawingState.items);
  }, [drawingScopeKey, drawingState, pair, timeframe]);

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
    chartContextVersionRef.current += 1;
    const chartContextVersion = chartContextVersionRef.current;
    setChartContext({
      chart: mainChart,
      series: candleSeries,
      version: chartContextVersion,
    });
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
      const series = chart.addLineSeries({
        color,
        lineWidth: overlayLineWidth,
        title,
        ...hiddenOverlayPriceAxisOptions,
      });
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
      addLine(true, computed.bb.middle, bbMiddleLineColor, 'BB中央');
      addLine(true, computed.bb.lower, lineColors.bb, 'BB下限');
    }

    if (toggles.ichimoku) {
      const stepSeconds = timeframeSeconds[timeframe];
      addLine(true, computed.ichimoku.conversion, lineColors.tenkan, '転換線');
      addLine(true, computed.ichimoku.base, lineColors.kijun, '基準線');
      const spanA = mainChart.addAreaSeries({
        topColor: lineColors.spanA,
        bottomColor: 'rgba(57, 210, 143, 0.01)',
        lineColor: 'rgba(91, 177, 139, 0.42)',
        lineWidth: overlayLineWidth,
        title: '先行スパンA',
        ...hiddenOverlayPriceAxisOptions,
      });
      spanA.setData(toFutureLineData(bars, computed.ichimoku.leadingSpanA, stepSeconds) as AreaData[]);
      const spanB = mainChart.addAreaSeries({
        topColor: lineColors.spanB,
        bottomColor: 'rgba(255, 91, 120, 0.01)',
        lineColor: 'rgba(211, 105, 122, 0.40)',
        lineWidth: overlayLineWidth,
        title: '先行スパンB',
        ...hiddenOverlayPriceAxisOptions,
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
      setChartContext((currentContext) =>
        currentContext?.version === chartContextVersion ? null : currentContext,
      );
      priceLineRefs.current = [];
      resizeObserver.disconnect();
      charts.forEach((chart) => chart.remove());
    };
  }, [
    bars,
    computed,
    pair,
    timeframe,
    toggles.bb,
    toggles.ema12,
    toggles.ema26,
    toggles.ichimoku,
    toggles.sma20,
    toggles.sma200,
    toggles.sma50,
  ]);

  useEffect(() => {
    candleSeriesRef.current?.setMarkers(allMarkers);
  }, [allMarkers, markerTargetVersion]);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) {
      return;
    }

    priceLineRefs.current.forEach((line) => candleSeries.removePriceLine(line));
    priceLineRefs.current = [];

    if (toggles.supportResistance) {
      priceLineRefs.current = displayedLevels.map((level) =>
        candleSeries.createPriceLine(createSupportResistancePriceLineOptions(level)),
      );
    }

    return () => {
      priceLineRefs.current.forEach((line) => candleSeries.removePriceLine(line));
      priceLineRefs.current = [];
    };
  }, [displayedLevels, markerTargetVersion, toggles.supportResistance]);

  return (
    <div className="chart-stack">
      <div className={mtf?.enabled ? 'primary-chart-layout primary-chart-layout-mtf' : 'primary-chart-layout'}>
        <div className="chart-card">
          <div className="chart-heading">
            <span>ローソク足</span>
            <span>{pair} / {timeframe.toUpperCase()}</span>
          </div>
          {activeOverlayLegendItems.length > 0 && (
            <div className="overlay-legend" aria-label="表示中の指標">
              {activeOverlayLegendItems.map((item) => (
                <span key={item.key} className="overlay-legend-chip">
                  <i style={{ background: item.color }} aria-hidden="true" />
                  {item.label}
                </span>
              ))}
            </div>
          )}
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
          <div className="drawing-panel">
            <div className="drawing-toolbar" role="toolbar" aria-label="描画ツール">
              {drawingToolOptions.map((option) => (
                <button
                  key={option.tool}
                  type="button"
                  className={`drawing-tool ${activeDrawingTool === option.tool ? 'drawing-tool-active' : ''}`}
                  title={option.title}
                  aria-label={option.title}
                  aria-pressed={activeDrawingTool === option.tool}
                  onClick={() => handleDrawingToolChange(option.tool)}
                >
                  <span className="drawing-tool-icon" aria-hidden="true">{option.icon}</span>
                  <span>{option.label}</span>
                </button>
              ))}
              <button
                type="button"
                className="drawing-tool drawing-action"
                title="選択削除: 選択中の描画を削除します"
                aria-label="選択削除: 選択中の描画を削除します"
                disabled={!selectedDrawingExists}
                onClick={handleDeleteSelectedDrawing}
              >
                <span className="drawing-tool-icon" aria-hidden="true">DEL</span>
                <span>選択削除</span>
              </button>
              <button
                type="button"
                className="drawing-tool drawing-action"
                title="全削除: この通貨ペアと時間足の描画をすべて削除します"
                aria-label="全削除: この通貨ペアと時間足の描画をすべて削除します"
                disabled={drawings.length === 0}
                onClick={handleClearDrawings}
              >
                <span className="drawing-tool-icon" aria-hidden="true">CLR</span>
                <span>全削除</span>
              </button>
            </div>
            <div className="drawing-status" aria-live="polite">
              <span>{drawingStatus}</span>
              <small>v1制約: 未来バー未対応・クリック位置はバーにスナップ</small>
            </div>
          </div>
          <div ref={mainRef} className="chart-area chart-area-main">
            {chartContext && (
              <DrawingOverlay
                key={chartContext.version}
                chart={chartContext.chart}
                series={chartContext.series}
                drawings={drawings}
                selectedDrawingId={selectedDrawingId}
                bars={bars}
                pair={pair}
                onChartClick={handleDrawingOverlayClick}
              />
            )}
          </div>
        </div>

        {mtf?.enabled && (
          mtf.loading ? (
            <div className="chart-card mtf-placeholder">
              <div className="chart-heading">
                <span>MTF表示</span>
                <span>{pair} / {mtf.timeframe.toUpperCase()}</span>
              </div>
              <div className="mtf-state-message">MTFデータを読み込んでいます...</div>
            </div>
          ) : mtf.error ? (
            <div className="chart-card mtf-placeholder">
              <div className="chart-heading">
                <span>MTF表示</span>
                <span>{pair} / {mtf.timeframe.toUpperCase()}</span>
              </div>
              <div className="mtf-state-message mtf-state-error">{mtf.error}</div>
            </div>
          ) : mtf.bars && mtf.analysis && mainSignalAnalysis ? (
            <MtfMiniChart
              bars={mtf.bars}
              pair={pair}
              timeframe={mtf.timeframe}
              mainTimeframe={timeframe}
              analysis={mtf.analysis}
              mainAnalysis={mainSignalAnalysis}
            />
          ) : (
            <div className="chart-card mtf-placeholder">
              <div className="chart-heading">
                <span>MTF表示</span>
                <span>{pair} / {mtf.timeframe.toUpperCase()}</span>
              </div>
              <div className="mtf-state-message">MTF表示の準備中です...</div>
            </div>
          )
        )}
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
      <section className="analysis-panel" aria-label="検出パターン">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">直近120本</p>
            <h2>検出パターン</h2>
          </div>
          <div className="rating-badge">{visiblePatterns.length}件</div>
        </div>

        {visiblePatterns.length === 0 ? (
          <p className="empty-copy">直近のローソク足・チャートパターンは検出されていません。</p>
        ) : (
          <ul className="signal-list">
            {visiblePatterns.map((pattern) => (
              <li key={pattern.id} className={`signal-item signal-${pattern.direction}`}>
                <div>
                  <strong>{pattern.label}</strong>
                  <p>{pattern.detail}</p>
                </div>
                <span>
                  {patternDirectionLabels[pattern.direction]} / 強度{pattern.strength}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

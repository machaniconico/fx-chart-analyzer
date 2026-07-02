import {
  ColorType,
  createChart,
  IChartApi,
  LineData,
  LineStyle,
  LineWidth,
  Time,
} from 'lightweight-charts';
import type { SupportResistanceLevel } from './levels';
import type { Bar, Timeframe } from '../types';

export const chartLineColors = {
  sma20: '#d8bd69',
  sma50: '#67b9d5',
  sma200: '#d96b81',
  ema12: '#8ac76e',
  ema26: '#b982d0',
  bb: '#8a96ad',
  tenkan: '#d68555',
  kijun: '#73b8ce',
  spanA: 'rgba(57, 210, 143, 0.10)',
  spanB: 'rgba(255, 91, 120, 0.09)',
  rsi: '#f5ce62',
  macd: '#61dafb',
  signal: '#ff9f43',
};

export const overlayLineWidth: LineWidth = 1;

export const hiddenOverlayPriceAxisOptions = {
  lastValueVisible: false,
  priceLineVisible: false,
} as const;

const supportResistanceDisplayLimit = 5;

export const timeframeSeconds: Record<Timeframe, number> = {
  m15: 60 * 15,
  m30: 60 * 30,
  h1: 60 * 60,
  h4: 60 * 60 * 4,
  d1: 60 * 60 * 24,
};

export const toLineData = (bars: readonly Bar[], values: readonly (number | null)[]): LineData[] =>
  values.flatMap((value, index) =>
    value === null || index >= bars.length ? [] : [{ time: bars[index].t as Time, value }],
  );

export const toFutureLineData = (
  bars: readonly Bar[],
  values: readonly (number | null)[],
  stepSeconds: number,
): LineData[] =>
  values.flatMap((value, index) => {
    if (value === null || bars.length === 0) {
      return [];
    }
    const baseTime = index < bars.length ? bars[index].t : bars[bars.length - 1].t + stepSeconds * (index - bars.length + 1);
    return [{ time: baseTime as Time, value }];
  });

export const createBaseChart = (container: HTMLDivElement, height: number): IChartApi =>
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

const priceLineColor = (level: SupportResistanceLevel): string => {
  const alpha = Math.min(0.72, 0.28 + level.strength * 0.08);
  return level.direction === 'support'
    ? `rgba(32, 201, 151, ${alpha.toFixed(2)})`
    : `rgba(255, 91, 120, ${alpha.toFixed(2)})`;
};

const priceLineStyle = (level: SupportResistanceLevel): LineStyle =>
  level.touches >= 3 ? LineStyle.Solid : LineStyle.Dashed;

export const visibleSupportResistanceLevels = (
  levels: readonly SupportResistanceLevel[],
): SupportResistanceLevel[] =>
  [...levels]
    .sort((a, b) => b.strength - a.strength || a.distancePct - b.distancePct)
    .slice(0, supportResistanceDisplayLimit);

export const createSupportResistancePriceLineOptions = (level: SupportResistanceLevel) => ({
  price: level.price,
  color: priceLineColor(level),
  lineWidth: overlayLineWidth,
  lineStyle: priceLineStyle(level),
  axisLabelVisible: false,
  lineVisible: true,
  title: `${level.direction === 'support' ? 'S' : 'R'}×${level.touches}`,
});

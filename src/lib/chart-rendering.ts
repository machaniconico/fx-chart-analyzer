import {
  ColorType,
  createChart,
  IChartApi,
  LineData,
  LineStyle,
  LineWidth,
  Time,
} from 'lightweight-charts';
import { formatPrice } from './chart-data';
import type { SupportResistanceLevel } from './levels';
import type { Bar, Pair, Timeframe } from '../types';

export const chartLineColors = {
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

export const timeframeSeconds: Record<Timeframe, number> = {
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
  const alpha = Math.min(0.9, 0.32 + level.strength * 0.11);
  return level.direction === 'support'
    ? `rgba(32, 201, 151, ${alpha.toFixed(2)})`
    : `rgba(255, 91, 120, ${alpha.toFixed(2)})`;
};

const priceLineWidth = (level: SupportResistanceLevel): LineWidth => {
  if (level.strength >= 5) {
    return 3;
  }
  if (level.strength >= 2.5) {
    return 2;
  }
  return 1;
};

const priceLineStyle = (level: SupportResistanceLevel): LineStyle =>
  level.touches >= 3 ? LineStyle.Solid : LineStyle.Dashed;

export const createSupportResistancePriceLineOptions = (
  pair: Pair,
  level: SupportResistanceLevel,
) => ({
  price: level.price,
  color: priceLineColor(level),
  lineWidth: priceLineWidth(level),
  lineStyle: priceLineStyle(level),
  axisLabelVisible: true,
  lineVisible: true,
  title: `${formatPrice(pair, level.price)} ${level.direction === 'support' ? 'S' : 'R'} ${level.touches}回`,
});

import type { Bar } from '../types';

export type SwingKind = 'high' | 'low';
export type LevelDirection = 'support' | 'resistance';

export interface SwingPoint {
  kind: SwingKind;
  index: number;
  time: number;
  price: number;
}

export interface SupportResistanceLevel {
  id: string;
  price: number;
  direction: LevelDirection;
  touches: number;
  strength: number;
  tolerance: number;
  distance: number;
  distancePct: number;
  lastTouchIndex: number;
  lastTouchTime: number;
  points: SwingPoint[];
}

export interface SwingDetectionOptions {
  lookback?: number;
  pivotStrength?: number;
}

export interface LevelDetectionOptions extends SwingDetectionOptions {
  atrPeriod?: number;
  toleranceAtrMultiplier?: number;
  maxLevels?: number;
  recencyHalfLifeBars?: number;
}

interface LevelCluster {
  points: SwingPoint[];
  weightedPriceTotal: number;
  recencyWeightTotal: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

export const calculateAtr = (bars: readonly Bar[], period = 14): number | null => {
  if (bars.length < 2) {
    return null;
  }

  const start = Math.max(1, bars.length - period);
  const ranges: number[] = [];
  for (let index = start; index < bars.length; index += 1) {
    const previousClose = bars[index - 1].c;
    ranges.push(
      Math.max(
        bars[index].h - bars[index].l,
        Math.abs(bars[index].h - previousClose),
        Math.abs(bars[index].l - previousClose),
      ),
    );
  }

  const atr = mean(ranges);
  return Number.isFinite(atr) && atr > 0 ? atr : null;
};

export const findFractalSwings = (
  bars: readonly Bar[],
  options: SwingDetectionOptions = {},
): SwingPoint[] => {
  const lookback = options.lookback ?? bars.length;
  const pivotStrength = options.pivotStrength ?? 2;
  if (!Number.isInteger(pivotStrength) || pivotStrength < 1 || bars.length < pivotStrength * 2 + 1) {
    return [];
  }

  const start = Math.max(0, bars.length - lookback);
  const first = Math.max(start + pivotStrength, pivotStrength);
  const last = bars.length - pivotStrength - 1;
  const swings: SwingPoint[] = [];

  for (let index = first; index <= last; index += 1) {
    let highPivot = true;
    let lowPivot = true;
    for (let offset = index - pivotStrength; offset <= index + pivotStrength; offset += 1) {
      if (offset === index) {
        continue;
      }
      if (bars[offset].h >= bars[index].h) {
        highPivot = false;
      }
      if (bars[offset].l <= bars[index].l) {
        lowPivot = false;
      }
      if (!highPivot && !lowPivot) {
        break;
      }
    }

    if (highPivot) {
      swings.push({ kind: 'high', index, time: bars[index].t, price: bars[index].h });
    }
    if (lowPivot) {
      swings.push({ kind: 'low', index, time: bars[index].t, price: bars[index].l });
    }
  }

  return swings.sort((a, b) => a.index - b.index || a.price - b.price);
};

const recencyWeight = (pointIndex: number, lastIndex: number, halfLifeBars: number): number => {
  const age = Math.max(0, lastIndex - pointIndex);
  return Math.pow(0.5, age / Math.max(1, halfLifeBars));
};

const clusterKey = (price: number): string => price.toFixed(Math.abs(price) >= 10 ? 3 : 5);

export const detectSupportResistanceLevels = (
  bars: readonly Bar[],
  options: LevelDetectionOptions = {},
): SupportResistanceLevel[] => {
  if (bars.length === 0) {
    return [];
  }

  const lookback = options.lookback ?? 240;
  const pivotStrength = options.pivotStrength ?? 2;
  const maxLevels = options.maxLevels ?? 8;
  const lastIndex = bars.length - 1;
  const currentClose = bars[lastIndex].c;
  const atr = calculateAtr(bars.slice(Math.max(0, bars.length - lookback)), options.atrPeriod ?? 14);
  const fallbackTolerance = Math.max(Math.abs(currentClose) * 0.0015, 0.00001);
  const tolerance = clamp(
    (atr ?? fallbackTolerance) * (options.toleranceAtrMultiplier ?? 0.65),
    Math.max(Math.abs(currentClose) * 0.0004, 0.00001),
    Math.max(Math.abs(currentClose) * 0.02, 0.00005),
  );
  const halfLifeBars = options.recencyHalfLifeBars ?? Math.max(20, Math.floor(lookback / 3));
  const swings = findFractalSwings(bars, { lookback, pivotStrength });
  if (swings.length === 0) {
    return [];
  }

  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters: LevelCluster[] = [];
  for (const point of sorted) {
    const cluster = clusters.find((item) => Math.abs(point.price - item.weightedPriceTotal / item.recencyWeightTotal) <= tolerance);
    const weight = recencyWeight(point.index, lastIndex, halfLifeBars);
    if (cluster) {
      cluster.points.push(point);
      cluster.weightedPriceTotal += point.price * weight;
      cluster.recencyWeightTotal += weight;
    } else {
      clusters.push({
        points: [point],
        weightedPriceTotal: point.price * weight,
        recencyWeightTotal: weight,
      });
    }
  }

  return clusters
    .map<SupportResistanceLevel>((cluster) => {
      const price = cluster.weightedPriceTotal / cluster.recencyWeightTotal;
      const touches = cluster.points.length;
      const lastTouch = cluster.points.reduce((latest, point) => (point.index > latest.index ? point : latest), cluster.points[0]);
      const distance = price - currentClose;
      const distancePct = Math.abs(distance) / Math.max(Math.abs(currentClose), 0.00001);
      const strength = touches * cluster.recencyWeightTotal;
      const direction: LevelDirection = price >= currentClose ? 'resistance' : 'support';
      return {
        id: `${direction}-${clusterKey(price)}-${lastTouch.index}`,
        price,
        direction,
        touches,
        strength,
        tolerance,
        distance: Math.abs(distance),
        distancePct,
        lastTouchIndex: lastTouch.index,
        lastTouchTime: lastTouch.time,
        points: [...cluster.points].sort((a, b) => a.index - b.index),
      };
    })
    .filter((level) => level.touches >= 1)
    .sort((a, b) => b.strength - a.strength || a.distancePct - b.distancePct)
    .slice(0, Math.max(1, maxLevels));
};

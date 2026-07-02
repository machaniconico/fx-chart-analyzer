import type { Bar, Pair, Timeframe } from '../types';

export interface DrawingPoint {
  barTime: number;
  price: number;
}

interface DrawingBase {
  id: string;
  pair: Pair;
  tf: Timeframe;
  createdAt: number;
}

export interface TrendlineDrawing extends DrawingBase {
  type: 'trendline';
  points: [DrawingPoint, DrawingPoint];
}

export interface HorizontalLineDrawing extends DrawingBase {
  type: 'horizontal';
  price: number;
}

export interface FibonacciDrawing extends DrawingBase {
  type: 'fibonacci';
  points: [DrawingPoint, DrawingPoint];
}

export type Drawing = TrendlineDrawing | HorizontalLineDrawing | FibonacciDrawing;

export interface FibonacciLevel {
  ratio: number;
  percent: number;
  label: string;
  price: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export interface DrawingCoordinateMapper {
  timeToX: (barTime: number) => number | null;
  priceToY: (price: number) => number | null;
}

export interface DrawingHitTestOptions {
  tolerance?: number;
  lastBarTime?: number | null;
}

export interface DrawingHitTestResult {
  drawingId: string;
  distance: number;
  hit: boolean;
}

export interface DrawingStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const fibonacciRatios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

const drawingStoragePrefix = 'fx-chart-analyzer:drawings';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const browserStorage = (): DrawingStorage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage;
};

export const createDrawingId = (prefix = 'drawing'): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export const drawingStorageKey = (pair: Pair, tf: Timeframe): string =>
  `${drawingStoragePrefix}:${pair}:${tf}`;

export const calculateFibonacciLevels = (
  points: readonly [DrawingPoint, DrawingPoint],
): FibonacciLevel[] => {
  const high = Math.max(points[0].price, points[1].price);
  const low = Math.min(points[0].price, points[1].price);
  const range = high - low;

  return fibonacciRatios.map((ratio) => ({
    ratio,
    percent: ratio * 100,
    label: `${(ratio * 100).toFixed(ratio === 0 || ratio === 0.5 || ratio === 1 ? 0 : 1)}%`,
    price: high - range * ratio,
  }));
};

export const snapTimeToNearestBar = (
  clickTime: number,
  bars: readonly Pick<Bar, 't'>[],
): number | null => {
  if (!Number.isFinite(clickTime) || bars.length === 0) {
    return null;
  }

  if (clickTime <= bars[0].t) {
    return bars[0].t;
  }
  const lastBarTime = bars[bars.length - 1].t;
  if (clickTime >= lastBarTime) {
    return lastBarTime;
  }

  let low = 0;
  let high = bars.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].t < clickTime) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const next = bars[low];
  const previous = bars[low - 1];
  return clickTime - previous.t <= next.t - clickTime ? previous.t : next.t;
};

export const distancePointToSegment = (
  point: PixelPoint,
  segmentStart: PixelPoint,
  segmentEnd: PixelPoint,
): number => {
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - segmentStart.x, point.y - segmentStart.y);
  }

  const projection = Math.max(
    0,
    Math.min(1, ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) / lengthSquared),
  );
  const projectedX = segmentStart.x + projection * dx;
  const projectedY = segmentStart.y + projection * dy;
  return Math.hypot(point.x - projectedX, point.y - projectedY);
};

export const distancePointToHorizontalLine = (point: PixelPoint, lineY: number): number =>
  Math.abs(point.y - lineY);

const mapDrawingPoint = (
  point: DrawingPoint,
  mapper: DrawingCoordinateMapper,
  lastBarTime: number | null | undefined,
): PixelPoint | null => {
  if (lastBarTime !== null && lastBarTime !== undefined && point.barTime > lastBarTime) {
    return null;
  }
  const x = mapper.timeToX(point.barTime);
  const y = mapper.priceToY(point.price);
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    return null;
  }
  return { x, y };
};

export const drawingDistanceToPoint = (
  drawing: Drawing,
  point: PixelPoint,
  mapper: DrawingCoordinateMapper,
  options: DrawingHitTestOptions = {},
): number => {
  if (drawing.type === 'horizontal') {
    const y = mapper.priceToY(drawing.price);
    return isFiniteNumber(y) ? distancePointToHorizontalLine(point, y) : Number.POSITIVE_INFINITY;
  }

  const first = mapDrawingPoint(drawing.points[0], mapper, options.lastBarTime);
  const second = mapDrawingPoint(drawing.points[1], mapper, options.lastBarTime);
  if (!first || !second) {
    return Number.POSITIVE_INFINITY;
  }

  if (drawing.type === 'trendline') {
    return distancePointToSegment(point, first, second);
  }

  const fromX = Math.min(first.x, second.x);
  const toX = Math.max(first.x, second.x);
  return calculateFibonacciLevels(drawing.points).reduce((minimumDistance, level) => {
    const y = mapper.priceToY(level.price);
    if (!isFiniteNumber(y)) {
      return minimumDistance;
    }
    return Math.min(
      minimumDistance,
      distancePointToSegment(point, { x: fromX, y }, { x: toX, y }),
    );
  }, Number.POSITIVE_INFINITY);
};

export const hitTestDrawing = (
  drawing: Drawing,
  point: PixelPoint,
  mapper: DrawingCoordinateMapper,
  options: DrawingHitTestOptions = {},
): DrawingHitTestResult => {
  const tolerance = options.tolerance ?? 8;
  const distance = drawingDistanceToPoint(drawing, point, mapper, options);
  return {
    drawingId: drawing.id,
    distance,
    hit: distance <= tolerance,
  };
};

export const findHitDrawing = (
  drawings: readonly Drawing[],
  point: PixelPoint,
  mapper: DrawingCoordinateMapper,
  options: DrawingHitTestOptions = {},
): Drawing | null => {
  let bestDrawing: Drawing | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = drawings.length - 1; index >= 0; index -= 1) {
    const result = hitTestDrawing(drawings[index], point, mapper, options);
    if (result.hit && result.distance < bestDistance) {
      bestDrawing = drawings[index];
      bestDistance = result.distance;
    }
  }

  return bestDrawing;
};

const parseDrawingPoint = (value: unknown): DrawingPoint | null => {
  if (!isRecord(value) || !isFiniteNumber(value.barTime) || !isFiniteNumber(value.price)) {
    return null;
  }
  return { barTime: value.barTime, price: value.price };
};

const parseDrawingPoints = (value: unknown): [DrawingPoint, DrawingPoint] | null => {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const first = parseDrawingPoint(value[0]);
  const second = parseDrawingPoint(value[1]);
  return first && second ? [first, second] : null;
};

const parseStoredDrawing = (
  value: unknown,
  pair: Pair,
  tf: Timeframe,
): Drawing | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.pair !== pair ||
    value.tf !== tf ||
    !isFiniteNumber(value.createdAt)
  ) {
    return null;
  }

  if (value.type === 'horizontal') {
    return isFiniteNumber(value.price)
      ? {
          id: value.id,
          pair,
          tf,
          createdAt: value.createdAt,
          type: 'horizontal',
          price: value.price,
        }
      : null;
  }

  if (value.type === 'trendline' || value.type === 'fibonacci') {
    const points = parseDrawingPoints(value.points);
    return points
      ? {
          id: value.id,
          pair,
          tf,
          createdAt: value.createdAt,
          type: value.type,
          points,
        }
      : null;
  }

  return null;
};

export const parseStoredDrawings = (
  value: unknown,
  pair: Pair,
  tf: Timeframe,
): Drawing[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const drawing = parseStoredDrawing(item, pair, tf);
    return drawing ? [drawing] : [];
  });
};

export const loadStoredDrawings = (
  pair: Pair,
  tf: Timeframe,
  storage: DrawingStorage | null = browserStorage(),
): Drawing[] => {
  if (!storage) {
    return [];
  }

  const raw = storage.getItem(drawingStorageKey(pair, tf));
  if (!raw) {
    return [];
  }

  try {
    return parseStoredDrawings(JSON.parse(raw), pair, tf);
  } catch {
    return [];
  }
};

export const saveStoredDrawings = (
  pair: Pair,
  tf: Timeframe,
  drawings: readonly Drawing[],
  storage: DrawingStorage | null = browserStorage(),
): void => {
  if (!storage) {
    return;
  }

  const key = drawingStorageKey(pair, tf);
  if (drawings.length === 0) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify(drawings));
};

export const removeStoredDrawings = (
  pair: Pair,
  tf: Timeframe,
  storage: DrawingStorage | null = browserStorage(),
): void => {
  storage?.removeItem(drawingStorageKey(pair, tf));
};

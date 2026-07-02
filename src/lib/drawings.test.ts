import { describe, expect, it } from 'vitest';
import {
  calculateFibonacciLevels,
  distancePointToHorizontalLine,
  distancePointToSegment,
  drawingStorageKey,
  findHitDrawing,
  hitTestDrawing,
  loadStoredDrawings,
  parseStoredDrawings,
  removeStoredDrawings,
  saveStoredDrawings,
  snapTimeToNearestBar,
  type Drawing,
  type DrawingStorage,
} from './drawings';
import type { Bar } from '../types';

class MemoryStorage implements DrawingStorage {
  readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const bars = (times: readonly number[]): Pick<Bar, 't'>[] =>
  times.map((time) => ({ t: time }));

const baseDrawing = {
  pair: 'USDJPY',
  tf: 'h1',
  createdAt: 1_700_000_000_000,
} as const;

describe('drawings', () => {
  it('calculates fibonacci retracement levels from the high and low prices', () => {
    const levels = calculateFibonacciLevels([
      { barTime: 100, price: 101 },
      { barTime: 200, price: 111 },
    ]);

    expect(levels.map((level) => level.label)).toEqual([
      '0%',
      '23.6%',
      '38.2%',
      '50%',
      '61.8%',
      '78.6%',
      '100%',
    ]);
    expect(levels[0].price).toBe(111);
    expect(levels[3].price).toBe(106);
    expect(levels[6].price).toBe(101);
  });

  it('snaps click time to the nearest bar time', () => {
    const sourceBars = bars([100, 200, 350]);

    expect(snapTimeToNearestBar(50, sourceBars)).toBe(100);
    expect(snapTimeToNearestBar(240, sourceBars)).toBe(200);
    expect(snapTimeToNearestBar(310, sourceBars)).toBe(350);
    expect(snapTimeToNearestBar(500, sourceBars)).toBe(350);
    expect(snapTimeToNearestBar(100, [])).toBeNull();
  });

  it('measures point distance to line segments and horizontal lines in pixel space', () => {
    expect(distancePointToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distancePointToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distancePointToHorizontalLine({ x: 10, y: 42 }, 45)).toBe(3);
  });

  it('hit-tests trendlines, horizontal lines, and fibonacci levels via coordinate mappers', () => {
    const mapper = {
      timeToX: (barTime: number) => barTime,
      priceToY: (price: number) => price,
    };
    const trendline: Drawing = {
      ...baseDrawing,
      id: 'trend',
      type: 'trendline',
      points: [
        { barTime: 0, price: 0 },
        { barTime: 100, price: 0 },
      ],
    };
    const horizontal: Drawing = {
      ...baseDrawing,
      id: 'horizontal',
      type: 'horizontal',
      price: 50,
    };
    const fibonacci: Drawing = {
      ...baseDrawing,
      id: 'fib',
      type: 'fibonacci',
      points: [
        { barTime: 10, price: 100 },
        { barTime: 110, price: 200 },
      ],
    };

    expect(hitTestDrawing(trendline, { x: 40, y: 6 }, mapper, { tolerance: 8 }).hit).toBe(true);
    expect(hitTestDrawing(horizontal, { x: 40, y: 59 }, mapper, { tolerance: 8 }).hit).toBe(false);
    expect(hitTestDrawing(fibonacci, { x: 60, y: 150 }, mapper, { tolerance: 2 }).hit).toBe(true);
    expect(hitTestDrawing(fibonacci, { x: 140, y: 150 }, mapper, { tolerance: 2 }).hit).toBe(false);
  });

  it('finds the nearest topmost drawing within the tolerance', () => {
    const mapper = {
      timeToX: (barTime: number) => barTime,
      priceToY: (price: number) => price,
    };
    const drawings: Drawing[] = [
      {
        ...baseDrawing,
        id: 'older',
        type: 'horizontal',
        price: 100,
      },
      {
        ...baseDrawing,
        id: 'newer',
        type: 'horizontal',
        price: 102,
      },
    ];

    expect(findHitDrawing(drawings, { x: 20, y: 101 }, mapper, { tolerance: 4 })?.id).toBe('newer');
  });

  it('loads, filters, and removes drawings from per-pair timeframe storage', () => {
    const storage = new MemoryStorage();
    const drawing: Drawing = {
      ...baseDrawing,
      id: 'line-1',
      type: 'horizontal',
      price: 145.2,
    };

    saveStoredDrawings('USDJPY', 'h1', [drawing], storage);

    expect(storage.getItem(drawingStorageKey('USDJPY', 'h1'))).not.toBeNull();
    expect(loadStoredDrawings('USDJPY', 'h1', storage)).toEqual([drawing]);
    expect(loadStoredDrawings('EURUSD', 'h1', storage)).toEqual([]);

    removeStoredDrawings('USDJPY', 'h1', storage);
    expect(loadStoredDrawings('USDJPY', 'h1', storage)).toEqual([]);
  });

  it('treats broken JSON and invalid payloads as empty drawings', () => {
    const storage = new MemoryStorage();
    storage.setItem(drawingStorageKey('USDJPY', 'h1'), '{bad json');

    expect(loadStoredDrawings('USDJPY', 'h1', storage)).toEqual([]);
    expect(parseStoredDrawings([{ ...baseDrawing, id: 'bad', type: 'horizontal' }], 'USDJPY', 'h1')).toEqual([]);
  });

  it('removes the storage key when saving an empty drawing list', () => {
    const storage = new MemoryStorage();
    storage.setItem(drawingStorageKey('USDJPY', 'h1'), '[]');

    saveStoredDrawings('USDJPY', 'h1', [], storage);

    expect(storage.getItem(drawingStorageKey('USDJPY', 'h1'))).toBeNull();
  });
});

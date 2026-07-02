import { describe, expect, it } from 'vitest';
import {
  evaluateMtfAlignment,
  getDefaultMtfTimeframe,
  getSelectableMtfTimeframes,
} from './mtf';
import { timeframeSeconds } from './chart-rendering';
import { TIMEFRAMES, timeframeLabels, type Timeframe } from '../types';

describe('mtf', () => {
  it('covers every timeframe in shared labels and duration maps', () => {
    expect(TIMEFRAMES).toEqual(['m15', 'm30', 'h1', 'h4', 'd1']);
    expect(Object.keys(timeframeLabels).sort()).toEqual([...TIMEFRAMES].sort());
    expect(Object.keys(timeframeSeconds).sort()).toEqual([...TIMEFRAMES].sort());
    expect(timeframeSeconds).toMatchObject({
      m15: 15 * 60,
      m30: 30 * 60,
      h1: 60 * 60,
      h4: 4 * 60 * 60,
      d1: 24 * 60 * 60,
    });
  });

  it('chooses the default secondary timeframe without matching the main timeframe', () => {
    const expectedDefaults: Record<Timeframe, Timeframe> = {
      m15: 'h1',
      m30: 'h4',
      h1: 'h4',
      h4: 'd1',
      d1: 'h4',
    };

    for (const item of TIMEFRAMES) {
      expect(getDefaultMtfTimeframe(item)).toBe(expectedDefaults[item]);
      expect(getDefaultMtfTimeframe(item)).not.toBe(item);
      expect(getSelectableMtfTimeframes(item)).toEqual(TIMEFRAMES.filter((timeframe) => timeframe !== item));
    }
  });

  it('marks matching bullish directions as aligned', () => {
    const result = evaluateMtfAlignment({
      mainTimeframe: 'h1',
      secondaryTimeframe: 'h4',
      mainScore: 2,
      secondaryScore: 5,
    });

    expect(result.status).toBe('aligned');
    expect(result.mainDirection).toBe('bullish');
    expect(result.secondaryDirection).toBe('bullish');
    expect(result.summary).toContain('一致');
  });

  it('marks matching bearish directions as aligned', () => {
    const result = evaluateMtfAlignment({
      mainTimeframe: 'h4',
      secondaryTimeframe: 'd1',
      mainScore: -1,
      secondaryScore: -4,
    });

    expect(result.status).toBe('aligned');
    expect(result.mainDirection).toBe('bearish');
    expect(result.secondaryDirection).toBe('bearish');
  });

  it('marks bullish and bearish combinations as diverged', () => {
    const result = evaluateMtfAlignment({
      mainTimeframe: 'h1',
      secondaryTimeframe: 'd1',
      mainScore: 3,
      secondaryScore: -2,
    });

    expect(result.status).toBe('diverged');
    expect(result.summary).toContain('逆行中の可能性');
  });

  it('treats neutral combinations as neutral instead of aligned or diverged', () => {
    expect(
      evaluateMtfAlignment({
        mainTimeframe: 'h1',
        secondaryTimeframe: 'h4',
        mainScore: 0,
        secondaryScore: 2,
      }).status,
    ).toBe('neutral');
    expect(
      evaluateMtfAlignment({
        mainTimeframe: 'h4',
        secondaryTimeframe: 'd1',
        mainScore: -2,
        secondaryScore: 0,
      }).status,
    ).toBe('neutral');
  });
});

import { describe, expect, it } from 'vitest';
import {
  evaluateMtfAlignment,
  getDefaultMtfTimeframe,
  getSelectableMtfTimeframes,
} from './mtf';

describe('mtf', () => {
  it('chooses the default secondary timeframe without matching the main timeframe', () => {
    expect(getDefaultMtfTimeframe('h1')).toBe('h4');
    expect(getDefaultMtfTimeframe('h4')).toBe('d1');
    expect(getDefaultMtfTimeframe('d1')).toBe('h4');
    expect(getSelectableMtfTimeframes('h4')).toEqual(['h1', 'd1']);
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

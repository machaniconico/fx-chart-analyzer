import { describe, expect, it } from 'vitest';
import { analyzeSignals } from './signals';
import type { Bar } from '../types';

const barsFromCloses = (closes: readonly number[]): Bar[] =>
  closes.map((close, index) => ({
    t: index * 3600,
    o: index === 0 ? close : closes[index - 1],
    h: close + 0.25,
    l: close - 0.25,
    c: close,
    v: 1000,
  }));

const signalIds = (bars: readonly Bar[]): string[] =>
  analyzeSignals(bars).signals.map((signal) => signal.id);

describe('signals', () => {
  it('detects an SMA20 x SMA50 golden cross on the latest bar', () => {
    const bars = barsFromCloses([
      ...Array(40).fill(100),
      ...Array(19).fill(99),
      130,
    ]);

    expect(signalIds(bars)).toContain('sma-golden-cross');
  });

  it('detects an SMA20 x SMA50 dead cross on the latest bar', () => {
    const bars = barsFromCloses([
      ...Array(40).fill(100),
      ...Array(19).fill(101),
      70,
    ]);

    expect(signalIds(bars)).toContain('sma-dead-cross');
  });

  it('detects RSI overbought and oversold zones', () => {
    expect(signalIds(barsFromCloses(Array.from({ length: 80 }, (_, index) => 100 + index)))).toContain(
      'rsi-overbought',
    );
    expect(signalIds(barsFromCloses(Array.from({ length: 80 }, (_, index) => 180 - index)))).toContain(
      'rsi-oversold',
    );
  });

  it('detects MACD bullish and bearish crosses on the latest bar', () => {
    expect(signalIds(barsFromCloses([...Array(80).fill(100), 110]))).toContain('macd-bullish-cross');
    expect(signalIds(barsFromCloses([...Array(80).fill(100), 90]))).toContain('macd-bearish-cross');
  });

  it('detects Bollinger Band breaks', () => {
    expect(signalIds(barsFromCloses([...Array(30).fill(100), 130]))).toContain('bb-upper-break');
    expect(signalIds(barsFromCloses([...Array(30).fill(100), 70]))).toContain('bb-lower-break');
  });

  it('detects price above and below the Ichimoku cloud', () => {
    expect(signalIds(barsFromCloses([...Array(90).fill(100), 110]))).toContain('ichimoku-above-cloud');
    expect(signalIds(barsFromCloses([...Array(90).fill(100), 90]))).toContain('ichimoku-below-cloud');
  });

  it('detects proximity to recent swing support and resistance', () => {
    const supportBars = barsFromCloses(Array(90).fill(100));
    supportBars[82] = { ...supportBars[82], h: 97, l: 95, c: 96 };
    supportBars[83] = { ...supportBars[83], h: 98, l: 97, c: 97.5 };
    supportBars[84] = { ...supportBars[84], h: 99, l: 98, c: 98.5 };
    supportBars[89] = { ...supportBars[89], h: 96, l: 95.1, c: 95.2 };

    const resistanceBars = barsFromCloses(Array(90).fill(100));
    resistanceBars[82] = { ...resistanceBars[82], h: 105, l: 103, c: 104 };
    resistanceBars[83] = { ...resistanceBars[83], h: 103, l: 102, c: 102.5 };
    resistanceBars[84] = { ...resistanceBars[84], h: 102, l: 101, c: 101.5 };
    resistanceBars[89] = { ...resistanceBars[89], h: 104.9, l: 104, c: 104.8 };

    expect(signalIds(supportBars)).toContain('support-near');
    expect(signalIds(resistanceBars)).toContain('resistance-near');
  });

  it('returns a five-step rating from the total score', () => {
    const analysis = analyzeSignals(barsFromCloses([...Array(40).fill(100), ...Array(19).fill(99), 130]));

    expect(analysis.rating.label).toMatch(/買い|強い買い|中立|売り/);
    expect(analysis.score).toBe(
      analysis.signals.reduce((total, signal) => total + signal.weight, 0),
    );
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  barsThroughTime,
  buildMonthlySimulation,
  buildScannerStats,
  judgeRecommendationOutcome,
  scannerPairs,
} from './build-scanner-stats.mjs';

const time = (iso) => Math.floor(Date.parse(iso) / 1000);

const bar = (iso, close = 100, patch = {}) => ({
  t: time(iso),
  o: close,
  h: close + 0.5,
  l: close - 0.5,
  c: close,
  v: 1000,
  ...patch,
});

const recommendation = (patch = {}) => ({
  pair: 'USDJPY',
  style: 'デイトレ',
  direction: '買い',
  score: 65,
  expectation: { tier: 'medium', label: '中', detail: '' },
  entry: { type: 'market', price: 100 },
  slPips: 100,
  tpPips: 200,
  slPrice: 99,
  tpPrice: 102,
  riskReward: 2,
  reasons: [],
  dataUpdatedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

const styleDefinitions = {
  daytrade: {
    label: 'デイトレ',
    executionTimeframe: 'm30',
    environmentTimeframe: 'h4',
    predictionHorizon: 5,
  },
  swing: {
    label: 'スイング',
    executionTimeframe: 'h4',
    environmentTimeframe: 'd1',
    predictionHorizon: 20,
  },
};

const dataForAllPairs = ({ m30, h4, d1 }) =>
  Object.fromEntries(
    scannerPairs.map((pair) => [
      pair,
      {
        m15: { pair, tf: 'm15', updatedAt: '', bars: m30 },
        m30: { pair, tf: 'm30', updatedAt: '', bars: m30 },
        h1: { pair, tf: 'h1', updatedAt: '', bars: m30 },
        h4: { pair, tf: 'h4', updatedAt: '', bars: h4 },
        d1: { pair, tf: 'd1', updatedAt: '', bars: d1 },
      },
    ]),
  );

describe('scanner stats builder', () => {
  it('passes only cutoff bars into walk-forward scanner calls', async () => {
    const m30 = [
      bar('2026-01-01T22:30:00Z', 100),
      bar('2026-01-02T22:30:00Z', 100, { h: 103, l: 100, c: 102 }),
      bar('2026-01-03T22:30:00Z', 101),
    ];
    const h4 = [
      bar('2026-01-01T16:00:00Z', 100),
      bar('2026-01-02T20:00:00Z', 100),
      bar('2026-01-02T23:00:00Z', 100),
    ];
    const d1 = [bar('2026-01-01T00:00:00Z', 100), bar('2026-01-02T00:00:00Z', 100)];
    const callTimes = [];

    await buildScannerStats({
      recommendationStyles: styleDefinitions,
      data: dataForAllPairs({ m30, h4, d1 }),
      useRollingAdaptiveStats: false,
      scanPair: ({ pair, style, executionBars, environmentBars }) => {
        const decisionTime = executionBars[executionBars.length - 1]?.t;
        expect(executionBars.every((item) => item.t <= decisionTime)).toBe(true);
        expect(environmentBars.every((item) => item.t + 4 * 60 * 60 <= decisionTime)).toBe(true);
        callTimes.push({ pair, style, decisionTime, environmentLast: environmentBars.at(-1)?.t });
        if (pair !== 'USDJPY' || style !== 'daytrade' || decisionTime !== m30[0].t) {
          return null;
        }
        return recommendation({ dataUpdatedAt: new Date(decisionTime * 1000).toISOString() });
      },
    });

    const firstCall = callTimes.find((item) => item.pair === 'USDJPY' && item.style === 'daytrade');
    expect(firstCall).toMatchObject({
      decisionTime: m30[0].t,
      environmentLast: h4[0].t,
    });
  });

  it('excludes forming environment bars from the scanner cutoff', () => {
    const h4 = [
      bar('2026-01-01T16:00:00Z', 100),
      bar('2026-01-01T20:00:00Z', 100),
    ];

    expect(barsThroughTime(h4, time('2026-01-01T22:30:00Z'), 4 * 60 * 60)).toEqual([
      h4[0],
    ]);
  });

  it('uses the pessimistic SL result when TP and SL are hit in the same bar', () => {
    const result = judgeRecommendationOutcome({
      recommendation: recommendation({ decisionTime: time('2026-01-05T00:00:00Z') }),
      maxHoldingBusinessDays: 5,
      futureBars: [
        bar('2026-01-05T00:30:00Z', 100, {
          h: 103,
          l: 98,
          c: 102,
        }),
      ],
    });

    expect(result).toMatchObject({
      outcome: 'loss',
      exitReason: 'sl',
      exitPrice: 99,
      realizedR: -1,
    });
    expect(result?.spreadPips).toBe(0.9);
  });

  it('fills market entries at the next bar open and applies fixed spread to realized R', () => {
    const result = judgeRecommendationOutcome({
      recommendation: recommendation({ decisionTime: time('2026-01-05T00:00:00Z') }),
      maxHoldingBusinessDays: 5,
      futureBars: [
        bar('2026-01-05T00:30:00Z', 100.5, {
          o: 100.5,
          h: 102.2,
          l: 100.2,
          c: 102,
        }),
      ],
    });

    expect(result).toMatchObject({
      outcome: 'win',
      exitReason: 'tp',
      entryTime: time('2026-01-05T00:30:00Z'),
      signalEntryPrice: 100.5,
      spreadPips: 0.9,
      exitPrice: 102,
    });
    expect(result?.entryPrice).toBeCloseTo(100.509, 6);
    expect(result?.realizedR).toBeCloseTo(0.988072, 6);
  });

  it('does not count a take profit that only prints on the pullback fill bar', () => {
    const result = judgeRecommendationOutcome({
      recommendation: recommendation({
        decisionTime: time('2026-01-05T00:00:00Z'),
        entry: {
          type: 'pullback',
          price: 100,
          zone: { low: 99.9, high: 100.1 },
        },
        slPrice: 99.5,
        tpPrice: 101,
      }),
      maxHoldingBusinessDays: 5,
      futureBars: [
        // Fill bar: high spikes to the TP (101.2 >= 101) but the low reaches the
        // limit zone, so the limit could only have filled after that spike. TP is
        // not credited on this bar; only SL is judged here.
        bar('2026-01-05T00:30:00Z', 100.5, { o: 100.5, h: 101.2, l: 100.0, c: 100.2 }),
        // Next bar takes the stop, so the honest outcome is a loss.
        bar('2026-01-05T01:00:00Z', 99.8, { o: 99.8, h: 99.9, l: 99.4, c: 99.5 }),
      ],
    });

    expect(result).toMatchObject({
      outcome: 'loss',
      exitReason: 'sl',
      entryTime: time('2026-01-05T00:30:00Z'),
      signalEntryPrice: 100,
      exitPrice: 99.5,
    });
    expect(result?.realizedR).toBeCloseTo(-1, 2);
  });

  it('waits for pullback entries to reach the zone before judging outcomes', () => {
    const result = judgeRecommendationOutcome({
      recommendation: recommendation({
        decisionTime: time('2026-01-05T00:00:00Z'),
        entry: {
          type: 'pullback',
          price: 100,
          zone: { low: 99.9, high: 100.1 },
        },
      }),
      maxHoldingBusinessDays: 5,
      futureBars: [
        bar('2026-01-05T00:30:00Z', 101, {
          h: 101.4,
          l: 100.2,
          c: 101,
        }),
        bar('2026-01-05T01:00:00Z', 100, {
          h: 100.5,
          l: 99.95,
          c: 100.2,
        }),
        bar('2026-01-05T01:30:00Z', 101.5, {
          h: 102.2,
          l: 101,
          c: 102,
        }),
      ],
    });

    expect(result).toMatchObject({
      outcome: 'win',
      exitReason: 'tp',
      entryTime: time('2026-01-05T01:00:00Z'),
      signalEntryPrice: 100,
      spreadPips: 0.9,
    });
    expect(result?.entryPrice).toBeCloseTo(100.009, 6);
    expect(result?.realizedR).toBeCloseTo(1.973241, 6);
  });

  it('clamps pullback fill prices to the reached bar range', () => {
    const result = judgeRecommendationOutcome({
      recommendation: recommendation({
        decisionTime: time('2026-01-05T00:00:00Z'),
        entry: {
          type: 'pullback',
          price: 100,
          zone: { low: 99.5, high: 100.5 },
        },
      }),
      maxHoldingBusinessDays: 5,
      futureBars: [
        bar('2026-01-05T00:30:00Z', 99.7, {
          h: 99.8,
          l: 99.4,
          c: 99.7,
        }),
        bar('2026-01-05T01:00:00Z', 101.5, {
          h: 102.2,
          l: 101,
          c: 102,
        }),
      ],
    });

    expect(result).toMatchObject({
      outcome: 'win',
      entryTime: time('2026-01-05T00:30:00Z'),
      signalEntryPrice: 99.8,
      spreadPips: 0.9,
    });
    expect(result?.entryPrice).toBeCloseTo(99.809, 6);
  });

  it('returns unfilled for pullback entries that never reach the zone inside the holding window', () => {
    const result = judgeRecommendationOutcome({
      recommendation: recommendation({
        decisionTime: time('2026-01-05T00:00:00Z'),
        entry: {
          type: 'pullback',
          price: 100,
          zone: { low: 99.9, high: 100.1 },
        },
      }),
      maxHoldingBusinessDays: 1,
      futureBars: [
        bar('2026-01-05T00:30:00Z', 101, {
          h: 101.4,
          l: 100.2,
          c: 101,
        }),
        bar('2026-01-06T00:30:00Z', 101, {
          h: 101.5,
          l: 100.2,
          c: 101,
        }),
      ],
    });

    expect(result).toMatchObject({
      outcome: 'unfilled',
      exitReason: 'unfilled',
      entryType: 'pullback',
    });
  });

  it('books monthly simulation P/L in the exit month', () => {
    const result = buildMonthlySimulation({
      mode: 'mediumOrHigher',
      endMonth: '2026-02',
      monthCount: 2,
      trades: [
        {
          pair: 'USDJPY',
          style: 'daytrade',
          expectationTier: 'medium',
          outcome: 'win',
          realizedR: 1,
          entryTime: time('2026-01-31T23:00:00Z'),
          exitTime: time('2026-02-01T00:30:00Z'),
        },
      ],
    });

    expect(result.months).toEqual([
      expect.objectContaining({ month: '2026-01', pnlYen: 0, wins: 0, losses: 0 }),
      expect.objectContaining({ month: '2026-02', pnlYen: 10000, wins: 1, losses: 0 }),
    ]);
    expect(result.summary.totalPnlYen).toBe(10000);
  });

  it('summarizes monthly simulation over active months within the displayed period', () => {
    const result = buildMonthlySimulation({
      mode: 'mediumOrHigher',
      endMonth: '2026-04',
      monthCount: 4,
      trades: [
        {
          pair: 'USDJPY',
          style: 'daytrade',
          expectationTier: 'medium',
          outcome: 'win',
          realizedR: 1,
          entryTime: time('2026-01-10T00:00:00Z'),
          exitTime: time('2026-01-10T00:30:00Z'),
        },
        {
          pair: 'USDJPY',
          style: 'daytrade',
          expectationTier: 'medium',
          outcome: 'loss',
          realizedR: -0.5,
          entryTime: time('2026-03-10T00:00:00Z'),
          exitTime: time('2026-03-10T00:30:00Z'),
        },
      ],
    });

    expect(result.summary).toMatchObject({
      periodStartMonth: '2026-01',
      periodEndMonth: '2026-04',
      activeMonths: 2,
      plusMonthRate: 0.5,
      averageMonthlyPnlYen: 2475,
      totalPnlYen: 4950,
      bestMonth: { month: '2026-01', pnlYen: 10000 },
      worstMonth: { month: '2026-03', pnlYen: -5050 },
    });
  });

  it('clamps the monthly simulation window to the real data period', () => {
    const result = buildMonthlySimulation({
      mode: 'mediumOrHigher',
      startMonth: '2026-03',
      endMonth: '2026-04',
      monthCount: 12,
      trades: [],
    });

    expect(result.months.map((item) => item.month)).toEqual(['2026-03', '2026-04']);
    expect(result.summary).toMatchObject({
      periodStartMonth: '2026-03',
      periodEndMonth: '2026-04',
      activeMonths: 0,
      plusMonthRate: null,
    });
  });

  it('validates the generated public scanner stats schema', async () => {
    const payload = JSON.parse(await readFile('public/data/stats/scanner.json', 'utf8'));

    expect(payload.version).toBe(1);
    expect(typeof payload.generatedAt).toBe('string');
    expect(payload.pairStyle.USDJPY.daytrade.recommendations).toEqual(expect.any(Number));
    expect(payload.styleTier.daytrade.medium.winRate === null || typeof payload.styleTier.daytrade.medium.winRate === 'number').toBe(true);
    expect(payload.monthlySimulation.mediumOrHigher.months.length).toBeLessThanOrEqual(12);
    expect(payload.monthlySimulation.highOnly.months.length).toBeLessThanOrEqual(12);
    expect(payload.monthlySimulation.mediumOrHigher.summary.periodStartMonth).toEqual(expect.any(String));
    expect(payload.meta.spreadPips.USDJPY).toBe(0.9);
  });
});

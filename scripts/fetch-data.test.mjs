import { describe, expect, it, vi } from 'vitest';
import {
  PRIMARY_STALE_LIMIT_HOURS_BY_TIMEFRAME,
  aggregateDailyFromH1,
  aggregateH4,
  buildSourceHealth,
  fetchDailyWithFallback,
  fetchH1AndH4WithFallback,
  fetchTimeframe,
  mergeAppendOnlyBars,
  normalizeYahooChartResponse,
  repairDailyClosesFromNextOpen,
  withTimeout,
} from './fetch-data.mjs';

const NOW = Date.UTC(2026, 6, 27, 21, 52, 0);

const makeBars = ({ count, endTime, stepSeconds, price = 100 }) =>
  Array.from({ length: count }, (_, index) => {
    const t = endTime - (count - index - 1) * stepSeconds;
    const value = price + index / 10_000;
    return { t, o: value, h: value + 1, l: value - 1, c: value + 0.5, v: 10 };
  });

describe('source health aggregation', () => {
  it('counts successful timeframe sources and records Dukascopy success by timeframe', () => {
    expect(
      buildSourceHealth({
        sources: [
          { timeframe: 'm15', source: 'yahoo-fallback' },
          { timeframe: 'm30', source: 'dukascopy' },
          { timeframe: 'h1', source: 'dukascopy' },
          { timeframe: 'h4', source: 'yahoo-fallback' },
          { timeframe: 'd1', source: 'dukascopy' },
        ],
        previousHealth: { lastPrimarySuccessAt: '2026-07-20T21:00:00.000Z' },
        nowMs: NOW,
      }),
    ).toEqual({
      updatedAt: '2026-07-27T21:52:00.000Z',
      timeframeTrackingSince: '2026-07-27T21:52:00.000Z',
      sources: { dukascopy: 3, 'yahoo-fallback': 2 },
      primaryOkThisRun: true,
      lastPrimarySuccessAt: '2026-07-27T21:52:00.000Z',
      lastPrimarySuccessByTimeframe: {
        m15: null,
        m30: '2026-07-27T21:52:00.000Z',
        h1: '2026-07-27T21:52:00.000Z',
        h4: null,
        d1: '2026-07-27T21:52:00.000Z',
      },
    });
  });

  it('carries the previous success forward when this run has no Dukascopy data', () => {
    const lastPrimarySuccessAt = '2026-07-24T21:00:00.000Z';
    const timeframeTrackingSince = '2026-07-20T21:00:00.000Z';
    const lastPrimarySuccessByTimeframe = {
      m15: '2026-07-23T21:00:00.000Z',
      m30: '2026-07-24T21:00:00.000Z',
      h1: '2026-07-24T21:00:00.000Z',
      h4: '2026-07-24T21:00:00.000Z',
      d1: '2026-07-22T21:00:00.000Z',
    };

    const result = buildSourceHealth({
      sources: [
        { timeframe: 'm15', source: 'yahoo-fallback' },
        { timeframe: 'm30', source: 'yahoo-fallback' },
      ],
      previousHealth: {
        lastPrimarySuccessAt,
        lastPrimarySuccessByTimeframe,
        timeframeTrackingSince,
      },
      nowMs: NOW,
    });

    expect(result.lastPrimarySuccessAt).toBe(lastPrimarySuccessAt);
    expect(result.timeframeTrackingSince).toBe(timeframeTrackingSince);
    expect(result.lastPrimarySuccessByTimeframe).toEqual(lastPrimarySuccessByTimeframe);
  });

  it('uses null when this run has no Dukascopy data and no previous success', () => {
    const result = buildSourceHealth({
      sources: [{ timeframe: 'm15', source: 'yahoo-fallback' }],
      previousHealth: null,
      nowMs: NOW,
    });

    expect(result.lastPrimarySuccessAt).toBeNull();
    expect(result.lastPrimarySuccessByTimeframe).toEqual({
      m15: null,
      m30: null,
      h1: null,
      h4: null,
      d1: null,
    });
  });
});

const yahooFixture = ({ timestamps, open, high, low, close }) => ({
  chart: {
    result: [
      {
        timestamp: timestamps,
        indicators: {
          quote: [
            {
              open,
              high,
              low,
              close,
            },
          ],
        },
      },
    ],
    error: null,
  },
});

describe('Yahoo Finance fallback normalization', () => {
  it('drops null, unaligned, and still-forming bars while setting volume to zero', () => {
    const base = 1_800_000_000;
    const bars = normalizeYahooChartResponse(
      yahooFixture({
        timestamps: [
          base,
          base + 900,
          base + 1800 + 8,
          base + 2700,
          base + 4500,
        ],
        open: [100, null, 102, 103, 104],
        high: [101, null, 103, 104, 105],
        low: [99, null, 101, 102, 103],
        close: [100.5, null, 102.5, 103.5, 104.5],
      }),
      'm15',
      { nowSeconds: base + 5000 },
    );

    expect(bars).toEqual([
      { t: base, o: 100, h: 101, l: 99, c: 100.5, v: 0 },
      { t: base + 2700, o: 103, h: 104, l: 102, c: 103.5, v: 0 },
    ]);
  });

  it('rejects malformed chart payloads', () => {
    expect(() => normalizeYahooChartResponse({ chart: { result: [] } }, 'm30')).toThrow(
      /malformed chart response/,
    );
  });

  it('normalizes Yahoo daily bars to UTC day starts, dedupes by day, and drops the current day', () => {
    const daySeconds = 24 * 60 * 60;
    const jan1At2300 = Date.UTC(2026, 0, 1, 23) / 1000;
    const jan2At2300 = Date.UTC(2026, 0, 2, 23) / 1000;
    const jan3At2300 = Date.UTC(2026, 0, 3, 23) / 1000;
    expect(jan1At2300 % daySeconds).toBe(82_800);

    const bars = normalizeYahooChartResponse(
      yahooFixture({
        timestamps: [jan1At2300, jan1At2300, jan2At2300, jan3At2300],
        open: [100, 101, 102, 103],
        high: [101, 102, 103, 104],
        low: [99, 100, 101, 102],
        close: [100.5, 101.5, 102.5, 103.5],
      }),
      'd1',
      { nowSeconds: Date.UTC(2026, 0, 4, 10) / 1000 },
    );

    expect(bars).toEqual([
      {
        t: Date.UTC(2026, 0, 2) / 1000,
        o: 101,
        h: 102,
        l: 100,
        c: 101.5,
        v: 0,
      },
      {
        t: Date.UTC(2026, 0, 3) / 1000,
        o: 102,
        h: 103,
        l: 101,
        c: 102.5,
        v: 0,
      },
    ]);
  });
});

describe('append-only Yahoo fallback merge', () => {
  it('keeps pre-tail bars untouched and appends only bars strictly after the tail', () => {
    const existingBars = [
      { t: 100, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: 200, o: 2, h: 3, l: 1.5, c: 2.5, v: 20 },
    ];
    const incomingBars = [
      { t: 300, o: 3, h: 4, l: 2.5, c: 3.5, v: 0 },
      { t: 400, o: 4, h: 5, l: 3.5, c: 4.5, v: 0 },
    ];

    expect(mergeAppendOnlyBars(existingBars, incomingBars)).toEqual([
      existingBars[0],
      existingBars[1],
      incomingBars[0],
      incomingBars[1],
    ]);
  });

  it('replaces a frozen final bar when the incoming feed carries the same timestamp', () => {
    // The last existing bar was persisted mid-formation; the fresh feed has the complete
    // bar for that same timestamp plus later bars. The stale tail must be swapped out.
    const existingBars = [
      { t: 100, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: 200, o: 2, h: 2.4, l: 1.9, c: 2.1, v: 5 },
    ];
    const incomingBars = [
      { t: 200, o: 2, h: 3, l: 1.5, c: 2.5, v: 20 },
      { t: 300, o: 3, h: 4, l: 2.5, c: 3.5, v: 0 },
    ];

    expect(mergeAppendOnlyBars(existingBars, incomingBars)).toEqual([
      existingBars[0],
      incomingBars[0],
      incomingBars[1],
    ]);
  });
});

describe('Dukascopy primary response gates', () => {
  const hour = 60 * 60;
  const day = 24 * hour;
  const nowMs = Date.UTC(2026, 8, 1, 12);
  const nowSeconds = nowMs / 1000;

  it('falls back to Yahoo when a d1 response is stale without throwing at the source', async () => {
    const stalePrimary = makeBars({
      count: 2000,
      endTime: nowSeconds - 121 * hour,
      stepSeconds: day,
    });
    const yahooDaily = makeBars({
      count: 1502,
      endTime: nowSeconds,
      stepSeconds: day,
      price: 200,
    });
    const fetchPrimary = vi.fn(async () => stalePrimary);
    const fetchYahoo = vi.fn(async () => yahooDaily);
    const readExisting = vi.fn(async () => null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchDailyWithFallback('AUDJPY', {
      fetchPrimary,
      fetchYahoo,
      readExisting,
      nowMs,
    });

    expect(fetchYahoo).toHaveBeenCalledOnce();
    expect(fetchYahoo).toHaveBeenCalledWith('AUDJPY', 'd1');
    expect(result.source).toBe('yahoo-fallback');
    expect(result.bars.at(-1).t).toBe(yahooDaily.at(-2).t);
    expect(result.bars.at(-1).o).toBe(yahooDaily.at(-2).o);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'stale primary response: AUDJPY d1 latest=',
      ),
    );
    expect(warn.mock.calls[0][0]).toContain(
      `ageHours=121.0 limit=${PRIMARY_STALE_LIMIT_HOURS_BY_TIMEFRAME.d1}`,
    );
  });

  it('falls back to Yahoo for both h1 and h4 when the primary response is stale', async () => {
    const stalePrimaryH1 = makeBars({
      count: 8000,
      endTime: nowSeconds - 121 * hour,
      stepSeconds: hour,
    });
    const yahooH1 = makeBars({
      count: 8000,
      endTime: nowSeconds - hour,
      stepSeconds: hour,
      price: 200,
    });
    const fetchPrimary = vi.fn(async () => stalePrimaryH1);
    const fetchYahoo = vi.fn(async () => yahooH1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchH1AndH4WithFallback('GBPUSD', {
      fetchPrimary,
      fetchYahoo,
      readExisting: async () => null,
      nowMs,
    });

    expect(fetchYahoo).toHaveBeenCalledOnce();
    expect(fetchYahoo).toHaveBeenCalledWith('GBPUSD', 'h1');
    expect(result.h1.source).toBe('yahoo-fallback');
    expect(result.h4.source).toBe('yahoo-fallback');
    expect(result.h1.bars.at(-1).t).toBe(yahooH1.at(-1).t);
    expect(result.h4.bars.at(-1).t).toBe(aggregateH4(yahooH1).at(-1).t);
    expect(warn.mock.calls[0][0]).toContain('stale primary response: GBPUSD h1 latest=');
  });

  it('applies the h4 freshness gate when h1 is exactly at its limit', async () => {
    const boundaryNowMs = Date.UTC(2026, 8, 1, 15);
    const boundaryNowSeconds = boundaryNowMs / 1000;
    const primaryH1 = makeBars({
      count: 8000,
      endTime: boundaryNowSeconds - PRIMARY_STALE_LIMIT_HOURS_BY_TIMEFRAME.h1 * hour,
      stepSeconds: hour,
    });
    const yahooH1 = makeBars({
      count: 8000,
      endTime: boundaryNowSeconds - hour,
      stepSeconds: hour,
      price: 200,
    });
    const fetchYahoo = vi.fn(async () => yahooH1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchH1AndH4WithFallback('GBPJPY', {
      fetchPrimary: async () => primaryH1,
      fetchYahoo,
      readExisting: async () => null,
      nowMs: boundaryNowMs,
    });

    expect(fetchYahoo).toHaveBeenCalledOnce();
    expect(result.h1.source).toBe('yahoo-fallback');
    expect(result.h4.source).toBe('yahoo-fallback');
    expect(warn.mock.calls[0][0]).toContain(
      `stale primary response: GBPJPY h4 latest=`,
    );
    expect(warn.mock.calls[0][0]).toContain(
      `ageHours=123.0 limit=${PRIMARY_STALE_LIMIT_HOURS_BY_TIMEFRAME.h4}`,
    );
  });

  it('rejects a fresh primary response that regresses behind the existing file', async () => {
    const existingEnd = Date.UTC(2026, 7, 31) / 1000;
    const existingBars = makeBars({ count: 2000, endTime: existingEnd, stepSeconds: day });
    const regressedPrimary = makeBars({
      count: 2000,
      endTime: existingEnd - day,
      stepSeconds: day,
      price: 150,
    });
    const yahooH1 = makeBars({
      count: 24,
      endTime: existingEnd + 23 * hour,
      stepSeconds: hour,
      price: 200,
    });
    const fetchYahoo = vi.fn(async () => yahooH1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchDailyWithFallback('EURUSD', {
      fetchPrimary: async () => regressedPrimary,
      fetchYahoo,
      readExisting: async () => existingBars,
      nowMs,
    });

    expect(fetchYahoo).toHaveBeenCalledWith('EURUSD', 'h1');
    expect(result.source).toBe('yahoo-fallback');
    expect(result.bars.at(-1).t).toBe(existingEnd);
    expect(result.bars.at(-1).o).toBe(yahooH1[0].o);
    expect(result.bars).not.toEqual(regressedPrimary);
  });

  it('keeps a fresh non-regressing response as Dukascopy data', async () => {
    const primaryEnd = Date.UTC(2026, 7, 31) / 1000;
    const primaryBars = makeBars({ count: 2000, endTime: primaryEnd, stepSeconds: day });
    const existingBars = makeBars({
      count: 2000,
      endTime: primaryEnd - day,
      stepSeconds: day,
    });
    const fetchYahoo = vi.fn();

    const result = await fetchDailyWithFallback('USDJPY', {
      fetchPrimary: async () => primaryBars,
      fetchYahoo,
      readExisting: async () => existingBars,
      nowMs,
    });

    expect(fetchYahoo).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'dukascopy', bars: primaryBars });
  });

  it('accepts a normal Monday-morning d1 response across a weekend longer than 72 hours', async () => {
    const mondayMorning = Date.UTC(2026, 8, 7, 8);
    const fridayStart = Date.UTC(2026, 8, 4) / 1000;
    const primaryBars = makeBars({ count: 2000, endTime: fridayStart, stepSeconds: day });
    const fetchYahoo = vi.fn();

    const result = await fetchDailyWithFallback('EURJPY', {
      fetchPrimary: async () => primaryBars,
      fetchYahoo,
      readExisting: async () => null,
      nowMs: mondayMorning,
    });

    expect((mondayMorning / 1000 - fridayStart) / hour).toBe(80);
    expect(PRIMARY_STALE_LIMIT_HOURS_BY_TIMEFRAME.d1).toBeGreaterThan(80);
    expect(fetchYahoo).not.toHaveBeenCalled();
    expect(result.source).toBe('dukascopy');
  });
});

describe('Yahoo d1 fallback never reads Yahoo daily close directly', () => {
  const hour = 60 * 60;
  const h1Bar = (t, o, h, l, c) => ({ t, o, h, l, c, v: 0 });

  it('aggregateDailyFromH1 derives each daily close from the last h1 close, dropping the current day', () => {
    const day1 = Date.UTC(2026, 0, 1) / 1000;
    const day2 = Date.UTC(2026, 0, 2) / 1000;
    const day3 = Date.UTC(2026, 0, 3) / 1000;
    const bars = aggregateDailyFromH1(
      [
        h1Bar(day1, 100, 101, 99, 100.4),
        h1Bar(day1 + hour, 100.4, 100.9, 100.2, 100.7),
        h1Bar(day1 + 23 * hour, 100.7, 101.5, 100.6, 101.2), // day1 true close
        h1Bar(day2, 101.2, 101.3, 100.8, 101.0),
        h1Bar(day2 + 23 * hour, 101.0, 101.1, 100.5, 100.6), // day2 true close
        h1Bar(day3, 100.6, 100.8, 100.4, 100.5), // still-forming current day
      ],
      { nowSeconds: day3 + hour },
    );

    expect(bars).toEqual([
      { t: day1, o: 100, h: 101.5, l: 99, c: 101.2, v: 0 },
      { t: day2, o: 101.2, h: 101.3, l: 100.5, c: 100.6, v: 0 },
    ]);
  });

  it('repairDailyClosesFromNextOpen sets close(D)=open(D+1) and drops the unrepairable final bar', () => {
    const day = 86400;
    const dailyRaw = [
      { t: day, o: 100, h: 102, l: 99, c: 100.05, v: 0 }, // Yahoo doji close (snapshot)
      { t: day * 2, o: 101, h: 103, l: 100, c: 101.02, v: 0 },
      { t: day * 3, o: 102, h: 104, l: 101, c: 102.01, v: 0 },
    ];

    expect(repairDailyClosesFromNextOpen(dailyRaw)).toEqual([
      { t: day, o: 100, h: 102, l: 99, c: 101, v: 0 },
      { t: day * 2, o: 101, h: 103, l: 100, c: 102, v: 0 },
    ]);
  });
});

describe('Dukascopy timeout guard', () => {
  it('absorbs late source rejections after the timeout wins', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      let rejectSource;
      const source = new Promise((_, reject) => {
        rejectSource = reject;
      });

      await expect(withTimeout(source, 1, 'timed out')).rejects.toThrow('timed out');
      rejectSource(new Error('late source failure'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('Dukascopy request options', () => {
  it('disables the dukascopy-node retry path', async () => {
    const fetchRates = vi.fn(async () => []);

    await fetchTimeframe('USDJPY', 'm15', 60, { fetchRates });

    expect(fetchRates).toHaveBeenCalledOnce();
    expect(fetchRates.mock.calls[0][0]).toMatchObject({
      retryCount: 0,
      retryOnEmpty: false,
    });
  });
});

describe('Yahoo h4 aggregation', () => {
  const h1Bar = (t, close) => ({
    t,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: 0,
  });

  it('drops the trailing h4 bucket when Yahoo h1 data only partially fills it', () => {
    const start = Date.UTC(2026, 0, 1) / 1000;
    const hour = 60 * 60;
    const bars = aggregateH4(
      [
        h1Bar(start, 100),
        h1Bar(start + hour, 101),
        h1Bar(start + 2 * hour, 102),
        h1Bar(start + 3 * hour, 103),
        h1Bar(start + 4 * hour, 104),
      ],
      { dropIncompleteTail: true },
    );

    expect(bars).toEqual([
      {
        t: start,
        o: 100,
        h: 104,
        l: 99,
        c: 103,
        v: 0,
      },
    ]);
  });
});

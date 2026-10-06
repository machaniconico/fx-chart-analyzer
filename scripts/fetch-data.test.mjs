import { describe, expect, it, vi } from 'vitest';
import {
  PRIMARY_STALE_LIMIT_HOURS_BY_TIMEFRAME,
  aggregateDailyFromH1,
  aggregateDominates,
  aggregateH1FromMinuteBars,
  describeBaseline,
  aggregateH4,
  isFxMarketHour,
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

  it('does not record a timeframe as primary success when any pair fell back to Yahoo', () => {
    const previousH1 = '2026-07-24T21:00:00.000Z';
    const result = buildSourceHealth({
      sources: [
        { timeframe: 'h1', source: 'dukascopy' },
        { timeframe: 'h1', source: 'yahoo-fallback' },
        { timeframe: 'd1', source: 'dukascopy' },
        { timeframe: 'd1', source: 'dukascopy' },
      ],
      previousHealth: { lastPrimarySuccessByTimeframe: { h1: previousH1 } },
      nowMs: NOW,
    });

    expect(result.primaryOkThisRun).toBe(true);
    expect(result.lastPrimarySuccessByTimeframe.h1).toBe(previousH1);
    expect(result.lastPrimarySuccessByTimeframe.d1).toBe('2026-07-27T21:52:00.000Z');
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

  it('fetches the current h1 month separately with failing retries and merges bars', async () => {
    const bar = (t) => ({ timestamp: t * 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
    const fetchRates = vi
      .fn()
      .mockResolvedValueOnce([bar(1_790_000_000), bar(1_790_003_600)])
      .mockResolvedValueOnce([bar(1_790_003_600), bar(1_790_007_200)]);

    const bars = await fetchTimeframe('USDJPY', 'h1', 730, { fetchRates });

    expect(fetchRates).toHaveBeenCalledTimes(2);
    const [history, current] = fetchRates.mock.calls.map(([options]) => options);
    expect(history).toMatchObject({ retryCount: 0 });
    expect(current).toMatchObject({ retryCount: 4, failAfterRetryCount: true });
    expect(history.dates.to).toEqual(current.dates.from);
    expect(current.dates.from.getUTCDate()).toBe(1);
    expect(bars.map((b) => b.t)).toEqual([1_790_000_000, 1_790_003_600, 1_790_007_200]);
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

describe('h1 aggregation from Dukascopy minute bars', () => {
  const H = 3600;
  const u = (...a) => Date.UTC(...a) / 1000;
  const fnow = u(2026, 9, 6, 12, 10);
  const m30 = (t, o, h, l, c, v = 1) => ({ t, o, h, l, c, v });
  const base = u(2026, 9, 6, 8);

  it('aggregates m30 into UTC hours (open first, high max, low min, close last, volume sum)', () => {
    const out = aggregateH1FromMinuteBars(
      [m30(base + 1800, 2, 9, 1, 3, 5), m30(base, 1, 5, 0.5, 2, 4), m30(base + H, 3, 4, 2, 3.5), m30(base + H + 1800, 3, 4, 2, 3.5)],
      'm30',
      { nowSeconds: fnow },
    );
    expect(out[0]).toEqual({ t: base, o: 1, h: 9, l: 0.5, c: 3, v: 9 });
    expect(out).toHaveLength(2);
  });

  it('drops the unfinished last bar and an incomplete tail hour', () => {
    const bars = [m30(base, 1, 1, 1, 1), m30(base + 1800, 1, 1, 1, 1), m30(base + H, 1, 1, 1, 1)];
    expect(aggregateH1FromMinuteBars(bars, 'm30', { nowSeconds: fnow }).map((b) => b.t)).toEqual([base]);
    const noon = u(2026, 9, 6, 12);
    const at1240 = [m30(noon - H, 1, 1, 1, 1), m30(noon - H + 1800, 1, 1, 1, 1), m30(noon, 1, 1, 1, 1), m30(noon + 1800, 1, 1, 1, 1)];
    expect(aggregateH1FromMinuteBars(at1240, 'm30', { nowSeconds: noon + 2400 }).map((b) => b.t)).toEqual([noon - H]);
    expect(aggregateH1FromMinuteBars(at1240, 'm30', { nowSeconds: noon + H }).map((b) => b.t)).toEqual([noon - H, noon]);
  });

  it('keeps a middle hour that has a single m30 (flat half skipped by ignoreFlats)', () => {
    const bars = [
      m30(base, 1, 1, 1, 1),
      m30(base + 1800, 1, 1, 1, 1),
      m30(base + H, 2, 3, 2, 3),
      m30(base + 2 * H, 3, 3, 3, 3),
      m30(base + 2 * H + 1800, 3, 3, 3, 3),
    ];
    expect(aggregateH1FromMinuteBars(bars, 'm30', { nowSeconds: fnow }).map((b) => b.t)).toEqual([base, base + H, base + 2 * H]);
  });

  it('excludes a first hour that starts mid-hour (m15 starting 09:45)', () => {
    const t0 = u(2026, 9, 6, 9, 45);
    const bars = Array.from({ length: 12 }, (_, i) => m30(t0 + i * 900, 1, 1, 1, 1));
    expect(aggregateH1FromMinuteBars(bars, 'm15', { nowSeconds: fnow })[0].t).toBe(u(2026, 9, 6, 10));
  });

  it('classifies FX market hours by New York time across DST', () => {
    expect(isFxMarketHour(u(2026, 6, 10, 20))).toBe(true);
    expect(isFxMarketHour(u(2026, 6, 10, 21))).toBe(false);
    expect(isFxMarketHour(u(2026, 6, 12, 20))).toBe(false);
    expect(isFxMarketHour(u(2026, 6, 12, 21))).toBe(true);
    expect(isFxMarketHour(u(2026, 0, 9, 21))).toBe(true);
    expect(isFxMarketHour(u(2026, 0, 9, 22))).toBe(false);
    expect(isFxMarketHour(u(2026, 0, 11, 21))).toBe(false);
    expect(isFxMarketHour(u(2026, 0, 11, 22))).toBe(true);
  });

  it('records derived sources as primary success in health', () => {
    const health = buildSourceHealth({
      sources: [
        { timeframe: 'h1', source: 'dukascopy-m30' },
        { timeframe: 'h4', source: 'dukascopy-m30' },
      ],
      previousHealth: null,
      nowMs: fnow * 1000,
    });
    expect(health.sources['dukascopy-m30']).toBe(2);
    expect(health.primaryOkThisRun).toBe(true);
    expect(health.lastPrimarySuccessByTimeframe.h1).toBe(health.updatedAt);
  });

  describe('dominance rule', () => {
    const bars = (...ts) => ({ bars: ts.map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 0 })) });
    const baseline = { h1Tail: 10, h4Tail: 4, changedH1: [9, 10], changedH4: [4] };
    const agg = (over = {}) => ({ h1: bars(8, 9, 10, 11), h4: bars(0, 4), partialH4: false, aggregatedH1Tail: 11, ...over });

    it('dominates when tails are not older, all Yahoo-changed bars exist, and no partial h4', () => {
      expect(aggregateDominates(agg(), baseline)).toBe(true);
    });

    it.each([
      ['older aggregated h1 tail', { aggregatedH1Tail: 9 }],
      ['older h4 tail', { h4: bars(0) }],
      ['missing a Yahoo-changed h1', { h1: bars(8, 10, 11) }],
      ['missing a Yahoo-changed h4', { h4: bars(0, 5) }],
      ['partial h4 bucket', { partialH4: true }],
    ])('does not dominate with %s', (_name, over) => {
      expect(aggregateDominates(agg(over), baseline)).toBe(false);
    });

    it('describes the baseline from the Yahoo version, or from existing data when Yahoo failed', () => {
      const existing = [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 }, { t: 2, o: 1, h: 1, l: 1, c: 1, v: 0 }];
      const changedTail = { t: 2, o: 5, h: 5, l: 5, c: 5, v: 0 };
      const yahoo = {
        h1: { bars: [existing[0], changedTail, { t: 3, o: 1, h: 1, l: 1, c: 1, v: 0 }] },
        h4: { bars: existing },
      };
      expect(describeBaseline(yahoo, existing, existing)).toEqual({ h1Tail: 3, h4Tail: 2, changedH1: [2, 3], changedH4: [] });
      expect(describeBaseline(null, existing, existing)).toEqual({ h1Tail: 2, h4Tail: 2, changedH1: [], changedH4: [] });
    });
  });

  describe('integration: always runs the Yahoo path, adopts an aggregate only when it dominates', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failPrimary = async () => {
      throw new Error('429');
    };
    const series = (step, end, drop = () => false) =>
      makeBars({ count: 8000, endTime: end, stepSeconds: step })
        .map((bar, i) => ({ ...bar, t: end - (7999 - i) * step }))
        .filter((bar) => !drop(bar.t));
    // yahooEnd: last Yahoo h1 time, or null when Yahoo fails
    const scenario = async ({ nowS = fnow, h1End = u(2026, 9, 6, 7), h1, h4, m30: m30Bars, m15, fetchedAtMs, yahooEnd }) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const existingH1 = h1 ?? makeBars({ count: 8000, endTime: h1End, stepSeconds: H });
      const stored = { h1: existingH1, h4: h4 ?? aggregateH4(existingH1, { dropIncompleteTail: true }) };
      const fetchYahoo = vi.fn(async () => {
        if (yahooEnd == null) throw new Error('yahoo down');
        return makeBars({ count: 8000, endTime: yahooEnd, stepSeconds: H, price: 200 });
      });
      const wrap = (bars) => (bars && fetchedAtMs ? { bars, fetchedAtMs } : bars);
      const run = () =>
        fetchH1AndH4WithFallback('GBPJPY', {
          fetchPrimary: failPrimary,
          fetchYahoo,
          readExisting: async (_p, tf) => stored[tf],
          nowMs: nowS * 1000,
          lowerTimeframeBars: { m30: wrap(m30Bars), m15: wrap(m15) },
        });
      return { fetchYahoo, stored, run };
    };

    it('adopts m30 when it is newer than Yahoo; Yahoo is still called once', async () => {
      const sc = await scenario({ m30: series(1800, u(2026, 9, 6, 11, 30)), yahooEnd: u(2026, 9, 6, 10) });
      const result = await sc.run();
      expect(sc.fetchYahoo).toHaveBeenCalledOnce();
      expect(result.h1.source).toBe('dukascopy-m30');
      expect(result.h1.bars.at(-1).t).toBe(u(2026, 9, 6, 11));
      expect(result.h4.bars.at(-1).t).toBe(u(2026, 9, 6, 8));
    });

    it('keeps the Yahoo version when Yahoo is one hour ahead of the aggregate', async () => {
      const sc = await scenario({ m30: series(1800, u(2026, 9, 6, 11, 30)), yahooEnd: u(2026, 9, 6, 12) });
      const result = await sc.run();
      expect(result.h1.source).toBe('yahoo-fallback');
      expect(result.h1.bars.at(-1).t).toBe(u(2026, 9, 6, 12));
    });

    it('with Yahoo down, adopts an aggregate that is newer than existing and otherwise fails like before', async () => {
      const fresh = await scenario({ m30: series(1800, u(2026, 9, 6, 11, 30)), yahooEnd: null });
      expect((await fresh.run()).h1.source).toBe('dukascopy-m30');
      const stale = await scenario({ m30: series(1800, u(2026, 9, 6, 5, 30)), yahooEnd: null });
      await expect(stale.run()).rejects.toThrow(/Yahoo fallback failed/);
      const none = await scenario({ yahooEnd: null });
      await expect(none.run()).rejects.toThrow(/Yahoo fallback failed/);
    });

    it('falls to the Yahoo version when m30 and m15 are both absent', async () => {
      const sc = await scenario({ yahooEnd: u(2026, 9, 6, 11) });
      expect((await sc.run()).h1.source).toBe('yahoo-fallback');
    });

    it('prefers newer m30 over stale m15 (Codex 16:10); Yahoo newer than both wins', async () => {
      const hole13 = (t) => t >= u(2026, 9, 6, 13) && t < u(2026, 9, 6, 14);
      const m30Bars = series(1800, u(2026, 9, 6, 15, 30), hole13);
      const m15 = series(900, u(2026, 9, 6, 7, 45));
      const nowS = u(2026, 9, 6, 16, 10);
      const older = await (await scenario({ nowS, m30: m30Bars, m15, yahooEnd: u(2026, 9, 6, 10) })).run();
      expect(older.h1.source).toBe('dukascopy-m30');
      expect(older.h4.bars.at(-1).t).toBe(u(2026, 9, 6, 8));
      const newer = await (await scenario({ nowS, m30: m30Bars, m15, yahooEnd: u(2026, 9, 6, 15) })).run();
      expect(newer.h1.source).toBe('yahoo-fallback');
    });

    it('prefers a newer m15 over a stale m30, and ties go to m30', async () => {
      const m15 = series(900, u(2026, 9, 6, 11, 45));
      const stale = await (await scenario({ m30: series(1800, u(2026, 9, 6, 7, 30)), m15, yahooEnd: u(2026, 9, 6, 6) })).run();
      expect(stale.h1.source).toBe('dukascopy-m15');
      const tie = await (await scenario({ m30: series(1800, u(2026, 9, 6, 11, 30)), m15, yahooEnd: u(2026, 9, 6, 6) })).run();
      expect(tie.h1.source).toBe('dukascopy-m30');
    });

    it('judges closure at fetch time (Codex 11:59 m15 snapshot processed at 12:01)', async () => {
      const sc = await scenario({
        nowS: u(2026, 9, 6, 12, 1),
        m15: series(900, u(2026, 9, 6, 11, 45)),
        fetchedAtMs: u(2026, 9, 6, 11, 59) * 1000,
        yahooEnd: u(2026, 9, 6, 6),
      });
      const result = await sc.run();
      expect(result.h1.source).toBe('dukascopy-m15');
      expect(result.h1.bars.at(-1).t).toBe(u(2026, 9, 6, 10));
      expect(result.h4.bars.at(-1).t).toBe(u(2026, 9, 6, 4));
    });

    it('never freezes a partial existing h4: with a hole the Yahoo version repairs it (Codex 20:00 bucket)', async () => {
      const h1 = makeBars({ count: 8000, endTime: u(2026, 9, 6, 21), stepSeconds: H });
      const lastClosed = u(2026, 9, 7, 0, 30);
      const holey = series(1800, lastClosed, (t) => t >= u(2026, 9, 6, 22) && t < u(2026, 9, 6, 23));
      const sc = await scenario({
        nowS: u(2026, 9, 7, 1, 10),
        h1,
        h4: aggregateH4(h1), // keeps the partial 20:00 bucket
        m30: holey,
        yahooEnd: u(2026, 9, 7, 0),
      });
      const result = await sc.run();
      expect(result.h1.source).toBe('yahoo-fallback');
      expect(result.h1.bars.find((bar) => bar.t === u(2026, 9, 6, 22))).toBeDefined();
    });

    it('repairs a partial existing h4 itself when the aggregate is complete and dominates', async () => {
      const h1 = makeBars({ count: 8000, endTime: u(2026, 9, 6, 21), stepSeconds: H });
      const sc = await scenario({
        nowS: u(2026, 9, 7, 1, 10),
        h1,
        h4: aggregateH4(h1),
        m30: series(1800, u(2026, 9, 7, 0, 30)),
        yahooEnd: u(2026, 9, 6, 22),
      });
      const result = await sc.run();
      expect(result.h1.source).toBe('dukascopy-m30');
      const repaired = result.h4.bars.find((bar) => bar.t === u(2026, 9, 6, 20));
      expect(repaired).not.toEqual(sc.stored.h4.at(-1));
      expect(result.h4.bars.at(-1).t).toBeGreaterThanOrEqual(u(2026, 9, 6, 20));
    });

    it('keeps an existing complete h4 when its leading bucket lacks source h1 (Codex GBPJPY case)', async () => {
      const h1 = makeBars({ count: (u(2026, 9, 3, 20) - u(2026, 5, 10, 14)) / H + 1, endTime: u(2026, 9, 3, 20), stepSeconds: H });
      const bucket = u(2026, 5, 10, 12);
      const sentinel = { t: bucket, o: 999, h: 1000, l: 998, c: 999.5, v: 1 };
      const older = makeBars({ count: 1000, endTime: bucket - 4 * H, stepSeconds: 4 * H });
      const h4 = [...older, sentinel, ...aggregateH4(h1.filter((bar) => bar.t >= bucket + 4 * H))];
      const start = u(2026, 5, 10, 14, 30);
      const minute = Array.from({ length: Math.floor((fnow - start) / 1800) }, (_, i) => ({
        t: start + i * 1800, o: 150, h: 151, l: 149, c: 150.5, v: 1,
      }));
      const sc = await scenario({ h1, h4, m30: minute, yahooEnd: null });
      const result = await sc.run();
      expect(result.h4.source).toBe('dukascopy-m30');
      expect(result.h4.bars.find((bar) => bar.t === bucket)).toEqual(sentinel);
    });

    it('does not add a partial h4 bucket (08:00 with hours 08 and 09 missing)', async () => {
      const gapFrom = u(2026, 9, 6, 8);
      const sc = await scenario({
        m30: series(1800, u(2026, 9, 6, 11, 30), (t) => t >= gapFrom && t < gapFrom + 2 * H),
        yahooEnd: null,
      });
      const result = await sc.run();
      expect(result.h1.source).toBe('dukascopy-m30');
      expect(result.h4.bars.some((bar) => bar.t === gapFrom)).toBe(false);
    });

    it('rejects an aggregate missing a whole market day; the Yahoo version is used', async () => {
      const dayStart = u(2026, 9, 6);
      const sc = await scenario({
        h1End: u(2026, 9, 5, 12),
        m30: series(1800, u(2026, 9, 6, 11, 30), (t) => t >= dayStart && t < dayStart + 9 * H),
        yahooEnd: u(2026, 9, 6, 11),
      });
      expect((await sc.run()).h1.source).toBe('yahoo-fallback');
    });

    it('accepts a weekend gap', async () => {
      const friClose = u(2026, 9, 2, 22);
      const sunOpen = u(2026, 9, 4, 21);
      const sc = await scenario({
        h1End: u(2026, 9, 2, 20),
        m30: series(1800, u(2026, 9, 6, 11, 30), (t) => t >= friClose && t < sunOpen),
        yahooEnd: null,
      });
      expect((await sc.run()).h1.source).toBe('dukascopy-m30');
    });

    it('summer: 3 missing market hours before the Friday 17:00 NY close are tolerated, 4 are rejected', async () => {
      const now = u(2026, 6, 14, 12);
      const sunOpen = u(2026, 6, 12, 21);
      const mk = async (existingEnd, dropFrom) => {
        const nowS = Math.floor(now / 1800) * 1800 + 600;
        const lastClosed = Math.floor((nowS - 1800) / 1800) * 1800;
        const sc = await scenario({
          nowS,
          h1End: existingEnd,
          m30: series(1800, lastClosed, (t) => t >= dropFrom && t < sunOpen),
          yahooEnd: null,
        });
        return sc.run();
      };
      expect((await mk(u(2026, 6, 10, 17), u(2026, 6, 10, 18))).h1.source).toBe('dukascopy-m30');
      await expect(mk(u(2026, 6, 10, 16), u(2026, 6, 10, 17))).rejects.toThrow(/Yahoo fallback failed/);
    });

    it('winter: 3 missing market hours after the Sunday 17:00 NY reopen are tolerated, 4 are rejected', async () => {
      const now = u(2026, 0, 13, 12);
      const nowS = Math.floor(now / 1800) * 1800 + 600;
      const lastClosed = Math.floor((nowS - 1800) / 1800) * 1800;
      const mk = async (dropTo) => {
        const sc = await scenario({
          nowS,
          h1End: u(2026, 0, 9, 21),
          m30: series(1800, lastClosed, (t) => t >= u(2026, 0, 9, 22) && t < dropTo),
          yahooEnd: null,
        });
        return sc.run();
      };
      expect((await mk(u(2026, 0, 12, 1))).h1.source).toBe('dukascopy-m30');
      await expect(mk(u(2026, 0, 12, 2))).rejects.toThrow(/Yahoo fallback failed/);
    });
  });
});

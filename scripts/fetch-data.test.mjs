import { describe, expect, it } from 'vitest';
import {
  aggregateH4,
  mergeAppendOnlyBars,
  normalizeYahooChartResponse,
  withTimeout,
} from './fetch-data.mjs';

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
  it('keeps existing bars unchanged and only appends Yahoo bars after the existing tail', () => {
    const existingBars = [
      { t: 100, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: 200, o: 2, h: 3, l: 1.5, c: 2.5, v: 20 },
    ];
    const yahooBars = [
      { t: 100, o: 9, h: 9, l: 9, c: 9, v: 0 },
      { t: 200, o: 8, h: 8, l: 8, c: 8, v: 0 },
      { t: 300, o: 3, h: 4, l: 2.5, c: 3.5, v: 0 },
      { t: 400, o: 4, h: 5, l: 3.5, c: 4.5, v: 0 },
    ];

    expect(mergeAppendOnlyBars(existingBars, yahooBars)).toEqual([
      existingBars[0],
      existingBars[1],
      yahooBars[2],
      yahooBars[3],
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

import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  diagnosticWindow,
  lastWeekdayWindow,
  latestRowFreshness,
  main,
  parseArgs,
} from './diagnose-dukascopy.mjs';

let previousExitCode;

beforeEach(() => {
  previousExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('parseArgs', () => {
  it('keeps the existing USDJPY and m15/h1/d1 defaults', () => {
    expect(parseArgs([])).toEqual({
      pair: 'usdjpy',
      timeframes: ['m15', 'h1', 'd1'],
      help: false,
    });
  });

  it('parses --pair and comma-separated --tf values case-insensitively', () => {
    expect(parseArgs(['--pair=AUDJPY', '--tf=D1,H1'])).toEqual({
      pair: 'audjpy',
      timeframes: ['d1', 'h1'],
      help: false,
    });
  });

  it('recognizes --help without changing the defaults', () => {
    expect(parseArgs(['--help'])).toEqual({
      pair: 'usdjpy',
      timeframes: ['m15', 'h1', 'd1'],
      help: true,
    });
  });
});

describe('CLI', () => {
  it('prints USDJPY defaults with --help without contacting the network', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/diagnose-dukascopy.mjs', '--help'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--pair=USDJPY');
    expect(result.stdout).toContain('--tf=m15,h1,d1');
    expect(result.stdout).toContain('Defaults: pair=USDJPY, tf=m15,h1,d1');
    expect(result.stderr).toBe('');
  });
});

describe('lastWeekdayWindow', () => {
  it.each([
    ['ordinary weekday', '2026-07-29T09:00:00Z', '2026-07-28'],
    ['month boundary', '2026-03-02T09:00:00Z', '2026-02-27'],
    ['year boundary', '2023-01-02T09:00:00Z', '2022-12-30'],
    ['weekend', '2026-04-04T09:00:00Z', '2026-04-03'],
  ])('returns a past weekday at 12:00-18:00 UTC across %s', (_, nowIso, date) => {
    const now = new Date(nowIso);
    const { from, to } = lastWeekdayWindow(now);

    expect(from.toISOString()).toBe(`${date}T12:00:00.000Z`);
    expect(to.toISOString()).toBe(`${date}T18:00:00.000Z`);
    expect(from.getUTCDay()).toBeGreaterThanOrEqual(1);
    expect(from.getUTCDay()).toBeLessThanOrEqual(5);
    expect(from.toISOString().slice(0, 10)).toBe(to.toISOString().slice(0, 10));
    expect(to.getTime()).toBeLessThan(now.getTime());
  });

  it('keeps every sampled window on one past Monday-Friday UTC date', () => {
    const start = Date.UTC(2025, 10, 15);
    for (let offset = 0; offset < 120; offset += 1) {
      const now = new Date(start + offset * 24 * 60 * 60 * 1000);
      const { from, to } = lastWeekdayWindow(now);
      expect(from.getUTCDay()).toBeGreaterThanOrEqual(1);
      expect(from.getUTCDay()).toBeLessThanOrEqual(5);
      expect(from.getUTCHours()).toBe(12);
      expect(to.getUTCHours()).toBe(18);
      expect(from.toISOString().slice(0, 10)).toBe(to.toISOString().slice(0, 10));
      expect(to.getTime()).toBeLessThan(now.getTime());
    }
  });
});

describe('diagnosticWindow', () => {
  it('expands d1 to roughly five business days while preserving the latest window end', () => {
    const now = new Date('2026-03-02T09:00:00Z');
    expect(diagnosticWindow('d1', now)).toEqual({
      from: new Date('2026-02-23T00:00:00.000Z'),
      to: new Date('2026-02-27T18:00:00.000Z'),
    });
    expect(diagnosticWindow('m15', now)).toEqual(lastWeekdayWindow(now));
  });
});

describe('latestRowFreshness', () => {
  it('accepts a recent row and rejects a stale or invalid latest timestamp', () => {
    const end = new Date('2026-07-24T18:00:00Z');
    expect(
      latestRowFreshness(
        [
          { timestamp: 'invalid' },
          { timestamp: Date.parse('2026-07-24T17:30:00Z') },
          { timestamp: Date.parse('2026-07-24T17:45:00Z') },
        ],
        'm15',
        end,
      ).ok,
    ).toBe(true);
    expect(
      latestRowFreshness([{ timestamp: Date.parse('2026-07-24T16:00:00Z') }], 'm15', end).ok,
    ).toBe(false);
    expect(latestRowFreshness([{ timestamp: 'invalid' }], 'h1', end).ok).toBe(false);
  });

  it('rejects a latest row newer than the diagnostic window end', () => {
    const end = new Date('2026-07-24T18:00:00Z');
    const freshness = latestRowFreshness(
      [{ timestamp: end.getTime() + 1 }],
      'm15',
      end,
    );

    expect(freshness.lagMs).toBe(-1);
    expect(freshness.ok).toBe(false);
  });
});

describe('main', () => {
  it('probes the requested pair/timeframes and reports count, latest bar, and elapsed time', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchRates = vi.fn(async (options) => [
      { timestamp: options.dates.to.getTime() - 15 * 60 * 1000 },
    ]);

    await main({
      fetchRates,
      now: new Date('2026-07-27T09:00:00Z'),
      pair: 'audjpy',
      timeframes: ['d1', 'h1'],
    });

    expect(fetchRates).toHaveBeenCalledTimes(2);
    expect(fetchRates.mock.calls.map(([options]) => options.instrument)).toEqual([
      'audjpy',
      'audjpy',
    ]);
    expect(fetchRates.mock.calls.map(([options]) => options.timeframe)).toEqual(['d1', 'h1']);
    const output = log.mock.calls.flat().join(' ');
    expect(output).toContain(
      'pair=AUDJPY timeframe=d1 rows=1 latestBar=2026-07-24T17:45:00.000Z',
    );
    expect(output).toContain('elapsedFromNowMs=');
  });

  it('times out a hung timeframe after 90 seconds and continues probing', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchRates = vi.fn((options) => {
      if (options.timeframe === 'm15') {
        return new Promise(() => {});
      }
      return Promise.resolve([
        { timestamp: options.dates.to.getTime() - 15 * 60 * 1000 },
      ]);
    });

    let settled = false;
    const diagnostic = main({
      fetchRates,
      now: new Date('2026-07-27T09:00:00Z'),
    }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(90_000);

    expect(settled).toBe(true);
    expect(fetchRates).toHaveBeenCalledTimes(3);
    expect(error.mock.calls.flat().join(' ')).toContain(
      'USDJPY m15: Dukascopy timed out after 90s',
    );
    expect(process.exitCode).toBe(1);
    await diagnostic;
  });

  it('marks a zero-row response INCONCLUSIVE and sets a failing exit code', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchRates = vi.fn(async (options) =>
      options.timeframe === 'm15'
        ? []
        : [{ timestamp: options.dates.to.getTime() - 15 * 60 * 1000 }],
    );

    await main({ fetchRates, now: new Date('2026-07-27T09:00:00Z') });

    expect(error.mock.calls.flat().join(' ')).toContain(
      'Dukascopy diagnostic INCONCLUSIVE [m15]',
    );
    expect(process.exitCode).toBe(1);
    expect(fetchRates).toHaveBeenCalledTimes(3);
  });

  it('marks a row beyond the allowed lag STALE and sets a failing exit code', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchRates = vi.fn(async (options) => [
      {
        timestamp:
          options.dates.to.getTime() -
          (options.timeframe === 'm15' ? 31 : 15) * 60 * 1000,
      },
    ]);

    await main({ fetchRates, now: new Date('2026-07-27T09:00:00Z') });

    expect(error.mock.calls.flat().join(' ')).toContain(
      'Dukascopy diagnostic STALE [m15]',
    );
    expect(process.exitCode).toBe(1);
    expect(fetchRates).toHaveBeenCalledTimes(3);
  });

  it('probes m15, h1, and d1 with production feed options but no cache or retries', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchRates = vi.fn(async (options) => [
      { timestamp: options.dates.to.getTime() - 15 * 60 * 1000 },
    ]);

    await main({ fetchRates, now: new Date('2026-07-27T09:00:00Z') });

    expect(fetchRates).toHaveBeenCalledTimes(3);
    expect(fetchRates.mock.calls.map(([options]) => options.timeframe)).toEqual([
      'm15',
      'h1',
      'd1',
    ]);
    for (const [options] of fetchRates.mock.calls) {
      expect(options).toMatchObject({
        instrument: 'usdjpy',
        priceType: 'bid',
        volumes: true,
        volumeUnits: 'units',
        ignoreFlats: true,
        format: 'json',
        useCache: false,
        retryCount: 0,
        retryOnEmpty: true,
        pauseBetweenRetriesMs: 1500,
      });
      expect(options.cacheFolderPath).toMatch(/\.dukascopy-cache$/);
    }
  });
});

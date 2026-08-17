import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLI_USAGE,
  DEEP_HISTORY_PAIRS,
  DEEP_HISTORY_TIMEFRAMES,
  DEEP_HISTORY_LOOKBACK_DAYS,
  MIN_EXPECTED_BARS_BY_TIMEFRAME,
  earliestStrategyRegisteredAt,
  main,
  normalizeBars,
  parseCliArgs,
} from './fetch-deep-history.mjs';
import {
  TUNING_REGISTERED_AT,
  TUNING_PAIRS,
  TUNING_TIMEFRAMES,
} from './tune-virtual-strategies.mjs';

const rawBars = (
  count = MIN_EXPECTED_BARS_BY_TIMEFRAME.h1,
  start = Date.UTC(2024, 0, 1),
) =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * 60 * 60 * 1000,
    open: 150.5,
    high: 151.5,
    low: 150,
    close: 151,
    volume: 12,
  }));

const writeStrategyFixtures = async (root, registeredAts) => {
  const directory = path.join(root, 'strategies');
  await mkdir(directory, { recursive: true });
  await Promise.all(
    registeredAts.map((registeredAt, index) =>
      writeFile(
        path.join(directory, `strategy-${index}.json`),
        `${JSON.stringify({ meta: { registeredAt } })}\n`,
        'utf8',
      ),
    ),
  );
  return directory;
};

const expectedRangeFrom = (registeredAt) =>
  new Date(
    (registeredAt - DEEP_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60) * 1_000,
  ).toISOString();

describe('fetch-deep-history CLI', () => {
  it('reuses the tuning pair and timeframe sets without fetching unused d1 jobs', () => {
    expect(DEEP_HISTORY_PAIRS).toBe(TUNING_PAIRS);
    expect(DEEP_HISTORY_TIMEFRAMES).toBe(TUNING_TIMEFRAMES);
    expect(DEEP_HISTORY_TIMEFRAMES).toEqual(['h1', 'h4', 'm30']);
    expect(DEEP_HISTORY_TIMEFRAMES).not.toContain('d1');
    expect(parseCliArgs([])).toEqual({
      help: false,
      pairs: [],
      timeframes: [],
    });
  });

  it('parses repeated and comma-separated pair/timeframe filters', () => {
    expect(
      parseCliArgs([
        '--pair=usdjpy,EURUSD',
        '--pair',
        'USDJPY',
        '--timeframe',
        'M30,h4',
      ]),
    ).toEqual({
      help: false,
      pairs: ['USDJPY', 'EURUSD'],
      timeframes: ['m30', 'h4'],
    });
  });

  it('shows help even when an unknown option is also present', () => {
    expect(parseCliArgs(['--unknown', '--help'])).toMatchObject({ help: true });
    expect(CLI_USAGE).toContain('--help, -h');
  });

  it('derives the fetch anchor from the shared tuning registration and JSON registrations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fx-deep-history-anchor-'));
    const laterThanTuning = await writeStrategyFixtures(root, [
      TUNING_REGISTERED_AT + 86_400,
      TUNING_REGISTERED_AT + 2 * 86_400,
    ]);
    const earlierThanTuning = await writeStrategyFixtures(
      await mkdtemp(path.join(os.tmpdir(), 'fx-deep-history-anchor-earlier-')),
      [TUNING_REGISTERED_AT - 86_400],
    );

    try {
      await expect(earliestStrategyRegisteredAt(laterThanTuning)).resolves.toBe(
        TUNING_REGISTERED_AT,
      );
      await expect(earliestStrategyRegisteredAt(earlierThanTuning)).resolves.toBe(
        TUNING_REGISTERED_AT - 86_400,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(path.dirname(earlierThanTuning), { recursive: true, force: true });
    }
  });

  it('rejects unknown options and invalid filter values without help', () => {
    expect(() => parseCliArgs(['--pair', 'CADJPY'])).toThrow(/Invalid value for --pair/);
    expect(() => parseCliArgs(['--timeframe', 'm15'])).toThrow(
      /Invalid value for --timeframe/,
    );
    expect(() => parseCliArgs(['--unknown'])).toThrow(/Unknown option/);
  });

  it('keeps the generated deep-history cache out of git', async () => {
    const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(gitignore.split(/\r?\n/)).toContain('.deep-history/');
  });

  it('deduplicates normalized bars by timestamp using the last response row', () => {
    const timestamp = Date.UTC(2024, 0, 1);
    expect(
      normalizeBars([
        {
          timestamp: timestamp / 1_000,
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 1,
        },
        { timestamp, open: 110, high: 112, low: 109, close: 111, volume: 2 },
      ]),
    ).toEqual([
      { t: timestamp / 1_000, o: 110, h: 112, l: 109, c: 111, v: 2 },
    ]);
  });
});

describe('fetch-deep-history orchestration', () => {
  it('fetches selected jobs serially with conservative Dukascopy options and saves normalized bars', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'fx-deep-history-test-'));
    const earliestRegisteredAt = Date.parse('2024-02-10T12:00:00.000Z') / 1_000;
    const strategiesDirectory = await writeStrategyFixtures(outputDirectory, [
      Date.parse('2025-04-20T12:00:00.000Z') / 1_000,
      earliestRegisteredAt,
    ]);
    const sleep = vi.fn(async () => {});
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const fetchRates = vi.fn(async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      return rawBars();
    });
    const now = new Date('2026-08-17T00:00:00.000Z');

    try {
      const summary = await main({
        args: ['--pair', 'USDJPY,EURUSD', '--timeframe', 'h1'],
        outputDirectory,
        strategiesDirectory,
        fetchRates,
        now: () => now,
        sleep,
        log: () => {},
      });

      expect(summary).toEqual({ total: 2, fetched: 2, skipped: 0 });
      expect(maxActiveRequests).toBe(1);
      expect(fetchRates).toHaveBeenCalledTimes(2);
      expect(fetchRates.mock.calls.map(([options]) => options.instrument)).toEqual([
        'usdjpy',
        'eurusd',
      ]);
      for (const [options] of fetchRates.mock.calls) {
        expect(options).toMatchObject({
          timeframe: 'h1',
          retryCount: 0,
          retryOnEmpty: false,
          useCache: true,
          format: 'json',
        });
        expect(options.batchSize).toBeLessThanOrEqual(4);
        expect(options.pauseBetweenBatchesMs).toBeGreaterThanOrEqual(600);
        expect(options.dates.from.getTime()).toBe(
          (earliestRegisteredAt - DEEP_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60) * 1_000,
        );
        expect(options.dates.to).toEqual(now);
      }
      expect(sleep).toHaveBeenCalledTimes(1);

      const saved = JSON.parse(
        await readFile(path.join(outputDirectory, 'USDJPY', 'h1.json'), 'utf8'),
      );
      expect(saved).toMatchObject({
        pair: 'USDJPY',
        tf: 'h1',
        source: 'dukascopy',
        referenceLookbackDays: DEEP_HISTORY_LOOKBACK_DAYS,
        anchorRegisteredAt: earliestRegisteredAt,
      });
      expect(saved.bars).toHaveLength(MIN_EXPECTED_BARS_BY_TIMEFRAME.h1);
      expect(saved.bars[0]).toEqual({
        t: 1704067200,
        o: 150.5,
        h: 151.5,
        l: 150,
        c: 151,
        v: 12,
      });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('resumes by skipping completed cache files', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'fx-deep-history-resume-'));
    const anchorRegisteredAt = Date.parse('2024-02-10T12:00:00.000Z') / 1_000;
    const strategiesDirectory = await writeStrategyFixtures(outputDirectory, [anchorRegisteredAt]);
    await mkdir(path.join(outputDirectory, 'USDJPY'), { recursive: true });
    await writeFile(
      path.join(outputDirectory, 'USDJPY', 'h1.json'),
      `${JSON.stringify({
        anchorRegisteredAt,
        range: { from: expectedRangeFrom(anchorRegisteredAt) },
        bars: [{ t: 1 }],
      })}\n`,
      'utf8',
    );
    const fetchRates = vi.fn(async () => rawBars());

    try {
      const summary = await main({
        args: ['--pair', 'USDJPY,EURUSD', '--timeframe', 'h1'],
        outputDirectory,
        strategiesDirectory,
        fetchRates,
        sleep: async () => {},
        log: () => {},
      });

      expect(summary).toEqual({ total: 2, fetched: 1, skipped: 1 });
      expect(fetchRates).toHaveBeenCalledOnce();
      expect(fetchRates.mock.calls[0][0].instrument).toBe('eurusd');
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ['anchorRegisteredAt', { anchorRegisteredAt: TUNING_REGISTERED_AT }],
    ['range.from', { range: { from: new Date('2024-01-01T00:00:00.000Z').toISOString() } }],
  ])('re-fetches a cache whose %s does not match the current request window', async (_field, stale) => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'fx-deep-history-resume-stale-'));
    const anchorRegisteredAt = Date.parse('2024-02-10T12:00:00.000Z') / 1_000;
    const strategiesDirectory = await writeStrategyFixtures(outputDirectory, [anchorRegisteredAt]);
    await mkdir(path.join(outputDirectory, 'USDJPY'), { recursive: true });
    await writeFile(
      path.join(outputDirectory, 'USDJPY', 'h1.json'),
      `${JSON.stringify({
        anchorRegisteredAt,
        range: { from: expectedRangeFrom(anchorRegisteredAt) },
        ...stale,
        bars: [{ t: 1 }],
      })}\n`,
      'utf8',
    );
    const fetchRates = vi.fn(async () => rawBars());
    const now = new Date('2026-08-17T00:00:00.000Z');

    try {
      await expect(
        main({
          args: ['--pair', 'USDJPY', '--timeframe', 'h1'],
          outputDirectory,
          strategiesDirectory,
          fetchRates,
          now: () => now,
          sleep: async () => {},
          log: () => {},
        }),
      ).resolves.toEqual({ total: 1, fetched: 1, skipped: 0 });
      expect(fetchRates).toHaveBeenCalledOnce();
      const refreshed = JSON.parse(
        await readFile(path.join(outputDirectory, 'USDJPY', 'h1.json'), 'utf8'),
      );
      expect(refreshed).toMatchObject({
        anchorRegisteredAt,
        range: { from: expectedRangeFrom(anchorRegisteredAt) },
      });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('reports a 429 explicitly and stops before the next job', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'fx-deep-history-429-'));
    const strategiesDirectory = await writeStrategyFixtures(outputDirectory, [
      Date.parse('2024-02-10T12:00:00.000Z') / 1_000,
    ]);
    const rateLimitError = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const fetchRates = vi.fn(async () => {
      throw rateLimitError;
    });

    try {
      await expect(
        main({
          args: ['--pair', 'USDJPY,EURUSD', '--timeframe', 'm30'],
          outputDirectory,
          strategiesDirectory,
          fetchRates,
          sleep: async () => {},
          log: () => {},
        }),
      ).rejects.toThrow(/429.*USDJPY m30|USDJPY m30.*429/);
      expect(fetchRates).toHaveBeenCalledOnce();
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('rejects a response below the unique-bar minimum before writing a resumable cache file', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'fx-deep-history-short-'));
    const strategiesDirectory = await writeStrategyFixtures(outputDirectory, [
      Date.parse('2024-02-10T12:00:00.000Z') / 1_000,
    ]);
    const outputPath = path.join(outputDirectory, 'USDJPY', 'h1.json');
    const duplicateInflatedBars = rawBars(MIN_EXPECTED_BARS_BY_TIMEFRAME.h1);
    duplicateInflatedBars.at(-1).timestamp = duplicateInflatedBars.at(-2).timestamp;

    try {
      await expect(
        main({
          args: ['--pair', 'USDJPY', '--timeframe', 'h1'],
          outputDirectory,
          strategiesDirectory,
          fetchRates: async () => duplicateInflatedBars,
          sleep: async () => {},
          log: () => {},
        }),
      ).rejects.toThrow(/USDJPY h1: expected at least 1500 bars, got 1499/);
      await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('does not fetch when help is combined with an unknown option', async () => {
    const fetchRates = vi.fn();
    const logs = [];

    await expect(
      main({
        args: ['--unknown', '--help'],
        fetchRates,
        log: (message) => logs.push(message),
      }),
    ).resolves.toEqual({ total: 0, fetched: 0, skipped: 0 });
    expect(fetchRates).not.toHaveBeenCalled();
    expect(logs).toEqual([CLI_USAGE]);
  });
});

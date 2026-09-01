// Minimal Dukascopy-only probe: no Yahoo fallback and no file writes.
// Use this to tell "the primary source is broken" apart from "the market was closed",
// which the daily pipeline cannot distinguish on its own — fetch-data.mjs silently
// falls back to Yahoo, so a total Dukascopy outage looks identical to a quiet weekend.
//
// Request options intentionally differ from production in only two effective ways:
// - useCache is false so this probe tests the live feed and never writes cache files.
// - retryCount is 0 so the first raw upstream failure is preserved for diagnosis.
// cacheFolderPath and the remaining feed/batching options mirror production; the cache
// path is inert while useCache is false. The 90-second timeout uses production's
// shared helper so a non-responsive feed cannot hang the diagnostic.
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHistoricalRates } from 'dukascopy-node';
import { withTimeout } from './fetch-data.mjs';

const require = createRequire(import.meta.url);
const dukascopyVersion = require('dukascopy-node/package.json').version;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheFolderPath = path.join(rootDir, '.dukascopy-cache');

const TIMEFRAMES = ['m15', 'h1', 'd1'];
const DUKASCOPY_TIMEOUT_MS = 90_000;
const REQUEST_PROFILE_BY_TIMEFRAME = {
  m15: { batchSize: 3, pauseBetweenBatchesMs: 600 },
  h1: { batchSize: 8, pauseBetweenBatchesMs: 150 },
  d1: { batchSize: 8, pauseBetweenBatchesMs: 150 },
};
const MAX_LAG_MS_BY_TIMEFRAME = {
  m15: 30 * 60 * 1000,
  h1: 2 * 60 * 60 * 1000,
  d1: 36 * 60 * 60 * 1000,
};
const HELP_TEXT = `Usage: node scripts/diagnose-dukascopy.mjs [--pair=USDJPY] [--tf=m15,h1,d1]
Defaults: pair=USDJPY, tf=m15,h1,d1`;

export const parseArgs = (args = []) => {
  let pair = 'usdjpy';
  let timeframes = [...TIMEFRAMES];
  let help = false;

  for (const arg of args) {
    if (arg === '--help') {
      help = true;
    } else if (arg.startsWith('--pair=')) {
      pair = arg.slice('--pair='.length).trim().toLowerCase();
    } else if (arg.startsWith('--tf=')) {
      timeframes = arg
        .slice('--tf='.length)
        .split(',')
        .map((timeframe) => timeframe.trim().toLowerCase());
    }
  }

  return { pair, timeframes, help };
};

const previousWeekday = (date) => {
  const result = new Date(date);
  do {
    result.setUTCDate(result.getUTCDate() - 1);
  } while (result.getUTCDay() === 0 || result.getUTCDay() === 6);
  return result;
};

// Walk back to the most recent window that is unambiguously inside trading hours:
// Mon-Fri 12:00-18:00 UTC (London/NY overlap). A weekend window returns zero rows
// legitimately, which would make a broken feed look healthy.
export const lastWeekdayWindow = (now = Date.now()) => {
  const weekday = previousWeekday(new Date(now));
  const from = new Date(
    Date.UTC(weekday.getUTCFullYear(), weekday.getUTCMonth(), weekday.getUTCDate(), 12),
  );
  const to = new Date(
    Date.UTC(weekday.getUTCFullYear(), weekday.getUTCMonth(), weekday.getUTCDate(), 18),
  );
  return { from, to };
};

export const diagnosticWindow = (timeframe, now = Date.now()) => {
  const window = lastWeekdayWindow(now);
  if (timeframe !== 'd1') {
    return window;
  }

  // A six-hour range contains at most one daily candle. Include roughly five
  // business days so the daily aggregation path must return a useful sample.
  let firstDay = new Date(window.from);
  for (let index = 0; index < 4; index += 1) {
    firstDay = previousWeekday(firstDay);
  }
  return {
    from: new Date(
      Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth(), firstDay.getUTCDate()),
    ),
    to: window.to,
  };
};

const timestampMs = (row) => {
  const timestamp = Number(row?.timestamp);
  if (!Number.isFinite(timestamp)) {
    return Number.NaN;
  }
  return timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
};

export const latestRowFreshness = (rows, timeframe, windowEnd) => {
  const latest = rows.reduce(
    (candidate, row) =>
      candidate === undefined ||
      !Number.isFinite(timestampMs(candidate)) ||
      timestampMs(row) > timestampMs(candidate)
        ? row
        : candidate,
    undefined,
  );
  const latestTimestampMs = timestampMs(latest);
  const lagMs = windowEnd.getTime() - latestTimestampMs;
  const maxLagMs = MAX_LAG_MS_BY_TIMEFRAME[timeframe];
  return {
    latest,
    lagMs,
    maxLagMs,
    ok:
      Number.isFinite(latestTimestampMs) &&
      Number.isFinite(maxLagMs) &&
      lagMs >= 0 &&
      lagMs <= maxLagMs,
  };
};

const requestOptions = (pair, timeframe, now) => ({
  instrument: pair,
  dates: diagnosticWindow(timeframe, now),
  timeframe,
  priceType: 'bid',
  volumes: true,
  volumeUnits: 'units',
  ignoreFlats: true,
  format: 'json',
  ...REQUEST_PROFILE_BY_TIMEFRAME[timeframe],
  useCache: false,
  cacheFolderPath,
  retryCount: 0,
  retryOnEmpty: true,
  pauseBetweenRetriesMs: 1500,
});

export const main = async ({
  fetchRates = getHistoricalRates,
  now = Date.now(),
  pair = 'usdjpy',
  timeframes = TIMEFRAMES,
} = {}) => {
  const normalizedPair = pair.toLowerCase();
  const pairLabel = normalizedPair.toUpperCase();
  const selectedTimeframes = timeframes.map((timeframe) => timeframe.toLowerCase());

  console.log(`Dukascopy diagnostic using dukascopy-node ${dukascopyVersion}`);
  console.log(
    `Dukascopy diagnostic target: pair=${pairLabel} timeframes=${selectedTimeframes.join(',')}`,
  );
  let failed = false;

  for (const timeframe of selectedTimeframes) {
    const options = requestOptions(normalizedPair, timeframe, now);
    console.log(`Dukascopy diagnostic request [${timeframe}]:`, inspect(options, { depth: null }));

    try {
      const rows = await withTimeout(
        fetchRates(options),
        DUKASCOPY_TIMEOUT_MS,
        `${pairLabel} ${timeframe}: Dukascopy timed out after ${DUKASCOPY_TIMEOUT_MS / 1000}s`,
      );
      const freshness = latestRowFreshness(rows, timeframe, options.dates.to);
      const latestTimestampMs = timestampMs(freshness.latest);
      const latestBar = Number.isFinite(latestTimestampMs)
        ? new Date(latestTimestampMs).toISOString()
        : 'n/a';
      const elapsedFromNowMs = Number.isFinite(latestTimestampMs)
        ? Number(now) - latestTimestampMs
        : 'n/a';
      console.log(
        `Dukascopy diagnostic result: pair=${pairLabel} timeframe=${timeframe} ` +
          `rows=${rows.length} latestBar=${latestBar} elapsedFromNowMs=${elapsedFromNowMs}`,
      );

      if (rows.length === 0) {
        // Holiday calendars change and vary by instrument. Keeping a partial calendar
        // here would age badly, so an empty result explicitly asks the operator to
        // check whether the displayed date was a market holiday.
        console.error(
          `Dukascopy diagnostic INCONCLUSIVE [${timeframe}]: request succeeded but returned 0 rows`,
        );
        console.error(
          'This window may be a market holiday; check the displayed dates before treating it as an outage.',
        );
        failed = true;
        continue;
      }

      if (!freshness.ok) {
        console.error(
          `Dukascopy diagnostic STALE [${timeframe}]: latest row is ${freshness.lagMs}ms behind ` +
            `the window end (allowed ${freshness.maxLagMs}ms)`,
        );
        console.error('Latest row:', inspect(freshness.latest, { depth: null }));
        failed = true;
        continue;
      }

      console.log(`Dukascopy diagnostic OK [${timeframe}]: ${rows.length} rows`);
      console.log('Latest row:', inspect(freshness.latest, { depth: null }));
    } catch (error) {
      console.error(`Dukascopy diagnostic FAILED [${timeframe}] (raw rejection):`);
      console.error(inspect(error, { depth: null }));
      if (error instanceof Error) {
        console.error('stack:', error.stack);
        console.error('cause:', inspect(error.cause, { depth: null }));
      }
      failed = true;
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const { pair, timeframes, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP_TEXT);
  } else {
    main({ pair, timeframes }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

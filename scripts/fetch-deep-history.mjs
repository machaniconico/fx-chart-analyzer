import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHistoricalRates } from 'dukascopy-node';
import {
  DEEP_HISTORY_LOOKBACK_DAYS,
  TUNING_REGISTERED_AT,
  TUNING_PAIRS,
  TUNING_TIMEFRAMES,
} from './tune-virtual-strategies.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export const DEEP_HISTORY_PAIRS = TUNING_PAIRS;
export const DEEP_HISTORY_TIMEFRAMES = TUNING_TIMEFRAMES;
export const DEFAULT_OUTPUT_DIRECTORY = path.join(projectRoot, '.deep-history');
export const DEFAULT_STRATEGIES_DIRECTORY = path.join(projectRoot, 'strategies', 'virtual');
export const REQUEST_PAUSE_MS = 1_500;
export { DEEP_HISTORY_LOOKBACK_DAYS };

// 完全性チェックではなく、取得ゼロに近い異常応答を弾くための tripwire。
export const MIN_EXPECTED_BARS_BY_TIMEFRAME = Object.freeze({
  m30: 3_000,
  h1: 1_500,
  h4: 1_500,
});

export const REQUEST_PROFILES = Object.freeze({
  m30: Object.freeze({ batchSize: 2, pauseBetweenBatchesMs: 1_200 }),
  h1: Object.freeze({ batchSize: 4, pauseBetweenBatchesMs: 600 }),
  h4: Object.freeze({ batchSize: 4, pauseBetweenBatchesMs: 600 }),
});

export const CLI_USAGE = `Usage: node scripts/fetch-deep-history.mjs [options]

Options:
  --pair <pair[,pair...]>                Filter pairs (${DEEP_HISTORY_PAIRS.join(', ')})
  --timeframe <timeframe[,timeframe...]> Filter timeframes (${DEEP_HISTORY_TIMEFRAMES.join(', ')})
  --help, -h                             Show this help

Each filter can be repeated. Existing pair/timeframe cache files are skipped so an interrupted run can be resumed.`;

const filterDefinitions = new Map([
  ['--pair', { key: 'pairs', values: DEEP_HISTORY_PAIRS, normalize: (value) => value.toUpperCase() }],
  ['--pairs', { key: 'pairs', values: DEEP_HISTORY_PAIRS, normalize: (value) => value.toUpperCase() }],
  [
    '--timeframe',
    {
      key: 'timeframes',
      values: DEEP_HISTORY_TIMEFRAMES,
      normalize: (value) => value.toLowerCase(),
    },
  ],
  [
    '--timeframes',
    {
      key: 'timeframes',
      values: DEEP_HISTORY_TIMEFRAMES,
      normalize: (value) => value.toLowerCase(),
    },
  ],
]);

const canonicalFilterValue = (rawValue, definition, flag) => {
  const normalized = definition.normalize(rawValue);
  const canonical = definition.values.find(
    (value) => value.toLowerCase() === normalized.toLowerCase(),
  );
  if (!canonical) {
    throw new Error(
      `Invalid value for ${flag}: ${rawValue}. Expected one of: ${definition.values.join(', ')}`,
    );
  }
  return canonical;
};

export const parseCliArgs = (args) => {
  const filters = { help: false, pairs: [], timeframes: [] };
  if (args.some((argument) => argument === '--help' || argument === '-h')) {
    return { ...filters, help: true };
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const definition = filterDefinitions.get(flag);
    if (!definition) {
      throw new Error(`Unknown option: ${argument}\n\n${CLI_USAGE}`);
    }

    const rawValues = equalsIndex === -1 ? args[index + 1] : argument.slice(equalsIndex + 1);
    if (equalsIndex === -1) {
      index += 1;
    }
    if (!rawValues || rawValues.startsWith('-')) {
      throw new Error(`Missing value for ${flag}`);
    }

    for (const rawValue of rawValues.split(',')) {
      const value = rawValue.trim();
      if (!value) {
        throw new Error(`Empty value for ${flag}`);
      }
      const canonical = canonicalFilterValue(value, definition, flag);
      if (!filters[definition.key].includes(canonical)) {
        filters[definition.key].push(canonical);
      }
    }
  }

  return filters;
};

const toUnixSeconds = (timestamp) => {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }
  return value > 10_000_000_000 ? Math.floor(value / 1_000) : Math.floor(value);
};

export const normalizeBars = (rows) => {
  const normalizedBars = rows
    .map((row) => ({
      t: toUnixSeconds(row.timestamp),
      o: Number(row.open),
      h: Number(row.high),
      l: Number(row.low),
      c: Number(row.close),
      v: Number(row.volume ?? 0),
    }))
    .filter(
      (bar) =>
        [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite) &&
        bar.h >= bar.l &&
        bar.o > 0 &&
        bar.c > 0,
    );
  const dedupedByTime = new Map();
  for (const bar of normalizedBars) {
    dedupedByTime.set(bar.t, bar);
  }
  return [...dedupedByTime.values()].sort((left, right) => left.t - right.t);
};

export const validateBars = (
  pair,
  timeframe,
  bars,
  { minExpectedBars = MIN_EXPECTED_BARS_BY_TIMEFRAME[timeframe] } = {},
) => {
  if (!Number.isInteger(minExpectedBars) || minExpectedBars <= 0) {
    throw new Error(`No minimum bar-count gate configured for ${timeframe}`);
  }
  const invalid = bars.find((bar) =>
    [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].some((value) => !Number.isFinite(value)),
  );
  if (invalid) {
    throw new Error(`${pair} ${timeframe}: invalid bar ${JSON.stringify(invalid)}`);
  }
  if (bars.length < minExpectedBars) {
    throw new Error(
      `${pair} ${timeframe}: expected at least ${minExpectedBars} bars, got ${bars.length}`,
    );
  }
};

export const earliestStrategyRegisteredAt = async (
  strategiesDirectory = DEFAULT_STRATEGIES_DIRECTORY,
) => {
  const filenames = (await readdir(strategiesDirectory))
    .filter((filename) => filename.endsWith('.json'))
    .sort();
  if (filenames.length === 0) {
    throw new Error(`No strategy JSON files found in ${strategiesDirectory}`);
  }

  let earliest = Number.POSITIVE_INFINITY;
  for (const filename of filenames) {
    let strategy;
    try {
      strategy = JSON.parse(await readFile(path.join(strategiesDirectory, filename), 'utf8'));
    } catch (error) {
      throw new Error(`Failed to read strategy registration from ${filename}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const registeredAt = strategy?.meta?.registeredAt;
    if (!Number.isInteger(registeredAt) || registeredAt <= 0) {
      throw new Error(`${filename}: meta.registeredAt must be a positive unix timestamp`);
    }
    earliest = Math.min(earliest, registeredAt);
  }
  return Math.min(TUNING_REGISTERED_AT, earliest);
};

const errorChain = (error) => {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
};

export const isRateLimitError = (error) =>
  errorChain(error).some((item) => {
    const status = item?.status ?? item?.statusCode ?? item?.response?.status;
    const message = item instanceof Error ? item.message : String(item ?? '');
    return Number(status) === 429 || /(?:\b429\b|too many requests|rate[ -]?limit)/i.test(message);
  });

const errorMessage = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() || 'unknown error';
};

const cacheMatchesRequest = async (filePath, { anchorRegisteredAt, rangeFrom }) => {
  let payload;
  try {
    payload = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
  return (
    payload?.anchorRegisteredAt === anchorRegisteredAt &&
    payload?.range?.from === rangeFrom
  );
};

export const cacheFilePath = (outputDirectory, pair, timeframe) =>
  path.join(outputDirectory, pair, `${timeframe}.json`);

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export const main = async ({
  args = process.argv.slice(2),
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  strategiesDirectory = DEFAULT_STRATEGIES_DIRECTORY,
  fetchRates = getHistoricalRates,
  now = () => new Date(),
  sleep = defaultSleep,
  log = console.log,
} = {}) => {
  const filters = parseCliArgs(args);
  if (filters.help) {
    log(CLI_USAGE);
    return { total: 0, fetched: 0, skipped: 0 };
  }

  const pairs = filters.pairs.length > 0 ? filters.pairs : DEEP_HISTORY_PAIRS;
  const timeframes =
    filters.timeframes.length > 0 ? filters.timeframes : DEEP_HISTORY_TIMEFRAMES;
  const jobs = pairs.flatMap((pair) => timeframes.map((timeframe) => ({ pair, timeframe })));
  const to = new Date(now());
  if (!Number.isFinite(to.getTime())) {
    throw new Error('Invalid current date');
  }
  const anchorRegisteredAt = await earliestStrategyRegisteredAt(strategiesDirectory);
  const from = new Date(
    (anchorRegisteredAt - DEEP_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60) * 1_000,
  );
  const rangeFrom = from.toISOString();
  const dukascopyCacheDirectory = path.join(outputDirectory, '.dukascopy-node');
  let fetched = 0;
  let skipped = 0;

  for (const [index, { pair, timeframe }] of jobs.entries()) {
    const outputPath = cacheFilePath(outputDirectory, pair, timeframe);
    if (await cacheMatchesRequest(outputPath, { anchorRegisteredAt, rangeFrom })) {
      skipped += 1;
      log(`skip ${pair} ${timeframe}: ${path.relative(projectRoot, outputPath)}`);
      continue;
    }

    const profile = REQUEST_PROFILES[timeframe];
    if (!profile) {
      throw new Error(`No request profile configured for ${timeframe}`);
    }
    log(
      `fetch ${pair} ${timeframe}: ${from.toISOString()} to ${to.toISOString()} ` +
        `(registeredAt anchor ${new Date(anchorRegisteredAt * 1_000).toISOString()})`,
    );
    let rows;
    try {
      rows = await fetchRates({
        instrument: pair.toLowerCase(),
        dates: { from: new Date(from), to: new Date(to) },
        timeframe,
        priceType: 'bid',
        volumes: true,
        volumeUnits: 'units',
        ignoreFlats: true,
        format: 'json',
        batchSize: profile.batchSize,
        pauseBetweenBatchesMs: profile.pauseBetweenBatchesMs,
        useCache: true,
        cacheFolderPath: dukascopyCacheDirectory,
        retryCount: 0,
        retryOnEmpty: false,
        failAfterRetryCount: true,
        pauseBetweenRetriesMs: 1_500,
      });
    } catch (error) {
      if (isRateLimitError(error)) {
        const rateLimitFailure = new Error(
          `Dukascopy 429 rate limit for ${pair} ${timeframe}; stopped. Re-run the command to resume from completed cache files.`,
          { cause: error },
        );
        rateLimitFailure.code = 'DUKASCOPY_RATE_LIMIT';
        throw rateLimitFailure;
      }
      throw new Error(
        `Dukascopy fetch failed for ${pair} ${timeframe}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (!Array.isArray(rows)) {
      throw new Error(`Dukascopy returned malformed data for ${pair} ${timeframe}`);
    }
    const bars = normalizeBars(rows);
    validateBars(pair, timeframe, bars);

    const pairDirectory = path.dirname(outputPath);
    await mkdir(pairDirectory, { recursive: true });
    const payload = {
      pair,
      tf: timeframe,
      updatedAt: to.toISOString(),
      source: 'dukascopy',
      referenceLookbackDays: DEEP_HISTORY_LOOKBACK_DAYS,
      anchorRegisteredAt,
      range: { from: rangeFrom, to: to.toISOString() },
      bars,
    };
    const temporaryPath = `${outputPath}.tmp-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8');
    await rename(temporaryPath, outputPath);
    fetched += 1;
    log(`saved ${pair} ${timeframe}: ${bars.length} bars`);

    if (index < jobs.length - 1) {
      await sleep(REQUEST_PAUSE_MS);
    }
  }

  return { total: jobs.length, fetched, skipped };
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

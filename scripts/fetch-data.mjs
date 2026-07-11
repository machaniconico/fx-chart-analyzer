import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHistoricalRates } from 'dukascopy-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'public', 'data');
const cacheDir = path.join(rootDir, '.dukascopy-cache');

const PAIRS = ['USDJPY', 'EURUSD', 'GBPJPY', 'EURJPY', 'AUDJPY', 'GBPUSD'];
const TARGET_BARS_BY_TIMEFRAME = {
  m15: 4000,
  m30: 4000,
  h1: 2000,
  h4: 2000,
  d1: 2000,
};
const MIN_EXPECTED_BARS_BY_TIMEFRAME = {
  m15: 3000,
  m30: 3000,
  h1: 1500,
  h4: 1500,
  d1: 1500,
};
const M15_LOOKBACK_DAYS = 60;
const M30_LOOKBACK_DAYS = 120;
const H1_LOOKBACK_DAYS = 730;
const D1_LOOKBACK_DAYS = 3400;
const DUKASCOPY_TIMEOUT_MS = 90_000;
const YAHOO_FETCH_TIMEOUT_MS = 30_000;

const dayMs = 24 * 60 * 60 * 1000;
const daySeconds = 24 * 60 * 60;
const barSecondsByTimeframe = {
  m15: 15 * 60,
  m30: 30 * 60,
  h1: 60 * 60,
  h4: 4 * 60 * 60,
  d1: 24 * 60 * 60,
};
const YAHOO_TIMEFRAME_PARAMS = {
  m15: { interval: '15m', range: '60d' },
  m30: { interval: '30m', range: '60d' },
  h1: { interval: '1h', range: '730d' },
  d1: { interval: '1d', range: '10y' },
};
const YAHOO_STANDALONE_MIN_EXPECTED_BARS_BY_TIMEFRAME = {
  m15: 2500,
  m30: 1800,
};

const toUnixSeconds = (timestamp) => {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid timestamp: ${timestamp}`);
  }
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
};

const normalizeBar = (row) => ({
  t: toUnixSeconds(row.timestamp),
  o: Number(row.open),
  h: Number(row.high),
  l: Number(row.low),
  c: Number(row.close),
  v: Number(row.volume ?? 0),
});

const yahooNumber = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const normalizeYahooChartResponse = (
  payload,
  tf,
  { nowSeconds = Math.floor(Date.now() / 1000) } = {},
) => {
  const timeframe = YAHOO_TIMEFRAME_PARAMS[tf];
  const barSeconds = barSecondsByTimeframe[tf];
  if (!timeframe || !barSeconds) {
    throw new Error(`Yahoo fallback is not configured for timeframe: ${tf}`);
  }

  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const quote = result?.indicators?.quote?.[0] ?? {};
  const { open, high, low, close } = quote;
  if (
    !Array.isArray(timestamps) ||
    !Array.isArray(open) ||
    !Array.isArray(high) ||
    !Array.isArray(low) ||
    !Array.isArray(close)
  ) {
    throw new Error(`Yahoo ${tf}: malformed chart response`);
  }

  const currentUtcDayStart = Math.floor(nowSeconds / daySeconds) * daySeconds;
  const normalizedBars = timestamps
    .map((timestamp, index) => {
      const rawTime = toUnixSeconds(timestamp);
      const bar = {
        t: tf === 'd1' ? Math.round(rawTime / daySeconds) * daySeconds : rawTime,
        o: yahooNumber(open[index]),
        h: yahooNumber(high[index]),
        l: yahooNumber(low[index]),
        c: yahooNumber(close[index]),
        v: 0,
      };
      if ([bar.o, bar.h, bar.l, bar.c].some((value) => value === null)) {
        return null;
      }
      return bar;
    })
    .filter((bar) => {
      if (!bar) {
        return false;
      }
      if (tf === 'd1') {
        return bar.t < currentUtcDayStart && bar.h >= bar.l && bar.o > 0 && bar.c > 0;
      }
      if (bar.t % barSeconds !== 0 || bar.t > nowSeconds - barSeconds) {
        return false;
      }
      return bar.h >= bar.l && bar.o > 0 && bar.c > 0;
    });

  if (tf !== 'd1') {
    return normalizedBars.sort((a, b) => a.t - b.t);
  }

  const dedupedByTime = new Map();
  for (const bar of normalizedBars) {
    dedupedByTime.set(bar.t, bar);
  }
  return [...dedupedByTime.values()].sort((a, b) => a.t - b.t);
};

export const mergeAppendOnlyBars = (existingBars, incomingBars) => {
  const existing = Array.isArray(existingBars) ? [...existingBars] : [];
  const incoming = Array.isArray(incomingBars) ? incomingBars : [];
  // A previous run may have persisted a still-forming final bar (frozen mid-bucket)
  // that the strict t > tail filter would never revisit. If the incoming feed carries a
  // fresh version of that same timestamp, drop the stale tail so it gets replaced.
  if (existing.length > 0 && incoming.some((bar) => bar.t === existing[existing.length - 1].t)) {
    existing.pop();
  }
  const lastExistingTime = existing.length ? existing[existing.length - 1].t : -Infinity;
  return [...existing, ...incoming.filter((bar) => bar.t > lastExistingTime)];
};

const validateBars = (pair, tf, bars, { minExpectedBars = MIN_EXPECTED_BARS_BY_TIMEFRAME[tf] } = {}) => {
  const invalid = bars.find(
    (bar) =>
      !Number.isFinite(bar.t) ||
      !Number.isFinite(bar.o) ||
      !Number.isFinite(bar.h) ||
      !Number.isFinite(bar.l) ||
      !Number.isFinite(bar.c) ||
      !Number.isFinite(bar.v),
  );
  if (invalid) {
    throw new Error(`${pair} ${tf}: invalid bar ${JSON.stringify(invalid)}`);
  }
  if (bars.length < minExpectedBars) {
    const targetBars = TARGET_BARS_BY_TIMEFRAME[tf];
    throw new Error(`${pair} ${tf}: expected at least ${minExpectedBars} of around ${targetBars} bars, got ${bars.length}`);
  }
};

const writeBars = async (pair, tf, bars, source, validateOptions = {}) => {
  validateBars(pair, tf, bars, validateOptions);
  const pairDir = path.join(outputDir, pair);
  await mkdir(pairDir, { recursive: true });
  const payload = {
    pair,
    tf,
    updatedAt: new Date().toISOString(),
    source,
    bars,
  };
  await writeFile(path.join(pairDir, `${tf}.json`), `${JSON.stringify(payload)}\n`);
};

const persistBars = async (pair, tf, result) => {
  if (result.shouldWrite === false) {
    return `kept ${tf}=${result.bars.length} source=${result.source} (no new Yahoo bars)`;
  }
  await writeBars(pair, tf, result.bars, result.source, result.validateOptions);
  return `wrote ${tf}=${result.bars.length} source=${result.source}`;
};

// 分足は取得ファイル数が多く、並列度が高いと Dukascopy 側にスロットリングされ
// fetch failed になりやすい(2026-07-03 に実際に発生)。分足のみ低負荷設定にする。
const REQUEST_PROFILE_BY_TIMEFRAME = {
  m15: { batchSize: 3, pauseBetweenBatchesMs: 600 },
  m30: { batchSize: 4, pauseBetweenBatchesMs: 400 },
};

const timeoutAfter = (ms, message) => {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
    timeoutId.unref?.();
  });
  return { timeout, clear: () => clearTimeout(timeoutId) };
};

export const withTimeout = async (promise, ms, message) => {
  const guardedPromise = Promise.resolve(promise);
  guardedPromise.catch(() => {});
  const { timeout, clear } = timeoutAfter(ms, message);
  try {
    return await Promise.race([guardedPromise, timeout]);
  } finally {
    clear();
  }
};

const fetchTimeframe = async (pair, timeframe, lookbackDays) => {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * dayMs);
  const profile = REQUEST_PROFILE_BY_TIMEFRAME[timeframe] ?? { batchSize: 8, pauseBetweenBatchesMs: 150 };
  const rows = await withTimeout(
    getHistoricalRates({
      instrument: pair.toLowerCase(),
      dates: { from, to },
      timeframe,
      priceType: 'bid',
      volumes: true,
      volumeUnits: 'units',
      ignoreFlats: true,
      format: 'json',
      batchSize: profile.batchSize,
      pauseBetweenBatchesMs: profile.pauseBetweenBatchesMs,
      useCache: true,
      cacheFolderPath: cacheDir,
      retryCount: 5,
      retryOnEmpty: true,
      pauseBetweenRetriesMs: 1500,
    }),
    DUKASCOPY_TIMEOUT_MS,
    `${pair} ${timeframe}: Dukascopy timed out after ${DUKASCOPY_TIMEOUT_MS / 1000}s`,
  );

  return rows
    .map(normalizeBar)
    .filter((bar) => bar.h >= bar.l && bar.o > 0 && bar.c > 0)
    .sort((a, b) => a.t - b.t);
};

const latest = (bars, tf) => {
  const count = TARGET_BARS_BY_TIMEFRAME[tf];
  return bars.slice(Math.max(0, bars.length - count));
};

const formatError = (error) => (error instanceof Error ? error.message : String(error));

const fetchYahooTimeframe = async (pair, tf) => {
  const timeframe = YAHOO_TIMEFRAME_PARAMS[tf];
  if (!timeframe) {
    throw new Error(`Yahoo fallback is not configured for timeframe: ${tf}`);
  }
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${pair}=X`);
  url.searchParams.set('interval', timeframe.interval);
  url.searchParams.set('range', timeframe.range);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(YAHOO_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Yahoo ${pair} ${tf}: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const chartError = payload?.chart?.error;
  if (chartError) {
    throw new Error(`Yahoo ${pair} ${tf}: ${chartError.description ?? chartError.code ?? 'chart error'}`);
  }
  return normalizeYahooChartResponse(payload, tf);
};

const readExistingBars = async (pair, tf) => {
  try {
    const payload = JSON.parse(await readFile(path.join(outputDir, pair, `${tf}.json`), 'utf8'));
    if (!Array.isArray(payload.bars)) {
      throw new Error(`${pair} ${tf}: existing payload has no bars array`);
    }
    return payload.bars;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const yahooMinExpectedBars = (tf, hasExistingBars) =>
  !hasExistingBars
    ? YAHOO_STANDALONE_MIN_EXPECTED_BARS_BY_TIMEFRAME[tf] ?? MIN_EXPECTED_BARS_BY_TIMEFRAME[tf]
    : MIN_EXPECTED_BARS_BY_TIMEFRAME[tf];

const barsEqual = (a, b) =>
  a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;

const buildYahooFallbackBars = async (pair, tf, incomingBars) => {
  const existingBars = await readExistingBars(pair, tf);
  const hasExistingBars = Array.isArray(existingBars);
  const existingLast = hasExistingBars && existingBars.length > 0
    ? existingBars[existingBars.length - 1]
    : null;
  const lastExistingTime = existingLast ? existingLast.t : -Infinity;
  const appendedCount = hasExistingBars
    ? incomingBars.filter((bar) => bar.t > lastExistingTime).length
    : incomingBars.length;
  // Detect a genuine replacement of the (possibly frozen) final bar so a replace-only run
  // still writes; identical replacements stay no-ops to avoid churning daily commits.
  const replacement = existingLast ? incomingBars.find((bar) => bar.t === existingLast.t) : null;
  const replacesLast = Boolean(replacement) && !barsEqual(replacement, existingLast);
  const merged = hasExistingBars ? mergeAppendOnlyBars(existingBars, incomingBars) : incomingBars;
  const bars = latest(merged, tf);
  const validateOptions = { minExpectedBars: yahooMinExpectedBars(tf, hasExistingBars) };
  validateBars(pair, tf, bars, validateOptions);
  return {
    bars,
    source: 'yahoo-fallback',
    validateOptions,
    shouldWrite: !hasExistingBars || appendedCount > 0 || replacesLast,
  };
};

// Yahoo's daily close is a mid-session snapshot (~the open), not the true daily close, so
// the d1 fallback must never read Yahoo d1 close directly. For an append-only refresh we
// rebuild recent daily bars from Yahoo h1 (whose closes are accurate) aggregated to UTC days.
export const aggregateDailyFromH1 = (h1Bars, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) => {
  const grouped = new Map();
  for (const bar of [...h1Bars].sort((a, b) => a.t - b.t)) {
    const bucket = Math.floor(bar.t / daySeconds) * daySeconds;
    const group = grouped.get(bucket);
    if (!group) {
      grouped.set(bucket, { t: bucket, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
      continue;
    }
    group.h = Math.max(group.h, bar.h);
    group.l = Math.min(group.l, bar.l);
    group.c = bar.c;
    group.v += bar.v;
  }
  const currentUtcDayStart = Math.floor(nowSeconds / daySeconds) * daySeconds;
  return [...grouped.values()]
    .filter((bar) => bar.t < currentUtcDayStart)
    .sort((a, b) => a.t - b.t);
};

// Standalone build only (no existing file, needs ~10y of daily bars deeper than h1 range):
// keep Yahoo d1 open (accurate ~1.6 pips) and repair each close as close(D) = open(D+1),
// then drop the final bar whose close has no next-day open to borrow.
export const repairDailyClosesFromNextOpen = (dailyBars) => {
  const sorted = [...dailyBars].sort((a, b) => a.t - b.t);
  const repaired = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    repaired.push({ ...sorted[i], c: sorted[i + 1].o });
  }
  return repaired;
};

const fetchTimeframeWithFallback = async (pair, tf, lookbackDays) => {
  try {
    const bars = latest(await fetchTimeframe(pair, tf, lookbackDays), tf);
    validateBars(pair, tf, bars);
    return { bars, source: 'dukascopy', validateOptions: {}, shouldWrite: true };
  } catch (dukascopyError) {
    console.warn(`  Dukascopy failed for ${pair} ${tf}: ${formatError(dukascopyError)}; trying Yahoo fallback`);
    try {
      const yahooBars = await fetchYahooTimeframe(pair, tf);
      return await buildYahooFallbackBars(pair, tf, yahooBars);
    } catch (yahooError) {
      throw new Error(
        `Dukascopy failed: ${formatError(dukascopyError)}; Yahoo fallback failed: ${formatError(yahooError)}`,
      );
    }
  }
};

const fetchDailyWithFallback = async (pair) => {
  try {
    const bars = latest(await fetchTimeframe(pair, 'd1', D1_LOOKBACK_DAYS), 'd1');
    validateBars(pair, 'd1', bars);
    return { bars, source: 'dukascopy', validateOptions: {}, shouldWrite: true };
  } catch (dukascopyError) {
    console.warn(`  Dukascopy failed for ${pair} d1: ${formatError(dukascopyError)}; trying Yahoo h1->d1 fallback`);
    try {
      const existingBars = await readExistingBars(pair, 'd1');
      const dailyBars = Array.isArray(existingBars)
        ? aggregateDailyFromH1(await fetchYahooTimeframe(pair, 'h1'))
        : repairDailyClosesFromNextOpen(await fetchYahooTimeframe(pair, 'd1'));
      return await buildYahooFallbackBars(pair, 'd1', dailyBars);
    } catch (yahooError) {
      throw new Error(
        `Dukascopy failed: ${formatError(dukascopyError)}; Yahoo fallback failed: ${formatError(yahooError)}`,
      );
    }
  }
};

const fetchH1AndH4WithFallback = async (pair) => {
  try {
    const h1Raw = await fetchTimeframe(pair, 'h1', H1_LOOKBACK_DAYS);
    const h1 = latest(h1Raw, 'h1');
    const h4 = latest(aggregateH4(h1Raw), 'h4');
    validateBars(pair, 'h1', h1);
    validateBars(pair, 'h4', h4);
    return {
      h1: { bars: h1, source: 'dukascopy', validateOptions: {}, shouldWrite: true },
      h4: { bars: h4, source: 'dukascopy', validateOptions: {}, shouldWrite: true },
    };
  } catch (dukascopyError) {
    console.warn(`  Dukascopy failed for ${pair} h1/h4: ${formatError(dukascopyError)}; trying Yahoo fallback`);
    try {
      const yahooH1 = await fetchYahooTimeframe(pair, 'h1');
      const h1 = await buildYahooFallbackBars(pair, 'h1', yahooH1);
      const h4 = await buildYahooFallbackBars(pair, 'h4', aggregateH4(yahooH1, { dropIncompleteTail: true }));
      return { h1, h4 };
    } catch (yahooError) {
      throw new Error(
        `Dukascopy failed: ${formatError(dukascopyError)}; Yahoo fallback failed: ${formatError(yahooError)}`,
      );
    }
  }
};

export const aggregateH4 = (h1Bars, { dropIncompleteTail = false } = {}) => {
  const grouped = new Map();
  const sortedBars = [...h1Bars].sort((a, b) => a.t - b.t);
  for (const bar of sortedBars) {
    const bucket = Math.floor(bar.t / (4 * 60 * 60)) * 4 * 60 * 60;
    const group = grouped.get(bucket);
    if (!group) {
      grouped.set(bucket, {
        t: bucket,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v: bar.v,
      });
      continue;
    }
    group.h = Math.max(group.h, bar.h);
    group.l = Math.min(group.l, bar.l);
    group.c = bar.c;
    group.v += bar.v;
  }
  const bars = [...grouped.values()].sort((a, b) => a.t - b.t);
  if (dropIncompleteTail && bars.length > 0 && sortedBars.length > 0) {
    const lastH1Bar = sortedBars[sortedBars.length - 1];
    const lastH4Bar = bars[bars.length - 1];
    if (lastH4Bar.t + barSecondsByTimeframe.h4 > lastH1Bar.t + barSecondsByTimeframe.h1) {
      bars.pop();
    }
  }
  return bars;
};

export const main = async () => {
  await mkdir(outputDir, { recursive: true });

  // 時間足単位で失敗を許容する: 失敗した組合せは既存JSONを温存してスキップし、
  // 部分更新でもデプロイを止めない(fetch-calendar/cot と同じ方針)。
  const failures = [];

  const tryUpdate = async (pair, tf, task) => {
    try {
      await task();
    } catch (error) {
      failures.push(`${pair} ${tf}`);
      console.warn(`  SKIP ${pair} ${tf}: ${formatError(error)} (既存データを温存)`);
    }
  };

  for (const pair of PAIRS) {
    console.log(`Fetching ${pair} m15...`);
    await tryUpdate(pair, 'm15', async () => {
      const m15 = await fetchTimeframeWithFallback(pair, 'm15', M15_LOOKBACK_DAYS);
      console.log(`  ${await persistBars(pair, 'm15', m15)}`);
    });

    console.log(`Fetching ${pair} m30...`);
    await tryUpdate(pair, 'm30', async () => {
      const m30 = await fetchTimeframeWithFallback(pair, 'm30', M30_LOOKBACK_DAYS);
      console.log(`  ${await persistBars(pair, 'm30', m30)}`);
    });

    console.log(`Fetching ${pair} h1...`);
    await tryUpdate(pair, 'h1/h4', async () => {
      const { h1, h4 } = await fetchH1AndH4WithFallback(pair);
      const h1Message = await persistBars(pair, 'h1', h1);
      const h4Message = await persistBars(pair, 'h4', h4);
      console.log(`  ${h1Message}; ${h4Message}`);
    });

    console.log(`Fetching ${pair} d1...`);
    await tryUpdate(pair, 'd1', async () => {
      const d1 = await fetchDailyWithFallback(pair);
      console.log(`  ${await persistBars(pair, 'd1', d1)}`);
    });
  }

  if (failures.length > 0) {
    console.warn(`Data generation finished with ${failures.length} skipped combos: ${failures.join(', ')}`);
    const total = PAIRS.length * 4;
    if (failures.length >= total) {
      console.error('All combos failed.');
      process.exitCode = 1;
    }
  } else {
    console.log('Data generation complete.');
  }
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

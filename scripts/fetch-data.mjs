import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHistoricalRates } from 'dukascopy-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'public', 'data');
const healthFile = path.join(outputDir, 'health.json');
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
export const PRIMARY_STALE_LIMIT_HOURS_BY_TIMEFRAME = Object.freeze({
  h1: 120,
  h4: 120,
  d1: 120,
});

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
  h1: { batchSize: 3, pauseBetweenBatchesMs: 600 },
};

// h1 の当月分は 1 リクエストだけで、CI(GitHub Runner)では 200 以外が返ることがある
// (2026-09-18〜)。dukascopy-node は retryCount=0 だと非 200 を空データとして黙って返すため、
// 当月分だけ再試行し、最後まで失敗したら例外にして失敗理由をログに残す。
const CURRENT_MONTH_RETRY_TIMEFRAMES = new Set(['h1']);
const CURRENT_MONTH_RETRY = { retryCount: 4, failAfterRetryCount: true, pauseBetweenRetriesMs: 15_000 };

const startOfUtcMonth = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

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

export const fetchTimeframe = async (
  pair,
  timeframe,
  lookbackDays,
  { fetchRates = getHistoricalRates } = {},
) => {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * dayMs);
  const profile = REQUEST_PROFILE_BY_TIMEFRAME[timeframe] ?? { batchSize: 8, pauseBetweenBatchesMs: 150 };
  const monthStart = startOfUtcMonth(to);
  const ranges =
    CURRENT_MONTH_RETRY_TIMEFRAMES.has(timeframe) && from < monthStart
      ? [
          { from, to: monthStart },
          { from: monthStart, to, retry: CURRENT_MONTH_RETRY },
        ]
      : [{ from, to }];
  const rows = [];
  for (const range of ranges) {
    rows.push(...(await fetchRange(pair, timeframe, range, profile, fetchRates)));
  }

  const byTime = new Map();
  for (const bar of rows.map(normalizeBar)) {
    byTime.set(bar.t, bar);
  }
  return [...byTime.values()]
    .filter((bar) => bar.h >= bar.l && bar.o > 0 && bar.c > 0)
    .sort((a, b) => a.t - b.t);
};

const fetchRange = (pair, timeframe, { from, to, retry }, profile, fetchRates) =>
  withTimeout(
    fetchRates({
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
      // dukascopy-node 1.50.0 のリトライ経路は分足を 429 後に空データ扱いにしてしまう。
      // 上位層には Yahoo fallback、90秒 timeout、鮮度ゲート、日次再実行があるため、
      // 一時障害の即時再試行より Dukascopy の分足を取得できることを優先する。
      retryCount: 0,
      // retryOnEmpty=true は 429 を "empty dataset" に変えて真因を隠すため、素の失敗を残す。
      retryOnEmpty: false,
      pauseBetweenRetriesMs: 1500,
      ...retry,
    }),
    timeoutMsFor(retry),
    `${pair} ${timeframe}: Dukascopy timed out after ${timeoutMsFor(retry) / 1000}s`,
  );

// 再試行の待ち時間ぶん期限を延ばし、再試行途中で timeout に切られないようにする。
const timeoutMsFor = (retry) =>
  DUKASCOPY_TIMEOUT_MS + (retry ? retry.retryCount * retry.pauseBetweenRetriesMs : 0);

const latest = (bars, tf) => {
  const count = TARGET_BARS_BY_TIMEFRAME[tf];
  return bars.slice(Math.max(0, bars.length - count));
};

const formatError = (error) => (error instanceof Error ? error.message : String(error));
const DERIVED_PRIMARY_SOURCES = ['dukascopy-m30', 'dukascopy-m15'];
const SOURCE_HEALTH_TIMEFRAMES = ['m15', 'm30', 'h1', 'h4', 'd1'];

// previousHealth comes from main's checked-out health.json, so carry-over depends on data/daily-update PRs
// merging; a stuck merge can freeze lastPrimarySuccessAt until a false 120h FAIL, though the
// OPEN_PR_MAX_AGE_HOURS persistence gate should fail first.
export const buildSourceHealth = ({ sources, previousHealth, nowMs = Date.now() }) => {
  const counts = { dukascopy: 0, 'yahoo-fallback': 0 };
  // h1 を Dukascopy の m30/m15 から集約した場合 (dukascopy-m30 / dukascopy-m15)。Dukascopy 由来なので
  // 一次ソース成功として扱うが、内訳は別キーに残す(出現した時だけ追加し、既存スキーマは変えない)。
  const primarySuccessTimeframes = new Set();
  const fallbackTimeframes = new Set();
  for (const entry of sources) {
    const source = typeof entry === 'string' ? entry : entry?.source;
    const isDerivedPrimary = DERIVED_PRIMARY_SOURCES.includes(source);
    if (isDerivedPrimary) {
      counts[source] = (counts[source] ?? 0) + 1;
    } else if (Object.hasOwn(counts, source)) {
      counts[source] += 1;
    }
    if ((source === 'dukascopy' || isDerivedPrimary) && SOURCE_HEALTH_TIMEFRAMES.includes(entry?.timeframe)) {
      primarySuccessTimeframes.add(entry.timeframe);
    }
    if (source === 'yahoo-fallback') {
      fallbackTimeframes.add(entry?.timeframe);
    }
  }
  // 1 ペアでも Yahoo に落ちた時間足は成功扱いにしない(一部ペアだけの成功で鮮度表示が進み、
  // 残りのペアの h1/h4 が Yahoo のままになっていたのを隠していた)。
  for (const timeframe of fallbackTimeframes) {
    primarySuccessTimeframes.delete(timeframe);
  }

  const primaryOkThisRun =
    counts.dukascopy > 0 || DERIVED_PRIMARY_SOURCES.some((source) => counts[source] > 0);
  const updatedAt = new Date(nowMs).toISOString();
  const timeframeTrackingSince =
    previousHealth != null && Object.hasOwn(previousHealth, 'timeframeTrackingSince')
      ? previousHealth.timeframeTrackingSince
      : updatedAt;
  const previousByTimeframe = previousHealth?.lastPrimarySuccessByTimeframe;
  const lastPrimarySuccessByTimeframe = Object.fromEntries(
    SOURCE_HEALTH_TIMEFRAMES.map((timeframe) => [
      timeframe,
      primarySuccessTimeframes.has(timeframe)
        ? updatedAt
        : previousByTimeframe?.[timeframe] ?? null,
    ]),
  );
  return {
    updatedAt,
    timeframeTrackingSince,
    sources: counts,
    primaryOkThisRun,
    lastPrimarySuccessAt: primaryOkThisRun
      ? updatedAt
      : previousHealth?.lastPrimarySuccessAt ?? null,
    lastPrimarySuccessByTimeframe,
  };
};

const writeSourceHealth = async (sources) => {
  let previousHealth = null;
  try {
    previousHealth = JSON.parse(await readFile(healthFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log(`No previous ${healthFile}; starting source-health history.`);
    } else {
      console.warn(
        `::warning::Could not read ${healthFile}; previous primary-source history is unavailable: ` +
          formatError(error),
      );
    }
  }

  const health = buildSourceHealth({ sources, previousHealth });
  const tempPath = `${healthFile}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(health, null, 2)}\n`, 'utf8');
    await rename(tempPath, healthFile);
  } catch (error) {
    // Louder than the read failure: an unwritten health.json freezes updatedAt, and the gate then
    // short-circuits to warn on staleness instead of ever reaching the 120h fail. Without the
    // annotation this step is continue-on-error, so the gate would degrade to warn-only unnoticed.
    console.warn(
      `::warning::Could not write ${healthFile}; continuing without updating source health: ` +
        formatError(error),
    );
  }
};

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

const assertPrimaryResponseUsable = (
  pair,
  tf,
  bars,
  existingBars,
  { nowMs = Date.now() } = {},
) => {
  const latestBar = bars[bars.length - 1];
  const staleLimitHours = PRIMARY_STALE_LIMIT_HOURS_BY_TIMEFRAME[tf];
  const ageHours = (nowMs / 1000 - latestBar.t) / (60 * 60);
  if (ageHours > staleLimitHours) {
    throw new Error(
      `stale primary response: ${pair} ${tf} latest=${new Date(latestBar.t * 1000).toISOString()} ` +
        `ageHours=${ageHours.toFixed(1)} limit=${staleLimitHours}`,
    );
  }

  const existingLatest = Array.isArray(existingBars) && existingBars.length > 0
    ? existingBars[existingBars.length - 1]
    : null;
  if (existingLatest && latestBar.t < existingLatest.t) {
    throw new Error(
      `regressed primary response: ${pair} ${tf} latest=${new Date(latestBar.t * 1000).toISOString()} ` +
        `existingLatest=${new Date(existingLatest.t * 1000).toISOString()}`,
    );
  }
};

const buildYahooFallbackBars = async (
  pair,
  tf,
  incomingBars,
  { readExisting = readExistingBars, source = 'yahoo-fallback' } = {},
) => {
  const existingBars = await readExisting(pair, tf);
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
    source,
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

export const fetchDailyWithFallback = async (
  pair,
  {
    fetchPrimary = fetchTimeframe,
    fetchYahoo = fetchYahooTimeframe,
    readExisting = readExistingBars,
    nowMs = Date.now(),
  } = {},
) => {
  try {
    const bars = latest(await fetchPrimary(pair, 'd1', D1_LOOKBACK_DAYS), 'd1');
    validateBars(pair, 'd1', bars);
    const existingBars = await readExisting(pair, 'd1');
    assertPrimaryResponseUsable(pair, 'd1', bars, existingBars, { nowMs });
    return { bars, source: 'dukascopy', validateOptions: {}, shouldWrite: true };
  } catch (dukascopyError) {
    console.warn(`  Dukascopy failed for ${pair} d1: ${formatError(dukascopyError)}; trying Yahoo h1->d1 fallback`);
    try {
      const existingBars = await readExisting(pair, 'd1');
      const dailyBars = Array.isArray(existingBars)
        ? aggregateDailyFromH1(await fetchYahoo(pair, 'h1'))
        : repairDailyClosesFromNextOpen(await fetchYahoo(pair, 'd1'));
      return await buildYahooFallbackBars(pair, 'd1', dailyBars, { readExisting });
    } catch (yahooError) {
      throw new Error(
        `Dukascopy failed: ${formatError(dukascopyError)}; Yahoo fallback failed: ${formatError(yahooError)}`,
      );
    }
  }
};

export const fetchH1AndH4WithFallback = async (
  pair,
  {
    fetchPrimary = fetchTimeframe,
    fetchYahoo = fetchYahooTimeframe,
    readExisting = readExistingBars,
    nowMs = Date.now(),
    // 同じ実行で Dukascopy から取得済みの m30 / m15 (Yahoo など他ソースのものは渡さない)。
    lowerTimeframeBars = {},
  } = {},
) => {
  try {
    const h1Raw = await fetchPrimary(pair, 'h1', H1_LOOKBACK_DAYS);
    const h1 = latest(h1Raw, 'h1');
    const h4 = latest(aggregateH4(h1Raw), 'h4');
    validateBars(pair, 'h1', h1);
    validateBars(pair, 'h4', h4);
    const [existingH1, existingH4] = await Promise.all([
      readExisting(pair, 'h1'),
      readExisting(pair, 'h4'),
    ]);
    assertPrimaryResponseUsable(pair, 'h1', h1, existingH1, { nowMs });
    assertPrimaryResponseUsable(pair, 'h4', h4, existingH4, { nowMs });
    return {
      h1: { bars: h1, source: 'dukascopy', validateOptions: {}, shouldWrite: true },
      h4: { bars: h4, source: 'dukascopy', validateOptions: {}, shouldWrite: true },
    };
  } catch (dukascopyError) {
    const derived = await buildH1H4FromLowerTimeframes(pair, dukascopyError, {
      readExisting,
      lowerTimeframeBars,
      nowMs,
    });
    if (derived) {
      return derived;
    }
    console.warn(`  Dukascopy failed for ${pair} h1/h4: ${formatError(dukascopyError)}; trying Yahoo fallback`);
    try {
      const yahooH1 = await fetchYahoo(pair, 'h1');
      const h1 = await buildYahooFallbackBars(pair, 'h1', yahooH1, { readExisting });
      const h4 = await buildYahooFallbackBars(
        pair,
        'h4',
        aggregateH4(yahooH1, { dropIncompleteTail: true }),
        { readExisting },
      );
      return { h1, h4 };
    } catch (yahooError) {
      throw new Error(
        `Dukascopy failed: ${formatError(dukascopyError)}; Yahoo fallback failed: ${formatError(yahooError)}`,
      );
    }
  }
};

// 分足(m30/m15)を UTC の 1 時間境界で h1 に集約する。集約元の最後の足がまだ確定していない場合と、
// 末尾の 1 時間が最後のスロットまで揃っていない場合は、その末尾の時間を除外する(aggregateH4 の
// dropIncompleteTail と同じ流儀)。途中の時間は ignoreFlats で値動きの無い足が欠けうるため、
// 1 本以上あれば集約する。
export const aggregateH1FromMinuteBars = (bars, tf, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) => {
  const barSeconds = barSecondsByTimeframe[tf];
  if (!barSeconds || barSeconds >= barSecondsByTimeframe.h1) {
    throw new Error(`h1 aggregation is not supported from timeframe: ${tf}`);
  }
  const hour = barSecondsByTimeframe.h1;
  const closed = [...bars]
    .filter((bar) => bar.t % barSeconds === 0 && bar.t + barSeconds <= nowSeconds)
    .sort((a, b) => a.t - b.t);
  const grouped = new Map();
  for (const bar of closed) {
    const bucket = Math.floor(bar.t / hour) * hour;
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
  const result = [...grouped.values()].sort((a, b) => a.t - b.t);
  const lastSource = closed[closed.length - 1];
  if (result.length > 0 && lastSource.t + barSeconds < result[result.length - 1].t + hour) {
    result.pop();
  }
  return result;
};

// 分足集約の採用条件。既存末尾より集約末尾が少し遅れる程度(Yahoo が数本先行)は許容するが、
// 閾値を超えて遅れる場合・古すぎる場合・市場時間中に連続した欠損がある場合は不完全として拒否する。
const AGGREGATE_MAX_LAG_HOURS = 6;
const AGGREGATE_MAX_MARKET_GAP_HOURS = 3;

// FX の週末クローズ: 金 22:00 UTC 頃 〜 日 21:00 UTC 頃。
const isFxMarketHour = (seconds) => {
  const date = new Date(seconds * 1000);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 0 && hour < 21) return false;
  return true;
};

const assertAggregateUsable = (pair, incomingH1, existingH1, { nowMs }) => {
  const hour = barSecondsByTimeframe.h1;
  const incomingTail = incomingH1[incomingH1.length - 1].t;
  const ageHours = (nowMs / 1000 - incomingTail) / 3600;
  if (ageHours > PRIMARY_STALE_LIMIT_HOURS_BY_TIMEFRAME.h1) {
    throw new Error(`stale aggregate: ${pair} h1 ageHours=${ageHours.toFixed(1)}`);
  }
  const existingTail = existingH1.length > 0 ? existingH1[existingH1.length - 1].t : null;
  if (existingTail === null) {
    return;
  }
  const lagHours = (existingTail - incomingTail) / 3600;
  if (lagHours > AGGREGATE_MAX_LAG_HOURS) {
    throw new Error(`aggregate lags existing h1 by ${lagHours}h (limit ${AGGREGATE_MAX_LAG_HOURS}h)`);
  }
  const present = new Set(incomingH1.map((bar) => bar.t));
  let run = 0;
  for (let t = existingTail + hour; t <= incomingTail; t += hour) {
    if (present.has(t) || !isFxMarketHour(t)) {
      run = 0;
      continue;
    }
    run += 1;
    if (run > AGGREGATE_MAX_MARKET_GAP_HOURS) {
      throw new Error(`aggregate has >${AGGREGATE_MAX_MARKET_GAP_HOURS}h market-hours gap before ${new Date(t * 1000).toISOString()}`);
    }
  }
};

// 既存に集約足を上書きで重ねる(重なる時刻は集約足、集約末尾より後の既存足は保持)。
const overlayBars = (existingBars, incomingBars) => {
  const byTime = new Map(existingBars.map((bar) => [bar.t, bar]));
  for (const bar of incomingBars) {
    byTime.set(bar.t, bar);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
};

const buildOverlayResult = async (pair, tf, mergedBars, existingBars, incomingBars, source) => {
  const bars = latest(mergedBars, tf);
  const validateOptions = { minExpectedBars: MIN_EXPECTED_BARS_BY_TIMEFRAME[tf] };
  validateBars(pair, tf, bars, validateOptions);
  const existingByTime = new Map(existingBars.map((bar) => [bar.t, bar]));
  const changed = incomingBars.some((bar) => {
    const previous = existingByTime.get(bar.t);
    return !previous || !barsEqual(previous, bar);
  });
  return { bars, source, validateOptions, shouldWrite: changed };
};

// h1 の Dukascopy 取得が失敗した時、同じ実行で取得済みの Dukascopy m30 (無ければ m15) から h1 を作り、
// h4 は結合後の h1 から既存の aggregateH4 で作る。使えなければ null を返し、呼び出し側が Yahoo に落とす。
const buildH1H4FromLowerTimeframes = async (
  pair,
  dukascopyError,
  { readExisting, lowerTimeframeBars, nowMs },
) => {
  for (const tf of ['m30', 'm15']) {
    const minuteBars = lowerTimeframeBars[tf];
    if (!Array.isArray(minuteBars) || minuteBars.length === 0) {
      continue;
    }
    try {
      const existingH1 = await readExisting(pair, 'h1');
      if (!Array.isArray(existingH1)) {
        throw new Error('no existing h1 to extend');
      }
      const incomingH1 = aggregateH1FromMinuteBars(minuteBars, tf, { nowSeconds: Math.floor(nowMs / 1000) });
      if (incomingH1.length === 0) {
        throw new Error('no complete hours');
      }
      assertAggregateUsable(pair, incomingH1, existingH1, { nowMs });
      const source = `dukascopy-${tf}`;
      const mergedH1 = overlayBars(existingH1, incomingH1);
      const h1 = await buildOverlayResult(pair, 'h1', mergedH1, existingH1, incomingH1, source);
      const existingH4 = await readExisting(pair, 'h4');
      const h4FirstBucket = Math.floor(incomingH1[0].t / barSecondsByTimeframe.h4) * barSecondsByTimeframe.h4;
      const incomingH4 = aggregateH4(mergedH1, { dropIncompleteTail: true }).filter((bar) => bar.t >= h4FirstBucket);
      const mergedH4 = overlayBars(existingH4 ?? [], incomingH4);
      const h4 = await buildOverlayResult(pair, 'h4', mergedH4, existingH4 ?? [], incomingH4, source);
      console.warn(
        `  Dukascopy h1 failed for ${pair}: ${formatError(dukascopyError)}; built h1/h4 from Dukascopy ${tf}`,
      );
      return { h1, h4 };
    } catch (error) {
      console.warn(`  Dukascopy ${tf} -> h1 aggregation unusable for ${pair}: ${formatError(error)}`);
    }
  }
  return null;
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
  const processedSources = [];

  const tryUpdate = async (pair, tf, task) => {
    try {
      await task();
    } catch (error) {
      failures.push(`${pair} ${tf}`);
      console.warn(`  SKIP ${pair} ${tf}: ${formatError(error)} (既存データを温存)`);
    }
  };

  for (const pair of PAIRS) {
    const lowerTimeframeBars = {};
    console.log(`Fetching ${pair} m15...`);
    await tryUpdate(pair, 'm15', async () => {
      const m15 = await fetchTimeframeWithFallback(pair, 'm15', M15_LOOKBACK_DAYS);
      if (m15.source === 'dukascopy') lowerTimeframeBars.m15 = m15.bars;
      const message = await persistBars(pair, 'm15', m15);
      processedSources.push({ timeframe: 'm15', source: m15.source });
      console.log(`  ${message}`);
    });

    console.log(`Fetching ${pair} m30...`);
    await tryUpdate(pair, 'm30', async () => {
      const m30 = await fetchTimeframeWithFallback(pair, 'm30', M30_LOOKBACK_DAYS);
      if (m30.source === 'dukascopy') lowerTimeframeBars.m30 = m30.bars;
      const message = await persistBars(pair, 'm30', m30);
      processedSources.push({ timeframe: 'm30', source: m30.source });
      console.log(`  ${message}`);
    });

    console.log(`Fetching ${pair} h1...`);
    await tryUpdate(pair, 'h1/h4', async () => {
      const { h1, h4 } = await fetchH1AndH4WithFallback(pair, { lowerTimeframeBars });
      const h1Message = await persistBars(pair, 'h1', h1);
      processedSources.push({ timeframe: 'h1', source: h1.source });
      const h4Message = await persistBars(pair, 'h4', h4);
      processedSources.push({ timeframe: 'h4', source: h4.source });
      console.log(`  ${h1Message}; ${h4Message}`);
    });

    console.log(`Fetching ${pair} d1...`);
    await tryUpdate(pair, 'd1', async () => {
      const d1 = await fetchDailyWithFallback(pair);
      const message = await persistBars(pair, 'd1', d1);
      processedSources.push({ timeframe: 'd1', source: d1.source });
      console.log(`  ${message}`);
    });
  }

  await writeSourceHealth(processedSources);

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

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHistoricalRates } from 'dukascopy-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'public', 'data');
const cacheDir = path.join(rootDir, '.dukascopy-cache');

const PAIRS = ['USDJPY', 'EURUSD', 'GBPJPY', 'EURJPY', 'AUDJPY', 'GBPUSD'];
const TARGET_BARS = 2000;
const H1_LOOKBACK_DAYS = 730;
const D1_LOOKBACK_DAYS = 3400;
const MIN_EXPECTED_BARS = 1500;

const dayMs = 24 * 60 * 60 * 1000;

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

const validateBars = (pair, tf, bars) => {
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
  if (bars.length < MIN_EXPECTED_BARS) {
    throw new Error(`${pair} ${tf}: expected around ${TARGET_BARS} bars, got ${bars.length}`);
  }
};

const writeBars = async (pair, tf, bars) => {
  validateBars(pair, tf, bars);
  const pairDir = path.join(outputDir, pair);
  await mkdir(pairDir, { recursive: true });
  const payload = {
    pair,
    tf,
    updatedAt: new Date().toISOString(),
    bars,
  };
  await writeFile(path.join(pairDir, `${tf}.json`), `${JSON.stringify(payload)}\n`);
};

const fetchTimeframe = async (pair, timeframe, lookbackDays) => {
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * dayMs);
  const rows = await getHistoricalRates({
    instrument: pair.toLowerCase(),
    dates: { from, to },
    timeframe,
    priceType: 'bid',
    volumes: true,
    volumeUnits: 'units',
    ignoreFlats: true,
    format: 'json',
    batchSize: 8,
    pauseBetweenBatchesMs: 150,
    useCache: true,
    cacheFolderPath: cacheDir,
    retryCount: 3,
    retryOnEmpty: true,
    pauseBetweenRetriesMs: 500,
  });

  return rows
    .map(normalizeBar)
    .filter((bar) => bar.h >= bar.l && bar.o > 0 && bar.c > 0)
    .sort((a, b) => a.t - b.t);
};

const latest = (bars, count = TARGET_BARS) => bars.slice(Math.max(0, bars.length - count));

const aggregateH4 = (h1Bars) => {
  const grouped = new Map();
  for (const bar of h1Bars) {
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
  return [...grouped.values()].sort((a, b) => a.t - b.t);
};

await mkdir(outputDir, { recursive: true });

for (const pair of PAIRS) {
  console.log(`Fetching ${pair} h1...`);
  const h1Raw = await fetchTimeframe(pair, 'h1', H1_LOOKBACK_DAYS);
  const h1 = latest(h1Raw);
  const h4 = latest(aggregateH4(h1Raw));
  await writeBars(pair, 'h1', h1);
  await writeBars(pair, 'h4', h4);
  console.log(`  wrote h1=${h1.length}, h4=${h4.length}`);

  console.log(`Fetching ${pair} d1...`);
  const d1 = latest(await fetchTimeframe(pair, 'd1', D1_LOOKBACK_DAYS));
  await writeBars(pair, 'd1', d1);
  console.log(`  wrote d1=${d1.length}`);
}

console.log('Data generation complete.');

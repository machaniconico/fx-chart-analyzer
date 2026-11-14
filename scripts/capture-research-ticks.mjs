/** Private, bounded historical quote capture. Never trades or certifies profitability.
 * rawRows are the package's parsed output, NOT the original provider HTTP bytes.
 * No outer timeout: abandoning a Promise would not cancel the underlying request.
 */
import { getHistoricalRates } from 'dukascopy-node';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const packageVersion = require('dukascopy-node/package.json').version;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assert = (ok, message) => { if (!ok) throw new Error(`tick-capture: ${message}`); };
const canonical = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
});
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export function captureConfig({ from, to, symbol = 'USDJPY', accountCurrency = 'JPY' }, now = Date.now()) {
  assert(symbol === 'USDJPY' && accountCurrency === 'JPY', 'only USDJPY with JPY account is supported');
  const parse = s => { assert(typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s), 'explicit ISO UTC millisecond from/to required'); const t = Date.parse(s); assert(Number.isSafeInteger(t) && new Date(t).toISOString() === s, 'invalid UTC date'); return t; };
  const start = parse(from), end = parse(to);
  assert(start >= 0 && end > start && end <= now && end - start <= 3600000 && Math.floor(start / 3600000) === Math.floor((end - 1) / 3600000), 'window must be historical and within one UTC hour');
  return { instrument: 'usdjpy', dates: { from, to }, timeframe: 'tick', format: 'json', utcOffset: 0,
    priceType: 'bid', volumes: true, volumeUnits: 'units', ignoreFlats: false, wafMode: 'off', wafTokenCache: false,
    useCache: false, batchSize: 1, pauseBetweenBatchesMs: 0, requestIntervalMs: 0, retryCount: 0,
    retryOnEmpty: false, rateLimitRetryCount: 0, failAfterRetryCount: true, pauseBetweenRetriesMs: 0,
    cacheFolderPath: '', chromePath: '', wafTimeoutMs: 60000, wafTokenCachePath: '' };
}
export function sourceUrl(from) {
  const d = new Date(from);
  return `https://jetta.dukascopy.com/v1/ticks/USD-JPY/${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCHours()}`;
}
export function normalizeTicks(rows, config) {
  assert(Array.isArray(rows) && rows.length > 0, 'nonempty parsed tick array required');
  const start = Date.parse(config.dates.from), end = Date.parse(config.dates.to);
  let previous = -1, maxGapMs = 0, minSpread = Infinity, maxSpread = 0;
  const quotes = rows.map(row => {
    assert(row && typeof row === 'object' && !Array.isArray(row), 'invalid tick row');
    assert(Object.keys(row).every(k => ['timestamp', 'askPrice', 'bidPrice', 'askVolume', 'bidVolume'].includes(k)), 'unknown/OHLC tick field');
    const { timestamp: t, askPrice: ask, bidPrice: bid } = row;
    assert(Number.isSafeInteger(t) && t >= start && t < end && t > previous, 'invalid, duplicate, backwards or out-of-window timestamp');
    assert(Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid, 'invalid or missing bid/ask');
    for (const k of ['askVolume', 'bidVolume']) if (Object.hasOwn(row, k)) assert(Number.isFinite(row[k]) && row[k] >= 0, 'invalid volume');
    if (previous >= 0) maxGapMs = Math.max(maxGapMs, t - previous);
    previous = t; minSpread = Math.min(minSpread, ask - bid); maxSpread = Math.max(maxSpread, ask - bid);
    return { type: 'quote', symbol: 'USDJPY', t, observedAt: t, bid, ask, quoteToAccount: 1, conversionObservedAt: t };
  });
  return { quotes, quality: { count: quotes.length, duplicateTimestamps: 0, firstObservedAt: quotes[0].t,
    lastObservedAt: quotes.at(-1).t, maxGapMs, minSpread, maxSpread,
    leadingGapMs: quotes[0].t - start, trailingGapMs: end - quotes.at(-1).t, coverageCertified: false } };
}
export async function captureTicks(options, { fetchRates = getHistoricalRates, now = Date.now } = {}) {
  const started = now(), config = captureConfig(options, started);
  const rawRows = await fetchRates(config);
  const ended = now();
  assert(Number.isSafeInteger(ended) && ended >= started, 'invalid retrieval clock');
  const { quotes, quality } = normalizeTicks(rawRows, config);
  return { schemaVersion: 1, provenance: { kind: 'observed', source: 'Dukascopy historical paired quotes',
    provider: 'Dukascopy', sourceUrl: sourceUrl(config.dates.from), package: 'dukascopy-node', packageVersion,
    retrievalStartedAt: new Date(started).toISOString(), fetchedAt: new Date(ended).toISOString(),
    config, accountCurrency: 'JPY', conversionMethod: 'JPY/JPY identity, no external conversion observation',
    parsedPayloadHash: hash(rawRows), normalizedHash: hash(quotes), hashEncoding: 'sha256 recursively key-sorted JSON UTF-8',
    limitations: 'Research only; historical indicative quotes, no guaranteed fills, liquidity, financing or coverage. Private capture; no redistribution rights claimed.' }, rawRows, quotes, quality };
}
export function importCapture(artifact, now = Date.now()) {
  assert(artifact?.schemaVersion === 1 && artifact.provenance?.kind === 'observed', 'unsupported capture artifact');
  const p = artifact.provenance;
  const config = captureConfig({ ...p.config?.dates, accountCurrency: p.accountCurrency }, now);
  assert(hash(config) === hash(p.config) && p.sourceUrl === sourceUrl(config.dates.from) && p.provider === 'Dukascopy' && p.package === 'dukascopy-node' && typeof p.packageVersion === 'string', 'invalid source/config');
  const started = Date.parse(p.retrievalStartedAt), ended = Date.parse(p.fetchedAt);
  assert(Number.isSafeInteger(started) && Number.isSafeInteger(ended) && ended >= started && ended <= now && started >= Date.parse(config.dates.to), 'invalid retrieval times');
  const normalized = normalizeTicks(artifact.rawRows, config);
  assert(hash(artifact.rawRows) === p.parsedPayloadHash && hash(normalized.quotes) === p.normalizedHash && hash(artifact.quotes) === p.normalizedHash && hash(normalized.quality) === hash(artifact.quality), 'capture hash/quality mismatch');
  // Hashes detect edits, not authenticity: locally supplied provenance is not signed by provider.
  return artifact;
}
function outputPath(output) {
  const reports = resolve(root, 'reports'), target = resolve(root, output);
  const inside = (base, path) => { const r = relative(base, path); return r && !r.startsWith('..') && !isAbsolute(r); };
  assert(inside(reports, target) && target.endsWith('.json'), 'output must be a JSON file under private reports/');
  assert(!existsSync(target), 'output already exists; immutable capture');
  // Reject any existing symlink resolving outside reports (including reports itself).
  let ancestor = dirname(target); while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor);
  assert(actual === ancestor, 'symlink output ancestors are not permitted');
  return target;
}
export function saveCapture(artifact, output) {
  const target = outputPath(output);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const fd = openSync(target, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(artifact, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  return target;
}
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (!argv.length || argv.includes('--help')) return { help: 'Use --from=2026-11-09T12:00:00.000Z --to=2026-11-09T12:00:10.000Z --output=reports/autonomy/capture.json; or --input=existing-capture.json --output=reports/autonomy/import.json. No network without explicit window. One UTC hour maximum. No overwrite. No outer timeout/cancellation claim.' };
  const args = {};
  for (const arg of argv) { const match = /^--(from|to|output|input)=(.+)$/.exec(arg); assert(match && !Object.hasOwn(args, match[1]), 'invalid or duplicate argument'); args[match[1]] = match[2]; }
  assert(args.output, 'explicit private output required'); outputPath(args.output);
  assert(!args.input || (!args.from && !args.to), 'input and fetch window are mutually exclusive');
  const artifact = args.input ? importCapture(JSON.parse(readFileSync(args.input, 'utf8')), dependencies.now?.() ?? Date.now())
    : await captureTicks(args, dependencies);
  return { path: saveCapture(artifact, args.output), count: artifact.quotes.length, parsedPayloadHash: artifact.provenance.parsedPayloadHash, normalizedHash: artifact.provenance.normalizedHash };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

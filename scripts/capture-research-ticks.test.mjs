import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { captureConfig, captureTicks, importCapture, main, normalizeTicks, saveCapture } from './capture-research-ticks.mjs';
const from = '2026-11-09T12:00:00.000Z', to = '2026-11-09T12:00:10.000Z';
const t = Date.parse(from), now = () => Date.parse('2026-11-10T12:00:00.000Z');
// Explicitly synthetic API mocks; never performance evidence.
const rows = () => [{ timestamp: t + 100, bidPrice: 150, askPrice: 150.01, bidVolume: 2, askVolume: 3 }, { timestamp: t + 200, bidPrice: 150.01, askPrice: 150.02 }];
const options = { from, to }, config = captureConfig(options, now());
const dir = `reports/autonomy/capture-test-${process.pid}`;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe('private observed tick capture', () => {
  it('uses exact safe settings and preserves observation times with identity conversion', async () => {
    const fetchRates = vi.fn(async () => rows());
    const a = await captureTicks(options, { fetchRates, now });
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(fetchRates).toHaveBeenCalledWith({ instrument: 'usdjpy', dates: options, timeframe: 'tick', format: 'json', utcOffset: 0,
      priceType: 'bid', volumes: true, volumeUnits: 'units', ignoreFlats: false, wafMode: 'off', wafTokenCache: false,
      useCache: false, batchSize: 1, pauseBetweenBatchesMs: 0, requestIntervalMs: 0, retryCount: 0, retryOnEmpty: false,
      rateLimitRetryCount: 0, failAfterRetryCount: true, pauseBetweenRetriesMs: 0,
      cacheFolderPath: '', chromePath: '', wafTimeoutMs: 60000, wafTokenCachePath: '' });
    expect(a.quotes[0]).toEqual({ type: 'quote', symbol: 'USDJPY', t: t + 100, observedAt: t + 100, bid: 150, ask: 150.01, quoteToAccount: 1, conversionObservedAt: t + 100 });
    expect(a.provenance.sourceUrl).toBe('https://jetta.dukascopy.com/v1/ticks/USD-JPY/2026/11/9/12');
    expect(a.provenance.fetchedAt).toBe(new Date(now()).toISOString());
    expect(importCapture(a, now())).toEqual(a);
  });
  it.each([
    {}, { from, to: from }, { from, to: '2026-11-09T13:00:00.001Z' },
    { from: '2026-11-09T12:59:59.000Z', to: '2026-11-09T13:00:01.000Z' },
    { from: '2026-02-30T12:00:00.000Z', to }, { from, to, symbol: 'EURUSD' },
    { from, to, accountCurrency: 'USD' }, { from: from.replace('Z', '+00:00'), to },
  ])('rejects invalid windows/currencies before fetch: %j', async input => {
    const fetchRates = vi.fn(); await expect(captureTicks(input, { fetchRates, now })).rejects.toThrow(); expect(fetchRates).not.toHaveBeenCalled();
  });
  it('accepts exactly one complete UTC hour', () => expect(captureConfig({ from, to: '2026-11-09T13:00:00.000Z' }, now())).toBeTruthy());
  it.each([
    [], [{ timestamp: t, open: 150, close: 150 }], [{ timestamp: t, bidPrice: 150 }],
    [{ timestamp: t, bidPrice: 151, askPrice: 150 }], [{ timestamp: t, bidPrice: NaN, askPrice: 150 }],
    [{ timestamp: t - 1, bidPrice: 150, askPrice: 151 }], [{ timestamp: t + 10000, bidPrice: 150, askPrice: 151 }],
    [...rows(), rows()[0]], [rows()[0], rows()[0]], [rows()[1], rows()[0]],
  ])('rejects bad payloads without fabricating values', payload => expect(() => normalizeTicks(payload, config)).toThrow());
  it('does not fetch by default', async () => { const fetchRates = vi.fn(); expect(await main([], { fetchRates })).toHaveProperty('help'); expect(fetchRates).not.toHaveBeenCalled(); });
  it('does not write on invalid rows or network failure and never retries', async () => {
    for (const fetchRates of [vi.fn(async () => []), vi.fn(async () => { throw new Error('403 refused'); })]) {
      await expect(main([`--from=${from}`, `--to=${to}`, `--output=${dir}/fail.json`], { fetchRates, now })).rejects.toThrow();
      expect(fetchRates).toHaveBeenCalledTimes(1); expect(existsSync(`${dir}/fail.json`)).toBe(false);
    }
  });
  it('rejects public output before any fetch', async () => { const fetchRates = vi.fn(); await expect(main([`--from=${from}`, `--to=${to}`, '--output=public/data/bad.json'], { fetchRates, now })).rejects.toThrow('private reports'); expect(fetchRates).not.toHaveBeenCalled(); });
  it('writes immutable artifacts and imports without fetching', async () => {
    const a = await captureTicks(options, { fetchRates: async () => rows(), now });
    saveCapture(a, `${dir}/a.json`);
    expect(() => saveCapture(a, `${dir}/a.json`)).toThrow('immutable');
    const fetchRates = vi.fn();
    await main([`--input=${dir}/a.json`, `--output=${dir}/b.json`], { fetchRates, now });
    expect(fetchRates).not.toHaveBeenCalled(); expect(JSON.parse(readFileSync(`${dir}/b.json`))).toEqual(a);
    await expect(main([`--from=${from}`, `--to=${to}`, `--output=${dir}/a.json`], { fetchRates, now })).rejects.toThrow('immutable'); expect(fetchRates).not.toHaveBeenCalled();
  });
  it('rejects tampered hashes, observations, metadata, quality and unsafe configs', async () => {
    const a = await captureTicks(options, { fetchRates: async () => rows(), now });
    for (const mutate of [b => b.rawRows[0].bidPrice++, b => b.quotes[0].bid++, b => b.provenance.config.wafMode = 'auto', b => b.quality.count++, b => b.provenance.fetchedAt = 'not-a-date', b => b.provenance.parsedPayloadHash = 'bad']) {
      const b = structuredClone(a); mutate(b); expect(() => importCapture(b, now())).toThrow();
    }
  });
});

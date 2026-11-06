import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferFetcher, DukascopyAccessDeniedError, URL_ROOT } from 'dukascopy-node';
import { buildSourceHealth, fetchTimeframe, fetchTimeframeWithFallback } from './fetch-data.mjs';
import { evaluateSourceHealth } from './check-data-freshness.mjs';

// Exercise the pinned dependency's real per-URL retry loop with production options.
// Global fetch is stubbed in every test: no network, browser, or cache writes.
const url = `${URL_ROOT}/candles/minute/EURJPY/BID/2026/11/5`;
const emptyCandles = JSON.stringify({
  timestamp: Date.UTC(2026, 10, 5),
  times: [], opens: [], highs: [], lows: [], closes: [], volumes: [],
});
const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const successfulResponse = () => new Response(emptyCandles, {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const productionM15Fetcher = async () => {
  let requestOptions;
  await fetchTimeframe('EURJPY', 'm15', 60, {
    fetchRates: async (options) => {
      requestOptions = options;
      return [];
    },
  });
  expect(requestOptions).toMatchObject({
    retryCount: 1,
    pauseBetweenRetriesMs: 1500,
    retryOnEmpty: false,
    failAfterRetryCount: true,
    wafTokenCache: false,
  });
  // Remove only the wait in these offline tests. BufferFetcher has no cacheManager,
  // while wafTokenCache:false keeps the transport from reading or writing tokens.
  return new BufferFetcher({ ...requestOptions, pauseBetweenRetriesMs: 0 });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('M15 bounded transport retry', () => {
  it('recovers one timed-out URL on the second attempt', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(timeoutError())
      .mockImplementationOnce(async () => successfulResponse());
    vi.stubGlobal('fetch', fetch);
    const transport = await productionM15Fetcher();

    const result = await transport.fetch([url]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([requestUrl]) => requestUrl)).toEqual([url, url]);
    expect(result).toHaveLength(1);
    expect(result[0].buffer.toString('utf8')).toBe(emptyCandles);
  });

  it('stops after two timeouts instead of retrying indefinitely', async () => {
    const error = timeoutError();
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', fetch);
    const transport = await productionM15Fetcher();

    await expect(transport.fetch([url])).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a plain HTTP 403 access denial', async () => {
    const fetch = vi.fn(async () => new Response('Forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const transport = await productionM15Fetcher();

    await expect(transport.fetch([url])).rejects.toBeInstanceOf(DukascopyAccessDeniedError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('falls back after exhausted timeouts without resetting stale primary-source health', async () => {
    const fetch = vi.fn().mockRejectedValue(timeoutError());
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = await productionM15Fetcher();
    const nowMs = Date.UTC(2026, 10, 6, 1, 30);
    const lastPrimarySuccess = '2026-10-07T00:23:39.977Z';
    const yahooBars = Array.from({ length: 4000 }, (_, index) => ({
      t: nowMs / 1000 - (4000 - index) * 900,
      o: 160, h: 161, l: 159, c: 160.5, v: 0,
    }));
    const fetchYahoo = vi.fn(async () => yahooBars);

    const result = await fetchTimeframeWithFallback('EURJPY', 'm15', 60, {
      fetchPrimary: async () => {
        await transport.fetch([url]);
        return [];
      },
      fetchYahoo,
      readExisting: async () => null,
      nowMs,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetchYahoo).toHaveBeenCalledWith('EURJPY', 'm15');
    expect(result).toMatchObject({ source: 'yahoo-fallback', bars: yahooBars });
    const health = buildSourceHealth({
      sources: [
        { timeframe: 'm15', source: 'dukascopy' },
        { timeframe: 'm15', source: result.source },
      ],
      previousHealth: {
        lastPrimarySuccessAt: lastPrimarySuccess,
        lastPrimarySuccessByTimeframe: { m15: lastPrimarySuccess },
      },
      nowMs,
    });
    expect(health.lastPrimarySuccessByTimeframe.m15).toBe(lastPrimarySuccess);
    const gate = evaluateSourceHealth({ health, nowMs });
    expect(gate.level).toBe('fail');
    expect(gate.message).toContain('m15');
    expect(gate.message).toContain('120h');
  });
});

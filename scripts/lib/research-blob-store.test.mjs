import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateBlobReservationStore } from './research-blob-store.mjs';
import { canonicalJson, fingerprint } from './virtual-autonomy.mjs';
import { reservationGenesis, readReservations, reserveHoldout, completeReservation, ReservationConflict } from './research-reservations.mjs';
import { runResearchCycle, syntheticResearchRequest } from './virtual-research-cycle.mjs';

const location = { ledgerId: 'synthetic-blob-acceptance', storeId: 'store_isolatedtest', pathname: 'synthetic/reservations.json' };
const expectedUrl = `https://${location.storeId.slice(6)}.private.blob.vercel-storage.com/${location.pathname}`;
const identity = (offset = 0) => ({ cycleId: fingerprint(['cycle', offset]), requestHash: fingerprint(['request', offset]),
  engineHash: fingerprint('engine'), testHash: fingerprint(['test', offset]), start: offset + 100, end: offset + 200 });
class PreconditionFailed extends Error {}
const bytesResponse = (bytes, etag = 'version0') => ({ statusCode: 200,
  blob: { pathname: location.pathname, url: expectedUrl, etag, size: bytes.length },
  stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
});
const response = (document, etag) => bytesResponse(Buffer.from(canonicalJson(document) + '\n'), etag);
const fixture = () => {
  let document = reservationGenesis(location.ledgerId), version = 'version0', writes = 0;
  const sdk = { BlobPreconditionFailedError: PreconditionFailed,
    get: vi.fn(async () => response(document, version)),
    put: vi.fn(async (path, content, options) => {
      if (options.ifMatch !== version) throw new PreconditionFailed('stale');
      document = JSON.parse(content); version = fingerprint(content); writes++;
      return { pathname: path, etag: version };
    }),
  };
  return { sdk, makeStore: () => createPrivateBlobReservationStore({ ...location, sdk }),
    state: () => ({ document: structuredClone(document), version, writes }) };
};
const temp = async fn => { const dir = mkdtempSync(join(tmpdir(), 'blob-acceptance-')); try { return await fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); } };

describe('private Blob transport, mocked SDK only', () => {
  beforeEach(() => vi.stubEnv('VERCEL_BLOB_RETRIES', '0'));
  afterEach(() => vi.unstubAllEnvs());
  it.each([undefined, '10', '1', '-1', 'zero'])('blocks SDK automatic retry configuration %j before a write', async value => {
    vi.stubEnv('VERCEL_BLOB_RETRIES', value);
    const f = fixture(), store = f.makeStore();
    await expect(store.compareAndSwap('version0', f.state().document)).rejects.toThrow('automatic retries');
    expect(f.sdk.put).not.toHaveBeenCalled();
  });
  it('rechecks retry settings at write time and keeps synthetic-only status immutable', async () => {
    const f = fixture(), store = f.makeStore();
    expect(Object.isFrozen(store)).toBe(true);
    expect(() => { store.syntheticOnly = false; }).toThrow();
    vi.stubEnv('VERCEL_BLOB_RETRIES', '10');
    await expect(store.compareAndSwap('version0', f.state().document)).rejects.toThrow('automatic retries');
    expect(f.sdk.put).not.toHaveBeenCalled();
  });
  it.each(['BLOB_READ_WRITE_TOKEN', 'VERCEL_BLOB_API_URL', 'NEXT_PUBLIC_VERCEL_BLOB_API_URL',
    'VERCEL_BLOB_API_VERSION_OVERRIDE', 'NEXT_PUBLIC_VERCEL_BLOB_API_VERSION_OVERRIDE',
    'VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API', 'NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API'])(
    'blocks unsafe ambient setting %s before any I/O', async key => {
      vi.stubEnv(key, 'synthetic-placeholder'); const f = fixture(), store = f.makeStore();
      await expect(store.read()).rejects.toThrow();
      await expect(store.compareAndSwap('version0', f.state().document)).rejects.toThrow();
      expect(f.sdk.get).not.toHaveBeenCalled(); expect(f.sdk.put).not.toHaveBeenCalled();
    });

  it('pins private store/path and reads body and ETag together without caching', async () => {
    const f = fixture(), store = f.makeStore(); await reserveHoldout(store, identity());
    expect(f.sdk.get).toHaveBeenCalledTimes(2);
    for (const [path, options] of f.sdk.get.mock.calls) {
      expect(path).toBe(location.pathname);
      expect(options).toMatchObject({ access: 'private', storeId: location.storeId, useCache: false });
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      expect(options).not.toHaveProperty('token'); expect(options).not.toHaveProperty('ifNoneMatch');
    }
    const [path, content, options] = f.sdk.put.mock.calls[0];
    expect(path).toBe(location.pathname); expect(JSON.parse(content).ledgerId).toBe(location.ledgerId);
    expect(options).toMatchObject({ access: 'private', storeId: location.storeId, ifMatch: 'version0',
      addRandomSuffix: false, allowOverwrite: true, multipart: false, contentType: 'application/json' });
    expect(options).not.toHaveProperty('token');
  });
  it('refuses observed research even with a usable injected transport', async () => temp(async dir => {
    const f = fixture(), request = syntheticResearchRequest(); request.dataset.provenance.kind = 'observed';
    await expect(runResearchCycle({ stateDir: dir, request, reservationStore: f.makeStore() })).rejects.toThrow('synthetic-only');
    expect(f.sdk.put).not.toHaveBeenCalled();
  }));
  it.each(['', 'http://example.com/x', '../ledger.json', '/ledger.json', 'a/../ledger.json', 'a//ledger.json', 'a/./ledger.json', 'ledger.txt'])('rejects ambiguous path %s before I/O', path => {
    const f = fixture(); expect(() => createPrivateBlobReservationStore({ ...location, pathname: path, sdk: f.sdk })).toThrow('pathname');
    expect(f.sdk.get).not.toHaveBeenCalled(); expect(f.sdk.put).not.toHaveBeenCalled();
  });
  it('requires a specific store, ledger, and dedicated SDK error class', () => {
    const f = fixture();
    for (const overrides of [{ storeId: '' }, { storeId: 'https://example.com' }, { ledgerId: 'short' },
      { sdk: { ...f.sdk, BlobPreconditionFailedError: Error } }, { sdk: { ...f.sdk, BlobPreconditionFailedError: undefined } }]) {
      expect(() => createPrivateBlobReservationStore({ ...location, sdk: f.sdk, ...overrides })).toThrow();
    }
  });
  it.each([null, { statusCode: 304 }, { statusCode: 404 }])('does not initialize missing/stale content %j', async payload => {
    const f = fixture(); f.sdk.get.mockResolvedValue(payload);
    await expect(reserveHoldout(f.makeStore(), identity())).rejects.toThrow('existing uncached ledger');
    expect(f.sdk.put).not.toHaveBeenCalled();
  });
  it.each(['', '*', 'W/"weak"', 'a,b', 'line\nbreak', 'has space', '""'])('rejects unsafe ETag %j before update', async version => {
    const f = fixture(), store = f.makeStore();
    f.sdk.get.mockImplementation(async () => response(f.state().document, version));
    await expect(readReservations(store)).rejects.toThrow('ETag');
    await expect(store.compareAndSwap(version, f.state().document)).rejects.toThrow('strong observed ETag');
    expect(f.sdk.put).not.toHaveBeenCalled();
  });
  it('refuses wrong-path, oversized, mismatched-length and invalid UTF-8 bodies', async () => {
    const f = fixture(), store = f.makeStore();
    const cases = [
      () => { const r = response(f.state().document, 'v1'); r.blob.pathname = 'other.json'; return r; },
      () => { const r = response(f.state().document, 'v1'); r.blob.url = expectedUrl.replace('.private.', '.public.'); return r; },
      () => { const r = response(f.state().document, 'v1'); r.blob.url = expectedUrl.replace('isolatedtest', 'other'); return r; },
      () => { const r = response(f.state().document, 'v1'); r.blob.size = 1024 * 1024 + 1; return r; },
      () => { const r = response(f.state().document, 'v1'); r.blob.size++; return r; },
      () => bytesResponse(Uint8Array.from([0xc3, 0x28])),
      () => bytesResponse(Buffer.from('{broken')),
      () => { const r = response(f.state().document, 'v1'); r.stream = null; return r; },
    ];
    for (const make of cases) {
      f.sdk.get.mockImplementation(async () => make());
      await expect(readReservations(store)).rejects.toThrow();
    }
    expect(f.sdk.put).not.toHaveBeenCalled();
  });
  it('caps the stream even when metadata understates its size', async () => {
    const f = fixture(); let cancelled = false;
    f.sdk.get.mockResolvedValue({ statusCode: 200, blob: { pathname: location.pathname, url: expectedUrl, etag: 'v1', size: 20 },
      stream: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } }) });
    await expect(readReservations(f.makeStore())).rejects.toThrow('exceeds size limit'); expect(cancelled).toBe(true);
  });
  it('captures the response revision before asynchronous body consumption', async () => {
    const f = fixture(), data = Buffer.from(canonicalJson(f.state().document) + '\n');
    const metadata = { pathname: location.pathname, url: expectedUrl, etag: 'v1', size: data.length };
    f.sdk.get.mockResolvedValue({ statusCode: 200, blob: metadata, stream: new ReadableStream({
      pull(c) { metadata.etag = 'v2'; metadata.size = 0; c.enqueue(data); c.close(); },
    }, { highWaterMark: 0 }) });
    expect((await readReservations(f.makeStore())).version).toBe('v1');
  });
  it('does not let mutation of the SDK methods redirect an existing adapter', async () => {
    const f = fixture(), store = f.makeStore(); f.sdk.get = () => { throw new Error('redirected'); };
    f.sdk.put = () => { throw new Error('redirected'); };
    await expect(reserveHoldout(store, identity())).resolves.toHaveProperty('reservation');
  });
  it('permits only one contender for the same holdout across independent adapters', async () => {
    const f = fixture(), a = f.makeStore(), b = f.makeStore();
    const results = await Promise.allSettled([reserveHoldout(a, identity()), reserveHoldout(b, identity())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(f.state().document.reservations).toHaveLength(1); expect(f.state().writes).toBe(1);
  });
  it('rejects an old version without modifying the winning reservation', async () => {
    const f = fixture(), a = f.makeStore(), b = f.makeStore(), before = await readReservations(a);
    const receipt = await reserveHoldout(b, identity());
    await expect(a.compareAndSwap(before.version, before.document)).rejects.toBeInstanceOf(ReservationConflict);
    expect(f.state().document).toEqual(receipt.snapshot.document); expect(f.state().writes).toBe(1);
  });
  it('preserves two ordered reservations while reconciling a stale contender', async () => {
    const f = fixture(), a = f.makeStore(), b = f.makeStore();
    const [first, later] = await Promise.all([reserveHoldout(a, identity()), reserveHoldout(b, identity(300))]);
    await completeReservation(a, first, fingerprint('first'));
    await completeReservation(b, later, fingerprint('later'));
    expect(f.state().document.reservations.map(r => r.status)).toEqual(['completed', 'completed']);
  });
  it('reconciles accepted reservation/completion after a lost response without another write', async () => {
    const f = fixture(), put = f.sdk.put;
    f.sdk.put = vi.fn(async (...args) => { await put(...args); throw new Error('lost response'); });
    const store = f.makeStore(), receipt = await reserveHoldout(store, identity());
    await completeReservation(store, receipt, fingerprint('result'));
    expect(f.sdk.put).toHaveBeenCalledTimes(2); expect(f.state().writes).toBe(2);
  });
  it.each(['unknown', 'named-like-precondition', 'status-only', 'no-op-success'])('never retries an unconfirmed %s write', async kind => {
    const f = fixture();
    f.sdk.put.mockImplementation(async () => {
      if (kind === 'no-op-success') return {};
      const error = new Error('uncertain');
      if (kind === 'named-like-precondition') error.name = 'BlobPreconditionFailedError';
      if (kind === 'status-only') error.status = 412;
      throw error;
    });
    await expect(reserveHoldout(f.makeStore(), identity())).rejects.toThrow('unconfirmed');
    expect(f.sdk.put).toHaveBeenCalledTimes(1); expect(f.state().writes).toBe(0);
  });
  it('refuses fitting after an unavailable confirmation read and keeps the interval consumed on restart', async () => temp(async root => {
    const f = fixture(), get = f.sdk.get; let reads = 0;
    f.sdk.get = vi.fn(async (...args) => { if (++reads === 2) throw new Error('offline'); return get(...args); });
    await expect(runResearchCycle({ stateDir: join(root, 'first'), request: syntheticResearchRequest(), reservationStore: f.makeStore() })).rejects.toThrow('offline');
    expect(readdirSync(join(root, 'first'))).toEqual([]); expect(f.state().document.reservations[0].status).toBe('reserved');
    f.sdk.get = get;
    await expect(runResearchCycle({ stateDir: join(root, 'restart'), request: syntheticResearchRequest(), reservationStore: f.makeStore() })).rejects.toThrow('consumed');
    expect(f.state().writes).toBe(1);
  }));
  it('detects a prior-snapshot rollback instead of interpreting it as an empty new ledger', async () => {
    const f = fixture(), store = f.makeStore(), before = await readReservations(store);
    const receipt = await reserveHoldout(store, identity());
    f.sdk.get.mockImplementation(async () => response(before.document, before.version));
    await expect(readReservations(store, receipt.snapshot)).rejects.toThrow('regressed');
  });
});

/** Prepared transport, not a provisioned or activated backend.
 * Inject an already authorized @vercel/blob SDK. Never create/extract/save tokens,
 * initialize a missing ledger, downgrade to public access, or enable a job here.
 * Remote privacy, retention and recovery checks remain separate prerequisites.
 */
import { canonicalJson } from './virtual-autonomy.mjs';
import { ReservationConflict } from './research-reservations.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(`research-blob: ${message}`); };
const strongVersion = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/^[wW]\//.test(value) && !/[\s*,\u0000-\u001f\u007f]/.test(value) && value !== '""';
const MAX_BYTES = 1024 * 1024;
const assertSdkEnvironment = () => {
  // A read-write token takes precedence over storeId in the SDK's fallback auth.
  // Restrict preparation to already authorized store-scoped OIDC, without reading
  // token values. Development routing/version overrides must never redirect I/O.
  assert(!('BLOB_READ_WRITE_TOKEN' in process.env), 'static token fallback is not allowed');
  for (const name of ['VERCEL_BLOB_API_URL', 'NEXT_PUBLIC_VERCEL_BLOB_API_URL',
    'VERCEL_BLOB_API_VERSION_OVERRIDE', 'NEXT_PUBLIC_VERCEL_BLOB_API_VERSION_OVERRIDE',
    'VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API', 'NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API']) {
    assert(!(name in process.env), 'SDK endpoint/version override is not allowed');
  }
};

async function readBody(stream) {
  assert(stream && typeof stream.getReader === 'function', 'ledger response body missing');
  const reader = stream.getReader(), chunks = [];
  let size = 0, finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      assert(value instanceof Uint8Array, 'invalid ledger response chunk');
      size += value.byteLength;
      assert(size <= MAX_BYTES, 'ledger exceeds size limit');
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    if (!finished) { try { await reader.cancel(); } catch { /* Original failure wins. */ } }
    reader.releaseLock();
  }
}

export function createPrivateBlobReservationStore({ ledgerId, storeId, pathname, sdk }) {
  assert(typeof ledgerId === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(ledgerId), 'invalid ledger identity');
  assert(typeof storeId === 'string' && /^store_[a-zA-Z0-9_-]+$/.test(storeId), 'explicit Blob store ID required');
  assert(typeof pathname === 'string' && /^[a-zA-Z0-9_.\/-]+$/.test(pathname)
    && !pathname.startsWith('/') && pathname.split('/').every(p => p && p !== '.' && p !== '..')
    && pathname.endsWith('.json') && pathname.length <= 950, 'explicit relative JSON pathname required');
  assert(sdk && typeof sdk.get === 'function' && typeof sdk.put === 'function'
    && typeof sdk.BlobPreconditionFailedError === 'function'
    && sdk.BlobPreconditionFailedError !== Error
    && sdk.BlobPreconditionFailedError.prototype instanceof Error,
  'SDK with a dedicated precondition error class required');
  // Snapshot function references. A caller cannot redirect an in-flight adapter by
  // replacing methods on its sdk object while an authoritative read is awaiting.
  const get = sdk.get.bind(sdk), put = sdk.put.bind(sdk), PreconditionFailed = sdk.BlobPreconditionFailedError;
  return Object.freeze({
    ledgerId, syntheticOnly: true, // Production activation is deliberately unavailable.
    async read() {
      assertSdkEnvironment();
      // Read body and ETag together. A separate head/get pair can mix revisions.
      const response = await get(pathname, { access: 'private', storeId, useCache: false,
        abortSignal: AbortSignal.timeout(30000) });
      assert(response?.statusCode === 200, 'existing uncached ledger required');
      const metadata = response.blob;
      assert(metadata?.pathname === pathname && metadata.url === `https://${storeId.slice(6)}.private.blob.vercel-storage.com/${pathname}`
        && strongVersion(metadata.etag), 'ledger path or ETag mismatch');
      assert(Number.isSafeInteger(metadata.size) && metadata.size >= 0 && metadata.size <= MAX_BYTES,
        'invalid ledger size');
      const version = metadata.etag, size = metadata.size;
      const bytes = await readBody(response.stream);
      assert(Buffer.byteLength(bytes, 'utf8') === size, 'ledger body length mismatch');
      return { version, document: JSON.parse(bytes) };
    },
    async compareAndSwap(version, document) {
      assertSdkEnvironment();
      assert(process.env.VERCEL_BLOB_RETRIES === '0', 'SDK automatic retries must be disabled before writes');
      assert(strongVersion(version), 'strong observed ETag required');
      // The reservation controller validates schema and monotonic transitions.
      assert(document?.ledgerId === ledgerId, 'ledger identity mismatch');
      const content = canonicalJson(document) + '\n';
      assert(Buffer.byteLength(content, 'utf8') <= MAX_BYTES, 'ledger exceeds size limit');
      try {
        await put(pathname, content, { access: 'private', storeId, addRandomSuffix: false,
          allowOverwrite: true, ifMatch: version, multipart: false, contentType: 'application/json',
          abortSignal: AbortSignal.timeout(30000) });
      } catch (error) {
        // Name/status guessing could misclassify an uncertain write as retryable.
        // Only the exact SDK's dedicated rejected-precondition class is safe.
        if (error instanceof PreconditionFailed) throw new ReservationConflict('Blob rejected stale ETag');
        throw error;
      }
      // A successful SDK response is not a receipt. change() always rereads and
      // requires the exact attempt/result to be present before fitting or success.
    },
  });
}

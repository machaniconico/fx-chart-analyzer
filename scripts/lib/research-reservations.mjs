/** Shared, monotonic holdout reservations. Stores must provide authoritative reads
 * and atomic compare-and-swap; a local artifact directory is never an authority.
 * No expiry, takeover, deletion, automatic initialization, or trading operations.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, fingerprint } from './virtual-autonomy.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(`research-reservation: ${message}`); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const copy = value => JSON.parse(canonicalJson(value));
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const immutable = entry => {
  const { status, resultHash, completedAt, ...identity } = entry;
  return identity;
};
export class ReservationConflict extends Error {}

/** Explicit bootstrap helper, not called by the production reader. Imported
 * historical reservations must be retained; never start an empty ledger to reset
 * previously consumed data. Persist in an approved shared destination separately.
 */
export function reservationGenesis(ledgerId, reservations = [], consumedBefore = 0) {
  const document = { schemaVersion: 1, ledgerId, revision: 0, consumedBefore, reservations: copy(reservations) };
  validateLedger(document, ledgerId);
  return document;
}

function validateLedger(document, ledgerId) {
  canonicalJson(document);
  assert(id(ledgerId) && document?.ledgerId === ledgerId, 'ledger identity mismatch');
  assert(document.schemaVersion === 1 && time(document.revision) && time(document.consumedBefore) && Array.isArray(document.reservations), 'invalid ledger');
  const cycles = new Set(), attempts = new Set(), tests = new Set(), batches = new Map();
  let end = -1;
  for (const r of document.reservations) {
    assert(hash(r.cycleId) && hash(r.requestHash) && hash(r.engineHash) && hash(r.testHash) && id(r.attemptId), 'invalid reservation identity');
    assert(time(r.start) && time(r.end) && r.end > r.start && r.start >= end && time(r.reservedAt), 'invalid/nonmonotonic holdout interval');
    assert(!cycles.has(r.cycleId) && !attempts.has(r.attemptId) && !tests.has(r.testHash), 'duplicate reservation');
    assert(r.status === 'reserved' || r.status === 'completed', 'invalid reservation status');
    assert(r.status === 'completed' ? hash(r.resultHash) && time(r.completedAt) && r.completedAt >= r.reservedAt
      : r.resultHash === undefined && r.completedAt === undefined, 'invalid completion');
    if (r.batchId !== undefined || r.batchSize !== undefined || r.batchIndex !== undefined) {
      assert(hash(r.batchId) && Number.isSafeInteger(r.batchSize) && r.batchSize >= 1 && r.batchSize <= 6
        && Number.isSafeInteger(r.batchIndex) && r.batchIndex >= 0 && r.batchIndex < r.batchSize, 'invalid batch membership');
      const group = batches.get(r.batchId) ?? [];
      group.push(r); batches.set(r.batchId, group);
    }
    cycles.add(r.cycleId); attempts.add(r.attemptId); tests.add(r.testHash); end = r.end;
  }
  for (const group of batches.values()) {
    const first = group[0];
    assert(group.length === first.batchSize && group.every((r, index) => r.batchIndex === index && r.batchSize === first.batchSize
      && r.requestHash === first.requestHash && r.engineHash === first.engineHash && r.status === first.status
      && r.resultHash === first.resultHash), 'incomplete or inconsistent batch');
  }
}

function extendsLedger(previous, current) {
  assert(current.consumedBefore >= previous.consumedBefore, 'legacy consumed-through cutoff regressed');
  assert(current.revision >= previous.revision && current.reservations.length >= previous.reservations.length, 'shared ledger regressed');
  if (current.revision === previous.revision) assert(equal(previous, current), 'ledger changed without revision');
  previous.reservations.forEach((r, i) => {
    const next = current.reservations[i];
    assert(equal(immutable(r), immutable(next)), 'reservation removed or rewritten');
    if (r.status === 'completed') assert(equal(r, next), 'completed reservation changed');
  });
}

/** A store's version is opaque (GitHub blob SHA, transactional row revision, etc.).
 * compareAndSwap MUST throw ReservationConflict only when it is known not to
 * have written. Every other error is uncertain, so never blindly retry it.
 */
export async function readReservations(store, previous = null) {
  assert(store && id(store.ledgerId) && typeof store.read === 'function' && typeof store.compareAndSwap === 'function', 'shared reservation store required');
  const snapshot = await store.read();
  assert(snapshot && typeof snapshot.version === 'string' && snapshot.version.length > 0, 'missing authoritative version');
  validateLedger(snapshot.document, store.ledgerId);
  if (previous) extendsLedger(previous.document, snapshot.document);
  return copy(snapshot);
}

async function change(store, initial, propose, findCommitted) {
  let before = initial;
  for (let attempt = 0; attempt < 8; attempt++) {
    const document = propose(before.document);
    document.revision = before.document.revision + 1;
    validateLedger(document, store.ledgerId);
    let failure = null;
    try { await store.compareAndSwap(before.version, copy(document)); } catch (error) { failure = error; }
    // This mandatory read also reconciles an accepted write whose response was lost.
    // If the read fails, throws, or cannot confirm our exact receipt, no fitting or
    // success is allowed. Only an explicitly rejected CAS can be retried.
    const after = await readReservations(store, before);
    const committed = findCommitted(after.document);
    if (committed) return { snapshot: after, reservation: copy(committed) };
    if (!(failure instanceof ReservationConflict)) throw new Error('research-reservation: write outcome unconfirmed; stopped without retry');
    before = after;
  }
  throw new Error('research-reservation: conflict retry limit; stopped');
}

export async function reserveHoldout(store, identity, initial = null) {
  identity = copy(identity);
  const snapshot = initial ?? await readReservations(store);
  const reservation = { ...copy(identity), attemptId: randomUUID(), reservedAt: Date.now(), status: 'reserved' };
  // The random attempt identifier is never reused by a new process. Even an
  // identical request cannot take over a reservation left by an interrupted run.
  const propose = document => {
    assert(reservation.start >= document.consumedBefore, 'legacy consumed-through cutoff; use a later untouched holdout');
    assert(!document.reservations.some(r => r.cycleId === reservation.cycleId), 'interrupted or completed cycle: holdout is consumed');
    assert(!document.reservations.some(r => r.testHash === reservation.testHash || (reservation.start < r.end && reservation.end > r.start)), 'holdout reused or overlapping, including renamed datasets');
    assert(!document.reservations.some(r => reservation.start < r.end), 'new cycles require a later untouched holdout');
    return { ...copy(document), reservations: [...copy(document.reservations), reservation] };
  };
  return change(store, snapshot, propose, document => document.reservations.find(r => equal(r, reservation)));
}

/** Atomically consume every planned outer interval before any fitting. There is
 * no partial success, release, takeover, or automatic rollback. Each fold keeps
 * its own ordinary reservation so old readers still protect all consumed data.
 * This primitive does not certify provenance or authorize observed research.
 */
export async function reserveHoldoutBatch(store, identities, initial = null) {
  identities = copy(identities);
  assert(Array.isArray(identities) && identities.length > 0 && identities.length <= 6, 'batch must contain 1..6 holdouts');
  const batchId = fingerprint({ identities, nonce: randomUUID() });
  const reservations = identities.map((identity, batchIndex) => ({ ...identity, attemptId: randomUUID(), reservedAt: Date.now(), status: 'reserved',
    batchId, batchIndex, batchSize: identities.length }));
  const first = reservations[0];
  assert(reservations.every(r => r.requestHash === first.requestHash && r.engineHash === first.engineHash), 'batch must share request and engine identities');
  // Validate the whole ordered batch before the first external await or write.
  validateLedger(reservationGenesis(store.ledgerId, reservations), store.ledgerId);
  const snapshot = initial ? copy(initial) : await readReservations(store);
  const receipt = await change(store, snapshot, document => {
    assert(first.start >= document.consumedBefore, 'legacy consumed-through cutoff; use later untouched holdouts');
    for (const reservation of reservations) {
      assert(!document.reservations.some(r => r.cycleId === reservation.cycleId), 'interrupted or completed batch: holdout is consumed');
      assert(!document.reservations.some(r => r.testHash === reservation.testHash || (reservation.start < r.end && reservation.end > r.start)), 'batch holdout reused or overlapping');
    }
    assert(!document.reservations.some(r => first.start < r.end), 'new batches require later untouched holdouts');
    return { ...copy(document), reservations: [...copy(document.reservations), ...copy(reservations)] };
  }, document => reservations.every(expected => document.reservations.some(r => equal(r, expected))) ? reservations : null);
  return { snapshot: receipt.snapshot, reservations: receipt.reservation };
}

/** Complete the exact batch in one conditional update, binding every fold to the
 * same full result artifact. An unconfirmed completion never returns success.
 */
export async function completeReservationBatch(store, receipt, resultHash) {
  receipt = copy(receipt);
  const expected = receipt.reservations;
  assert(hash(resultHash) && Array.isArray(expected) && expected.length > 0 && expected.length <= 6
    && expected.every(r => r.status === 'reserved' && r.batchId === expected[0].batchId && hash(r.batchId)), 'invalid batch completion receipt');
  validateLedger(reservationGenesis(store.ledgerId, expected), store.ledgerId);
  assert(expected.every(r => r.requestHash === expected[0].requestHash && r.engineHash === expected[0].engineHash), 'batch receipt identity mismatch');
  assert(receipt.snapshot?.document?.ledgerId === store.ledgerId
    && expected.every(r => receipt.snapshot.document.reservations.some(saved => equal(saved, r))), 'batch receipt snapshot mismatch');
  const completed = expected.map(r => ({ ...r, status: 'completed', resultHash, completedAt: Math.max(Date.now(), r.reservedAt) }));
  const current = await readReservations(store, receipt.snapshot);
  const result = await change(store, current, document => {
    const next = copy(document);
    expected.forEach((reservation, index) => {
      const i = next.reservations.findIndex(r => r.cycleId === reservation.cycleId);
      assert(i >= 0 && equal(next.reservations[i], reservation), 'batch completion ownership/status mismatch');
      next.reservations[i] = completed[index];
    });
    return next;
  }, document => completed.every(expected => document.reservations.some(r => equal(r, expected))) ? completed : null);
  return { snapshot: result.snapshot, reservations: result.reservation };
}

export async function completeReservation(store, receipt, resultHash) {
  assert(hash(resultHash) && receipt.reservation.status === 'reserved', 'invalid completion receipt');
  assert(receipt.reservation.batchId === undefined, 'grouped reservation requires whole-batch completion');
  const expected = receipt.reservation;
  const completed = { ...expected, status: 'completed', resultHash, completedAt: Math.max(Date.now(), expected.reservedAt) };
  const current = await readReservations(store, receipt.snapshot);
  return change(store, current, document => {
    const i = document.reservations.findIndex(r => r.cycleId === expected.cycleId);
    assert(i >= 0 && equal(document.reservations[i], expected), 'completion ownership/status mismatch');
    const next = copy(document); next.reservations[i] = completed; return next;
  }, document => document.reservations.find(r => equal(r, completed)));
}

/** Adapter for the existing GitHub connector. readFile/updateFile are injected
 * connected-tool calls. No credentials are created, extracted, or persisted here.
 * Pin a dedicated existing branch, path AND ledgerId in trusted runner config.
 * Missing files are errors, not permission to create an empty replacement.
 */
export function createGitHubReservationStore({ ledgerId, repository, branch, path, readFile, updateFile }) {
  assert(id(ledgerId) && /^[\w.-]+\/[\w.-]+$/.test(repository) && typeof branch === 'string' && branch.length > 0
    && typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..'), 'invalid GitHub ledger location');
  assert(typeof readFile === 'function' && typeof updateFile === 'function', 'connected read/update functions required');
  return {
    ledgerId,
    async read() {
      const response = await readFile({ repository_full_name: repository, path, ref: branch });
      assert(response && !response.isError, 'GitHub read failed');
      const value = response.structuredContent ?? response;
      assert(typeof value.content === 'string' && /^[a-f0-9]{40,64}$/.test(value.sha), 'invalid GitHub snapshot');
      return { version: value.sha, document: JSON.parse(value.content) };
    },
    async compareAndSwap(version, document) {
      let response;
      try {
        response = await updateFile({ repository_full_name: repository, branch, path, sha: version,
          message: 'research: persist holdout reservation state', content: canonicalJson(document) + '\n' });
      } catch (error) {
        if (error.status === 409) throw new ReservationConflict('GitHub rejected stale version');
        throw error;
      }
      if (response?.isError) {
        if (response.structuredContent?.status === 409) throw new ReservationConflict('GitHub rejected stale version');
        throw new Error('GitHub write response uncertain');
      }
      // Success is deliberately verified by an authoritative read in change().
    },
  };
}

/** Optional standalone transport using an already provisioned, in-memory token.
 * This does not configure or grant access, create credentials, or bootstrap state.
 * Production activation must separately verify destination, access and retention.
 */
export function createGitHubHttpStore({ token, fetchImpl = globalThis.fetch, ...location }) {
  assert(typeof token === 'string' && token.length > 0, 'existing authorized GitHub credential required');
  const api = async (suffix, init = {}) => {
    const response = await fetchImpl(`https://api.github.com/repos/${location.repository}${suffix}`, {
      ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const error = new Error(`GitHub ledger request failed (${response.status})`); error.status = response.status; throw error;
    }
    return response.json();
  };
  const filePath = location.path?.split('/').map(encodeURIComponent).join('/');
  const store = createGitHubReservationStore({ ...location,
    readFile: async ({ ref }) => {
      const file = await api(`/contents/${filePath}?ref=${encodeURIComponent(ref)}`);
      assert(file.encoding === 'base64' && file.type === 'file' && typeof file.content === 'string', 'GitHub ledger content missing');
      return { content: Buffer.from(file.content, 'base64').toString('utf8'), sha: file.sha };
    },
    updateFile: async ({ sha, content, branch, message }) => api(`/contents/${filePath}`, {
      method: 'PUT', body: JSON.stringify({ sha, content: Buffer.from(content).toString('base64'), branch, message }),
    }),
  });
  return { ...store, async verifyPrivateDestination() {
    const repository = await api('');
    assert(repository.private === true && repository.full_name === location.repository, 'private ledger repository required');
    // Contents reads verify access/file identity. No remote write is made here.
    return readReservations(store);
  } };
}

/** Credential-free filesystem reference store for SYNTHETIC TESTS ONLY.
 * Separate research directories/processes may share this test authority.
 * Not a network-filesystem/distributed-lock or production durability promise.
 */
export function createSyntheticFileStore(directory, ledgerId = 'synthetic-test-ledger') {
  const root = resolve(directory), path = join(root, 'reservations.json'), lockPath = join(root, 'reservations.lock');
  mkdirSync(root, { recursive: true });
  const syncDirectory = () => { const fd = openSync(root, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
  // Exclusive creation is safe for concurrent fixture startup. Never overwrite.
  let fd;
  try { fd = openSync(path, 'wx', 0o600); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fd !== undefined) {
    try { writeFileSync(fd, canonicalJson(reservationGenesis(ledgerId)) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory();
  }
  return {
    ledgerId, syntheticOnly: true,
    async read() { const bytes = readFileSync(path, 'utf8'); return { version: fingerprint(bytes), document: JSON.parse(bytes) }; },
    async compareAndSwap(version, document) {
      // A residual lock is uncertainty, not a retryable conflict or an expired lease.
      const lock = openSync(lockPath, 'wx', 0o600);
      try {
        fsyncSync(lock); syncDirectory();
        const bytes = readFileSync(path, 'utf8');
        if (fingerprint(bytes) !== version) throw new ReservationConflict('stale file version');
        const tmp = join(root, `pending-${randomUUID()}.json`), file = openSync(tmp, 'wx', 0o600);
        try { writeFileSync(file, canonicalJson(document) + '\n'); fsyncSync(file); } finally { closeSync(file); }
        renameSync(tmp, path); syncDirectory();
      } finally { closeSync(lock); unlinkSync(lockPath); syncDirectory(); }
    },
  };
}

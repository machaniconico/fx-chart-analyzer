/** Inactive write-ahead protocol model. Built-in synthetic prices only. Injected
 * stores model independent authorities; flags/hashes do not prove independence,
 * fresh reads, retention or provider durability. No bootstrap, recovery, trading,
 * scheduling, credentials, observed tapes or evaluator callbacks in the runner.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson, fingerprint } from './virtual-autonomy.mjs';
import { createSyntheticOuterPlan, syntheticOuterHoldouts, replaySyntheticOuterPlan } from './synthetic-outer-replay.mjs';
import { readReservations, reserveHoldoutBatch, completeReservationBatch } from './research-reservations.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(`synthetic-witness: ${message}`); };
const copy = value => JSON.parse(canonicalJson(value));
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const keys = (object, expected) => assert(object && Object.getPrototypeOf(object) === Object.prototype
  && same(Object.keys(object).sort(), [...expected].sort()), 'unexpected or missing fields');
const snapshotKeys = snapshot => keys(snapshot, ['version', 'document']);
const identityKeys = ['cycleId', 'requestHash', 'engineHash', 'testHash', 'start', 'end'];
const identityOf = reservation => Object.fromEntries(identityKeys.map(key => [key, reservation[key]]));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const sourceNames = ['witnessed-synthetic-outer-replay.mjs', 'synthetic-outer-replay.mjs', 'virtual-research-cycle.mjs',
  'virtual-autonomy.mjs', 'virtual-portfolio.mjs', 'research-reservations.mjs', 'research-git-store.mjs', 'research-blob-store.mjs'];
const sources = () => sourceNames.map(name => ({ name, source: readFileSync(new URL(name, import.meta.url), 'utf8') }));
const loadedSourcesHash = fingerprint(sources());
const sourceSnapshot = () => {
  const result = sources(); assert(fingerprint(result) === loadedSourcesHash, 'engine changed; restart required'); return result;
};
const validateSnapshot = async (snapshot, ledgerId) => {
  snapshotKeys(snapshot);
  return readReservations({ ledgerId, read: async () => snapshot, compareAndSwap() {} });
};
const genesisBody = document => {
  const { events, genesisHash, ...body } = document; return body;
};
const checkpoint = document => ({ witnessId: document.witnessId, ledgerScopeHash: document.ledgerScopeHash,
  sequence: document.events.length, hash: document.events.at(-1)?.hash ?? document.genesisHash });

/** Explicit fixture helper only. The runner never initializes an absent witness
 * or ledger. Baseline must retain every existing reservation and consumedBefore.
 * An actual independent bootstrap/cutover is not implemented or authorized here.
 */
export async function syntheticWitnessGenesis(options) {
  options = copy(options);
  keys(options, ['witnessId', 'ledgerScopeHash', 'baseline']);
  assert(id(options.witnessId) && hash(options.ledgerScopeHash), 'invalid witness identity/scope');
  const baseline = await validateSnapshot(options.baseline, options.baseline.document?.ledgerId);
  const body = { schemaVersion: 1, syntheticOnly: true, witnessId: options.witnessId,
    ledgerScopeHash: options.ledgerScopeHash, ledgerId: baseline.document.ledgerId, baseline };
  const document = { ...body, genesisHash: fingerprint(body), events: [] };
  return freeze({ document, checkpoint: checkpoint(document) });
}

const validateIdentities = identities => {
  assert(Array.isArray(identities) && identities.length >= 1 && identities.length <= 6, 'invalid intent intervals');
  let end = -1;
  const cycles = new Set(), tests = new Set();
  for (const r of identities) {
    keys(r, identityKeys);
    assert(['cycleId', 'requestHash', 'engineHash', 'testHash'].every(key => hash(r[key]))
      && time(r.start) && time(r.end) && r.end > r.start && r.start >= end, 'invalid intent identity/chronology');
    assert(!cycles.has(r.cycleId) && !tests.has(r.testHash)
      && r.requestHash === identities[0].requestHash && r.engineHash === identities[0].engineHash, 'inconsistent intent');
    cycles.add(r.cycleId); tests.add(r.testHash); end = r.end;
  }
};

/** Verify a complete append-only history, including the exact ledger projection.
 * Full snapshots are deliberate: neither a truncated batch nor untracked state
 * changes may silently become a new baseline. Size is bounded, not auto-pruned.
 */
async function validateWitness(document, binding, pin) {
  assert(Buffer.byteLength(canonicalJson(document)) <= 2 * 1024 * 1024, 'witness size limit; explicit archival protocol required');
  keys(document, ['schemaVersion', 'syntheticOnly', 'witnessId', 'ledgerScopeHash', 'ledgerId', 'baseline', 'genesisHash', 'events']);
  assert(document.schemaVersion === 1 && document.syntheticOnly === true && document.witnessId === binding.witnessId
    && document.ledgerScopeHash === binding.ledgerScopeHash && document.ledgerId === binding.ledgerId
    && hash(document.genesisHash) && document.genesisHash === fingerprint(genesisBody(document))
    && Array.isArray(document.events) && document.events.length <= 300, 'witness identity/genesis mismatch');
  keys(pin, ['witnessId', 'ledgerScopeHash', 'sequence', 'hash']);
  assert(pin.witnessId === document.witnessId && pin.ledgerScopeHash === document.ledgerScopeHash
    && time(pin.sequence) && hash(pin.hash) && pin.sequence <= document.events.length
    && (pin.sequence ? document.events[pin.sequence - 1]?.hash : document.genesisHash) === pin.hash, 'trusted checkpoint missing or rolled back');
  let ledger = await validateSnapshot(document.baseline, binding.ledgerId), pending = null, previousHash = document.genesisHash, previousTime = 0;
  const attempts = new Set();
  for (const [index, event] of document.events.entries()) {
    keys(event, ['sequence', 'previousHash', 'phase', 'attemptId', 'recordedAt', 'payload', 'hash']);
    const { hash: eventHash, ...body } = event;
    assert(event.sequence === index + 1 && event.previousHash === previousHash && eventHash === fingerprint(body)
      && id(event.attemptId) && time(event.recordedAt) && event.recordedAt >= previousTime, 'invalid event chain');
    if (event.phase === 'intent') {
      assert(pending === null && !attempts.has(event.attemptId), 'unresolved or duplicate intent');
      keys(event.payload, ['identities', 'ledgerCheckpoint']);
      validateIdentities(event.payload.identities);
      assert(same(event.payload.ledgerCheckpoint, { version: ledger.version, documentHash: fingerprint(ledger.document) }), 'intent ledger checkpoint mismatch');
      const identities = event.payload.identities, first = identities[0];
      assert(first.start >= ledger.document.consumedBefore
        && ledger.document.reservations.every(r => first.start >= r.end
          && identities.every(i => i.cycleId !== r.cycleId && i.testHash !== r.testHash)), 'intent interval already consumed');
      pending = { intent: event, receipt: null }; attempts.add(event.attemptId);
    } else if (event.phase === 'reserved') {
      assert(pending && !pending.receipt && event.attemptId === pending.intent.attemptId, 'reservation without matching intent');
      keys(event.payload, ['snapshot', 'reservations']);
      const receipt = event.payload, next = await validateSnapshot(receipt.snapshot, binding.ledgerId);
      assert(Array.isArray(receipt.reservations) && same(receipt.reservations.map(identityOf), pending.intent.payload.identities), 'reserved intervals differ from whole intent');
      const first = receipt.reservations[0];
      assert(first.batchSize === receipt.reservations.length && hash(first.batchId)
        && receipt.reservations.every((r, i) => r.status === 'reserved' && r.batchId === first.batchId && r.batchIndex === i
          && r.batchSize === first.batchSize), 'invalid reservation membership');
      assert(next.version !== ledger.version && same(next.document, { ...ledger.document,
        revision: ledger.document.revision + 1, reservations: [...ledger.document.reservations, ...receipt.reservations] }), 'ledger reservation transition mismatch');
      pending.receipt = receipt; ledger = next;
    } else if (event.phase === 'completed') {
      assert(pending?.receipt && event.attemptId === pending.intent.attemptId, 'completion without matching reservation');
      keys(event.payload, ['snapshot', 'reservations', 'resultHash']);
      const { reservations, resultHash } = event.payload, next = await validateSnapshot(event.payload.snapshot, binding.ledgerId);
      assert(hash(resultHash) && Array.isArray(reservations) && reservations.length === pending.receipt.reservations.length, 'invalid completion receipt');
      const expected = pending.receipt.reservations;
      assert(reservations.every((r, i) => {
        const { resultHash: actualHash, completedAt, ...rest } = r;
        return actualHash === resultHash && time(completedAt) && completedAt >= expected[i].reservedAt
          && same(rest, { ...expected[i], status: 'completed' });
      }), 'completed ownership/result mismatch');
      const nextReservations = [...ledger.document.reservations.slice(0, -expected.length), ...reservations];
      assert(next.version !== ledger.version && same(next.document, { ...ledger.document,
        revision: ledger.document.revision + 1, reservations: nextReservations }), 'ledger completion transition mismatch');
      ledger = next; pending = null;
    } else throw new Error('synthetic-witness: unsupported phase');
    previousHash = eventHash; previousTime = event.recordedAt;
  }
  return { ledger, pending, checkpoint: checkpoint(document) };
}

function storesFor(options) {
  const r = options.reservationStore, w = options.witnessStore;
  assert(r?.syntheticOnly === true && w?.syntheticOnly === true, 'explicit synthetic-only authorities required');
  assert(id(r.ledgerId) && id(w.witnessId) && hash(r.scopeHash) && w.ledgerScopeHash === r.scopeHash
    && id(r.authorityId) && id(w.authorityId) && r.authorityId !== w.authorityId, 'distinct authorities and fixed ledger scope required');
  for (const store of [r, w]) assert(typeof store.read === 'function' && typeof store.compareAndSwap === 'function', 'authoritative read/CAS required');
  // Snapshot methods and identity before any await; caller mutation cannot switch
  // a destination. This cannot defend against a malicious store implementation.
  return { ledger: Object.freeze({ ledgerId: r.ledgerId, syntheticOnly: true, read: r.read.bind(r), compareAndSwap: r.compareAndSwap.bind(r) }),
    witness: Object.freeze({ read: w.read.bind(w), compareAndSwap: w.compareAndSwap.bind(w) }),
    binding: { ledgerId: r.ledgerId, witnessId: w.witnessId, ledgerScopeHash: r.scopeHash } };
}

/** This audit performs no write, fitting or recovery and always reports inactive.
 * A pending intent consumes all of its intervals even if the ledger never wrote.
 */
export async function inspectSyntheticWitness(options) {
  keys(options, ['reservationStore', 'witnessStore', 'trustedCheckpoint']);
  const stores = storesFor(options), pin = copy(options.trustedCheckpoint);
  return inspect(stores, pin);
}
async function readWitness(stores, pin, previous = null) {
  const snapshot = copy(await stores.witness.read()); snapshotKeys(snapshot);
  assert(typeof snapshot.version === 'string' && snapshot.version.length > 0, 'missing witness version');
  const state = await validateWitness(snapshot.document, stores.binding, pin);
  if (previous) {
    assert(same(genesisBody(snapshot.document), genesisBody(previous.document)) && snapshot.document.events.length >= previous.document.events.length
      && same(snapshot.document.events.slice(0, previous.document.events.length), previous.document.events), 'witness history rewritten or regressed');
    if (snapshot.version === previous.version) assert(same(snapshot.document, previous.document), 'witness changed without version');
  }
  return { snapshot, state };
}
async function inspect(stores, pin) {
  const { snapshot, state } = await readWitness(stores, pin);
  const ledger = await readReservations(stores.ledger);
  assert(same(ledger, state.ledger), 'ledger differs from witnessed state; recovery required');
  return { activationReady: false, action: 'hold', state: state.pending ? 'unresolved-intent' : 'consistent',
    pendingIntervals: state.pending?.intent.payload.identities ?? [], checkpoint: state.checkpoint, snapshot, ledger };
}
async function append(stores, current, phase, attemptId, payload) {
  const body = { sequence: current.document.events.length + 1,
    previousHash: current.document.events.at(-1)?.hash ?? current.document.genesisHash,
    phase, attemptId, recordedAt: Math.max(Date.now(), current.document.events.at(-1)?.recordedAt ?? 0), payload: copy(payload) };
  const event = { ...body, hash: fingerprint(body) };
  const next = { ...copy(current.document), events: [...copy(current.document.events), event] };
  // Validation is write-ahead as well: never transmit malformed transitions.
  await validateWitness(next, stores.binding, checkpoint(current.document));
  try { await stores.witness.compareAndSwap(current.version, copy(next)); } catch { /* reconcile only; never blindly retry */ }
  const result = await readWitness(stores, checkpoint(current.document), current);
  assert(result.snapshot.version !== current.version && same(result.snapshot.document, next), 'witness write unconfirmed; stopped without retry');
  return result.snapshot;
}

/** The fixed plan is evaluated only after exact write-ahead intent + ledger
 * reservation + witness binding receipts. Every interruption is fail-closed.
 * There is no automatic takeover, completion retry, artifact recovery or release.
 */
export async function runWitnessedSyntheticOuterReplay(options) {
  keys(options, ['plan', 'reservationStore', 'witnessStore', 'trustedCheckpoint']);
  const stores = storesFor(options), pin = copy(options.trustedCheckpoint), plan = copy(options.plan);
  assert(same(plan, createSyntheticOuterPlan(plan.config)), 'plan changed or engine mismatch');
  const engineSources = sourceSnapshot(), engineHash = fingerprint({ outer: plan.engineHash, orchestrationSources: loadedSourcesHash });
  const requestHash = fingerprint({ mode: 'write-ahead-synthetic-only', plan, engineHash });
  const identities = syntheticOuterHoldouts(plan).map(({ foldIndex, ...identity }) => ({ ...identity,
    requestHash, engineHash, cycleId: fingerprint({ requestHash, foldIndex }) }));
  const initial = await inspect(stores, pin);
  assert(initial.state === 'consistent', 'unresolved intent; all its intervals remain consumed');
  const attemptId = randomUUID();
  let witness = await append(stores, initial.snapshot, 'intent', attemptId, { identities,
    ledgerCheckpoint: { version: initial.ledger.version, documentHash: fingerprint(initial.ledger.document) } });
  const receipt = await reserveHoldoutBatch(stores.ledger, identities, initial.ledger);
  witness = await append(stores, witness, 'reserved', attemptId, receipt);
  // Catch a one-sided rollback between the second write and fitting. Atomicity
  // across authorities is not assumed; an unavailable or stale provider stops.
  const barrier = await inspect(stores, checkpoint(witness.document));
  assert(barrier.state === 'unresolved-intent' && same(barrier.snapshot, witness) && same(barrier.ledger, receipt.snapshot), 'reservation barrier changed');
  sourceSnapshot();
  const replay = replaySyntheticOuterPlan(plan);
  assert(replay.folds.every((fold, index) => fold.testHash === identities[index].testHash), 'reserved test identity mismatch');
  sourceSnapshot();
  const artifact = { schemaVersion: 1, mode: 'write-ahead-synthetic-only', action: 'hold', eligible: false, activationReady: false,
    requestHash, engineHash, plan, engineSources, attemptId, ledgerId: stores.binding.ledgerId,
    witnessId: stores.binding.witnessId, witnessCheckpoint: checkpoint(witness.document), reservations: receipt.reservations, replay,
    limits: ['synthetic_data_not_evidence', 'independent_authority_and_retention_not_verified', 'fresh_reads_require_provider_contract',
      'conservative_cutover_not_implemented', 'historical_inventory_incomplete', 'observed_runner_not_implemented',
      'durable_artifact_and_recovery_not_implemented', 'real_backend_acceptance_not_established'] };
  const resultHash = fingerprint(artifact);
  const completion = await completeReservationBatch(stores.ledger, receipt, resultHash);
  witness = await append(stores, witness, 'completed', attemptId, { ...completion, resultHash });
  const final = await inspect(stores, checkpoint(witness.document));
  assert(final.state === 'consistent' && same(final.snapshot, witness), 'completion barrier changed');
  return { artifact, resultHash, completion, checkpoint: checkpoint(witness.document) };
}

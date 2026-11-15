/** Read-only reconciliation of legacy history reports with an EXISTING ledger.
 * No bootstrap, writes, repair, fitting, prices, witness creation or activation.
 * A proposed cutoff excludes history; it never certifies that later data is fresh.
 */
import { AUTONOMY_TIME_UNIT, canonicalJson, fingerprint } from './virtual-autonomy.mjs';

export const CUTOVER_LIMITS = Object.freeze({ inputBytes: 8 * 1024 * 1024, snapshotBytes: 2 * 1024 * 1024,
  sources: 64, reservations: 2048, reportEntries: 2048, arrayEntries: 4096,
  // Deliberately reject seconds/microseconds and unsupported historical epochs.
  // Never guess or convert a unit, including in otherwise valid old reports.
  minimumTime: Date.UTC(2000, 0, 1), maximumTime: Date.UTC(2100, 0, 1) });
const assert = (ok, message) => { if (!ok) throw new Error(`research-cutover: ${message}`); };
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
const sourceId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => Number.isSafeInteger(value) && value >= CUTOVER_LIMITS.minimumTime && value < CUTOVER_LIMITS.maximumTime;
const text = (value, max = 2000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const path = value => text(value, 1000) && value.split('/').every(part => /^[a-zA-Z0-9_.@-]+$/.test(part) && part !== '.' && part !== '..');
const keys = (object, required) => assert(object && Object.getPrototypeOf(object) === Object.prototype
  && same(Object.keys(object).sort(), [...required].sort()), 'unexpected or missing fields');
const array = (value, limit, label) => assert(Array.isArray(value) && value.length <= limit, `${label} count limit`);
const unit = value => assert(value.schemaVersion === 1 && value.timeUnit === AUTONOMY_TIME_UNIT, 'explicit UTC millisecond timeUnit/schema required on every persisted input');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

/** Snapshot descriptor values, not getters/toJSON. Reject sparse arrays BEFORE
 * canonicalJson (whose generic legacy contract does not reject array holes).
 * Bounded traversal also rejects cycles, symbols, extra array fields and classes.
 */
function snapshot(value, maxBytes = CUTOVER_LIMITS.inputBytes) {
  let bytes = 0, nodes = 0;
  const seen = new Set();
  const charge = length => { bytes += length; assert(bytes <= maxBytes, 'input byte limit'); };
  const visit = (current, depth = 0) => {
    assert(++nodes <= 100000 && depth <= 32, 'input depth/node limit');
    if (current === null || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') {
      assert(typeof current !== 'number' || (Number.isFinite(current) && !Object.is(current, -0)), 'finite JSON values required');
      assert(typeof current !== 'string' || current.length <= 16384, 'input string limit');
      charge(Buffer.byteLength(JSON.stringify(current))); return current;
    }
    assert(current && typeof current === 'object' && !seen.has(current), 'plain acyclic JSON required');
    seen.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current), own = Reflect.ownKeys(descriptors);
    assert(own.every(key => typeof key === 'string'), 'symbol fields forbidden');
    const list = Array.isArray(current);
    assert(Object.getPrototypeOf(current) === (list ? Array.prototype : Object.prototype), 'plain JSON objects/arrays required');
    let names = own;
    if (list) {
      assert(current.length <= CUTOVER_LIMITS.arrayEntries && own.length === current.length + 1
        && own.at(-1) === 'length' && own.slice(0, -1).every((key, i) => key === String(i)), 'dense bounded arrays required');
      names = own.slice(0, -1);
    }
    charge(2 + names.length);
    const result = list ? [] : {};
    for (const name of names) {
      const descriptor = descriptors[name];
      assert(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'accessor/hidden fields forbidden');
      assert(name.length <= 1000, 'input key limit');
      if (!list) charge(Buffer.byteLength(JSON.stringify(name)) + 1);
      Object.defineProperty(result, name, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(current); return result;
  };
  return visit(value);
}

const identityKeys = ['cycleId', 'requestHash', 'engineHash', 'testHash', 'start', 'end'];
const identity = entry => Object.fromEntries(identityKeys.map(key => [key, entry[key]]));
const immutable = entry => {
  const { status, resultHash, completedAt, ...rest } = entry; return rest;
};
const tail = document => document.reservations.at(-1)?.end ?? 0;

/** A stricter boundary than the historical ledger reader: exact schemas, bounded
 * modern UTC-ms times and complete batches. No extensions are silently dropped.
 */
function validateLedger(document, ledgerId) {
  keys(document, ['schemaVersion', 'ledgerId', 'revision', 'consumedBefore', 'reservations']);
  assert(document.schemaVersion === 1 && id(ledgerId) && document.ledgerId === ledgerId, 'ledger identity/schema mismatch');
  assert(integer(document.revision) && (document.consumedBefore === 0 || time(document.consumedBefore)), 'invalid ledger revision/UTC-ms cutoff');
  array(document.reservations, CUTOVER_LIMITS.reservations, 'ledger reservations');
  const cycles = new Set(), tests = new Set(), attempts = new Set(), batches = new Map();
  let lastEnd = 0;
  for (const r of document.reservations) {
    const batched = ['batchId', 'batchIndex', 'batchSize'].some(key => Object.hasOwn(r, key));
    keys(r, [...identityKeys, 'attemptId', 'reservedAt', 'status', ...(r.status === 'completed' ? ['resultHash', 'completedAt'] : []),
      ...(batched ? ['batchId', 'batchIndex', 'batchSize'] : [])]);
    assert(identityKeys.slice(0, 4).every(key => hash(r[key])) && id(r.attemptId), 'invalid reservation identity');
    assert(time(r.start) && time(r.end) && r.end > r.start && r.start >= lastEnd && time(r.reservedAt), 'invalid reservation UTC-ms interval/order');
    assert(!cycles.has(r.cycleId) && !tests.has(r.testHash) && !attempts.has(r.attemptId), 'duplicate reservation identity');
    assert(r.status === 'reserved' || r.status === 'completed', 'invalid reservation status');
    if (r.status === 'completed') assert(hash(r.resultHash) && time(r.completedAt) && r.completedAt >= r.reservedAt, 'invalid completion');
    if (batched) {
      assert(hash(r.batchId) && integer(r.batchSize) && r.batchSize >= 1 && r.batchSize <= 6
        && integer(r.batchIndex) && r.batchIndex < r.batchSize, 'invalid batch membership');
      const group = batches.get(r.batchId) ?? [];
      group.push(r); batches.set(r.batchId, group);
    }
    cycles.add(r.cycleId); tests.add(r.testHash); attempts.add(r.attemptId); lastEnd = r.end;
  }
  for (const group of batches.values()) {
    const first = group[0];
    assert(group.length === first.batchSize && group.every((r, i) => r.batchIndex === i && r.batchSize === first.batchSize
      && r.requestHash === first.requestHash && r.engineHash === first.engineHash && r.status === first.status
      && r.resultHash === first.resultHash), 'incomplete/inconsistent batch');
  }
}

function validateBinding(binding) {
  keys(binding, ['ledgerId', 'repository', 'branch', 'path']);
  assert(id(binding.ledgerId) && typeof binding.repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(binding.repository)
    && text(binding.branch, 255) && !/[\s\x00-\x1f\x7f]/.test(binding.branch) && path(binding.path), 'invalid fixed ledger binding');
}

function validateEnvelope(envelope, binding) {
  keys(envelope, ['schemaVersion', 'timeUnit', 'scopeHash', 'snapshot', 'documentHash']); unit(envelope);
  assert(hash(envelope.scopeHash) && envelope.scopeHash === fingerprint(binding), 'ledger scope mismatch');
  keys(envelope.snapshot, ['version', 'document']);
  assert(text(envelope.snapshot.version, 256), 'authoritative ledger version required');
  validateLedger(envelope.snapshot.document, binding.ledgerId);
  assert(hash(envelope.documentHash) && envelope.documentHash === fingerprint(envelope.snapshot.document), 'ledger document hash mismatch');
}

function extendsSnapshot(previous, current) {
  const old = previous.snapshot.document, next = current.snapshot.document;
  assert(next.consumedBefore >= old.consumedBefore, 'existing ledger cutoff regressed');
  assert(next.revision >= old.revision && next.reservations.length >= old.reservations.length, 'existing ledger regressed');
  if (next.revision === old.revision || current.snapshot.version === previous.snapshot.version)
    assert(same(old, next), 'ledger changed without revision/version');
  old.reservations.forEach((record, index) => {
    const actual = next.reservations[index];
    assert(same(immutable(record), immutable(actual)), 'existing reservation removed, reordered or rewritten');
    if (record.status === 'completed') assert(same(record, actual), 'existing completed reservation changed');
  });
  // New suffix consumption must respect the cutoff that existed before append.
  assert(next.reservations.slice(old.reservations.length).every(r => r.start >= old.consumedBefore), 'new reservation predates retained cutoff');
}

function validateReportSource(source, ledgerId) {
  keys(source, ['schemaVersion', 'timeUnit', 'sourceId', 'reportHash', 'report']); unit(source);
  assert(sourceId(source.sourceId) && hash(source.reportHash) && fingerprint(source.report) === source.reportHash, 'history source identity/hash mismatch');
  const report = source.report;
  keys(report, ['schemaVersion', 'mode', 'activationReady', 'manifestHash', 'manifestPinMatched', 'anchorCustodyVerified',
    'historicalCompletenessProven', 'verifiedFileCount', 'journals', 'referencedArtifactCount', 'selectedReports',
    'exactReservations', 'proposedLedger', 'knownReservationEnd', 'blockers']);
  assert(report.schemaVersion === 1 && report.mode === 'read-only-history-audit' && report.activationReady === false
    && report.historicalCompletenessProven === false && report.anchorCustodyVerified === false
    && (report.manifestPinMatched === null || report.manifestPinMatched === true) && hash(report.manifestHash), 'unsupported history audit report');
  assert(integer(report.verifiedFileCount) && report.verifiedFileCount >= 1 && report.verifiedFileCount <= 10000
    && integer(report.referencedArtifactCount) && report.referencedArtifactCount <= report.verifiedFileCount, 'invalid history report counts');
  for (const name of ['journals', 'selectedReports', 'blockers']) array(report[name], CUTOVER_LIMITS.reportEntries, name);
  assert(report.journals.length >= 1 && report.journals.length <= report.verifiedFileCount
    && report.blockers.every(value => text(value, 200)), 'invalid journal inventory/blockers');
  const paths = new Set();
  for (const journal of report.journals) {
    keys(journal, ['path', 'eventCount', 'sourceHash', 'auditHeadHash', 'artifactCount']);
    assert(path(journal.path) && journal.path.split('/').at(-1) === 'audit.jsonl' && !paths.has(journal.path)
      && hash(journal.sourceHash) && integer(journal.eventCount) && journal.eventCount <= 100000
      && (journal.eventCount === 0 ? journal.auditHeadHash === null : hash(journal.auditHeadHash))
      && integer(journal.artifactCount) && journal.artifactCount <= journal.eventCount
      && journal.artifactCount <= report.referencedArtifactCount, 'invalid history journal');
    paths.add(journal.path);
  }
  assert(report.selectedReports.length <= report.verifiedFileCount, 'invalid selected report count');
  for (const selected of report.selectedReports) {
    keys(selected, ['path', 'sourceHash', 'fullSourcePresent', 'selectedCandidateCount', 'evaluatedCombinationCount']);
    assert(path(selected.path) && !paths.has(selected.path) && hash(selected.sourceHash)
      && typeof selected.fullSourcePresent === 'boolean'
      && ['selectedCandidateCount', 'evaluatedCombinationCount'].every(key => selected[key] === null || integer(selected[key])), 'invalid selected history report');
    paths.add(selected.path);
  }
  validateLedger(report.proposedLedger, ledgerId);
  assert(report.proposedLedger.revision === 0 && report.proposedLedger.consumedBefore === 0, 'history report is not an existing shared ledger');
  assert(report.exactReservations === report.proposedLedger.reservations.length
    && report.exactReservations <= report.journals.reduce((sum, journal) => sum + journal.eventCount, 0)
    && report.knownReservationEnd === tail(report.proposedLedger), 'history reservation count/end mismatch');
  for (const record of report.proposedLedger.reservations) {
    assert(record.status === 'reserved' && record.batchId === undefined
      && record.attemptId === `legacy_${fingerprint(identity(record)).slice(0, 48)}`, 'invalid legacy reservation projection');
  }
}

function validateBound(bound, missing = false) {
  keys(bound, ['schemaVersion', 'timeUnit', ...(missing ? ['sourceId', 'sourceHash'] : []), 'consumedBefore', 'recordedAt', 'evidenceHash', 'reason']); unit(bound);
  assert((missing && bound.consumedBefore === null) || time(bound.consumedBefore), 'explicit UTC-ms quarantine bound required');
  assert(time(bound.recordedAt) && (bound.consumedBefore === null || bound.consumedBefore <= bound.recordedAt)
    && hash(bound.evidenceHash) && text(bound.reason)
    && (!missing || (sourceId(bound.sourceId) && (bound.sourceHash === null || hash(bound.sourceHash)))), 'invalid bound evidence/UTC-ms time');
}

function selectedReportCoverage(historyAudits, missingSources) {
  // fullSourcePresent only records a matching file in a checkpoint. The audit
  // never parsed that file's all-trial consumption, so EVERY selected source
  // needs an explicit hash-bound range, including present-but-unparsed sources.
  const sources = new Map();
  for (const source of historyAudits) {
    for (const selected of source.report.selectedReports) {
      const found = sources.get(selected.sourceHash) ?? [];
      found.push({ sourceId: source.sourceId, path: selected.path, fullSourcePresent: selected.fullSourcePresent });
      sources.set(selected.sourceHash, found);
      assert(sources.size <= CUTOVER_LIMITS.reportEntries, 'combined selected source limit');
    }
  }
  return [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([sourceHash, reports]) => {
    const bound = missingSources.find(source => source.sourceHash === sourceHash);
    return { sourceHash, reports, boundSourceId: bound?.sourceId ?? null, consumedBefore: bound?.consumedBefore ?? null };
  });
}

function reconcile(historyAudits, document) {
  const unique = new Map(), conflicts = [], matched = [], missing = [];
  for (const source of historyAudits) {
    for (const reservation of source.report.proposedLedger.reservations) {
      const digest = fingerprint(reservation), known = unique.get(digest);
      if (known) known.sourceIds.push(source.sourceId);
      else unique.set(digest, { reservation, sourceIds: [source.sourceId] });
    }
  }
  const records = [...unique.values()].sort((a, b) => a.reservation.start - b.reservation.start
    || a.reservation.end - b.reservation.end || fingerprint(a.reservation).localeCompare(fingerprint(b.reservation)));
  assert(records.length <= CUTOVER_LIMITS.reservations, 'combined legacy reservation limit');
  const reasons = (a, b) => [
    ...(a.cycleId === b.cycleId ? ['cycle_identity'] : []),
    ...(a.testHash === b.testHash ? ['test_identity'] : []),
    ...(a.attemptId === b.attemptId ? ['attempt_identity'] : []),
    ...(a.start < b.end && a.end > b.start ? ['overlapping_interval'] : []),
  ];
  for (let i = 0; i < records.length; i++) {
    const known = records[i]; known.sourceIds.sort();
    for (let j = 0; j < i; j++) {
      const collision = reasons(known.reservation, records[j].reservation);
      if (collision.length) conflicts.push({ kind: 'conflicting_legacy_sources', reasons: collision,
        expected: known, actual: records[j] });
    }
    const matches = document.reservations.map((actual, ledgerIndex) => ({ actual, ledgerIndex,
      reasons: reasons(known.reservation, actual) })).filter(item => item.reasons.length > 0);
    if (matches.length === 1 && same(immutable(known.reservation), immutable(matches[0].actual))) {
      const { actual, ledgerIndex } = matches[0];
      matched.push({ ...known, ledgerIndex, retainedStatus: actual.status, retainedRecordHash: fingerprint(actual) });
    } else if (matches.length) {
      conflicts.push({ kind: 'conflicting_existing_reservation', expected: known, actual: matches });
    } else {
      missing.push({ ...known, appendOnlyPosition: known.reservation.start < tail(document) ? 'before_existing_tail' : 'after_existing_tail' });
    }
    // Conflict output itself must stay bounded even for adversarial inventories.
    assert(conflicts.length <= CUTOVER_LIMITS.reservations, 'reconciliation conflict limit');
  }
  return { knownLegacyReservations: records.length, matched, missing, conflicts };
}

/** readLedger(binding) must read the authorized existing authoritative ledger.
 * Its return value and checkpoint are explicit UTC-ms envelopes, each binding
 * the scope, exact document hash and opaque version. The callback's authority,
 * fresh reads and retained checkpoint custody cannot be established by this API.
 * Read implementations must themselves be read-only; no write API is accepted.
 *
 * Every persisted caller input and callback identity is captured BEFORE await.
 * Each read is detached immediately, and a second equal read is required for a
 * cutoff-only candidate. Neither equality nor booleans prove legacy quiescence.
 */
export async function planResearchCutover(options) {
  keys(options, ['binding', 'readLedger', 'checkpoint', 'historyAudits', 'missingSources', 'quarantine']);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  assert(Reflect.ownKeys(descriptors).length === 6 && Object.values(descriptors).every(d => Object.hasOwn(d, 'value') && d.enumerable), 'plain option values required');
  const readLedger = descriptors.readLedger.value;
  assert(typeof readLedger === 'function', 'read-only ledger reader required');
  const inputs = snapshot(Object.fromEntries(Object.entries(descriptors).filter(([key]) => key !== 'readLedger').map(([key, d]) => [key, d.value])));
  const { binding, checkpoint, historyAudits, missingSources, quarantine } = inputs;
  validateBinding(binding); validateEnvelope(checkpoint, binding);
  array(historyAudits, CUTOVER_LIMITS.sources, 'history sources'); array(missingSources, CUTOVER_LIMITS.sources, 'missing sources');
  assert(historyAudits.length + missingSources.length >= 1 && historyAudits.length + missingSources.length <= CUTOVER_LIMITS.sources, 'explicit bounded history inventory required');
  const sources = new Set();
  for (const source of historyAudits) {
    validateReportSource(source, binding.ledgerId);
    assert(!sources.has(source.sourceId), 'duplicate sourceId'); sources.add(source.sourceId);
  }
  const missingHashes = new Set();
  for (const source of missingSources) {
    validateBound(source, true); assert(!sources.has(source.sourceId), 'duplicate sourceId'); sources.add(source.sourceId);
    if (source.sourceHash !== null) {
      assert(!missingHashes.has(source.sourceHash), 'duplicate missing sourceHash'); missingHashes.add(source.sourceHash);
    }
  }
  validateBound(quarantine);
  freeze(inputs);
  const first = snapshot(await readLedger(binding), CUTOVER_LIMITS.snapshotBytes);
  validateEnvelope(first, binding); extendsSnapshot(checkpoint, first);
  const latest = snapshot(await readLedger(binding), CUTOVER_LIMITS.snapshotBytes);
  validateEnvelope(latest, binding); extendsSnapshot(first, latest);
  const document = latest.snapshot.document, reconciliation = reconcile(historyAudits, document);
  const legacyReportSources = selectedReportCoverage(historyAudits, missingSources);
  const requiredKnownCutoff = Math.max(document.consumedBefore, tail(document),
    ...historyAudits.map(source => source.report.knownReservationEnd), ...missingSources.map(source => source.consumedBefore ?? 0));
  const planningBlockers = [
    ...(!same(first, latest) ? ['ledger_changed_during_planning'] : []),
    ...(quarantine.consumedBefore < document.consumedBefore ? ['quarantine_cutoff_would_regress'] : []),
    ...(quarantine.consumedBefore < requiredKnownCutoff ? ['quarantine_cutoff_before_known_consumption'] : []),
    ...(missingSources.some(source => source.consumedBefore === null) ? ['missing_source_consumption_bound_unknown'] : []),
    ...(legacyReportSources.some(source => source.consumedBefore === null) ? ['selected_legacy_source_missing_hash_bound'] : []),
    ...(reconciliation.missing.length ? ['known_legacy_reservations_missing_from_existing_ledger'] : []),
    ...(reconciliation.missing.some(item => item.appendOnlyPosition === 'before_existing_tail') ? ['missing_older_records_cannot_be_inserted_into_append_only_ledger'] : []),
    ...(reconciliation.conflicts.length ? ['consumption_identity_or_interval_conflict'] : []),
    ...(quarantine.consumedBefore !== document.consumedBefore && document.revision === Number.MAX_SAFE_INTEGER ? ['ledger_revision_exhausted'] : []),
  ];
  // Never derive a fresh genesis from a history report. Even a cutoff covering a
  // missing old reservation is not exact reconciliation and cannot remove it.
  const changed = quarantine.consumedBefore !== document.consumedBefore;
  const proposedLedger = planningBlockers.length ? null : { ...document,
    consumedBefore: quarantine.consumedBefore, revision: document.revision + (changed ? 1 : 0) };
  if (proposedLedger) validateLedger(proposedLedger, binding.ledgerId);
  const body = { schemaVersion: 1, timeUnit: AUTONOMY_TIME_UNIT, mode: 'read-only-cutover-plan', action: 'hold',
    activationReady: false, historicalCompletenessProven: false, legacyQuiescenceProven: false, anchorCustodyVerified: false,
    binding, scopeHash: fingerprint(binding), checkpoint, existingLedger: latest, historyAudits, missingSources, legacyReportSources,
    quarantine: { ...quarantine, requiredKnownCutoff }, reconciliation, planningBlockers,
    proposedLedger, proposedLedgerHash: proposedLedger === null ? null : fingerprint(proposedLedger),
    preservation: { reservationCount: document.reservations.length, reservationsHash: fingerprint(document.reservations),
      reservedCount: document.reservations.filter(r => r.status === 'reserved').length,
      completedCount: document.reservations.filter(r => r.status === 'completed').length,
      batchCount: new Set(document.reservations.filter(r => r.batchId !== undefined).map(r => r.batchId)).size,
      appendedRecords: 0, rewrittenRecords: 0, removedRecords: 0,
      changes: proposedLedger && changed ? [
        { field: 'consumedBefore', from: document.consumedBefore, to: proposedLedger.consumedBefore },
        { field: 'revision', from: document.revision, to: proposedLedger.revision },
      ] : [] },
    blockers: [...planningBlockers, 'full_historical_source_inventory_not_proven', 'legacy_evaluation_quiescence_not_proven',
      'history_reports_not_independently_reaudited', 'checkpoint_and_evidence_custody_not_verified',
      'authoritative_fresh_reads_and_private_destination_not_verified',
      ...(missingSources.length ? ['missing_source_bounds_not_independently_verified'] : []),
      ...(legacyReportSources.length ? ['selected_legacy_consumption_not_independently_reconciled'] : []),
      ...(historyAudits.some(s => s.report.selectedReports.some(r => !r.fullSourcePresent)) ? ['selected_legacy_reports_missing_full_sources'] : []),
      'independent_write_ahead_witness_cutover_not_implemented', 'conditional_apply_and_durability_not_verified',
      'cutover_not_applied', 'observed_execution_disabled'],
    limits: [
      'Only the enumerated report projections and two supplied reads are reconciled; hashes are not signatures or custody evidence.',
      'The retained checkpoint is a comparison input, not proof that it includes every earlier reservation or experiment.',
      'A stable pair of reads is not an atomic snapshot, proof of fresh authoritative storage, or proof that old evaluators stopped.',
      'The quarantine cutoff excludes [0, consumedBefore); data at or after it is not certified fresh or authorized for fitting.',
      'Missing reservations remain blockers even below the cutoff. No old record is inserted, rewritten, reset, completed or removed.',
      'All source report metadata and blockers are retained; selected reports are not complete all-trial evidence.',
      'This is not an activation certificate, witness genesis, CAS authorization or permission to apply the candidate.',
    ] };
  // Bound the complete report as well; preserve all records or fail, never prune.
  const detached = snapshot(body, 3 * CUTOVER_LIMITS.inputBytes);
  return freeze({ ...detached, planHash: fingerprint(detached) });
}

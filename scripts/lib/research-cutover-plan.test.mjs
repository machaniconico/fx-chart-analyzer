import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AUTONOMY_TIME_UNIT as timeUnit, appendAudit, canonicalJson, fingerprint } from './virtual-autonomy.mjs';
import { planLegacyReservationMigration } from './research-migration.mjs';
import { auditResearchHistory } from './research-history-audit.mjs';
import { CUTOVER_LIMITS, planResearchCutover } from './research-cutover-plan.mjs';

// All identifiers, event times, records and source files here are invented.
// There are no market tapes, evaluation calls or network/file write transports.
const T = Date.UTC(2026, 0, 1), ledgerId = 'synthetic-cutover-ledger';
const binding = { ledgerId, repository: 'example/private-fixture', branch: 'retained-state', path: 'ledger/reservations.json' };
const copy = value => JSON.parse(JSON.stringify(value));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const event = (suffix = 'a', start = T + 10, end = T + 20) => ({ type: 'holdout-reserved', at: T + 30,
  cycleId: fingerprint(`cycle-${suffix}`), requestHash: fingerprint(`request-${suffix}`), engineHash: fingerprint('fixture-engine'),
  testHash: fingerprint(`test-${suffix}`), start, end });
const history = (sourceId = 'host-a', events = [event()]) => {
  const journal = events.reduce((all, record) => appendAudit(all, record), []);
  const migration = planLegacyReservationMigration({ ledgerId, sources: [{ sourceId, events: journal }] });
  const report = { schemaVersion: 1, mode: 'read-only-history-audit', activationReady: false,
    manifestHash: fingerprint('invented-manifest'), manifestPinMatched: null, anchorCustodyVerified: false,
    historicalCompletenessProven: false, verifiedFileCount: 1,
    journals: [{ path: 'audit.jsonl', eventCount: journal.length, sourceHash: fingerprint(journal),
      auditHeadHash: journal.at(-1)?.hash ?? null, artifactCount: 0 }],
    referencedArtifactCount: 0, selectedReports: [], exactReservations: migration.exactReservations,
    proposedLedger: migration.proposedLedger, knownReservationEnd: migration.earliestNewHoldoutStart,
    blockers: ['full_historical_source_inventory_not_proven', 'no_ledger_or_activation_changes_performed'] };
  return wrapReport(sourceId, report);
};
const wrapReport = (sourceId, report) => ({ schemaVersion: 1, timeUnit, sourceId, reportHash: fingerprint(report), report });
const envelope = (document, version = 'fixture-version-7') => ({ schemaVersion: 1, timeUnit,
  scopeHash: fingerprint(binding), snapshot: { version, document: copy(document) }, documentHash: fingerprint(document) });
const bound = (consumedBefore = T + 100) => ({ schemaVersion: 1, timeUnit, consumedBefore, recordedAt: T + 200,
  evidenceHash: fingerprint('invented-cutover-note'), reason: 'Synthetic proposed quarantine boundary, not proof of quiescence.' });
const unavailable = (sourceId = 'lost-tuner', consumedBefore = T + 80, sourceHash = null) => ({ ...bound(consumedBefore), sourceId, sourceHash });
const setup = () => {
  const source = history();
  const document = { ...copy(source.report.proposedLedger), revision: 7 };
  const live = envelope(document);
  return { binding: copy(binding), readLedger: vi.fn(async () => copy(live)), checkpoint: copy(live),
    historyAudits: [source], missingSources: [], quarantine: bound() };
};
const withLedger = (args, transform) => {
  const document = copy(args.checkpoint.snapshot.document); transform(document);
  args.checkpoint = envelope(document); args.readLedger = vi.fn(async () => copy(args.checkpoint)); return args;
};
const rehashReport = source => { source.reportHash = fingerprint(source.report); };
const outputBody = result => { const { planHash, ...body } = result; return body; };
const complete = (r, resultHash = fingerprint('invented-result')) => ({ ...r, status: 'completed', resultHash, completedAt: T + 90 });
const laterBatch = (status = 'reserved') => [0, 1].map(i => {
  const base = history(`batch-${i}`, [event(`batch-${i}`, T + 40 + i * 20, T + 50 + i * 20)]).report.proposedLedger.reservations[0];
  const r = { ...base, attemptId: `fixture-batch-attempt-${i}`, requestHash: fingerprint('batch-request'),
    batchId: fingerprint('invented-batch'), batchIndex: i, batchSize: 2 };
  return status === 'completed' ? complete(r, fingerprint('batch-result')) : r;
});

describe('inactive existing-ledger cutover planning', () => {
  it('retains every completed and batched record and proposes only a monotonic cutoff/revision diff', async () => {
    const args = withLedger(setup(), document => {
      document.reservations[0] = complete(document.reservations[0]);
      document.reservations.push(...laterBatch('completed'));
    });
    const before = copy(args.checkpoint), result = await planResearchCutover(args);
    expect(args.readLedger).toHaveBeenCalledTimes(2);
    expect(args.readLedger.mock.calls.every(([actual]) => Object.isFrozen(actual) && sameBinding(actual))).toBe(true);
    expect(result.proposedLedger).toEqual({ ...before.snapshot.document, consumedBefore: T + 100, revision: 8 });
    expect(result.existingLedger).toEqual(before);
    expect(result.proposedLedger.reservations).toEqual(before.snapshot.document.reservations);
    expect(result.reconciliation.matched[0]).toMatchObject({ retainedStatus: 'completed', ledgerIndex: 0 });
    expect(result.preservation).toMatchObject({ reservationCount: 3, completedCount: 3, reservedCount: 0,
      batchCount: 1, appendedRecords: 0, rewrittenRecords: 0, removedRecords: 0,
      changes: [{ field: 'consumedBefore', from: 0, to: T + 100 }, { field: 'revision', from: 7, to: 8 }] });
    expect(args.checkpoint).toEqual(before);
    expect(result).toMatchObject({ activationReady: false, action: 'hold', legacyQuiescenceProven: false,
      historicalCompletenessProven: false, anchorCustodyVerified: false });
    expect(result.blockers).toContain('observed_execution_disabled');
    expect(result.planHash).toBe(fingerprint(outputBody(result)));
    expect(result.proposedLedgerHash).toBe(fingerprint(result.proposedLedger));
  });

  it('preserves interrupted reservations and does not invent completion or release a batch', async () => {
    const args = withLedger(setup(), document => document.reservations.push(...laterBatch()));
    const result = await planResearchCutover(args);
    expect(result.preservation).toMatchObject({ reservedCount: 3, completedCount: 0, batchCount: 1 });
    expect(result.proposedLedger.reservations).toEqual(args.checkpoint.snapshot.document.reservations);
  });

  it('keeps revision unchanged for an already matching cutoff', async () => {
    const args = withLedger(setup(), document => { document.consumedBefore = T + 100; });
    const result = await planResearchCutover(args);
    expect(result.proposedLedger).toEqual(args.checkpoint.snapshot.document);
    expect(result.preservation.changes).toEqual([]);
  });

  it('retains all source metadata and blockers without converting a matching manifest pin into custody', async () => {
    const args = setup(), report = args.historyAudits[0].report;
    report.manifestPinMatched = true; report.verifiedFileCount = 2;
    report.selectedReports.push({ path: 'tune-virtual-strategies-fixture.selected.json', sourceHash: fingerprint('missing-full-report'),
      fullSourcePresent: false, selectedCandidateCount: 3, evaluatedCombinationCount: 200 });
    report.blockers.push('selected_legacy_reports_missing_full_sources', 'caller-note-is-not-proof');
    rehashReport(args.historyAudits[0]);
    const result = await planResearchCutover(args);
    expect(result.historyAudits).toEqual(args.historyAudits);
    expect(result.blockers).toContain('selected_legacy_reports_missing_full_sources');
    expect(result.blockers).toContain('history_reports_not_independently_reaudited');
    expect(result.anchorCustodyVerified).toBe(false); expect(result.activationReady).toBe(false);
  });

  it.each(['absent', 'unrelated hash', 'unidentified source', 'unknown bound'])('blocks known missing selected sources with %s evidence', async kind => {
    const args = setup(), report = args.historyAudits[0].report, missingHash = fingerprint('known-missing-all-trials');
    report.verifiedFileCount = 2;
    report.selectedReports.push({ path: 'tune-virtual-strategies-fixture.selected.json', sourceHash: missingHash,
      fullSourcePresent: false, selectedCandidateCount: 3, evaluatedCombinationCount: 200 });
    rehashReport(args.historyAudits[0]);
    if (kind !== 'absent') args.missingSources = [unavailable('matching-looking-name', kind === 'unknown bound' ? null : T + 80,
      kind === 'unrelated hash' ? fingerprint('another-file') : kind === 'unidentified source' ? null : missingHash)];
    const result = await planResearchCutover(args);
    expect(result.proposedLedger).toBeNull(); expect(result.planningBlockers).toContain('selected_legacy_source_missing_hash_bound');
    expect(result.legacyReportSources[0].sourceHash).toBe(missingHash);
  });

  it('requires separate hash-bound evidence for each missing selected source', async () => {
    const args = setup(), report = args.historyAudits[0].report;
    report.verifiedFileCount = 3;
    report.selectedReports = ['one', 'two'].map(name => ({ path: `tune-virtual-strategies-${name}.selected.json`,
      sourceHash: fingerprint(`missing-${name}`), fullSourcePresent: false, selectedCandidateCount: null, evaluatedCombinationCount: null }));
    rehashReport(args.historyAudits[0]); args.missingSources = [unavailable('first', T + 80, fingerprint('missing-one'))];
    const blocked = await planResearchCutover(args);
    expect(blocked.proposedLedger).toBeNull(); expect(blocked.legacyReportSources.filter(item => item.consumedBefore === null)).toHaveLength(1);
    args.missingSources.push(unavailable('second', T + 90, fingerprint('missing-two')));
    const bounded = await planResearchCutover(args);
    expect(bounded.proposedLedger.consumedBefore).toBe(T + 100); expect(bounded.quarantine.requiredKnownCutoff).toBe(T + 90);
    expect(bounded.activationReady).toBe(false);
    args.missingSources.push(unavailable('duplicate', T + 90, fingerprint('missing-two')));
    await expect(planResearchCutover(args)).rejects.toThrow('duplicate missing sourceHash');
  });

  it.each([
    ['present source', [true]],
    ['missing source', [false]],
    ['present and missing sources', [true, false]],
  ])('requires hash-bound consumption for %s, not just a matching source file', async (_, presence) => {
    const args = setup(), report = args.historyAudits[0].report;
    report.verifiedFileCount = 1 + presence.length * 2;
    report.selectedReports = presence.map((fullSourcePresent, i) => ({ path: `tune-virtual-strategies-${i}.selected.json`,
      sourceHash: fingerprint(`unparsed-source-${i}`), fullSourcePresent, selectedCandidateCount: 3, evaluatedCombinationCount: 200 }));
    rehashReport(args.historyAudits[0]);
    for (let i = 0; i < presence.length; i++) {
      const incomplete = await planResearchCutover(args);
      expect(incomplete.proposedLedger).toBeNull();
      expect(incomplete.planningBlockers).toContain('selected_legacy_source_missing_hash_bound');
      expect(incomplete.legacyReportSources.flatMap(item => item.reports).map(item => item.fullSourcePresent).sort())
        .toEqual([...presence].sort());
      args.missingSources.push(unavailable(`unreconciled-${i}`, T + 80 + i, fingerprint(`unparsed-source-${i}`)));
    }
    const bounded = await planResearchCutover(args);
    expect(bounded.proposedLedger.revision).toBe(8); expect(bounded.activationReady).toBe(false);
    expect(bounded.blockers).toContain('selected_legacy_consumption_not_independently_reconciled');
    expect(bounded.legacyReportSources.every(source => source.boundSourceId !== null)).toBe(true);
  });

  it('deduplicates only exact copied legacy reservations while retaining every source', async () => {
    const args = setup(); args.historyAudits.push(history('copied-host'));
    const result = await planResearchCutover(args);
    expect(result.reconciliation.knownLegacyReservations).toBe(1);
    expect(result.reconciliation.matched[0].sourceIds).toEqual(['copied-host', 'host-a']);
    expect(result.historyAudits).toHaveLength(2);
  });

  it('permits a valid monotonic advance from the retained checkpoint but preserves the actual latest completion', async () => {
    const args = setup(), current = copy(args.checkpoint.snapshot.document);
    current.revision++; current.reservations[0] = complete(current.reservations[0]); current.consumedBefore = T + 80;
    const latest = envelope(current, 'fixture-version-8'); args.readLedger = vi.fn(async () => latest);
    const result = await planResearchCutover(args);
    expect(result.checkpoint).toEqual(args.checkpoint); expect(result.existingLedger).toEqual(latest);
    expect(result.proposedLedger).toEqual({ ...current, revision: 9, consumedBefore: T + 100 });
  });

  it('produces deterministic, detached, deeply frozen reports without touching its arguments', async () => {
    const args = setup(), before = canonicalJson({ ...args, readLedger: null });
    const result = await planResearchCutover(args);
    expect(result).toEqual(await planResearchCutover(args));
    expect(canonicalJson({ ...args, readLedger: null })).toBe(before);
    expect(Object.isFrozen(result.existingLedger.snapshot.document.reservations[0])).toBe(true);
    expect(() => { result.proposedLedger.reservations[0].status = 'completed'; }).toThrow();
    args.historyAudits[0].report.blockers.push('later-caller-edit');
    expect(result.historyAudits[0].report.blockers).not.toContain('later-caller-edit');
  });
});
const sameBinding = value => canonicalJson(value) === canonicalJson(binding);

describe('consumption reconciliation blockers, never history rewrites', () => {
  it('does not insert an absent older reservation even when the cutoff covers its entire interval', async () => {
    const args = setup(); args.historyAudits.push(history('older-host', [event('older', T, T + 5)]));
    const result = await planResearchCutover(args);
    expect(result.proposedLedger).toBeNull(); expect(result.proposedLedgerHash).toBeNull();
    expect(result.existingLedger).toEqual(args.checkpoint);
    expect(result.planningBlockers).toContain('missing_older_records_cannot_be_inserted_into_append_only_ledger');
    expect(result.reconciliation.missing[0]).toMatchObject({ appendOnlyPosition: 'before_existing_tail',
      reservation: { start: T, end: T + 5 } });
    expect(result.preservation.changes).toEqual([]);
  });

  it('also blocks absent later reservations instead of inventing append/migration authorization', async () => {
    const args = setup(); args.historyAudits.push(history('later-host', [event('later', T + 30, T + 40)]));
    const result = await planResearchCutover(args);
    expect(result.proposedLedger).toBeNull(); expect(result.reconciliation.missing[0].appendOnlyPosition).toBe('after_existing_tail');
    expect(result.planningBlockers).not.toContain('missing_older_records_cannot_be_inserted_into_append_only_ledger');
  });

  it.each([
    ['renamed cycle over same period', { cycleId: fingerprint('renamed-cycle') }],
    ['reused test hash over another period', { cycleId: fingerprint('renamed-cycle'), start: T + 30, end: T + 40 }],
    ['changed request', { requestHash: fingerprint('different-request') }],
    ['changed engine', { engineHash: fingerprint('different-engine') }],
    ['changed reservation time', { at: T + 31 }],
  ])('reports a conflict for %s', async (_, patch) => {
    const args = setup(); args.historyAudits = [history('conflict-host', [{ ...event(), ...patch }])];
    const result = await planResearchCutover(args);
    expect(result.proposedLedger).toBeNull(); expect(result.reconciliation.conflicts[0].kind).toBe('conflicting_existing_reservation');
    expect(result.planningBlockers).toContain('consumption_identity_or_interval_conflict');
    expect(result.existingLedger).toEqual(args.checkpoint);
  });

  it('reports conflicting source copies rather than arbitrarily choosing one', async () => {
    const args = setup(); args.historyAudits.push(history('conflicting-copy', [{ ...event(), at: T + 31 }]));
    const result = await planResearchCutover(args);
    expect(result.reconciliation.conflicts.some(c => c.kind === 'conflicting_legacy_sources')).toBe(true);
    expect(result.proposedLedger).toBeNull(); expect(result.reconciliation.knownLegacyReservations).toBe(2);
  });

  it('does not match an original cycle when the current attempt identity was replaced', async () => {
    const args = withLedger(setup(), document => { document.reservations[0].attemptId = 'invented-new-attempt-id'; });
    const result = await planResearchCutover(args);
    expect(result.reconciliation.matched).toEqual([]); expect(result.reconciliation.conflicts).toHaveLength(1);
  });

  it('reports unknown consumption bounds without interpreting null as a zero cutoff', async () => {
    const args = setup(); args.missingSources = [unavailable('unknown-host', null)];
    const result = await planResearchCutover(args);
    expect(result.proposedLedger).toBeNull(); expect(result.missingSources).toEqual(args.missingSources);
    expect(result.planningBlockers).toContain('missing_source_consumption_bound_unknown');
  });

  it('uses explicit missing-source bounds only as lower bounds, not independent proof', async () => {
    const args = setup(); args.missingSources = [unavailable()];
    const result = await planResearchCutover(args);
    expect(result.quarantine.requiredKnownCutoff).toBe(T + 80); expect(result.proposedLedger.consumedBefore).toBe(T + 100);
    expect(result.blockers).toContain('missing_source_bounds_not_independently_verified');
    expect(result.activationReady).toBe(false);
  });

  it.each(['existing cutoff', 'known ledger interval', 'missing-source bound'])('blocks a quarantine before %s', async kind => {
    const args = setup(); args.quarantine.consumedBefore = T + 15;
    if (kind === 'existing cutoff') withLedger(args, document => { document.consumedBefore = T + 50; });
    if (kind === 'missing-source bound') args.missingSources = [unavailable()];
    const result = await planResearchCutover(args);
    expect(result.proposedLedger).toBeNull(); expect(result.planningBlockers).toContain('quarantine_cutoff_before_known_consumption');
    if (kind === 'existing cutoff') expect(result.planningBlockers).toContain('quarantine_cutoff_would_regress');
    expect(result.existingLedger).toEqual(args.checkpoint);
  });

  it('includes a missing legacy interval in the lower bound even though it cannot be appended', async () => {
    const args = setup(); args.historyAudits.push(history('later', [event('later', T + 150, T + 160)]));
    const result = await planResearchCutover(args);
    expect(result.quarantine.requiredKnownCutoff).toBe(T + 160);
    expect(result.planningBlockers).toContain('quarantine_cutoff_before_known_consumption');
  });

  it('does not overflow or reset an exhausted revision', async () => {
    const args = withLedger(setup(), document => { document.revision = Number.MAX_SAFE_INTEGER; });
    const result = await planResearchCutover(args);
    expect(result.proposedLedger).toBeNull(); expect(result.planningBlockers).toContain('ledger_revision_exhausted');
  });
});

describe('strict persisted input boundaries', () => {
  it.each(['checkpoint', 'history', 'missing', 'quarantine', 'read'])('requires explicit UTC-ms on %s, not just the top-level request', async target => {
    const args = setup(); args.missingSources = [unavailable()];
    if (target === 'read') { const live = copy(args.checkpoint); delete live.timeUnit; args.readLedger = vi.fn(async () => live); }
    else {
      const input = target === 'history' ? args.historyAudits[0] : target === 'missing' ? args.missingSources[0] : args[target];
      input.timeUnit = 'UTC epoch seconds';
    }
    await expect(planResearchCutover(args)).rejects.toThrow(/UTC millisecond|missing fields/);
    if (target !== 'read') expect(args.readLedger).not.toHaveBeenCalled();
  });

  it.each(['seconds', 'microseconds', 'fraction', 'before-range', 'after-range'])('rejects %s times rather than converting them', async kind => {
    const args = setup(), values = { seconds: T / 1000, microseconds: T * 1000, fraction: T + 0.5,
      'before-range': CUTOVER_LIMITS.minimumTime - 1, 'after-range': CUTOVER_LIMITS.maximumTime };
    args.quarantine.consumedBefore = values[kind];
    await expect(planResearchCutover(args)).rejects.toThrow('UTC-ms'); expect(args.readLedger).not.toHaveBeenCalled();
  });

  it('rejects mixed units in validly rehashed ledger and legacy report records', async () => {
    const args = setup();
    withLedger(args, document => { document.reservations[0].start = T / 1000; });
    await expect(planResearchCutover(args)).rejects.toThrow('UTC-ms');
    const legacy = setup(); legacy.historyAudits[0].report.proposedLedger.reservations[0].reservedAt = T / 1000;
    rehashReport(legacy.historyAudits[0]);
    await expect(planResearchCutover(legacy)).rejects.toThrow('UTC-ms');
  });

  it.each(['historyAudits', 'missingSources', 'ledger reservations', 'report journals', 'report blockers'])('rejects sparse %s before hashing or awaiting', async target => {
    const args = setup();
    if (target === 'ledger reservations') args.checkpoint.snapshot.document.reservations = new Array(1);
    else if (target === 'report journals') args.historyAudits[0].report.journals = new Array(1);
    else if (target === 'report blockers') args.historyAudits[0].report.blockers = new Array(1);
    else args[target] = new Array(1);
    await expect(planResearchCutover(args)).rejects.toThrow('dense'); expect(args.readLedger).not.toHaveBeenCalled();
  });

  it('rejects named array properties, symbols, getters, hidden data and inherited values', async () => {
    for (const corrupt of [
      args => { args.historyAudits.extra = true; },
      args => { args.quarantine[Symbol('hidden')] = 1; },
      args => { Object.defineProperty(args.quarantine, 'consumedBefore', { get: () => T + 100, enumerable: true }); },
      args => { Object.defineProperty(args.quarantine, 'hidden', { value: 1 }); },
      args => { Object.setPrototypeOf(args.quarantine, { ignored: true }); },
    ]) {
      const args = setup(); corrupt(args);
      await expect(planResearchCutover(args)).rejects.toThrow(); expect(args.readLedger).not.toHaveBeenCalled();
    }
  });

  it('rejects sparse or extended arrays returned by an authoritative reader', async () => {
    for (const corrupt of [
      document => { document.reservations = new Array(1); },
      document => { document.reservations.extra = true; },
    ]) {
      const args = setup(), live = copy(args.checkpoint); corrupt(live.snapshot.document);
      args.readLedger = vi.fn(async () => live);
      await expect(planResearchCutover(args)).rejects.toThrow('dense'); expect(args.readLedger).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects boolean proof flags and source price arrays as unsupported fields', async () => {
    for (const field of ['sourcesComplete', 'quiescenceVerified', 'custodyVerified', 'quotes']) {
      const args = setup(); args.quarantine[field] = field === 'quotes' ? [100, 101] : true;
      await expect(planResearchCutover(args)).rejects.toThrow('fields'); expect(args.readLedger).not.toHaveBeenCalled();
    }
    const args = setup(); args.historyAudits[0].report.historicalCompletenessProven = true; rehashReport(args.historyAudits[0]);
    await expect(planResearchCutover(args)).rejects.toThrow('history audit');
  });

  it('rejects ledger schema extensions rather than silently discarding them', async () => {
    const args = withLedger(setup(), document => { document.extraMetadata = { note: 'requires explicit schema support' }; });
    await expect(planResearchCutover(args)).rejects.toThrow('fields');
  });

  it('rejects bad scope, ledger identity and exact content hashes', async () => {
    for (const corrupt of [
      args => { args.checkpoint.scopeHash = fingerprint('other-scope'); },
      args => { args.binding.path = 'different/ledger.json'; },
      args => { args.checkpoint.snapshot.document.ledgerId = 'different-ledger-identity'; },
      args => { args.checkpoint.documentHash = 'a'.repeat(64); },
      args => { args.historyAudits[0].reportHash = 'b'.repeat(64); },
    ]) {
      const args = setup(); corrupt(args);
      await expect(planResearchCutover(args)).rejects.toThrow(/scope|identity|hash/); expect(args.readLedger).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed and inconsistent audit report projections', async () => {
    for (const corrupt of [
      report => { report.exactReservations++; },
      report => { report.knownReservationEnd++; },
      report => { report.proposedLedger.revision = 1; },
      report => { report.proposedLedger.consumedBefore = T + 5; },
      report => { report.proposedLedger.reservations[0].attemptId = 'unrelated-attempt-identity'; },
      report => { report.proposedLedger.reservations[0] = complete(report.proposedLedger.reservations[0]); },
      report => { report.journals[0].path = '../audit.jsonl'; },
    ]) {
      const args = setup(); corrupt(args.historyAudits[0].report); rehashReport(args.historyAudits[0]);
      await expect(planResearchCutover(args)).rejects.toThrow(); expect(args.readLedger).not.toHaveBeenCalled();
    }
  });

  it('rejects incomplete or inconsistently completed batches', async () => {
    for (const records of [[laterBatch()[0]], [complete(laterBatch()[0]), laterBatch()[1]],
      laterBatch().map((r, i) => ({ ...r, batchIndex: i + 1 }))]) {
      const args = withLedger(setup(), document => document.reservations.push(...records));
      await expect(planResearchCutover(args)).rejects.toThrow('batch');
    }
  });

  it('rejects duplicate source names and an absent inventory', async () => {
    const args = setup(); args.missingSources = [unavailable('host-a')];
    await expect(planResearchCutover(args)).rejects.toThrow('duplicate');
    args.missingSources = []; args.historyAudits = [];
    await expect(planResearchCutover(args)).rejects.toThrow('inventory');
  });

  it('bounds input counts, strings, nesting, cycles and bytes before any read', async () => {
    for (const corrupt of [
      args => { args.historyAudits = Array.from({ length: CUTOVER_LIMITS.sources + 1 }, (_, i) => history(`host-${i}`)); },
      args => { args.missingSources = new Array(CUTOVER_LIMITS.arrayEntries + 1).fill(null); },
      args => { args.quarantine.reason = 'x'.repeat(16385); },
      args => { args.quarantine.extra = args.quarantine; },
      args => { args.quarantine.extra = Array.from({ length: 600 }, () => 'x'.repeat(16384)); },
      args => { let value = {}; for (let i = 0; i < 34; i++) value = { child: value }; args.quarantine.extra = value; },
    ]) {
      const args = setup(); corrupt(args);
      await expect(planResearchCutover(args)).rejects.toThrow(/limit|bounded|acyclic/); expect(args.readLedger).not.toHaveBeenCalled();
    }
  });
});

describe('read-only races and retained-checkpoint rollback detection', () => {
  it('captures all data and the read callback before the first await', async () => {
    const args = setup(), original = copy(args.checkpoint), originalSources = copy(args.historyAudits);
    const reader = vi.fn(async actualBinding => {
      expect(sameBinding(actualBinding)).toBe(true);
      args.binding.path = 'switched.json'; args.quarantine.consumedBefore = T + 199;
      args.historyAudits = []; args.checkpoint.snapshot.document.reservations = [];
      args.readLedger = () => { throw new Error('switched callback called'); };
      return copy(original);
    });
    args.readLedger = reader;
    const result = await planResearchCutover(args);
    expect(reader).toHaveBeenCalledTimes(2); expect(result.binding).toEqual(binding);
    expect(result.historyAudits).toEqual(originalSources); expect(result.quarantine.consumedBefore).toBe(T + 100);
    expect(result.checkpoint).toEqual(original);
  });

  it('detaches the first response before the second read mutates a shared object', async () => {
    const args = setup(), shared = copy(args.checkpoint); let calls = 0;
    args.readLedger = vi.fn(async () => {
      if (calls++) {
        shared.snapshot.document.revision++; shared.snapshot.document.consumedBefore = T + 80;
        shared.snapshot.version = 'fixture-version-8'; shared.documentHash = fingerprint(shared.snapshot.document);
      }
      return shared;
    });
    const result = await planResearchCutover(args);
    expect(result.planningBlockers).toContain('ledger_changed_during_planning'); expect(result.proposedLedger).toBeNull();
    expect(result.existingLedger.snapshot.document.revision).toBe(8);
  });

  it('blocks a changed opaque version even when both document bodies are identical', async () => {
    const args = setup(); let calls = 0;
    args.readLedger = vi.fn(async () => ({ ...copy(args.checkpoint), snapshot: {
      ...copy(args.checkpoint.snapshot), version: `fixture-version-${7 + calls++}` } }));
    const result = await planResearchCutover(args);
    expect(result.proposedLedger).toBeNull(); expect(result.planningBlockers).toContain('ledger_changed_during_planning');
  });

  it.each(['revision', 'cutoff', 'record deletion', 'record rewrite', 'completed downgrade', 'completed hash'])('rejects retained %s rollback', async kind => {
    const args = withLedger(setup(), document => {
      document.consumedBefore = T + 40; document.reservations[0] = complete(document.reservations[0]);
    });
    const document = copy(args.checkpoint.snapshot.document); document.revision++;
    if (kind === 'revision') document.revision = 6;
    if (kind === 'cutoff') document.consumedBefore = 0;
    if (kind === 'record deletion') document.reservations = [];
    if (kind === 'record rewrite') document.reservations[0].reservedAt++;
    if (kind === 'completed downgrade') { const { completedAt, resultHash, ...r } = document.reservations[0]; document.reservations[0] = { ...r, status: 'reserved' }; }
    if (kind === 'completed hash') document.reservations[0].resultHash = fingerprint('different-result');
    args.readLedger = vi.fn(async () => envelope(document, 'fixture-version-8'));
    await expect(planResearchCutover(args)).rejects.toThrow(/regressed|rewritten|completed/);
  });

  it.each(['revision', 'version'])('rejects a changed document without a changed %s', async kind => {
    const args = setup(), document = copy(args.checkpoint.snapshot.document); document.consumedBefore = T + 60;
    if (kind === 'version') document.revision++;
    args.readLedger = vi.fn(async () => envelope(document, kind === 'version' ? args.checkpoint.snapshot.version : 'fixture-version-8'));
    await expect(planResearchCutover(args)).rejects.toThrow('without revision/version');
  });

  it('rejects newly appended consumption below a previously retained cutoff', async () => {
    const args = withLedger(setup(), document => { document.consumedBefore = T + 100; });
    const document = copy(args.checkpoint.snapshot.document); document.reservations.push(...laterBatch()); document.revision++;
    args.readLedger = vi.fn(async () => envelope(document, 'fixture-version-8'));
    await expect(planResearchCutover(args)).rejects.toThrow('predates retained cutoff');
  });

  it('does not bootstrap, retry a failed reader, or accept missing state', async () => {
    for (const read of [async () => { throw new Error('authority unavailable'); }, async () => null, async () => ({})]) {
      const args = setup(); args.readLedger = vi.fn(read);
      await expect(planResearchCutover(args)).rejects.toThrow(); expect(args.readLedger).toHaveBeenCalledTimes(1);
    }
  });
});

describe('integration with an actual history-audit report format', () => {
  it('reconciles a report from a synthetic checkpoint without writing or reading price arrays', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cutover-report-fixture-'));
    try {
      const r = event(), artifact = canonicalJson({ fixture: 'metadata-only, not a price tape' }) + '\n';
      mkdirSync(join(root, r.cycleId)); writeFileSync(join(root, r.cycleId, 'request.json'), artifact);
      const events = appendAudit(appendAudit([], r), { type: 'request-snapshotted', at: T + 31, cycleId: r.cycleId,
        artifact: `${r.cycleId}/request.json`, artifactHash: digest(artifact) });
      writeFileSync(join(root, 'audit.jsonl'), events.map(canonicalJson).join('\n') + '\n');
      const selected = 'tune-virtual-strategies-fixture.selected.json';
      writeFileSync(join(root, selected), canonicalJson({ source: { sha256: fingerprint('unavailable-all-trials') },
        candidates: [], summary: { combinationCount: 50 } }));
      const filePaths = ['audit.jsonl', `${r.cycleId}/request.json`, selected];
      const manifest = canonicalJson({ format: 1, files: Object.fromEntries(filePaths.map(p => [p, digest(readFileSync(join(root, p)))])) });
      writeFileSync(join(root, 'CHECKPOINT-MANIFEST.json'), manifest);
      const inventoryBefore = readdirSync(root), bytesBefore = filePaths.map(p => readFileSync(join(root, p), 'utf8'));
      const report = auditResearchHistory({ checkpointRoot: root, ledgerId, expectedManifestHash: digest(manifest) });
      const args = setup(); args.historyAudits = [wrapReport('preserved-checkpoint', report)];
      const result = await planResearchCutover(args);
      expect(result.reconciliation.matched).toHaveLength(1); expect(result.proposedLedger).toBeNull();
      expect(result.planningBlockers).toContain('selected_legacy_source_missing_hash_bound');
      expect(result.historyAudits[0].report).toEqual(report);
      expect(result.blockers).toContain('selected_legacy_reports_missing_full_sources');
      expect(result.activationReady).toBe(false); expect(result.anchorCustodyVerified).toBe(false);
      expect(readdirSync(root)).toEqual(inventoryBefore);
      expect(filePaths.map(p => readFileSync(join(root, p), 'utf8'))).toEqual(bytesBefore);
      expect(readFileSync(join(root, 'CHECKPOINT-MANIFEST.json'), 'utf8')).toBe(manifest);
      args.missingSources = [unavailable('legacy-full-report', T + 80, fingerprint('unavailable-all-trials'))];
      const bounded = await planResearchCutover(args);
      expect(bounded.proposedLedger.revision).toBe(8); expect(bounded.activationReady).toBe(false);
      expect(bounded.legacyReportSources[0]).toMatchObject({ sourceHash: fingerprint('unavailable-all-trials'),
        boundSourceId: 'legacy-full-report', consumedBefore: T + 80 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

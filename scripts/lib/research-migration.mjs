/** Read-only preparation for moving legacy research reservations to shared storage.
 * Never writes a remote ledger, repairs history, resumes research, or promotes an EA.
 * A plan can preserve known consumption, but cannot prove an inventory is complete.
 */
import { canonicalJson, fingerprint, verifyAudit } from './virtual-autonomy.mjs';
import { reservationGenesis, createGitHubReservationStore, readReservations } from './research-reservations.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(`research-migration: ${message}`); };
const copy = value => JSON.parse(canonicalJson(value));
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
const sourceId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** Exact legacy identities are retained, but not old completion/profitability claims.
 * Missing sources need a documented upper bound: the exclusive UTC-ms cutoff is
 * deliberately global. No assumption that a missing or interrupted run did nothing.
 * Overlaps/conflicting identities require reconciliation, never silent deduplication.
 */
export function planLegacyReservationMigration({ ledgerId, sources, missingSources = [] }) {
  assert(id(ledgerId), 'invalid target ledgerId');
  assert(Array.isArray(sources) && Array.isArray(missingSources) && sources.length + missingSources.length > 0, 'explicit legacy source inventory required');
  const seenSources = new Set(), reservations = new Map(), inventory = [];
  const register = value => {
    assert(sourceId(value) && !seenSources.has(value), 'invalid or duplicate sourceId'); seenSources.add(value);
  };
  for (const source of sources) {
    register(source.sourceId);
    const events = copy(source.events);
    verifyAudit(events);
    const knownCycles = new Set();
    for (const event of events) {
      assert(hash(event.cycleId), 'legacy audit event needs a cycle identity');
      if (event.type === 'holdout-reserved') knownCycles.add(event.cycleId);
      else assert(knownCycles.has(event.cycleId), 'orphan legacy event: consumed cycle has no earlier reservation; reconcile source or document a conservative cutoff');
    }
    const consumed = events.filter(e => e.type === 'holdout-reserved');
    const cycleIds = new Set();
    for (const event of consumed) {
      assert(!Object.hasOwn(event, 'ledgerId') && !Object.hasOwn(event, 'attemptId'), 'shared reservations need their authoritative ledger snapshot, not a reconstructed local audit');
      assert(hash(event.cycleId) && hash(event.requestHash) && hash(event.engineHash) && hash(event.testHash)
        && time(event.start) && time(event.end) && event.end > event.start && time(event.at), 'invalid legacy reservation');
      assert(!cycleIds.has(event.cycleId), 'duplicate cycle within legacy source'); cycleIds.add(event.cycleId);
      const identity = { cycleId: event.cycleId, requestHash: event.requestHash, engineHash: event.engineHash,
        testHash: event.testHash, start: event.start, end: event.end };
      const reservation = { ...identity, attemptId: `legacy_${fingerprint(identity).slice(0,48)}`,
        reservedAt: event.at, status: 'reserved' };
      const existing = reservations.get(reservation.cycleId);
      assert(!existing || canonicalJson(existing) === canonicalJson(reservation), 'conflicting copied legacy reservation');
      reservations.set(reservation.cycleId, reservation);
    }
    inventory.push({ sourceId: source.sourceId, kind: 'verified_local_audit', eventCount: events.length,
      reservationCount: consumed.length, sourceHash: fingerprint(events), auditHeadHash: events.at(-1)?.hash ?? null });
  }
  let consumedBefore = 0;
  for (const missing of missingSources) {
    register(missing.sourceId);
    assert(time(missing.consumedBefore) && missing.consumedBefore > 0 && nonempty(missing.evidence), 'missing source requires an explicit conservative consumedBefore and evidence');
    consumedBefore = Math.max(consumedBefore, missing.consumedBefore);
    inventory.push({ sourceId: missing.sourceId, kind: 'unavailable_with_conservative_cutoff',
      consumedBefore: missing.consumedBefore, evidence: missing.evidence });
  }
  const imported = [...reservations.values()].sort((a,b) => a.start - b.start || a.end - b.end || a.cycleId.localeCompare(b.cycleId));
  // The genesis validator rejects overlaps, duplicate test hashes and contradictions.
  // It only constructs a proposal; it never initializes a real storage destination.
  const proposedLedger = reservationGenesis(ledgerId, imported, consumedBefore);
  inventory.sort((a,b) => a.sourceId.localeCompare(b.sourceId));
  const body = { schemaVersion: 1, timeUnit: 'UTC epoch milliseconds; intervals [start,end)',
    mode: 'migration-plan-only', activationReady: false, proposedLedger, inventory,
    exactReservations: imported.length, unavailableSources: missingSources.length,
    earliestNewHoldoutStart: Math.max(consumedBefore, ...imported.map(r => r.end), 0),
    blockers: ['inventory_completeness_not_proven', 'private_destination_not_verified',
      'remote_durability_and_conflicts_not_tested', 'migration_not_applied'],
    limits: ['All imported reservations remain consumed, including unsuccessful and interrupted runs.',
      'A hash chain without an external trusted head cannot detect a removed valid suffix or prove the source inventory is complete.',
      'Legacy completion claims are not imported as new research evidence.',
      'A cutoff cannot satisfy exact local audit reconciliation; use a separate new artifact directory when exact history is unavailable.',
      'The plan is not permission to replace, reset, or overwrite an existing shared ledger.'] };
  return { ...body, planHash: fingerprint(body) };
}

/** Connected read-only preflight. Metadata checks do not test CAS, access retention,
 * administrative rollback protection, or provider recovery guarantees. Those stay
 * explicit activation blockers. readFile is not called for a public destination.
 */
export async function inspectResearchLedger({ config, inspectRepository, readFile }) {
  config = copy(config);
  assert(Object.keys(config).sort().join(',') === 'branch,ledgerId,path,repository', 'config must contain only repository, branch, path, ledgerId');
  assert(typeof inspectRepository === 'function' && typeof readFile === 'function', 'connected read functions required');
  const store = createGitHubReservationStore({ ...config, readFile,
    updateFile: async () => { throw new Error('read-only preflight cannot update a ledger'); } });
  const response = await inspectRepository({ repository_full_name: config.repository });
  assert(response && !response.isError, 'repository metadata unavailable');
  const repository = response.structuredContent ?? response;
  const actualName = repository.repository_full_name ?? repository.full_name;
  const nameConsistent = (!Object.hasOwn(repository, 'repository_full_name') || repository.repository_full_name === config.repository)
    && (!Object.hasOwn(repository, 'full_name') || repository.full_name === config.repository);
  const visibilityPrivate = repository.visibility === 'private' || repository.private === true;
  const visibilityConsistent = (!Object.hasOwn(repository, 'visibility') || repository.visibility === 'private')
    && (!Object.hasOwn(repository, 'private') || repository.private === true);
  assert(actualName === config.repository && nameConsistent && visibilityPrivate && visibilityConsistent, 'verified private repository required');
  assert(repository.permissions?.pull === true && repository.permissions?.push === true, 'existing read and write permission must be confirmed; no access is granted');
  const first = await readReservations(store);
  const second = await readReservations(store, first);
  return { schemaVersion: 1, mode: 'read-only-preflight', activationReady: false, config,
    repositoryPrivate: true, metadataReportsReadWritePermission: true,
    ledgerId: store.ledgerId, version: second.version, revision: second.document.revision,
    reservationCount: second.document.reservations.length, consumedBefore: second.document.consumedBefore,
    earliestNewHoldoutStart: Math.max(second.document.consumedBefore, ...second.document.reservations.map(r => r.end), 0),
    checks: ['repository_identity_and_private_visibility', 'reported_existing_permissions', 'ledger_identity_and_schema', 'two_read_monotonicity'],
    blockers: ['historical_migration_not_independently_verified', 'conditional_remote_writes_not_tested',
      'durability_retention_and_rollback_controls_not_verified', 'continuous_operation_not_enabled'] };
}

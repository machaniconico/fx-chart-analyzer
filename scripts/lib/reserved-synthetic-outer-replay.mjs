/** Inactive reservation barrier demonstration, not an observed-data runner.
 * All outer windows are consumed together before replay starts. No network,
 * credentials, file writes, cache recovery, schedule, promotion or broker API.
 */
import { readFileSync } from 'node:fs';
import { canonicalJson, fingerprint } from './virtual-autonomy.mjs';
import { createSyntheticOuterPlan, syntheticOuterHoldouts, replaySyntheticOuterPlan } from './synthetic-outer-replay.mjs';
import { reserveHoldoutBatch, completeReservationBatch } from './research-reservations.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(`reserved-synthetic-outer: ${message}`); };
const copy = value => JSON.parse(canonicalJson(value));
const sourceNames = ['reserved-synthetic-outer-replay.mjs', 'synthetic-outer-replay.mjs', 'virtual-research-cycle.mjs',
  'virtual-autonomy.mjs', 'virtual-portfolio.mjs', 'research-reservations.mjs', 'research-git-store.mjs', 'research-blob-store.mjs'];
const sources = () => sourceNames.map(name => ({ name, source: readFileSync(new URL(name, import.meta.url), 'utf8') }));
const loadedSourcesHash = fingerprint(sources());
const snapshotSources = () => {
  const result = sources();
  assert(fingerprint(result) === loadedSourcesHash, 'engine changed; restart before replay');
  return result;
};

/** The plan must be fixed before calling. Only the built-in default scenario is
 * supported; no externally supplied tape, callbacks or partial-fold replay.
 * Returning requires exact shared receipts for the entire reserve and complete
 * operations. Interruptions consume every window permanently. Even completed
 * runs cannot be recomputed; durable artifact/cached-result recovery is not yet
 * implemented here. Caller-owned plan/identities are snapshotted before awaits.
 */
export async function runReservedSyntheticOuterReplay(options) {
  assert(options && Object.keys(options).every(key => ['plan', 'reservationStore'].includes(key)), 'unsupported input fields');
  const { reservationStore } = options;
  assert(reservationStore?.syntheticOnly === true, 'explicit synthetic-only store required; observed authority is disabled');
  const plan = copy(options.plan);
  assert(canonicalJson(plan) === canonicalJson(createSyntheticOuterPlan(plan.config)), 'plan changed or engine mismatch');
  const engineSources = snapshotSources();
  const engineHash = fingerprint({ outer: plan.engineHash, orchestrationSources: loadedSourcesHash });
  const requestHash = fingerprint({ mode: 'reserved-synthetic-only', plan, engineHash });
  const identities = syntheticOuterHoldouts(plan).map(({ foldIndex, ...identity }) => ({ ...identity,
    requestHash, engineHash, cycleId: fingerprint({ requestHash, foldIndex }) }));
  const receipt = await reserveHoldoutBatch(reservationStore, identities);
  // No evaluation is reachable before all exact shared receipts are confirmed.
  const replay = replaySyntheticOuterPlan(plan);
  assert(replay.folds.every((fold, index) => fold.testHash === identities[index].testHash), 'reserved test identity mismatch');
  snapshotSources();
  const artifact = { schemaVersion: 1, mode: 'reserved-synthetic-only', action: 'hold', eligible: false,
    activationReady: false, requestHash, engineHash, ledgerId: reservationStore.ledgerId,
    plan, engineSources, reservations: receipt.reservations, replay,
    limits: ['synthetic_data_not_evidence', 'observed_runner_not_implemented',
      'durable_artifact_and_cache_recovery_not_implemented', 'independent_high_water_anchor_not_verified',
      'historical_consumed_inventory_not_verified', 'real_backend_acceptance_not_established_by_this_fixture'] };
  const resultHash = fingerprint(artifact);
  const completion = await completeReservationBatch(reservationStore, receipt, resultHash);
  return { artifact, resultHash, completion };
}

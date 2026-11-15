# Whole-plan reservations before outer replay

This is an **inactive synthetic-only prerequisite**, not an observed-data
evaluation service. It does not remove the remaining observed-pipeline,
independent-checkpoint, historical-inventory or production-runner blockers.
No existing research history, production ledger, job, credential, strategy,
deployment or order is changed by importing these modules.

## Atomic batch controller

`reserveHoldoutBatch` and `completeReservationBatch` in
`scripts/lib/research-reservations.mjs` extend the existing shared authority.

- A batch contains one to six strictly ordered, non-overlapping outer intervals
  with the same request and executable-engine hashes. All intervals must be later
  than already consumed reservations and the legacy cutoff.
- One compare-and-swap consumes the entire batch with one revision increment.
  Every fold has its own cycle, attempt and exact test identity. Optional
  `batchId`, `batchSize` and `batchIndex` fields bind its immutable group
  membership. Ordinary pre-batch reservations remain valid and unchanged.
- Readers reject incomplete, reordered, mixed-status or mixed-result groups.
  Single-record completion cannot complete a grouped entry. Batch completion
  rejects shortened or changed receipts and binds every member to the same
  full-artifact hash in one conditional update.
- Only an explicit, known-not-written conflict can be retried, at most eight
  attempts. Every write is followed by a monotonic authoritative read. Exact
  receipts for every member are required even when the acknowledgement is lost.
  No-op, partial, unavailable or unconfirmed outcomes stop without fitting or
  claiming success. There is no release, expiry, takeover or automatic reset.
- Caller identities and completion receipts are copied before asynchronous
  persistence. The existing single-reservation helper now also copies its input
  before the initial read, closing an equivalent mutation window.

These helpers do not initialize a production ledger or establish a provider's
atomicity or durability. A malicious or broken backend may partially persist a
document: the controller rejects it, but cannot undo it or make it trustworthy.
Do not weaken validation or erase consumed evidence to continue.

## Synthetic integration

`runReservedSyntheticOuterReplay` in
`scripts/lib/reserved-synthetic-outer-replay.mjs` takes only a precommitted
`createSyntheticOuterPlan()` result and an explicitly synthetic-only store.
It accepts no quote tape, dataset path, external source label, evaluator callback,
scenario override or partial-fold request. It has no built-in network transport,
CLI, job, credentials or local artifact writer. Persistence calls go only through
the supplied synthetic authority; do not point a demo at a production ledger.

The sequence is:

1. Snapshot and verify the plan and all eight executable local source files.
2. Generate the built-in fixture's exact outer test hashes without fitting.
3. Reserve every planned outer interval atomically and confirm every receipt.
4. Run the existing causal outer fixture, unchanged in selection/score behavior.
   Each champion is frozen before that fold's outer evaluation. Outer scores
   never select later proposals or pipeline variants.
5. Verify source and test identities again. Construct the complete artifact with
   plan, source snapshots, trials, decisions, results and reservation receipts.
6. Complete the whole batch with `fingerprint(artifact)`, the SHA-256 of its
   canonical JSON **without a trailing newline**. Return only after confirming
   every completed receipt. The returned completion receipts are separate from
   the artifact they authenticate.

Every result remains `action: hold`, `eligible: false`, `activationReady: false`.
The original pure synthetic fixture remains freely repeatable for unit testing.
This reservation-backed demonstration deliberately cannot recompute even a
completed plan. It has no durable result-cache recovery. If a process dies after
reservation or completion, all intervals stay consumed; the returned artifact
may be unavailable. This conservative loss of availability is not permission to
rerun, remove reservations, or treat synthetic scores as market evidence.

## Verification and remaining work

Focused tests cover whole-batch CAS, exact membership, single and batch caller
mutation, conflicts, lost acknowledgements, partial results, preserved later
reservations, malformed inputs, observed authority refusal, score parity and the
pre-fit barrier. Independent processes race the same plan; SIGKILL after reserve,
before completion and after completion preserves all three consumed windows and
prevents restart reuse. Tests use invented data and local/in-memory storage.

Before observed outer evaluation, the runner still needs a separately verified
private backend with an independent durable latest-state anchor, reconciliation
of the complete historical consumed inventory, precommitted observed-data plans,
provenance/coverage checks and durable artifacts with guarded cache recovery.
Real-backend service-disaster recovery is not demonstrated by process tests.
Long-history evidence, financing/liquidity/margin, the router and allocator,
statistical selection effects and any automatic adoption remain unvalidated.
No automatic research schedule should be enabled by this change.

```sh
npx vitest run scripts/lib/research-reservation-batch.test.mjs scripts/lib/reserved-synthetic-outer-replay.test.mjs
npm test
npm run build
```

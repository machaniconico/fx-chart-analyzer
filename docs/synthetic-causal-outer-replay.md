# Synthetic causal outer replay foundation

The implementation is
`scripts/lib/synthetic-outer-replay.mjs`, with focused tests in
`scripts/lib/synthetic-outer-replay.test.mjs`.

This is a **synthetic-only mechanical foundation** for evaluating the bounded
candidate-generation/selection procedure over chronological outer folds. It is
not observed market evidence, an automatic improvement service, or a promotion
gate. Every result and fold remains `action: hold`, `eligible: false`.

## What is implemented

1. `createSyntheticOuterPlan()` commits the finite candidate-generation settings,
   all fold windows, embargo, portfolio, selection rule, cost scenarios, policy
   and engine identity before any quote is generated or scored. Plans are deeply
   frozen and content hashed. Evaluation reconstructs the expected plan from its
   configuration, rejecting changed windows, proposals, rules or policy even if
   the caller recomputes its hash. These hashes are not signatures and cannot
   prove that a human has never inspected a scenario before planning.
2. Up to six non-overlapping chronological folds each have local train,
   selection and later outer-test partitions, with positive embargo gaps. Each
   partition starts flat and warms up locally. No fitted state, open position or
   label crosses a boundary. The default uses 399/399/400 quotes and one missing
   quote interval between partitions, including between folds.
3. Every fold independently regenerates the same predeclared bounded candidate
   set. The existing executable quote evaluator scores train, selection and
   selection at twice the spread/commission/slippage. The existing development
   gate requires positive closed-trade profit, at least one close, no boundary
   open position and drawdown within policy in all three evaluations. Ranking
   uses selection net profit, then candidate ID. Exceptions remain failed trials.
4. The champion (or all-flat decision) and development hashes are frozen before
   accessing that fold's outer partition. Only the selected champion is evaluated
   there, under both predeclared cost scenarios. Failed evaluation is distinct
   from choosing all-flat. Previous outer scores never change future proposals,
   rank candidates, select a pipeline variant or update portfolio allocation.
5. Every fold reports its trials, frozen decision, outer results, baseline and
   test hash. There is deliberately no pooled equity, Sharpe or promotion score:
   folds reset capital and boundary positions are censored, not forced closes.

The selector intentionally mirrors the existing cycle without changing its
production path. A parity test runs the existing cycle with its synthetic
reservation authority on the identical invented tape and verifies champion and
both outer scores. Any future change to development gates or ranking must update
both implementations and preserve this parity test (or extract a shared pure
selector under separate review).

## Synthetic boundary and reproducibility

The evaluator accepts a plan and only two optional controls:

- `completedFoldCount` replays a completed prefix of the **same** fixed plan.
- `scenario: { fromIndex, slopeChange }` applies a bounded deterministic slope
  change to the internally invented price path, for causal perturbation tests.

It does not accept quote arrays, dataset paths, provenance labels, callbacks or
external portfolio data. It neither reads observed price files nor initializes
an observed reservation backend. It performs no network operations, artifact or
strategy-state writes, job changes, promotion or broker actions. Importing its
existing engine dependencies reads engine source files solely for identity.
Synthetic scenarios may be repeated freely; that is not one-time observed
holdout evaluation. Repeated scenario exploration must never be presented as
independent financial evidence.

A prefix run generates only quotes through the last requested fold's test end.
Its completed folds equal the corresponding folds from a full run. Perturbing a
fold's outer quotes changes its outer score but not its development trials or
frozen decision. Perturbing a later fold leaves earlier completed folds unchanged.
The full result's scenario metadata intentionally differs across perturbations;
causal equality applies to the decisions and completed fold records.

## Running the checks

```sh
npx vitest run scripts/lib/synthetic-outer-replay.test.mjs
```

The ten checks cover plan immutability/chronology, deterministic hold-only
behavior, prefix extension, holdout perturbation, future-fold perturbation,
failed-development all-flat behavior, failed outer evaluation, plan tampering,
input/budget rejection and parity with the existing research cycle.

## Remaining requirements

This does **not** remove the existing research cycle's
`nested_outer_pipeline_folds_not_implemented` blocker. An observed pipeline still
needs an independently reviewed orchestration design that reserves every planned
outer interval in the shared consumed-holdout authority **before any fitting**,
handles interruptions without releasing consumed evidence, preserves historical
receipts and snapshots the complete executable pipeline. Do not relabel the
synthetic fixture or bypass reservations to attempt observed research.

The harness does not validate a regime router, a multi-EA capital allocator,
financing/rollover, liquidity, margin, long-history robustness, paper-trading
readiness, score-driven generational adaptation or statistical independence.
The invented quote-to-account conversion is constant; these scores have no
currency-market interpretation. Its three default folds merely exercise the
control flow and do not satisfy the real minimum-history/fold evidence gates.
The next safe implementation step is reservation-aware observed outer planning
and replay, not deployment or promotion of its synthetic winners.

The [whole-plan reservation demonstration](reserved-synthetic-outer-replay.md)
now exercises atomic reservation and completion of every planned outer interval
with this same built-in fixture. It remains synthetic-only and does not implement
observed orchestration or remove the blockers above.

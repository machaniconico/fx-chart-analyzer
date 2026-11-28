# Production publishing serialization

Both the daily refresh and push/manual deploy publish to the same Pages target.
They now share `fx-production-publish` with `cancel-in-progress: false` at workflow
level, with `queue: max` so a new deploy does not replace a waiting daily run. The deploy job is main-only and resolves current main after acquiring the
lock, rather than building a potentially stale queued event SHA.

This prevents concurrent publishing between these two workflows and avoids
interrupting a daily run between its data push, PR creation and persistence gate.
A normal deploy can now wait behind a daily refresh (up to its 90-minute timeout).
The queue is bounded to 100 waiting runs; further arrivals are cancelled. This is not a durable queue,
exactly-once execution, or protection against publishers outside these workflows.

This does NOT fix GitHub schedule delivery or stop a delayed schedule and a manual
refresh from running sequentially. Do not add blind retry schedules or repeated
manual dispatches. Before an authorized recovery, check both workflows and any
unsettled data PR; let active runs finish. Confirm saved forward/market data and
Pages provenance after completion. A successful run alone is not proof that its
soft-failing forward step succeeded (the separate forward outcome gate addresses
that distinction).

Tests assert the workflow wiring, not the hosted GitHub concurrency service.
No real trading or strategy activation is introduced.

Deploy-only runs have a 30-minute timeout so a stalled build cannot hold the shared
lock for the six-hour default. The daily workflow retains its 90-minute timeout.
Roll out only when older-version publishers have finished: those runs retain
the old concurrency group. A later main deploy can still replace unpersisted
working-tree data; this change does not redefine that existing fallback policy.

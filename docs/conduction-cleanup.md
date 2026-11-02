# Retired conduction cleanup (B-1243)

Retirement ends orchestration without verifying work. On each pass, maintenance discovers
active and parked runs whose ticket is archived or subsumed, plus requested reap on a run
with neither a worker reference nor an in-flight leg. Healthy paused runs stay untouched.

The additive web helpers are invoker functions: row security, project-token scope and write
membership all apply. `claim_conduction_cleanup` compares the observed row version under a
row lock and issues a two-minute token. A fresh foreign lease is never stolen (the stale
bound is capped at five minutes). Cleanup leaves parked status intact, so a newer active run
on the same ticket does not conflict with the unique active index. While a claim is live,
a trigger refuses Resume and ordinary identity/status changes with SQLSTATE 55000. Using
40001 here would cause PostgREST to retry a deliberate refusal rather than return it promptly.

The scheduler drops retired ready entries before ordinary wake/settlement and checks again
before launch. It uses the recorded backend and worker identity. A missing local tracking
entry does not prove absence. Reap commands get `HARMONY_CONFIRM_WORKER_STOP=1`: GKE uses
foreground deletion followed by bounded get/list polling (no new watch RBAC); Cloud Run
requires successful discovery, cancellation and a successful subsequent absence read.
Custom reap profiles must return 0 or 3 only after confirming stop/absence under this flag.
A command timeout, API error or unconfirmed stop retains the worker identity and a durable
cleanup error for retry. The existing history reason line names the unconfirmed stop.

`finish_conduction_cleanup` rechecks the token, holder, expiry, worker identity and current
retirement/request condition. It commits completed status, cleared tracking and one ticket
comment together. A failed comment rolls back completion. Retry/output history, task workflow
and outstanding gate remain unchanged. Repeated completion and reap requests are no-ops.

Land the web helpers/tests PR before the plugin maintenance PR. Missing helpers produce an
explicit diagnostic and skip only new maintenance. The founder's milestone promote installs
the forward-only migration on production; conductor Update then activates the new scheduler
and reap scripts. Neither merge nor worker-image refresh alone updates the conductor pod.

Validation includes the rolled-back SQL suite, two-session browser contention and Completed
history walk, scheduler/reap script suites, and the opt-in localhost Docker smoke:
`HARMONY_TEST_LOCAL_CLEANUP=1 HARMONY_TEST_LOCAL_CLEANUP_PROJECT=<local fixture project UUID>
npx vitest run src/tools/conduction-cleanup.local.test.ts`.
The local E2E fixture user must have been seeded first. This smoke never targets a hosted board.

# The notify → outbox sync contract (B-973)

**Status:** ratified design. Nothing in this plugin dispatches to a `notify` endpoint — that remains
true (§8 C9). **B-1009 narrowed the "declared data only" half:** the declaration now has exactly one
consumer, `harmony gates run`'s sync of it to the board (`src/config/notify-sync.ts`); the delivery
substrate itself is Supabase-hosted.

**Audience:** whoever builds the delivery substrate (**B-980**, the outbox) and whoever builds the
HTTP dispatcher (**B-1009**). This document is meant to be sufficient on its own: event shape, which
manifest declaration maps to which outbox event, registration, and at-least-once/restart semantics,
without asking this ticket's author a question.

---

## 1. Purpose and the scope boundary

A project declares, in its own `.harmony/project.yml`, which workflow-state transitions it wants an
external endpoint told about — alongside the `build` / `release` / `verify` steps and the
`preconditions` it already declares there. That declaration is the *whole* of what this repo owns.

There is, deliberately, **no HTTP dispatcher in this repo and nothing anywhere in this plugin that
POSTs to a declared `endpoint`.** Saying that out loud is the point: a reader who greps for the code
that POSTs to `endpoint` will not find it, and should not go looking for a bug. *(B-1009 added the
one thing that does READ `endpoint`: `src/config/notify-sync.ts` sends the declared URL to the
BOARD, so the Supabase-hosted dispatcher knows where to deliver. It never opens a connection to that
URL — see §8 C9.)* The delivery chain is split across three tickets:

| Piece | Owner | Where it lives |
|---|---|---|
| The `notify` declaration surface + this sync contract | **B-973** (this ticket) | `src/config/project-manifest.ts`, this document |
| The outbox substrate — published event contract, registration, claim/ack with lease redelivery | **B-980** | harmony-web (DB side) |
| The HTTP dispatcher — a Supabase edge function invoked by a `pg_net` database webhook on outbox insert, plus a `pg_cron` sweep | **B-1009** | harmony-web (edge function + DB) |

**B-1009 owns the DB-side sync and the actual delivery.** It is B-943's fifth child. It is a
Supabase-hosted dispatcher — an edge function triggered by a `pg_net` webhook on outbox insert, with a
`pg_cron` sweep for anything the webhook missed. It is explicitly **not** the conductor daemon: no
plugin process, no worker, and no long-lived Node service anywhere in this repo dispatches a notify.

### Which document owns which boundary

B-980's substrate contract is expected to land at **`web/docs/outbox-contract.md`**.

> **That file did not exist when this document was authored.** Checked against harmony-web
> `origin/main` at commit `34e398e`, freshly fetched on **2026-09-11**: there is no outbox document
> anywhere in that tree. B-980's clarify was ratified only hours earlier the same day. The authority
> that *is* readable today is **B-980's ratified clarify entry `40c604eb`** on the Harmony board —
> cite that, not the file, until the file exists.

The boundary statement below holds unconditionally; it does not depend on that file existing:

- **This document owns manifest → board sync.** How a `notify` declaration in
  `.harmony/project.yml` corresponds to a row in `activity_events`, which transitions are declarable,
  what a consumer must key on, how a consumer dedupes, and what it may assume about ordering and
  redelivery.
- **`web/docs/outbox-contract.md` (B-980) owns outbox → dispatcher.** The outbox table itself,
  registration mechanics, claim/ack, lease expiry and redelivery, retention.
- **B-1009 owns dispatcher → the network.** HTTP delivery, payload signing, retry/backoff and the
  dead-letter path.

A builder on either side should read both. Neither document restates the other.

---

## 2. The `notify` declaration surface

`notify` is the sixth strict top-level key of `.harmony/project.yml`. It is a list of entries:

```yaml
version: 1
notify:
  - on: "reaching Built"
    endpoint: "https://hooks.example.com/harmony/built"
  - on: "reaching Verified"
    endpoint: "https://hooks.example.com/harmony/verified"
```

- **`on`** — one of a fixed, enumerated set of transitions (below). Validated **post-parse** against
  that set. A value outside it makes the manifest **whole-file malformed** with the dedicated reason
  `unknown-transition`, and the error names the file, the offending value, and the recognized set, on
  one line. A declaration that would silently never fire is not a supported state.
- **`endpoint`** — an **absolute URL** (`z.string().url()`). A relative path or a typo'd scheme fails
  loud at parse time, not at some future dispatch.
- The entry schema is `.strict()`: any other key in an entry is `invalid-shape`.

### The ten declarable transitions

| # | `on` value |
|---|---|
| 1 | `reaching Proposed` |
| 2 | `reaching Clarified` |
| 3 | `reaching Decomposed` |
| 4 | `reaching Designed` |
| 5 | `reaching Planned` |
| 6 | `reaching Built` |
| 7 | `reaching Deployed` |
| 8 | `reaching Verified` |
| 9 | `reaching Parked` |
| 10 | `reaching Cancelled` |

Eight state entries plus the two exits. The list is exported as `DECLARABLE_TRANSITIONS` from
`src/config/project-manifest.ts` — that constant is the normative source; this table is a copy for
readers.

**`Captured` and the legacy `Idea` state are deliberately NOT declarable.** A reader scanning for "all
the states" will notice their absence, so: those are intake states, reached by *creating* a ticket
rather than by crossing a gate, so `reaching Captured` would fire on every ticket a project ever
opens — a notification with no decision behind it. If a project ever genuinely wants intake
notifications, that is a schema change to `DECLARABLE_TRANSITIONS` plus a manifest `version` bump
(§10), not a thing a project can smuggle in through a string.

---

## 3. The event source: the `activity_events` row shape

The board already emits, on every workflow-state change, a row in `public.activity_events`. Under
B-994's typed event contract (migration `20260910140000_b994_typed_event_contract.sql`, harmony-web)
that row carries:

| Column | Meaning |
|---|---|
| `id` | `uuid`, `gen_random_uuid()` — **random, not monotonic** (matters in §6) |
| `task_id`, `project_id`, `user_id` | the subject task, its project, the acting profile |
| `event_type` | `'field_change'` for a tracked-field write; `'brief_resolved'`, `'acceptance_event_consumed'`, … for the typed writers |
| `field_name`, `old_value`, `new_value` | for a `field_change` row: the field and its before/after (`'workflow_state'`, `'Deployed'`, `'Verified'`) |
| `metadata` | `jsonb`, writer-specific |
| `created_at` | `timestamptz`, `now()` — **transaction time, so rows in one transaction tie** (§6) |
| `source` | `'trigger'` (the pre-existing writers) or `'rpc-typed'` (B-994's causation-tracked path) |
| `provenance` | mirrors `resolve_brief`'s `p_provenance` — e.g. `'human-in-browser'`, `'human-in-session'`. Recorded, not enforced |
| `causation_brief_id`, `causation_conduction_id`, `causation_leg` | which brief / conduction / leg the event traces back to; `NULL` is a well-defined case, not an error |
| `aggregate_type`, `aggregate_id` | what entity the event is about (`'task'`, the task id) |
| `contract_version` | `NULL` = a pre-migration row, outside this contract's domain entirely, never backfilled. Non-`NULL` (currently `1`) = written under the typed contract |
| `tx_id` | `bigint`, `pg_current_xact_id()` — groups every row written in the same Postgres transaction. A grouping key, **not** an identity: deliberately not unique and not indexed as one |

**The row this contract keys on** is the `workflow_state` `field_change` row. It is written by the
tracked-field loop in `public.log_task_field_changes()`, the `AFTER UPDATE ... FOR EACH ROW` trigger on
`public.tasks`; `workflow_state` was added to that loop's tracked-field array by B-734
(`20260728161300_b734_workflow_decision_trail.sql`). A consumer must treat `contract_version IS NULL`
rows as outside this contract.

---

## 4. The declaration → event mapping, and the path-agnostic guarantee

A `notify` entry maps to exactly one class of event:

> `on: "reaching <State>"` ⟶ an `activity_events` row with
> `event_type = 'field_change'`, `field_name = 'workflow_state'`, `new_value = '<State>'`,
> `contract_version IS NOT NULL`, for a task in the declaring project.

`old_value` is whatever the task was in before; the declaration does not constrain it. `aggregate_id`
(and `task_id`) identify the ticket. That is the whole mapping — there is no second form.

### The path-agnostic guarantee

**The substrate must fire on *every* path into a declared state, including a human's click in the web
UI.** The manifest declaration is path-agnostic *by construction*, and the reason is the trigger's
position:

`log_task_field_changes()` is a row-level trigger on **`public.tasks` UPDATE**. It is not attached to
any one RPC, and it cannot see which caller performed the update. Anything that changes
`tasks.workflow_state` — `advance_workflow`, a `consume_*` RPC, `resolve_brief`'s applied decision, a
direct table update from the web app, a human clicking a state control in the browser — is an UPDATE
on `tasks`, and therefore produces the row. A declaration cannot accidentally scope itself to "only
transitions the conductor drove", because there is nothing in the row's provenance that the mapping in
§4 consults.

**Evidence that the browser path really does emit it (B-994, verified live):** on **2026-09-10 at
19:49:02Z**, a human advancing **B-838 from Deployed to Verified by clicking in the web UI** produced,
in a single transaction at that identical timestamp, a `brief_resolved` row plus **two** `field_change`
rows — one of them the `workflow_state` row, `Deployed` → `Verified`. The rows carry
`provenance = 'human-in-browser'`. No conductor, no plugin, no CLI was involved in that transition, and
the row shape is the same one a conductor-driven advance produces.

That same observation is also the hazard in §5 — note the row *count*.

---

## 5. De-duplication within a transaction (the companion-row hazard)

**This was found live at the design gate and it will bite a naive consumer.**

One logical state change writes **more than one row mentioning `workflow_state`, in the same
transaction, at the same timestamp.** Concretely, a deferred acceptance being consumed writes:

- the trigger's `field_change` row — `field_name = 'workflow_state'`, `old_value` → `new_value`; and
- `log_acceptance_event_write(...)`'s **companion** row — `event_type = 'acceptance_event_consumed'`,
  also with `field_name = 'workflow_state'` and the same from/to values (B-994 migration, the
  `consume_*` final-commit audit write).

Both rows are real and both are wanted — they record different things (what changed vs. which
brief/conduction caused it). They share one `tx_id`.

**The rule for consumers:**

1. **Key on the `field_change` / `workflow_state` row.** `event_type = 'field_change'` AND
   `field_name = 'workflow_state'`. That is the notification-bearing row.
2. **Dedupe by `tx_id`.** At most one notification per `(tx_id, task_id, declared transition)`.

A consumer that keys naively on "any row mentioning `workflow_state`" **double-fires** — it will send
two notifications for one state change. A consumer that keys on `acceptance_event_consumed` instead
of `field_change` will additionally miss every transition that did not go through a deferred
acceptance, including the browser click in §4.

---

## 6. Registration and the resumable position

Per B-980's ratified clarify (`40c604eb`): the outbox is substrate + a published contract +
**registration** + **claim/ack with lease redelivery**, and **consumers PULL**. A registered consumer
holds a *position* and resumes from it.

**The ordering key is `(tx_id, id)`** — `activity_events.tx_id` first, then `activity_events.id` as the
tiebreaker. It is stable and resumable: a consumer stores the last `(tx_id, id)` it acknowledged and
asks for rows strictly greater than it.

**It is not a total chronological order, and this contract says so rather than implying it:**

- **Across transactions** the order is chronologically correct — `tx_id` comes from
  `pg_current_xact_id()` and increases with transaction start.
- **Within a single transaction the order is arbitrary — but stable.** `activity_events.id` is a
  **random UUID** (`gen_random_uuid()`), and `created_at` is `now()`, which is *transaction* time, so
  every row written in one transaction carries the **identical** timestamp. Neither column can
  recover the intra-transaction write order. Sorting by `id` within a `tx_id` therefore yields an
  order that is arbitrary with respect to what actually happened, but *the same every time you ask* —
  which is all a resumable position needs.

A consumer must not infer causality from intra-transaction order (e.g. "the companion row came after
the field_change row"). Use `tx_id` grouping and §5's keying rule instead.

---

## 7. At-least-once and restart semantics

These are **obligations on the substrate** (B-980), restated here so a notify consumer knows what it
may assume:

- **At-least-once, never at-most-once.** A claimed event whose lease expires without an ack is
  **redelivered**. A consumer will therefore see duplicates, and must be idempotent — §5's
  `(tx_id, task_id, transition)` key is the idempotency key to use.
- **Restart resumes, it does not replay from zero and it does not skip.** A consumer that dies
  mid-batch restarts from its last acknowledged position (§6). Events between that position and the
  crash are redelivered, not dropped.
- **Ack is explicit.** Reading an event is not consuming it; the claim/ack cycle with lease
  redelivery is the substrate's, per B-980's clarify.
- **Ordering guarantees are exactly §6's** — per-transaction chronological, arbitrary-but-stable
  within a transaction. The substrate does not promise a global total order over wall-clock time.

---

## 8. Obligations this contract places on the delivery substrate

Written as **checkable claims**. Each one is either true of an implementation or it is not, and can be
tested against the DB without reading this prose:

1. **C1 — Path-agnostic firing.** For every path that changes `tasks.workflow_state` into a declared
   state — including a human clicking in the web UI — the substrate produces exactly one outbox event
   for that transition. *Check:* perform the same transition via `advance_workflow`, via a `consume_*`
   RPC, and via a browser click; assert one outbox event each.
2. **C2 — Declared-only.** The substrate produces an outbox event only for transitions a project's
   manifest declared in `notify`. A project declaring nothing produces no outbox events. *Check:* a
   manifest with no `notify` key yields zero events across a full gate sequence.
3. **C3 — Enumerated-only.** Only the ten transitions in §2 can appear. Nothing else is representable,
   because a manifest naming anything else does not parse. *Check:* the loader returns
   `unknown-transition` for any other value.
4. **C4 — Correct keying.** The substrate keys on the `field_change` / `workflow_state` row, not on
   any companion row. *Check:* a deferred-acceptance consume (which writes both rows, §5) yields one
   event, not two.
5. **C5 — Transaction dedup.** At most one outbox event per `(tx_id, task_id, declared transition)`.
   *Check:* the §5 two-row transaction yields one event.
6. **C6 — Contract-domain only.** Rows with `contract_version IS NULL` are ignored entirely.
   *Check:* a pre-migration row never produces an event.
7. **C7 — Stable resumable position.** A consumer resuming from a stored `(tx_id, id)` sees every
   event after it, exactly once per delivery attempt, in `(tx_id, id)` order. *Check:* kill a consumer
   mid-batch, restart, assert no gap.
8. **C8 — At-least-once with lease redelivery.** An unacked claim whose lease expires is redelivered.
   *Check:* claim without acking, wait out the lease, assert redelivery.
9. **C9 — No plugin-side dispatch to an endpoint.** *(Narrowed by B-1009 — still true, now
   precise.)* No process in harmony-plugin opens a network connection **to a declared `notify`
   `endpoint`**. The dispatch is entirely Supabase-hosted: an edge function driven by a `pg_net`
   webhook plus a `pg_cron` sweep, with HMAC signing, retry/backoff and dead-lettering all in the
   database (B-1009's migration, `20260911153220_b1009_notify_dispatcher.sql`). *Check:*
   `src/config/project-manifest.test.ts`'s "notify endpoint — declared data, NEVER reached" test,
   which asserts `notify` is absent from `EXTENSION_POINTS` and that no code path resolves it to an
   action.

   **What B-1009 DID make false is "there is no consumer of the key."** There is one now:
   `harmony gates run` syncs a repo's declaration to the board through the
   `notify_sync_subscriptions` RPC (`src/config/notify-sync.ts`), so declaring in
   `.harmony/project.yml` is the only step an operator takes. That call goes to the **board**, never
   to a declared endpoint; it fires only when `notify` is declared **and** the declaration's hash
   changed; it runs under a hard 3s timeout; and every failure mode — unreachable board, absent RPC,
   timeout — is one stderr warning that cannot change a gate's stdout, its steps, or its exit code
   (pinned by `src/cli/commands/gates.test.ts`'s four-outcome test).

10. **C10 — Receivers must be idempotent; the uniqueness guarantee is per logical transition.**
    Delivery is **at-least-once** end to end (C8), so a receiver **may see the same delivery
    re-attempted** — after a timeout whose request actually landed, after a lease expiry, or on a
    retry of a response the dispatcher never saw. Receivers must therefore be idempotent, keyed on
    the delivery's `(tx_id, task_id, subscription_id)` identity. What B-1009 *does* guarantee is
    **at most one delivery ROW per logical transition per subscription**, enforced by a UNIQUE index
    on `(tx_id, task_id, subscription_id)` — a database object, not a promise. That is not
    exactly-once delivery and must not be read as such: it bounds fan-out, not HTTP attempts.

11. **C11 — A dead-letter is a typed, flagged event, not an integrity gap.** When a delivery
    exhausts its attempts, the dead-letter event it raises is written with `source: 'trigger'` and
    is accepted **as flagged** — the same precedent B-980's auto-reconcile set for substrate-authored
    rows. A reader seeing `source: 'trigger'` on a dead-letter is looking at the dispatcher's own
    honest record of a failed endpoint, not at an unattributed write or a hole in the contract.

---

## 9. What this contract does NOT specify

- **HTTP delivery** — method, headers, timeouts, TLS policy, the payload body. B-1009.
- **Payload signing** — shared secrets, HMAC scheme, key rotation. B-1009.
- **Retry and backoff** — attempt counts, schedule, jitter. B-1009.
- **The dead-letter path** — where a permanently failing notification goes and who looks at it.
  B-1009.
- **Outbox table shape, registration mechanics, claim/ack, lease duration, retention.** B-980,
  `web/docs/outbox-contract.md` when it lands (§1).

**Explicitly: nothing in the plugin dispatches to `endpoint`.** That is as true after B-1009 as it
was before it — the dispatcher is Supabase-hosted (§8 C9). `notify` is still not a member of
`EXTENSION_POINTS` and `resolveExtensionPoint` still knows nothing about it.

**Updated by B-1009:** `notify` is no longer *unconsumed*. `harmony gates run`
(`src/config/notify-sync.ts`) syncs the declaration to the board's `notify_sync_subscriptions` RPC —
a board call, hash-gated, hard-timed-out, warning-only on every failure. A project that declares no
`notify` section still observes exactly what it observed before: zero board calls, identical stdout,
identical exit code.

---

## 10. Versioning and change policy

Two independent version seams govern changes to this contract.

**`activity_events.contract_version`** (B-994) versions the *event* side. `NULL` means a row predates
the typed contract and carries none of its guarantees — never backfilled, and a consumer must ignore
those rows (§8 C6). The current value is `1`. A future non-backward-compatible change to the row's
meaning bumps it; a consumer should pin the versions it understands and ignore rows carrying a version
it does not, rather than best-effort guessing.

**The manifest's own `version: 1`** versions the *declaration* side. `.harmony/project.yml` is
hand-authored, per-repo, `.strict()` prose: an unrecognized top-level key is far likelier a typo than
a forward-compat future key, so the schema fails loud instead of passing it through. `version` is the
single seam that would carry a real schema revision. Which means:

- **Adding a transition** to §2's ten (e.g. making `Captured` declarable) is a manifest schema change:
  it widens `DECLARABLE_TRANSITIONS`. Old manifests keep parsing, so this is additive and does not
  require a `version` bump — but it does require this document's §2 table and the constant to move
  together.
- **Removing or renaming a transition**, or changing an entry's shape (`endpoint` semantics, a new
  required field), **breaks existing manifests** and requires `version: 2` plus a loader that
  recognizes both.
- A manifest naming any `version` other than the supported one is malformed
  (`unrecognized-version`) — never silently accepted. This runner has no idea what a future version
  means.

The two seams move independently: an event-contract bump does not invalidate a `version: 1` manifest,
and a manifest bump does not change what `activity_events` emits.

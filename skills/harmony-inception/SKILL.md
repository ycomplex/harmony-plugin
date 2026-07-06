---
name: harmony-inception
description: Run a project's Day-1 genesis — the inception flow that seeds a brand-new product's knowledge base and work graph from a raw idea. Triggers on "inception", "harmony inception", "start a new project", "seed a new project from scratch", "Day 1", "we're starting something brand new". Configures Harmony for the project (S0), captures the founding proposition through the clarify gate (S1), then STAMPS the fixed genesis scaffold — foundational-spine decision tickets + bootstrap umbrellas + dependency edges — and seeds the founding persona + feature entity nodes. It makes ZERO technical decisions; those happen later by conducting the seeded decision tickets.
allowed-tools: mcp__harmony__* Read Grep Glob Write Edit
disallowed-tools: Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Inception (Day-1 genesis — B-397)

Inception is a **graph-seeder, not a decision-maker** (product-design `e340b661`; technical-design
`826c5088`). One run performs, in order: **S0** configure Harmony for this project + elicit its per-gate
semantics; **S1** capture the founding proposition by running the `clarify` gate on a bounded
proposition-root ticket; then **stamp the fixed genesis scaffold** — the portable foundational-spine
decision tickets, the bootstrap umbrellas, the dependency edges, and the founding persona + feature
entity nodes. It makes **zero technical decisions** — those happen later, by *conducting* the seeded
decision tickets. Almost nothing here is bespoke; the skill **composes** mechanisms the board + knowledge
layer already have (skills are stateless executors — the board + KB are the memory).

> This skill orchestrates existing tools. It does **not** invent a "founding-entry seeder": the ONE direct
> graph write it owns is entity-node seeding via `create_entity` (S1). Everything else rides the existing
> gates (`clarify` authors the proposition claims; conducting the S2 tickets authors the operational
> knowledge).

> Before recording any knowledge, follow `skills/harmony-shared/knowledge-discipline.md`. The elicitation
> in S0 and S1 is the SHARED engine — `skills/harmony-shared/elicitation-engine.md` and its four tools
> (`start_elicitation`, `file_elicitation_round`, `get_elicitation`, `conclude_elicitation`). A behaviour
> gap is an ENGINE amendment to surface, never a local workaround.

## The two governing boundaries (read before running)

1. **Completeness-for-build (IN) vs merit (OUT).** Inception elicits ONLY to close capture gaps that
   drive a downstream decision — *"you haven't said what happens when X, and that drives a decision"*
   (IN). It NEVER challenges whether the bet is good — *"have you validated that anyone wants X"* (OUT).
   Harmony is a build tool, not a business-model validator. This line governs every question you ask.
2. **The product-vs-project firewall.** Inception seeds **decision CATEGORIES** ("decide your
   architecture"), NEVER **decisions** ("use React"). The operational test for anything you are tempted to
   seed: *would this still be true if the project chose Drizzle instead of Supabase, or 100 microservices
   instead of a monolith? If flipping the stack flips the fact, it is project-specific — it belongs to a
   conducted decision's OUTPUT, never an inception seed.* You carry exactly one archetype: the canonical
   **genesis DAG** (a *process* archetype), never a *technical* archetype.

> **Ignore this ticket's own risk badge.** An inception run *files tickets*; it touches no auth /
> data-migration / irreversible-destructive surface itself. The `risk_classes` on the conducted
> decisions it seeds are caught later, at those decisions' own gates.

## 0. Preflight — resume-or-start (idempotency is a first-class requirement, AC A10)

Every write below is **create-or-skip on identity that already exists**, plus a **project-level
completion marker**. So a full re-run is a no-op AND a partial/interrupted stamp resumes without
duplicating. **Always start here:**

1. `mcp__harmony__get_project` — confirm you have a project. If `mode !== 'opinionated'` the discovery
   gates don't apply; inception is an opinionated-mode flow — set the mode in S0 before proceeding.
2. **Completion-marker fast path.** `mcp__harmony__query_knowledge({ type: 'convention', search:
   'inception:scaffold-complete' })` (also match by exact title in step 4's convention). **If the marker
   entry exists → inception already ran: report "already seeded" and STOP** (no-op). **If it is absent
   but scaffold artifacts already exist → RESUME:** run the phases below, and because every write is
   lookup-before-create, each already-present artifact is skipped and only the missing ones are created.
   Set the marker (step 4) once every artifact is present.

Treat S0 → S1 → scaffold as steps that each **check-then-create**. Interrupted anywhere, a re-run picks
up exactly where it stopped.

## 1. S0 — configure Harmony for this project + elicit its semantics

S0 is the substrate the other strata run on. It has two parts.

### 1a. Instantiate + pick mode (existing ops)
Ensure the project entity exists and set the **mode** (opinionated vs manual) via the existing project
ops. This is thin configuration, not knowledge.

### 1b. Per-gate semantics elicitation → project CLAUDE.md + `convention` entries
Elicit **what each gate MEANS and REQUIRES for THIS project**, through the shared engine:

```
mcp__harmony__start_elicitation({ task_id: <proposition-root or a config ticket>, trigger: 'inception-semantics', gate: 'inception' })
mcp__harmony__file_elicitation_round({ task_id, context_line: "...", questions: [...] })
```

Ask, per gate, the questions whose answers only the builder holds — e.g.:
- **What does "Deployed" correspond to here** — staging, pre-prod, or prod? What triggers each?
- **Does release require code review?** Is there a human finish-gate?
- **What does "Verified" require** — tests green, a staging smoke, a founder sign-off?

Then write the builder's answers to **two** places:
- The project's **own `CLAUDE.md`** (create/append via `Write`/`Edit`) — the label's meaning in prose,
  where the builder and future agents read it.
- A **`convention` knowledge entry per semantic** via
  `mcp__harmony__record_decision({ type: 'convention', title: "<project>: 'Deployed' means <X> here",
  content: "...", domain: ['process'], source_activity: 'inception' })`.

> **NEVER seed Harmony's OWN semantics.** Record the PROJECT's mapping ("Deployed = live on Cloudflare
> Pages for *this* project"), never the generic state-machine definition. The generic lifecycle is baked
> into Harmony's skills; re-seeding it would be noise.

> **S0↔S2 boundary — cross-reference, never restate.** S0 records the *label's meaning* (the semantic).
> The *implementation* ("how staging actually deploys") is the conducted S2 environment-topology
> decision's OUTPUT. On conflict, S2 is authoritative for the mechanism, S0 for the label. Don't define
> the deploy mechanism at S0 — only what the label means.

Convention entries dedupe on the knowledge title-uniqueness constraint, so a resumed run re-authoring the
same semantic is caught (skip on the friendly "already exists" error).

## 2. S1 — capture the founding proposition (the proposition-root + clarify gate)

The proposition (purpose, personas, features) is captured by running the **existing `clarify` gate** — no
bespoke capture logic.

### 2a. Create the bounded proposition-root ticket
`mcp__harmony__create_task` a **proposition-root** ticket titled e.g. *"Founding proposition — <product>"*,
described as the Day-1 capture of purpose / personas / features. Stamp it with the inception label (step
3a) so a resumed run finds it by lookup. **Lookup-before-create** — `search_tasks` for the deterministic
title first; reuse the existing one if present.

### 2b. Run clarify — at genesis the KB is empty, so it degrades to PURE COLD-START elicitation (AC A7)
Invoke `/harmony-plugin:harmony-clarify <proposition-root>` (or run its flow inline). Because the KB is
empty there is nothing to infer from, so clarify runs as **pure elicitation** under the cold-start rule
(`elicitation-engine.md` §cold start): **lead with your own best-effort inferences as validate
questions, gate depth by stakes, keep force-quit prominent from round one** — never maximal
interrogation of the least-invested user. Stay inside the completeness-vs-merit line: capture what the
build needs (personas, features, purpose, the explicit non-goals), never interrogate the bet's merit.

### 2c. On the founder's clarify-ACCEPT → seed the persona + feature entity nodes
The clarify accept promotes the proposition to **Accepted knowledge anchored to the proposition-root**,
and the ticket completes. **Only then** — the node-lifecycle rule (below) — seed the founding entity
nodes from the just-Accepted proposition claims:

```
// one thin node per persona named in the Accepted proposition
mcp__harmony__create_entity({ kind: 'persona',  name: "<persona>",  description: "<ONE-line canonical identity>" })
// one thin node per feature/capability named in the Accepted proposition
mcp__harmony__create_entity({ kind: 'feature',  name: "<feature>",  description: "<ONE-line canonical identity>" })
```

**Entity-node lifecycle rule (technical-design `826c5088` point 6 — do not violate):**
- **Born at the gate-ACCEPT that produces its Accepted knowledge.** Persona + feature nodes are seeded
  *only after* the clarify accept, from the just-Accepted claims. Never write a node before its knowledge
  is Accepted — nodes carry no Asserted→Accepted status, so `query_entities` returns them unconditionally;
  seeding early would surface un-Accepted substance.
- **A node description is a THIN, stable, one-line canonical identifier.** The substance and lifecycle
  live in the CLAIM/decision (which carries Asserted→Accepted + realization), NOT the node. Depth in the
  claim, not the node.
- **Seed persona + feature ONLY.** Do **NOT** seed `component` nodes — component is Stratum-2
  (architecture); creating it at inception would presume architecture (the firewall breach AC6 forbids).
  Component nodes are created LATER, when the architecture S2 decision is conducted. If the founder names
  product-level **surfaces** ("web app", "mobile app"), capture them as **features** (explicitly separate
  from architecture components).

`create_entity` upserts on `(workspace, kind, name)`, so a resumed run re-seeding the same persona is a
no-op (AC A10). After this step, `query_entities({ kind: 'persona' })` returns the seeded personas — not
`[]` (AC4).

## 3. Scaffold-stamp — the fixed genesis scaffold (archetype instantiation, NOT a decompose)

The scaffold is a **fixed stamp**, not a decomposition of the proposition-root (Ticket #1's real
decomposition would be the whole product — it would never complete). It does not require the proposition
to exist first. Stamp these, each **lookup-before-create**.

### 3a. Ensure the inception label (dedup key)
Tasks have **no per-project title uniqueness** (only `(project_id, task_number)`), so scaffold dedup is
**lookup-before-create**, keyed on a deterministic title + an `inception-scaffold` label. Ensure the
label exists (`create_label` — idempotent; reuse if present) and stamp it on every scaffold ticket
(`manage_labels`).

### 3b. Stamp the S2 foundational-spine decision tickets (portable CATEGORIES)
`create_task` one ticket per **portable decision-category** — these are the universal foundational spine
every software project decides. **Categories, never choices:**

| S2 decision ticket (title) | It decides… |
|---|---|
| Decide the architecture | module/component map, the shape of the system |
| Decide the repo & workspace topology | mono vs poly-repo, per-repo boundaries, deployable units |
| Decide the environment topology & deploy triggers | the staging→prod ladder, what triggers each deploy |
| Decide the data & migration tooling | the DB/ORM, the migration tool, forward-only vs rollback |
| Decide the CI/CD approach | pipeline, required checks, promote methodology |
| Decide the testing approach | frameworks, the test-runner, coverage expectations |
| Decide the coding standards | lint/format, conventions, the review policy |

Each S2 ticket's **description carries its half of the paired self-decompose contract (AC A11):**
> *"Produce a **well-structured** decision output the downstream bootstrap umbrella can read — e.g.
> architecture → an enumerable component description; testing → the framework picks. The bootstrap
> umbrella `<name>` reads this structure before it decomposes. A malformed output surfaces as a
> human-visible stall at this decision's accept gate — never bootstrap from garbage."*

The Slot A–F operational properties (forward-only migrations, deliberate promote-to-prod, prod-credential
handling, …) are **NOT seeded here** — they are recorded by *conducting* the relevant decision (e.g.
forward-only migrations is emitted by conducting *decide the data & migration tooling*). Seed the
category; the conduct emits the property.

### 3c. Stamp the S3 bootstrap umbrellas (undecomposed)
`create_task` the bootstrap umbrellas at the default inbox state, **specifically NOT decomposed** — they
self-decompose later, reading the knowledge their upstream S2 decisions produce:

- **Bootstrap the stack**
- **Set up CI/CD**
- **Wire the test runner**

Each S3 umbrella's **description carries the other half of the paired contract (AC A11):**
> *"Before decomposing, READ the structure recorded by `<upstream S2 decision>`. Pull the technical HOW
> (how to scaffold React vs Express, etc.) from builder-supplied archetype skills at decompose time — NOT
> from Harmony. If the upstream decision's structure is missing or ambiguous, STALL at your clarify gate
> (elicitation-first) rather than guessing — loud, not silent."*

### 3d. Wire the canonical genesis-DAG edges (`manage_dependencies`)
`manage_dependencies({ task_id, add: [<ids it depends on>] })`. **Skip-if-exists** — `list_dependencies`
first, add only the missing edges. The canonical edges:

- **Every S2 decision ticket depends-on the proposition-root** (so the Accepted proposition is retrievable
  the moment any decision is conducted — cold-start visibility rides this edge; no special rule).
- **Bootstrap the stack** depends-on *Decide the architecture* + *Decide the repo & workspace topology*.
- **Set up CI/CD** depends-on *Decide the CI/CD approach* + *Decide the repo & workspace topology* +
  *Decide the environment topology*.
- **Wire the test runner** depends-on *Decide the testing approach* + *Bootstrap the stack*.

(These are the genesis DAG's standard edges — the one *process* archetype inception carries. The S2
tickets have no blockers among themselves, so the founder conducts the architecture decision first and
the umbrellas immediately unblock.)

## 4. Set the completion marker

Once every artifact above is present, author the project-level completion marker so a subsequent clean
re-run fast-paths to a no-op (step 0.2):

```
mcp__harmony__record_decision({ type: 'convention', title: "inception:scaffold-complete — <project>",
  content: "Genesis scaffold stamped: proposition-root, S2 spine, S3 umbrellas, edges, persona+feature nodes.",
  status: 'Accepted', domain: ['process'], source_activity: 'inception' })
```

Its title uniqueness is the idempotency backstop: a resumed run that reaches here when the marker already
exists no-ops on the friendly "already exists" error.

## 5. Report

Summarize what was stamped (proposition-root id, the S2 + S3 ticket ids, the edges, the seeded
persona/feature nodes, the semantics conventions) and the immediate next move: **conduct the architecture
decision first** — it has no blockers, and accepting it unblocks *Bootstrap the stack*.

## What inception must NEVER do
- Make a technical decision (choose a stack, a framework, a repo count). It seeds the *category*; conduct
  decides.
- Seed a `component` entity node (Stratum-2 — presuming architecture, the firewall breach).
- Challenge the merit of the bet (completeness IN, merit OUT).
- Write an entity node before its knowledge is Accepted.
- Seed the Slot A–F operational properties directly (they are conduct OUTPUTS).
- Duplicate on a re-run — every write is create-or-skip on existing identity + the completion marker.

## Note on the S2 `realization` axis (agreed→live)
Seed the S2 decisions' knowledge (when they are conducted) at **`realization = 'agreed'`** — decided,
not-yet-built (B-400). The flip to `'live'` is driven downstream when the S2's S3 bootstrap umbrella
completes; it does not fire during inception. See B-397's build notes for the flip mechanism.

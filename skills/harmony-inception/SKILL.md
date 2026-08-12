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

**The lookup key per artifact — every write below has one:**

| Artifact | Lookup-before-create key |
|---|---|
| Proposition-root, S2 tickets, S3 umbrellas, the S4 roadmap slot | deterministic title + the `inception-scaffold` label (tasks have no per-project title uniqueness) |
| The `v1` / `deferred` milestones (§1a) | milestone title |
| Persona / feature entity nodes | `create_entity` upserts on `(workspace, kind, name)` |
| `convention` entries (S0 semantics) | knowledge title uniqueness — skip on the friendly "already exists" error |
| DAG edges (§3d) | `list_dependencies` first; add only what is missing |
| The `.gitignore` ignore line (§3g) | `Grep` for the line before any `Edit` |
| The scaffold-complete marker (§4) | knowledge title uniqueness — the project-level backstop |

## 1. S0 — configure Harmony for this project + elicit its semantics

S0 is the substrate the other strata run on. It has two parts.

### 1a. Instantiate + pick mode + stamp the milestone fence (existing ops)
Ensure the project entity exists and set the **mode** (opinionated vs manual) via the existing project
ops. This is thin configuration, not knowledge.

Then stamp the **default milestone fence** specified in §3f — `create_milestone` for **`v1`** and
**`deferred`**, lookup-before-create by title.

> **Why the fence is created HERE and not with the rest of the scaffold in §3 — this ordering is
> load-bearing.** S1's proposition clarify can **de-scope**: on the founder's explicit "that's later"
> answer it re-tickets the later phase (`harmony-clarify` §3's de-scope block). Those mints need a named
> later milestone to land in *at that moment*. §3 runs **after** S1, so a fence stamped there would arrive
> too late and the de-scoped captures would land in an undifferentiated backlog — the exact failure the
> fence exists to prevent. Creating two milestones presumes nothing about the product, so it is safe this
> early; the S4 conduct renames them once the founder knows what the first release is actually called.

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
Invoke `/harmony-plugin:harmony-clarify <proposition-root>` — always the real gate skill, never an inline
re-implementation (B-681 dropped the former "(or run its flow inline)" escape: the real gate is what
authors the proposition knowledge, carries the completion line, and runs the fast-forward). Because the KB is
empty there is nothing to infer from, so clarify runs as **pure elicitation** under the cold-start rule
(`elicitation-engine.md` §cold start): **lead with your own best-effort inferences as validate
questions, gate depth by stakes, keep force-quit prominent from round one** — never maximal
interrogation of the least-invested user. Stay inside the completeness-vs-merit line: capture what the
build needs (personas, features, purpose, the explicit non-goals), never interrogate the bet's merit.

### 2c. On the founder's clarify-ACCEPT → seed the persona + feature entity nodes
The clarify accept promotes the proposition to **Accepted knowledge anchored to the proposition-root**,
and the ticket completes **by the named mechanism (B-681): the accept advances Proposed→Clarified, then —
when the proposition-root carries the `decision-only` label — the clarify skill's trailing
`advance_workflow('fast-forwarding')` completes it Clarified→Verified** (the brief carries the completion
line; the captured proposition stays `realization='agreed'`; never Parked, never left non-terminal).
**Stamping is now enabled (B-688):** who stamps the `decision-only` label is no longer unowned — it is one
of three ratified producers (inception's, clarify-proposed, and manual — see
`skills/harmony-shared/gate-routing.md` §The decision-only fast-forward). Inception's own mechanism here is
**unchanged**: this proposition-root is capture-only by construction (S1's whole job is capturing the
founding proposition, nothing to plan/build/deploy from it), so **label it by hand right after step 2a's
`create_task`, before running clarify** — exactly as before this ticket. What changes is that the stamp is
now GOVERNED: it runs through the label editor's `can_mark_decision_only` pre-check (step 1 of this
ticket's web half) like any manual label-add, and since a just-minted proposition-root is always
pre-Planned with no build PR, the guard always allows it at this point in the flow. **Only
then** — the node-lifecycle rule
(below) — seed the founding entity
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
| Decide the authentication & identity approach | who a user is, what proves it, which system provides it |
| Decide the design system | whether one exists, when it gets built, what it governs |

**Stamp every row UNCONDITIONALLY — never conditionally on the product's shape.** It is tempting to stamp
*Decide the design system* only for a product with a user interface, or the auth row only when the
proposition mentions identity. Do **not**: deciding whether this product *has* a UI channel or an identity
model IS a decision, and the skill makes none (the firewall in *The two governing boundaries*). Conditional
stamping also converts the scaffold from a fixed archetype instantiation into an inferred one.

A project that genuinely has neither closes the ticket with an **explicit "not applicable, and why"
decision** at its own gate — the recorded-not-implicit principle applied to the N/A case. An explicit
not-applicable is cheap; a silently-missing category is what let identity go unasked for an entire
five-module product.

Each S2 ticket's **description carries its half of the paired self-decompose contract (AC A11):**
> *"Produce a **well-structured** decision output the downstream bootstrap umbrella can read — e.g.
> architecture → an enumerable component description; testing → the framework picks. The bootstrap
> umbrella `<name>` reads this structure before it decomposes. A malformed output surfaces as a
> human-visible stall at this decision's accept gate — never bootstrap from garbage."*

Each S2 description **also carries the seeded-direction section (§3h)** — empty at stamp time, for the
founder to paste pre-formed direction into:
> `## Seeded direction (proposal, not a decision)`
>
> *"Anything here is a starting proposal. This ticket's clarify gate treats it as a candidate to validate,
> and its design gate must still record real alternatives and may reject it."*

**`Decide the repo & workspace topology` additionally carries the repo-hygiene clause (§3g):**
> *"Whatever repo count and boundaries you decide, every repository created under them carries
> `.harmony-task.json` in its `.gitignore` from birth."*

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

Each S3 umbrella's **description carries the other half of the paired contract (AC A11).** Take
`<upstream S2 decisions>` verbatim from **this umbrella's row in §3d's table** — never re-derive or
re-type the list here, which is exactly how the two authorings drifted before:
> *"Before decomposing, READ the structure recorded by `<upstream S2 decisions — this umbrella's §3d
> row>`. Pull the technical HOW (how to scaffold React vs Express, etc.) from builder-supplied archetype
> skills at decompose time — NOT from Harmony. If any upstream decision's structure is missing or
> ambiguous, STALL at your clarify gate (elicitation-first) rather than guessing — loud, not silent."*

**Bootstrap the stack additionally carries the repo-hygiene clause (§3f):**
> *"Any repository this umbrella creates carries `.harmony-task.json` in its `.gitignore` from the first
> commit. That file is per-ticket conductor working context, not product source: left untracked-but-
> uncommitted it collides on every concurrent pair of workers, and committed it puts a conductor artifact
> in the product tree."*

### 3d. The canonical genesis DAG — ONE table, cited twice

**This table is the single source of truth for the genesis DAG.** Both the dependency wiring below AND
the read-inputs named in §3c's stamped umbrella descriptions are written FROM it. Do **not** restate a
read-input anywhere else — cite the row.

*Why it is a table and not two prose lists:* the read-inputs used to be authored twice, once as an edge
list here and once as description prose in §3c, and the two drifted — the edge list wired *Bootstrap the
stack* to two upstreams while the description the same skill stamped named four. Correcting the mismatch
without removing the duplication would only have reset the clock.

| Downstream node | Reads (depends-on) |
|---|---|
| Every S2 decision ticket | the proposition-root |
| S4 · Define the roadmap & first-milestone backlog | the proposition-root |
| S3 · Bootstrap the stack | Decide the architecture · Decide the repo & workspace topology · Decide the data & migration tooling · Decide the coding standards |
| S3 · Set up CI/CD | Decide the CI/CD approach · Decide the repo & workspace topology · Decide the environment topology & deploy triggers |
| S3 · Wire the test runner | Decide the testing approach · Bootstrap the stack |

Wire them with `manage_dependencies({ task_id, add: [<ids it depends on>] })`. **Skip-if-exists** —
`list_dependencies` first, add only the missing edges.

Notes on particular rows:
- **Every S2 depends-on the proposition-root** so the Accepted proposition is retrievable the moment any
  decision is conducted — cold-start visibility rides this edge; no special rule.
- **S4 depends on the proposition-root ONLY** (§3e). Which features ship first is a product question, not
  an architecture-dependent one, so the roadmap is conducted EARLY. The *late* things are its OUTPUT
  tickets, which carry their own edges onto the S3 umbrellas — see §3e's contract.
- **Bootstrap the stack reads four decisions**, matching the description it stamps: architecture and repo
  topology for the shape, data & migration tooling for the persistence layer, coding standards for house
  style.
- **The two newer S2 categories — authentication & identity, and the design system — carry no S3 edge.**
  No bootstrap umbrella names either as a read-input; they are read by the S4 roadmap's feature work
  instead. Blanket-wiring every S2 onto an umbrella would conflate the umbrella split, which is the same
  error in the opposite direction.

(These are the genesis DAG's standard edges — the one *process* archetype inception carries. The S2
tickets have no blockers among themselves, so the founder conducts the architecture decision first and
the umbrellas immediately unblock.)

### 3e. Stamp the S4 roadmap slot — where the board becomes plannable

The scaffold so far produces a decision spine and nothing to plan against. This slot is what ends Day-1
with a plannable board. `create_task` **one** ticket, lookup-before-create on the deterministic title:

- **Define the roadmap & first-milestone backlog**

Its **description carries its contract** — and note that every step below is an EXISTING gate doing its
existing job. This slot invents no minting mechanism:
> *"Conducting this ticket produces the board. Your **clarify** gate agrees the milestone set with the
> founder — refining and renaming the default fence (§3f), adding milestones as needed — and agrees which
> features belong in the FIRST milestone, grounded in the persona and feature entity nodes S1 seeded. Your
> **decompose** gate then creates one child per agreed feature. As part of that same decompose accept:
> assign each child to the first milestone (`update_task milestone_id`), and wire each child depends-on the
> S3 bootstrap umbrellas it needs (`manage_dependencies`) — no feature can be built before the stack it
> runs on exists. Milestone writes are `update_milestone` to rename the defaults and `create_milestone` for
> any additional."*

**Conduct this EARLY — it is not blocked by architecture.** Its only edge is the proposition-root (§3d).
Which features ship first is a product question; gating it behind the architecture decision would leave the
founder holding a spine with nothing to plan against for as long as the spine takes to conduct, which is
the exact failure this slot exists to end. Its OUTPUT tickets are the late ones, by their own edges.

### 3f. The default milestone fence — stamped in S0, before anything can de-scope

The fence itself is created in **§1a (S0)**, not here — see the ordering note there. This section is where
it is *specified*, since it is scaffold structure:

- **`v1`** — the first delivery goal. The S4 conduct renames it to whatever the founder actually calls it.
- **`deferred`** — the fence for later-phase work.

`create_milestone` for each, **lookup-before-create by title**. The S4 conduct **refines and renames**
them; it never originates them. Nothing else in the flow may assume a particular name — read them back by
lookup, because by then the founder may have renamed both.

### 3g. Repo hygiene — the ignore line, written where a repo first exists

The conductor writes `.harmony-task.json` into a repo it is building in. That file is per-ticket worker
context, not product source: uncommitted it collides on every concurrent pair of workers, committed it
leaves a conductor artifact in a team's product tree.

**The primary write is a contract clause, not an action here** — because at stamp time there is usually
**no repository yet**. How many repos exist, and where, is precisely what the *Decide the repo & workspace
topology* S2 decision settles later, so the skill cannot know what to edit. The clause therefore rides two
stamped descriptions: **Bootstrap the stack** (§3c, the umbrella that actually creates repos) and **Decide
the repo & workspace topology** (§3b, which decides how many there will be).

**Additionally, when a repository ALREADY exists at scaffold time** — a founder running inception inside an
existing checkout — ensure the line now, idempotently:

1. `Grep` the repo's `.gitignore` for `.harmony-task.json`. Present → done, no write.
2. Absent → `Edit` the file to append the line.

Never a blind append (it duplicates on a re-run), and never a shell script: this skill's `allowed-tools`
carries no `Bash`, and appending one line to a text file is what `Edit` is for. Widening a discovery-role
skill's permissions for this would buy nothing.

### 3h. Founder-seeded direction — the blessed pattern, and its rail

Founders routinely form direction *outside* this flow — brainstorming an architecture with an assistant
(`superpowers:brainstorming` is the sanctioned tool) and bringing the result to the ticket. **This is
blessed, not tolerated.** The flow neither had to support nor pretend it doesn't happen.

The **rail** is what makes it safe. Seeded direction enters as a **proposal, never a decision**:

- Each stamped S2 description carries a named section — **`## Seeded direction (proposal, not a decision)`**
  — for the founder to paste into.
- The receiving ticket's **clarify** gate treats that content as a validation candidate, not settled
  intent.
- The receiving ticket's **design** gate must still record genuine alternatives, and may reject the seeded
  direction outright.

**What the rail prevents** is the failure actually observed: a framework named in passing inside a design
that did not own the choice, which then governed by default because nothing ever ratified or rejected it.
A proposal that survives its design gate is a decision; one that is never examined is not — and §3i is how
you tell which decisions were owed in the first place.

### 3i. The decision-allocation map — which stage owns each decision, and where it may defer to

The spine seeds decision *categories*. This map answers the next question: **when a specific choice comes
up, which ticket owns it, and what happens if it is not settled there?**

| Decision | Owning stage | May defer to (deferral must be RECORDED) |
|---|---|---|
| What the gate labels mean here | S0 semantics | — (S0 is the floor) |
| Purpose, personas, features | S1 proposition | — |
| Language / runtime, UI framework, module map | S2 · Decide the architecture | Bootstrap the stack's clarify |
| Repo count and boundaries | S2 · Decide the repo & workspace topology | — |
| DB, ORM, migration tool | S2 · Decide the data & migration tooling | Bootstrap the stack's clarify |
| Pipeline, required checks, promote method | S2 · Decide the CI/CD approach | Set up CI/CD's clarify |
| Test framework and runner | S2 · Decide the testing approach | Wire the test runner's clarify |
| Lint, format, review policy | S2 · Decide the coding standards | Bootstrap the stack's clarify |
| Auth model and provider | S2 · Decide the authentication & identity approach | the first feature that needs identity |
| Design system: whether, when, what it governs | S2 · Decide the design system | the first UI feature |
| Milestone set, first-milestone scope | S4 roadmap | — |

**The governing rule: a stack specific belongs to the S2 category that owns its layer.** A UI framework is
decided by *Decide the architecture*, not mentioned in passing by whichever design happens to touch the UI
first.

**Deferral is legal; silence is not.** An S2 that deliberately does not settle a specific must say so in
its decision output and **name where it will be decided** — the "May defer to" column is the allowed set. A
choice that appears in prose without an owning ticket and without a recorded deferral is a defect, and this
map is what makes it visible as one.

## 4. Set the completion marker

Once every artifact above is present, author the project-level completion marker so a subsequent clean
re-run fast-paths to a no-op (step 0.2):

```
mcp__harmony__record_decision({ type: 'convention', title: "inception:scaffold-complete — <project>",
  content: "Genesis scaffold stamped: v1+deferred milestone fence, proposition-root, S2 spine, S3 umbrellas, S4 roadmap slot, edges, persona+feature nodes.",
  status: 'Accepted', domain: ['process'], source_activity: 'inception' })
```

Its title uniqueness is the idempotency backstop: a resumed run that reaches here when the marker already
exists no-ops on the friendly "already exists" error.

## 5. Report

Summarize what was stamped (the milestone fence, proposition-root id, the S2 + S3 + S4 ticket ids, the
edges, the seeded persona/feature nodes, the semantics conventions) and the immediate next moves. **Two
tickets are unblocked from the start, and they answer different questions:**

- **Conduct the architecture decision** — it has no blockers, and accepting it unblocks *Bootstrap the
  stack*. This is the "what are we building it with" thread.
- **Conduct the S4 roadmap slot** — also unblocked (proposition-root only), and it is what turns the board
  plannable: milestones the founder recognizes, and a first-milestone backlog. This is the "what are we
  building, and when" thread.

Name both. A founder told only about the architecture decision gets a spine and still cannot answer what
ships first — the gap this scaffold now closes.

## What inception must NEVER do
- Make a technical decision (choose a stack, a framework, a repo count). It seeds the *category*; conduct
  decides.
- **Stamp a decision category conditionally** on the product's shape ("no UI, so skip the design system").
  Inferring the shape is itself a decision — stamp every category and let a genuinely inapplicable one
  close with an explicit not-applicable decision (§3b).
- **Mint feature build tickets itself.** The features land via the S4 roadmap slot's *conduct* (§3e), which
  is what keeps the skill a graph-seeder. Note the vocabulary: the inception **SKILL** stamps; the
  inception **PROCESS** — this run plus conducting what it stamped — is what puts features on the board.
- Seed a `component` entity node (Stratum-2 — presuming architecture, the firewall breach).
- Challenge the merit of the bet (completeness IN, merit OUT).
- Write an entity node before its knowledge is Accepted.
- Seed the Slot A–F operational properties directly (they are conduct OUTPUTS).
- Duplicate on a re-run — every write is create-or-skip on existing identity + the completion marker.

## Note on the S2 `realization` axis (agreed→live)
Seed the S2 decisions' knowledge (when they are conducted) at **`realization = 'agreed'`** — decided,
not-yet-built (B-400). The flip to `'live'` is driven downstream when the S2's S3 bootstrap umbrella
completes; it does not fire during inception. See B-397's build notes for the flip mechanism.

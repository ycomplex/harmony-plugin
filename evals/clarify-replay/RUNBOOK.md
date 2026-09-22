# Clarify-replay eval — hand-pass runbook (B-1036)

A clarify-gate replay eval: 15 ratified v1.4 tickets, replayed through `skills/harmony-clarify`
against an isolated fixture project, graded (4 deterministic must-haves + 1 LLM judge) against the
ratified brief each ticket actually carries on **production**. This document is the procedure for
the **hand pass** — a human (or a credentialed agent session) running the suite for real. It is
**not** run as part of this suite's own PR build; see the ticket for why.

## 0. Founder-run preconditions (not built by this suite — verify, never create)

This whole suite depends on three things a founder sets up separately. This RUNBOOK's step 2 below
is how the hand-pass executor **verifies** them — never creates them:

- **(a) An isolated fixture project row**, inside the **staging** Supabase project, created by a
  founder-run `pg_dump` copy-and-strip of the ~15 case tickets (tasks rows only): `epic_id`,
  `milestone_id`, `parent_task_id`, and `cycle_id` all nulled, `workflow_state` reset to
  `Proposed`, and `field_values.gate_slots` cleared. The fixture project has **its own visual-id
  key** (e.g. `FX`), independent of the production project's `B` key.
- **(b) A `HARMONY_API_TOKEN` scoped to that fixture project.** Tokens are per-project — an
  ordinary staging Backlogs token does **not** reach the fixture project; a token minted
  specifically against it is required.
- **(c) The staging URL/anon key + that fixture-scoped token wired into the eval invocation's
  environment** (step 4 below).

## 1. Environment — two DIFFERENT credential sets, named here, values nowhere

Two separate steps below need two separate credential sets. **Names only — no values, no example
tokens, ever, in this file or in anything derived from it.**

**Step 2 (label-fetch) — production, read-only:**
- `HARMONY_API_TOKEN` — an ordinary **production** Backlogs token (any token that can read the ~15
  case tickets on production is enough; the script only ever `SELECT`s).
- `HARMONY_SUPABASE_URL`, `HARMONY_SUPABASE_ANON_KEY` — **leave unset**, or set to production's own
  values. Do **not** point these at staging for this step — the ratified labels live on
  production, not on the fixture project.

**Step 4 (the suite run) — the fixture project on staging:**
- `HARMONY_API_TOKEN` — the **fixture-project-scoped** token from precondition (b) above. Not an
  ordinary staging token — it must be minted against the fixture project specifically.
- `HARMONY_SUPABASE_URL`, `HARMONY_SUPABASE_ANON_KEY` — the **staging** Supabase project's values
  (the same pair `scripts/setup-staging-channel.sh` writes for the B-488 staging channel).

Never run step 2 and step 4 in the same shell without re-exporting between them — the two steps
must never share a `HARMONY_API_TOKEN`.

## 2. Verify the preconditions (one read, before anything else)

Before running the label-fetch script or the suite, confirm (a)-(c) above are actually in place
with **one** staging-channel `get_task` read of any single ticket already known to be in the
fixture project's pool (a "pool ticket") — using the credentials from step 4, e.g. from the B-488
staging-channel setup (`plugin/CLAUDE.md` → "Staging channel"). Confirm:

- the read succeeds at all (precondition a: the project row and the ticket exist);
- the ticket's `workflow_state` reads `Proposed` and its `field_values.gate_slots` is empty
  (precondition a: the strip actually reset state, not just copied rows);
- `get_project`'s `environment` block shows `target: staging` (precondition c: the wiring is
  correct).

**Record what this read found** (pass/fail per bullet above) before proceeding — as a comment on
B-1036, or alongside the run's output in `results/` (step 6). A precondition failure here means
stop: fix the precondition (founder's job, not the eval's) before running anything else.

## 3. Fetch the labels (production, read-only)

From a checkout of this repo with `npm install` already run (the script imports
`@supabase/supabase-js` from `node_modules`):

```
# Environment from step 1's "Step 2" block.
node evals/clarify-replay/scripts/fetch-labels.mjs
```

Writes `evals/clarify-replay/labels/<TICKET>.json` for each of the 15 dataset tickets (gitignored
— never committed). Pass one or more visual ids as arguments to fetch a subset, e.g.
`node evals/clarify-replay/scripts/fetch-labels.mjs B-818 B-904`.

The script is **read-only**: it only ever calls `.select()` against the `tasks` and `briefs`
tables. It never writes to the board.

## 4. Substitute the fixture project's ticket ids into each case's prompt.md

Every case's `prompt.md` carries the placeholder token `__FIXTURE_TICKET_ID__` in place of the
production ticket id (build detail #4 of B-1036 — the fixture project has its own visual-id key,
not `B-<n>`). Before running the suite, replace the placeholder in each case with the fixture
project's own id for that ticket (the mapping from production ticket → fixture ticket id is
established by precondition (a)'s copy-and-strip; get it from whoever ran that `pg_dump`, or from
the fixture project's own board).

```
# Example shape — fill in the real fixture ids for your run:
declare -A FIXTURE_ID=( [B-818]=FX-1 [B-904]=FX-2 [B-917]=FX-3 [B-293]=FX-4 [B-847]=FX-5 \
  [B-720]=FX-6 [B-776]=FX-7 [B-785]=FX-8 [B-809]=FX-9 [B-861]=FX-10 [B-871]=FX-11 \
  [B-881]=FX-12 [B-894]=FX-13 [B-919]=FX-14 [B-929]=FX-15 )

for ticket in "${!FIXTURE_ID[@]}"; do
  sed -i "s/__FIXTURE_TICKET_ID__/${FIXTURE_ID[$ticket]}/g" \
    "evals/clarify-replay/cases/${ticket}/prompt.md"
done
```

**This edits the working tree only.** After the run (step 6), restore the placeholders so the
checkout stays clean for the next hand pass:

```
git checkout -- evals/clarify-replay/cases/*/prompt.md
```

## 5. Run the suite

From the repo root, environment from step 1's "Step 4" block:

```
claude plugin eval . \
  --eval-dir evals/clarify-replay \
  --mocks off --allow-real-servers \
  --allow-tools 'mcp__harmony__*' \
  --runs 1 \
  --model claude-sonnet-5 \
  --judge-model claude-opus-5 \
  --max-cost-usd 20 \
  --json evals/clarify-replay/results/result.json \
  --report evals/clarify-replay/results/report.html
```

Notes on each pinned flag (per the accepted design, B-1036 step 5):

- **`--mocks off --allow-real-servers`** — real MCP servers against the fixture project, not
  recorded stand-ins (`--mocks record` withholds any MCP tool with no recorded mock — the probe's
  finding).
- **`--runs 1`** (not the default 3) — the fixture project's pre-clarify board state does not
  survive being read and drafted against more than once; there is no reset/clone mechanism for it
  in v1. Also set as each case's own `runs: 1` as a defensive default.
- **`--ablation`** left at its default (`with-without`, since the target resolves to this plugin) —
  this is what makes the `related-tickets-queried` grader's `arm: with-only` actually exclude it
  from the score (see that grader's comment in each case.yaml).
- **`--model claude-sonnet-5`** — the authoring model (the deployment default for the clarify
  gate).
- **`--judge-model claude-opus-5`** — the judge model, deliberately **distinct** from the authoring
  model (B-1036 step 4's requirement).
- **`--max-cost-usd 20`** — a real ceiling, not a placeholder: 15 cases × one judge call each, at
  list price, comfortably inside this (the July KB eval's cost note: "tens of dollars at list
  price per run").
- **`--allow-tools 'mcp__harmony__*'`** — the operator grant real MCP tool calls need under
  `--mocks off`.

If the run hits `--max-cost-usd` and aborts (exit 2), the partial JSON/HTML still reports whatever
graded before the ceiling — attach it as a partial run and say so explicitly (never silently as if
it were complete).

## 6. Where the report lands, and how to attach it to B-1036

`--json` and `--report` above pin stable filenames:
`evals/clarify-replay/results/result.json` and `evals/clarify-replay/results/report.html`.
`evals/clarify-replay/results/` is gitignored (confirmed live during this build: the tool writes an
`aggregate-result.json` under a timestamped `results/` subdirectory even with no `--output-dir`, so
the whole directory is ignored rather than just the two pinned filenames) — hand-pass output, never
suite source, never committed.

Attach **both** files to B-1036 with the `attach_file` MCP tool (`task_id: B-1036`, `file_path:`
each of the two paths above) — this is the same substrate `download_attachment`/`attach_file`
(`src/tools/attachments.ts`) already uses for any task attachment. Then post a one-paragraph
reading of the score as a comment: the `overallScore`, `casesPassed`, which grader(s) caught
anything (and on which ticket), and an honest note on any case that scored low only because of the
`related-tickets-queried` with-only indicator being absent (expected — see that grader's comment —
never a real miss).

## 7. What this build verified live, and what is still unverified

This suite's shape (case.yaml schema, grader field names, the `arm: with-only` ablation-exclusion
mechanism, `--eval-dir`'s path semantics) was reverse-derived from the installed `claude plugin
eval` binary's own compiled validator (early access, 2026-09) plus its `--help` text, then checked
against a real, zero-cost dry run of this exact suite (`--max-cost-usd 0`, which aborts before any
agent turn or MCP server launch, so nothing real was ever called or spent):

- **Confirmed live:** all 15 `case.yaml` files parse without a schema error; `--eval-dir
  evals/clarify-replay` correctly resolves the nested path and finds all 15 cases under
  `cases/*/case.yaml`; the plugin resolves by path (reported as `harmony-plugin @ 0.0.0-dev` — the
  inert source-only marker, confirming this is the source checkout, not an installed copy);
  ablation correctly defaults to `with-without` once the plugin resolves (so the
  `related-tickets-queried` grader's `arm: with-only` will actually take effect); and the dry run's
  own mock-warning message confirms `--mocks record` (the default) would withhold the plugin's MCP
  server entirely, validating the `--mocks off --allow-real-servers` choice in step 5.
- **Still unverified — no cheap way to check without a real run:**
  1. **`execution.allowed_tools: [mcp__harmony__*, ...]`** — the wildcard form assumed to follow
     Claude Code's ordinary MCP-tool wildcard convention (the same syntax `harmony-clarify`'s own
     skill frontmatter uses). Case-load accepted it with no parse error, but that does not prove
     the wildcard actually grants every `mcp__harmony__*` tool at run time. If a run reports MCP
     tools withheld despite `--allow-tools 'mcp__harmony__*'`, try listing each MCP tool name the
     clarify skill actually calls explicitly instead of the wildcard.
  2. **`baseline_file: ../../labels/<TICKET>.json`** — assumed relative to the case directory
     (`cases/<TICKET>/`), landing on `evals/clarify-replay/labels/<TICKET>.json`. The tool's own
     error text confirms the path must be relative and must resolve "inside the suite or the
     plugin under test" — both true here — but the resolution BASE (case dir vs. suite root) is
     only exercised once a `baseline` grader actually scores a real run, which the $0 dry run never
     reaches.

## 8. Out of scope (do not attempt these from this runbook)

- Wiring this suite into CI / a skill-PR gate — that is B-1037.
- Any other gate's replay suite (decompose, design, plan) — a follow-on once this one has caught
  something, per the accepted design.
- The KB eval cadence (B-678) — unrelated suite, unrelated cadence.
- Creating, resetting, or restoring the fixture project — founder-run precondition (a); this
  runbook only verifies it (step 2).

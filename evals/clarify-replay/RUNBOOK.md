# Clarify-replay eval — hand-pass runbook (B-1036)

A clarify-gate replay eval: 15 ratified v1.4 tickets, replayed through `skills/harmony-clarify`
against an isolated fixture project on **staging**, graded (4 deterministic must-haves + 1 LLM
judge) against the ratified brief each ticket carries on **production**. This is the procedure for
the **hand pass** — a credentialed session running the suite for real. It is not part of this
suite's own PR build. Every mechanism below was proven live on 2026-09-22 (see the ticket).

## 0. Founder-run preconditions (verified here, never created here)

- **(a)** A fixture project inside the staging Supabase project holding the 15 case tickets as
  **tasks rows only** — `epic_id` / `milestone_id` / `parent_task_id` / `cycle_id` null,
  `workflow_state` `Proposed`, `field_values` `{}` — under its own key (`FX`; `FX-<n>` is `B-<n>`,
  same `task_number`). Single-use: the clarify skill writes a brief to each case it runs.
- **(b)** A `HARMONY_API_TOKEN` minted against that fixture project (tokens are per-project).
- **(c)** The staging URL / anon key and that token, in an env file **outside the repo** (mode
  600), holding `HARMONY_SUPABASE_URL`, `HARMONY_SUPABASE_ANON_KEY`, `HARMONY_API_TOKEN`.

## 1. How the credentials reach the sandbox (read this before touching a flag)

`claude plugin eval` withholds the executor's environment from the run: only a small allowlist
and **`EVAL_*` variables** reach the child session, and the plugin's real MCP server inherits the
child's environment. Nothing else works — tested and ruled out on 2026-09-22: `CLAUDE_ENV_FILE`
(not passed), a `context.scaffold_script` seeding `<workspace>/.claude/settings.local.json` (the
scaffold itself runs with a minimal env, and the child ignores workspace settings entirely).

So the plugin reads `EVAL_HARMONY_API_TOKEN` / `EVAL_HARMONY_SUPABASE_URL` /
`EVAL_HARMONY_SUPABASE_ANON_KEY` as a fallback when the ordinary name is unset (`src/env.ts`,
B-1036). The ordinary name always wins, so installed plugins are unaffected.

Two credential sets, two shells, **names only — values never in this file or any output**:

- **Step 3 (label fetch) — production, read-only:** `HARMONY_API_TOKEN` = an ordinary production
  token. Leave `HARMONY_SUPABASE_URL` / `HARMONY_SUPABASE_ANON_KEY` unset (production defaults).
- **Step 5 (the suite) — the fixture on staging:** `EVAL_HARMONY_SUPABASE_URL`,
  `EVAL_HARMONY_SUPABASE_ANON_KEY`, `EVAL_HARMONY_API_TOKEN` exported from the env file in (c):
  ```bash
  set -a; . /path/to/your/env-file; set +a
  export EVAL_HARMONY_SUPABASE_URL="$HARMONY_SUPABASE_URL" \
         EVAL_HARMONY_SUPABASE_ANON_KEY="$HARMONY_SUPABASE_ANON_KEY" \
         EVAL_HARMONY_API_TOKEN="$HARMONY_API_TOKEN"
  unset HARMONY_SUPABASE_URL HARMONY_SUPABASE_ANON_KEY HARMONY_API_TOKEN
  ```
  Never run step 3 and step 5 in the same shell without re-exporting between them.

## 2. Verify the preconditions (one read, before anything else)

With the step-5 triple in an ordinary `HARMONY_*` env (not the `EVAL_` twins — this is a direct
probe, not a sandboxed run), read one pool ticket through the plugin's MCP server and confirm:
`get_project` → the fixture key, `mode: opinionated`, `environment.target: staging`;
`get_task <KEY>-818` → `workflow_state: Proposed`, no active brief, `knowledge_reference_count: 0`.
Record what you found on the ticket. A failure here is the founder's to fix, not the eval's.

## 3. Fetch the labels and generate the judges (production, read-only)

From a checkout with `npm install` done:

```bash
node evals/clarify-replay/scripts/fetch-labels.mjs            # all 15, or pass B-818 B-904 …
```

Writes `labels/<TICKET>.json` **and** `cases/<TICKET>/graders/judge.md` — the LLM judge with the
ratified label embedded in its rubric (`scripts/judge-rubric.md` is the committed template). Both
are gitignored: the labels are product-decision content and must never be committed. The script
only ever `SELECT`s from `tasks` and `briefs`.

## 4. Substitute the fixture ids into each case's prompt

`prompt.md` carries `__FIXTURE_TICKET_ID__`. With key `FX` and preserved numbers:

```bash
for d in evals/clarify-replay/cases/B-*/; do n=$(basename "$d"); n=${n#B-}
  sed -i '' "s/__FIXTURE_TICKET_ID__/FX-${n}/g" "$d/prompt.md"; done     # GNU sed: sed -i
```

Working tree only — restore afterwards: `git checkout -- evals/clarify-replay/cases/*/prompt.md`.

## 5. Build, then run

`main` is source-only: `npm run build` first, so the plugin under test has `dist/index.js` (the
MCP server the sandbox spawns). Then, with the step-5 `EVAL_*` exports in this shell:

```bash
claude plugin eval . \
  --eval-dir evals/clarify-replay \
  --mocks off --allow-real-servers \
  --allow-tools 'mcp__plugin_harmony-plugin_harmony__*' \
  --runs 1 \
  --model claude-sonnet-5 \
  --judge-model claude-opus-5 \
  --max-cost-usd 20 \
  --trust-plugin --no-publish \
  --json evals/clarify-replay/results/result.json \
  --report evals/clarify-replay/results/report.html
```

- The MCP server key is `plugin_harmony-plugin_harmony`, so its tools are
  `mcp__plugin_harmony-plugin_harmony__<tool>` — the grant above and both `tool_used` graders use
  that prefix (a wrong prefix silently scores zero).
- `--runs 1`: the fixture is read-and-drafted-against once; there is no reset in v1.
- `--ablation` stays at its default (with-without): the no-plugin arm has no MCP tools and cannot
  touch the board; `related-tickets-queried` is `arm: with-only` and becomes an indicator.
- Each case sets `execution.max_turns: 150` and `timeout_seconds: 1800` — the runner defaults (10
  / 300) cut a clarify off. Hitting either is recorded as a run error.
- Cost: a run whose server fails at spawn costs about $3.50 for 30 runs; a real run costs more.
  If the ceiling trips (exit 2) the partial report still lands — attach it and say it is partial.
- `--keep-temp` preserves `/private/tmp/e-*/out/trace.jsonl` per run for debugging.

## 6. Where the report lands, and what to record

`results/result.json` and `results/report.html` (the directory is gitignored). Attach both to
B-1036 with `attach_file`, then post: the PR head sha the suite ran from, the fixture project id,
`costUsd` and `durationSeconds` from the JSON, the exact invocation, `overallScore` /
`casesPassed` / `meanDelta`, which grader caught what on which ticket, and the honest limits —
single-use fixture, no pre-existing knowledge base in the fixture, `find_related_tickets` sees only
sibling cases, and the judge's window (next section).

## 7. Known limits of the judge

The `llm` judge on `focus: trace` sees the **first 12 and last 12** trace messages. The fresh
brief is the `compose_brief` tool-call input near the end of the run; confirm on one case that it
falls inside that window (open the kept trace). If a run grows long enough that it does not, have
the case's prompt ask the skill to also render the final brief to a workspace file and point the
judge's `focus` at `{ source: file, path: <that file> }`.

## 8. B-1037 — CI wiring: what runs automatically, and what a founder/orchestrator must still do

B-1037 wires this suite into CI as a PR check on `skills/**` / `evals/clarify-replay/**` changes.
The workflow YAML itself is **not** in this repo yet — Edit/Write under `.github/workflows/**` is
denied at the harness level for every build context, so it was written to
`evals/clarify-replay/ci/skill-eval.yml.proposed` (a normal, non-workflow path) and must be
hand-carried into `.github/workflows/skill-eval.yml` by a human. Read that file's own header
comment first — it explains the non-blocking mechanism (NOT `continue-on-error` on the eval step
itself — that would violate AC6) and lists the exact secrets a human must add
(`HARMONY_CLARIFY_EVAL_LABEL_TOKEN`, `ANTHROPIC_API_KEY`).

### 8a. The derived tool inventory + its CI check

`evals/clarify-replay/reference-tool-calls.json` is a COMMITTED, one-time extraction of the 15
tool names the real B-1036 hand-run traces actually called (9 reads + 6 writes — see the file
itself). `evals/clarify-replay/scripts/check-mock-inventory.mjs` diffs it against the mock
directory (`mocks/plugin_harmony-plugin_harmony/*.md`, excluding `_server.md`, `_tools.json`,
`fixtures/`, `.replay/`) and exits non-zero, NAMING every manifest tool with no mock file. It runs
as its own fast CI step before the mocked eval run (no sandbox, no cost). If the clarify skill
starts calling a 16th tool, update `reference-tool-calls.json` by hand (there is no live-trace
re-derivation mechanism — traces are gitignored) and author its mock.

### 8b. Hand-authored mocks for the 9 reads + 6 writes

`evals/clarify-replay/mocks/plugin_harmony-plugin_harmony/*.md` — one file per tool, in the real
`claude plugin eval` mock format (frontmatter `type`/`expect`, body with `{{input.<field>}}`
substitution). The 6 write mocks (`record_decision`, `reference_knowledge`, `compose_brief`,
`start_elicitation`, `file_elicitation_round`, `conclude_elicitation`) are canned-success,
id-bearing stand-ins — enough for the skill's flow to reach `compose_brief`, which every
deterministic grader inspects. The 9 read mocks are mostly STATIC (empty results) because the
isolated FX fixture project is a near-empty board by design (`query_knowledge`, `query_entities`,
`search_tasks`, `list_comments`, `find_related_tickets`, `get_brief`, `get_elicitation`,
`get_project` all return a fixed, generic body) — only `get_task` carries real ticket text, and
even that is currently a GENERIC placeholder ticket, not per-ticket real content (see 8c for why,
and the founder TODO to improve it).

### 8c. Wiring per-ticket `get_task` content (a documented gap, not a bug)

The mock format's two documented substitutions are `{{input.<field>}}` and
`{{file:fixtures/<literal-name>}}` — this build did **not** assume NESTED substitution
(`{{file:fixtures/{{input.task_id}}.json}}`) works, because it could not be verified live (no
`claude plugin eval` access in this build container). So the suite-level `get_task.md` mock
returns one fixed, generic-but-plausible ticket body for every case — good enough for the SMOKE
subset's purpose (catching a skill-prose regression in the frame/ACs/word-budget shape), but not
real per-ticket content.

**Founder/orchestrator TODO, once real `claude plugin eval` access is available:** confirm whether
nested `{{file:...{{input...}}...}}` substitution is supported. If yes, wire
`mocks/plugin_harmony-plugin_harmony/get_task.md` to read
`fixtures/{{input.task_id}}.json` directly. If no, author a per-case override at
`cases/<TICKET>/mocks/plugin_harmony-plugin_harmony/get_task.md` for each of the 15 real cases
(case-local mocks override the suite's file-by-file — see the ticket's own "Mock file format"
notes) pointing at that ticket's own exported fixture.

### 8d. Exporting read fixtures from FX (fixture-export.mjs) — start with a reset

`evals/clarify-replay/scripts/fixture-export.mjs` is a READ-ONLY, founder/orchestrator-run script
(no FX credentials exist in a build container) that exports one stripped JSON fixture per case
ticket into `mocks/plugin_harmony-plugin_harmony/fixtures/` (gitignored). **Before every export
pass**, re-run the fixture SQL (`scratchpad/b1036-fixture.sql`, founder-held) to reset FX — the
B-1036 hand run already wrote briefs, ACs and decisions onto the 15 fixture tickets, so FX is
**not** pre-clarify state today. The script REFUSES (loud, named, non-zero exit) to export any
ticket whose `field_values.gate_slots.clarify` is populated, whose `acceptance_criteria` is
non-empty, or that already has a brief — see `checkTicketIsPreClarify` (unit-tested at
`src/fixture-export-refusal.test.ts`, no live board needed). A REFUSED entry means: reset FX, then
re-run.

```bash
# after resetting FX via scratchpad/b1036-fixture.sql:
HARMONY_SUPABASE_URL=<staging url> HARMONY_SUPABASE_ANON_KEY=<staging anon key> \
  HARMONY_API_TOKEN=<FX token> node evals/clarify-replay/scripts/fixture-export.mjs
```

### 8e. Generating `_tools.json` (optional, not yet generated)

See `mocks/plugin_harmony-plugin_harmony/TOOLS_JSON_TODO.md` — capture the real MCP server's
`tools/list` response during a real (§5) hand-pass run and save it there; delete the TODO file once
done. Its absence does not block a mocked run.

### 8f. Judge calibration: the two control cases (AC2)

Two case directories exist with NO fetchable production ticket of their own —
`cases/ctrl-positive-known-good/` and `cases/ctrl-negative-boundary-flip/`. They calibrate the
**judge**, not the skill: neither touches the Harmony MCP server at all (their `prompt.md` has the
agent copy a pre-seeded `fixtures/fresh-brief.md` verbatim into the workspace via `Read`+`Write`);
their judge (`graders/judge.md`, `focus: { source: file, path: fresh-brief.md }`, gitignored) is
the SAME rubric+label as an ordinary case's judge — only the fresh artifact differs:

- **Positive control**: the fresh artifact IS the source ticket's ratified label, rendered
  verbatim. Expected **PASS** on every check.
- **Negative control**: the fresh artifact is the SAME rendering with one `in_scope` item moved to
  `not_solving` (a genuine boundary miss, per the rubric's own check-2 definition). Expected
  **FAIL, specifically on check 2** (SAME BOUNDARIES) — checks 1/3/4 must still read PASS.

Both cases also carry a second, weight-0 `graders/judge-reasoning.md` grader (same rubric plus an
instruction to name PASS/FAIL per numbered check explicitly) — today's judge votes carry no
per-check reasoning, so this exists to make a run's report legible to a human without re-deriving
it from a bare verdict.

**Generate both cases' fixtures/judge files** (gitignored, exactly like every other case's
`graders/judge.md`) with:

```bash
HARMONY_API_TOKEN=<production token> node evals/clarify-replay/scripts/fetch-labels.mjs --controls B-293
```

(`B-293` — the Test-epic case — is this build's default source ticket; pass a different visual id
to use another already-fetched label instead.)

**AC2's calibration gate, in order:**
1. Run the command above.
2. Run the suite against just the two control cases (`--case ctrl-positive-known-good --case
   ctrl-negative-boundary-flip`, mocked or real — both work, since neither touches the MCP server).
3. Confirm the positive control PASSES and the negative control FAILS on check 2 specifically. If
   either disagrees, the judge/rubric is miscalibrated — fix it before deriving a threshold from
   any other case's score.
4. Only THEN derive `EVAL_SCORE_THRESHOLD` from real scores and consider flipping the check
   `required` in branch protection (a separate, deliberate, post-merge founder action — never part
   of this build; see `evals/clarify-replay/ci/skill-eval.yml.proposed`'s own header).

**Also walk-at-build/verify (plan build notes item 2, carried forward, NOT done here):** the 10
fresh briefs from the original hand run already exist in the traces
(`results/result2.json` `tracePaths` → the last `compose_brief` call per trace) — re-judging THOSE
stored briefs against their labels with the rendered-brief focus (judge calls only, no clarify
runs) is a cheaper, more targeted calibration than a fresh clarify run, and its agreement with the
deterministic graders belongs in the PR that flips this check to required. `results/result2.json`
is gitignored and lives on the orchestrator's machine — not reproducible in a build container.

### 8g. Smoke subset vs full 15

Every PR run (`pull_request` trigger) runs a SMOKE SUBSET of 4-5 cases plus the two control cases,
under a cost ceiling — see the placeholders in `skill-eval.yml.proposed`'s own header (case list,
threshold, cost ceiling — all founder-set at release, not invented in this build). The full 15 runs
on demand via `workflow_dispatch` with `full_suite: true`.

### 8h. Secrets discipline (applies to every step above run in CI)

Every credential the CI workflow needs is a repo secret referenced by NAME only
(`secrets.HARMONY_CLARIFY_EVAL_LABEL_TOKEN`, `secrets.ANTHROPIC_API_KEY`) — the same regime as
`.github/workflows/model-catalog-liveness.yml`. No step ever echoes a token or label text to a log,
the job summary, or an uploaded artifact; `fetch-labels.mjs`'s own stdout is ticket-id +
revision-count only (never the label's content), and the uploaded eval-result artifact is always
the SANITISED copy (see AC4 in the workflow's own comments) — the raw JSON (with full grader
rubrics, i.e. full label content) never leaves the runner.

## 9. Out of scope

Other gates' suites; the KB eval cadence (B-678); creating or resetting the fixture (founder-run
precondition (a)); flipping the CI check to a required, blocking gate (post-merge, post-calibration
founder action — see §8f).

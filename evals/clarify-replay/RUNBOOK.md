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

## 8. Out of scope

CI wiring (B-1037); other gates' suites; the KB eval cadence (B-678); creating or resetting the
fixture (founder-run precondition (a)).

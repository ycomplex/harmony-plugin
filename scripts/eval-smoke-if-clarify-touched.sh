#!/usr/bin/env bash
# B-1082 — the clarify-replay smoke eval as a RELEASE-GATE step, run only when the change can affect
# what the suite measures.
#
# Declared in .harmony/project.yml under release.before_merge and executed by
# `harmony gates run release.before_merge` (src/cli/commands/gates.ts) — inside the worker at the
# release gate, under the plan-included credential the container already runs on
# (CLAUDE_CODE_OAUTH_TOKEN; container/provision.sh unsets an empty ANTHROPIC_API_KEY), or locally by the
# orchestrator before a fast-track record. It replaces the automatic per-PR CI run B-1037 wired
# (retired to workflow_dispatch by this ticket): a real case costs ~$1 on the API key and the check fired
# for every skill change on every push, although the suite only exercises the clarify skill.
#
# WHAT IT DOES
#   1. Path-conditioned: compares HEAD against the merge base with origin/main (falls back to main).
#      If no changed path matches the surfaces the suite measures, it prints why and exits 0 in
#      well under a second. Nothing else runs.
#   2. Otherwise: fetch the smoke labels + judge-calibration controls (evals/clarify-replay/scripts/
#      fetch-labels.mjs — read-only board reads, gitignored output), substitute the fixture ids, run
#      `claude plugin eval --tag smoke` exactly as the retired CI job did, sanitize the result to
#      .harmony/.gate-evidence/eval-score.json (gitignored), print ONE summary line, and FAIL the step on
#      a partial result, a score below EVAL_SCORE_THRESHOLD (default 0.50), or cost above
#      EVAL_MAX_COST_USD (default 5). Substituted prompts are restored on every exit path.
#   3. Never silently green: a missing runner, a failed fetch, a run that produced no result, or an
#      unreadable result all exit non-zero and say so. There is no waiver flag; a genuine capability
#      denial in the worker is the orchestrator's hand-carry (the docs/orchestrating-a-milestone.md
#      recovery-substrate rule), never a skipped step.
#
# ENV (all optional): EVAL_SCORE_THRESHOLD, EVAL_MAX_COST_USD — mirror the repository variables the
# on-demand CI workflow reads; EVAL_SMOKE_DRY_RUN=1 — print the path decision and exit without running
# anything (used by src/eval-smoke-gate.test.ts); EVAL_SMOKE_BASE — override the base ref.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

threshold="${EVAL_SCORE_THRESHOLD:-0.50}"
ceiling="${EVAL_MAX_COST_USD:-5}"
base_ref="${EVAL_SMOKE_BASE:-}"
if [ -z "$base_ref" ]; then
  if git rev-parse --verify -q origin/main >/dev/null; then base_ref=origin/main
  elif git rev-parse --verify -q main >/dev/null; then base_ref=main
  else echo "eval-smoke: FAIL — neither origin/main nor main exists to diff against" >&2; exit 1; fi
fi
merge_base="$(git merge-base "$base_ref" HEAD)"
changed="$(git diff --name-only "$merge_base" HEAD)"

matches=""
while IFS= read -r p; do
  [ -z "$p" ] && continue
  case "$p" in
    skills/harmony-clarify/*|skills/harmony-shared/brief-authoring.md|evals/clarify-replay/*) matches="${matches}${p}"$'\n' ;;
  esac
done <<< "$changed"

if [ -z "$matches" ]; then
  echo "eval-smoke: skipped — no changed path affects what the clarify-replay suite measures (skills/harmony-clarify/**, skills/harmony-shared/brief-authoring.md, evals/clarify-replay/**); base ${base_ref} @ ${merge_base:0:7}"
  exit 0
fi
echo "eval-smoke: running — changed paths the suite measures:"
printf '%s' "$matches" | sed 's/^/  /'

if [ "${EVAL_SMOKE_DRY_RUN:-0}" = "1" ]; then
  echo "eval-smoke: DRY RUN — would run the smoke set (threshold ${threshold}, ceiling \$${ceiling})"
  exit 0
fi

command -v claude >/dev/null 2>&1 || { echo "eval-smoke: FAIL — the claude CLI is not on PATH; the eval runner cannot run (never silently green)" >&2; exit 1; }
[ -n "${HARMONY_API_TOKEN:-}" ] || { echo "eval-smoke: FAIL — HARMONY_API_TOKEN is not set; the label fetch needs a board token" >&2; exit 1; }

restore_prompts() { git checkout -q -- evals/clarify-replay/cases/*/prompt.md 2>/dev/null || true; }
trap restore_prompts EXIT

node evals/clarify-replay/scripts/fetch-labels.mjs B-293 B-818
node evals/clarify-replay/scripts/fetch-labels.mjs --controls B-293
node evals/clarify-replay/scripts/substitute-fixture-ids.mjs B-293 B-818

result=evals/clarify-replay/results/result.json
rm -f "$result"
rc=0
claude plugin eval . \
  --eval-dir evals/clarify-replay \
  --mocks record \
  --runs 1 \
  --model claude-sonnet-5 \
  --judge-model claude-opus-5 \
  --max-cost-usd "$ceiling" \
  --trust-plugin --no-publish \
  --ablation none \
  --threshold 0 \
  --allow-tools Write \
  --scaffold \
  --tag smoke \
  --json "$result" || rc=$?
# exit 2 = the runner hit --max-cost-usd and wrote a PARTIAL result; keep going so the numbers are
# reported, then fail below on `partial`. Any other non-zero exit is a runner failure.
if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then echo "eval-smoke: FAIL — claude plugin eval exited ${rc}" >&2; exit "$rc"; fi
[ -f "$result" ] || { echo "eval-smoke: FAIL — the runner wrote no result file (never silently green)" >&2; exit 1; }

mkdir -p .harmony/.gate-evidence
node evals/clarify-replay/scripts/sanitize-eval-result.mjs "$result" .harmony/.gate-evidence/eval-score.json >/dev/null
if grep -q '## THE RATIFIED LABEL' .harmony/.gate-evidence/eval-score.json; then
  echo "eval-smoke: FAIL — sanitized result still carries label content; refusing to keep it" >&2
  rm -f .harmony/.gate-evidence/eval-score.json; exit 1
fi

node - "$threshold" "$ceiling" <<'NODE'
const fs = require('node:fs');
const [threshold, ceiling] = process.argv.slice(2).map(Number);
const r = JSON.parse(fs.readFileSync('.harmony/.gate-evidence/eval-score.json', 'utf8'));
const a = r.aggregates ?? r;
const line = `eval-smoke: overallScore=${a.overallScore} casesPassed=${a.casesPassed}/${a.casesTotal} costUsd=${r.costUsd} partial=${r.partial} threshold=${threshold} ceiling=${ceiling}`;
console.log(line);
fs.writeFileSync('.harmony/.gate-evidence/eval-score.line', line + '\n');
if (typeof a.overallScore !== 'number' || !(a.casesTotal > 0)) { console.error('eval-smoke: FAIL — no cases were evaluated'); process.exit(1); }
if (r.partial === true) { console.error('eval-smoke: FAIL — partial result (the runner hit its cost ceiling and skipped paid graders); the score is not trustworthy'); process.exit(1); }
if (a.overallScore < threshold) { console.error(`eval-smoke: FAIL — overallScore ${a.overallScore} is below the threshold ${threshold}`); process.exit(1); }
if (typeof r.costUsd === 'number' && r.costUsd > ceiling) { console.error(`eval-smoke: FAIL — costUsd ${r.costUsd} exceeded the ceiling ${ceiling}`); process.exit(1); }
console.log('eval-smoke: PASS');
NODE

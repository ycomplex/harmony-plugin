#!/usr/bin/env node
// B-1036 — clarify-replay eval: label-fetch script.
//
// READ ONLY. This script never writes to the board — it only SELECTs from the `tasks` and
// `briefs` tables and writes its findings to local, gitignored JSON files under
// evals/clarify-replay/labels/. It must never be given write scope and never calls an
// insert/update/delete/RPC-mutation on anything.
//
// Runs against the PRODUCTION board, on purpose (build-detail #1 of B-1036): the ratified v1.4
// clarify labels this suite grades against live on production, not on the not-yet-created
// staging fixture project. Use the ORDINARY HARMONY_* env vars for this step — do NOT point
// HARMONY_SUPABASE_URL / HARMONY_SUPABASE_ANON_KEY at staging here; leave them unset (or set to
// the production values) and pass an ordinary production HARMONY_API_TOKEN. See RUNBOOK.md.
//
// Zero-build by design (an .mjs, not a src/ import): this script must run from a fresh `main`
// checkout where `dist/` may not exist yet (B-1007 — main is source-only). It duplicates the
// small token-exchange shape `src/auth.ts`'s HarmonyAuth class implements, the same way
// scripts/resume-discovery.mjs duplicates isSessionResumeEnabled for the same reason (see that
// file's header). It DOES depend on `@supabase/supabase-js` from node_modules (already an
// ordinary `dependencies` entry in package.json) for the read queries themselves — `npm install`
// in the repo checkout is a documented RUNBOOK precondition.
//
// Usage:
//   HARMONY_API_TOKEN=<production token> node evals/clarify-replay/scripts/fetch-labels.mjs
//   HARMONY_API_TOKEN=<production token> node evals/clarify-replay/scripts/fetch-labels.mjs B-818 B-904
//
// Output: evals/clarify-replay/labels/<TICKET>.json AND evals/clarify-replay/cases/<TICKET>/graders/judge.md
// (both created / overwritten; both gitignored — see .gitignore's B-1036 entries).
//
// B-1037 addition — judge calibration control cases (see RUNBOOK.md "Judge calibration: the two
// control cases"): --controls <SOURCE_TICKET> renders the source ticket's ALREADY-FETCHED label
// (run a normal fetch for it first, or pass its visual id and this mode fetches it too) into the
// two control cases' fixtures/fresh-brief.md (one verbatim, one boundary-flipped) plus their
// graders/judge.md + graders/judge-reasoning.md — all gitignored, same discipline as every other
// case's graders/judge.md.
//   HARMONY_API_TOKEN=<production token> node evals/clarify-replay/scripts/fetch-labels.mjs --controls B-293

import { createClient } from '@supabase/supabase-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABELS_DIR = join(HERE, '..', 'labels');
const CASES_DIR = join(HERE, '..', 'cases');
const RUBRIC = readFileSync(join(HERE, 'judge-rubric.md'), 'utf8');

// Same production defaults src/auth.ts / src/supabase.ts fall back to — this script reads
// production ON PURPOSE (see header), so falling back to the same defaults those files use is
// correct here, not a hazard. An explicit HARMONY_SUPABASE_URL/ANON_KEY still wins if a caller
// sets one (e.g. to point at a self-hosted deployment's own production project).
const SUPABASE_URL = process.env.HARMONY_SUPABASE_URL ?? 'https://eioxsunvhakmelhanmnn.supabase.co';
const SUPABASE_ANON_KEY = process.env.HARMONY_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpb3hzdW52aGFrbWVsaGFubW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NDY3NjksImV4cCI6MjA5MDIyMjc2OX0.SdbpfqRhcB21qWs6XnD6Lsj6AGX2b6tOGV3pg2iJjsw';

// The B-1036 dataset — the ~15 ratified v1.4 tickets selected per the ratified rule (see the
// ticket + the accepted plan). Hardcoded here, same set the case scaffolding under cases/ uses.
const DEFAULT_TICKETS = [
  'B-818', 'B-904', 'B-917', // multi-revision lineages
  'B-293', // Test epic
  'B-847', // Core Task Features epic
  'B-720', 'B-776', 'B-785', 'B-809', 'B-861', 'B-871', 'B-881', 'B-894', 'B-919', 'B-929', // Conductor epic
];

// B-1036: the per-case LLM judge. `claude plugin eval`'s `baseline` grader wants a .jsonl
// transcript, and an `llm` grader can only see the run (last_message / trace / a workspace
// file) plus its own rubric — so the ratified label has to travel INSIDE the rubric. This writes
// cases/<TICKET>/graders/judge.md (gitignored) from the committed rubric template plus the label
// just fetched. focus: trace, because the fresh brief is the compose_brief tool-call input.
function renderLabelSection(label) {
  const c = label.gate_slots_clarify?.content ?? label.gate_slots_clarify ?? {};
  const revs = Array.isArray(label.brief_revisions) ? label.brief_revisions : [];
  const last = revs.length > 0 ? revs[revs.length - 1] : null;
  const doc = last?.doc ?? {};
  const recommend = doc.recommend?.text ?? doc.recommend ?? null;
  const acs = Array.isArray(doc.payload)
    ? doc.payload.filter((x) => x?.write_kind === 'acceptance_criterion').map((x) => x.content)
    : [];
  const list = (xs) => (Array.isArray(xs) && xs.length > 0 ? xs.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : '- (none recorded)');
  const notSolving = Array.isArray(c.not_solving)
    ? c.not_solving.map((x) => (typeof x === 'string' ? x : `${x.item} — lands: ${x.lands ?? '?'}`))
    : [];
  return [
    `## THE RATIFIED LABEL — ${label.ticket}: ${label.title}`,
    '',
    `Fetched from production ${label.fetched_at}; ${revs.length} retained clarify brief revision(s), the LAST is the converged one.`,
    '',
    '### Solving',
    c.solving ?? '(none recorded)',
    '',
    '### In scope',
    list(c.in_scope),
    '',
    '### Not solving',
    list(notSolving),
    '',
    '### Ratified recommendation (last retained revision)',
    recommend ? String(recommend) : '(none recorded)',
    '',
    '### Acceptance criteria the ratified brief filed',
    list(acs),
    '',
  ].join('\n');
}

function writeJudge(label) {
  const dir = join(CASES_DIR, label.ticket, 'graders');
  mkdirSync(dir, { recursive: true });
  const body = ['---', 'type: llm', 'focus: trace', 'weight: 4', '---', RUBRIC.trim(), '', renderLabelSection(label)].join('\n');
  writeFileSync(join(dir, 'judge.md'), `${body}\n`);
}

// ---------------------------------------------------------------------------
// B-1037: judge-calibration control cases
// ---------------------------------------------------------------------------
//
// Two committed case directories (evals/clarify-replay/cases/ctrl-positive-known-good/ and
// .../ctrl-negative-boundary-flip/) exist WITHOUT a fetchable production ticket of their own —
// they calibrate the JUDGE, not the skill. Their "fresh" artifact is a rendering of an EXISTING
// ticket's already-fetched label: verbatim for the positive control (expected PASS on every
// check), with one in_scope/not_solving boundary line moved for the negative control (expected
// FAIL, specifically on check 2 "SAME BOUNDARIES" — see judge-rubric.md's own check numbering).
// Both controls are graded by the IDENTICAL judge+rubric as every other case, generated the same
// way (writeJudge below), pointed at the SAME source label — only the fresh artifact differs.

const CONTROL_CASES = [
  { dir: 'ctrl-positive-known-good', flipBoundary: false },
  { dir: 'ctrl-negative-boundary-flip', flipBoundary: true },
];

/** Render a markdown "fresh brief" from a label — the same shape a real clarify run's compose_brief
 *  would produce for its frame + recommend + ACs, but built straight from the ratified label's own
 *  content (the positive control's whole point: there is no daylight between "fresh" and "label").
 *  `flipBoundary`: move the LAST in_scope item to not_solving (a genuine boundary miss per the
 *  rubric's own check 2 definition — "something the label excluded that the fresh brief now
 *  includes, or the reverse, is a boundary miss") — problem statement, recommendation and ACs are
 *  left untouched, so only check 2 should fail. */
export function renderFreshBriefMarkdown(label, { flipBoundary = false } = {}) {
  const c = label.gate_slots_clarify?.content ?? label.gate_slots_clarify ?? {};
  const revs = Array.isArray(label.brief_revisions) ? label.brief_revisions : [];
  const last = revs.length > 0 ? revs[revs.length - 1] : null;
  const doc = last?.doc ?? {};
  const recommend = doc.recommend?.text ?? doc.recommend ?? null;
  const acs = Array.isArray(doc.payload)
    ? doc.payload.filter((x) => x?.write_kind === 'acceptance_criterion').map((x) => x.content)
    : [];
  let inScope = Array.isArray(c.in_scope) ? [...c.in_scope] : [];
  let notSolving = Array.isArray(c.not_solving)
    ? c.not_solving.map((x) => (typeof x === 'string' ? x : `${x.item} — lands: ${x.lands ?? '?'}`))
    : [];

  if (flipBoundary && inScope.length > 0) {
    const moved = inScope[inScope.length - 1];
    inScope = inScope.slice(0, -1);
    const movedText = typeof moved === 'string' ? moved : JSON.stringify(moved);
    notSolving = [...notSolving, `${movedText} — lands: n/a (B-1037 negative-control boundary flip)`];
  }

  const list = (xs) => (xs.length > 0 ? xs.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : '- (none)');

  return [
    `# Fresh clarify brief (judge-calibration control, source: ${label.ticket})`,
    '',
    flipBoundary
      ? '_B-1037 negative control: one in_scope item has been deliberately moved to not_solving relative to the source label — every other section is unchanged._'
      : '_B-1037 positive control: this section-for-section matches the source label verbatim — there is no daylight for the judge to catch._',
    '',
    '## Solving',
    c.solving ?? '(none)',
    '',
    '## In scope',
    list(inScope),
    '',
    '## Not solving',
    list(notSolving),
    '',
    '## Recommend',
    recommend ? String(recommend) : '(none)',
    '',
    '## Acceptance criteria',
    list(acs),
    '',
  ].join('\n');
}

/** The (near-)weightless reasoning grader (build notes item: "today's judge votes have none" — this grader
 *  forces the judge to name PASS/FAIL per numbered check explicitly, even when the overall vote is
 *  PASS, so a human reviewing a run can see WHICH check(s) drove a given score without re-deriving
 *  it from a bare verdict). Barely affects the score (weight: 0.1 vs the judge's 4 — the runner
 *  rejects a literal 0) — it exists to make a failing run's
 *  report legible, not to grade it a second time. */
function renderReasoningRubric() {
  return [
    RUBRIC.trim(),
    '',
    '## Additionally (B-1037 reasoning grader)',
    '',
    'Regardless of your overall PASS/FAIL verdict above, ALSO output one line per numbered check',
    '(1 SAME PROBLEM STATEMENT, 2 SAME BOUNDARIES, 3 SAME RECOMMENDATION, 4 NO INVENTED ACS) in the',
    'exact form `CHECK <n> (<name>): PASS|FAIL — <one-sentence reason>`, even for a check that',
    'passed. This is a NAMED, per-check reasoning trail — never collapse it into a single overall',
    'sentence.',
  ].join('\n');
}

function writeControlJudge(caseDir, label, fileName, rubricBody) {
  const dir = join(CASES_DIR, caseDir, 'graders');
  mkdirSync(dir, { recursive: true });
  const body = [
    '---',
    'type: llm',
    'focus:',
    '  source: file',
    '  path: fresh-brief.md',
    // weight 0.1, not 0: the runner's case schema requires every grader weight to be > 0 (a
    // generated `weight: 0` failed CI's case load on 2026-09-24 — "graders.1.weight: Number must
    // be greater than 0"). At 0.1 against the judge's 4 it is a rounding term on the score; its
    // purpose is still the per-check reasoning trail, not a second verdict.
    fileName === 'judge.md' ? 'weight: 4' : 'weight: 0.1',
    '---',
    rubricBody,
    '',
    renderLabelSection(label),
  ].join('\n');
  writeFileSync(join(dir, fileName), `${body}\n`);
}

/** Render both control cases' fixtures/fresh-brief.md + graders/judge.md + graders/judge-reasoning.md
 *  from ONE already-fetched source label. Call fetchOneLabel (or a prior ordinary run) for
 *  `sourceTicket` before this — it reads labels/<SOURCE>.json, it does not fetch it itself, so a
 *  missing label file is a loud, named failure (never a silent skip). */
export function writeControlCases(sourceTicket, label) {
  for (const { dir, flipBoundary } of CONTROL_CASES) {
    const fixturesDir = join(CASES_DIR, dir, 'fixtures');
    mkdirSync(fixturesDir, { recursive: true });
    writeFileSync(join(fixturesDir, 'fresh-brief.md'), renderFreshBriefMarkdown(label, { flipBoundary }));
    writeControlJudge(dir, label, 'judge.md', RUBRIC.trim());
    writeControlJudge(dir, label, 'judge-reasoning.md', renderReasoningRubric());
    console.log(`OK   controls <- ${sourceTicket} -> cases/${dir}/{fixtures/fresh-brief.md, graders/judge.md, graders/judge-reasoning.md}`);
  }
}

function parseVisualId(id) {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(id.trim());
  if (!m) throw new Error(`Not a visual id: "${id}" (expected e.g. "B-818")`);
  return { key: m[1].toUpperCase(), taskNumber: parseInt(m[2], 10) };
}

async function exchangeToken(apiToken) {
  const endpoint = '/functions/v1/auth-token';
  const res = await fetch(`${SUPABASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ token: apiToken }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return res.json(); // { access_token, expires_in, project_id }
}

async function main() {
  const apiToken = process.env.HARMONY_API_TOKEN;
  if (!apiToken) {
    console.error('HARMONY_API_TOKEN is not set. Use an ORDINARY PRODUCTION token — see RUNBOOK.md.');
    process.exit(1);
  }

  const rawArgs = process.argv.slice(2);
  const controlsIdx = rawArgs.indexOf('--controls');
  const controlsMode = controlsIdx !== -1;
  // B-1037: --controls <SOURCE_TICKET> is consumed here so it never lands in `tickets` below — the
  // rest of the loop (fetch + writeJudge) runs unchanged for the one source ticket either way, and
  // writeControlCases fires ONLY after that ticket's label is confirmed written.
  const controlsSourceTicket = controlsMode ? (rawArgs[controlsIdx + 1] ?? 'B-293') : null;
  const tickets = controlsMode
    ? [controlsSourceTicket]
    : rawArgs.length > 0
    ? rawArgs
    : DEFAULT_TICKETS;

  const { access_token: accessToken, project_id: projectId } = await exchangeToken(apiToken);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: () => Promise.resolve(accessToken),
    auth: { persistSession: false, autoRefreshToken: false },
  });

  mkdirSync(LABELS_DIR, { recursive: true });

  let failures = 0;
  for (const visualId of tickets) {
    try {
      const { key, taskNumber } = parseVisualId(visualId);
      // READ ONLY — .select() calls only, never .insert()/.update()/.delete()/a mutating .rpc().
      const { data: task, error: taskErr } = await client
        .from('tasks')
        .select('id, task_number, title, workflow_state, field_values')
        .eq('project_id', projectId)
        .eq('task_number', taskNumber)
        .single();
      if (taskErr || !task) {
        throw new Error(`No task ${key}-${taskNumber} in project ${projectId}: ${taskErr?.message ?? 'not found'}`);
      }

      const gateSlotsClarify = task.field_values?.gate_slots?.clarify ?? null;

      // Retained brief revisions (B-843), where present — every 'clarification-draft' brief this
      // task ever carried, oldest first, so a multi-revision lineage (B-818/904/917) reads as a
      // history. READ ONLY. Degrades to null on a DB predating brief retention — never throws.
      let briefRevisions = null;
      {
        const { data, error } = await client
          .from('briefs')
          .select('id, reason, doc, status, iteration, resolved_command, resolved_detail, resolved_at, created_at')
          .eq('task_id', task.id)
          .eq('reason', 'clarification-draft')
          .order('created_at', { ascending: true });
        if (!error) briefRevisions = data ?? [];
        // else: leave null — this DB's `briefs` table (or one of the selected columns) is
        // unavailable; the gate_slots label above is still the primary source of truth (B-867).
      }

      const label = {
        ticket: `${key}-${taskNumber}`,
        task_id: task.id,
        title: task.title,
        workflow_state: task.workflow_state,
        fetched_at: new Date().toISOString(),
        source: 'production',
        gate_slots_clarify: gateSlotsClarify,
        brief_revisions: briefRevisions,
      };

      writeFileSync(join(LABELS_DIR, `${key}-${taskNumber}.json`), `${JSON.stringify(label, null, 2)}\n`);
      writeJudge(label);
      console.log(`OK   ${key}-${taskNumber} -> labels/${key}-${taskNumber}.json (${briefRevisions?.length ?? 0} retained brief revision(s))`);

      // B-1037: --controls consumes this SAME just-fetched label (never a second fetch) to render
      // the two judge-calibration control cases — see writeControlCases's own header comment.
      if (controlsMode) writeControlCases(visualId, label);
    } catch (err) {
      failures += 1;
      console.error(`FAIL ${visualId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${tickets.length} ticket(s) failed — see above.`);
    process.exit(1);
  }
  if (controlsMode) {
    console.log(`\nWrote the 2 control case(s) from source ${controlsSourceTicket} to cases/ctrl-*/.`);
  } else {
    console.log(`\nWrote ${tickets.length} label file(s) to ${LABELS_DIR}`);
  }
}

// B-1037: guarded like fixture-export.mjs / check-mock-inventory.mjs — this file is now
// IMPORTABLE (renderFreshBriefMarkdown / writeControlCases are exported for reuse and for unit
// testing), and main() makes a REAL network call against PRODUCTION the moment it runs. An
// unguarded top-level call would fire on a bare `import` too, not just a CLI invocation — this
// guard keeps it CLI-only, matching every other script in this suite.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}

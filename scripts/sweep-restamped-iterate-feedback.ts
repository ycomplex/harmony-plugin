#!/usr/bin/env node
// B-903 — null out `briefs.iterate_feedback` on revisions that a send-back never caused.
//
// THE DEFECT: `compose_brief`'s description told callers to pass `iterate_feedback` "on every round-2+
// call", which they read literally — so the last feedback a composer happened to know about was
// re-stamped onto every subsequent revision of the lineage, including revisions nobody sent back (a
// self-redraft, a rebase, an answer to an accept-with-remark, the recompose after a concluded
// `discuss`). Storage and rendering were always correct; only the caller instruction was wrong. That
// instruction is fixed in `src/tools/briefs.ts`; this script cleans up the rows it already produced.
//
// THE RULE, mechanically: within one lineage, ordered by iteration, a revision whose `iterate_feedback`
// is BYTE-IDENTICAL and non-null to its IMMEDIATE PREDECESSOR's is a re-stamp and is nulled. The FIRST
// revision carrying a given value keeps it — that is the revision the send-back actually caused.
//
// PLAN FROM THE SNAPSHOT, THEN WRITE. Every comparison is against the value the predecessor had when the
// snapshot was READ, never a post-write value. Comparing against live rows would silently half-correct a
// 3-deep re-stamp run: nulling revision 3 makes revision 4 stop matching its predecessor, and revision 4
// keeps the words it never earned. The snapshot is read ONCE, up front, for exactly this reason.
//
// NON-CONTIGUOUS REAPPEARANCE IS NOT SWEPT. If a value reappears after a gap (iter2 = X, iter3 = null,
// iter4 = X), that is NOT mechanically a re-stamp — the human may genuinely have sent the same words
// back twice. Those rows are printed under their own banner for human review and are never auto-nulled.
//
// Rows with NO `lineage_id` are singleton lineages: they have no predecessor, so they are structurally
// unsweepable (there is nothing to have been re-stamped FROM). They are counted and skipped.
//
// SIDE EFFECT OF EVERY WRITE: the `update_briefs_updated_at` BEFORE UPDATE trigger moves `updated_at` on
// every swept row. The sweep is otherwise invisible — `doc`, `content`, `status` and `iteration` are
// untouched, and no brief changes its rendered bytes.
//
// USAGE — no build step is wired for this one-off maintenance script; bundle it ad hoc with esbuild
// (already a devDependency) rather than adding a permanent dist target for a script meant to run once
// per defect, not on every build:
//
//   npx esbuild scripts/sweep-restamped-iterate-feedback.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/sweep-b903.mjs
//   node /tmp/sweep-b903.mjs             # dry run — prints the plan per lineage, writes NOTHING
//   node /tmp/sweep-b903.mjs --apply     # executes the planned nulls
//
// Idempotent by construction: a second run replans from a fresh snapshot, where every swept row is now
// null and therefore matches nothing, and finds zero to do.
//
// Requires HARMONY_API_TOKEN (and optionally HARMONY_SUPABASE_URL / HARMONY_SUPABASE_ANON_KEY) in the
// environment — the SAME credentials the CLI/MCP server use. Every write goes through
// `clearRevisionIterateFeedback` (src/tools/briefs.ts) — the plugin's normal write plane — never raw SQL.

import { HarmonyAuth } from '../src/auth.js';
import { createAuthenticatedClient } from '../src/supabase.js';
import { clearRevisionIterateFeedback } from '../src/tools/briefs.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** One brief revision, exactly as the snapshot read it. Nothing here is ever re-read. */
interface RevisionRow {
  id: string;
  task_id: string | null;
  lineage_id: string | null;
  iteration: number | null;
  status: string | null;
  iterate_feedback: string | null;
  created_at: string | null;
}

const SNAPSHOT_COLS = 'id, task_id, lineage_id, iteration, status, iterate_feedback, created_at';
const PAGE = 1000;

type Action = 'NULL' | 'KEEP' | 'REPORT';

interface PlannedRow {
  row: RevisionRow;
  action: Action;
}

function parseArgs(argv: string[]) {
  return { apply: argv.includes('--apply') };
}

function truncate(value: string | null, max = 64): string {
  if (value === null) return '(null)';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? `"${flat}"` : `"${flat.slice(0, max)}…"`;
}

/**
 * SHAPE THAT WORKED: the `tasks!inner(project_id)` embedded-filter form. PostgREST scopes the briefs
 * rows by the parent task's project in one query, so the snapshot is a straight paged read. The chunked
 * fallback below exists because that shape is rejected on some deployments (no FK exposed to PostgREST,
 * or RLS blocking the embed); it enumerates the project's task ids and pages `.in('task_id', ids)`.
 */
async function snapshotByInnerJoin(client: SupabaseClient, projectId: string): Promise<RevisionRow[]> {
  const out: RevisionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('briefs')
      .select(`${SNAPSHOT_COLS}, tasks!inner(project_id)`)
      .eq('tasks.project_id', projectId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as RevisionRow[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Fallback: enumerate the project's task ids, then page `.in('task_id', chunk)` over them. */
async function snapshotByTaskIds(client: SupabaseClient, projectId: string): Promise<RevisionRow[]> {
  const taskIds: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('tasks')
      .select('id')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`enumerating task ids failed: ${error.message}`);
    const rows = (data ?? []) as { id: string }[];
    taskIds.push(...rows.map((r) => r.id));
    if (rows.length < PAGE) break;
  }

  const out: RevisionRow[] = [];
  const CHUNK = 200; // keeps the `in(...)` URL well under any gateway length limit
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const chunk = taskIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from('briefs')
        .select(SNAPSHOT_COLS)
        .in('task_id', chunk)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`reading briefs for a task chunk failed: ${error.message}`);
      const rows = (data ?? []) as unknown as RevisionRow[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

/** ONE read of every brief row in the project. Try the embedded filter; fall back to chunked task ids. */
async function readSnapshot(client: SupabaseClient, projectId: string): Promise<{ rows: RevisionRow[]; shape: string }> {
  try {
    const rows = await snapshotByInnerJoin(client, projectId);
    return { rows, shape: "tasks!inner(project_id) embedded filter" };
  } catch (err) {
    console.log(`NOTE  the tasks!inner(project_id) filter was rejected (${(err as Error).message}) — falling back to chunked task ids.`);
    const rows = await snapshotByTaskIds(client, projectId);
    return { rows, shape: 'chunked .in(task_id, ids)' };
  }
}

/** Group into lineages, ordered by `iteration` ascending with `created_at` as the tie-break. */
function groupLineages(rows: RevisionRow[]): Map<string, RevisionRow[]> {
  const groups = new Map<string, RevisionRow[]>();
  for (const row of rows) {
    if (!row.lineage_id) continue; // singleton — no predecessor, structurally unsweepable
    const list = groups.get(row.lineage_id) ?? [];
    list.push(row);
    groups.set(row.lineage_id, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const ia = a.iteration ?? 0;
      const ib = b.iteration ?? 0;
      if (ia !== ib) return ia - ib;
      return (a.created_at ?? '').localeCompare(b.created_at ?? '');
    });
  }
  return groups;
}

/**
 * Plan ONE lineage from the snapshot. Every comparison reads `ordered[i - 1].iterate_feedback` — the
 * SNAPSHOT value — so a run of N identical stamps yields N-1 nulls, not one.
 */
function planLineage(ordered: RevisionRow[]): PlannedRow[] {
  const planned: PlannedRow[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i];
    if (i === 0 || row.iterate_feedback === null) {
      planned.push({ row, action: 'KEEP' });
      continue;
    }
    const predecessor = ordered[i - 1].iterate_feedback; // snapshot value, never a post-write one
    if (predecessor !== null && predecessor === row.iterate_feedback) {
      planned.push({ row, action: 'NULL' });
      continue;
    }
    // Not a contiguous repeat. If this exact value already appeared EARLIER in the lineage, it has come
    // back after a gap — which is not mechanically a re-stamp (the human may have said the same thing
    // twice). Report it; never null it.
    const seenEarlier = ordered.slice(0, i).some((r) => r.iterate_feedback !== null && r.iterate_feedback === row.iterate_feedback);
    planned.push({ row, action: seenEarlier ? 'REPORT' : 'KEEP' });
  }
  return planned;
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const apiToken = process.env.HARMONY_API_TOKEN;
  if (!apiToken) {
    console.error('HARMONY_API_TOKEN is required (same credential the CLI/MCP server use).');
    process.exit(1);
  }

  const auth = new HarmonyAuth(apiToken);
  const client = await createAuthenticatedClient(auth);
  const projectId = auth.getProjectId();

  console.log(`Mode: ${apply ? 'APPLY (writes via clearRevisionIterateFeedback)' : 'DRY RUN (no writes)'}`);
  console.log(`Project: ${projectId}\n`);

  const { rows, shape } = await readSnapshot(client, projectId);
  const singletons = rows.filter((r) => !r.lineage_id).length;
  const lineages = groupLineages(rows);
  console.log(`Snapshot: ${rows.length} brief rows via ${shape} — ${lineages.size} lineages, ${singletons} singleton row(s) with no lineage_id (skipped: no predecessor).\n`);

  const toNull: RevisionRow[] = [];
  const nonContiguous: Array<{ lineage: string; row: RevisionRow }> = [];
  let affectedLineages = 0;

  for (const [lineageId, ordered] of [...lineages.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const planned = planLineage(ordered);
    const interesting = planned.filter((p) => p.action !== 'KEEP');
    if (!interesting.length) continue;
    affectedLineages++;

    const task = ordered[0]?.task_id ?? '(unknown task)';
    console.log(`LINEAGE ${lineageId}  (task ${task})`);
    for (const { row, action } of planned) {
      console.log(`  iter ${String(row.iteration ?? '?').padStart(2)}  ${String(row.status ?? '?').padEnd(11)}  ${action.padEnd(6)}  ${truncate(row.iterate_feedback)}`);
    }
    console.log('');

    for (const { row, action } of planned) {
      if (action === 'NULL') toNull.push(row);
      if (action === 'REPORT') nonContiguous.push({ lineage: lineageId, row });
    }
  }

  if (nonContiguous.length) {
    console.log('══════════════════════════════════════════════════════════════════════════════════');
    console.log('NON-CONTIGUOUS REAPPEARANCE — NOT SWEPT, FOR HUMAN REVIEW');
    console.log('The same feedback reappears in the lineage after a gap. That is not mechanically a');
    console.log('re-stamp — the human may genuinely have sent the same words back twice. Left alone.');
    console.log('══════════════════════════════════════════════════════════════════════════════════');
    for (const { lineage, row } of nonContiguous) {
      console.log(`  ${lineage}  iter ${row.iteration ?? '?'}  brief ${row.id}  ${truncate(row.iterate_feedback)}`);
    }
    console.log('');
  }

  console.log(`Totals: ${lineages.size} lineages scanned, ${affectedLineages} affected, ${toNull.length} row(s) to null, ${nonContiguous.length} non-contiguous flagged.`);

  if (apply) {
    for (const row of toNull) {
      await clearRevisionIterateFeedback(client, row.id);
      console.log(`  -> nulled ${row.id} (iter ${row.iteration ?? '?'})`);
    }
    console.log(`\nApplied: ${toNull.length} row(s) nulled.`);
  } else if (toNull.length > 0) {
    console.log('\nDry run only — re-run with --apply to write these changes.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

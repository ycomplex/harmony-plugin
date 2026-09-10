#!/usr/bin/env node
// B-977 Script B — DRY-RUN ONLY. Audits Accepted technical-design decisions in the BIS dogfood
// project for NULL `realization` and prints which rows WOULD be stamped 'agreed' (decided-not-
// yet-built) if a human later chooses to apply it. NEVER executes a write — database mutations on
// this project are founder-held (per the B-977 ticket's guardrail). This script has NO --apply flag
// and NO write path at all.
//
// TARGET: the BIS dogfood project, specifically. The token you authenticate with
// (HARMONY_API_TOKEN) determines which project this runs against; this script refuses to proceed
// unless that project's key is literally "BIS".
//
// FIXED 2026-09-10 (verify-gate iterate, round 3): the original version hardcoded
// `TARGET_TICKETS = ['TH-2', 'TH-3']` and tried to resolve them as visual IDs via resolveTaskId —
// which validates a visual ID's prefix against the AUTHENTICATED project's key, so 'TH-2'/'TH-3'
// could never resolve under a 'BIS'-scoped token. That constant was wrong, not the project guard:
// per B-798's clarified-intent knowledge entry ("TH-2/TH-3 dogfood conductions produced two concrete
// defects"), TH-2 and TH-3 name the two DOGFOOD CONDUCTION RUNS that surfaced this bug, not ticket
// visual IDs — there is no ticket 'TH-2' or 'TH-3' to resolve. Since nothing enforced the
// realization stamp before this same ticket's fix, every Accepted technical-design decision made in
// the BIS project prior to the fix is a candidate, not just the two runs that happened to surface
// it — so this script now audits ALL of them project-wide instead of resolving fixed visual IDs.
// This is evidence-based (cf. the knowledge entry cited above), not a guess about which specific
// tickets TH-2/TH-3 pointed at; it also structurally can't repeat the original defect, since it
// never resolves a ticket visual ID at all.
//
// USAGE (no build step wired for this one-off maintenance script — bundle ad hoc):
//   npx esbuild scripts/backfill/b977-stamp-null-realization-dry-run.ts --bundle --platform=node \
//     --format=esm --outfile=/tmp/b977-stamp-realization-dry-run.mjs
//   node /tmp/b977-stamp-realization-dry-run.mjs
//
// Requires HARMONY_API_TOKEN (and optionally HARMONY_SUPABASE_URL / HARMONY_SUPABASE_ANON_KEY) in
// the environment, scoped to the BIS dogfood project — the same credentials the CLI/MCP server use.
// A human who agrees with the printed plan applies it by hand via `update_knowledge_entry` (entry_id,
// realization: 'agreed') — this script performs no write of any kind.

import { HarmonyAuth } from '../../src/auth.js';
import { createAuthenticatedClient } from '../../src/supabase.js';
import { getProject } from '../../src/tools/project.js';
import { getWorkspaceId } from '../../src/tools/knowledge.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const EXPECTED_PROJECT_KEY = 'BIS';

interface DecisionRow {
  id: string;
  title: string;
  status: string;
  realization: string | null;
  source_task_id: string | null;
  created_at: string;
}

async function findAcceptedTechnicalDesignDecisions(
  client: SupabaseClient,
  workspaceId: string,
  projectId: string,
): Promise<DecisionRow[]> {
  const { data, error } = await client
    .from('knowledge_decisions')
    .select('id, title, status, realization, source_task_id, created_at')
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .eq('type', 'technical-design')
    .eq('status', 'Accepted');
  if (error) throw new Error(`decision lookup failed: ${error.message}`);
  return (data ?? []) as DecisionRow[];
}

async function resolveVisualId(
  client: SupabaseClient,
  taskId: string,
  projectKey: string,
): Promise<string> {
  const { data, error } = await client.from('tasks').select('task_number').eq('id', taskId).maybeSingle();
  if (error || !data) return `(unresolvable task ${taskId})`;
  return `${projectKey}-${(data as { task_number: number }).task_number}`;
}

async function main() {
  const apiToken = process.env.HARMONY_API_TOKEN;
  if (!apiToken) {
    console.error('HARMONY_API_TOKEN is required (same credential the CLI/MCP server use), scoped to the BIS dogfood project.');
    process.exit(1);
  }

  const auth = new HarmonyAuth(apiToken);
  const client = await createAuthenticatedClient(auth);
  const projectId = auth.getProjectId();

  const project = await getProject(client, projectId);
  if (project.key.toUpperCase() !== EXPECTED_PROJECT_KEY) {
    console.error(
      `Refusing to run: this token is scoped to project "${project.key}", not "${EXPECTED_PROJECT_KEY}" ` +
      `(the BIS dogfood project this script targets). Re-authenticate with a BIS-scoped token if that is ` +
      `really what you intend.`,
    );
    process.exit(1);
  }

  const workspaceId = await getWorkspaceId(client, projectId);

  console.log(`DRY RUN ONLY — no writes. Project: ${project.name} (${project.key}, ${projectId}).\n`);

  const decisions = await findAcceptedTechnicalDesignDecisions(client, workspaceId, projectId);

  // Fail-loud guard: this query has no ticket-resolution step to fail silently on (the original
  // defect's failure mode), but an RLS/permission problem can still return an empty result set
  // indistinguishable from "genuinely no technical-design decisions exist yet". Surface the total
  // so a human can tell the two apart, instead of a bare, possibly-misleading zero.
  if (decisions.length === 0) {
    console.log(
      'ABORTED: found 0 Accepted technical-design decisions of ANY realization value in this project. ' +
      'This is almost certainly a permission/RLS problem (a BIS-scoped token should see prior technical- ' +
      'design decisions), not evidence the backfill is already done. Verify token scope before trusting ' +
      'this result.',
    );
    process.exit(1);
  }

  let plannedTotal = 0;
  let alreadyStamped = 0;

  for (const d of decisions) {
    if (d.realization === null) {
      const visualId = d.source_task_id ? await resolveVisualId(client, d.source_task_id, project.key) : '(no source ticket)';
      console.log(`  PLAN (not executed): stamp realization='agreed' on ${d.id} — "${d.title}" (ticket=${visualId}, created_at=${d.created_at})`);
      console.log(`    -> update_knowledge_entry({ entry_id: '${d.id}', realization: 'agreed' })`);
      plannedTotal++;
    } else {
      alreadyStamped++;
    }
  }

  console.log(`\n${decisions.length} Accepted technical-design decision(s) found; ${alreadyStamped} already carry a non-NULL realization.`);
  console.log(`Total: ${plannedTotal} decision(s) would be stamped realization='agreed'.`);
  console.log('\nNothing was written. Review the plan above, then run the printed update_knowledge_entry call(s) by hand (MCP tool or CLI) if you agree.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

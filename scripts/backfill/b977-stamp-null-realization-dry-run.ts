#!/usr/bin/env node
// B-977 Script B — DRY-RUN ONLY. Audits TH-2 and TH-3's Accepted technical-design decisions in the
// BIS dogfood project for NULL `realization` and prints which rows WOULD be stamped 'agreed'
// (decided-not-yet-built) if a human later chooses to apply it. NEVER executes a write — database
// mutations on this project are founder-held (per the B-977 ticket's guardrail). This script has NO
// --apply flag and NO write path at all.
//
// TARGET: the BIS dogfood project, specifically. The token you authenticate with
// (HARMONY_API_TOKEN) determines which project this runs against; this script refuses to proceed
// unless that project's key is literally "BIS" AND both TH-2/TH-3 resolve within it (resolveTaskId
// itself rejects a visual-id prefix that doesn't match the token's project key — a second,
// independent guard against pointing this at the wrong project).
//
// WHY these two tickets specifically: TH-2/TH-3 are the tickets named in the B-977 ticket body as
// carrying Accepted technical-design decisions from before this same ticket's realization-default
// fix (recordDecision now defaults realization='agreed' for design-decision types going forward —
// this script is the backfill for decisions authored BEFORE that default existed).
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
import { resolveTaskId } from '../../src/tools/resolve-task-id.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const TARGET_TICKETS = ['TH-2', 'TH-3'];
const EXPECTED_PROJECT_KEY = 'BIS';

interface DecisionRow {
  id: string;
  title: string;
  type: string;
  status: string;
  realization: string | null;
  source_task_id: string | null;
  created_at: string;
}

async function findAcceptedTechnicalDesignDecisions(
  client: SupabaseClient,
  taskId: string,
): Promise<DecisionRow[]> {
  const { data, error } = await client
    .from('knowledge_decisions')
    .select('id, title, type, status, realization, source_task_id, created_at')
    .eq('source_task_id', taskId)
    .eq('type', 'technical-design')
    .eq('status', 'Accepted');
  if (error) throw new Error(`decision lookup failed for task ${taskId}: ${error.message}`);
  return (data ?? []) as DecisionRow[];
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

  console.log(`DRY RUN ONLY — no writes. Project: ${project.name} (${project.key}, ${projectId}).\n`);

  let plannedTotal = 0;

  for (const visualId of TARGET_TICKETS) {
    let taskId: string;
    try {
      taskId = await resolveTaskId(client, projectId, visualId);
    } catch (err) {
      console.error(`  Could not resolve ${visualId} in project ${project.key}: ${(err as Error).message}`);
      continue;
    }

    const decisions = await findAcceptedTechnicalDesignDecisions(client, taskId);
    console.log(`── ${visualId} (${taskId}) — ${decisions.length} Accepted technical-design decision(s) ──`);

    if (decisions.length === 0) {
      console.log('  (none found)\n');
      continue;
    }

    for (const d of decisions) {
      if (d.realization === null) {
        console.log(`  PLAN (not executed): stamp realization='agreed' on ${d.id} — "${d.title}" (created_at=${d.created_at})`);
        console.log(`    -> update_knowledge_entry({ entry_id: '${d.id}', realization: 'agreed' })`);
        plannedTotal++;
      } else {
        console.log(`  SKIP — ${d.id} "${d.title}" already carries realization='${d.realization}' (not NULL).`);
      }
    }
    console.log('');
  }

  console.log(`Total: ${plannedTotal} decision(s) would be stamped realization='agreed'.`);
  console.log('\nNothing was written. Review the plan above, then run the printed update_knowledge_entry call(s) by hand (MCP tool or CLI) if you agree.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

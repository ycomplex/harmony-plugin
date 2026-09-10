#!/usr/bin/env node
// B-977 Script B — DRY-RUN ONLY. Audits Accepted technical-design decisions in the Team Health (TH)
// project for NULL `realization` and prints which rows WOULD be stamped 'agreed' (decided-not-
// yet-built) if a human later chooses to apply it. NEVER executes a write — database mutations on
// this project are founder-held (per the B-977 ticket's guardrail). This script has NO --apply flag
// and NO write path at all.
//
// TARGET: the Team Health (TH) project, on STAGING — not BIS/prod. AC5 names two specific tickets,
// TH-2 and TH-3 ("Decide the architecture" / "Decide the repo & workspace topology") — both are
// real tickets in TH, and both already carry realization='agreed' (confirmed live 2026-09-10; see
// the B-977 verify-gate round-4 brief). The defect class AC5 was written to catch is nonetheless
// live elsewhere in the SAME project: a project-wide, read-only audit of TH found 15 Accepted
// technical-design decisions, 7 of them still NULL. So this script audits ALL Accepted
// technical-design decisions in TH project-wide, not two fixed visual IDs — the AC5 disposition
// (whether stamping the other 7 is in scope for this ticket, or a separate concern) is a founder
// choice surfaced on the verify brief, not something this script decides.
//
// The token you authenticate with (HARMONY_API_TOKEN) determines which project this runs against;
// this script refuses to proceed unless that project's key is literally "TH", AND unless
// HARMONY_SUPABASE_URL is explicitly set to the STAGING instance (this repo's plugin defaults to
// PROD when that variable is unset, which is the wrong instance for TH entirely — see USAGE below).
//
// SCOPE GUARD — do not widen the query beyond `type='technical-design' AND status='Accepted'`. TH
// carries 51 Accepted decisions with NULL realization project-wide; 44 of those are `specification`/
// `convention` rows, which are NULL BY DESIGN (this ticket's own accepted design only stamps
// product/technical/ux-ui design types) and B-551's intent-emit trigger deliberately relies on NULL
// for `specification`-typed intent rows since B-671 — stamping those would break it. The query below
// filters on `type` and `status` server-side and inspects `realization` only in memory, precisely so
// it can never regress into a bare `realization IS NULL` sweep.
//
// FIXED 2026-09-10 (verify-gate iterate, round 3 -> round 4): round 3 shipped believing TH-2/TH-3
// named the two dogfood CONDUCTION RUNS that surfaced the original bug rather than ticket visual IDs,
// and retargeted this script at the BIS project on that (wrong) premise. A live, read-only audit
// against the real database (round 4) showed TH-2 and TH-3 ARE tickets — in the Team Health project,
// on STAGING, not BIS on prod — and both already have realization='agreed'. Round 3's "no ticket
// TH-2/TH-3 exists" claim was never verified against a live board; it has been removed. The
// project-wide-sweep SHAPE round 3 introduced was the right instinct — it was just pointed at the
// wrong project (BIS/prod instead of TH/staging). This version keeps the shape, fixes the target.
//
// USAGE (no build step wired for this one-off maintenance script — bundle ad hoc):
//   npx esbuild scripts/backfill/b977-stamp-null-realization-dry-run.ts --bundle --platform=node \
//     --format=esm --outfile=/tmp/b977-stamp-realization-dry-run.mjs
//   HARMONY_SUPABASE_URL="https://meqkdgncdzromunylyxf.supabase.co" \
//   HARMONY_SUPABASE_ANON_KEY="<staging anon key — the founder has it>" \
//   HARMONY_API_TOKEN="<a TH-scoped token>" \
//     node /tmp/b977-stamp-realization-dry-run.mjs
//
// All three environment variables above MUST be set explicitly to the STAGING/TH triple. Do NOT
// obtain the anon key via plugin/scripts/setup-staging-channel.sh's fallback — that falls back to
// `VITE_SUPABASE_ANON_KEY` in web/.env, which deliberately points at the dev/scratch project
// (lhgljwwetammvsngmbic), the wrong project. A human who agrees with the printed plan applies it by
// hand via `update_knowledge_entry` (entry_id, realization: 'agreed') — this script performs no
// write of any kind.

import { HarmonyAuth } from '../../src/auth.js';
import { createAuthenticatedClient } from '../../src/supabase.js';
import { getProject } from '../../src/tools/project.js';
import { getWorkspaceId } from '../../src/tools/knowledge.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const EXPECTED_PROJECT_KEY = 'TH';
const EXPECTED_SUPABASE_URL = 'https://meqkdgncdzromunylyxf.supabase.co'; // staging (ref meqkdgncdzromunylyxf)

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
    console.error('HARMONY_API_TOKEN is required (same credential the CLI/MCP server use), scoped to the Team Health (TH) project on STAGING.');
    process.exit(1);
  }

  const supabaseUrl = process.env.HARMONY_SUPABASE_URL;
  if (supabaseUrl !== EXPECTED_SUPABASE_URL) {
    console.error(
      `Refusing to run: HARMONY_SUPABASE_URL must be explicitly set to the STAGING instance ` +
      `(${EXPECTED_SUPABASE_URL}) — got ${supabaseUrl ? `"${supabaseUrl}"` : 'unset (which defaults to PROD)'}. ` +
      `Team Health (TH) lives on staging, not prod; set HARMONY_SUPABASE_URL, HARMONY_SUPABASE_ANON_KEY and ` +
      `HARMONY_API_TOKEN together to the staging/TH triple before running this script (see USAGE above).`,
    );
    process.exit(1);
  }

  const auth = new HarmonyAuth(apiToken);
  const client = await createAuthenticatedClient(auth);
  const projectId = auth.getProjectId();

  const project = await getProject(client, projectId);
  if (project.key.toUpperCase() !== EXPECTED_PROJECT_KEY) {
    console.error(
      `Refusing to run: this token is scoped to project "${project.key}", not "${EXPECTED_PROJECT_KEY}" ` +
      `(the Team Health project this script targets). Re-authenticate with a TH-scoped token if that is ` +
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
      'This is almost certainly a permission/RLS problem (a TH-scoped token should see prior technical- ' +
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

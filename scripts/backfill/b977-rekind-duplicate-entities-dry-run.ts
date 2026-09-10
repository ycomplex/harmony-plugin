#!/usr/bin/env node
// B-977 Script A — DRY-RUN ONLY. Prints what a re-kind/merge via reconcile_entity would do for the
// 8 confirmed duplicate entity-kind pairs in the BIS dogfood project. NEVER executes a write —
// database mutations on this project are founder-held (per the B-977 ticket's guardrail). This
// script has NO --apply flag and NO write path at all: it is safe to run repeatedly and safe to
// hand to a human, who reviews the printed plan and runs the suggested `reconcile_entity` calls by
// hand (via the MCP tool / CLI) if they agree with the plan.
//
// TARGET: the BIS dogfood project, specifically — never inferred/auto-detected. The token you
// authenticate with (HARMONY_API_TOKEN) determines which project this runs against; this script
// refuses to proceed unless that project's key is literally "BIS" (see the hard guard in main()
// below), so pointing it at the wrong token's project fails loudly instead of silently auditing (or
// worse, later mutating) the wrong project's graph.
//
// THE 8 CONFIRMED PAIRS (2026-07-07): each name was created as kind='feature', then re-created
// ~52 minutes later as kind='concept' — an accidental duplicate under B-977's new same-name-
// different-kind collision warning (which did not exist yet when these were minted). This script
// does not decide the merge DIRECTION for you: it prints both candidate rows (feature + concept)
// with their ids/descriptions/created_at so a human can confirm which is the more complete/
// canonical node before running reconcile_entity by hand. The suggested call below defaults to
// merging the OLDER 'feature' stub INTO the newer 'concept' node (to_kind='concept',
// from_kind='feature') — reverse it if the human reviewing this decides 'feature' is actually the
// better-typed kind for these (arguably true for several of them — that judgment call belongs to
// the human running this, not this script).
//
// USAGE (no build step wired for this one-off maintenance script — bundle ad hoc):
//   npx esbuild scripts/backfill/b977-rekind-duplicate-entities-dry-run.ts --bundle --platform=node \
//     --format=esm --outfile=/tmp/b977-rekind-dry-run.mjs
//   node /tmp/b977-rekind-dry-run.mjs
//
// Requires HARMONY_API_TOKEN (and optionally HARMONY_SUPABASE_URL / HARMONY_SUPABASE_ANON_KEY) in
// the environment, scoped to the BIS dogfood project — the same credentials the CLI/MCP server use.

import { HarmonyAuth } from '../../src/auth.js';
import { createAuthenticatedClient } from '../../src/supabase.js';
import { getProject } from '../../src/tools/project.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Hardcoded, not inferred: the 8 names confirmed duplicated 2026-07-07 (B-977 ticket body).
const DUPLICATE_NAMES = [
  'Book metadata',
  'Calibre import',
  'Cloud library management',
  'Cross-device sync',
  'In-app reader',
  'Native mobile client',
  'Reading-experience tracking',
  'Web client',
];

const FROM_KIND = 'feature';
const TO_KIND = 'concept';

// A hardcoded guard, deliberately NOT a CLI flag: this script must never silently run against
// whatever project the caller's token happens to be scoped to. "BIS" is the dogfood project's key.
const EXPECTED_PROJECT_KEY = 'BIS';

interface EntityRow {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  created_at: string;
}

async function findEntity(
  client: SupabaseClient,
  workspaceId: string,
  name: string,
  kind: string,
): Promise<EntityRow | null> {
  const { data, error } = await client
    .from('knowledge_entities')
    .select('id, kind, name, description, created_at')
    .eq('workspace_id', workspaceId)
    .eq('kind', kind)
    .eq('name', name)
    .maybeSingle();
  if (error) throw new Error(`lookup failed for "${name}" (${kind}): ${error.message}`);
  return (data as EntityRow | null) ?? null;
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
      `(the BIS dogfood project this script targets). This is a hard guard, not a flag to override — ` +
      `re-authenticate with a BIS-scoped token if that is really what you intend.`,
    );
    process.exit(1);
  }

  // workspace_id is on every knowledge_entities row; resolve it via the projects table (same
  // pattern knowledge.ts's getWorkspaceId uses internally).
  const { data: projectRow, error: projErr } = await client
    .from('projects')
    .select('workspace_id')
    .eq('id', projectId)
    .single();
  if (projErr || !projectRow) throw new Error(`Could not resolve workspace: ${projErr?.message ?? 'no row'}`);
  const workspaceId = (projectRow as { workspace_id: string }).workspace_id;

  console.log(`DRY RUN ONLY — no writes. Project: ${project.name} (${project.key}, ${projectId}). Workspace: ${workspaceId}.\n`);

  let planned = 0;
  let skipped = 0;

  for (const name of DUPLICATE_NAMES) {
    const [featureRow, conceptRow] = await Promise.all([
      findEntity(client, workspaceId, name, FROM_KIND),
      findEntity(client, workspaceId, name, TO_KIND),
    ]);

    console.log(`── "${name}" ──`);
    console.log(`  kind='${FROM_KIND}': ${featureRow ? `id=${featureRow.id} created_at=${featureRow.created_at} description=${JSON.stringify(featureRow.description)}` : '(not found)'}`);
    console.log(`  kind='${TO_KIND}':  ${conceptRow ? `id=${conceptRow.id} created_at=${conceptRow.created_at} description=${JSON.stringify(conceptRow.description)}` : '(not found)'}`);

    if (!featureRow || !conceptRow) {
      console.log(`  SKIP — expected BOTH kind='${FROM_KIND}' and kind='${TO_KIND}' rows to confirm this pair; found only one (or neither). Not planning a reconcile for this name.\n`);
      skipped++;
      continue;
    }

    console.log(
      `  PLAN (not executed): reconcile_entity({ name: ${JSON.stringify(name)}, to_kind: '${TO_KIND}', from_kind: '${FROM_KIND}' })\n` +
      `    -> MERGE mode (a '${TO_KIND}' node already exists): repoints every reference from ${featureRow.id} ` +
      `to ${conceptRow.id}, then deletes ${featureRow.id}. Confirm direction before running.\n`,
    );
    planned++;
  }

  console.log(`Totals: ${DUPLICATE_NAMES.length} names checked, ${planned} pair(s) confirmed and planned, ${skipped} skipped (not a confirmed pair).`);
  console.log('\nNothing was written. Review the plan above, then run the printed reconcile_entity call(s) by hand (MCP tool or CLI) if you agree.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

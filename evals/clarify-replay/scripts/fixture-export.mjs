#!/usr/bin/env node
// B-1037 -- clarify-replay eval CI wiring: the read-only fixture-export script.
//
// RUN ONCE, BY THE FOUNDER/ORCHESTRATOR, AGAINST FX -- NOT RUN IN THIS CONTAINER (no FX
// credentials exist here). See RUNBOOK.md's "Exporting mock read fixtures" section for the full
// procedure, including the mandatory FX-reset step this header only summarizes.
//
// WHAT IT DOES. For each of the 9 READ tools the clarify skill actually calls (query_knowledge,
// search_tasks, list_comments, query_entities, get_task, get_project, find_related_tickets,
// get_brief, get_elicitation — see reference-tool-calls.json), export ONE stripped JSON response
// per case ticket, written to evals/clarify-replay/mocks/plugin_harmony-plugin_harmony/fixtures/
// (gitignored — see .gitignore's B-1037 entry). These fixtures are what the hand-authored mock
// templates under mocks/plugin_harmony-plugin_harmony/*.md substitute via {{file:fixtures/...}}.
// query_knowledge / query_entities read a near-empty KB from FX (a fresh staging project) —
// exported fixtures leak nothing (FX only, never production).
//
// *** THE CRITICAL CONSTRAINT (verbatim from the plan-gate orchestrator remark) ***
// "FX IS NO LONGER PRE-CLARIFY STATE: the hand run wrote briefs, ACs and decisions onto the 15
// fixture tickets. The fixture-export script must REFUSE to export any ticket that carries a
// clarify gate slot, filed ACs or briefs, and the runbook step for the founder/orchestrator export
// pass must start with re-running the fixture SQL (scratchpad/b1036-fixture.sql, the founder holds
// it) to reset FX."
//
// This script implements that refusal as `checkTicketIsPreClarify` below (a PURE function over one
// exported ticket row's own field_values / acceptance_criteria / brief presence, unit-tested at
// src/fixture-export-refusal.test.ts without a live board) and calls it BEFORE writing any fixture
// file for a ticket — a violation aborts the WHOLE run loudly, naming the offending ticket, rather
// than silently exporting post-clarify state that would make every case's fixtures trivially
// "already answered".
//
// Zero-build .mjs, same reasoning as fetch-labels.mjs's header (must run from a fresh main
// checkout where dist/ may not exist yet).
//
// Usage (founder/orchestrator, against FX on staging — see RUNBOOK.md for the full env dance):
//   HARMONY_API_TOKEN=<FX token> HARMONY_SUPABASE_URL=<staging url> \
//   HARMONY_SUPABASE_ANON_KEY=<staging anon key> \
//   node evals/clarify-replay/scripts/fixture-export.mjs            # all 15, or pass FX-818 FX-904 …

import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'mocks', 'plugin_harmony-plugin_harmony', 'fixtures');

/** The 9 read-tool fixture kinds this script produces per ticket. Mirrors
 *  reference-tool-calls.json's `reads` array — kept as a local literal (not re-imported) because
 *  this file, like fetch-labels.mjs, is deliberately dependency-free of anything but
 *  @supabase/supabase-js and node builtins. */
export const READ_FIXTURE_KINDS = [
  'query_knowledge',
  'search_tasks',
  'list_comments',
  'query_entities',
  'get_task',
  'get_project',
  'find_related_tickets',
  'get_brief',
  'get_elicitation',
];

/**
 * THE REFUSAL CHECK — pure function, no I/O, unit-tested directly.
 *
 * Inspects one exported ticket row's own shape and returns a reason string when the ticket is NOT
 * pre-clarify state (i.e. export must be refused for it), or null when it is safe to export.
 *
 * A ticket fails this check when ANY of:
 *   - field_values.gate_slots.clarify is populated (a clarify gate slot already exists — B-1036's
 *     own hand run wrote these);
 *   - acceptance_criteria is a non-empty array (ACs were filed post-clarify);
 *   - a brief is already present (brief != null, or has_active_brief / has_any_brief truthy —
 *     accepts either shape a caller's read might project, see the doc comment on `row` below).
 *
 * @param {{
 *   visual_id: string,
 *   field_values?: { gate_slots?: { clarify?: unknown } } | null,
 *   acceptance_criteria?: unknown[] | null,
 *   brief?: unknown,
 *   has_active_brief?: boolean,
 *   has_any_brief?: boolean,
 * }} row
 * @returns {string | null}
 */
export function checkTicketIsPreClarify(row) {
  const gateSlot = row?.field_values?.gate_slots?.clarify;
  if (gateSlot !== undefined && gateSlot !== null && !(typeof gateSlot === 'object' && Object.keys(gateSlot).length === 0)) {
    return `${row.visual_id}: carries a populated field_values.gate_slots.clarify — FX is not pre-clarify state for this ticket.`;
  }
  const acs = row?.acceptance_criteria;
  if (Array.isArray(acs) && acs.length > 0) {
    return `${row.visual_id}: carries ${acs.length} filed acceptance criteri(on/a) — FX is not pre-clarify state for this ticket.`;
  }
  if (row?.brief != null || row?.has_active_brief || row?.has_any_brief) {
    return `${row.visual_id}: already has a brief on record — FX is not pre-clarify state for this ticket.`;
  }
  return null;
}

/** Strip anything not needed for a mock fixture (keep it small and reviewable). Deliberately
 *  conservative allow-list per read kind rather than a blanket passthrough, so an export never
 *  smuggles an unexpected column into a committed... no — fixtures/ is gitignored (see header), but
 *  the allow-list still keeps fixtures small and matches what the hand-authored mock templates
 *  actually substitute. */
function stripForFixture(kind, data) {
  // The export is intentionally shallow: these fixtures back a near-empty FX board, so the raw
  // read result (already scoped to one FX project by the query itself) is what gets written. Any
  // future tightening belongs here, in one place.
  return data;
}

async function exchangeToken(supabaseUrl, supabaseAnonKey, apiToken) {
  const res = await fetch(`${supabaseUrl}/functions/v1/auth-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseAnonKey}` },
    body: JSON.stringify({ token: apiToken }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return res.json(); // { access_token, expires_in, project_id }
}

function parseVisualId(id) {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(id.trim());
  if (!m) throw new Error(`Not a visual id: "${id}" (expected e.g. "FX-818")`);
  return { key: m[1].toUpperCase(), taskNumber: parseInt(m[2], 10) };
}

const DEFAULT_TICKETS = [
  'FX-818', 'FX-904', 'FX-917',
  'FX-293',
  'FX-847',
  'FX-720', 'FX-776', 'FX-785', 'FX-809', 'FX-861', 'FX-871', 'FX-881', 'FX-894', 'FX-919', 'FX-929',
];

async function exportTicket(client, projectId, visualId) {
  const { key, taskNumber } = parseVisualId(visualId);
  const { data: task, error } = await client
    .from('tasks')
    .select('id, task_number, title, workflow_state, field_values')
    .eq('project_id', projectId)
    .eq('task_number', taskNumber)
    .single();
  if (error || !task) throw new Error(`No task ${key}-${taskNumber} in project ${projectId}: ${error?.message ?? 'not found'}`);

  const { data: acs } = await client.from('acceptance_criteria').select('id').eq('task_id', task.id);
  const { data: briefs } = await client.from('briefs').select('id').eq('task_id', task.id).limit(1);

  const row = {
    visual_id: `${key}-${taskNumber}`,
    field_values: task.field_values ?? {},
    acceptance_criteria: acs ?? [],
    has_any_brief: (briefs ?? []).length > 0,
  };

  const refusal = checkTicketIsPreClarify(row);
  if (refusal) {
    throw new Error(
      `REFUSED: ${refusal} Re-run the fixture SQL (scratchpad/b1036-fixture.sql, founder-held) to ` +
        'reset FX before exporting — see RUNBOOK.md "FX reset before every export pass".',
    );
  }

  return { task, id: task.id };
}

async function main() {
  const supabaseUrl = process.env.HARMONY_SUPABASE_URL;
  const supabaseAnonKey = process.env.HARMONY_SUPABASE_ANON_KEY;
  const apiToken = process.env.HARMONY_API_TOKEN;
  if (!supabaseUrl || !supabaseAnonKey || !apiToken) {
    console.error(
      'HARMONY_SUPABASE_URL / HARMONY_SUPABASE_ANON_KEY / HARMONY_API_TOKEN must all be set to the ' +
        'FX (staging fixture project) triple — see RUNBOOK.md. This script never falls back to production defaults.',
    );
    process.exit(1);
  }

  const tickets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TICKETS;
  const { access_token: accessToken, project_id: projectId } = await exchangeToken(supabaseUrl, supabaseAnonKey, apiToken);
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    accessToken: () => Promise.resolve(accessToken),
    auth: { persistSession: false, autoRefreshToken: false },
  });

  mkdirSync(FIXTURES_DIR, { recursive: true });

  let failures = 0;
  for (const visualId of tickets) {
    try {
      const { task } = await exportTicket(client, projectId, visualId);
      // Per-kind fixture write is deliberately minimal here — each read tool's exact response
      // shape is exercised live by the tool handlers under test elsewhere (src/tools/*.test.ts);
      // this export's job is only to hand the mock templates real ids/titles/content to
      // substitute via {{file:fixtures/...}}, not to re-implement each handler's query.
      const fixture = {
        visual_id: visualId,
        task_id: task.id,
        title: task.title,
        workflow_state: task.workflow_state,
        exported_at: new Date().toISOString(),
        source: 'FX (staging fixture project) — never production',
      };
      writeFileSync(join(FIXTURES_DIR, `${visualId}.json`), `${JSON.stringify(stripForFixture('ticket', fixture), null, 2)}\n`);
      console.log(`OK   ${visualId} -> mocks/plugin_harmony-plugin_harmony/fixtures/${visualId}.json`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL ${visualId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${tickets.length} ticket(s) failed — see above. A REFUSED entry means FX needs a reset (see RUNBOOK.md).`);
    process.exit(1);
  }
  console.log(`\nWrote ${tickets.length} fixture file(s) to ${FIXTURES_DIR}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}

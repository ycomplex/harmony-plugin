#!/usr/bin/env node
// B-1029 — repair accepted gate briefs whose `gate_slot` / `knowledge_entry_content` payload items never
// landed because the same-session accept path called the commit-only `consume_acceptance_event` instead
// of `consume_pending_acceptance_event` (which runs `applyAcceptanceEventPayload` FIRST). See
// `src/tools/acceptance-events.ts`'s module doc-comment and B-1029's own call-site swaps
// (harmony-clarify / harmony-decompose / harmony-design-decide / start-work) for the underlying bug this
// backfills. Reproduced live on B-934 (2026-09-15), repaired there by hand — this script is the
// mechanical version of that same-shaped repair, for every OTHER ticket the bug already touched.
//
// THE DEFECT'S FOOTPRINT: an event whose `pending_acceptance_events` row is already `consumed_at IS NOT
// NULL` (the deferred workflow-state advance DID commit — the ticket moved on) but whose payload's
// `gate_slot` and/or `knowledge_entry_content` items were never applied, because the same-session accept
// skipped straight to the commit-only tool. Two independently-checkable symptoms:
//   - `knowledge_entry_content` — the target knowledge entry's live content is STILL the compose-time
//     PLACEHOLDER stub (e.g. "clarified intent for B-904; body derived from the ratified brief."), never
//     replaced by the ratified projection the accept promised.
//   - `gate_slot` — `tasks.field_values.gate_slots.<gate>` is ABSENT for the ticket, even though the
//     accepted brief's payload named that gate's durable section.
//
// WINDOW: B-867 (which introduced `gate_slot` payload items) shipped ~2026-09-01, so only events created
// on/after that date can exhibit this defect at all — `knowledge_entry_content` (B-843) predates it, but
// scoping to the same window keeps this script's blast radius aligned to what could plausibly be broken
// by the SAME bug, rather than also re-touching unrelated pre-B-843 history.
//
// FIX MECHANISM — never re-author content. For every candidate, re-run `applyAcceptanceEventPayload`
// (src/tools/acceptance-events.ts) against that SAME event, verbatim: it is idempotent by its own
// per-write-kind external_ref ledger, so this only lands whatever this event's own stored payload still
// promised and never touches a row that turns out already-correct. Every write goes through the exact
// same per-write-kind SECURITY DEFINER RPCs the same-session accept path itself would have used — no new
// write surface, no hand-authored content.
//
// USAGE — no build step is wired for this one-off maintenance script; bundle it ad hoc with esbuild
// (already a devDependency) rather than adding a permanent dist target for a script meant to run once
// per defect, not on every build. Use `--format=cjs`, NOT `--format=esm` — an ESM bundle of this script
// crashes at startup with `Error: Dynamic require of "process" is not supported` (a CJS `require` pulled
// in transitively via `src/config/project-manifest.ts`'s `yaml` dependency, inside an ESM bundle). The
// `--format=cjs` bundle below has been verified to run correctly; expect one benign, EXPECTED warning
// about `import.meta` being empty in `src/tools/environment.ts` on this path — that is not a failure:
//
//   npx esbuild scripts/repair-stubbed-accept-payloads.ts --bundle --platform=node --format=cjs \
//     --outfile=/tmp/repair-b1029.cjs
//   node /tmp/repair-b1029.cjs                       # dry run — prints each candidate, writes nothing
//   node /tmp/repair-b1029.cjs --apply                # re-applies the missing write(s) per candidate
//   node /tmp/repair-b1029.cjs --apply --ids <event-uuid>[,<event-uuid>...]   # explicit event id list
//
// Requires HARMONY_API_TOKEN (and optionally HARMONY_SUPABASE_URL / HARMONY_SUPABASE_ANON_KEY) in the
// environment — the SAME credentials the CLI/MCP server use. Every write goes through
// `applyAcceptanceEventPayload` (src/tools/acceptance-events.ts) — the plugin's normal write plane for
// this class of write — never raw SQL.

import { HarmonyAuth } from '../src/auth.js';
import { createAuthenticatedClient } from '../src/supabase.js';
import {
  applyAcceptanceEventPayload,
  restrictPayloadToEntrySlotItems,
  type AcceptanceEventPayloadItem,
  type PendingAcceptanceEvent,
} from '../src/tools/acceptance-events.js';
import { getKnowledgeEntry } from '../src/tools/knowledge.js';
import { GATE_SLOT_FIELD_KEY } from '../src/tools/gate-slots.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The window B-867 shipped in — see the header comment above for why this is the scan floor. */
const WINDOW_START = '2026-09-01T00:00:00Z';

// Copied verbatim from `scripts/redrive-decided-entries.ts` (B-902) — the SAME placeholder shape every
// gate's compose step stamps a promoted entry with before a real accept replaces it ("clarified intent
// for B-904; body derived from the ratified brief."). A live entry still matching this pattern after its
// owning event is `consumed_at IS NOT NULL` is exactly this ticket's `knowledge_entry_content` symptom:
// the accept committed the workflow-state advance but never actually promoted the entry.
const STUB_CONTENT_RE = /for B-\d+; body derived from the ratified brief\.?$/i;
const STUB_MAX_LEN = 200;
function isPlaceholderContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length < STUB_MAX_LEN && STUB_CONTENT_RE.test(trimmed);
}

/** One row from `pending_acceptance_events`, exactly as the snapshot read it. Mirrors
 *  `PendingAcceptanceEvent` (acceptance-events.ts) plus the two extra columns this script's own
 *  candidate query needs that the shared interface doesn't carry (it never needed them before). */
interface EventRow {
  id: string;
  task_id: string;
  brief_id: string;
  reason: string;
  payload: PendingAcceptanceEvent['payload'];
  pending_activity: string | null;
  status: 'pending' | 'consumed';
  consumed_at: string | null;
  created_at: string | null;
}

interface MissingItem {
  kind: 'knowledge_entry_content' | 'gate_slot';
  ref: string;
  detail: string; // human-readable reason it's judged missing
}

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes('--apply'),
    ids: (() => {
      const flag = argv.find((a) => a.startsWith('--ids='));
      return flag ? flag.slice('--ids='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
    })(),
  };
}

/** Same shape-tolerance as `acceptance-events.ts`'s own (unexported) `rawItemsOf` — the live snapshot
 *  shape from `resolve_brief` is `payload.payload` (an array), falling back to a bare array or
 *  `.items` for any other caller shape. Duplicated here rather than exported solely for this script:
 *  it is intentionally private to the module that owns the write dispatch. */
function rawItemsOf(payload: PendingAcceptanceEvent['payload']): unknown[] {
  const withNestedPayload = payload as { payload?: unknown };
  if (Array.isArray(withNestedPayload?.payload)) return withNestedPayload.payload;
  if (Array.isArray(payload)) return payload;
  const withItems = payload as { items?: unknown[] };
  return Array.isArray(withItems?.items) ? withItems.items : [];
}

function itemsOf(payload: PendingAcceptanceEvent['payload']): AcceptanceEventPayloadItem[] {
  return rawItemsOf(payload) as AcceptanceEventPayloadItem[];
}

async function fetchCandidateRows(client: SupabaseClient, ids: string[] | null): Promise<EventRow[]> {
  let query = client
    .from('pending_acceptance_events')
    .select('id, task_id, brief_id, reason, payload, pending_activity, status, consumed_at, created_at')
    .not('consumed_at', 'is', null)
    .gte('created_at', WINDOW_START)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (ids) query = client.from('pending_acceptance_events')
    .select('id, task_id, brief_id, reason, payload, pending_activity, status, consumed_at, created_at')
    .in('id', ids);
  const { data, error } = await query;
  if (error) throw new Error(`fetching candidate pending_acceptance_events failed: ${error.message}`);
  return (data ?? []) as EventRow[];
}

/** Resolve a `knowledge_entry_content` item's target entry id — the item's own `entry_id` when set,
 *  otherwise the brief's `decision_ref.id` (the normal case: the DB resolves it the same way at write
 *  time when `_entry_id` is omitted — see `acceptance-events.ts`'s `consume_knowledge_entry_content_write`
 *  call). Returns null when neither is available (nothing to check against). */
async function resolveEntryId(
  client: SupabaseClient,
  item: AcceptanceEventPayloadItem,
  briefId: string,
): Promise<string | null> {
  if (item.entry_id) return item.entry_id;
  const { data, error } = await client
    .from('briefs')
    .select('decision_ref')
    .eq('id', briefId)
    .maybeSingle();
  if (error) throw new Error(`reading brief ${briefId} for decision_ref failed: ${error.message}`);
  const ref = (data as { decision_ref?: { id?: string } | null } | null)?.decision_ref;
  return ref?.id ?? null;
}

const WRITE_KIND_ORDER: AcceptanceEventPayloadItem['write_kind'][] = [
  'child_ticket', 'checklist_item', 'acceptance_criterion', 'ac_transfer', 'gate_slot', 'knowledge_entry_content', 'label_add',
];

/** Tally EVERY write_kind a row's stored payload carries, in the same order `applyAcceptanceEventPayload`
 *  itself dispatches them — so the dry run's log shows an operator everything `--apply` will and will NOT
 *  touch, not just the two kinds this script checks for missingness. B-1029 (production-defect fix):
 *  `--apply` only ever re-issues the specific `knowledge_entry_content`/`gate_slot` writes THIS row's own
 *  scan found missing (via `restrictPayloadToEntrySlotItems`, src/tools/acceptance-events.ts) — it never
 *  replays `acceptance_criterion`/`child_ticket`/`checklist_item`/`ac_transfer`/`label_add` from a stored
 *  payload, regardless of what this breakdown shows. This function is purely informational. */
function writeKindBreakdown(items: AcceptanceEventPayloadItem[]): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.write_kind, (counts.get(item.write_kind) ?? 0) + 1);
  return WRITE_KIND_ORDER.filter((k) => counts.has(k)).map((k) => ({ kind: k, count: counts.get(k) as number }));
}

/** For each row, determine which `knowledge_entry_content` / `gate_slot` items this event's payload
 *  carries but never actually landed. Read-only — never writes.
 *
 *  NOTE on design-decision-draft rows never surfacing a `gate_slot` finding: this is EXPECTED, not a bug
 *  to re-investigate. `src/tools/briefs.ts`'s `GATE_REASON_FLOW` map (~line 1830 onward) marks
 *  `'design-decision-draft'` (and `'decomposition-proposal'`, `'plan-draft'`, `'stale-patch-review'`,
 *  `'revise-scope-review'`) `writes_slot: false` — only `'clarification-draft'` (via its own accept
 *  payload), `'release-decision-pending'`, and `'verification-ack-pending'` (via the `write_gate_slot` MCP
 *  tool directly, never a payload item) ever write a `gate_slots` entry. So a design accept's payload
 *  NEVER carries a `gate_slot` item in the first place; the gate_slot check below is already correct and
 *  simply has nothing to find for a design-decision-draft row (confirmed live on B-934, 2026-09-15). */
async function findMissingItems(client: SupabaseClient, projectId: string, row: EventRow): Promise<MissingItem[]> {
  const items = itemsOf(row.payload);
  const missing: MissingItem[] = [];

  for (const item of items.filter((i) => i.write_kind === 'knowledge_entry_content')) {
    const entryId = await resolveEntryId(client, item, row.brief_id);
    if (!entryId) {
      missing.push({ kind: 'knowledge_entry_content', ref: item.ref, detail: 'no resolvable target entry id (neither item.entry_id nor the brief\'s decision_ref) — cannot verify' });
      continue;
    }
    try {
      const entry = await getKnowledgeEntry(client, projectId, { entry_id: entryId });
      if (isPlaceholderContent(entry.content)) {
        missing.push({ kind: 'knowledge_entry_content', ref: item.ref, detail: `entry ${entryId} still reads as the compose-time placeholder` });
      }
    } catch (err) {
      missing.push({ kind: 'knowledge_entry_content', ref: item.ref, detail: `could not read entry ${entryId}: ${(err as Error).message}` });
    }
  }

  for (const item of items.filter((i) => i.write_kind === 'gate_slot')) {
    if (!item.gate) continue;
    const { data, error } = await client
      .from('tasks')
      .select('field_values')
      .eq('id', row.task_id)
      .maybeSingle();
    if (error) {
      missing.push({ kind: 'gate_slot', ref: item.ref, detail: `could not read task ${row.task_id}: ${error.message}` });
      continue;
    }
    const fieldValues = (data as { field_values?: Record<string, unknown> } | null)?.field_values ?? {};
    const slots = (fieldValues[GATE_SLOT_FIELD_KEY] ?? {}) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(slots, item.gate)) {
      missing.push({ kind: 'gate_slot', ref: item.ref, detail: `tasks.field_values.${GATE_SLOT_FIELD_KEY}.${item.gate} is absent` });
    }
  }

  return missing;
}

async function main() {
  const { apply, ids } = parseArgs(process.argv.slice(2));
  const apiToken = process.env.HARMONY_API_TOKEN;
  if (!apiToken) {
    console.error('HARMONY_API_TOKEN is required (same credential the CLI/MCP server use).');
    process.exit(1);
  }

  const auth = new HarmonyAuth(apiToken);
  const client = await createAuthenticatedClient(auth);
  const projectId = auth.getProjectId();

  console.log(`Mode: ${apply ? 'APPLY (writes via applyAcceptanceEventPayload)' : 'DRY RUN (no writes)'}`);
  console.log(`Project: ${projectId}`);
  console.log(`Window: consumed_at IS NOT NULL AND created_at >= ${WINDOW_START}\n`);

  const rows = await fetchCandidateRows(client, ids);
  console.log(`Scanned ${rows.length} consumed event(s) in window.\n`);

  let candidates = 0;
  let alreadyCorrect = 0;
  let applied = 0;
  let failed = 0;

  for (const row of rows) {
    const missing = await findMissingItems(client, projectId, row);
    if (missing.length === 0) {
      alreadyCorrect++;
      continue;
    }
    candidates++;
    console.log(`CANDIDATE  event=${row.id}  ticket=${row.task_id}  reason=${row.reason}`);
    const breakdown = writeKindBreakdown(itemsOf(row.payload));
    console.log(`  payload write_kinds: ${breakdown.length ? breakdown.map((b) => `${b.kind}=${b.count}`).join(', ') : '(none)'}`);
    for (const m of missing) console.log(`  missing ${m.kind} (ref=${m.ref}) — ${m.detail}`);

    if (apply) {
      // B-1029 (production-defect fix) — pass ONLY the missing knowledge_entry_content/gate_slot items
      // THIS row's own scan found, never the row's full stored payload: re-running
      // applyAcceptanceEventPayload over the FULL payload also re-issued acceptance_criterion (and would
      // have re-issued checklist_item/child_ticket/ac_transfer/label_add) writes that had already been
      // filed in-session by the owning gate skill's own direct tool call — see
      // restrictPayloadToEntrySlotItems's doc-comment (src/tools/acceptance-events.ts) for the full story.
      const restrictedItems = restrictPayloadToEntrySlotItems(
        itemsOf(row.payload),
        missing.map((m) => ({ kind: m.kind, ref: m.ref })),
      );
      const event: PendingAcceptanceEvent = {
        id: row.id,
        task_id: row.task_id,
        brief_id: row.brief_id,
        reason: row.reason,
        payload: { items: restrictedItems },
        pending_activity: row.pending_activity,
        status: row.status,
      };
      try {
        const result = await applyAcceptanceEventPayload(client, event);
        if (result.substrate_absent_for) {
          console.log(`  -> substrate absent for '${result.substrate_absent_for}' — left pending, retry once the migration lands`);
          failed++;
        } else {
          console.log(`  -> applied=${result.applied} skipped_already_done=${result.skipped_already_done} by_write_kind=${JSON.stringify(result.by_write_kind)}`);
          applied++;
        }
      } catch (err) {
        console.log(`  -> FAILED: ${(err as Error).message}`);
        failed++;
      }
    }
  }

  console.log(`\n${candidates} candidate(s) found, ${alreadyCorrect} already correct, ${rows.length} scanned.`);
  if (apply) {
    console.log(`Applied: ${applied}, failed: ${failed}.`);
  } else if (candidates > 0) {
    console.log('\nDry run only — re-run with --apply to write these changes.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

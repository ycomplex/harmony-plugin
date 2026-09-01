#!/usr/bin/env node
// B-902 — re-derive knowledge entries whose promoted body predates the decided-form `renderEntry` fix
// (unticked "Ratified asks" checkboxes with a live "recommend:" label, and the self-referential
// "On accept, this brief files:" block). Diff-gated and idempotent: for every candidate entry, this
// re-renders its content from its own RETAINED SOURCE BRIEF (B-843 retention makes this a mechanical
// loop — the ratified `doc` is still there) via the fixed `renderEntry`, and only writes when the fresh
// render differs from what is currently stored.
//
// Targets, by default:
//   - The four originally-named entries the ticket calls out (5ee3fe3f, d54edff2, c2442e3d, aac154e0)
//   - B-902's own three entries, themselves derived between filing and build (ac6bab06, 54d09d65, cc4a52f8)
// Pass `--sweep` to ALSO scan every knowledge entry created project-wide in the filing→build window
// (2026-09-01T10:00Z through now) for the same old-shape defect, and re-derive any match found there too
// (beyond the seven named above) — see the WATCH note below.
//
// WATCH: a "stub-shaped" entry (a one-line placeholder like "technical-design decision for B-902; body
// derived from the ratified brief", carrying none of the brief's actual projection) is a DIFFERENT defect
// than the decided-form one this script targets, but it happens to share the same fix — re-deriving from
// the retained source brief replaces the stub with the real projection. `cc4a52f8` is a KNOWN stub, fixed
// here same as every other candidate. Any OTHER stub the `--sweep` turns up is fixed the same way but is
// NOT silently normal — it is printed under a "STUB (beyond cc4a52f8)" banner so it gets called out
// separately, per this ticket's build report.
//
// USAGE — no build step is wired for this one-off maintenance script; bundle it ad hoc with esbuild
// (already a devDependency) rather than adding a permanent dist target for a script meant to run once
// per defect, not on every build:
//
//   npx esbuild scripts/redrive-decided-entries.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/redrive-decided-entries.mjs
//   node /tmp/redrive-decided-entries.mjs                    # dry run — prints a diff per entry, writes nothing
//   node /tmp/redrive-decided-entries.mjs --apply             # applies via update_knowledge_entry
//   node /tmp/redrive-decided-entries.mjs --apply --sweep     # also sweeps the filing→build window
//   node /tmp/redrive-decided-entries.mjs --apply --sweep --ids <uuid>[,<uuid>...]   # explicit id list
//
// Requires HARMONY_API_TOKEN (and optionally HARMONY_SUPABASE_URL / HARMONY_SUPABASE_ANON_KEY) in the
// environment — the SAME credentials the CLI/MCP server use. Every write goes through
// `updateKnowledgeEntry` (src/tools/knowledge.ts) — the plugin's normal write plane — never raw SQL.

import { HarmonyAuth } from '../src/auth.js';
import { createAuthenticatedClient } from '../src/supabase.js';
import { getKnowledgeEntry, updateKnowledgeEntry, type KnowledgeEntryFull } from '../src/tools/knowledge.js';
import { renderEntry, type BriefDoc } from '../src/tools/briefs.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The seven entries the ticket names by their 8-hex-char short id: the four originally-produced
 *  entries this ticket exists to fix, plus B-902's own three (derived between filing and build, while
 *  the old renderEntry was still live). Full UUIDs are resolved at runtime (see `resolveNamedIds`). */
const NAMED_PREFIXES = [
  '5ee3fe3f', 'd54edff2', 'c2442e3d', 'aac154e0', // the four originally-named entries
  'ac6bab06', '54d09d65', 'cc4a52f8',             // B-902's own three
];

/** The filing→build window `--sweep` scans, project-wide, for any OTHER entry derived while the old
 *  renderEntry was still live. */
const SWEEP_WINDOW_START = '2026-09-01T10:00:00Z';

// Matches every stub variant seen in the wild — a short placeholder body naming its own ticket instead of
// carrying the brief's actual projection. B-904: widened from a design-gate-only pattern (it required the
// literal word "decision" before "for B-<n>") to the tail EVERY gate's placeholder shares regardless of its
// leading noun phrase — "clarified intent for B-904...", "decomposition rationale for B-904...",
// "revise-scope rationale for B-902...", "technical design decision for B-902...". The narrower pattern is
// exactly why B-902's own revise-scope stub (801d094c, "revise-scope rationale for B-902; body derived from
// the ratified brief") evaded this script's --sweep: "rationale" never matched "decision". The tail phrase
// "; body derived from the ratified brief" is distinctive enough on its own (a real renderEntry-derived
// entry reads "Derived from the ratified brief at the <gate> gate..." — a different shape entirely, never
// this trailing clause) that dropping the leading-noun requirement introduces no new false positives.
const STUB_CONTENT_RE = /for B-\d+; body derived from the ratified brief\.?$/i;
const STUB_MAX_LEN = 200;
function isStubContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length < STUB_MAX_LEN && STUB_CONTENT_RE.test(trimmed);
}

interface Candidate {
  id: string;
  reason: string; // why this id is being checked, for the log
}

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes('--apply'),
    sweep: argv.includes('--sweep'),
    ids: (() => {
      const flag = argv.find((a) => a.startsWith('--ids='));
      return flag ? flag.slice('--ids='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
    })(),
  };
}

/** Resolve the seven short prefixes above to full UUIDs by scanning a wide recent window and matching
 *  on `id.startsWith(prefix)` client-side — PostgREST cannot `ilike` a `uuid`-typed column, so a
 *  server-side prefix filter is not available. */
async function resolveNamedIds(client: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await client
    .from('knowledge_decisions')
    .select('id')
    .gte('created_at', '2026-08-20T00:00:00Z')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(`resolving named entry ids failed: ${error.message}`);
  const rows = (data ?? []) as { id: string }[];
  const out: Candidate[] = [];
  for (const prefix of NAMED_PREFIXES) {
    const hit = rows.find((r) => r.id.startsWith(prefix));
    if (!hit) {
      console.log(`WARN could not resolve named id prefix "${prefix}" to a full UUID — skipping`);
      continue;
    }
    out.push({ id: hit.id, reason: `named (${prefix})` });
  }
  return out;
}

/** `--sweep`: every knowledge entry created project-wide in the filing→build window. */
async function sweepWindowIds(client: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await client
    .from('knowledge_decisions')
    .select('id, title, content, status')
    .gte('created_at', SWEEP_WINDOW_START)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(`sweep query failed: ${error.message}`);
  const rows = (data ?? []) as { id: string; title: string; content: string; status: string }[];
  // Only entries that LOOK derived by renderEntry are candidates at all: they carry the provenance
  // stamp, OR they are stub-shaped (a renderEntry-adjacent defect this script also fixes — see the WATCH
  // note above). A plain ticket "Intent" note (the clarify-gate problem statement, never renderEntry's
  // output) matches neither and is correctly left alone.
  return rows
    .filter((r) => r.content.includes('Derived from the ratified brief') || isStubContent(r.content))
    .map((r) => ({ id: r.id, reason: 'sweep window' }));
}

/** Find the entry's own retained source brief: the brief whose `decision_ref.id` names this entry.
 *  Multiple retained revisions can carry the SAME decision_ref (the pointer is set once and then carried
 *  forward across in-place iterates) — take the newest. Returns null when no retained brief points here
 *  (the entry was not derived by renderEntry at all, or its brief was not retained). */
async function findSourceBrief(
  client: SupabaseClient,
  entryId: string,
): Promise<{ reason: string; doc: BriefDoc } | null> {
  const { data, error } = await client
    .from('briefs')
    .select('id, reason, doc, created_at')
    .filter('decision_ref->>id', 'eq', entryId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`finding source brief for ${entryId} failed: ${error.message}`);
  const rows = (data ?? []) as { id: string; reason: string; doc: unknown; created_at: string }[];
  const row = rows[0];
  if (!row?.doc) return null;
  return { reason: row.reason, doc: row.doc as BriefDoc };
}

/** Re-derive with the SAME gate reason and construction date the entry already carries, when it carries
 *  one — so a pure formatting fix produces a MINIMAL diff (only the shape actually changed, never the
 *  provenance date) and, critically, so a SECOND run reproduces byte-identical output (idempotency): if
 *  we re-stamped with "now" on every run, a re-run on a later day would manufacture a spurious diff.
 *  Falls back to the brief's own reason and today's date only when the entry carries no stamp to read
 *  (the stub-shaped case, which never had a real derivation date to preserve). */
function extractProvenance(content: string): { reason: string; date: string } | null {
  const m = content.match(/Derived from the ratified brief at the ([\w-]+) gate, (\d{4}-\d{2}-\d{2})/);
  return m ? { reason: m[1], date: m[2] } : null;
}

/** Minimal line-based diff (LCS), printed unified-style. Good enough for a human review gate; no
 *  dependency needed for content this size. */
function printDiff(before: string, after: string): void {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      console.log(`  - ${a[i]}`);
      i++;
    } else {
      console.log(`  + ${b[j]}`);
      j++;
    }
  }
  while (i < a.length) { console.log(`  - ${a[i]}`); i++; }
  while (j < b.length) { console.log(`  + ${b[j]}`); j++; }
}

async function main() {
  const { apply, sweep, ids } = parseArgs(process.argv.slice(2));
  const apiToken = process.env.HARMONY_API_TOKEN;
  if (!apiToken) {
    console.error('HARMONY_API_TOKEN is required (same credential the CLI/MCP server use).');
    process.exit(1);
  }

  const auth = new HarmonyAuth(apiToken);
  const client = await createAuthenticatedClient(auth);
  const projectId = auth.getProjectId();

  console.log(`Mode: ${apply ? 'APPLY (writes via update_knowledge_entry)' : 'DRY RUN (no writes)'}${sweep ? ' + sweep' : ''}`);
  console.log(`Project: ${projectId}\n`);

  let candidates: Candidate[];
  if (ids) {
    candidates = ids.map((id) => ({ id, reason: 'explicit --ids' }));
  } else {
    candidates = await resolveNamedIds(client);
    if (sweep) {
      const swept = await sweepWindowIds(client);
      const known = new Set(candidates.map((c) => c.id));
      for (const s of swept) if (!known.has(s.id)) { candidates.push(s); known.add(s.id); }
    }
  }

  let changed = 0;
  let unchanged = 0;
  let skipped = 0;
  const stubsBeyondCc4a52f8: string[] = [];

  for (const candidate of candidates) {
    let entry: KnowledgeEntryFull;
    try {
      entry = await getKnowledgeEntry(client, projectId, { entry_id: candidate.id });
    } catch (err) {
      console.log(`SKIP  ${candidate.id} (${candidate.reason}) — could not read entry: ${(err as Error).message}`);
      skipped++;
      continue;
    }

    const isStub = isStubContent(entry.content);
    if (isStub && !entry.id.startsWith('cc4a52f8')) {
      stubsBeyondCc4a52f8.push(`${entry.id} — "${entry.title}"`);
    }

    const brief = await findSourceBrief(client, entry.id);
    if (!brief) {
      console.log(`SKIP  ${entry.id} (${candidate.reason}) "${entry.title}" — no retained source brief found (not renderEntry-derived, or brief not retained)`);
      skipped++;
      continue;
    }

    const provenance = extractProvenance(entry.content);
    const renderCtx = provenance
      ? { reason: provenance.reason, now: new Date(`${provenance.date}T00:00:00Z`) }
      : { reason: brief.reason };
    const rendered = renderEntry(brief.doc, renderCtx);

    if (rendered === entry.content) {
      console.log(`OK    ${entry.id} (${candidate.reason}) "${entry.title}" — already decided-form, no change`);
      unchanged++;
      continue;
    }

    console.log(`DIFF  ${entry.id} (${candidate.reason}) "${entry.title}"${isStub ? '  [STUB' + (entry.id.startsWith('cc4a52f8') ? ', known' : ', BEYOND cc4a52f8 — see watch note') + ']' : ''}`);
    printDiff(entry.content, rendered);
    changed++;

    if (apply) {
      await updateKnowledgeEntry(client, projectId, { entry_id: entry.id, content: rendered });
      console.log('  -> applied');
    }
  }

  console.log(`\n${changed} would change${apply ? ' (applied)' : ''}, ${unchanged} already correct, ${skipped} skipped, ${candidates.length} scanned.`);
  if (stubsBeyondCc4a52f8.length) {
    console.log('\nSTUB-SHAPED ENTRIES FOUND BEYOND cc4a52f8 (fixed by this run same as the others, but flagging per the watch instruction):');
    for (const s of stubsBeyondCc4a52f8) console.log(`  - ${s}`);
  }
  if (!apply && changed > 0) {
    console.log('\nDry run only — re-run with --apply to write these changes.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

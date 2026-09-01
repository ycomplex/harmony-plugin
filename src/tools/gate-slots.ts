// B-867 — GATE SLOTS: a gate's ratified content, landed on the ticket and kept visible.
//
// A gate brief is a MOMENT. The human accepts it, the conductor advances, and the wording the gate
// actually ratified survives only inside `briefs.doc` — a row nobody reads once the ticket has moved on.
// So the three answers a reader of the ticket most needs are the three hardest to find: what clarify
// decided this is (and is NOT) solving, what release shipped and where, and what verify's runbook was.
// B-843 fixed the adjacent half (the accepted wording lands on the gate's knowledge entry); this fixes
// the ticket's own face.
//
// THIS MODULE IS THE WRITE HALF. The PROJECTION half is `renderSlot` in briefs.ts — the third mechanical
// projection of the ratified `BriefDoc`, alongside `renderBrief` (what the human reads) and `renderEntry`
// (what the accept promotes). Canonicity was settled by B-866 (`doc` → everything) and is CONSUMED here,
// never re-decided: nothing in this file authors slot prose, it only validates and lands it.
//
// STORAGE (harmony-web's 20260901120538_b867_gate_slot_write.sql — read it before changing anything
// here). The EXISTING `tasks.field_values` JSONB, under the reserved key `gate_slots`, one sub-key per
// gate, each holding `{ content, ratified_by, ratified_at }`. The merge is TWO-LEVEL and both levels are
// load-bearing: the outer level preserves every OTHER field_values key (`build_pr`, `work_branch`), the
// inner one preserves every OTHER gate's slot and REPLACES this gate's — latest-accepted-per-gate.
//
// THE SEMANTIC EVERYTHING HERE PROTECTS — "ratified an EMPTY answer" is NOT "never ratified", and the
// distinction is carried by KEY PRESENCE, never by an empty-ish value:
//   * slot key ABSENT  ⇒ this gate never ratified ⇒ the ticket shows no section at all.
//   * slot key PRESENT ⇒ it ratified, and its answer may legitimately be empty ⇒ the section renders,
//                        and the empty field reads as an explicit "None".
// So an empty `content` object is ACCEPTED and stored verbatim, and a slot key is NEVER deleted. A write
// path that "helpfully" skipped an empty content would collapse a ratified answer back into "nobody
// asked" — the one failure this whole ticket exists to prevent.
//
// ——— TWO CALL SITES, ONE WRITE. AND WHY THEY REACH THE DB DIFFERENTLY ————————————————————————————————
//
// Three gates write a slot (`GATE_REASON_FLOW.writes_slot`, briefs.ts). They do NOT all have an
// acceptance event to hang the write on, and that asymmetry is structural, not an oversight:
//
//   * CLARIFY — `resolve_brief` DEFERS its accept into a `pending_acceptance_events` row, so a
//     `gate_slot` payload item rides that event and the write goes through the ledgered SECURITY DEFINER
//     RPC `consume_gate_slot_write`, exactly like every other write_kind. Idempotent via the ledger's
//     UNIQUE(event_id, write_kind, external_ref); `ratified_by`/`ratified_at` stamped inside the
//     function, so a replayed payload cannot back-date a slot.
//
//   * RELEASE and VERIFY — `resolve_brief` defers ONLY the four agent-owned-payload reasons, so these
//     two accepts mint NO event at all (they are the `carries_writes: false` "NEITHER HALF" rows). The
//     RPC requires an existing event: `acceptance_event_writes.event_id` is NOT NULL with an FK to
//     `pending_acceptance_events`, and the function raises when the event is not found. So the ledgered
//     route is structurally unavailable at these two gates. `finish-work` calls the `write_gate_slot`
//     tool below at the accept, and the write lands through the SAME two-level merge, performed here.
//
// Giving the two hard-floor gates payload semantics purely to make the routes uniform — minting a
// synthetic acceptance event so the RPC has something to point at — was considered and REJECTED: it
// would put `tasks.pending_acceptance_event_id` up transiently (the web renders a "conductor
// executing…" floor off it), contend with the one-pending-event-per-task unique index, and invent an
// event whose only purpose is bookkeeping symmetry. The honest cost of the route we took instead is
// stated at `writeGateSlot` below, where the second branch lives — ONE helper, so the envelope, the
// validation and the merge semantics have exactly one definition whichever route reaches them.

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { resolveTaskId } from './resolve-task-id.js';
import {
  renderSlot,
  readBuildPrReferences,
  GATE_SLOT_NAMES,
  REASON_FOR_GATE_SLOT,
  type BriefDoc,
  type BuildPrReference,
  type GateSlotName,
  type GateSlotContent,
} from './briefs.js';

export { GATE_SLOT_NAMES, REASON_FOR_GATE_SLOT, type GateSlotName, type GateSlotContent };

/** The reserved `tasks.field_values` key the slot map lives under. Mirrors harmony-web's
 *  `GATE_SLOT_FIELD_KEY` (src/features/tasks/lib/gateSlots.ts) — the two halves must agree on it. */
export const GATE_SLOT_FIELD_KEY = 'gate_slots';

// ——— The schemas: what a slot may contain, pinned ————————————————————————————————————————————————
//
// PINNED, not merely typed. These shapes are a cross-repo contract with harmony-web's per-gate section
// renderers (`GateSectionsSection.tsx`), which claim these exact key names; a key this file renames is a
// key that silently changes how the ticket reads. The web side degrades a key it does not recognise to a
// labelled generic row rather than dropping it, so drift is legible rather than lossy — but it is still
// drift, and these schemas are where it gets caught on THIS side.
//
// EVERY FIELD IS `.optional()`, AND THAT IS THE POINT: `undefined` (key absent — the gate did not answer
// this) must stay distinguishable from `[]` (the gate ratified an EMPTY answer). A `.default([])`
// anywhere below would silently erase that distinction — the same collapse the storage layer refuses,
// one level up. Nothing here may ever acquire a default.
//
// Every object is `.passthrough()`: a slot written by a NEWER plugin against an older schema must still
// parse. Validation here is a guard against malformed content, never a filter that quietly drops the
// content a gate ratified.

/** clarify's `not_solving` rows — what is excluded, and where it lands instead. */
export const ExcludedSlotSchema = z.object({
  item: z.string(),
  lands: z.string(),
}).passthrough();

/**
 * The PINNED `build_pr` family — one pull request as the ticket's release section renders it.
 *
 * `tasks.field_values.build_pr` has no enforced shape and three divergent forms exist on the live board:
 * sibling keys (`build_pr` + `build_pr_plugin`, B-740), nesting (`build_pr.web_pr` / `build_pr.plugin_pr`,
 * B-743), and a non-PR sibling (`work_branch`, B-844). `readBuildPrReferences` (briefs.ts) already reads
 * all three defensively; this schema pins what the durable section stores, so the ticket's face is stable
 * even though its source is not. `repo`/`ref`/`url` are the key names harmony-web's `renderPullRequest`
 * claims — matched deliberately, not coincidentally.
 */
export const PullRequestSlotSchema = z.object({
  repo: z.string().optional(),
  ref: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
}).passthrough();

/** verify's criteria rows — the runbook, one line per filed criterion. */
export const CriterionSlotSchema = z.object({
  ac_id: z.string().optional(),
  text: z.string().optional(),
  how: z.string().optional(),
  disposition: z.string().optional(),
}).passthrough();

/** clarify — what this ticket is, and is not, solving. */
export const ClarifySlotSchema = z.object({
  solving: z.string().optional(),
  in_scope: z.array(z.string()).optional(),
  not_solving: z.array(ExcludedSlotSchema).optional(),
}).passthrough();

/** release — what shipped, where it landed, through which PRs, and what is live but unproven. */
export const ReleaseSlotSchema = z.object({
  shipped: z.string().optional(),
  lands_in: z.string().optional(),
  prs: z.array(PullRequestSlotSchema).optional(),
  unproven: z.array(z.string()).optional(),
  evidence_status: z.string().optional(),
}).passthrough();

/** verify — the runbook the human walked, and what backs it. */
export const VerifySlotSchema = z.object({
  environment: z.string().optional(),
  criteria: z.array(CriterionSlotSchema).optional(),
  evidence_status: z.string().optional(),
}).passthrough();

/** A gate this schema predates: it still stores, and the web still displays it, generically labelled. */
export const UnknownGateSlotSchema = z.record(z.unknown());

export const GATE_SLOT_SCHEMAS: Record<GateSlotName, z.ZodTypeAny> = {
  clarify: ClarifySlotSchema,
  release: ReleaseSlotSchema,
  verify: VerifySlotSchema,
};

export type ClarifySlot = z.infer<typeof ClarifySlotSchema>;
export type ReleaseSlot = z.infer<typeof ReleaseSlotSchema>;
export type VerifySlot = z.infer<typeof VerifySlotSchema>;
export type PullRequestSlot = z.infer<typeof PullRequestSlotSchema>;

export function isGateSlotName(gate: string): gate is GateSlotName {
  return (GATE_SLOT_NAMES as readonly string[]).includes(gate);
}

/**
 * Validate one gate's slot content. Returns the content (unchanged — every schema passes unknown keys
 * through), or THROWS naming the gate and the offending path.
 *
 * An EMPTY object passes, at every gate: it is the ratified-empty answer, not a malformed one.
 */
export function parseGateSlotContent(gate: string, content: unknown): GateSlotContent {
  const schema = isGateSlotName(gate) ? GATE_SLOT_SCHEMAS[gate] : UnknownGateSlotSchema;
  const parsed = schema.safeParse(content);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`gate_slot content for gate '${gate}' does not match the pinned shape — ${detail}`);
  }
  return parsed.data as GateSlotContent;
}

/**
 * The pinned PR list for a release slot, read from a task's raw `field_values`.
 *
 * DEFENSIVE, and never throws: `readBuildPrReferences` names what it can read out of the three divergent
 * live shapes and omits what it cannot, and this only re-keys its output into the shape the ticket's
 * section renders. A reference with no url and no number contributes nothing — a PR line the reader
 * cannot follow is worse than no line at all.
 */
export function pinBuildPrs(fieldValues: unknown): PullRequestSlot[] {
  const refs: BuildPrReference[] = readBuildPrReferences(fieldValues);
  const out: PullRequestSlot[] = [];
  for (const ref of refs) {
    const label = typeof ref.pr_number === 'number' ? `#${ref.pr_number}` : (ref.branch ?? ref.pr_url);
    if (!ref.pr_url && !label) continue;
    const pr: PullRequestSlot = { repo: ref.key };
    if (label) pr.ref = label;
    if (ref.pr_url) pr.url = ref.pr_url;
    out.push(pr);
  }
  return out;
}

// ——— The write ————————————————————————————————————————————————————————————————————————————————————

/** WHERE this write anchors — the one thing that differs between the two call sites (see the header).
 *  `acceptance-event` is the ledgered RPC route (clarify, through its accept payload); `task` is the
 *  direct route for a gate whose accept mints no event (release, verify). */
export type GateSlotTarget =
  | { via: 'acceptance-event'; event_id: string; external_ref: string }
  | { via: 'task'; task_id: string };

export interface WriteGateSlotArgs {
  /** WHICH section. Open by design — the DB puts no enum CHECK on it, so a fourth gate stores and
   *  displays without a web deploy. Must be non-blank: a slot is keyed by the gate that ratified it. */
  gate: string;
  /** The section's fields. An EMPTY object is valid and meaningful (ratified-empty). */
  content: GateSlotContent;
  target: GateSlotTarget;
}

export interface GateSlotWriteResult {
  gate: string;
  /** false on the ledgered route when this exact write already landed (a retry) — never an error. */
  applied: boolean;
  /** The content keys actually landed, for a caller that wants to report what it wrote. */
  keys: string[];
  /** The task the slot landed on, when the route knows it. */
  result_id?: string;
  /** B-383/B-688 — set ONLY when `consume_gate_slot_write` itself does not exist on this DB yet (the
   *  plugin's `main` reaches prod before harmony-web's migration does). The caller must treat this
   *  exactly like the sibling write kinds do: leave the event pending, never consume, let a later retry
   *  pick it up. Never set on the `task` route, which needs no migration at all. */
  substrate_absent?: true;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The three PostgREST/Postgres error shapes that mean "this RPC does not exist on this DB" — the
 *  B-383 schema-drift class. A deliberate local copy of the sibling predicate in acceptance-events.ts
 *  (and of briefs.ts's three): importing it would make this module and its only ledgered caller import
 *  each other, and a cycle is a worse price than six duplicated lines. It NEVER matches a permission
 *  error, a transient network failure, or a genuine write failure — those must propagate. */
function isMissingGateSlotRpc(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  if (code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205') return true;
  const msg = err.message ?? '';
  return /schema cache/i.test(msg) && /(could not find|does not exist)/i.test(msg);
}

/** The slot's `ratified_at`, in the SAME format the RPC stamps (`YYYY-MM-DDTHH:MM:SSZ`, UTC, no
 *  milliseconds) — so a slot's provenance line reads identically whichever route wrote it. */
function ratifiedAtStamp(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/**
 * THE single write. Both call sites reach this — the payload dispatch (acceptance-events.ts) and the
 * `write_gate_slot` MCP tool below — so the envelope, the validation and the two-level merge semantics
 * have exactly one definition, and a change to any of them cannot land at one gate and not the others.
 *
 * VALIDATION RUNS FIRST, BEFORE ANY WRITE, mirroring the RPC's own order (B-688 / B-843 precedent): a
 * call that cannot name its gate, or carries no content OBJECT, leaves nothing behind and stays cleanly
 * retryable. An EMPTY content object is valid at both routes.
 *
 * THE TWO ROUTES, AND THE HONEST DIFFERENCE BETWEEN THEM:
 *   * `acceptance-event` → `consume_gate_slot_write`. Ledgered (idempotent via the ledger's UNIQUE),
 *     provenance stamped server-side, RLS bypassed by SECURITY DEFINER. Everything the sibling write
 *     kinds get.
 *   * `task` → the same two-level merge performed here, against `tasks.field_values`. It exists because
 *     the RPC cannot be reached without an acceptance event and release/verify have none (header). It is
 *     NOT ledgered — it does not need to be: unlike minting a child ticket, re-writing a slot is
 *     naturally idempotent (latest-accepted-per-gate means a repeat lands the same section), so a retry
 *     costs a duplicate `field_values` write and nothing else. Its two real costs, stated rather than
 *     hidden: `ratified_at` is stamped from the CLIENT clock (same format, so the two routes read
 *     identically), and the read-modify-write is not atomic — a second writer racing the same task's
 *     `field_values` between the read and the update would lose its key. Both are acceptable here: the
 *     accept is a single conducting session, and `update_task`'s own field_values merge has the same
 *     shape and the same exposure.
 */
export async function writeGateSlot(
  client: SupabaseClient,
  args: WriteGateSlotArgs,
): Promise<GateSlotWriteResult> {
  const gate = (args.gate ?? '').trim();
  if (!gate) throw new Error('gate_slot write names no gate — the slot is keyed by the gate that ratified it');
  if (!isPlainObject(args.content)) {
    throw new Error(
      `gate_slot write for gate '${gate}' must carry a content OBJECT (an EMPTY object is valid — it means the gate ratified an empty answer)`,
    );
  }
  const content = parseGateSlotContent(gate, args.content);
  const keys = Object.keys(content);

  if (args.target.via === 'acceptance-event') {
    const { data, error } = await client.rpc('consume_gate_slot_write', {
      _event_id: args.target.event_id,
      _external_ref: args.target.external_ref,
      _gate: gate,
      // ONLY the content. `ratified_by` / `ratified_at` are stamped INSIDE the function, from `_gate`
      // and `now()` — sending them would let a replayed payload back-date a slot.
      _content: content,
    });
    if (error) {
      if (isMissingGateSlotRpc(error)) return { gate, applied: false, keys, substrate_absent: true };
      throw new Error(error.message);
    }
    const row = (data ?? {}) as { applied?: boolean; result_id?: string };
    return { gate, applied: row.applied === true, keys, result_id: row.result_id };
  }

  const taskId = args.target.task_id;
  const { data: taskRow, error: readErr } = await client
    .from('tasks').select('field_values').eq('id', taskId).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!taskRow) throw new Error(`gate_slot write for gate '${gate}' targets task ${taskId}, which does not exist`);

  const fieldValues = isPlainObject((taskRow as { field_values?: unknown }).field_values)
    ? ((taskRow as { field_values: Record<string, unknown> }).field_values)
    : {};
  // Read the existing slot map DEFENSIVELY, exactly as the RPC does: anything that is not an object
  // (absent, null, or a scalar left by some earlier hand-edit) starts over as `{}` rather than
  // corrupting the merge.
  const existingSlots = isPlainObject(fieldValues[GATE_SLOT_FIELD_KEY])
    ? (fieldValues[GATE_SLOT_FIELD_KEY] as Record<string, unknown>)
    : {};

  const ratified_at = ratifiedAtStamp(new Date());
  // Two-level merge, both levels load-bearing: the outer spread keeps every OTHER field_values key
  // (`build_pr`, `work_branch` above all — clobbering them is exactly what update_task is careful not to
  // do), the inner one keeps every OTHER gate's slot and REPLACES this gate's.
  const nextFieldValues = {
    ...fieldValues,
    [GATE_SLOT_FIELD_KEY]: {
      ...existingSlots,
      [gate]: { content, ratified_by: gate, ratified_at },
    },
  };

  const { error: writeErr } = await client.from('tasks').update({ field_values: nextFieldValues }).eq('id', taskId);
  if (writeErr) throw new Error(writeErr.message);
  return { gate, applied: true, keys, result_id: taskId };
}

// ——— The MCP tool: the release and verify accepts' route to the same write ————————————————————————

export interface WriteGateSlotToolArgs {
  task_id: string;
  gate: string;
}

export interface WriteGateSlotToolResult {
  task_id: string;
  gate: string;
  /** false ⇒ nothing was written, and `reason` says why. Never an error: a hard-floor gate's accept must
   *  not fail because a brief predates the frame this projects. */
  written: boolean;
  reason?: string;
  applied?: boolean;
  keys?: string[];
  brief_id?: string;
}

/**
 * Land ONE gate's ratified brief content on the ticket, as a durable section.
 *
 * The content is DERIVED here, never supplied by the caller: this reads the gate's own brief and
 * projects its ratified `doc` through `renderSlot`. A `content` parameter would re-open exactly the
 * duplication B-866 closed — a section hand-authored beside the brief, vetted once and displayed
 * forever. There is deliberately no way to pass one.
 */
export async function writeGateSlotToolHandler(
  client: SupabaseClient,
  projectId: string,
  args: WriteGateSlotToolArgs,
): Promise<WriteGateSlotToolResult> {
  if (!args.task_id) throw new Error('task_id is required');
  const gate = (args.gate ?? '').trim();
  if (!gate) throw new Error('gate is required');
  if (!isGateSlotName(gate)) {
    throw new Error(`gate must be one of: ${GATE_SLOT_NAMES.join(', ')} — got '${gate}'`);
  }
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  const reason = REASON_FOR_GATE_SLOT[gate];

  // The gate's OWN brief, newest first, at ANY status — the slot is written AT the accept, by which time
  // the brief is resolved, so an active-only read (the B-878 blindness) would find nothing.
  const { data: briefRows, error: briefErr } = await client
    .from('briefs').select('id, doc, reason, created_at')
    .eq('task_id', taskId).eq('reason', reason)
    .order('created_at', { ascending: false }).limit(1);
  if (briefErr) throw new Error(briefErr.message);
  const brief = ((briefRows as Array<{ id: string; doc: unknown }> | null) ?? [])[0];
  if (!brief) {
    return { task_id: taskId, gate, written: false, reason: `no ${reason} brief exists on this ticket — nothing was ratified at the ${gate} gate` };
  }

  const doc = brief.doc as BriefDoc | null;
  const projected = doc ? renderSlot(doc, gate) : null;
  if (!projected) {
    // A brief with no frame of this gate's kind ratified nothing the section can lay out. Writing an
    // empty slot would CLAIM the gate ratified an empty answer, which is a different (and false) thing.
    return {
      task_id: taskId, gate, written: false, brief_id: brief.id,
      reason: `the ${reason} brief carries no ${gate} frame — there is nothing ratified in a shape the ticket's section can lay out`,
    };
  }

  const content: GateSlotContent = { ...projected };
  if (gate === 'release') {
    // The PR references are the one part of the release section the doc cannot carry — they live on the
    // task. Read them defensively and pin them into the shape the section renders.
    const { data: taskRow } = await client.from('tasks').select('field_values').eq('id', taskId).maybeSingle();
    const prs = pinBuildPrs((taskRow as { field_values?: unknown } | null)?.field_values);
    // Always set the key, even to `[]`: "this release landed through no recorded PR" is an answer the
    // reader needs, and it is a different claim from "nobody recorded whether it did".
    content.prs = prs;
  }

  const result = await writeGateSlot(client, { gate, content, target: { via: 'task', task_id: taskId } });
  return { task_id: taskId, gate, written: true, applied: result.applied, keys: result.keys, brief_id: brief.id };
}

export const writeGateSlotTool = {
  name: 'write_gate_slot',
  description:
    "B-867 — land a gate's ratified brief content on the ticket as a DURABLE section, visible forever " +
    'after (stored in tasks.field_values.gate_slots, one sub-key per gate, latest-accepted-per-gate). ' +
    'Call it IMMEDIATELY AFTER the accept at the release gate (gate: "release") and the verify gate ' +
    '(gate: "verify") — those two accepts create no acceptance event, so their slot cannot ride a brief ' +
    'payload the way clarify\'s does; this tool is how they reach the same write. Clarify normally needs ' +
    'no call at all: its slot rides its accept payload automatically. ' +
    'The content is DERIVED, never passed in: this reads the gate\'s own brief and projects its ratified ' +
    'doc (the same projection the brief itself renders), so the section and the brief cannot disagree — ' +
    'there is deliberately no way to hand-author it. Requires the gate\'s brief to carry a `doc.frame` ' +
    'of the matching kind (B-876); a brief without one returns { written: false, reason } and changes ' +
    'nothing, rather than failing the accept. Idempotent: re-running replaces THIS gate\'s slot and ' +
    "touches no other gate's, and never any other field_values key (build_pr / work_branch are safe). " +
    'Returns { written, applied, keys, reason? }.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, task number (e.g., 867), or visual ID (e.g., B-867)' },
      gate: {
        type: 'string',
        enum: ['clarify', 'release', 'verify'],
        description: "Which gate's section to land — 'release' after the release accept, 'verify' after the verify accept.",
      },
    },
    required: ['task_id', 'gate'],
  },
};

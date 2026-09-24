// B-1062 — the RECORDED gate-walk core.
//
// `harmony record <ticket>` (CLI: src/cli/commands/record.ts, MCP: the `record` tool in
// src/tools/index.ts) and the daemon-side drain (src/daemon/recorded-walk-drain.ts, B-1063's
// sibling table) BOTH call `runRecordedWalk` below — ONE implementation, never two, exactly like
// every other shared MCP+CLI core in `src/tools/`.
//
// WHAT THIS DOES: walks a non-conducted ticket's gates — clarify -> decompose -> design -> plan ->
// build -> release — from a human-supplied summary + evidence links, with ZERO worker legs. It reuses
// the SAME primitives a live conduct run would use (`compose_brief` / `resolve_brief` /
// `consume_pending_acceptance_event` / `advance_workflow` / `record_decision` / `write_gate_slot`), so
// the ticket ends up with the same gate-slot/knowledge-entry TRAIL a conducted ticket would get —
// marked "recorded, not conducted" by two load-bearing markers everywhere this core writes:
//   - `ratified_by: 'recorded'` on every gate slot (gate-slots.ts's `WriteGateSlotArgs.ratified_by`
//     override, B-1062 step 5) — NEVER the gate's own name, which is what a live accept would stamp.
//   - `agent-on-behalf:human-recorded` (provenance.ts, B-1062's third closed suffix) on every
//     KNOWLEDGE write this core makes (the placeholder decision entries) — never a bare
//     `agent-synthesized`, which would misattribute a human's already-done work to conductor synthesis.
// `resolve_brief`'s own accept provenance is a SEPARATE, narrower closed vocabulary
// (`validateResolutionProvenance` in briefs.ts — human-in-session / agent-synthesized[:mode] only, and
// NOT widened by this ticket's step 6, which scopes only the KNOWLEDGE-write fence in
// provenance.ts/knowledge.ts) — every accept this core issues uses `agent-synthesized:recorded`, an
// honest existing-vocabulary read: an agent, not a live human, is issuing this accept, under the
// 'recorded' delegation mode.
//
// REFUSE-BEFORE-WRITE (AC-critical): `evaluateEligibility` (record-eligibility.ts) runs FIRST, before
// this function resolves a task id or touches the database at all. Any failing/unattested item refuses
// the WHOLE walk — the ticket is left byte-identical. See `runRecordedWalk`'s early return below.
//
// MID-WALK FAILURE: once eligible, each gate's writes are attempted in order and appended to `landed`
// as they succeed. A thrown error from any gate is caught HERE (never left to crash the caller) and
// returned as `{ error, gates: landed, ... }` — naming exactly which gates already landed, so a human
// can resume by hand (compose_brief/resolve_brief directly, or `harmony conduct`) rather than the walk
// silently half-applying and reporting false success.
//
// SCOPE NOTE (stated plainly, not hidden): this core authors MINIMAL, MECHANICAL gate frames derived
// from the summary/evidence — it does not replicate every ancillary step a live interactive skill run
// performs (e.g. harmony-clarify's elicitation exchange, AC-filing-pass marker convention, or
// decision-only fast-forward; harmony-decompose's split-vs-no-split branch; harmony-design-decide's
// per-track promotion). It always takes the "nothing further to elicit, no split, no design decision to
// promote" shape, which is the correct shape for the overwhelmingly common case a recorded walk exists
// for: a ticket whose gates were never walked live but whose work is already done and needs no further
// branching. A ticket whose true history needs one of those richer shapes is exactly the
// eligibility floor's job to keep OUT of this path (see record-eligibility.ts) — and a ticket that
// still needs one after passing eligibility can always be walked live via `harmony conduct` instead.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import { composeBrief, resolveBrief, type BriefDoc } from './briefs.js';
import { consumePendingAcceptanceEvent } from './acceptance-events.js';
import { writeGateSlot, type GateSlotContent } from './gate-slots.js';
import { advanceWorkflow } from './workflow.js';
import { addComment } from './comments.js';
import { manageAcceptanceCriteria } from './acceptance-criteria.js';
import { PROVENANCE_AGENT_ON_BEHALF_HUMAN_RECORDED } from './provenance.js';
import {
  evaluateEligibility,
  type EligibilityReport,
  type EligibilityEvidenceLink,
} from './record-eligibility.js';

/** B-1062: the `ratified_by` value stamped on every gate slot this core writes — never the gate's own
 *  name, which is what a live accept would stamp (gate-slots.ts's `WriteGateSlotArgs.ratified_by`). */
export const RATIFIED_BY_RECORDED = 'recorded';

/** The accept provenance this core issues on every `resolve_brief` call. See this file's header for
 *  why it is NOT `agent-on-behalf:human-recorded` — that vocabulary belongs to `validateResolutionProvenance`
 *  (briefs.ts), a separate closed set this ticket does not widen. */
export const RESOLVE_BRIEF_PROVENANCE_RECORDED = 'agent-synthesized:recorded';

/** The knowledge-write provenance this core issues on every placeholder decision it records — the
 *  widened B-1021 fence's third closed suffix (provenance.ts, B-1062 step 6). */
export const KNOWLEDGE_WRITE_PROVENANCE_RECORDED = PROVENANCE_AGENT_ON_BEHALF_HUMAN_RECORDED;

export type RecordWalkGateName = 'clarify' | 'decompose' | 'design' | 'plan' | 'build' | 'release';

const GATE_REASONS: Partial<Record<RecordWalkGateName, string>> = {
  clarify: 'clarification-draft',
  decompose: 'decomposition-proposal',
  design: 'design-decision-draft',
  plan: 'plan-draft',
  release: 'release-decision-pending',
};

/** Reasons whose `resolve_brief` accept DEFERS its writes into a `pending_acceptance_events` row (see
 *  acceptance-events.ts's header) — this core must `consume_pending_acceptance_event` right after
 *  accepting one of these, or the promised writes (gate slot / promoted knowledge entry / filed ACs)
 *  never actually land. `release-decision-pending` is deliberately absent: its accept mints no event at
 *  all (briefs.ts's `resolveBrief` header), so its slot is written directly via `write_gate_slot` instead. */
const PAYLOAD_CARRYING_REASONS = new Set([
  'clarification-draft', 'decomposition-proposal', 'design-decision-draft', 'plan-draft',
]);

export interface RecordWalkArgs {
  task_id: string;
  summary: string;
  evidence: EligibilityEvidenceLink[];
  attest_walk?: string;
}

export interface RecordWalkGateResult {
  gate: RecordWalkGateName;
  reason?: string;
  landed: boolean;
  detail?: string;
}

export interface RecordWalkResult {
  task_id: string;
  eligibility: EligibilityReport;
  /** true ⇒ the walk never started (refuse-before-write); the ticket is byte-identical. */
  refused: boolean;
  refusal_reason?: string;
  gates: RecordWalkGateResult[];
  attestation_recorded: boolean;
  /** Set on a genuine mid-walk failure — `gates` still names everything that landed before it. */
  error?: string;
}

function trimmedOrEmpty(s: string | undefined): string {
  return typeof s === 'string' ? s.trim() : '';
}

/** A short, single-sentence "what became true" line derived mechanically from the human's summary —
 *  never a second free-text input; the summary IS the source of truth this whole walk records. */
function deriveSolving(summary: string): string {
  const trimmed = trimmedOrEmpty(summary).replace(/[.!?]+$/, '');
  return trimmed ? `${trimmed}.` : summary;
}

export function describeIneligibility(report: EligibilityReport): string {
  const bad = report.items.filter((i) => i.verdict !== 'pass');
  const lines = bad.map((i) => `  - ${i.label}: ${i.verdict.toUpperCase()} (${i.value}${i.detail ? ' — ' + i.detail : ''})`);
  return (
    `harmony record refuses — ${bad.length} of 5 eligibility item(s) did not pass:\n` +
    lines.join('\n') +
    `\nNothing was written. Use \`harmony conduct <ticket>\` instead to walk this ticket's gates live.`
  );
}

function renderAttestationComment(args: RecordWalkArgs, userId: string): string {
  const when = new Date().toISOString();
  return (
    `RECORDED-WALK-ATTESTATION\n` +
    `who: ${userId}\n` +
    `what_was_walked: ${trimmedOrEmpty(args.attest_walk)}\n` +
    `when: ${when}\n` +
    `summary: ${trimmedOrEmpty(args.summary)}\n` +
    `evidence: ${args.evidence.map((e) => e.url).join(', ') || '(none)'}`
  );
}

/** AC c44227c9 — who/when/what, all populated. `who` is resolved from the ACTING user (the
 *  `userId` this whole walk is issuing writes as — the same identity `composeAndAccept`/`addComment`
 *  already thread through every other write below; no separate lookup invented). `what_was_walked`
 *  keeps the free-text `attest_walk` content unchanged (it was previously bare `who`/`what`-conflated
 *  free text with `who` always null — this field's CONTENT is untouched, only its neighbor is now real). */
function buildAttestation(args: RecordWalkArgs, userId: string): Record<string, unknown> {
  return {
    who: userId,
    what_was_walked: trimmedOrEmpty(args.attest_walk),
    when: new Date().toISOString(),
    evidence: args.evidence.map((e) => e.url),
  };
}

interface ComposeAndAcceptArgs {
  reason: string;
  pendingActivity: string | null;
  decide: string;
  frame: BriefDoc['frame'];
  why?: string[];
  /** B-876 — ONLY meaningful on the release frame: compose_brief derives `frame.risk_classes` from
   *  this (overwriting whatever the frame above authored there). Omitted everywhere else. */
  changedPaths?: string[];
}

/** compose_brief -> resolve_brief(accept) -> (payload-carrying reasons only) consume the deferred
 *  writes. Throws on any failure — the caller (runRecordedWalk) is the ONE place that catches and
 *  reports partial progress. */
async function composeAndAccept(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  taskId: string,
  args: ComposeAndAcceptArgs,
): Promise<void> {
  await composeBrief(client, projectId, userId, {
    task_id: taskId,
    reason: args.reason,
    pending_activity: args.pendingActivity ?? undefined,
    changed_paths: args.changedPaths,
    doc: {
      decide: args.decide,
      why: args.why,
      items: [],
      frame: args.frame,
    },
  });
  await resolveBrief(client, projectId, {
    task_id: taskId,
    command: 'accept',
    provenance: RESOLVE_BRIEF_PROVENANCE_RECORDED,
  });
  if (PAYLOAD_CARRYING_REASONS.has(args.reason)) {
    const consumed = await consumePendingAcceptanceEvent(client, projectId, taskId);
    if (consumed.status !== 'consumed' && consumed.status !== 'none' && consumed.status !== 'substrate-absent') {
      throw new Error(
        `recorded walk: ${args.reason} accept deferred a payload this core could not apply cleanly ` +
        `(status: ${consumed.status}) — a human must resume this gate by hand, e.g. via ` +
        `consume_pending_acceptance_event / the owning gate skill's self-heal route.`,
      );
    }
  }
}

/**
 * Walk a ticket's gates — clarify -> decompose -> design -> plan -> build -> release — from a human
 * summary + evidence trail, with ZERO worker legs. See this file's header for the full contract.
 */
export async function runRecordedWalk(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: RecordWalkArgs,
): Promise<RecordWalkResult> {
  const eligibility = evaluateEligibility({
    summary: args.summary,
    evidence: args.evidence,
    attestWalk: args.attest_walk,
  });

  // REFUSE-BEFORE-WRITE: nothing below this line runs on an ineligible ticket — not even a task-id
  // resolve (a read), so the ticket is left provably byte-identical.
  if (!eligibility.eligible) {
    return {
      task_id: args.task_id,
      eligibility,
      refused: true,
      refusal_reason: describeIneligibility(eligibility),
      gates: [],
      attestation_recorded: false,
    };
  }

  const taskId = await resolveTaskId(client, projectId, args.task_id);
  const gates: RecordWalkGateResult[] = [];
  let attestationRecorded = false;
  const summary = trimmedOrEmpty(args.summary);
  const solving = deriveSolving(summary);
  const repos = Array.from(new Set(args.evidence.map((e) => e.repo).filter((r): r is string => !!r)));
  const changedPaths = args.evidence.flatMap((e) => e.paths ?? []);

  try {
    // ——— Captured -> Proposed, brief-less plumbing (B-1062 verify-round fix 1) ——————————————————
    // EVERY ticket eligible for `harmony record` starts life in `Captured` (the post-B-474 inbox
    // state) — without this, clarify's own compose_brief would refuse (no
    // ('Captured','clarifying','Clarified') edge exists; only ('Proposed','clarifying','Clarified')
    // does). Mirrors `harmony-conduct`'s own Captured self-advance EXACTLY (SKILL.md loop step 4:
    // `advance_workflow({ task_id, activity: 'proposing' })`, Captured->Proposed, framed as plumbing —
    // never a pause). A ticket already past Captured (e.g. re-run after a partial walk) skips this.
    const { data: currentTaskRow, error: currentStateErr } = await client
      .from('tasks')
      .select('workflow_state')
      .eq('id', taskId)
      .eq('project_id', projectId)
      .single();
    if (currentStateErr) throw currentStateErr;
    const currentWorkflowState = (currentTaskRow as { workflow_state: string | null } | null)?.workflow_state ?? null;
    if (currentWorkflowState === 'Captured') {
      await advanceWorkflow(client, projectId, { task_id: taskId, activity: 'proposing' });
    }

    // ——— CLARIFY ———————————————————————————————————————————————————————————————————————————
    await composeAndAccept(client, projectId, userId, taskId, {
      reason: GATE_REASONS.clarify!,
      pendingActivity: 'clarifying',
      decide: `Record ${args.task_id}'s intent from the supplied summary and evidence (recorded, not conducted).`,
      why: [summary],
      frame: {
        kind: 'clarify',
        solving,
        in_scope: [summary],
        not_solving: [],
      },
    });
    gates.push({ gate: 'clarify', reason: GATE_REASONS.clarify, landed: true });

    // AC c44227c9 — the attestation lands BOTH as a dated ticket comment AND inside the clarify slot's
    // own content (never only the CLI flag) — landed here, AFTER the accept, via a DIRECT write_gate_slot
    // call (never the payload route clarify's own accept would otherwise take — see this file's header
    // and gate-slots.ts's `ratified_by` doc comment for why: the acceptance-event route stamps
    // `ratified_by` server-side from the gate name and cannot be overridden).
    const clarifyContent: GateSlotContent = {
      solving,
      in_scope: [summary],
      not_solving: [],
      attestation: buildAttestation(args, userId),
    };
    await writeGateSlot(client, {
      gate: 'clarify',
      content: clarifyContent,
      target: { via: 'task', task_id: taskId },
      ratified_by: RATIFIED_BY_RECORDED,
    });
    if (trimmedOrEmpty(args.attest_walk)) {
      await addComment(client, projectId, userId, { task_id: taskId, content: renderAttestationComment(args, userId) });
      attestationRecorded = true;
    }

    // B-747 build-gate floor (B-1062 verify-round fix 2): the floor correctly refuses Planned->Built
    // on zero acceptance criteria — a recorded walk has no live clarify leg to file one, so nothing
    // ever would without this. File exactly one checked AC here, at clarify, before the walk proceeds
    // any further, so the floor never blocks this walk's own BUILD step below. Same provenance
    // discipline as the rest of this walk's writes (see this file's header): the content names the
    // recorded-not-conducted origin and the attesting user, never presented as a live-clarified AC.
    const evidenceSummary = args.evidence.map((e) => e.url).join(', ') || '(none)';
    await manageAcceptanceCriteria(client, projectId, userId, {
      task_id: taskId,
      add: [{
        content: `${summary} — recorded from ${evidenceSummary}; verify walk attested by ${userId}`,
        checked: true,
      }],
    });

    // ——— DECOMPOSE (no-split shape — see this file's header SCOPE NOTE) —————————————————————————
    await composeAndAccept(client, projectId, userId, taskId, {
      reason: GATE_REASONS.decompose!,
      pendingActivity: 'decomposing',
      decide: `Confirm ${args.task_id} does not split (recorded walk).`,
      frame: {
        kind: 'decompose',
        elements: [],
        coverage: 'Recorded walk — no decomposition; the work is recorded as a single ticket from the supplied summary and evidence.',
        existing_children_checked: true,
      },
    });
    gates.push({ gate: 'decompose', reason: GATE_REASONS.decompose, landed: true });

    // ——— DESIGN (no track requires a fresh decision — see this file's header SCOPE NOTE) ————————
    await composeAndAccept(client, projectId, userId, taskId, {
      reason: GATE_REASONS.design!,
      pendingActivity: 'designing',
      decide: `Confirm ${args.task_id} needs no new design decision (recorded walk).`,
      frame: {
        kind: 'design',
        track: 'technical-design',
        tracks: [
          { track: 'product-design', status: 'not-required', note: 'Recorded walk — no product-design decision to ratify.' },
          { track: 'technical-design', status: 'not-required', note: 'Recorded walk — no technical-design decision to ratify.' },
          { track: 'ux-ui-design', status: 'not-required', note: 'Recorded walk — no ux-ui-design decision to ratify.' },
        ],
        reach: [],
      },
    });
    gates.push({ gate: 'design', reason: GATE_REASONS.design, landed: true });

    // ——— PLAN ——————————————————————————————————————————————————————————————————————————————
    await composeAndAccept(client, projectId, userId, taskId, {
      reason: GATE_REASONS.plan!,
      pendingActivity: 'planning',
      decide: `Record ${args.task_id}'s plan from the supplied summary and evidence (recorded, not conducted).`,
      frame: {
        kind: 'plan',
        scope: { repos: repos.length > 0 ? repos : ['(unknown — no repo derived from evidence)'], surfaces: [], has_migration: false },
        steps: [summary],
        attestation: { base_verified: 'recorded walk — no live base-verify run; ratified from supplied evidence' },
        carried_unproven: [],
        ac_coverage: 'Recorded from the supplied summary and evidence; one checked acceptance criterion was filed at clarify to satisfy the build gate\'s B-747 floor.',
      },
    });
    gates.push({ gate: 'plan', reason: GATE_REASONS.plan, landed: true });

    // ——— BUILD — brief-less SYSTEM/AGENT advance (Planned -> Built), mirrors every conducted run ——
    await advanceWorkflow(client, projectId, { task_id: taskId, activity: 'building' });
    gates.push({ gate: 'build', landed: true });

    // ——— RELEASE ———————————————————————————————————————————————————————————————————————————
    await composeAndAccept(client, projectId, userId, taskId, {
      reason: GATE_REASONS.release!,
      // pending_activity: null — Built->Deployed is SYSTEM-on-deploy-success, never this accept's own
      // doing (mirrors finish-work's own release compose — see skills/finish-work/SKILL.md).
      pendingActivity: null,
      decide: `Record what ${args.task_id} shipped, from the supplied summary and evidence (recorded, not conducted).`,
      frame: {
        kind: 'release',
        act: {
          repos: repos.length > 0 ? repos : [],
          pr_count: args.evidence.length,
          lands_in: 'merged-main',
          atomicity: repos.length > 1 ? 'together' : 'single',
          irreversible: [],
        },
        unproven: [],
        evidence_status: {
          proven_by_run: 0,
          walk_at_verify: 0,
          unproven: 0,
          total: 0,
          detail: 'Recorded walk — evidence linked from the supplied links, not independently re-verified at this accept.',
        },
        risk_classes: [], // overwritten by compose_brief from changedPaths (B-876) — authored value is never trusted.
      },
      changedPaths,
    });
    const releaseContent: GateSlotContent = {
      shipped: solving,
      lands_in: 'merged-main',
      prs: args.evidence.map((e) => ({ url: e.url, repo: e.repo })),
      unproven: [],
      evidence_status: 'Recorded walk — evidence linked, not independently re-verified.',
    };
    await writeGateSlot(client, {
      gate: 'release',
      content: releaseContent,
      target: { via: 'task', task_id: taskId },
      ratified_by: RATIFIED_BY_RECORDED,
    });
    gates.push({ gate: 'release', reason: GATE_REASONS.release, landed: true });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : (typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : JSON.stringify(err));
    return {
      task_id: taskId,
      eligibility,
      refused: false,
      gates,
      attestation_recorded: attestationRecorded,
      error:
        `recorded walk failed after landing ${gates.length} gate(s) (${gates.map((g) => g.gate).join(', ') || 'none'}) — ` +
        `${message} — resume by hand from the next unlanded gate, or via harmony conduct.`,
    };
  }

  return { task_id: taskId, eligibility, refused: false, gates, attestation_recorded: attestationRecorded };
}

// ——— B-1062 step 9: the MCP tool — the CLI (src/cli/commands/record.ts) and this tool drive the ———
// ——— exact SAME `runRecordedWalk` implementation above, never two. ————————————————————————————————

export interface RecordToolArgs {
  task_id: string;
  summary: string;
  evidence: Array<{ url: string; repo?: string; paths?: string[] }>;
  attest_walk?: string;
}

export const recordTool = {
  name: 'record',
  description:
    "B-1062 — walk a non-conducted ticket's gates (clarify -> decompose -> design -> plan -> build -> " +
    'release) from a human-supplied summary + evidence links, with ZERO worker legs — producing the ' +
    "same gate-slot/knowledge-entry trail a conducted ticket would get, marked 'recorded, not " +
    "conducted' (ratified_by: 'recorded' on every gate slot; agent-on-behalf:human-recorded provenance " +
    'on every knowledge write). Refuses BEFORE any write if any of five eligibility items ' +
    '(multi-repo, migration, auth/shared-core/irreversible-destructive risk, single-sentence-statable ' +
    'change, a 5+ minute verify-walk attestation) fails or is unattested — the ticket is left ' +
    'byte-identical on a refusal. The verify-walk item is NEVER auto-passed: supply `attest_walk` ' +
    '("<who/what was walked>") or it reports unattested and the walk refuses. On a genuine mid-walk ' +
    'failure, reports exactly which gates already landed (never a silent half-apply) so a human can ' +
    'resume by hand, or via `create_conduction`/`harmony conduct` instead. `evidence` entries carry ' +
    '`repo`/`paths` when already known (e.g. from `gh pr diff`); omit them and this tool evaluates ' +
    'eligibility from `url` alone.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)' },
      summary: { type: 'string', description: 'A one-sentence-statable account of the change this ticket records' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            repo: { type: 'string', description: "owner/repo, when already known" },
            paths: { type: 'array', items: { type: 'string' }, description: 'Changed file paths this evidence touches, when already known' },
          },
          required: ['url'],
        },
        description: 'Evidence links backing the recorded change (e.g. merged PR URLs).',
      },
      attest_walk: {
        type: 'string',
        description: 'Attest a 5+ minute verify walk — who/what was walked. Never auto-passed; omit to leave this eligibility item UNATTESTED (which refuses the walk).',
      },
    },
    required: ['task_id', 'summary', 'evidence'],
  },
};

export async function recordToolHandler(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: RecordToolArgs,
): Promise<RecordWalkResult> {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.summary?.trim()) throw new Error('summary is required');
  return runRecordedWalk(client, projectId, userId, {
    task_id: args.task_id,
    summary: args.summary,
    evidence: args.evidence ?? [],
    attest_walk: args.attest_walk,
  });
}

// P3: Brief substrate + command set (gate-ui-conductor §3, §4). The structured doc is canonical; the
// Markdown blob is DERIVED by renderBrief(). The §3.2 disciplines are a mechanical lint over the same
// canonical doc — so what's checked is exactly what's rendered.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import { detectRiskClasses } from './risk-class.js';
import type { AcceptanceEventPayloadItem } from './acceptance-events.js';
import { slugRef } from './payload-refs.js';

export interface BriefItem {
  /** §3.2 sort: a decision (always recommended), a content-input (only the human can supply it),
   *  or a derived-constraint (already fixed elsewhere — belongs in Context, never an ask). */
  kind: 'decision' | 'content-input' | 'derived-constraint';
  text: string;
  recommendation?: string;
  /** true when the decision is deferred behind research (the load-bearing-gap path). */
  deferred?: boolean;
}

export interface BriefAlternative {
  option: string;
  rejection: string;
}

// ——— B-876: the per-gate FRAME ———————————————————————————————————————————————————————————————————
//
// The BLUF spine (decide / recommend / why / context / items) is a decision-memo schema and a good one.
// What it never had is a home for each gate's OWN must-have — the elements at decompose, the reach at
// design, the carried-unproven residue at plan, the landing act at release, the criteria ledger at
// verify — so those facts degraded into freeform `context[]` and then disappeared (measured across a
// 14-brief-per-gate corpus: docs/2026-07-31-gate-brief-reader-needs.md §3).
//
// `frame` is ONE optional, `kind`-discriminated field emitting ONE extra block, positioned per gate.
// Two invariants make it deployable warn-only:
//   1. A doc with NO frame renders exactly today's bytes — nothing in flight changes.
//   2. Every frame lint rule added here is a WARNING. `compose_brief` gains no new way to refuse, so
//      an unattended daemon leg can never hard-stop on a frame defect (§4.4 blast radius).
// The error flip is deliberately a LATER ticket, one gate at a time (§5 step 5).

/** plan.carried_unproven ≡ release.unproven — one shape, authored predictively, rendered at both gates. */
export interface Unproven { item: string; reason: string }

/** clarify.not_solving ≡ decompose's out-of-scope pointers. `lands` binds the brief to the disposition
 *  discipline: every exclusion resolves SOMEWHERE. `"nowhere — nobody is tracking this"` is an explicit,
 *  sanctioned value (§7#4) and is the highest-signal entry in the block, not an escape hatch. */
export interface Excluded { item: string; lands: string }

/** Release's executed-aware evidence counts (§8 item 5). Deliberately NOT a single string: B-745 shipped
 *  a non-functional RPC behind a test that was WRITTEN but never RAN, and "an unexecuted test is not weak
 *  evidence, it is zero evidence". The full per-AC ledger stays at verify; release gets the counts. */
export interface EvidenceSummary {
  /** ACs proven by a test that actually EXECUTED. */
  proven_by_run: number;
  /** ACs deliberately deferred to the verify runbook. */
  walk_at_verify: number;
  /** ACs in the `unproven[]` residue below. */
  unproven: number;
  total: number;
  detail?: string;
}

/** The iteration delta (round 2+ only). Each change is BOUND to the feedback it answers, so an
 *  "already reflected" claim has a falsifiable form. It renders BELOW the frame, never above it:
 *  the human approves the totality, never the diff (B-239/B-856). */
export interface RevisionBlock {
  round: number;
  changes: Array<{ change: string; responds_to: string }>;
}

/** The release topology — FIXED at plan (`frame.plan.landing`), EXECUTED at release (`frame.release.act`).
 *  One object both times, so the plan reader can be held to the topology they authorized. */
export interface LandingShape {
  repos: string[];
  pr_count: number;
  lands_in: 'staging' | 'production' | 'both' | 'merged-main';
  atomicity: 'single' | 'together' | 'ordered';
  /** REQUIRED when `atomicity === 'ordered'` — the lint warns when it is missing. */
  ordering?: string;
  /** `[]` is a meaningful, renderable answer ("nothing"). */
  irreversible: string[];
}

/** One row of verify's criteria ledger — the gate whose whole contract is "confirm reality against these
 *  criteria" rendered the criterion text in 0/14 briefs before this. */
export interface CriterionRow {
  ac_id: string;
  text: string;
  checked: boolean;
  disposition: 'walk' | 'blocked' | 'test-proven' | 'not-hand-checkable' | 'carried' | 'unproven';
  /** REQUIRED when `disposition === 'walk'` — a walk step the human cannot find is not a runbook. */
  step_ref?: string;
  blocked_reason?: string;
  carried_to?: string;
  backed_by?: string;
}

/** Design's three sub-tracks. Declared as its own alias rather than inlined: an indexed access like
 *  `GateFrame['track']` is illegal on a union whose other members carry no `track` key. */
export type DesignTrack = 'product-design' | 'technical-design' | 'ux-ui-design';

export interface DesignTrackEntry {
  track: DesignTrack;
  status: 'accepted' | 'this-brief' | 'pending' | 'not-required';
  /** REQUIRED (lint-warned) on a `not-required` entry: declaring a track away is a decision, not a fact. */
  note?: string;
}

/** The gate frame — one variant per framed gate. `stale-patch-review` and `revise-scope-review` are
 *  deliberately absent: n=1 and n=4 respectively, which cannot support a schema (§3.9, §7#6).
 *
 *  All six members are declared, including `clarify`; the clarify AUTHORING lives in its own ticket, so
 *  `harmony-clarify` does not populate this yet. The renderer needs the member regardless — a variant the
 *  type cannot express is a variant the render cannot position. */
export type GateFrame =
  // `solving` is the OUTCOME paragraph — what becomes true for the product when this ships, in product
  // terms. NEVER a restatement of the problem: briefs restate pain well and never state the outcome
  // (§8 item 2). Altitude per §4.0 — judgeable without the repo open.
  | { kind: 'clarify'; solving: string; in_scope: string[]; not_solving: Excluded[] }
  | {
      kind: 'decompose';
      elements: Array<{ text: string; surface?: string; covers?: string }>;
      coverage: string;
      existing_children_checked: boolean;
    }
  | {
      kind: 'design';
      track: DesignTrack;
      tracks: DesignTrackEntry[];
      /** `[]` is a real answer ("this reaches nothing beyond the ticket"); an ABSENT key is not. */
      reach: string[];
      not_reopened?: string[];
      derisk?: { run: string[]; not_run: string[] };
      /** Product track only — the AC manifest this accept files. */
      files_on_accept?: string[];
    }
  | {
      kind: 'plan';
      scope: { repos: string[]; surfaces: string[]; has_migration: boolean };
      /** Renders under its own **Plan:** heading, between Why and You-need-to. */
      steps: string[];
      attestation: { base_verified: string; derisked_by_running?: string };
      /** The KEY must be present; `[]` = explicitly none. Absence and "none" are different claims. */
      carried_unproven: Unproven[];
      ac_coverage: string;
      /** Lint-warned as REQUIRED when the scope names more than one repo or carries a migration (§8 item 6). */
      landing?: LandingShape;
      design_delta?: string;
    }
  | {
      kind: 'release';
      act: LandingShape;
      unproven: Unproven[];
      evidence_status: EvidenceSummary;
      /** PATH-DERIVED FROM THE DIFF, and computed at compose — `composeBrief` overwrites whatever the
       *  skill authored here (B-876 step 7). No diff ⇒ `[]`, never a prose guess. This is NOT the B-516
       *  carried-from-gates signal, which is a different, non-diff-derived signal and still rides prose. */
      risk_classes: string[];
      pr_review_state?: string;
    }
  | {
      kind: 'verify';
      environment: 'staging' | 'production' | 'merged-main' | 'local';
      criteria: CriterionRow[];
      exempt_reason?: string;
      evidence_status: string;
      bounded_accept?: { open_ac_ids: string[]; closes_when: string };
    };

/** The `reason` each frame variant belongs to — the render is positional, the lint is the matcher. */
export const FRAME_KIND_FOR_REASON: Record<string, GateFrame['kind']> = {
  'clarification-draft': 'clarify',
  'decomposition-proposal': 'decompose',
  'design-decision-draft': 'design',
  'plan-draft': 'plan',
  'release-decision-pending': 'release',
  'verification-ack-pending': 'verify',
};

/** The canonical structured brief (the BLUF skeleton as data). renderBrief() is its only renderer. */
export interface BriefDoc {
  decide: string;
  recommend?: { text: string; confidence?: 'high' | 'medium' | 'low'; cede?: boolean };
  why?: string[];
  alternatives?: BriefAlternative[];
  context?: string[];
  items: BriefItem[];
  research?: string[];
  load_bearing_gap?: boolean;
  tail?: string;
  /** B-810 — the promised structured writes this brief's ACCEPT will materialize, snapshotted verbatim
   *  into a `pending_acceptance_events` row (B-797) when accepted with no session running, then applied
   *  mechanically by `applyAcceptanceEventPayload` (acceptance-events.ts). NEVER rendered — purely a
   *  side-channel for the cross-session safety net; the rendered `doc` (decide/why/items/...) is what the
   *  human reads. Every item's `ref` MUST come from `slugRef` + `dedupeRefs` (payload-refs.ts) — a
   *  content-derived slug, never a positional index, so an unchanged item reproduces the identical ref
   *  across an in-place `iterate` recompose. Omitted or `[]` ⇒ nothing to auto-apply (e.g. decompose's
   *  "no split", or a gate not yet wired to author this shape) — `classifyPayload` in acceptance-events.ts
   *  treats an empty array as a legitimate zero-write accept, never a hollow-advance signal. */
  payload?: AcceptanceEventPayloadItem[];
  /** B-876 — the gate-specific frame. Optional forever: the corpus is permanently mixed (old briefs keep
   *  their bytes), so no consumer may treat a missing frame as malformed. */
  frame?: GateFrame;
  /** B-876 — the round-2+ iteration delta, rendered under the **On accept:** line. */
  revision?: RevisionBlock;
}

export interface BriefLintResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// §3.2 soft budget — TIER-AWARE (B-467). A flat ~300 cap false-flagged legitimately-larger briefs
// (a medium-tier brief hit 390w live); scale the budget by the brief's own structural size
// (items + alternatives) so the warning fires on bloat-for-tier, not mere length. Soft: warns,
// never fails — preserves the expose-expand-not-amputate convention.
// B-541: BASE raised 300->600 (founder-confirmed ~2× base) so briefs read as self-contained
// artifacts; MAX raised 700->1400 so the clamp doesn't re-squeeze normal complex briefs.
// B-660 re-tune (2026-07-06): measured five live contract-passing briefs against their tier
// budgets — 47–81% used (worst case 604/750). Measurement says no change: base 600, 75/unit,
// clamp 1400 all hold; the budget never pressured a legible brief toward density.
const WORD_BUDGET_BASE = 600;
const WORD_BUDGET_PER_UNIT = 75;   // unchanged
const WORD_BUDGET_MAX = 1400;

/** B-876 — the frame's STRUCTURAL size, in the same units the tier budget already counts.
 *
 *  Without this the change self-sabotages: a frame adds words but no `items`/`alternatives`, so the
 *  bloat warning would fire on exactly the briefs that improved — a 14-row verify ledger is DATA, not
 *  rambling, and the budget exists to stop rambling. Counts the renderable sub-elements per variant
 *  (elements / criteria rows / act steps / unproven entries and their siblings). Pure + exported so the
 *  calibration can be measured with exactly the shipped logic. */
export function frameUnits(frame?: GateFrame): number {
  if (!frame) return 0;
  switch (frame.kind) {
    case 'clarify':
      return (frame.in_scope?.length ?? 0) + (frame.not_solving?.length ?? 0);
    case 'decompose':
      return frame.elements?.length ?? 0;
    case 'design':
      return (
        (frame.tracks?.length ?? 0) +
        (frame.reach?.length ?? 0) +
        (frame.not_reopened?.length ?? 0) +
        (frame.derisk?.run.length ?? 0) +
        (frame.derisk?.not_run.length ?? 0) +
        (frame.files_on_accept?.length ?? 0)
      );
    case 'plan':
      return (
        (frame.steps?.length ?? 0) +
        (frame.carried_unproven?.length ?? 0) +
        landingUnits(frame.landing)
      );
    case 'release':
      return (frame.unproven?.length ?? 0) + landingUnits(frame.act);
    case 'verify':
      return frame.criteria?.length ?? 0;
    default:
      return 0;
  }
}

/** A landing/act block's own renderable steps: one per repo, plus one per irreversible item. */
function landingUnits(landing?: LandingShape): number {
  if (!landing) return 0;
  return (landing.repos?.length ?? 0) + (landing.irreversible?.length ?? 0);
}

/** Tier-aware soft word budget: base + per-unit × (items + alternatives + frame sub-elements), clamped. */
function softWordBudget(doc: BriefDoc): number {
  const units = doc.items.length + (doc.alternatives?.length ?? 0) + frameUnits(doc.frame);
  return Math.min(WORD_BUDGET_BASE + WORD_BUDGET_PER_UNIT * units, WORD_BUDGET_MAX);
}

export const DEFAULT_TAIL = 'Type `accept`, `edit`, `iterate <feedback>`, or `defer`.';

// B-874 — the stale-patch gate's command tail. The default tail is MISINFORMING there: on a
// `stale-patch-review` brief `defer` does not park the ticket, it REJECTS the patch — the stale flag
// clears anyway, the divergence is recorded, and the ticket proceeds on the retired decision. That is
// irreversible, so the human must read it at the moment of deciding. Emitted mechanically by the render
// (keyed on the gate reason), so no author can forget it and the wording cannot drift.
export const STALE_PATCH_TAIL =
  '`accept` applies this patch and clears the stale flag (state unchanged). `defer` REJECTS it — the flag clears anyway, the divergence is recorded, and the ticket proceeds on the retired decision; this is not a park and cannot be undone. Or `edit` / `iterate <feedback>`.';

// B-874 — the clarify gate's proposed-AC block heading. BYTE-STABLE FOREVER: older resolved briefs keep
// their rendered bytes, so changing this string would make new briefs disagree with the archive. The
// block itself is DERIVED from `doc.payload`'s acceptance_criterion items — the author no longer
// hand-writes it into context, so the promised writes and the rendered promise cannot diverge.
export const PROPOSED_ACS_HEADING = 'Proposed acceptance criteria (happy path) — filed on accept:';

// B-877 — the clarify gate's de-scope block heading (B-518). BYTE-STABLE FOREVER, for the same reason as
// the proposed-AC heading above: older resolved briefs keep their rendered bytes, so changing this string
// would make new briefs disagree with the archive. Unlike that heading, this block is NOT rendered here —
// it exists today only in skill prose (`harmony-clarify` authors it into `doc.context`, `harmony-decompose`
// reads it), which is exactly why the string needs a home in code: this constant is the single source a
// contract test can pin, so the prose and the archive cannot drift apart unnoticed.
export const DE_SCOPE_HEADING = 'De-scope — re-ticketed on accept:';

// B-866 — the heading for the payload-derived promise block, the generalisation of the clarify
// proposed-AC block above past `clarification-draft`. BYTE-STABLE FOREVER, for exactly the same reason:
// older resolved briefs keep the bytes they were rendered with. Every payload-bearing gate now renders
// its promise FROM THE PAYLOAD IT WILL EXECUTE, so the writes the human reads and the writes the accept
// performs cannot disagree at any gate — not just at clarify.
export const PROMISED_WRITES_HEADING = 'On accept, this brief files:';

// B-866 — the element-level ratification mark carried by a DERIVED knowledge entry (`renderEntry`).
// Deliberately NOT a trailing "not ratified" appendix: a blanket banner cannot tell a reader WHICH claim
// is unvetted, and an entry's whole value is that a later reader can lean on a specific claim. The mark
// rides the element itself; the construction stamp below explains it once.
export const NOT_RATIFIED_MARK = '⚠️ [NOT RATIFIED]';

/** B-866 — the sentence that DEFINES what an unmarked element means, carried in every stamp.
 *
 *  The mark and this line are ONE mechanism, not two. The entry marks only the EXCEPTIONS — a positive
 *  tick on every ratified element would bury the one signal that matters in noise — and that is only
 *  readable because the stamp says so. Reword either half alone and they silently stop referring to each
 *  other: the token becomes an unexplained glyph, or the convention describes a mark that no longer
 *  exists. So the convention INTERPOLATES the token rather than restating it, and
 *  `derivation-contract.test.ts` pins both literals AND that this line contains that token. */
export const RATIFICATION_CONVENTION =
  `Every element below appeared in that brief, except any marked ${NOT_RATIFIED_MARK}.`;

/** B-866 — the construction-provenance stamp every derived entry opens with. A reader must be able to
 *  tell a post-change (stamped) entry from the thousands of pre-change unstamped ones, so the
 *  "unmarked means ratified" convention is scoped to stamped entries ONLY and can never be read back
 *  onto the archive. */
export const ENTRY_PROVENANCE_PREFIX = 'Derived from the ratified brief';

/** The tail this gate reason owes the human, or undefined when the default one is correct. */
function tailForReason(reason: string | undefined): string | undefined {
  return reason === 'stale-patch-review' ? STALE_PATCH_TAIL : undefined;
}

// ——— B-660 legibility nudges (warn-only — same soft tier as the word budget) ———
// The legibility contract (skills/harmony-shared/brief-authoring.md) is not self-enforcing:
// B-550's design brief sat within the word budget and was still rejected as illegible. Two
// mechanical nudges catch its two highest-signal violations: over-long sentences ("one idea
// per sentence") and STACKED parentheticals (an aside inside an aside — B-550's signature;
// a per-sentence count would false-flag the common, legitimate two-asides sentence). Both run
// on the rendered blob AFTER stripping fenced code blocks, inline code spans, URLs, and
// template chrome (the `> Type accept…` tail and the rendered `- [ ]` item lines — structured
// field output, not authored prose), so `manage_subtasks(task_id)` can never read as a
// parenthetical and a long tool path never inflates a sentence.

/** Words per sentence over which the "one idea per sentence" nudge fires. Calibrated
 *  two-sided (B-660, 2026-07-06): five real contract-passing briefs must stay silent and a
 *  synthetic B-550 positive must fire. The starting 40 false-tripped two real briefs (45w
 *  and 48w units), so the threshold sits at 50 — the exact floor of B-550's documented
 *  "five-clause 50+ word sentences" failure signature. Closest passing negatives: 48w
 *  (BRIEF-5's plan step-list) and 45w (BRIEF-4's recommend clause). */
export const SENTENCE_WORD_LIMIT = 50;

export interface LegibilityStats {
  /** Sentence-ish units found in the stripped prose (newline- and .!?;-bounded). */
  sentenceCount: number;
  /** Word count of the longest unit — the calibration headroom signal. */
  maxSentenceWords: number;
  /** Units over SENTENCE_WORD_LIMIT, longest first. */
  longSentences: Array<{ words: number; excerpt: string }>;
  /** Parentheticals opened inside another parenthetical (per line; depth resets at newlines). */
  nestedParens: number;
  /** Immediately-adjacent parenthetical pairs — `)(` or `) (` — the other stacking form. */
  adjacentParens: number;
}

/** Drop everything the legibility nudges must never read: code, URLs, and template chrome. */
function stripForLegibility(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/`[^`\n]+`/g, ' ')               // inline code spans
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // markdown links: keep the text, drop the (target)
    .replace(/\(\s*https?:\/\/[^)]*\)/g, ' ') // parenthesized bare URLs
    .replace(/https?:\/\/\S+/g, ' ')          // bare URLs
    .split('\n')
    // Template chrome: the command tail (blockquote), rendered checkbox items (structured text —
    // recommendation fields joined by em-dashes, not authored prose sentences), and — B-876 — the
    // frame's structured output: Markdown table rows (verify's criteria ledger) and `**Label:**`
    // field lines. Without those two, the verify ledger would trip the sentence-length and
    // stacked-paren nudges on every framed brief, which is a false positive on data, not prose.
    //
    // ONE deliberate exemption: the `**Recommend…:**` line. It is authored prose, and it is the line
    // the B-660 calibration positive (the reconstructed B-550 brief) carries its long sentence and its
    // stacked parentheticals on — stripping it would silently retire the nudge at the exact spot it was
    // calibrated to fire. Every other `**Label:**` line the render emits is either a bare section
    // header (zero words) or mechanical field output.
    .filter(
      (line) =>
        !/^\s*>/.test(line) &&
        !/^\s*- \[[ xX]\]/.test(line) &&
        !/^\s*\|/.test(line) &&
        (!/^\s*\*\*[^*]+:\*\*/.test(line) || /^\s*\*\*Recommend\b/.test(line)),
    )
    .join('\n');
}

/** Word-ish tokens only — a bare `—` or `·` between spaces is not a word. */
function countProseWords(s: string): number {
  return s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** Measure the stripped prose for the two B-660 legibility nudges. Pure + exported so the
 *  calibration corpus can be measured with exactly the shipped logic. */
export function analyzeLegibility(content: string): LegibilityStats {
  const text = stripForLegibility(content);

  // Sentence units: newline-bounded, then split after terminal punctuation (. ! ?), a
  // semicolon, or a colon — a semicolon separates two ideas the way a period does, and a
  // colon hands off to an elaboration/step list (real plan briefs legitimately enumerate
  // "do X, do Y, do Z" after one). "Five clauses means five sentences" blesses the split.
  // Abbreviation artifacts ("e.g.") only shorten units, the safe direction for a warn-only
  // nudge. Em-dashes deliberately do NOT split: dash-glued clause-chains are the B-550
  // signature the nudge exists to catch.
  const sentences = text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?;:])\s+/))
    .map((s) => s.trim())
    .filter((s) => countProseWords(s) > 0);

  const measured = sentences.map((s) => ({ words: countProseWords(s), sentence: s }));
  const longSentences = measured
    .filter((m) => m.words > SENTENCE_WORD_LIMIT)
    .sort((a, b) => b.words - a.words)
    .map((m) => ({
      words: m.words,
      excerpt: m.sentence.split(/\s+/).slice(0, 8).join(' '),
    }));

  // Stacked parentheticals: NESTED — `(… (…) …)` — plus immediately-adjacent pairs `)(` /
  // `) (`. NEVER a per-sentence count (two separate asides in one sentence are legitimate).
  // Depth is tracked per line (brief prose never spans a parenthetical across lines), so one
  // unbalanced `(` can't cascade nesting onto every later line.
  let nestedParens = 0;
  let adjacentParens = 0;
  for (const line of text.split('\n')) {
    let depth = 0;
    let prevClose = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') {
        depth++;
        if (depth >= 2) nestedParens++;
        if (prevClose >= 0 && /^\s*$/.test(line.slice(prevClose + 1, i))) adjacentParens++;
      } else if (ch === ')') {
        if (depth > 0) depth--;
        prevClose = i;
      }
    }
  }

  return {
    sentenceCount: sentences.length,
    maxSentenceWords: measured.reduce((mx, m) => Math.max(mx, m.words), 0),
    longSentences,
    nestedParens,
    adjacentParens,
  };
}

/** Compose-time context the render needs but the canonical doc cannot carry (B-874): the gate `reason`
 *  this brief is being composed for, and the state transition its ACCEPT will actually apply.
 *  `composeBrief` resolves both before rendering; every field is optional so a bare 1-/2-arg call still
 *  renders exactly today's bytes. */
export interface BriefRenderContext {
  /** The gate reason (§6.5) — selects the reason-specific tail and the clarify proposed-AC block. */
  reason?: string;
  /** The resolved accept-transition: the row `pending_activity` matched in `workflow_transitions`.
   *  `null`/absent ⇒ accept advances no state. */
  accept?: { from: string | null; to: string } | null;
}

// ——— B-876: frame rendering ————————————————————————————————————————————————————————————————————
//
// Deterministic, and positional per gate. Two exceptions to "below Recommend", both deliberate:
//   * `clarify` renders ABOVE `## DECIDE:` — it is the only gate where the frame IS the artefact being
//     produced, so leading with the ask inverts the document.
//   * `release` renders BELOW DECIDE and ABOVE Recommend — the object of the decision must be named
//     before an opinion is offered about it (§4.2's one placement disagreement, kept rather than smoothed).
// Everything else renders after Recommend and before the **On accept:** line, so the revision block —
// which sits directly under On-accept — can never float above the frame.

/** A LandingShape as one operational sentence: fixed at plan, executed at release, same words both times. */
function renderLanding(landing: LandingShape): string {
  const repos = landing.repos?.length ? landing.repos.join(', ') : 'no repo named';
  const prs = `${landing.pr_count} pull request${landing.pr_count === 1 ? '' : 's'}`;
  const atomicity =
    landing.atomicity === 'ordered'
      ? `ordered${landing.ordering ? ` — ${landing.ordering}` : ''}`
      : landing.atomicity === 'together'
        ? 'landed together, not sequenced'
        : 'a single landing';
  return `${prs} across ${repos} — lands in ${landing.lands_in}, ${atomicity}`;
}

/** `[]` is a meaningful answer here, so an empty list renders the word rather than nothing at all. */
function renderIrreversible(landing: LandingShape): string {
  return landing.irreversible?.length ? landing.irreversible.join('; ') : 'nothing — every step is revertable';
}

/** ONE `Unproven` entry, in the words every projection uses for it. B-867 lifted this OUT of the block
 *  below (byte-for-byte — the block still adds the bullet) so `renderSlot` can land the same wording on
 *  the ticket without restating it. That is technical decision f0d55b23 applied to the third
 *  projection: structured once, rendered deterministically, no parallel rendering pipeline. */
function unprovenText(entry: Unproven): string {
  return `${entry.item} — ${entry.reason}`;
}

function renderUnprovenBlock(label: string, entries: Unproven[] | undefined): string[] {
  const list = entries ?? [];
  if (!list.length) return [`**${label}:** nothing`];
  return [`**${label} — ${list.length}:**`, ...list.map((u) => `- ${unprovenText(u)}`)];
}

/** The executed-aware evidence counts as ONE sentence — shared by the release frame's
 *  **Evidence (mechanical):** line and (B-867) the release slot's `evidence_status`. Same reason as
 *  `unprovenText`: one wording, two projections, never two copies. */
function evidenceSummaryText(ev: EvidenceSummary): string {
  return (
    `${ev.proven_by_run}/${ev.total} proven by a test that RAN · ` +
    `${ev.walk_at_verify} deferred to the verify runbook · ${ev.unproven} unproven` +
    `${ev.detail ? ` — ${ev.detail}` : ''}`
  );
}

const DISPOSITION_MARK: Record<CriterionRow['disposition'], string> = {
  walk: '✅ walk now',
  blocked: '⚠️ blocked',
  'test-proven': '🧪 test-proven',
  'not-hand-checkable': '🛈 not hand-checkable',
  carried: '🔁 carried',
  unproven: '❌ unproven',
};

/** One criterion row's disposition — mark, blocked-reason and carried-target included. Shared by the
 *  verify frame's ledger table and (B-867) the verify slot's `criteria[].disposition`: the durable
 *  section must say what the brief said, in the brief's own words. */
function dispositionLabel(row: CriterionRow): string {
  return (
    DISPOSITION_MARK[row.disposition] +
    (row.disposition === 'blocked' && row.blocked_reason ? ` — ${row.blocked_reason}` : '') +
    (row.disposition === 'carried' && row.carried_to ? ` to ${row.carried_to}` : '')
  );
}

/** Escape a pipe so a criterion containing one cannot break the ledger's table row. */
function cell(value: string | undefined): string {
  return (value ?? '—').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim() || '—';
}

/** The frame block for one gate, as Markdown lines (no trailing blank — the caller adds it). */
function renderFrame(frame: GateFrame): string[] {
  const out: string[] = [];
  switch (frame.kind) {
    case 'clarify': {
      out.push(`## SOLVING: ${frame.solving}`, '');
      if (frame.in_scope?.length) out.push('**In scope:**', ...frame.in_scope.map((e) => `- ${e}`), '');
      const excluded = frame.not_solving ?? [];
      out.push('**Not solving:**');
      if (excluded.length) out.push(...excluded.map((e) => `- ${e.item} — ${e.lands}`));
      else out.push('- nothing is being excluded — the whole problem is in scope');
      break;
    }
    case 'decompose': {
      const elements = frame.elements ?? [];
      out.push(`**The elements — ${elements.length}:**`);
      for (const el of elements) {
        const surface = el.surface ? ` — *${el.surface}*` : '';
        const covers = el.covers ? ` — covers ${el.covers}` : '';
        out.push(`- ${el.text}${surface}${covers}`);
      }
      if (!elements.length) out.push('- (none enumerated)');
      out.push('', `**Coverage:** ${frame.coverage}`);
      out.push(
        `**Existing children checked:** ${frame.existing_children_checked ? 'yes' : 'no — an existing child set was NOT checked'}`,
      );
      break;
    }
    case 'design': {
      const others = (frame.tracks ?? [])
        .filter((t) => t.track !== frame.track)
        .map((t) => `${t.track} ${t.status}${t.note ? ` (${t.note})` : ''}`);
      out.push(`**Track:** ${[frame.track, ...others].join(' · ')}`);
      const reach = frame.reach ?? [];
      if (reach.length) out.push('**Reach beyond this ticket:**', ...reach.map((r) => `- ${r}`));
      else out.push('**Reach beyond this ticket:** none — this decision reaches nothing outside the ticket');
      if (frame.not_reopened?.length) {
        out.push('**Not reopened here:**', ...frame.not_reopened.map((r) => `- ${r}`));
      }
      if (frame.derisk) {
        const run = frame.derisk.run?.length ? frame.derisk.run.join('; ') : 'nothing';
        const notRun = frame.derisk.not_run?.length ? frame.derisk.not_run.join('; ') : 'nothing load-bearing outstanding';
        out.push(`**De-risked by running:** ${run}`, `**Not run:** ${notRun}`);
      }
      if (frame.files_on_accept?.length) {
        out.push('**Files on accept:**', ...frame.files_on_accept.map((f) => `- ${f}`));
      }
      break;
    }
    case 'plan': {
      const scope = frame.scope ?? { repos: [], surfaces: [], has_migration: false };
      const repos = scope.repos?.length ? scope.repos.join(', ') : 'no repo named';
      const surfaces = scope.surfaces?.length ? ` — ${scope.surfaces.join(', ')}` : '';
      out.push(`**Touches:** ${repos}${surfaces}. Migration: ${scope.has_migration ? 'yes' : 'no'}.`);
      out.push(`**Base verified:** ${frame.attestation?.base_verified ?? '(not attested)'}`);
      if (frame.attestation?.derisked_by_running) {
        out.push(`**De-risked by running:** ${frame.attestation.derisked_by_running}`);
      }
      out.push(...renderUnprovenBlock('Carried into build unproven', frame.carried_unproven));
      out.push(`**Covers:** ${frame.ac_coverage}`);
      if (frame.landing) {
        out.push(`**Landing:** ${renderLanding(frame.landing)}`, `**One-way in this:** ${renderIrreversible(frame.landing)}`);
      }
      if (frame.design_delta) out.push(`**Design delta:** ${frame.design_delta}`);
      break;
    }
    case 'release': {
      // Defensive: `act` is lint-warned rather than lint-refused, so a doc CAN reach the render without
      // one. The render must degrade to a legible "not stated" line — a throw here would turn a
      // warn-only rule into a hard compose failure through the back door.
      if (frame.act) {
        out.push(`**This accept executes:** ${renderLanding(frame.act)}`);
        out.push(`**Lands in:** ${frame.act.lands_in}`);
        out.push(`**One-way in this:** ${renderIrreversible(frame.act)}`);
      } else {
        out.push('**This accept executes:** not stated — the landing sequence is missing from this brief.');
      }
      out.push(...renderUnprovenBlock('Live but unproven when this lands', frame.unproven));
      const risk = frame.risk_classes ?? [];
      out.push(`**Risk (path-derived from the diff):** ${risk.length ? risk.join(', ') : 'none'}`);
      const ev = frame.evidence_status;
      if (ev) out.push(`**Evidence (mechanical):** ${evidenceSummaryText(ev)}`);
      if (frame.pr_review_state) out.push(`**PR review state:** ${frame.pr_review_state}`);
      break;
    }
    case 'verify': {
      const rows = frame.criteria ?? [];
      const confirmable = rows.filter((r) => r.disposition === 'walk').length;
      out.push(
        `**Verifying against — ${rows.length} criteria on file · you can confirm ${confirmable} today**`,
        '',
      );
      if (rows.length) {
        out.push('| # | Criterion (as filed) | Disposition | Step | Backed by |', '|---|---|---|---|---|');
        rows.forEach((r, i) => {
          const disposition = dispositionLabel(r);
          out.push(`| ${i + 1} | ${cell(r.text)} | ${cell(disposition)} | ${cell(r.step_ref)} | ${cell(r.backed_by)} |`);
        });
        out.push('');
      } else if (frame.exempt_reason) {
        out.push(`This ticket carries no acceptance criteria of its own — ${frame.exempt_reason}`, '');
      }
      out.push(`**Covers:** ${frame.environment}`);
      out.push(`**Evidence (mechanical):** ${frame.evidence_status}`);
      if (frame.bounded_accept) {
        const ids = frame.bounded_accept.open_ac_ids?.length
          ? frame.bounded_accept.open_ac_ids.join(', ')
          : 'none';
        out.push(`**Bounded accept:** criteria left open — ${ids}. Closes when ${frame.bounded_accept.closes_when}`);
      }
      break;
    }
  }
  return out;
}

// ——— B-866: the shared section BODIES ————————————————————————————————————————————————————————————
//
// The single most important constraint in this change (technical decision f0d55b23): "a brief is
// structured once, rendered deterministically, and stored once — both surfaces display the exact same
// blob, no parallel rendering pipeline." So the ELEMENT formatters live here, exactly once, and BOTH
// projections call them: `renderBrief` wraps them in the brief's headings, `renderEntry` wraps the SAME
// strings in the entry's. One authored copy, projected twice. If an element's brief line and its entry
// line were ever produced by two different bits of code, the duplication this change exists to remove
// would simply have moved somewhere less visible.
//
// They are ELEMENT-level on purpose. `renderEntry` marks each projected element ratified-or-not by
// asking whether its text appears in the brief the human actually read — a question that is only
// mechanically answerable because both renders emit the identical string for the same element.

function whyLines(doc: BriefDoc): string[] {
  return (doc.why ?? []).map((w) => `- ${w}`);
}

function alternativeLines(doc: BriefDoc): string[] {
  return (doc.alternatives ?? []).map((a) => `- ${a.option} — ${a.rejection}`);
}

function contextLines(doc: BriefDoc): string[] {
  return (doc.context ?? []).map((c) => `- ${c}`);
}

function revisionLines(doc: BriefDoc): string[] {
  return (doc.revision?.changes ?? []).map((c) => `- ${c.change} — *answers: ${c.responds_to}*`);
}

function researchLines(doc: BriefDoc): string[] {
  return (doc.research ?? []).map((p, i) => `${i + 1}. ${p}`);
}

function planStepLines(frame: GateFrame): string[] {
  return frame.kind === 'plan' ? (frame.steps ?? []).map((step, i) => `${i + 1}. ${step}`) : [];
}

/** The `**Recommend…:**` line, confidence suffix and all — or undefined when the doc carries none. */
function recommendLine(doc: BriefDoc): string | undefined {
  if (!doc.recommend) return undefined;
  let suffix = '';
  if (doc.recommend.cede) suffix = ' (low confidence — this is a values call you should own)';
  else if (doc.recommend.confidence === 'low') suffix = ' (low confidence — see below)';
  else if (doc.recommend.confidence === 'medium') suffix = ' (moderate confidence)';
  else if (doc.recommend.confidence === 'high') suffix = ' (high confidence)';
  return `**Recommend${suffix}:** ${doc.recommend.text}`;
}

/** The rendered ask lines. `derived-constraint` items never render — the lint rejects them first. */
function itemLines(doc: BriefDoc): string[] {
  const out: string[] = [];
  for (const item of doc.items ?? []) {
    if (item.kind === 'content-input') {
      out.push(`- [ ] ${item.text} *(your input needed)*`);
    } else if (item.kind === 'decision') {
      const rec = !item.deferred && item.recommendation ? ` — *recommend: ${item.recommendation}*` : '';
      out.push(`- [ ] ${item.text}${rec}`);
    }
  }
  return out;
}

/** B-874 — clarify's proposed happy-path ACs, one line per `acceptance_criterion` payload item. */
function proposedAcLines(payload: AcceptanceEventPayloadItem[] | undefined): string[] {
  return (payload ?? [])
    .filter((p) => p.write_kind === 'acceptance_criterion' && typeof p.content === 'string' && p.content.trim().length > 0)
    .map((p) => `- ${p.content}`);
}

/** B-866 — one promise line per payload item, in the item's own terms. Returns null for an item that
 *  carries nothing renderable: a promise the reader cannot check is worse than no promise at all. */
function promisedWriteLine(item: AcceptanceEventPayloadItem): string | null {
  const text = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  switch (item.write_kind) {
    case 'acceptance_criterion': {
      const content = text(item.content);
      return content ? `- acceptance criterion — ${content}` : null;
    }
    case 'child_ticket': {
      const title = text(item.title);
      return title ? `- new child ticket — ${title}` : null;
    }
    case 'checklist_item': {
      const title = text(item.title);
      return title ? `- checklist item — ${title}` : null;
    }
    case 'ac_transfer': {
      const content = text(item.content);
      return content ? `- moves an acceptance criterion to ${text(item.target_child_ref) ?? '(unnamed child)'} — ${content}` : null;
    }
    case 'label_add':
      return `- label — ${text(item.label_name) ?? 'decision-only'}`;
    case 'knowledge_entry_content':
      return '- the linked decision entry, written from THIS brief (derived, never separately authored)';
    case 'gate_slot':
      // B-867 — CONTENT-FREE on purpose, exactly like the entry line above. `withDerivedGateSlot`
      // derives the slot from this same doc, so a promise that embedded the slot's content would
      // change the render that the content is derived from. Naming the section is the promise; the
      // section's own words are already on the page, in the frame this line points at.
      return `- the ${text(item.gate) ?? 'gate'} section on the ticket — this brief's ratified content, kept visible after the gate closes`;
    default:
      return null;
  }
}

/** B-866 — the promise block's lines. `skipAcceptanceCriteria` is set at `clarification-draft`, where
 *  the ACs already render under their own byte-stable heading and must not be listed twice. */
function promisedWriteLines(
  payload: AcceptanceEventPayloadItem[] | undefined,
  skipAcceptanceCriteria: boolean,
): string[] {
  return (payload ?? [])
    .filter((p) => !(skipAcceptanceCriteria && p.write_kind === 'acceptance_criterion'))
    .map(promisedWriteLine)
    .filter((line): line is string => line !== null);
}

/** Render the canonical doc to the §3.1 BLUF Markdown blob, deterministically.
 *  When `decisionRef` is present (B-674), the render mechanically appends the depth-pointer
 *  footer just above the command tail — the authoring agent no longer hand-writes it. A brief
 *  with no `decision_ref` correctly shows no pointer.
 *
 *  B-874 — `ctx` carries the compose-time facts the doc cannot know. When it is supplied the render also
 *  emits the **On accept:** spine line (what this accept actually does to the ticket's state), selects the
 *  gate-specific command tail, and derives the clarify proposed-AC block from `doc.payload`. When it is
 *  ABSENT (an old 1-/2-arg caller) none of that is emitted — the output is byte-identical to before.
 *
 *  B-866 — the payload-derived promise now extends past `clarification-draft`: every payload-bearing
 *  reason renders its promise from the payload its accept will execute. Still `ctx`-gated, and still
 *  byte-identical for a doc with no payload. */
export function renderBrief(doc: BriefDoc, decisionRef?: DecisionRef | null, ctx?: BriefRenderContext): string {
  const out: string[] = [];
  const frame = doc.frame;

  // B-876 — clarify is the ONLY gate whose frame precedes the ask: the problem statement IS the artefact
  // being produced, so leading with DECIDE would invert the document. Every other gate INHERITS the
  // problem, and porting this shape downstream would restate what the reader already has.
  if (frame?.kind === 'clarify') out.push(...renderFrame(frame), '');

  out.push(`## DECIDE: ${doc.decide}`, '');

  // B-876 — release's frame sits below DECIDE and ABOVE Recommend: at the one gate with a measured wrong
  // accept, the object of the decision must be named before an opinion is offered about it.
  if (frame?.kind === 'release') out.push(...renderFrame(frame), '');

  if (doc.load_bearing_gap) {
    // Research-first (§3.2): open with the research, defer the substantive recommendation — never buried.
    out.push("**Recommend:** I don't know enough yet — run the research below before deciding.", '');
    out.push('**Research first:**');
    out.push(...researchLines(doc));
    out.push('');
  } else {
    const recommend = recommendLine(doc);
    if (recommend) out.push(recommend, '');
  }

  // B-876 — every other frame renders after the recommendation and above the **On accept:** line, so the
  // revision block (which sits directly under On-accept) can never float above the frame.
  if (frame && frame.kind !== 'clarify' && frame.kind !== 'release') out.push(...renderFrame(frame), '');

  // B-874 — the spine line: what accepting this brief DOES to the ticket, stated in the brief itself.
  // It sits directly under the recommendation and above the reasoning, because it is the consequence the
  // human is actually ratifying. Only emitted when the caller supplied compose-time context: a 1-/2-arg
  // call (tests, any pre-B-874 caller) renders exactly today's bytes.
  if (ctx) {
    if (ctx.accept) {
      out.push(
        ctx.accept.from
          ? `**On accept:** advances ${ctx.accept.from} → ${ctx.accept.to}`
          : `**On accept:** advances to ${ctx.accept.to}`,
        '',
      );
    } else {
      out.push('**On accept:** no state change', '');
    }
  }

  // B-876 — the iteration delta, directly under the On-accept line and NEVER above the frame. The human
  // approves the totality; the diff is shown so an "already reflected" claim has a falsifiable form.
  if (doc.revision?.changes?.length) {
    out.push('**Changed this round:**', ...revisionLines(doc), '');
  }

  if (doc.why?.length) {
    out.push('**Why:**', ...whyLines(doc), '');
  }
  if (doc.alternatives?.length) {
    out.push('**Alternatives:**', ...alternativeLines(doc), '');
  }
  if (doc.context?.length) {
    out.push('**Context:**', ...contextLines(doc), '');
  }

  // B-874 — clarify's proposed happy-path acceptance criteria, DERIVED from the payload that accept will
  // actually file (`doc.payload`, B-810) instead of hand-written prose that could disagree with it. Part
  // of the Context region: it is context the reader needs to judge the clarification, not an ask.
  //
  // B-866 generalises the invariant this comment states. The clarify block is UNCHANGED (byte-stable
  // heading, byte-stable lines); every OTHER promised write — at clarify AND at every other payload-
  // bearing gate — now renders under PROMISED_WRITES_HEADING from the same payload. A gate that promises
  // writes the reader never sees is the same defect as prose that disagrees with them.
  if (ctx) {
    const isClarify = ctx.reason === 'clarification-draft';
    if (isClarify) {
      const criteria = proposedAcLines(doc.payload);
      if (criteria.length) out.push(PROPOSED_ACS_HEADING, ...criteria, '');
    }
    const promised = promisedWriteLines(doc.payload, isClarify);
    if (promised.length) out.push(PROMISED_WRITES_HEADING, ...promised, '');
  }

  // B-876 — the plan's own steps, under their own heading between the reasoning and the ask. The plan gate
  // is the one whose artefact had no home at all: in 6/14 briefs the plan rendered under **Context:**, the
  // block that everywhere else means "no action needed", while the checkbox degenerated into a pointer.
  if (frame?.kind === 'plan' && frame.steps?.length) {
    out.push('**Plan:**', ...planStepLines(frame), '');
  }

  if (doc.items.length) {
    out.push('**You need to:**', ...itemLines(doc), '');
  }

  if (decisionRef) {
    // B-674: emit the depth-pointer mechanically whenever the brief carries a decision_ref — the
    // author no longer hand-writes it, so the wording can never drift.
    out.push('_This brief is a summary — fuller depth lives in the linked decision entry._', '');
  }

  // Tail precedence (B-874): an explicit `doc.tail` (the author's deliberate override) wins, then the
  // gate-specific tail, then the default.
  out.push(`> ${doc.tail ?? tailForReason(ctx?.reason) ?? DEFAULT_TAIL}`);
  return out.join('\n');
}

// ——— B-866: the SECOND projection of the one authored source ——————————————————————————————————————
//
// The problem this closes: the composing agent used to hand-author the brief prose AND the knowledge
// entry prose in sequence; the human ratified the BRIEF; the accept promoted the ENTRY. Two copies, one
// vetted. Nothing enforced that they matched, and nothing could — they were separately authored.
//
// So the structured `BriefDoc` the human ratifies is the SINGLE authored prose source. The human reads
// `renderBrief(doc)`; the accept promotes `renderEntry(doc)`. Both are mechanical projections of one
// object, built from the SAME element formatters above. There is one copy, projected twice.

/** Compose-time context for the entry projection. Extends the brief's own render context because the
 *  entry is derived from the brief the human read — the ratification test literally re-renders it. */
export interface EntryRenderContext extends BriefRenderContext {
  /** The brief's decision_ref, so the oracle re-renders the human's exact blob (depth-pointer included). */
  decisionRef?: DecisionRef | null;
  /** The construction date. Injectable so the projection is deterministic under test; defaults to now. */
  now?: Date;
}

/** The construction-provenance line every derived entry opens with (see ENTRY_PROVENANCE_PREFIX). */
export function entryProvenanceStamp(ctx?: EntryRenderContext): string {
  const when = (ctx?.now ?? new Date()).toISOString().slice(0, 10);
  const gate = ctx?.reason ? ` at the ${ctx.reason} gate` : '';
  return (
    `_${ENTRY_PROVENANCE_PREFIX}${gate}, ${when} — a mechanical projection of the brief the human ` +
    `approved, not separately authored prose. ${RATIFICATION_CONVENTION}_`
  );
}

// B-902 — the entry-only decided form. `itemLines` (above) renders the STILL-OPEN ask — a live
// checkbox with a "recommend:" label — because it is read by a human who has not decided yet. An
// entry is read AFTER the decision was made, so showing that same open-ask framing misrepresents it:
// a reader sees a settled question dressed as a pending one. This formatter is entry-ONLY; itemLines
// itself, and every call site of it inside `renderBrief`, stay byte-identical — reusing this formatter
// for the brief (or changing itemLines to always emit decided form) would show "Decided:" on an ask the
// human has not yet ratified, which is worse than the defect this closes.
//
// A ticked line alone (`- [x] <text>`) covers a `content-input` ask (the human supplied it; there is no
// "recommendation" to report) and a `decision` item with no adopted recommendation (deferred behind
// research, or authored without one). A `decision` item that DID carry a recommendation gets it named —
// `- [x] <text> — Decided: <recommendation>` — so the record states what was actually decided, not just
// that *something* was.
function decidedItemLine(item: BriefItem): string {
  const decided = item.kind === 'decision' && !item.deferred && item.recommendation
    ? ` — Decided: ${item.recommendation}`
    : '';
  return `- [x] ${item.text}${decided}`;
}

/** The entry's decided-form ask lines, PAIRED with the item each line came from — the ratification
 *  check below needs the item (its text/recommendation), not the rendered line, because a decided-form
 *  line never appears verbatim in the brief (the brief renders the same item as an open ask). Mirrors
 *  `itemLines`' own kind filter: a `derived-constraint` item never renders (the lint rejects it first). */
function decidedItems(doc: BriefDoc): Array<{ item: BriefItem; line: string }> {
  const out: Array<{ item: BriefItem; line: string }> = [];
  for (const item of doc.items ?? []) {
    if (item.kind === 'content-input' || item.kind === 'decision') {
      out.push({ item, line: decidedItemLine(item) });
    }
  }
  return out;
}

/**
 * Project the ratified doc into the knowledge entry the accept promotes.
 *
 * NOT a second renderer: every element line below comes from the same formatter `renderBrief` uses, and
 * the ratification oracle is `renderBrief` itself. What differs is only the WRAPPING — an entry is read
 * later, by someone who was not at the gate, so it leads with the decision rather than the ask, drops
 * the command tail and the depth-pointer (a pointer back to its own source), and marks provenance. B-902
 * additionally drops the whole promised-writes block (an entry describing its own filing has zero
 * durable value once the write already landed) and renders the ratified asks in DECIDED form — ticked,
 * or naming the recommendation actually adopted — never as a live, still-open checkbox.
 *
 * RATIFICATION IS ELEMENT-LEVEL, and it is measured, not declared: an element is ratified iff its text
 * appears in the blob the human actually read. That is why the recommendation of a `load_bearing_gap`
 * brief comes out marked — the brief showed "I don't know enough yet" in its place, so the human never
 * ratified it — and why research prompts authored without the gap flag come out marked too.
 *
 * B-902 — item ratification is CONTENT-level, not literal-line: a decided-form line never appears
 * verbatim in the brief by construction (the brief renders the same item as an open ask), so checking
 * for the rendered ENTRY line would mark every ratified item NOT RATIFIED. Instead each item's own text
 * and (when the decided line shows one) its recommendation are checked against the brief separately —
 * exactly what `itemLines` decided whether to render, so an item deferred behind research or authored
 * without a shown recommendation is correctly unmarked, and an item whose recommendation the brief never
 * displayed is correctly marked.
 */
export function renderEntry(doc: BriefDoc, ctx?: EntryRenderContext): string {
  const briefContent = renderBrief(doc, ctx?.decisionRef ?? null, ctx);
  // Blank text is vacuously ratified: there is no claim in it to vet.
  const isRatified = (text: string): boolean => !text.trim() || briefContent.includes(text);
  const mark = (text: string): string => (isRatified(text) ? text : `${text} ${NOT_RATIFIED_MARK}`);
  const markAll = (lines: string[]): string[] => lines.map(mark);
  // CONTENT-level match, not literal-line: an item is ratified iff its OWN CONTENT — text, and a
  // recommendation when it carries one — appeared in the brief, independent of whether the decided-form
  // line happens to display that recommendation. A deferred decision item (or a content-input item)
  // that still carries a `recommendation` the brief never showed is correctly flagged even though its
  // decided-form line displays no "Decided:" suffix to hang the mark on — the mark still names a real,
  // unvetted claim the doc carries.
  const isItemRatified = (item: BriefItem): boolean =>
    isRatified(item.text) && isRatified(item.recommendation ?? '');

  const out: string[] = [entryProvenanceStamp(ctx), ''];

  // The decision itself, first — an entry is read for what was decided, not for what was asked.
  out.push(`**Decision:** ${doc.recommend ? mark(doc.recommend.text) : '(the brief made no recommendation)'}`, '');
  out.push(`**Question put to the human:** ${mark(doc.decide)}`, '');

  if (doc.frame) out.push(...markAll(renderFrame(doc.frame)), '');

  const research = researchLines(doc);
  if (research.length) out.push('**Research first:**', ...markAll(research), '');

  const why = whyLines(doc);
  if (why.length) out.push('**Why:**', ...markAll(why), '');
  const alternatives = alternativeLines(doc);
  if (alternatives.length) out.push('**Alternatives:**', ...markAll(alternatives), '');
  const context = contextLines(doc);
  if (context.length) out.push('**Context:**', ...markAll(context), '');

  const isClarify = ctx?.reason === 'clarification-draft';
  if (isClarify) {
    const criteria = proposedAcLines(doc.payload);
    if (criteria.length) out.push(PROPOSED_ACS_HEADING, ...markAll(criteria), '');
  }
  // B-902 — the promised-writes block is DROPPED here, entirely (heading and lines both): it describes
  // what THIS brief's accept files, which is self-referential furniture once the entry it produced is
  // the thing being read. `renderBrief` keeps rendering it — the brief IS the still-open ask, and a
  // human deciding whether to accept needs to see what accepting will do.

  if (doc.frame?.kind === 'plan') {
    const steps = planStepLines(doc.frame);
    if (steps.length) out.push('**Plan:**', ...markAll(steps), '');
  }

  const items = decidedItems(doc);
  if (items.length) {
    out.push(
      '**Ratified asks:**',
      ...items.map(({ item, line }) => (isItemRatified(item) ? line : `${line} ${NOT_RATIFIED_MARK}`)),
      '',
    );
  }

  const changes = revisionLines(doc);
  if (changes.length) out.push('**Changed in the final round:**', ...markAll(changes), '');

  return out.join('\n').trimEnd();
}

// ——— B-867: the THIRD projection — what the TICKET keeps ————————————————————————————————————————
//
// `renderBrief` is what the human READS. `renderEntry` is what the accept PROMOTES. `renderSlot` is
// what the ticket KEEPS: the gate's ratified content, landed on the ticket's own face and still legible
// months later, when the brief that carried it has long since scrolled out of the history.
//
// Canonicity was settled by B-866 — the structured `doc` the human ratifies is the single authored
// source and every downstream artefact is a mechanical projection of it. This CONSUMES that decision
// and never re-opens it. So the slot is derived from the same doc (its typed `frame` above all) through
// the SAME element formatters the other two projections call — `renderLanding`, `unprovenText`,
// `evidenceSummaryText`, `dispositionLabel`. Wording produced by a second bit of code would be exactly
// the duplication B-866 removed, moved one surface along (technical decision f0d55b23).
//
// BORN WITHOUT three things `renderEntry` carries, deliberately — a slot must not inherit them:
//   * NO ratification oracle and no NOT-RATIFIED marks. A slot is only ever written BY an accept, so
//     every word in it is ratified by construction; re-deriving that per element would be theatre.
//   * NO `itemLines` and no **Ratified asks:** block (B-902 is removing that shape from entries too).
//     The asks are the gate's transaction, not the ticket's durable answer, and an unticked `- [ ]` on
//     a permanent section reads as open work forever.
//   * NO promised-writes heading and NO provenance stamp. The promised writes have already landed by
//     the time a slot exists, and provenance (`ratified_by` / `ratified_at`) belongs to the WRITE, not
//     to the projection — it is stamped by the write path (see gate-slots.ts), never authored here.
//
// KEY PRESENCE IS THE SEMANTIC, and it is preserved at both levels. A gate that never ratified gets no
// slot at all; a gate that ratified an EMPTY answer gets a slot whose field is `[]`. So a key is
// emitted below IFF the frame actually carries it: an absent frame key stays absent, an empty list
// stays an empty list. Collapsing the two would turn "we decided nothing is excluded" back into
// "nobody ever asked" — the one failure this whole ticket exists to prevent.

/** The gates that land a durable section on the ticket. Three today; the storage key is open (the DB
 *  puts no enum CHECK on it) so a fourth gate stores and displays without a web deploy. */
export type GateSlotName = 'clarify' | 'release' | 'verify';
export const GATE_SLOT_NAMES: readonly GateSlotName[] = ['clarify', 'release', 'verify'];

/** Which gate reason's brief carries each slot's content — the brief `renderSlot` must be given. */
export const REASON_FOR_GATE_SLOT: Record<GateSlotName, string> = {
  clarify: 'clarification-draft',
  release: 'release-decision-pending',
  verify: 'verification-ack-pending',
};

/** A slot's `content` — the per-gate field map the ticket lays out. Deliberately an open record: the
 *  displaying surface renders a field it does not recognise under a generic label rather than dropping
 *  it (B-875's rule one layer down), so a key added here degrades legibly instead of vanishing. */
export type GateSlotContent = Record<string, unknown>;

/** One criteria-ledger row in the shape the durable section lays out. `how` composes the two backing
 *  facts the frame keeps in separate columns — the runbook step that discharges the criterion, and
 *  whatever already proves it — because the ticket's section is one line per criterion, not a
 *  four-column table. Omitted entirely when the row states neither: an absent key renders nothing,
 *  which is the honest answer, where an empty string would render an empty dash. */
function criterionSlotRow(row: CriterionRow): Record<string, unknown> {
  const how = [row.step_ref ? `runbook step ${row.step_ref}` : null, row.backed_by ?? null]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' · ');
  const out: Record<string, unknown> = { text: row.text, disposition: dispositionLabel(row) };
  if (row.ac_id !== undefined) out.ac_id = row.ac_id;
  if (how) out.how = how;
  return out;
}

/**
 * Project the ratified doc into ONE gate's durable ticket section.
 *
 * Returns `null` when this doc carries no frame of the gate's own kind — there is nothing ratified in a
 * shape the section can lay out, and writing an empty slot would CLAIM the gate ratified an empty
 * answer. `null` means "do not write a slot"; `{}` (a frame present but answering nothing) means "the
 * gate ratified, and its answer is empty". Those are different, and every caller must keep them so.
 */
export function renderSlot(doc: BriefDoc, gate: GateSlotName): GateSlotContent | null {
  const frame = doc.frame;
  if (!frame) return null;
  const out: GateSlotContent = {};

  switch (gate) {
    case 'clarify': {
      if (frame.kind !== 'clarify') return null;
      if (frame.solving !== undefined) out.solving = frame.solving;
      if (frame.in_scope !== undefined) out.in_scope = [...frame.in_scope];
      if (frame.not_solving !== undefined) {
        out.not_solving = frame.not_solving.map((e) => ({ item: e.item, lands: e.lands }));
      }
      return out;
    }
    case 'release': {
      if (frame.kind !== 'release') return null;
      // `act` is lint-WARNED rather than refused, so a release doc can legitimately reach here without
      // one. Omit both keys rather than inventing a landing — the section then shows what it has.
      if (frame.act) {
        out.shipped = renderLanding(frame.act);
        out.lands_in = frame.act.lands_in;
      }
      if (frame.unproven !== undefined) out.unproven = frame.unproven.map(unprovenText);
      if (frame.evidence_status !== undefined) {
        out.evidence_status = evidenceSummaryText(frame.evidence_status);
      }
      // `prs` is NOT derivable from the doc — the PR references live on the task
      // (`field_values.build_pr`, whose family gate-slots.ts pins). The write path adds that key; this
      // projection never guesses it.
      return out;
    }
    case 'verify': {
      if (frame.kind !== 'verify') return null;
      if (frame.environment !== undefined) out.environment = frame.environment;
      if (frame.criteria !== undefined) out.criteria = frame.criteria.map(criterionSlotRow);
      if (frame.evidence_status !== undefined) out.evidence_status = frame.evidence_status;
      if (frame.exempt_reason !== undefined) out.exempt_reason = frame.exempt_reason;
      if (frame.bounded_accept !== undefined) {
        out.bounded_accept = {
          open_ac_ids: [...(frame.bounded_accept.open_ac_ids ?? [])],
          closes_when: frame.bounded_accept.closes_when,
        };
      }
      return out;
    }
    default:
      return null;
  }
}

/** Task-derived context the lint needs but cannot see in the doc alone (B-732). */
export interface BriefLintContext {
  /** The gate reason this brief is being composed for. */
  reason?: string;
  /** `tasks.field_values.build_pr` — the B-722 pushed-PR record, when one exists. */
  buildPr?: { author_is_bot?: boolean; pr_url?: string; pr_number?: number } | null;
  /** B-876 — EVERY pull request readable from the task's `field_values`, defensively (see
   *  `readBuildPrReferences`). Drives the warn-only "the release brief names no PR" rule. */
  buildPrRefs?: BuildPrReference[];
  /** B-877 — the iteration this brief WILL have once the compose lands (post-increment), never the one
   *  it had. A first compose is 1; an in-place iterate over an active brief at N is N+1. Drives the
   *  warn-only "a round-2+ brief carries no `doc.revision`" rule, which must stay silent on a first
   *  compose. Absent when the caller supplies no iteration, and absence warns on nothing. */
  iteration?: number;
}

/** B-876 — one pull request read out of a task's `field_values`. `key` is the path it was found at
 *  (`build_pr`, `build_pr.web_pr`, `build_pr_plugin`, …) so the brief can name WHICH reference it means. */
export interface BuildPrReference {
  key: string;
  pr_url?: string;
  pr_number?: number;
  author_is_bot?: boolean;
  branch?: string;
  head_sha?: string;
}

/** Is this value shaped like a pull-request record? PRESENCE of a url or a number, nothing more —
 *  `work_branch` (B-844's sibling key) carries neither, so it is correctly not a PR. */
function isPrShaped(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.pr_url === 'string' || typeof v.pr_number === 'number';
}

function toPrReference(key: string, value: Record<string, unknown>): BuildPrReference {
  const ref: BuildPrReference = { key };
  if (typeof value.pr_url === 'string') ref.pr_url = value.pr_url;
  if (typeof value.pr_number === 'number') ref.pr_number = value.pr_number;
  if (typeof value.author_is_bot === 'boolean') ref.author_is_bot = value.author_is_bot;
  if (typeof value.branch === 'string') ref.branch = value.branch;
  if (typeof value.head_sha === 'string') ref.head_sha = value.head_sha;
  return ref;
}

/**
 * B-876 — read every pull request a task's `field_values` can yield, DEFENSIVELY.
 *
 * `field_values.build_pr` has no enforced shape and three divergent forms exist on the live board:
 *   * B-740 — SIBLING KEYS: `build_pr` plus a separate top-level `build_pr_plugin`.
 *   * B-743 — NESTED: `build_pr` carrying its own `web_pr` / `plugin_pr` children.
 *   * B-844 — `build_pr` plus a sibling `work_branch`, which is NOT a PR at all.
 *
 * So the contract is: NAME WHAT CAN BE READ, OMIT WHAT CANNOT, AND NEVER THROW. A shape this function
 * does not understand yields fewer references, never an exception — a brief compose must not die because
 * a build wrote an unfamiliar artefact. Nesting is one level deep on purpose: that is the only nesting
 * observed, and an unbounded walk would start inventing references out of arbitrary objects.
 */
export function readBuildPrReferences(fieldValues: unknown): BuildPrReference[] {
  const refs: BuildPrReference[] = [];
  try {
    if (!fieldValues || typeof fieldValues !== 'object' || Array.isArray(fieldValues)) return refs;
    const fv = fieldValues as Record<string, unknown>;
    const seen = new Set<string>();
    const push = (key: string, value: unknown) => {
      if (!isPrShaped(value)) return;
      const ref = toPrReference(key, value);
      const identity = `${ref.pr_url ?? ''}#${ref.pr_number ?? ''}`;
      if (seen.has(identity)) return; // B-743 repeats the parent's own PR inside `plugin_pr`
      seen.add(identity);
      refs.push(ref);
    };
    // `build_pr` first (the primary reference every release path knows how to land), then its nested
    // children, then any OTHER PR-shaped top-level key (B-740's `build_pr_plugin`, B-715's `companion_pr`).
    const primary = fv.build_pr;
    push('build_pr', primary);
    if (primary && typeof primary === 'object' && !Array.isArray(primary)) {
      for (const [k, v] of Object.entries(primary as Record<string, unknown>)) {
        push(`build_pr.${k}`, v);
      }
    }
    for (const [k, v] of Object.entries(fv)) {
      if (k === 'build_pr') continue;
      push(k, v);
    }
  } catch {
    return refs; // never throw — a malformed field_values degrades to "nothing readable"
  }
  return refs;
}

/** The PRIMARY `build_pr` record, read defensively for the B-732 approval rule. Unchanged semantics:
 *  a task with no readable `build_pr` yields undefined and the rule simply does not apply. */
export function readBuildPr(fieldValues: unknown): BriefLintContext['buildPr'] {
  try {
    if (!fieldValues || typeof fieldValues !== 'object' || Array.isArray(fieldValues)) return undefined;
    const value = (fieldValues as Record<string, unknown>).build_pr;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as BriefLintContext['buildPr'];
  } catch {
    return undefined;
  }
}

/** Does the rendered brief actually tell the human an approval is REQUIRED? (B-732)
 *
 *  Generous about phrasing, strict about meaning. An earlier draft accepted "approv*" anywhere
 *  alongside "github" — which every release brief satisfies trivially, because the PR URL itself
 *  contains github.com. So the match is scoped to a SENTENCE containing both an approval word and
 *  a requirement word: "needs your approval before it can merge" passes, "approve this and I'll
 *  merge" (the brief-accept verb) does not. A literal reviewDecision/REVIEW_REQUIRED mention also
 *  passes on its own, since surfacing it is the other half of what the rule asks for. */
function mentionsApprovalRequirement(content: string): boolean {
  const c = content.toLowerCase();

  // Surfacing the PR's actual review state satisfies the rule outright.
  if (/reviewdecision|review_required/.test(c)) return true;

  const APPROVAL = /\bapprov\w*/;
  const REQUIREMENT = /\brequir\w*|\bneed\w*|\bmust\b|\bbefore\b|\buntil\b|\bcannot\b|\bcan't\b|\bunable\b/;

  // Sentence-scoped so an approval word here and a requirement word paragraphs away don't combine.
  return c
    .split(/[.!?\n]+/)
    .some((sentence) => APPROVAL.test(sentence) && REQUIREMENT.test(sentence));
}

// ——— B-876: the per-gate frame lint ————————————————————————————————————————————————————————————
//
// Reason-gated, exactly as the B-732 release rule already is — that precedent also establishes that the
// lint stays a pure function of its ARGUMENTS: `composeBrief` does the fetching and hands facts in.
//
// EVERY RULE HERE IS A WARNING. Not one of them can refuse a brief, and that is the whole deployability
// argument: `composeBrief` throws on a failed lint, so each new ERROR class would be a new way for an
// unattended daemon leg to hard-stop mid-run — and an in-place `iterate` re-composes a doc authored under
// the old rules, which a hard error would refuse an hour after it was legal. The error flip is a later
// ticket, one gate at a time, ascending blast radius (§5 step 5). `reach` is included in the warn-only
// set deliberately, despite §8 arguing it up to an error: nothing refuses a brief in this change.

const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim().length === 0;

/** Frame rules for the gate this brief is being composed for. Appends WARNINGS only — never errors. */
function lintFrame(doc: BriefDoc, ctx: BriefLintContext, warnings: string[]): void {
  const expected = ctx.reason ? FRAME_KIND_FOR_REASON[ctx.reason] : undefined;
  // stale-patch-review (n=1) and revise-scope-review (n=4, unanalysed) have no frame variant: `frame` is
  // unconstrained there rather than inheriting a sibling gate's rules.
  if (!expected) return;

  const frame = doc.frame;
  if (!frame) {
    warnings.push(
      `This ${ctx.reason} brief carries no \`doc.frame\`. The gate's own must-haves have no other typed home, so they degrade into \`context[]\` and stop being read — author the \`${expected}\` frame (see skills/harmony-shared/brief-authoring.md).`,
    );
    return;
  }
  if (frame.kind !== expected) {
    warnings.push(
      `\`doc.frame.kind\` is '${frame.kind}' but this brief's reason is '${ctx.reason}', which expects the '${expected}' frame. The render positions the frame by kind, so a mismatched frame lands in the wrong place.`,
    );
    return;
  }

  switch (frame.kind) {
    case 'clarify':
      if (blank(frame.solving)) {
        warnings.push('`frame.solving` is blank. It is the OUTCOME — what becomes true for the product when this ships — never a restatement of the problem.');
      }
      if (!Array.isArray(frame.not_solving)) {
        warnings.push('`frame.not_solving` is absent. The KEY is required even when nothing is excluded — `[]` is a legal, meaningful answer; absence is not.');
      } else {
        for (const entry of frame.not_solving) {
          if (blank(entry?.lands)) {
            warnings.push(`Excluded item "${entry?.item ?? '(unnamed)'}" names no destination. Every exclusion resolves somewhere — a ticket id, a later phase, or the explicit "nowhere — nobody is tracking this".`);
          }
        }
      }
      break;

    case 'decompose':
      if (!frame.elements?.length) {
        warnings.push('`frame.elements` is empty. The gate decides whether these elements ship as one unit or N children — with no inventory the fork cannot be priced.');
      }
      if (blank(frame.coverage)) {
        warnings.push('`frame.coverage` is blank. State the attestation against the accepted clarification: no gaps, no overlaps.');
      }
      if (!doc.alternatives?.length) {
        warnings.push('This decomposition brief carries no `alternatives`. Name the rejected cut and price it by independent shippability — 1/14 briefs did, and the un-split default is the expensive-to-detect error.');
      }
      break;

    case 'design':
      if (blank(frame.track)) {
        warnings.push('`frame.track` is absent. One gate reason serves three sub-tracks; the reader cannot otherwise tell which of three serialized decisions they are holding.');
      }
      for (const entry of frame.tracks ?? []) {
        if (entry?.status === 'not-required' && blank(entry.note)) {
          warnings.push(`Track '${entry.track}' is declared not-required with no note. Declaring a track away is a decision — say why, so a reader can contest it.`);
        }
      }
      if (!Array.isArray(frame.reach)) {
        warnings.push('`frame.reach` is absent. The KEY is required: `[]` ("this reaches nothing beyond the ticket") is a real answer, and a negative reach claim is often what carries the recommendation.');
      }
      if (!doc.alternatives?.length && frame.track !== 'ux-ui-design') {
        warnings.push("This design brief carries no `alternatives`. Name the real options and why each lost. (The ux-ui-design track is exempt: `visual-handoff.md` §D2 forbids auto-generating a guessed variant.)");
      }
      break;

    case 'plan':
      if (blank(frame.attestation?.base_verified)) {
        warnings.push('`frame.attestation.base_verified` is blank. The plan reader is the only one who can judge "safe to build from" — say what was verified against real code, not from memory.');
      }
      if (!Array.isArray(frame.carried_unproven)) {
        warnings.push('`frame.carried_unproven` is absent. The KEY is required: `[]` = "nothing carried unproven", which is a different claim from silence.');
      }
      if (blank(frame.ac_coverage)) {
        warnings.push('`frame.ac_coverage` is blank. Say whether the plan covers the ticket’s acceptance criteria.');
      }
      if (!frame.landing && ((frame.scope?.repos?.length ?? 0) > 1 || frame.scope?.has_migration === true)) {
        warnings.push('`frame.landing` is absent on a multi-repo or migration-carrying plan. The release topology is FIXED here and merely executed at release — an unstated ordering is exactly the risk that is invisible from the diff.');
      }
      break;

    case 'release':
      if (!frame.act) {
        warnings.push('`frame.act` is absent. The release gate has no field for the act it authorizes unless this is filled — name the repos, the PR count, the environment, and the atomicity.');
      } else if (frame.act.atomicity === 'ordered' && blank(frame.act.ordering)) {
        warnings.push("`frame.act.atomicity` is 'ordered' but `frame.act.ordering` is blank. An ordered landing with no stated order is not executable.");
      }
      if (!Array.isArray(frame.unproven)) {
        warnings.push('`frame.unproven` is absent. The KEY is required: the ship decision IS accepting this residue, and `[]` ("nothing") is the answer a clean release gives.');
      }
      if (!frame.evidence_status) {
        warnings.push('`frame.evidence_status` is absent. Carry the mechanical, executed-aware counts — an unexecuted test is zero evidence, not weak evidence.');
      }
      break;

    case 'verify':
      if (!frame.criteria?.length && blank(frame.exempt_reason)) {
        warnings.push('`frame.criteria` is empty and no `exempt_reason` is given. This is the gate whose whole contract is confirming reality against the filed criteria — an empty ledger acks against nothing.');
      }
      for (const row of frame.criteria ?? []) {
        if (row?.disposition === 'walk' && blank(row.step_ref)) {
          warnings.push(`Criterion "${row?.text ?? row?.ac_id ?? '(unnamed)'}" is dispositioned 'walk' but names no \`step_ref\`. A walk with no step is not a runbook step the human can follow.`);
        }
      }
      if (blank(frame.evidence_status)) {
        warnings.push('`frame.evidence_status` is blank. It is mechanical by construction and present on every verify brief — supporting confidence, never the thing being acked.');
      }
      break;
  }
}

/** Does the rendered brief name a pull request the human can go and look at? (B-876 step 9)
 *  Generous about form — the recorded url, a `#123` number, or any `/pull/<n>` link all count. */
function mentionsPullRequest(content: string, refs: BuildPrReference[]): boolean {
  if (/\/pull\/\d+/.test(content)) return true;
  for (const ref of refs) {
    if (ref.pr_url && content.includes(ref.pr_url)) return true;
    if (typeof ref.pr_number === 'number' && new RegExp(`#${ref.pr_number}\\b`).test(content)) return true;
  }
  return false;
}

/** Enforce the §3.2 disciplines on the canonical doc. `content` is the rendered blob (for the word budget). */
export function lintBrief(
  doc: BriefDoc,
  content: string,
  ctx: BriefLintContext = {},
): BriefLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const research = doc.research ?? [];

  // B-732 — the release brief must not hide the approval requirement.
  //
  // Once daemon PRs are authored by the harmony-daemon App, a bot-authored PR CANNOT be merged
  // until a human approves it. A release brief that omits this walks the human into accepting a
  // release that then cannot proceed — which is exactly what happened on B-738: the brief's whole
  // ask was "Release B-738 … to production?" with no mention of approval, and the run only went
  // smoothly because the founder had been told out-of-band to approve first.
  //
  // Prose alone did not prevent it (the instruction existed, in a code path the daemon flow never
  // takes), so this is enforced mechanically: `start-work` records `author_is_bot` on the build_pr
  // at artefact time, and a bot-authored PR makes the approval line a HARD requirement of the
  // brief. The author cannot forget it, because compose_brief refuses the brief.
  if (ctx.reason === 'release-decision-pending' && ctx.buildPr?.author_is_bot === true) {
    if (!mentionsApprovalRequirement(content)) {
      errors.push(
        `This release brief is for a BOT-AUTHORED pull request${ctx.buildPr.pr_url ? ` (${ctx.buildPr.pr_url})` : ''}, which GitHub will not let the worker merge until a human approves it. The brief must SAY so — name the pull request, state that your approval on GitHub is required before the merge, and surface its current reviewDecision. Without that, accepting this brief starts a release that cannot proceed.`,
      );
    }
  }

  // B-876 — the release brief must name the pull request it is about. WARN-ONLY, and reason-gated on the
  // same fetched fact the B-732 rule uses. A release manager whose structural value is NOT having built
  // the thing cannot go and look at a PR the brief never names.
  if (ctx.reason === 'release-decision-pending' && ctx.buildPrRefs?.length) {
    if (!mentionsPullRequest(content, ctx.buildPrRefs)) {
      const named = ctx.buildPrRefs
        .map((r) => r.pr_url ?? (typeof r.pr_number === 'number' ? `#${r.pr_number}` : r.key))
        .join(', ');
      warnings.push(
        `This task records a pushed pull request (${named}) but the brief names no PR reference. Put it on the brief — the release reader must be able to open the thing they are authorizing a merge of.`,
      );
    }
  }

  // B-876 — the per-gate frame rules. Warn-only by construction (see lintFrame's header).
  lintFrame(doc, ctx, warnings);

  // B-876 — the revision block is a round-2+ artefact, and each change must name the feedback it answers;
  // an unbound change is a diff, not a response, and cannot be checked against what was asked.
  //
  // B-877 completes the rule's other half (audit §4.2): the block is not merely constrained WHEN present,
  // it is OWED once the brief iterates. An iterated brief carrying no record of what changed and what
  // feedback it answers leaves the reader unable to tell what moved between rounds — they must diff two
  // renders in their head to find out. Gated on the POST-increment `ctx.iteration`, so a FIRST compose
  // (iteration 1, or absent when the caller supplies none) can never warn; warning there would fire on
  // every brief ever composed, which is the exact inverse of this tail-case signal.
  if (!doc.revision && ctx.iteration !== undefined && ctx.iteration > 1) {
    warnings.push(`This brief is being composed as round ${ctx.iteration} but carries no \`doc.revision\`. An iterated brief owes the reader a record of what changed and which feedback each change answers — without it they must diff two renders to find out what moved.`);
  }
  if (doc.revision) {
    if (typeof doc.revision.round === 'number' && doc.revision.round < 2) {
      warnings.push(`\`doc.revision.round\` is ${doc.revision.round}. The revision block is a round-2+ artefact — a first-round brief has no prior feedback to answer.`);
    }
    for (const change of doc.revision.changes ?? []) {
      if (blank(change?.responds_to)) {
        warnings.push(`Revision change "${change?.change ?? '(unnamed)'}" names no feedback it responds to. Bind each change to the feedback it answers, so an "already reflected" claim has a falsifiable form.`);
      }
    }
  }

  for (const item of doc.items) {
    // Rule 2 (the single most-repeated failure, B-320/B-327): a derived constraint already fixed
    // elsewhere is Context, never a "confirm" — forcing the human to confirm it wastes a decision.
    if (item.kind === 'derived-constraint') {
      errors.push(
        `Item "${item.text}" is a derived constraint already fixed elsewhere — move it to Context, do not ask the human to confirm it.`,
      );
      continue;
    }
    // Rule 1 (no naked forks): every decision carries a recommendation, unless deferred behind research.
    if (item.kind === 'decision' && !item.deferred && !item.recommendation?.trim()) {
      errors.push(
        `Decision "${item.text}" has no recommendation (naked fork). Recommend a default (mark it cede-able if it's a values call), or defer it behind research.`,
      );
    }
  }

  // Rule 3 (research-first when load-bearing, B-327): lead with the research, never bury it; and don't
  // ask a substantive decision the agent is out of depth on — defer it until research returns.
  if (doc.load_bearing_gap) {
    if (research.length === 0) {
      errors.push('Load-bearing knowledge gap declared but no research supplied — lead with the research, do not guess.');
    }
    if (doc.items.some((i) => i.kind === 'decision' && !i.deferred)) {
      errors.push('Load-bearing gap declared but a substantive decision is still being asked — defer the recommendation until research returns.');
    }
  }

  // Soft: word budget (§3.2 — soft, not enforced: trim noise, don't amputate reasoning). Tier-aware
  // (B-467): the budget scales with the brief's structural size so larger decisions aren't false-flagged.
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  const budget = softWordBudget(doc);
  if (words > budget) {
    warnings.push(
      `Brief renders to ${words} words (soft budget ${budget}, tier-aware). Trim noise — but don't amputate reasoning; expose detail via expand instead.`,
    );
  }

  // Soft (B-660): the two legibility nudges — warn-only, same tier as the word budget. They
  // never touch `errors`, so `ok` can never flip because of a nudge.
  const legibility = analyzeLegibility(content);
  if (legibility.longSentences.length > 0) {
    const worst = legibility.longSentences[0];
    warnings.push(
      `${legibility.longSentences.length} sentence(s) run past ${SENTENCE_WORD_LIMIT} words (longest: ${worst.words} — "${worst.excerpt}…"). One idea per sentence — five clauses means five sentences (brief-authoring.md, legibility contract).`,
    );
  }
  const stackedParens = legibility.nestedParens + legibility.adjacentParens;
  if (stackedParens > 0) {
    warnings.push(
      `Stacked parentheticals at ${stackedParens} spot(s) — an aside inside (or immediately against) an aside. Unstack these: lift the inner aside into its own sentence (brief-authoring.md, legibility contract).`,
    );
  }

  // Soft: confidence calibration (B-445 — the signal must be informative, not reflexively absent/low).
  // Nudge an explicit level on every non-ceded recommendation so confidence carries information.
  if (doc.recommend && !doc.recommend.cede && !doc.recommend.confidence) {
    warnings.push(
      'Recommendation has no confidence level — set an explicit `confidence` (high | medium | low) so the signal carries information; do not leave it unmarked or reflexively low.',
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

const BRIEF_COLS =
  'id, task_id, reason, doc, content, expand_sections, related, pending_activity, decision_ref, status, iteration, resolved_command, resolved_detail, resolved_at, created_by, created_at, updated_at';

const VALID_REASONS = [
  'clarification-draft', 'decomposition-proposal', 'design-decision-draft',
  'plan-draft', 'release-decision-pending', 'verification-ack-pending', 'stale-patch-review',
  'revise-scope-review',
];

export interface DecisionRef { type: string; id: string; }

// ——— B-866: the eight-reason coverage ledger ——————————————————————————————————————————————————————
//
// Pinned in CODE (and in `derivation-contract.test.ts`) rather than left implicit, because the failure
// mode here is silence: a gate that quietly flows through neither half looks exactly like a gate nobody
// got to yet. Every one of the eight §6.5 reasons is NAMED, with the reason it does or does not carry
// each half — so an unflowed reason is a stated exemption a reader can contest, never an omission.
//
// THE COUNT IS FIVE, and it was verified against the skills in this repo, not inherited:
//   * FIVE reasons carry a `decision_ref` — clarification-draft, decomposition-proposal,
//     design-decision-draft, stale-patch-review, revise-scope-review. Their accept promotes a knowledge
//     entry, so their entry prose is DERIVED here.
//   * plan-draft is the WRITES half ONLY. It composes promised writes (the plan-step checklist) and
//     composes NO decision_ref — it promotes no entry, so there is no entry prose to derive.
//   * release-decision-pending and verification-ack-pending are NEITHER: they promote no entry and
//     promise no structured writes. Their accept executes a landing / acknowledges reality.
// Any "6 of 8" reading is wrong; plan-draft is the reason it is easy to get wrong.

export interface GateReasonFlow {
  /** Does this gate's brief carry a `decision_ref` — the POINTER fact? It drives the depth-pointer line
   *  and names the entry the accept promotes. FIVE reasons do. */
  carries_decision_ref: boolean;
  /** Does compose DERIVE this gate's entry BODY from the ratified doc? FOUR reasons do — deliberately
   *  one fewer than carry the pointer.
   *
   *  THE TWO FACTS ARE SEPARATE FIELDS BECAUSE THEY ARE SEPARATE FACTS. Collapsed into one, "carries a
   *  decision_ref" silently implies "may be overwritten from this brief", which is how
   *  `stale-patch-review` nearly acquired a destructive write by implication rather than by decision. Its
   *  row below is a NAMED, PRINCIPLED EXEMPTION rather than a gap — and it is pinned in both directions,
   *  so it can neither silently widen to another reason nor silently vanish. */
  derives_entry_content: boolean;
  /** Does this gate's brief carry promised structured writes in `doc.payload`? */
  carries_writes: boolean;
  /** B-867 — does this gate land a DURABLE SECTION on the ticket (`tasks.field_values.gate_slots`)?
   *  THREE reasons do: clarification-draft, release-decision-pending, verification-ack-pending.
   *
   *  A FOURTH FIELD BECAUSE IT IS A FOURTH FACT, and it deliberately does NOT line up with
   *  `carries_writes` — the two disagree at FIVE of the eight rows. Clarify writes its slot THROUGH the
   *  payload (its accept defers into an acceptance event, so a `gate_slot` item can ride it). Release
   *  and verify carry no writes at all and never will: their accept creates NO acceptance event
   *  (`resolve_brief` defers only the four agent-owned-payload reasons), so there is nothing for a
   *  payload item to hang on — they reach the same `writeGateSlot` helper through the `write_gate_slot`
   *  MCP tool at the accept instead. Giving the two hard-floor gates payload semantics purely to make
   *  this column agree with the one above it was considered and REJECTED at design: it would invent an
   *  event whose only purpose is uniformity. Reading `writes_slot` off `carries_writes` would therefore
   *  be wrong in BOTH directions — decompose/design/plan carry writes and land no section, while
   *  release/verify land a section and carry no writes. */
  writes_slot: boolean;
  /** Why. Present on EVERY row, including the flowed ones — an exemption nobody wrote down is
   *  indistinguishable from an oversight. Covers all four facts above, not just the interesting one. */
  note: string;
}

export const GATE_REASON_FLOW: Record<string, GateReasonFlow> = {
  'clarification-draft': {
    carries_decision_ref: true,
    derives_entry_content: true,
    carries_writes: true,
    writes_slot: true,
    note: "Promotes the clarified-intent specification entry, whose body this gate records as a PLACEHOLDER moments before composing — so deriving it replaces a seat, never ratified prose. Promises the happy-path acceptance criteria (and any de-scope re-tickets). WRITES THE `clarify` SLOT (B-867) — through its own accept payload, since this reason defers into an acceptance event; the item is derived at compose from the doc's clarify frame, never hand-authored.",
  },
  'decomposition-proposal': {
    carries_decision_ref: true,
    derives_entry_content: true,
    carries_writes: true,
    writes_slot: false,
    note: "Promotes the decomposition rationale entry, recorded as a placeholder by this same gate. Promises the child tickets and any AC transfers. Writes NO slot: the ticket's durable face carries what this ticket is solving, what shipped and what was verified — a decomposition's answer is the child tickets themselves, which are already on the board and need no second copy.",
  },
  'design-decision-draft': {
    carries_decision_ref: true,
    derives_entry_content: true,
    carries_writes: true,
    writes_slot: false,
    note: "Promotes the design decision entry (technical / product / ux-ui track), recorded as a placeholder by this same gate; its `madr` block keeps its own authored value, only the body is projected. Promises the product track's AC manifest and the decision-only label. Writes NO slot: its durable record is the design decision ENTRY it promotes (and the AC manifest it files); a section restating that on the ticket would be a third copy of one decision.",
  },
  'stale-patch-review': {
    carries_decision_ref: true,
    derives_entry_content: false,
    carries_writes: false,
    writes_slot: false,
    note: "POINTER-ONLY, BY CONSTRUCTION — a NAMED, PRINCIPLED EXEMPTION, not a gap. It DOES carry a decision_ref, so the depth-pointer still renders and the accept still promotes the entry; today's stale-patch behaviour is unchanged, which is the point. But its decision_ref names `stale_ref.superseded_by`: ANOTHER GATE'S ALREADY-RATIFIED ENTRY, not a placeholder this gate recorded. Projecting the patch-review brief onto it would DESTROY ratified content — the inverse of this ticket's guarantee, aimed at an artefact the human ratified elsewhere. So content derivation stops here. (A null-successor brief omits decision_ref entirely and carries neither half.) Promises no structured writes. Writes NO slot, for the same reason it derives no content: everything it ratifies belongs to the gate whose entry it points at, and a durable section here would be that borrowed ratification wearing this ticket's face.",
  },
  'revise-scope-review': {
    carries_decision_ref: true,
    derives_entry_content: true,
    carries_writes: false,
    writes_slot: false,
    note: "Promotes the B-763 rationale record, recorded as a placeholder by this same gate; its trigger / supersede-list / keep-list / broadened-scope / AC-axis content now rides the brief's `doc.context`, where the human ratifies it. Promises no structured writes. Writes NO slot today: a re-scope changes what the CLARIFY slot should say, and the honest fix is for the re-clarify to rewrite that slot (latest-accepted-per-gate) rather than for this gate to open a competing section.",
  },
  'plan-draft': {
    carries_decision_ref: false,
    derives_entry_content: false,
    carries_writes: true,
    writes_slot: false,
    note: "WRITES HALF ONLY — composes no decision_ref, so its accept promotes no knowledge entry and there is no entry prose to derive. It does promise the plan-step checklist. Writes NO slot — note it DOES carry writes, so this column is not a restatement of the one before it: a plan is superseded by what actually shipped, and the release slot is where that lands.",
  },
  'release-decision-pending': {
    carries_decision_ref: false,
    derives_entry_content: false,
    carries_writes: false,
    writes_slot: true,
    note: "NEITHER HALF — the accept executes a landing (merge + deploy); it promotes no entry and promises no structured writes. WRITES THE `release` SLOT (B-867) — what shipped, where it landed, the PRs it landed through, and what is live but unproven. NOT through a payload: this accept creates no acceptance event, so finish-work calls the `write_gate_slot` MCP tool at the accept, reaching the same helper the payload dispatch reaches.",
  },
  'verification-ack-pending': {
    carries_decision_ref: false,
    derives_entry_content: false,
    carries_writes: false,
    writes_slot: true,
    note: "NEITHER HALF — the accept acknowledges observed reality against the criteria ledger; it promotes no entry and promises no structured writes. WRITES THE `verify` SLOT (B-867) — the criteria runbook, the environment it covers and the evidence behind it, kept for the reader who asks months later what 'Verified' actually meant here. Same route as release: no acceptance event exists, so the accept calls `write_gate_slot`.",
  },
};

/** Does compose DERIVE this gate's entry body from the doc? Reads the ledger's OWN field — never
 *  re-derived from "does it carry a decision_ref", which is a DIFFERENT question with a different
 *  answer at exactly one gate. */
export function derivesEntryContent(reason: string | undefined): boolean {
  return !!reason && GATE_REASON_FLOW[reason]?.derives_entry_content === true;
}

/** Does this gate's brief carry a decision_ref (the pointer fact)? */
export function carriesDecisionRef(reason: string | undefined): boolean {
  return !!reason && GATE_REASON_FLOW[reason]?.carries_decision_ref === true;
}

/** B-867 — does this gate land a durable section on the ticket? Reads the ledger's OWN field, never
 *  re-derived from `carries_writes`: that answer is wrong at five of the eight reasons (see the
 *  `writes_slot` doc-comment). Says nothing about HOW the slot is written — clarify goes through its
 *  accept payload, release and verify through the `write_gate_slot` tool. */
export function writesGateSlot(reason: string | undefined): boolean {
  return !!reason && GATE_REASON_FLOW[reason]?.writes_slot === true;
}

/** The gate slots reachable through a brief's ACCEPT PAYLOAD — clarify alone, and the ledger above is
 *  why. Release and verify write slots too, but `resolve_brief` defers only the four agent-owned-payload
 *  reasons, so their accept mints no acceptance event and a payload item would have nothing to ride.
 *  Keyed by reason (not by gate) because that is what `composeBrief` actually holds. */
const GATE_SLOT_FOR_PAYLOAD_REASON: Record<string, GateSlotName> = {
  'clarification-draft': 'clarify',
};

/**
 * B-867 — DERIVE the `gate_slot` payload item from the doc the human is about to ratify.
 *
 * Same discipline as `withDerivedEntryContent` below, and for the same reason: a hand-authored section
 * would be a SECOND copy of prose the human only vetted once. The content is `renderSlot(doc, gate)` —
 * a mechanical projection of the frame the brief itself renders — so the brief the human reads and the
 * section the accept lands cannot disagree.
 *
 * Deriving it at COMPOSE (rather than at consume) is what makes the brief render its own promise: the
 * item is in `doc.payload` before `renderBrief` runs, so the promised-writes block names the section
 * this accept will land. A hand-authored item is REPLACED, never merged — one source, or none.
 *
 * The doc comes back UNCHANGED for a reason with no payload-borne slot, and for a doc whose frame does
 * not match the gate (`renderSlot` returns null): nothing was ratified in a shape the section can lay
 * out, and writing an empty slot would claim the gate ratified an empty answer.
 *
 * Runs BEFORE `withDerivedEntryContent` at the one call site, deliberately: that function projects the
 * doc into the knowledge entry via a render of this same doc, so the slot item must already be present
 * or the entry's embedded render would disagree with the brief actually stored.
 */
export function withDerivedGateSlot(doc: BriefDoc, reason: string): BriefDoc {
  const gate = GATE_SLOT_FOR_PAYLOAD_REASON[reason];
  if (!gate) return doc;
  const content = renderSlot(doc, gate);
  if (!content) return doc;

  const others = (doc.payload ?? []).filter((p) => !(p.write_kind === 'gate_slot' && p.gate === gate));
  // Ref derived from the GATE, not from the content: the content changes on every iterate, and an
  // external_ref that moved with it would defeat the ledger's retry idempotency. One slot per gate is
  // exactly the storage's own latest-accepted-per-gate semantic.
  const item: AcceptanceEventPayloadItem = {
    write_kind: 'gate_slot',
    ref: slugRef('slot', gate),
    gate,
    slot_content: content,
  };
  return { ...doc, payload: [...others, item] };
}

/**
 * B-866 — DERIVE the `knowledge_entry_content` payload item from the doc the human is about to ratify.
 *
 * This is the wiring that makes the accept consume what was approved. Before it, the composing agent
 * hand-authored the entry prose separately from the brief prose; the human ratified the brief; the
 * accept promoted the entry. One copy vetted, the other promoted, nothing enforcing they matched.
 *
 * The fixed point is deliberate and load-bearing: the promise line the render emits for a
 * `knowledge_entry_content` item names the entry but does NOT contain the entry text, so deriving the
 * content from a doc that ALREADY carries the (content-less) item is stable —
 * `renderEntry(result) === result's own knowledge_entry_content.content`. That equality is exactly what
 * `derivation-contract.test.ts` pins, and it would be unprovable if the promise embedded the content.
 *
 * Returns the doc UNCHANGED for a reason that derives no entry, and for a brief with no decision_ref
 * (the stale-patch null-successor case) — there is no entry to write, so there is nothing to promise.
 */
export function withDerivedEntryContent(
  doc: BriefDoc,
  reason: string,
  decisionRef: DecisionRef | null | undefined,
  ctx: EntryRenderContext,
): BriefDoc {
  if (!derivesEntryContent(reason)) return doc;
  if (!decisionRef?.id) return doc;

  // Any hand-authored knowledge_entry_content item is REPLACED, never merged: the whole point is that
  // the entry prose has exactly one source, and a surviving hand-authored copy would be a second one.
  const others = (doc.payload ?? []).filter((p) => p.write_kind !== 'knowledge_entry_content');
  // Ref derived from the ENTRY's identity, not from its content: the content changes on every iterate,
  // and an external_ref that moved with it would defeat the ledger's retry idempotency.
  const ref = slugRef('entry', decisionRef.id);
  // `entry_id` is set explicitly rather than left for the DB to resolve from the brief's decision_ref:
  // the snapshotted payload is then self-describing, and the item's ref and its target agree by
  // construction.
  const stub: AcceptanceEventPayloadItem = { write_kind: 'knowledge_entry_content', ref, entry_id: decisionRef.id };
  const staged: BriefDoc = { ...doc, payload: [...others, stub] };
  const content = renderEntry(staged, { ...ctx, decisionRef });
  return { ...staged, payload: [...others, { ...stub, content }] };
}

export interface ComposeBriefArgs {
  task_id: string;
  reason: string;
  doc: BriefDoc;
  expand_sections?: Record<string, string>;
  related?: unknown[];
  pending_activity?: string | null;
  decision_ref?: DecisionRef;
  /** B-645 iterate-prune: the KEPT set of elicitation-claim ids that still underwrite the brief.
   *  On an in-place iterate, coupled Asserted claims NOT in this list are archived (empty array ⇒
   *  archive all coupled Asserted claims). Omitted ⇒ no prune (back-compat). */
  underwriting_claim_ids?: string[];
  /** B-876 — the build's changed file paths (`git diff --name-only origin/main...HEAD`). The ONLY input
   *  to a release frame's `risk_classes`: compose computes that field and overwrites whatever the skill
   *  authored. No diff ⇒ `[]` — the signal is path-derived or it is nothing. */
  changed_paths?: string[];
  /** B-843 — the human feedback that CAUSED this iterate, stored on the NEW revision.
   *
   *  An EXPLICIT parameter, never a scrape. Sourcing the feedback from `briefs.pending_resolution`
   *  would record NOTHING for a terminal `iterate <feedback>` — which is where most iterations come
   *  from, since a same-session iterate writes no marker at all. Omitted on a first draft (nothing
   *  caused it); never fabricated.
   *
   *  B-896 NOTE: this parameter's rationale is unchanged, but one fact in its original phrasing is not.
   *  `pending_resolution` used to be written by exactly ONE thing (the browser's `submit_brief_command`);
   *  `reshapeBrief` below is now a second writer, so a marker's mere existence no longer implies a human
   *  in a browser. That is precisely why reshapeBrief records provenance on its own audit row rather than
   *  leaving authorship to be inferred from the marker. (The original comment also named the RPC
   *  `request_brief_reshape`, which exists nowhere in harmony-web — the function is `submit_brief_command`.) */
  iterate_feedback?: string;
}

/**
 * B-876 — COMPOSE IS AUTHORITATIVE for a release frame's `risk_classes`.
 *
 * The field is PATH-DERIVED FROM THE DIFF, computed here with the same pure detector `get_task` uses
 * (`detectRiskClasses`, src/tools/risk-class.ts) — never a second detector, and never a prose guess. The
 * skill's authored value is OVERWRITTEN, because a hand-written risk list is exactly the prose-keyed
 * signal B-516's path filter exists to replace. No `changed_paths` ⇒ `[]`.
 *
 * Note the deliberate omission of `text`: passing the brief's prose would re-admit the prose false
 * positives (a brief that merely MENTIONS "migration" while the diff touches one frontend file).
 *
 * THIS DOES NOT REPLACE the B-516 carried-from-gates signal. Two DIFFERENT signals reach a release brief:
 * (a) this one, diff-derived; and (b) the classes recorded at gates an `--unattended` run auto-advanced,
 * which are NOT diff-derived, still ride the brief as prose, and must be labelled as carried from gates.
 * Reading "diff-derived, not prose" as "drop everything that is not diff-derived" would silently weaken
 * the unattended-mode floor — the very floor that exists because those runs do not pause mid-flight.
 *
 * Returns a doc CLONE when it rewrites anything; the caller's object is never mutated.
 */
function withDiffDerivedRiskClasses(doc: BriefDoc, changedPaths?: string[]): BriefDoc {
  if (doc.frame?.kind !== 'release') return doc;
  const paths = Array.isArray(changedPaths) ? changedPaths.filter((x) => typeof x === 'string') : [];
  const risk_classes = paths.length > 0 ? (detectRiskClasses({ changedPaths: paths }) as string[]) : [];
  return { ...doc, frame: { ...doc.frame, risk_classes } };
}

/**
 * B-843 / B-383 — "the compose_brief_revision RPC does not exist on this DB (yet)".
 *
 * The plugin's `main` reaches the PROD board the moment it merges, but harmony-web's migration only
 * reaches prod at the next `./promote-prod.sh`. So there is a real window in which this code runs against
 * a DB with no `compose_brief_revision`, and composing must degrade to today's in-place iterate rather
 * than hard-failing the gate.
 *
 * Deliberately the SAME idiom as `isMissingPendingResolution` / `isMissingAcceptRemark` above and
 * `isMissingRelationOrFunction` in acceptance-events.ts: 42883 = undefined_function, PGRST202 = PostgREST
 * "function not found in schema cache". It NEVER matches a permission error, a transient network failure,
 * or a genuine write failure — those must propagate, never be silently read as "substrate absent".
 */
export const isMissingComposeBriefRevision = (
  err: { code?: string; message?: string } | null | undefined,
): boolean => {
  if (!err) return false;
  const code = err.code ?? '';
  if (code === '42883' || code === 'PGRST202') return true;
  const msg = err.message ?? '';
  return /compose_brief_revision/.test(msg) && /(does not exist|could not find|schema cache)/i.test(msg);
};

export async function composeBrief(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: ComposeBriefArgs,
): Promise<{ brief: unknown; lint: BriefLintResult }> {
  if (!args.task_id) throw new Error('task_id is required');
  if (!VALID_REASONS.includes(args.reason)) {
    throw new Error(`reason must be one of: ${VALID_REASONS.join(', ')}`);
  }
  if (!args.doc?.decide?.trim()) throw new Error('doc.decide is required');

  // Resolve the task identifier (UUID / task number / visual ID), matching the sibling task tools.
  // B-732: this now runs BEFORE the lint, because the release-brief approval rule needs the task's
  // build_pr record — the lint can no longer be a pure function of the doc alone.
  const taskId = await resolveTaskId(client, projectId, args.task_id);

  // B-732: read the B-722 pushed-PR record so the lint knows whether this release brief is for a
  // bot-authored PR. Guarded: a task with no build_pr (every non-release brief, and any pre-B-722
  // ticket) simply yields undefined and the rule does not apply. A read failure must never block
  // brief composition — the rule degrades to "not applicable" rather than erroring the gate.
  //
  // B-876: the SAME guarded read now also yields every readable PR reference (`readBuildPrReferences`),
  // which tolerates the three divergent live shapes — B-740's sibling keys, B-743's nesting, B-844's
  // non-PR `work_branch` sibling. It names what it can read and omits what it cannot; it never throws.
  let buildPr: BriefLintContext['buildPr'];
  let buildPrRefs: BuildPrReference[] | undefined;
  if (args.reason === 'release-decision-pending') {
    const { data: taskRow } = await client
      .from('tasks')
      .select('field_values')
      .eq('id', taskId)
      .maybeSingle();
    const fv = (taskRow as { field_values?: Record<string, unknown> } | null)?.field_values;
    buildPr = readBuildPr(fv);
    buildPrRefs = readBuildPrReferences(fv);
  }

  // B-625: a literal-string "null" (case-insensitive, trimmed) is the string-serialized form of JSON null
  // — treat it as omitted (parity with B-466's null≡omitted), advancing no state. Narrow: ONLY the exact
  // "null" token; any other unknown activity still hits the transition guard below (a typo'd "buildng" must
  // keep erroring — that error is doing its job; resolve_brief's own lookup is B-373, out of scope).
  const pendingActivity =
    typeof args.pending_activity === 'string' && args.pending_activity.trim().toLowerCase() === 'null'
      ? null
      : args.pending_activity;

  // Compose-time guard (fail-fast): a pending_activity must yield a real transition from the current state.
  // Invariant: P1's seed has (from_state, activity) unique, so maybeSingle is exact; if a future seed adds
  // a second to_state for the same (from_state, activity), maybeSingle errors loudly (a safe fail).
  //
  // B-874: this runs BEFORE the render (it used to sit after it) so the resolved transition can be handed
  // to renderBrief as the **On accept:** line — the brief states what accepting it actually does. Nothing
  // else moves: the same reads, the same guards, the same messages, and STILL no task read at all on the
  // `pending_activity: null` path.
  let accept: BriefRenderContext['accept'] = null;
  if (pendingActivity) {
    const { data: task, error: tErr } = await client
      .from('tasks').select('workflow_state, stale').eq('id', taskId).single();
    if (tErr) throw new Error(tErr.message);
    const taskRow = task as { workflow_state: string | null; stale: boolean | null } | null;
    const fromState = taskRow?.workflow_state ?? null;
    // B-715: a stale ticket must never compose a state-advancing brief except through the two
    // documented reconciliation routes. This mirrors the P1 transition-table guard pattern so the
    // stale backstop can't be skipped by loop non-adherence — the exact gap B-696 exposed (a design
    // accept + plan-draft compose sailed through while stale:true, with nothing at the substrate to
    // stop it).
    if (taskRow?.stale === true && args.reason !== 'stale-patch-review' && args.reason !== 'revise-scope-review') {
      throw new Error(
        `Task is stale (tasks.stale=true) — cannot compose a state-advancing brief (reason '${args.reason}'). ` +
        `Route through harmony-stale-patch (files a 'stale-patch-review' brief) or harmony-revise-scope first.`,
      );
    }
    let q = client.from('workflow_transitions').select('to_state').eq('activity', pendingActivity);
    q = fromState === null ? q.is('from_state', null) : q.eq('from_state', fromState);
    const { data: tr, error: trErr } = await q.maybeSingle();
    if (trErr) throw new Error(trErr.message);
    if (!tr) {
      throw new Error(`pending_activity '${pendingActivity}' has no valid transition from state '${fromState ?? 'NULL'}'`);
    }
    accept = { from: fromState, to: (tr as { to_state: string }).to_state };
  }

  // B-877 — the active-brief lookup is HOISTED above the render/lint pair because the lint needs the
  // iteration this compose will land on (a round-2+ brief owes a `doc.revision`). It depends only on the
  // client and the resolved task id — nothing derived from `doc`, `content` or `payload` — so the hoist is
  // safe; its one consequence is an extra SELECT on a compose that then fails the lint, a read not a write.
  // `existing` is still what the upsert below branches on; nothing about that use changed.
  //
  // B-866: it also reads `decision_ref`, because the render must use the MERGED value rather than the
  // one THIS call happened to pass (below).
  const { data: existing, error: lookupErr } = await client
    .from('briefs').select('id, iteration, decision_ref')
    .eq('task_id', taskId).eq('status', 'active').maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);

  // B-866 — THE MERGED decision_ref: what the row will actually carry after this compose, not what this
  // call passed. The B-843 revision patch is a PARTIAL — an omitted `decision_ref` CARRIES FORWARD — so
  // rendering from `args.decision_ref` made a partial recompose keep the pointer on the row while
  // silently dropping the depth-pointer line from the content the human reads. Absent ≠ null here, and
  // that distinction is the whole fix: omitted means "keep whatever is there", explicit null means clear.
  const existingRow = existing as { id: string; iteration?: number; decision_ref?: DecisionRef | null } | null;
  const mergedDecisionRef: DecisionRef | null =
    args.decision_ref !== undefined ? (args.decision_ref ?? null) : (existingRow?.decision_ref ?? null);

  // Render the canonical doc to the blob, then lint the doc (what's checked is what's rendered).
  // The third argument (B-874) carries the compose-time facts the doc cannot know — the gate reason and
  // the resolved accept-transition — which drive the **On accept:** line, the gate-specific command tail,
  // and clarify's payload-derived proposed-AC block.
  // B-876: `doc` is the canonical doc with compose-authoritative fields resolved (today: the release
  // frame's diff-derived `risk_classes`). It — not `args.doc` — is what gets rendered, linted and stored.
  // B-866: `doc` also carries the DERIVED `knowledge_entry_content` payload item for the five gate
  // reasons whose accept promotes a knowledge entry — the entry prose is a projection of this same doc
  // (`renderEntry`), so the human ratifies and the accept promotes one authored source, not two.
  const renderCtx: BriefRenderContext = { reason: args.reason, accept };
  // B-867: `withDerivedGateSlot` runs INSIDE the entry derivation, never after it — the entry's content
  // is a render of this same doc, so the slot's promise line must already be on the page when that
  // render happens or the promoted entry would disagree with the brief the human read.
  const doc = withDerivedEntryContent(
    withDerivedGateSlot(withDiffDerivedRiskClasses(args.doc, args.changed_paths), args.reason),
    args.reason,
    mergedDecisionRef,
    renderCtx,
  );
  const content = renderBrief(doc, mergedDecisionRef, renderCtx);
  const lint = lintBrief(doc, content, {
    reason: args.reason,
    buildPr,
    buildPrRefs,
    // The POST-increment iteration — identical to the value the update below writes, so the lint judges the
    // round the human will actually read. No active brief means this compose is round 1.
    iteration: existing ? ((existing as { iteration: number }).iteration ?? 1) + 1 : 1,
  });
  if (!lint.ok) {
    throw new Error(`Brief failed the §3.2 pre-send lint:\n- ${lint.errors.join('\n- ')}`);
  }

  const payload = {
    reason: args.reason,
    doc,
    content,
    expand_sections: args.expand_sections ?? {},
    related: args.related ?? [],
    pending_activity: pendingActivity ?? null,
    // B-866: the MERGED ref (see above), so the non-RPC fallback UPDATE below no longer nulls a
    // carried-forward pointer that the rendered content still advertises. On the INSERT path there is no
    // prior revision, so this is exactly `args.decision_ref ?? null` — unchanged.
    decision_ref: mergedDecisionRef,
    // B-485 Phase 2 (release-review fix): composing/iterating a brief CONSUMES any browser-submitted
    // reshape, so null out `pending_resolution` as part of the write. The conductor owns no brief-write
    // tool; a browser `reshape` writes `pending_resolution`, then the running conductor re-composes via
    // compose_brief (§4d) — this in-place iterate IS the consume moment, so clearing it here is the natural
    // place. Without it the marker would linger and risk an ambiguous row (a stale reshape coexisting with a
    // later state-advance). compose_brief is skill-only (the web never composes — see the NOTE below), so
    // this never clobbers a reshape the web means to keep: on the iterate re-compose the agent IS consuming
    // it; on a first compose there is no active brief yet, so the write is a harmless no-op. Safe against
    // schema drift: per the prod-gate the column is present whenever this code runs (web-migration-first,
    // §3), and the update is wrapped in a guarded fallback below so an older DB degrades instead of 400-ing.
    pending_resolution: null,
  };

  // Upsert: update the active brief in place (edit/iterate — §3.2) or insert a new one (compose) — the
  // lookup itself was hoisted above the lint (B-877), which needs the iteration this compose will land on.

  // Guarded write: `pending_resolution` is added by harmony-web's Phase-1 migration. On a DB that predates
  // it, including the column in the write 400s the whole compose (the B-383 schema-drift class). So if the
  // write fails specifically because that column is absent, retry once without it — the marker can't exist
  // on a schema that lacks the column, so dropping the null is a faithful no-op. Any other error rethrows.
  const isMissingPendingResolution = (msg: string | undefined): boolean =>
    !!msg && /pending_resolution/.test(msg) && /(does not exist|could not find|schema cache|column)/i.test(msg);

  // B-843 — an iterate RETAINS the prior revision. `compose_brief_revision` supersedes the active row and
  // inserts its successor in ONE transaction (required: `uq_briefs_one_active_per_task` is a partial
  // unique index on (task_id) WHERE status='active', so a split supersede-then-insert conflicts).
  //
  // The patch carries ONLY what this compose CHANGES. That is the whole point: the DB carries every
  // omitted field forward, so a redraft that does not re-state `decision_ref` KEEPS the pointer instead of
  // silently nulling it — the exact data loss the old `decision_ref: args.decision_ref ?? null` write
  // caused. An explicit null still clears (absent ≠ null). `pending_resolution` is not in the patch: the
  // successor row starts with the column at its NULL default, which IS the B-485 marker-consume.
  const revisionPatch: Record<string, unknown> = { reason: args.reason, doc, content };
  if (args.expand_sections !== undefined) revisionPatch.expand_sections = args.expand_sections;
  if (args.related !== undefined) revisionPatch.related = args.related;
  if (args.pending_activity !== undefined) revisionPatch.pending_activity = pendingActivity ?? null;
  if (args.decision_ref !== undefined) revisionPatch.decision_ref = args.decision_ref ?? null;

  let brief: unknown;
  if (existing) {
    const briefId = (existing as { id: string }).id;
    const { data: revision, error: revisionErr } = await client.rpc('compose_brief_revision', {
      _task_id: taskId,
      _patch: revisionPatch,
      _iterate_feedback: args.iterate_feedback ?? null,
      _created_by: userId,
    });

    if (!revisionErr) {
      brief = revision;
    } else if (isMissingComposeBriefRevision(revisionErr)) {
      // B-383 / B-734 guarded degradation (the same shape as the `pending_resolution` fallback below and
      // the B-645 claim prune): the plugin's `main` runs against the PROD board before harmony-web's
      // migration is promoted there, so the RPC is genuinely absent for a window. Fall back to today's
      // in-place UPDATE — the prior revision is not retained and the feedback is not stored, but the gate
      // keeps working exactly as it does today. ANY other error rethrows: a real write failure must be loud.
      const updateRow = { ...payload, iteration: ((existing as { iteration: number }).iteration ?? 1) + 1 };
      const { data, error } = await client
        .from('briefs').update(updateRow).eq('id', briefId).select(BRIEF_COLS).single();
      if (error) {
        if (!isMissingPendingResolution(error.message)) throw new Error(error.message);
        const { pending_resolution: _drop, ...fallback } = updateRow;
        const { data: data2, error: error2 } = await client
          .from('briefs').update(fallback).eq('id', briefId).select(BRIEF_COLS).single();
        if (error2) throw new Error(error2.message);
        brief = data2;
      } else {
        brief = data;
      }
    } else {
      throw new Error(revisionErr.message);
    }

    // B-645 iterate-prune: the in-place iterate is the elicitation-claim disposal moment for a
    // reshaped brief (mirrors this same path consuming pending_resolution above). When the caller
    // passes `underwriting_claim_ids` — the KEPT set of claims that still underwrite the re-composed
    // brief — archive every coupled dangling claim: Asserted rows whose underwriting_brief_id is
    // THIS brief and whose id is not kept. An empty array archives ALL coupled Asserted claims.
    // Omitted ⇒ no prune (back-compat: pre-B-645 callers never prune). Rows coupled to other briefs
    // (or uncoupled) are untouched by construction of the underwriting_brief_id filter.
    if (args.underwriting_claim_ids !== undefined) {
      // B-843: `briefId` is deliberately the PRIOR revision's id, not the successor's — coupled claims
      // carry `underwriting_brief_id` pointing at the row that was active when they were asserted, which
      // is the row this compose just superseded. Keying the prune on the new revision would match nothing
      // and silently stop pruning.
      const kept = args.underwriting_claim_ids;
      let prune = client
        .from('knowledge_decisions')
        .update({ status: 'Archived' })
        .eq('underwriting_brief_id', briefId)
        .eq('status', 'Asserted');
      if (kept.length > 0) {
        prune = prune.not('id', 'in', `(${kept.join(',')})`);
      }
      const { error: pruneErr } = await prune;
      if (pruneErr) {
        // Guarded (B-383 class, like the pending_resolution fallback): on a DB that predates the
        // Phase-1 claim columns the filter column is absent — no claim can exist there, so the
        // prune is a faithful no-op. Any OTHER error rethrows: a real prune failure must be loud.
        const missingClaimColumn =
          /underwriting_brief_id/.test(pruneErr.message ?? '') &&
          /(does not exist|could not find|schema cache|column)/i.test(pruneErr.message ?? '');
        if (!missingClaimColumn) throw new Error(pruneErr.message);
      }
    }
  } else {
    const insertRow = { task_id: taskId, created_by: userId, ...payload };
    const { data, error } = await client
      .from('briefs').insert(insertRow).select(BRIEF_COLS).single();
    if (error) {
      if (!isMissingPendingResolution(error.message)) throw new Error(error.message);
      const { pending_resolution: _drop, ...fallback } = insertRow;
      const { data: data2, error: error2 } = await client
        .from('briefs').insert(fallback).select(BRIEF_COLS).single();
      if (error2) throw new Error(error2.message);
      brief = data2;
    } else {
      brief = data;
    }
  }

  // Set the P1 awaiting_human_input context (state-machine §6.5) so the queue/load views surface it.
  const { error: taskErr } = await client
    .from('tasks')
    .update({
      awaiting_human_input: true,
      awaiting_human_reason: args.reason,
      awaiting_human_ref: { type: 'brief', id: (brief as { id: string }).id },
    })
    .eq('id', taskId);
  if (taskErr) throw new Error(taskErr.message);

  return { brief, lint };
}

// NOTE: compose_brief is skill-only (§4.3 — the web never composes; it does mechanical accept/defer only),
// so the two writes above (briefs upsert, then the tasks flag) need no cross-surface transaction. On a
// flag-set failure the function throws; the composing skill re-calls compose_brief and the in-place upsert
// safely re-attempts (retry-safe, no duplicate brief). The atomic+idempotent path is resolve_brief, which
// BOTH surfaces call. A compose_brief RPC is a noted fast-follow, not v1 (finding F4).

export const composeBriefTool = {
  name: 'compose_brief',
  description:
    "Compose (or iterate, in place) the BLUF decision brief for a task and flag it awaiting human input. Pass the STRUCTURED doc (decide / recommend / why / alternatives / context / items / research); the Markdown blob is rendered from it. Runs the §3.2 pre-send lint (rejects naked forks; enforces research-first when load-bearing; rejects items labelled `derived-constraint` among the asks) and validates pending_activity against the transition table. pending_activity = the workflow activity `accept` will apply; decision_ref = the Asserted knowledge entry `accept` will promote. Calling again for the same task produces the NEXT REVISION of the same brief (edit/iterate): B-843 supersedes the active row and inserts its successor in one transaction, so every earlier version stays readable and `iteration` keeps counting. Pass `iterate_feedback` (the human's verbatim words) on every round-2+ call. The revision write is a PARTIAL: fields you omit CARRY FORWARD from the previous revision and only an explicit null clears one — so omitting `decision_ref` no longer silently drops the pointer to the entry accept promotes. On an in-place iterate, pass `underwriting_claim_ids` (B-645) = the elicitation-claim ids that STILL underwrite the re-composed brief — coupled Asserted claims not in the list are archived (empty array archives all; omit to skip pruning). Each gate's brief contract — the one question it answers, its must-haves, and the engagement depth it owes the human — lives in skills/harmony-shared/brief-authoring.md: author the doc against your gate's section plus its legibility contract; do not restate it here. Write one-scan prose (short sentences, no stacked parentheticals, jargon and internal IDs spelled out); the brief is the summary, and the render appends the depth-pointer line automatically whenever the brief carries a decision_ref — do not hand-write it. " +
    "B-866: the doc you compose is the SINGLE authored prose source. The human reads the rendered brief; at the four gates that record their own entry the accept promotes a mechanical projection of the SAME doc as that entry's body (stamped 'Derived from the ratified brief', with any element the brief did not show them marked NOT RATIFIED). Do not author entry prose separately — put it in the doc. The depth-pointer is rendered from the MERGED decision_ref, so a partial recompose that omits it keeps the pointer. " +
    "B-876: also author `doc.frame` — the gate-specific frame, a `kind`-discriminated block carrying the must-haves the BLUF spine has no field for (clarify: solving/in_scope/not_solving; decompose: elements/coverage; design: track/tracks/reach; plan: scope/steps/attestation/carried_unproven/ac_coverage; release: act/unproven/evidence_status; verify: environment/criteria ledger). Its `kind` must match the gate `reason`; the render positions it per gate (clarify above DECIDE, release below DECIDE and above Recommend, everything else below Recommend). Omitting it renders exactly the pre-B-876 bytes and every frame rule is a WARNING — no frame defect can refuse a brief. On an in-place iterate (round 2+), also author `doc.revision` = { round, changes: [{ change, responds_to }] }, each change bound to the feedback it answers; it renders under the On-accept line, never above the frame. For a `release-decision-pending` brief pass `changed_paths` (the PR diff) — compose computes `frame.risk_classes` from it with the deterministic path detector and OVERWRITES whatever you authored there; no diff yields an empty list. That diff-derived field does NOT replace the B-516 classes carried from auto-advanced gates, which still ride the brief as prose labelled as carried from gates.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'The task this brief decides on — UUID, task number (e.g., 43), or visual ID (e.g., B-43)' },
      reason: { type: 'string', description: 'Gate reason (§6.5): clarification-draft | decomposition-proposal | design-decision-draft | plan-draft | release-decision-pending | verification-ack-pending | stale-patch-review | revise-scope-review' },
      doc: {
        type: 'object',
        description: 'The canonical structured BLUF brief. The rendered Markdown blob is derived from this.',
        properties: {
          decide: { type: 'string', description: 'One-line statement of the decision needed' },
          recommend: { type: 'object', description: '{ text, confidence?: "high" | "medium" | "low", cede?: boolean } — omit when load_bearing_gap (research-first)' },
          why: { type: 'array', items: { type: 'string' }, description: '2–3 bullets of reasoning' },
          alternatives: { type: 'array', items: { type: 'object' }, description: '[{ option, rejection }]' },
          context: { type: 'array', items: { type: 'string' }, description: 'Peer decisions / scope / known patterns' },
          items: {
            type: 'array',
            description: 'The "You need to" items, each sorted into exactly one kind (§3.2).',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', description: "'decision' (always recommended) | 'content-input' (only the human can supply) | 'derived-constraint' (already fixed — belongs in Context, NOT an ask)" },
                text: { type: 'string' },
                recommendation: { type: 'string', description: 'Required for a decision unless deferred behind research' },
                deferred: { type: 'boolean', description: 'true when the decision is deferred behind research' },
              },
              required: ['kind', 'text'],
            },
          },
          research: { type: 'array', items: { type: 'string' }, description: 'Research prompts — required + surfaced up front when load_bearing_gap, never buried' },
          load_bearing_gap: { type: 'boolean', description: 'true when a load-bearing knowledge gap blocks a substantive decision (forces research-first)' },
          tail: { type: 'string', description: 'Optional custom command tail line; defaults to the standard one' },
          frame: {
            type: 'object',
            description:
              "B-876 — the gate-specific frame, discriminated by `kind` (must match the gate reason): 'clarify' { solving, in_scope[], not_solving[{item,lands}] } | 'decompose' { elements[{text,surface?,covers?}], coverage, existing_children_checked } | 'design' { track, tracks[{track,status,note?}], reach[], not_reopened?[], derisk?{run[],not_run[]}, files_on_accept?[] } | 'plan' { scope{repos[],surfaces[],has_migration}, steps[], attestation{base_verified,derisked_by_running?}, carried_unproven[{item,reason}], ac_coverage, landing?, design_delta? } | 'release' { act(LandingShape), unproven[{item,reason}], evidence_status{proven_by_run,walk_at_verify,unproven,total,detail?}, risk_classes[], pr_review_state? } | 'verify' { environment, criteria[{ac_id,text,checked,disposition,step_ref?,blocked_reason?,carried_to?,backed_by?}], exempt_reason?, evidence_status, bounded_accept? }. LandingShape = { repos[], pr_count, lands_in: 'staging'|'production'|'both'|'merged-main', atomicity: 'single'|'together'|'ordered', ordering? (required when ordered), irreversible[] }. Every rule over this field is a WARNING — an absent or malformed frame never refuses the brief; omit it entirely and the render is byte-identical to the pre-B-876 output.",
          },
          revision: {
            type: 'object',
            description:
              "B-876 — round-2+ only: { round: number, changes: [{ change, responds_to }] }. One entry per change made this round, each bound to the feedback it answers. Renders under the **On accept:** line as 'Changed this round:' and never above the frame — the human approves the totality, not the diff.",
          },
          payload: {
            type: 'array',
            description:
              "B-810 — the promised structured writes this brief's ACCEPT will materialize (AcceptanceEventPayloadItem[], acceptance-events.ts): one item per acceptance_criterion / child_ticket / checklist_item / ac_transfer / label_add / knowledge_entry_content write, mirroring exactly what the gate's own same-session accept-time materialization performs. A `knowledge_entry_content` item (B-843) CARRIES the full prose of the knowledge entry this brief's decision_ref names. B-866: DO NOT AUTHOR ONE — compose DERIVES it from this same doc (renderEntry) for the FOUR reasons whose gate records the entry itself (clarification-draft, decomposition-proposal, design-decision-draft, revise-scope-review), sets its `ref` and `entry_id`, and REPLACES any item you supply. stale-patch-review is a NAMED EXEMPTION: it carries a decision_ref (the depth-pointer still renders) but its entry was ratified at another gate, so its body is never overwritten; the entry's prose belongs in the doc (recommend / why / alternatives / context / frame), never in a second hand-authored copy. The payload is executed by the B-797 cross-session safety net (a web accept with no session running); since B-866 the brief also RENDERS its promise — one line per promised write — so what the reader sees and what the accept executes cannot disagree. Every item's `ref` MUST be derived via `slugRef` + deduped via `dedupeRefs` (payload-refs.ts) — a content-derived slug, never a positional index, stable across an in-place iterate recompose. Omit or pass `[]` when this gate has no promised writes (e.g. decompose's 'no split').",
            items: {
              type: 'object',
              properties: {
                write_kind: { type: 'string', description: "'acceptance_criterion' | 'child_ticket' | 'checklist_item' | 'ac_transfer' | 'label_add' | 'knowledge_entry_content'" },
                ref: { type: 'string', description: 'Stable, content-derived, within-payload-unique ref — from slugRef/dedupeRefs (payload-refs.ts)' },
                content: { type: 'string', description: 'Required for acceptance_criterion, ac_transfer and knowledge_entry_content — the full text, verbatim' },
                title: { type: 'string', description: 'Required for child_ticket and checklist_item' },
                description: { type: ['string', 'null'], description: 'Optional, child_ticket only' },
                target_child_ref: { type: 'string', description: "ac_transfer only — the destination child_ticket item's own `ref` from this SAME payload" },
                from_ac_id: { type: ['string', 'null'], description: "ac_transfer only — the parent AC's own id being removed; omit only for the rare copy-not-move case" },
                label_name: { type: 'string', description: "label_add only (B-688) — the label to add; defaults to 'decision-only' when omitted (the only real-world caller today)" },
                entry_id: { type: ['string', 'null'], description: "knowledge_entry_content only (B-843) — the target knowledge entry; omit to let the DB resolve it from this brief's own decision_ref (the normal case)" },
              },
              required: ['write_kind', 'ref'],
            },
          },
        },
        required: ['decide', 'items'],
      },
      expand_sections: { type: 'object', description: 'Pre-generated expand content keyed by section: reasoning/alternatives/history' },
      related: { type: 'array', description: 'Pre-generated related decisions/tickets/knowledge' },
      pending_activity: { type: ['string', 'null'], description: 'The workflow activity `accept` applies (e.g. clarifying, decomposing, deploying, verifying). A real activity is validated against the transition table; null or omitted ⇒ accept advances no state.' },
      decision_ref: { type: 'object', description: 'The Asserted knowledge entry to promote on accept: { type: "decision", id: "<uuid>" }' },
      changed_paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          "B-876 — the build's changed file paths (`git diff --name-only origin/main...HEAD`). Used ONLY to compute a release frame's `risk_classes` with the deterministic path detector; compose is authoritative for that field and overwrites whatever the doc authored. Omit (or pass []) and the field is [] — the risk signal is path-derived or it is nothing, never prose-guessed.",
      },
      underwriting_claim_ids: { type: 'array', items: { type: 'string' }, description: 'B-645 iterate-prune: on an in-place iterate, the KEPT set of elicitation-claim ids that still underwrite this brief. Coupled Asserted claims NOT listed are archived; [] archives all coupled Asserted claims; omit ⇒ no prune. Ignored on a first compose (nothing is coupled yet).' },
      iterate_feedback: {
        type: 'string',
        description:
          "B-843 — the human's feedback that CAUSED this iterate, VERBATIM. Pass it on EVERY round-2+ compose (`edit` / `iterate <feedback>`, and the browser reshape's `pending_resolution.detail`); omit it only on a first draft, where nothing caused the brief. It is stored on the NEW revision, so the retained history reads as \"this is what they asked for, and this is what I changed\". Never guessed, never paraphrased into a summary, and never left out because `doc.revision` already names the changes — `doc.revision` records what YOU changed, this records what THEY said.",
      },
    },
    required: ['task_id', 'reason', 'doc'],
  },
};

// B-485 Phase 2: `briefs.pending_resolution` is a browser-submitted reshape request the running
// conductor consumes on auto-pickup — shape `{ command: 'iterate', detail: <feedback> }`, or NULL/none.
// It is added by harmony-web's Phase-1 migration (`20260618…_briefs_pending_resolution.sql`). Until that
// migration is live on the DB this MCP server talks to, the column does not exist — so we read it on a
// SEPARATE, defensive select and SWALLOW the error rather than inline it into BRIEF_COLS. Inlining would
// 400 the whole core read on a DB that lacks the column (the B-383 schema-drift class of break the
// prod-gate guards against); a separate guarded read degrades to `pending_resolution: null` instead.
// Promotion is still lockstep (web migration first, then plugin) per the prod-gate.
export interface PendingResolution {
  command: string; // 'iterate' in v1 (the browser-submitted reshape)
  detail?: string | null; // the human's feedback text
}

/** Fetch the active brief's `pending_resolution` defensively. Returns null on absent column / no brief /
 *  any error — never throws, so it can never regress get_brief/get_task on a DB without the column. */
export async function fetchPendingResolution(
  client: SupabaseClient,
  taskId: string,
): Promise<PendingResolution | null> {
  try {
    const { data, error } = await client
      .from('briefs')
      .select('pending_resolution')
      .eq('task_id', taskId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) return null;
    // Cast: the column may be absent from generated types / the deployed schema. Guard for null.
    const pr = (data as unknown as { pending_resolution?: unknown } | null)?.pending_resolution;
    return (pr ?? null) as PendingResolution | null;
  } catch {
    return null;
  }
}

// B-503 (accept-with-remark): `briefs.accept_remark` + `briefs.accept_remark_consumed_at` are added
// by harmony-web's B-503 migration — resolve_brief persists an optional remark alongside an accept.
// The plugin's pickup half surfaces the task's most recent UNCONSUMED remark as `pending_remark` on
// get_task (full AND meta), and consume_accept_remark stamps it consumed. Both reads/writes are
// guarded (the B-383 schema-drift class, exactly like pending_resolution above): on a DB that
// predates the migration, the read degrades to null and the consume returns an unsupported ack —
// never a 400 on the core path.
export interface PendingRemark {
  /** The brief the remark rode in on — pass this to consume_accept_remark. */
  brief_id: string;
  /** That brief's gate reason (e.g. 'decomposition-proposal') — what the remark was accepted AT. */
  reason: string;
  /** The human's remark text (briefs.accept_remark). */
  detail: string;
  /** B-866 — the brief's own `decision_ref`: the knowledge entry this accept promoted. */
  decision_ref: DecisionRef | null;
  /** B-866 — the resolved referent (see RemarkReferent). Always present; never silently omitted. */
  referent: RemarkReferent;
}

/**
 * B-866 — WHAT A REMARK REFERS TO.
 *
 * A LIGHT amendment ("the promoted decision stays the same decision — a wording fix, a clarifying
 * constraint") is applied to THE PROMOTED KNOWLEDGE ENTRY. Until now the consumer was handed
 * `{ brief_id, reason, detail }` and had to work out which entry that was, which in practice meant
 * re-authoring one from memory of the brief — the exact separately-authored-second-copy failure this
 * ticket exists to close, re-entering through the remark door.
 *
 * So the referent is RESOLVED here, from the brief's `decision_ref`, and its provenance is part of the
 * value. DEGRADATION IS STATED, NEVER SILENT: when the entry cannot be read, the caller gets a
 * RECONSTRUCTION — `renderEntry` over the brief's own stored doc, which is the same projection the
 * accept would have promoted — carrying an explicit `warning` that it was not read from the board. A
 * reconstruction presented as though it were the real thing is worse than no referent at all: it invites
 * an amendment written against text that may not be what is stored.
 */
export type RemarkReferent =
  /** Read from the board. `content` is the entry's live prose — amend THIS. */
  | { status: 'entry'; entry_id: string; title: string | null; content: string }
  /** NOT read from the board. `content` is a local projection of the brief's stored doc. */
  | { status: 'reconstructed'; entry_id: string | null; content: string; warning: string }
  /** Neither readable nor reconstructable — say so rather than hand back a guess. */
  | { status: 'unavailable'; entry_id: string | null; warning: string };

/** Reconstruct the entry from the brief's own stored doc — the SAME projection the accept promotes —
 *  or report that even that is impossible. Both branches carry the warning verbatim. */
function reconstructReferent(
  doc: unknown,
  entryId: string | null,
  reason: string,
  warning: string,
): RemarkReferent {
  const isDoc = !!doc && typeof doc === 'object' && !Array.isArray(doc) && typeof (doc as BriefDoc).decide === 'string';
  if (!isDoc) {
    return { status: 'unavailable', entry_id: entryId, warning: `${warning} The brief's stored doc could not be read either, so no reconstruction is possible.` };
  }
  return {
    status: 'reconstructed',
    entry_id: entryId,
    content: renderEntry(doc as BriefDoc, { reason }),
    warning,
  };
}

/** Resolve the entry the accept promoted. Never throws: every failure becomes a STATED degradation. */
async function resolveRemarkReferent(
  client: SupabaseClient,
  row: { id: string; reason: string; decision_ref?: unknown; doc?: unknown },
): Promise<{ decision_ref: DecisionRef | null; referent: RemarkReferent }> {
  const rawRef = row.decision_ref;
  const decisionRef =
    rawRef && typeof rawRef === 'object' && typeof (rawRef as DecisionRef).id === 'string'
      ? (rawRef as DecisionRef)
      : null;

  if (!decisionRef) {
    return {
      decision_ref: null,
      referent: reconstructReferent(
        row.doc,
        null,
        row.reason,
        `This brief carried no decision_ref, so its accept promoted no knowledge entry. What follows is a LOCAL RECONSTRUCTION of the brief's own entry projection — it was NOT read from the board, and no stored entry corresponds to it.`,
      ),
    };
  }

  try {
    const { data, error } = await client
      .from('knowledge_decisions')
      .select('id, title, content')
      .eq('id', decisionRef.id)
      .maybeSingle();
    if (!error && data) {
      const entry = data as { id: string; title?: string | null; content?: string | null };
      return {
        decision_ref: decisionRef,
        referent: { status: 'entry', entry_id: entry.id, title: entry.title ?? null, content: entry.content ?? '' },
      };
    }
    const why = error ? `Reading it failed: ${error.message}.` : 'No such entry was returned.';
    return {
      decision_ref: decisionRef,
      referent: reconstructReferent(
        row.doc,
        decisionRef.id,
        row.reason,
        `The promoted knowledge entry ${decisionRef.id} could NOT be read. ${why} What follows is a LOCAL RECONSTRUCTION of the brief's own entry projection — it was NOT read from the board, so it may differ from what is stored. Re-read the entry before amending it.`,
      ),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision_ref: decisionRef,
      referent: reconstructReferent(
        row.doc,
        decisionRef.id,
        row.reason,
        `The promoted knowledge entry ${decisionRef.id} could NOT be read (${message}). What follows is a LOCAL RECONSTRUCTION of the brief's own entry projection — it was NOT read from the board. Re-read the entry before amending it.`,
      ),
    };
  }
}

/** Fetch the task's most recent brief whose accept_remark is unconsumed, defensively (mirrors
 *  fetchPendingResolution). Returns null on absent columns (older DB) / no such brief / any error —
 *  never throws, so it can never regress get_task on a DB without the B-503 migration.
 *
 *  B-866: it also resolves the remark's REFERENT — the knowledge entry the accept promoted — so a light
 *  amendment is applied to the thing that was promoted rather than to a re-authored copy of it. */
export async function fetchPendingRemark(
  client: SupabaseClient,
  taskId: string,
): Promise<PendingRemark | null> {
  try {
    const { data, error } = await client
      .from('briefs')
      .select('id, reason, accept_remark, decision_ref, doc')
      .eq('task_id', taskId)
      .not('accept_remark', 'is', null)
      .is('accept_remark_consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    // Cast: the columns may be absent from generated types / the deployed schema. Guard for null.
    const row = data as unknown as { id: string; reason: string; accept_remark?: unknown; decision_ref?: unknown; doc?: unknown };
    const detail = row.accept_remark;
    if (typeof detail !== 'string' || detail.trim().length === 0) return null;
    const { decision_ref, referent } = await resolveRemarkReferent(client, row);
    return { brief_id: row.id, reason: row.reason, detail, decision_ref, referent };
  } catch {
    return null;
  }
}

export interface ConsumeAcceptRemarkArgs { brief_id: string; }

/** Idempotent consume result. `consumed: true` = this call stamped it. `already: true` = nothing to
 *  stamp (already consumed, no remark, or no such brief — all safe no-ops). `unsupported: true` =
 *  the DB predates the B-503 columns (pre-migration guard; nothing could exist to consume). */
export interface ConsumeAcceptRemarkResult {
  brief_id: string;
  consumed: boolean;
  already?: boolean;
  unsupported?: boolean;
}

const isMissingAcceptRemark = (msg: string | undefined): boolean =>
  !!msg && /accept_remark/.test(msg) && /(does not exist|could not find|schema cache|column)/i.test(msg);

/**
 * B-883 — the WRITE-side sibling of isMissingAcceptRemark above, and deliberately NOT that predicate.
 *
 * isMissingAcceptRemark matches `accept_remark`: the COLUMN, on the read path. The write-side failure is
 * a different thing entirely — passing `p_remark` to a database whose `resolve_brief` signature predates
 * the parameter is a PostgREST FUNCTION-resolution failure (PGRST202, "Could not find the function ... in
 * the schema cache") whose message names `p_remark`, the PARAMETER. The string `p_remark` does not contain
 * `accept_remark`, so reusing the read-side guard here would never fire: the drift case would throw in
 * production while the code looked like it handled it.
 */
const isMissingRemarkParam = (msg: string | undefined): boolean =>
  !!msg && /p_remark/.test(msg) && /(does not exist|could not find|schema cache|function)/i.test(msg);

export async function consumeAcceptRemark(
  client: SupabaseClient,
  _projectId: string,
  args: ConsumeAcceptRemarkArgs,
): Promise<ConsumeAcceptRemarkResult> {
  if (!args.brief_id) throw new Error('brief_id is required');

  // Conditional stamp: WHERE accept_remark_consumed_at IS NULL makes the consume naturally
  // idempotent — a second call matches zero rows and is a no-op ack, never an error. The
  // remark-present filter keeps the stamp meaningful (a brief with no remark is a no-op too).
  const { data, error } = await client
    .from('briefs')
    .update({ accept_remark_consumed_at: new Date().toISOString() })
    .eq('id', args.brief_id)
    .not('accept_remark', 'is', null)
    .is('accept_remark_consumed_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    // Guarded (B-383 class, like the pending_resolution fallback): on a DB that predates the B-503
    // columns no remark can exist, so the consume is a faithful no-op ack. Any other error rethrows.
    if (isMissingAcceptRemark(error.message)) {
      return { brief_id: args.brief_id, consumed: false, unsupported: true };
    }
    throw new Error(error.message);
  }
  if (!data) return { brief_id: args.brief_id, consumed: false, already: true };
  return { brief_id: args.brief_id, consumed: true };
}

export const consumeAcceptRemarkTool = {
  name: 'consume_accept_remark',
  description:
    "Mark a brief's accept-with-remark as consumed (B-503). get_task surfaces the task's most recent unconsumed remark as `pending_remark: { brief_id, reason, detail, decision_ref, referent }` — B-866's `referent` is the knowledge entry the accept promoted, which is what a LIGHT amendment is applied to: { status: 'entry', entry_id, title, content } when it was read from the board, or { status: 'reconstructed' | 'unavailable', warning } when it could NOT be, in which case any `content` is a LOCAL projection of the brief's doc and the warning says so — never amend from a reconstruction without re-reading the entry; after APPLYING the remark (consume-after-apply — never stamp before the apply completes), call this with that brief_id to stamp `accept_remark_consumed_at` so the remark is not re-consumed. Idempotent: an already-consumed (or absent) remark returns { consumed: false, already: true } — no error. On a DB that predates the B-503 columns, returns { consumed: false, unsupported: true }.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      brief_id: { type: 'string', description: 'The brief whose accept remark to mark consumed (from pending_remark.brief_id)' },
    },
    required: ['brief_id'],
  },
};

export interface GetBriefArgs { task_id: string; }

export async function getBrief(
  client: SupabaseClient,
  projectId: string,
  args: GetBriefArgs,
): Promise<unknown> {
  if (!args.task_id) throw new Error('task_id is required');
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  // Unique-lookup guard: the partial unique index guarantees ≤1 active brief, so maybeSingle is exact.
  const { data, error } = await client
    .from('briefs').select(BRIEF_COLS)
    .eq('task_id', taskId).eq('status', 'active').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null; // null when no active brief
  // B-485: surface the browser-submitted reshape marker so a running conductor can detect+consume it.
  // Defensive (separate guarded read) so an older DB without the column returns null, not a 400.
  const pending_resolution = await fetchPendingResolution(client, taskId);
  return { ...(data as Record<string, unknown>), pending_resolution };
}

// ——— B-878: the brief HISTORY read ———————————————————————————————————————————————————————————————
//
// `get_brief` above answers "what is awaiting the human RIGHT NOW" — it filters status='active' and the
// conductor loop depends on exactly that. It is deliberately NOT widened here: history is a SECOND,
// additive read, so nothing that reads the active brief changes shape.
//
// What this returns is the record B-843 started retaining: every gate ask on the ticket (a LINEAGE),
// every retained revision of it at every status, the reshape feedback that produced each revision, and
// the elicitation exchanges anchored where they actually happened.

/** The history read needs BRIEF_COLS plus B-843's two revision columns. */
const BRIEF_HISTORY_COLS = `${BRIEF_COLS}, lineage_id, iterate_feedback`;

/** The exchange columns the history read surfaces (no consumable markers — history never answers). */
const HISTORY_EXCHANGE_COLS = 'id, task_id, brief_id, trigger, gate, status, rounds, created_at';

/**
 * B-878 / B-383 — "this DB does not have the revision-history substrate (yet)": the lineage/feedback
 * COLUMNS, or the `brief_revision_lineages` VIEW. Same idiom (and the same hard limits) as
 * `isMissingComposeBriefRevision` above and `isMissingRelationOrFunction` in acceptance-events.ts:
 * 42703 = undefined_column, 42P01 = undefined_table, PGRST204/PGRST205 = PostgREST "column/table not
 * found in schema cache". It NEVER matches a permission error, a transient network failure, or any
 * other error class — those must propagate, never be silently read as "substrate absent".
 */
export const isMissingBriefHistorySubstrate = (
  err: { code?: string; message?: string } | null | undefined,
): boolean => {
  if (!err) return false;
  const code = err.code ?? '';
  if (code === '42703' || code === '42P01' || code === 'PGRST204' || code === 'PGRST205') return true;
  const msg = err.message ?? '';
  if (/(lineage_id|iterate_feedback|brief_revision_lineages)/.test(msg)
    && /(does not exist|could not find|schema cache)/i.test(msg)) return true;
  return false;
};

export interface ListBriefsArgs { task_id: string; }

interface HistoryExchangeRow {
  id: string;
  brief_id: string | null;
  [field: string]: unknown;
}

/** One retained revision, with whatever was discussed ON it. */
export interface BriefRevisionEntry {
  id: string;
  iteration: number | null;
  reason: string | null;
  doc: unknown;
  content: string | null;
  iterate_feedback: string | null;
  status: string | null;
  resolved_command: string | null;
  resolved_detail: string | null;
  resolved_at: string | null;
  created_at: string | null;
  /** Exchanges whose `brief_id` points at THIS revision. An array, not a single value: a revision can
   *  carry an abandoned discussion AND the one that converged, and history must drop neither. */
  exchanges: HistoryExchangeRow[];
}

export interface BriefLineageEntry {
  lineage_id: string;
  reason: string | null;
  /** The newest revision's status — how the ask stands (or ended). */
  status: string | null;
  resolved_command: string | null;
  resolved_detail: string | null;
  retained_revisions: number;
  unretained_revisions: number;
  has_unretained_revisions: boolean;
  /** Newest revision first. */
  revisions: BriefRevisionEntry[];
  /** `brief_id IS NULL` — a conversation that ran BEFORE any draft existed, so it anchors to the
   *  lineage rather than to a revision. */
  pre_draft_exchanges: HistoryExchangeRow[];
}

export interface ListBriefsResult {
  task_id: string;
  lineages: BriefLineageEntry[];
  /**
   * Which parts of the substrate this DB actually has. Reported rather than assumed, so a degraded
   * read is VISIBLE to the caller (the B-843/B-883 discipline: a drop is never silent).
   */
  substrate: {
    revision_columns: 'present' | 'absent';
    lineage_view: 'present' | 'absent';
    exchanges: 'present' | 'absent';
  };
}

/**
 * B-878 — every brief a task has ever had, grouped into lineages, at EVERY status.
 *
 * Degrades, never throws, when a piece of the substrate is missing (a plugin `main` reaches the prod
 * board before harmony-web's migration does — see B-383): absent revision columns make each brief its
 * own single-revision lineage, an absent counts view falls back to the revisions actually held, and an
 * absent exchange table simply contributes no exchanges. Any NON-schema error still propagates.
 */
export async function listBriefs(
  client: SupabaseClient,
  projectId: string,
  args: ListBriefsArgs,
): Promise<ListBriefsResult> {
  if (!args.task_id) throw new Error('task_id is required');
  const taskId = await resolveTaskId(client, projectId, args.task_id);

  // 1) Every brief on the task — no status filter (that active-only blindness is what this closes).
  let revision_columns: 'present' | 'absent' = 'present';
  let rows: Record<string, unknown>[] = [];
  {
    const { data, error } = await client
      .from('briefs').select(BRIEF_HISTORY_COLS)
      .eq('task_id', taskId).order('created_at', { ascending: false });
    if (error) {
      if (!isMissingBriefHistorySubstrate(error)) throw new Error(error.message);
      revision_columns = 'absent';
      const fallback = await client
        .from('briefs').select(BRIEF_COLS)
        .eq('task_id', taskId).order('created_at', { ascending: false });
      if (fallback.error) throw new Error(fallback.error.message);
      rows = (fallback.data as Record<string, unknown>[]) ?? [];
    } else {
      rows = (data as Record<string, unknown>[]) ?? [];
    }
  }

  // 2) The exchanges, at every status — anchored per revision below by brief_id.
  let exchanges: HistoryExchangeRow[] = [];
  let exchangesPresence: 'present' | 'absent' = 'present';
  {
    const { data, error } = await client
      .from('elicitation_exchanges').select(HISTORY_EXCHANGE_COLS).eq('task_id', taskId);
    if (error) {
      if (!isMissingBriefHistorySubstrate(error)) throw new Error(error.message);
      exchangesPresence = 'absent';
    } else {
      exchanges = (data as HistoryExchangeRow[]) ?? [];
    }
  }

  // 3) The counts view — the only place that knows how many revisions predate retention.
  const counts = new Map<string, Record<string, unknown>>();
  let lineage_view: 'present' | 'absent' = 'present';
  {
    const { data, error } = await client
      .from('brief_revision_lineages').select('*').eq('task_id', taskId);
    if (error) {
      if (!isMissingBriefHistorySubstrate(error)) throw new Error(error.message);
      lineage_view = 'absent';
    } else {
      for (const row of ((data as Record<string, unknown>[]) ?? [])) {
        const key = row.lineage_id;
        if (typeof key === 'string') counts.set(key, row);
      }
    }
  }

  const anchored = exchanges.filter((e) => !!e.brief_id);
  const preDraft = exchanges.filter((e) => !e.brief_id);

  // Group, preserving the created_at-descending order the query returned.
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    // A brief written before the lineage column existed still groups — as its own lineage keyed by its
    // id. Tolerance, never a dropped revision.
    const key = typeof row.lineage_id === 'string' ? row.lineage_id : String(row.id);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }

  const entries = [...grouped.entries()];
  const lineages: BriefLineageEntry[] = entries.map(([lineage_id, revisions], index) => {
    const latest = revisions[0] ?? {};
    const countRow = counts.get(lineage_id);
    const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);
    return {
      lineage_id,
      reason: (latest.reason as string) ?? null,
      status: (latest.status as string) ?? null,
      resolved_command: (latest.resolved_command as string) ?? null,
      resolved_detail: (latest.resolved_detail as string) ?? null,
      retained_revisions: num(countRow?.retained_revisions, revisions.length),
      unretained_revisions: num(countRow?.unretained_revisions, 0),
      has_unretained_revisions: countRow?.has_unretained_revisions === true,
      revisions: revisions.map((row) => ({
        id: row.id as string,
        iteration: (row.iteration as number) ?? null,
        reason: (row.reason as string) ?? null,
        doc: row.doc ?? null,
        content: (row.content as string) ?? null,
        iterate_feedback: (row.iterate_feedback as string) ?? null,
        status: (row.status as string) ?? null,
        resolved_command: (row.resolved_command as string) ?? null,
        resolved_detail: (row.resolved_detail as string) ?? null,
        resolved_at: (row.resolved_at as string) ?? null,
        created_at: (row.created_at as string) ?? null,
        exchanges: anchored.filter((e) => e.brief_id === row.id),
      })),
      // A pre-draft exchange preceded a lineage's FIRST draft: match it by gate when the gate says
      // which lineage it belongs to, else it belongs to the OLDEST lineage (the first ask on the
      // ticket) — the only lineage a gate-less pre-draft conversation can have preceded.
      pre_draft_exchanges: preDraft.filter((e) => {
        const gate = e.gate;
        if (typeof gate === 'string' && gate) {
          if (revisions.some((r) => r.pending_activity === gate)) return true;
          if (rows.some((r) => r.pending_activity === gate)) return false;
        }
        return index === entries.length - 1;
      }),
    };
  });

  return {
    task_id: taskId,
    lineages,
    substrate: { revision_columns, lineage_view, exchanges: exchangesPresence },
  };
}

// ——— B-734 Phase B: resolution provenance ————————————————————————————————————————————————————————
//
// resolve_brief now records a `brief_resolved` decision entry carrying WHO decided. Provenance FAILS
// CLOSED at the DB (a NULL is stored as JSON null and renders unattributed), so the plugin makes it a
// REQUIRED input rather than an optional flourish — a caller that forgets it would silently produce
// an unattributed decision forever.
//
// The plugin may declare only two things, because they are the only two it can witness:
//   'human-in-session'                — the human typed accept/defer in the running session.
//   'agent-synthesized[:<mode>]'      — the conductor synthesized it under a delegation mode.
//
// 'human-in-browser' is the WEB CLIENT'S ALONE (harmony-web's WEB_RESOLUTION_PROVENANCE). The plugin
// is never the browser, so accepting it here would let an agent claim a human clicked. Rejected.
//
// Everything else is rejected too — INCLUDING near-misses. 'agent-synthesised' (British spelling)
// would otherwise be stored verbatim, fall through harmony-web's exact-match attribution, and render
// as unattributed forever: a typo that looks like a data problem. An error at the call site is
// strictly better than a wrong value in an audit trail.
export const PROVENANCE_HUMAN_IN_SESSION = 'human-in-session';
export const PROVENANCE_AGENT_SYNTHESIZED = 'agent-synthesized';
/** harmony-web's own value — the plugin must never send it. */
export const PROVENANCE_WEB_ONLY = 'human-in-browser';

const ACCEPTED_PROVENANCE = `'${PROVENANCE_HUMAN_IN_SESSION}', '${PROVENANCE_AGENT_SYNTHESIZED}', or '${PROVENANCE_AGENT_SYNTHESIZED}:<mode>'`;

/**
 * Validate-and-reject (never pass through). Returns the trimmed, accepted value.
 * Surrounding whitespace is tolerated — it is not a semantic near-miss — but nothing else is.
 */
export function validateResolutionProvenance(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    throw new Error(`provenance is required — declare who decided this: ${ACCEPTED_PROVENANCE}`);
  }
  if (value === PROVENANCE_HUMAN_IN_SESSION) return value;
  if (value === PROVENANCE_AGENT_SYNTHESIZED) return value;
  if (value.startsWith(`${PROVENANCE_AGENT_SYNTHESIZED}:`)) {
    const mode = value.slice(PROVENANCE_AGENT_SYNTHESIZED.length + 1).trim();
    if (mode) return `${PROVENANCE_AGENT_SYNTHESIZED}:${mode}`;
    throw new Error(
      `invalid provenance '${value}' — '${PROVENANCE_AGENT_SYNTHESIZED}:' must name a delegation mode (e.g. '${PROVENANCE_AGENT_SYNTHESIZED}:unattended'), or use bare '${PROVENANCE_AGENT_SYNTHESIZED}'`,
    );
  }
  if (value === PROVENANCE_WEB_ONLY) {
    throw new Error(
      `provenance '${PROVENANCE_WEB_ONLY}' is the web client's alone — the plugin is never the browser, and accepting it here would let an agent claim a human clicked. Use '${PROVENANCE_HUMAN_IN_SESSION}' when the human decided in this session, or '${PROVENANCE_AGENT_SYNTHESIZED}[:<mode>]' when the conductor synthesized it.`,
    );
  }
  throw new Error(
    `unrecognised provenance '${value}' — accepted values are ${ACCEPTED_PROVENANCE}. Rejected rather than stored: an unrecognised value renders as unattributed forever, so a near-miss (e.g. the British 'agent-synthesised') would look like a data problem instead of a typo.`,
  );
}

export interface ResolveBriefArgs { task_id: string; command: string; detail?: string; remark?: string; provenance: string; }

export async function resolveBrief(
  client: SupabaseClient,
  projectId: string,
  args: ResolveBriefArgs,
): Promise<unknown> {
  if (!args.task_id) throw new Error('task_id is required');
  if (args.command !== 'accept' && args.command !== 'defer') {
    throw new Error('resolve_brief handles only accept/defer; edit/iterate are skill-side, expand/related are reads on get_brief');
  }
  const provenance = validateResolutionProvenance(args.provenance);
  // B-883: a remark rides on ACCEPT only. A deferred ticket parks, so a remark attached to a defer would
  // sit unconsumed forever — and quietly storing it would be the very silent-loss failure this change
  // exists to close. Rejected BEFORE the RPC: nothing is written, so there is no partial state to reason
  // about. A blank remark is treated as absent (below), so it never trips this.
  const remark = typeof args.remark === 'string' ? args.remark.trim() : '';
  if (remark && args.command === 'defer') {
    throw new Error(
      "a remark cannot accompany 'defer': the remark channel rides on accept, and a deferred ticket parks, so the remark would never be consumed. Drop the remark, or accept instead — for a defer reason use `detail`.",
    );
  }
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  // Unique-lookup guard (partial unique index): exactly one active brief, or none.
  const { data: active, error: lookupErr } = await client
    .from('briefs').select('id')
    .eq('task_id', taskId).eq('status', 'active').maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);

  // B-517: a trigger-rolled-up umbrella's verify gate has NO brief (it was auto-advanced to Deployed
  // without a live conductor), so the normal active-brief path can't ack it. When the task is such a
  // brief-less umbrella-auto-verify sentinel (Deployed + awaiting verification-ack-pending + ref.kind=
  // 'umbrella-auto-verify') and the human accepts, advance it Deployed→Verified via the fixed-contract
  // RPC instead of erroring. defer/other commands on a brief-less umbrella stay out of scope (still error).
  if (!active) {
    if (args.command === 'accept') {
      const { data: task, error: taskErr } = await client
        .from('tasks')
        .select('workflow_state, awaiting_human_reason, awaiting_human_ref')
        .eq('id', taskId)
        .maybeSingle();
      if (taskErr) throw new Error(taskErr.message);
      const row = task as {
        workflow_state?: string | null;
        awaiting_human_reason?: string | null;
        awaiting_human_ref?: { kind?: string } | null;
      } | null;
      if (
        row?.workflow_state === 'Deployed' &&
        row.awaiting_human_reason === 'verification-ack-pending' &&
        row.awaiting_human_ref?.kind === 'umbrella-auto-verify'
      ) {
        const { data, error } = await client.rpc('ack_umbrella_verify', { _task_id: taskId });
        if (error) throw new Error(error.message);
        return data;
      }
    }
    throw new Error(`no active brief for task ${args.task_id}`);
  }

  const rpcArgs = {
    _brief_id: (active as { id: string }).id,
    _command: args.command,
    _detail: args.detail ?? null,
    // B-734: the decision entry's attribution. Validated above — never a caller's raw string.
    p_provenance: provenance,
  };

  // A blank remark omits the parameter entirely — that IS "blank is absent", so it needs no other branch.
  const { data, error } = await client.rpc(
    'resolve_brief',
    remark ? { ...rpcArgs, p_remark: remark } : rpcArgs,
  );
  if (!error) return remark ? withRemarkRecorded(data, true) : data;

  // B-883: write-side schema drift. The parameter is unresolvable, so the WHOLE call failed and the accept
  // did NOT happen — degrading therefore cannot mean "the accept succeeded and the remark was skipped", it
  // must mean RETRY. Safe on both old and new deployments because the migration declares
  // `p_remark text DEFAULT NULL`, so omitting the argument is always valid. The accept lands, and the
  // dropped remark is REPORTED rather than silently swallowed — a silent drop here would reproduce the
  // exact failure this ticket exists to close, inside its own fix.
  if (remark && isMissingRemarkParam(error.message)) {
    const { data: retried, error: retryErr } = await client.rpc('resolve_brief', rpcArgs);
    if (retryErr) throw new Error(retryErr.message);
    return withRemarkRecorded(retried, false);
  }
  throw new Error(error.message);
}

/** Attach the B-883 remark-visibility flag to the RPC's ack without assuming its shape. */
function withRemarkRecorded(data: unknown, recorded: boolean): Record<string, unknown> {
  const base = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return { ...base, remark_recorded: recorded };
}

// ——— B-896: reshape — send an ACTIVE brief back for rework ——————————————————————————————————————
//
// The terminal twin of the browser's reshape (useReshapeBrief). A SIBLING of resolve_brief, never a
// third command on it: resolve_brief's DB function hard-rejects anything but accept/defer, and an
// iterate is a different act entirely — the brief SURVIVES (stays `active`, carries the marker, and
// the ball goes to the agent) instead of being resolved.
//
// It composes two already-granted RPCs, and THE ORDER IS A SAFETY PROPERTY:
//   1. log_brief_decision_event — the provenance-bearing audit row.        FIRST.
//   2. submit_brief_command     — B-498's atomic marker + ball-handoff.    SECOND.
// A crash between them leaves an ORPHAN AUDIT ROW: harmless, and truthful — someone did decide to
// reshape. The reverse order would leave a marker with NO provenance, which is exactly the state this
// tool exists to prevent: an agent-authored reshape indistinguishable from a human's. NEVER reorder.
//
// NO FLOOR VETO — deliberately. A release or verify brief CAN be reshaped. floor-veto.ts is scoped to
// pre-ACCEPTING a gate a human must read; declining is the opposite act, and sending the work back
// for rework IS the human reading it. (The motivating incident was three release briefs that needed
// rework.) Do not import floorVeto here.
export interface ReshapeBriefArgs { task_id: string; feedback: string; provenance: string; }

/**
 * B-383-class drift guard, in the shape of the neighbouring isMissingAcceptRemark/isMissingRemarkParam:
 * a database missing EITHER composed RPC. PostgREST's PGRST202 names the unresolvable FUNCTION, so the
 * predicate matches the function names — the reshape then degrades to a clear, actionable error naming
 * the missing capability instead of an opaque schema-cache string.
 */
const isReshapeRpcSchemaDrift = (msg: string | undefined): boolean =>
  !!msg &&
  /(log_brief_decision_event|submit_brief_command)/.test(msg) &&
  /(does not exist|could not find|schema cache|function)/i.test(msg);

export async function reshapeBrief(
  client: SupabaseClient,
  projectId: string,
  args: ReshapeBriefArgs,
): Promise<unknown> {
  if (!args.task_id) throw new Error('task_id is required');
  // Same fail-closed validator resolve_brief uses — never a second one. 'human-in-browser' is rejected
  // here too: the plugin is never the browser, and a reshape is precisely the act whose author matters.
  const provenance = validateResolutionProvenance(args.provenance);

  // Feedback is REQUIRED, and blank is not feedback (B-883's remark convention: blank ≡ absent — here
  // absent is a refusal rather than an omission). A reshape hands the ball back to the agent; with no
  // instruction the agent is woken to nothing and re-composes the same brief. Refused BEFORE either
  // RPC, so NOTHING is written and there is no partial state to reason about.
  const feedback = typeof args.feedback === 'string' ? args.feedback.trim() : '';
  if (!feedback) {
    throw new Error(
      'feedback is required to reshape a brief — a reshape sends the brief back for rework, and blank feedback tells the agent nothing about what to change. Nothing was written.',
    );
  }

  const taskId = await resolveTaskId(client, projectId, args.task_id);
  // Unique-lookup guard (partial unique index): exactly one active brief, or none. `reason` is read
  // here because the audit row records the gate the decision was taken AT — the brief's own reason.
  const { data: active, error: lookupErr } = await client
    .from('briefs').select('id, reason')
    .eq('task_id', taskId).eq('status', 'active').maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);

  if (!active) {
    // The submitElicitationAnswers guard shape: distinguish "never composed" from "already resolved",
    // because the two need different next moves. NOTHING is written on either path.
    const { data: latest, error: latestErr } = await client
      .from('briefs').select('id, status, resolved_command')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) throw new Error(latestErr.message);
    const row = latest as { id: string; status?: string; resolved_command?: string | null } | null;
    if (!row) {
      throw new Error(
        `task ${args.task_id} has no brief to reshape — no brief has ever been composed for it, so there is nothing to send back. Compose one first with compose_brief; nothing was written.`,
      );
    }
    const via = row.resolved_command ? ` (resolved via '${row.resolved_command}')` : '';
    throw new Error(
      `the brief on task ${args.task_id} is already resolved — brief ${row.id} is '${row.status}'${via}, and a reshape is only offered on an ACTIVE brief. Compose a new brief rather than reshaping a concluded one; nothing was written.`,
    );
  }

  const brief = active as { id: string; reason: string };

  // WRITE 1 — the provenance-bearing audit row. FIRST, always (see the ordering note above).
  const { error: auditErr } = await client.rpc('log_brief_decision_event', {
    p_task_id: taskId,
    p_brief_id: brief.id,
    p_command: 'iterate',
    p_reason: brief.reason,
    // Validated above — never a caller's raw string.
    p_provenance: provenance,
    p_detail: feedback,
  });
  if (auditErr) {
    // Drift on write 1: the audit row could not be written, so write 2 is NOT attempted — a marker with
    // no provenance is the one outcome this tool must never produce. Nothing was written.
    if (isReshapeRpcSchemaDrift(auditErr.message)) {
      throw new Error(
        `reshape is unavailable on this database: it predates the decision-trail RPC (log_brief_decision_event). Nothing was written — the reshape was NOT applied. Reshape from the browser, or promote the schema first. Underlying error: ${auditErr.message}`,
      );
    }
    throw new Error(auditErr.message);
  }

  // WRITE 2 — B-498's atomic marker + ball-handoff. SECOND. The brief stays `active` and keeps its
  // workflow_state; the conductor consumes {command:'iterate', detail} on pickup and re-composes.
  const { data, error } = await client.rpc('submit_brief_command', {
    _brief_id: brief.id,
    _command: 'iterate',
    _detail: feedback,
  });
  if (error) {
    if (isReshapeRpcSchemaDrift(error.message)) {
      throw new Error(
        `reshape is unavailable on this database: it predates the handoff RPC (submit_brief_command). The reshape did NOT land — the brief is untouched and still awaiting the human. A decision entry was already recorded and is now orphaned, which is harmless (it truthfully records that a reshape was attempted). Reshape from the browser, or promote the schema first. Underlying error: ${error.message}`,
      );
    }
    throw new Error(error.message);
  }

  // A compact, server-computed ack (B-683's projection contract): the RPC's own payload, plus the gate
  // it was reshaped at and the provenance actually recorded. The caller's feedback text is deliberately
  // NOT echoed back — it is caller-sent body, and the ack exists to confirm server state.
  const base = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    brief_id: brief.id,
    task_id: taskId,
    command: 'iterate',
    reason: brief.reason,
    ...base,
    provenance,
  };
}

export const getBriefTool = {
  name: 'get_brief',
  description: "Get the active brief for a task (its rendered content blob + canonical doc + pre-generated expand sections + related), plus `pending_resolution` — a browser-submitted reshape request ({command:'iterate', detail:<feedback>}) the running conductor consumes on pickup, or null if none. Returns null if no brief is awaiting input.",
  inputSchema: {
    type: 'object' as const,
    properties: { task_id: { type: 'string', description: 'The task whose active brief to fetch — UUID, task number, or visual ID (e.g., B-43)' } },
    required: ['task_id'],
  },
};

export const listBriefsTool = {
  name: 'list_briefs',
  description:
    "Read the FULL brief history of a task: every gate ask (a lineage), every RETAINED revision of it at every status, newest first — the record `get_brief` cannot show you, because get_brief answers only 'what is awaiting the human right now' (status='active') and is unchanged by this tool. " +
    "Each lineage carries its reason (the gate), how it stands or ended (status + resolved_command + resolved_detail), the retained revision count, and — from the brief_revision_lineages view — how many earlier revisions were NOT retained because they predate revision retention (B-843): a real count of briefs whose text is gone, never a claim that there were none. " +
    "Each revision carries `doc`, `content`, `reason`, `iteration`, `iterate_feedback` (the send-back feedback that PRODUCED this revision — stored on the successor, not on the version it rejected), `status`, `resolved_command`, `resolved_detail`, `resolved_at`, plus the elicitation exchanges attached to that specific revision (elicitation_exchanges.brief_id match). Exchanges with a NULL brief_id are pre-draft conversations and are reported at LINEAGE level as `pre_draft_exchanges` — what preceded the first draft. " +
    "Degrades rather than failing against a database that predates the substrate (B-383's merge-before-promote window): the `substrate` block reports which of the revision columns / the counts view / the exchange table were actually present, so a partial answer is visible as partial and never mistaken for 'there is no history'.",
  inputSchema: {
    type: 'object' as const,
    properties: { task_id: { type: 'string', description: 'The task whose brief history to read — UUID, task number, or visual ID (e.g., B-43)' } },
    required: ['task_id'],
  },
};

export const resolveBriefTool = {
  name: 'resolve_brief',
  description:
    "Resolve the active brief on a task. accept = promote the Asserted knowledge entry to Accepted, advance the state machine, clear the flag. defer = park the ticket. Idempotent (re-issuing the same command is safe). (To send a brief BACK for rework instead of resolving it, use reshape_brief — the sibling tool; it keeps the brief active, records the provenance-bearing decision entry, and hands the ball to the agent. edit is skill-side authoring via compose_brief; expand/related are reads via get_brief.) " +
    "B-734: `provenance` is REQUIRED — it attributes the recorded decision entry, and absent provenance is stored as null and read as UNATTRIBUTED, never as a human. Accepted from the plugin: 'human-in-session' (the human typed accept/defer in this session) or 'agent-synthesized' / 'agent-synthesized:<mode>' (the conductor synthesized it under a delegation mode, e.g. 'agent-synthesized:unattended'). " +
    "FAILS CLOSED: 'human-in-browser' is the web client's alone and is REJECTED here (the plugin is never the browser), and any other value — including near-misses like the British 'agent-synthesised' — is REJECTED rather than stored, because a wrong value would render as unattributed forever. " +
    "B-883: `detail` and `remark` are DIFFERENT CHANNELS and are not interchangeable. `remark` is an instruction for the NEXT leg — it rides on an accept, surfaces as `pending_remark` on get_task, and is consumed once. `detail` is an inert note (it lands in resolved_detail) and is NEVER surfaced as pending_remark, so an instruction passed as `detail` is stored and silently never reaches anyone. A remark on 'defer' is REJECTED (a deferred ticket parks, so it could never be consumed). Against a database predating the remark parameter the accept still SUCCEEDS and the ack carries `remark_recorded: false` — the drop is visible, never silent.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'The task whose active brief to resolve — UUID, task number, or visual ID (e.g., B-43)' },
      command: { type: 'string', description: "'accept' | 'defer'" },
      detail: { type: 'string', description: "Optional INERT note recorded against the resolution (e.g. the defer reason). Lands in resolved_detail and is never surfaced as pending_remark — if you want the next leg to ACT on something, that is `remark`, not this." },
      remark: { type: 'string', description: "Optional instruction for the NEXT leg, carried with an ACCEPT (B-503's remark channel). Surfaces as `pending_remark` on get_task and is consumed once by the conductor. Rejected with 'defer' (a parked ticket would never consume it). Blank/whitespace-only is treated as no remark. On a database predating the parameter the accept still succeeds and the ack reports `remark_recorded: false`." },
      provenance: {
        type: 'string',
        description:
          "REQUIRED. Who decided: 'human-in-session' (the human typed it in this session) | 'agent-synthesized' | 'agent-synthesized:<mode>' (conductor delegation mode). 'human-in-browser' is the web client's alone and is rejected here; any other value is rejected too.",
      },
    },
    required: ['task_id', 'command', 'provenance'],
  },
};

export const reshapeBriefTool = {
  name: 'reshape_brief',
  description:
    "Send a task's ACTIVE brief BACK FOR REWORK with feedback — the terminal twin of the browser's reshape, and the SIBLING of resolve_brief (accept/defer). The brief stays active and its workflow_state is untouched; a {command:'iterate', detail:<feedback>} marker is written and the ball is handed to the agent, which consumes the marker on pickup and re-composes. Use this when the brief is wrong, thin, or aimed at the wrong thing — not resolve_brief, which only concludes. " +
    "`feedback` is REQUIRED: it is the instruction the re-compose acts on, and blank/whitespace-only is REFUSED with nothing written. " +
    "`provenance` is REQUIRED and validated exactly as on resolve_brief (B-734): 'human-in-session' | 'agent-synthesized' | 'agent-synthesized:<mode>'. 'human-in-browser' is the web client's alone and is REJECTED here, so an agent can never make its own reshape look like a human's — which is the whole point of recording it. " +
    "A RELEASE or VERIFY brief CAN be reshaped: the accept-side floor does not apply, because sending work back is the opposite of pre-accepting it. " +
    "Refuses, writing nothing, when the task has no active brief — distinguishing 'no brief has ever been composed' from 'the brief is already resolved'. On a database predating the underlying RPCs it fails with a clear unavailable-here error rather than an opaque one.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'The task whose ACTIVE brief to send back for rework — UUID, task number, or visual ID (e.g., B-43)' },
      feedback: { type: 'string', description: "REQUIRED. What is wrong and what to change — the instruction the re-compose acts on. Lands as the marker's `detail` and as the decision entry's detail. Blank/whitespace-only is refused and nothing is written." },
      provenance: {
        type: 'string',
        description:
          "REQUIRED. Who decided to send it back: 'human-in-session' (the human said so in this session) | 'agent-synthesized' | 'agent-synthesized:<mode>' (conductor delegation mode). 'human-in-browser' is the web client's alone and is rejected here; any other value is rejected too.",
      },
    },
    required: ['task_id', 'feedback', 'provenance'],
  },
};
